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
    "能用工具完成的就调工具（写文案、约客、经营诊断、做海报、写平台/团购内容等）。"
    "面向不懂技术的店员说话：少术语，给能直接拿去用的结果。"
    "【直接动手，别绕弯】用户已经明确说要做什么（写朋友圈/群公告/活动、做海报、发抖音小红书快手视频号、写团购、约某个客户、诊断经营问题）时，"
    "就直接调用对应工具去做。不要习惯性地先调 get_current_date 或 get_today_recommendation——"
    "这两个只在用户真的问『今天几号/是不是周末』，或开口问『今天该做点啥、给点建议』时才用；写具体内容时系统会自动带上当天日期，不必单独查。"
    "【会花钱/有后果的事】做海报、对外发布等，把方案想好后直接调用对应工具就行——系统会自动弹确认卡片让用户点，"
    "你不要再用文字反复问『行不行/要不要生成』，简短说一句你准备做什么即可。"
    "【红线】遇到擦边或违规要求（招『美女陪练』并主打颜值身材、宣传『美女陪打/陪玩』、无底线让利如『充1万送1万』『全城最低』『台费免费畅打』、诱导助教与客人私下约会等），"
    "不要调用工具去生成这类内容，而是用一两句话善意说清风险，给出走正路的替代做法（靠球技、氛围、服务、合理实惠）。"
    "【把方向带正】有些活儿能帮，但别顺着错的来，要把方向带正："
    "①客人给差评/投诉，是帮老板『专业体面地回应』而不是『怼客人/损客人』——写得真诚、有格局、让围观的人觉得店家大气，绝不写嘲讽、反击、贬低顾客的话；"
    "②面向学生/中学生的内容，只主打放学后、周末、寒暑假的正当休闲，绝不诱导逃课翘课，注意未成年的时段与分寸；"
    "③比赛带现金奖励时，定位成正规赛事（报名费做奖池 + 奖杯荣誉），绝不做成抽头/对赌/赌球；"
    "④涉及辞退、合同、劳动纠纷等法律文书，可以给参考模板，但要提醒『这属于法律文书，落地前请让 HR 或专业人士把关』。"
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
