"""Agent 对话 SSE 端点（P0 骨架）。

把流式 ReAct 循环（services.agent.loop.run_agent_loop_stream）的事件以 SSE 推给前端：
token / tool_call / tool_result / final / done / error。

P0 范围：打通"对话→规划→调工具→流式事件"协议骨架，只挂了 1 个 demo 只读工具。
TODO(P1)：注入门店画像/知识库/店脑 system prompt、把现有十几个能力登记成工具、
          落库 + increment_usage 计费、审批闸（写/对外类工具）。
"""
import json
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import AIServiceError
from core.rbac import Permission, require_permission
from core.security_guard import check_input_injection
from models.user import User
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop_stream
from services.agent.registry import default_registry
from services.quota_service import check_quota
import services.agent.tools  # noqa: F401  导入即把内置工具登记进 default_registry

logger = logging.getLogger(__name__)
router = APIRouter()

_AGENT_SYSTEM_PROMPT = (
    "你是台球房运营助手的 AI Agent。用大白话、简洁地帮台球房老板/店员完成日常运营工作。"
    "需要客观事实（如今天几号、是不是周末）时，调用提供的工具确认，不要凭空猜。"
)


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

    # P0：先用配额闸防滥用（计费/落库在 P1 接全管道时补）
    await check_quota(db, str(store.id))

    ctx = AgentContext(db=db, store=store, user=user)

    async def event_generator():
        try:
            async for event in run_agent_loop_stream(
                user_message=body.message,
                registry=default_registry,
                ctx=ctx,
                system_prompt=_AGENT_SYSTEM_PROMPT,
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
    )
