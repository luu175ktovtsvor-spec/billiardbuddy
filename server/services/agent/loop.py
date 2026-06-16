"""最小 ReAct Agent 循环。

模型 →（产出思考/工具调用）→ 执行工具 → 把结果作 role:tool 消息回灌 → 再调模型，
直到模型不再要求调工具（收敛到最终答复）或达到 max_turns 兜底。

设计取舍：
- 工具执行失败（不存在 / 抛异常 / 入参非法）不崩循环，而是把错误文本作为工具结果回灌，
  让模型自行决定补救——这是 agentic 系统稳健性的关键。
- steps 记录每一步（thinking / tool_call / tool_result / final），供 SSE 流式展示（P0.6）与测试断言。
- 默认用编排大脑 provider + 编排模型（可与内容生成分离，见 settings.effective_orchestration_*）。
"""
import json
import logging
from dataclasses import dataclass, field

from config import settings
from services.agent.context import AgentContext
from services.agent.registry import ToolRegistry
from services.ai.base import TextProvider, TextRequest
from services.ai.factory import ProviderFactory

logger = logging.getLogger(__name__)

# 审批闸（proposal 模式）：requires_approval 的工具不在循环里执行，
# 改提请用户确认；这条作为工具结果回灌给模型，让它把方案讲给用户、不要假装已完成。
_APPROVAL_PENDING_MSG = (
    "[待用户确认] 已请求执行「{name}」，需用户确认后才会真正执行。"
    "请用一两句话把你打算做的事告诉用户、并请他确认，不要假装已经做完或已生成。"
)


@dataclass
class AgentStep:
    type: str  # thinking | tool_call | tool_result | final
    content: str = ""
    tool_name: str | None = None
    tool_args: dict | None = None
    tool_call_id: str | None = None


@dataclass
class AgentResult:
    final_text: str
    steps: list[AgentStep] = field(default_factory=list)
    turns: int = 0
    stopped_reason: str = "final"  # final | max_turns
    messages: list[dict] = field(default_factory=list)  # 完整对话轨迹（含工具调用/结果），供落库与续接


async def run_agent_loop(
    *,
    user_message: str,
    registry: ToolRegistry,
    ctx: AgentContext | None = None,
    system_prompt: str | None = None,
    provider: TextProvider | None = None,
    model: str | None = None,
    history: list[dict] | None = None,
    max_turns: int = 8,
    max_tokens: int = 2000,
) -> AgentResult:
    provider = provider or ProviderFactory.get_orchestration_provider()
    model = model or settings.effective_orchestration_model
    ctx = ctx or AgentContext()

    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    tools = registry.to_openai_tools()
    steps: list[AgentStep] = []

    for turn in range(1, max_turns + 1):
        resp = await provider.generate(TextRequest(
            messages=messages,
            tools=tools,
            tool_choice="auto",
            model=model,
            max_tokens=max_tokens,
        ))

        # 无工具调用 → 收到最终答复，结束
        if not resp.tool_calls:
            steps.append(AgentStep(type="final", content=resp.content))
            return AgentResult(
                final_text=resp.content, steps=steps, turns=turn,
                stopped_reason="final", messages=messages,
            )

        # 工具调用前可能带一段思考文本，记一笔
        if resp.content:
            steps.append(AgentStep(type="thinking", content=resp.content))

        # 把 assistant 的 tool_calls 原样回灌（下一轮模型需要看到自己调了什么）
        messages.append({"role": "assistant", "content": resp.content or "", "tool_calls": resp.tool_calls})

        # 逐个执行工具，结果作 role:tool 回灌
        for tc in resp.tool_calls:
            tc_id = tc.get("id")
            fn = tc.get("function") or {}
            name = fn.get("name")
            args = _parse_args(fn.get("arguments"))

            tool = registry.get(name) if name else None
            if tool is not None and tool.requires_approval:
                # 审批闸：不在循环里执行，记一笔 approval_request、回灌"待确认"
                steps.append(AgentStep(type="approval_request", tool_name=name, tool_args=args, tool_call_id=tc_id))
                pending = _APPROVAL_PENDING_MSG.format(name=name)
                steps.append(AgentStep(type="tool_result", tool_name=name, tool_call_id=tc_id, content=pending))
                messages.append({"role": "tool", "tool_call_id": tc_id, "content": pending})
                continue

            steps.append(AgentStep(type="tool_call", tool_name=name, tool_args=args, tool_call_id=tc_id))
            result_str = await _execute_tool(registry, name, args, ctx)
            steps.append(AgentStep(type="tool_result", tool_name=name, tool_call_id=tc_id, content=result_str))
            messages.append({"role": "tool", "tool_call_id": tc_id, "content": result_str})

    # 达到 max_turns 仍未收敛（兜底，防止循环跑飞）
    logger.warning("agent loop 达到 max_turns=%s 仍未结束", max_turns)
    steps.append(AgentStep(type="final", content=""))
    return AgentResult(final_text="", steps=steps, turns=max_turns,
                       stopped_reason="max_turns", messages=messages)


