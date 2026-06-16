"""P0.4 ReAct Agent 循环骨架。

锁住：
- 模型要求调工具 → 执行 → 结果作 role:tool 回灌 → 再调模型 → 收敛到最终答复
- 首轮无 tool_calls 即直接给最终答复（1 轮）
- max_turns 兜底：模型永远要求调工具时，循环不会无限跑
- 未知工具 / 工具抛异常 → 错误回灌给模型（不崩循环），模型可补救
- tool_calls 的 arguments(JSON 字符串) 被正确解析后传给 handler
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.loop import run_agent_loop
from services.agent.registry import Tool, ToolRegistry


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _registry_with(handler, name="get_today"):
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="测试工具",
                      parameters={"type": "object", "properties": {}}, handler=handler))
    return reg


def _run(**kw):
    return asyncio.run(run_agent_loop(**kw))


def test_loop_calls_tool_then_finalizes():
    calls = []

    async def handler(args, ctx):
        calls.append(args)
        return "今天是周六"

    reg = _registry_with(handler, "get_today")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("get_today", "{}")], finish_reason="tool_calls"),
        TextResponse(content="周末建议搞个充值活动", model="mock", finish_reason="stop"),
    ])
    res = _run(user_message="今天该干啥", registry=reg, provider=provider)

    assert res.final_text == "周末建议搞个充值活动"
    assert res.stopped_reason == "final"
    assert res.turns == 2
    assert len(calls) == 1
    types = [s.type for s in res.steps]
    assert "tool_call" in types and "tool_result" in types and types[-1] == "final"
    # 工具结果作 role:tool 回灌进 messages
    assert any(m.get("role") == "tool" and m.get("content") == "今天是周六" for m in res.messages)


def test_loop_no_tools_immediate_final():
    async def handler(args, ctx):
        return "x"

    reg = _registry_with(handler)
    provider = MockTextProvider(scripted=[TextResponse(content="直接回答你", model="mock", finish_reason="stop")])
    res = _run(user_message="你好", registry=reg, provider=provider)
    assert res.final_text == "直接回答你"
    assert res.turns == 1
    assert res.stopped_reason == "final"


def test_loop_max_turns_guard():
    async def handler(args, ctx):
        return "ok"

    reg = _registry_with(handler)

    class _AlwaysToolProvider(MockTextProvider):
        async def generate(self, request):
            return TextResponse(content="", model="mock",
                                tool_calls=[_tc("get_today")], finish_reason="tool_calls")

    res = _run(user_message="x", registry=reg, provider=_AlwaysToolProvider(), max_turns=3)
    assert res.stopped_reason == "max_turns"
    assert res.turns == 3


def test_loop_unknown_tool_fed_back():
    async def handler(args, ctx):
        return "ok"

    reg = _registry_with(handler, "real_tool")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("ghost_tool")], finish_reason="tool_calls"),
        TextResponse(content="换个方式帮你", model="mock", finish_reason="stop"),
    ])
    res = _run(user_message="x", registry=reg, provider=provider)
    assert any(s.type == "tool_result" and "[工具不存在]" in s.content for s in res.steps)
    assert res.final_text == "换个方式帮你"


def test_loop_tool_error_fed_back():
    async def boom(args, ctx):
        raise RuntimeError("炸了")

    reg = _registry_with(boom, "boom")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("boom")], finish_reason="tool_calls"),
        TextResponse(content="已处理异常", model="mock", finish_reason="stop"),
    ])
    res = _run(user_message="x", registry=reg, provider=provider)
    assert any(s.type == "tool_result" and "[工具执行失败]" in s.content for s in res.steps)
    assert res.final_text == "已处理异常"


def test_loop_parses_tool_args():
    seen = {}

    async def handler(args, ctx):
        seen.update(args)
        return "ok"

    reg = _registry_with(handler, "with_args")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("with_args", '{"city":"成都","n":3}')], finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    _run(user_message="x", registry=reg, provider=provider)
    assert seen == {"city": "成都", "n": 3}
