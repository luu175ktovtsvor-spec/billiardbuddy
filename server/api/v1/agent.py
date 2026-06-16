"""Agent 对话 SSE 端点。

把流式 ReAct 循环（services.agent.loop.run_agent_loop_stream）的事件以 SSE 推给前端：
token / tool_call / tool_result / final / done / error。

已接管道：
- system prompt 注入门店画像 + 店脑记忆（让 agent "懂这家店"）
- 输入注入检查 + 上游配额闸（check_quota）
- 后台从用户消息学习店脑（故障安全、不计配额）
- 计费：生成类工具内部各自走 run_generation/generate_workbench（自带配额/落库/合规过滤），
  因此端点不再重复计费/落库；纯对话（未调工具）开销极小，由上游 check_quota 把门。

TODO(后续)：agent 会话本身落库(type=agent) + 多轮 conversation_id 续接；审批闸（写/对外类工具）。
"""
import json
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import AIServiceError
from core.rbac import Permission, require_permission
from core.security_guard import check_input_injection
from db.session import async_session
from models.user import User
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop_stream
from services.agent.registry import default_registry
from services.memory_service import format_memories_for_prompt, load_store_memory, remember
from services.quota_service import check_quota
from services.store_profile_service import render_operation_profile_context
import services.agent.tools  # noqa: F401  导入即把内置工具登记进 default_registry

logger = logging.getLogger(__name__)
router = APIRouter()

_AGENT_BASE_PROMPT = (
    "你是台球房运营助手的 AI Agent。用大白话、简洁地帮台球房老板/店员完成日常运营工作。"
    "能用工具完成的就调工具（写文案、约客、经营诊断、查今日推荐等）；需要客观事实（如今天几号、是不是周末）时也用工具确认，不要凭空编。"
    "面向不懂技术的店员说话：少术语，给能直接拿去用的结果。"
)


def compose_agent_system_prompt(profile_text: str, brain_text: str) -> str:
    """拼 agent 的 system prompt：基底指令 + 门店画像 + 店脑记忆（让它"懂这家店"）。"""
    parts = [_AGENT_BASE_PROMPT]
    if profile_text and profile_text.strip():
        parts.append("【这家店的情况】\n" + profile_text.strip())
    if brain_text and brain_text.strip():
        # format_memories_for_prompt 自带"如与其他资料冲突以此为准"的前缀
        parts.append(brain_text.strip())
    return "\n\n".join(parts)


async def _learn_in_background(store_id: str, text: str) -> None:
    """对话后台学习：独立 session 从用户消息抽取门店记忆、整合进店脑。失败静默、不计配额。"""
    if not text or not text.strip():
        return
    try:
        async with async_session() as bg_db:
            await remember(bg_db, store_id, text)
    except Exception:
        logger.exception("agent 店脑后台学习失败 store_id=%s", store_id)


class AgentChatRequest(BaseModel):
    message: str
    history: list[dict] | None = None
    model: str | None = None


@router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    injection = check_input_injection(body.message or "")
    if injection:
        raise AIServiceError(injection)

    await check_quota(db, str(store.id))

    # 注入"懂这家店"：门店画像（同步）+ 店脑记忆 → system prompt
    profile_text = render_operation_profile_context(store)
    memories = await load_store_memory(db, store.id)
    system_prompt = compose_agent_system_prompt(profile_text, format_memories_for_prompt(memories))

    ctx = AgentContext(db=db, store=store, user=user)

    async def event_generator():
        try:
            async for event in run_agent_loop_stream(
                user_message=body.message,
                registry=default_registry,
                ctx=ctx,
                system_prompt=system_prompt,
                history=body.history,
                model=body.model,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception:
            logger.exception("agent chat stream error")
            yield f"data: {json.dumps({'type': 'error', 'error': '生成过程中出现错误，请重试'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
        background=BackgroundTask(_learn_in_background, str(store.id), body.message),
    )


class AgentExecuteRequest(BaseModel):
    tool: str
    args: dict | None = None


@router.post("/execute")
async def agent_execute(
    body: AgentExecuteRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """确认后执行一个需审批的工具（proposal 模式的执行端点）。

    只允许执行 requires_approval=True 的工具——这些是对话循环里被拦下、等用户点确认的动作
    （如生图：花钱）。普通工具在循环里直接执行，不经此路径。
    工具自身的护栏（配额/限流/落库）由其 handler 负责；这里让其异常（如配额不足）正常抛出，
    由全局异常处理转成对用户友好的提示。
    """
    tool = default_registry.get(body.tool)
    if tool is None or not tool.requires_approval:
        raise AIServiceError("该操作不可执行，或无需经此确认")

    args = body.args or {}
    injection = check_input_injection(
        " ".join(str(v) for v in args.values() if isinstance(v, (str, int, float)))
    )
    if injection:
        raise AIServiceError(injection)

    ctx = AgentContext(db=db, store=store, user=user)
    result = await tool.handler(args, ctx)
    if not isinstance(result, str):
        try:
            result = json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            result = str(result)
    return {"tool": body.tool, "result": result}