def _parse_args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        logger.warning("工具入参解析失败，按空参处理: %r", raw)
        return {}


async def _execute_tool(registry: ToolRegistry, name: str | None, args: dict, ctx: AgentContext) -> str:
    tool = registry.get(name) if name else None
    if tool is None:
        return f"[工具不存在] {name}"
    try:
        result = await tool.handler(args, ctx)
    except Exception as e:  # 工具失败不崩循环：错误回灌，让模型决定补救
        logger.exception("工具执行失败: %s", name)
        return f"[工具执行失败] {name}: {e}"

    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(result)


async def run_agent_loop_stream(
    *,
    user_message: str,
    registry: ToolRegistry,
    ctx: AgentContext | None = None,
    system_prompt: str | None = None,
    provider: TextProvider | None = None,
    model: str | None = None,
    history: list[dict] | None = None,
    max_turns: int = 8,
    max_tokens: int = 2000,
):
    """流式版 ReAct 循环：边跑边 yield 事件 dict，供 SSE 推给前端。

    事件类型：
    - {"type": "token", "content": <片段>}        最终答复文本（逐片）
    - {"type": "tool_call", "tool", "args", "id"}  模型决定调某工具
    - {"type": "tool_result", "tool", "id", "content"}  工具执行结果
    - {"type": "final", "content": <完整答复>}     收敛的最终答复全文
    - {"type": "done", "turns", "stopped_reason"}  收尾（恒为最后一条）
    """
    provider = provider or ProviderFactory.get_orchestration_provider()
    model = model or settings.effective_orchestration_model
    ctx = ctx or AgentContext()

    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    tools = registry.to_openai_tools()

    for turn in range(1, max_turns + 1):
        sink: list[dict] = []
        parts: list[str] = []
        async for tok in provider.generate_stream(
            TextRequest(messages=messages, tools=tools, tool_choice="auto", model=model, max_tokens=max_tokens),
            tool_calls_sink=sink,
        ):
            parts.append(tok)
            yield {"type": "token", "content": tok}
        text = "".join(parts)

        # 无工具调用 → 本轮文本即最终答复
        if not sink:
            yield {"type": "final", "content": text}
            yield {"type": "done", "turns": turn, "stopped_reason": "final"}
            return

        # 工具调用轮：assistant(tool_calls) 回灌 → 逐个执行 → 结果回灌
        messages.append({"role": "assistant", "content": text, "tool_calls": sink})
        for tc in sink:
            tc_id = tc.get("id")
            fn = tc.get("function") or {}
            name = fn.get("name")
            args = _parse_args(fn.get("arguments"))

            tool = registry.get(name) if name else None
            if tool is not None and tool.requires_approval:
                # 审批闸（proposal 模式）：不在循环里执行，吐 approval_request 让前端弹确认，
                # 把"待确认"回灌让模型讲方案；用户确认后走独立的 /agent/execute 执行。
                yield {"type": "approval_request", "tool": name, "args": args, "id": tc_id}
                pending = _APPROVAL_PENDING_MSG.format(name=name)
                yield {"type": "tool_result", "tool": name, "id": tc_id, "content": pending}
                messages.append({"role": "tool", "tool_call_id": tc_id, "content": pending})
                continue

            yield {"type": "tool_call", "tool": name, "args": args, "id": tc_id}
            result = await _execute_tool(registry, name, args, ctx)
            yield {"type": "tool_result", "tool": name, "id": tc_id, "content": result}
            messages.append({"role": "tool", "tool_call_id": tc_id, "content": result})

    # 达到 max_turns 仍未收敛
    logger.warning("agent stream loop 达到 max_turns=%s 仍未结束", max_turns)
    yield {"type": "final", "content": ""}
    yield {"type": "done", "turns": max_turns, "stopped_reason": "max_turns"}
