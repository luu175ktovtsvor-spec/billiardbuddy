# -*- coding: utf-8 -*-
"""跨轮记忆 · 流式 loop 把【完整轨迹】（含最终 assistant）暴露到 ctx.final_messages，供端点落盘。

为什么单独测：loop 内部的 messages 只到"最后一轮工具结果"为止，最终答复（无 tool_calls 的那条 assistant
正文）历来没 append 进去。落盘要的是【完整轨迹】——必须把最终答复补成尾部 assistant，否则下一轮模型看不到
自己上轮答了啥。ctx.final_messages 就是这份完整轨迹（system 仍在，落盘时再剥）。
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _registry_with(handler, name="get_today"):
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="测试工具",
                      parameters={"type": "object", "properties": {}}, handler=handler))
    return reg


async def _collect(agen):
    return [ev async for ev in agen]


def test_final_messages_includes_tool_trajectory_and_final_answer():
    async def handler(args, ctx):
        return "今天是周六"

    reg = _registry_with(handler, "get_today")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("get_today")], finish_reason="tool_calls"),
        TextResponse(content="周末人多，建议搞充值送时长", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext()
    asyncio.run(_collect(run_agent_loop_stream(
        user_message="今天该干啥", registry=reg, provider=provider, ctx=ctx, system_prompt="SYS")))

    fm = ctx.final_messages
    assert fm is not None
    assert fm[0]["role"] == "system"   # 系统提示仍在（落盘时由 transcript 层剥）
    # 工具调用 + 工具结果都在轨迹（不只是文本对）
    assert any(m.get("role") == "assistant" and m.get("tool_calls") for m in fm)
    assert any(m.get("role") == "tool" and m.get("content") == "今天是周六" for m in fm)
    # 最终答复补成了尾部 assistant 消息（轨迹完整）
    assert fm[-1] == {"role": "assistant", "content": "周末人多，建议搞充值送时长"}


def test_final_messages_for_plain_answer_includes_final():
    reg = _registry_with(lambda a, c: "x")
    provider = MockTextProvider(scripted=[TextResponse(content="你好呀", model="mock", finish_reason="stop")])
    ctx = AgentContext()
    asyncio.run(_collect(run_agent_loop_stream(
        user_message="hi", registry=reg, provider=provider, ctx=ctx, system_prompt="SYS")))

    fm = ctx.final_messages
    # 纯问答也要把最终 assistant 收进轨迹（否则下一轮看不到自己答了啥）
    assert fm[-1] == {"role": "assistant", "content": "你好呀"}
    assert any(m.get("role") == "user" and m.get("content") == "hi" for m in fm)


def test_final_messages_no_duplicate_final():
    # 防御：最终答复只补一条，不重复
    reg = _registry_with(lambda a, c: "x")
    provider = MockTextProvider(scripted=[TextResponse(content="单条回答", model="mock", finish_reason="stop")])
    ctx = AgentContext()
    asyncio.run(_collect(run_agent_loop_stream(
        user_message="hi", registry=reg, provider=provider, ctx=ctx, system_prompt="SYS")))
    assistants_with_text = [m for m in ctx.final_messages
                            if m.get("role") == "assistant" and m.get("content") == "单条回答"]
    assert len(assistants_with_text) == 1
