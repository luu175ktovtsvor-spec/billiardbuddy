"""防打转（anti-spin）第一层：同一工具+完全相同参数【连续】反复调，达到阈值(5，对齐 Gemini
TOOL_CALL_LOOP_THRESHOLD)即断——第 5 次直接拦不执行；被别的调用（哪怕参数不同）打断则清零重来。"""
import asyncio

from services.agent.context import AgentContext
from services.agent.loop import _execute_tool, run_agent_loop, _MAX_SAME_CALL
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, cid, args=None):
    import json
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args or {})}}


def test_anti_spin_blocks_repeated_identical_calls():
    calls = {"n": 0}

    async def handler(args, ctx):
        calls["n"] += 1
        return "结果"

    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="t", parameters={"type": "object", "properties": {}}, handler=handler))

    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.turn = 0

        async def generate(self, request):
            self.turn += 1
            if self.turn <= 6:  # 同一工具+同样空参，连调 6 次
                return TextResponse(content="", model="mock", tool_calls=[_tc("probe", f"c{self.turn}")], finish_reason="tool_calls")
            return TextResponse(content="停", model="mock", finish_reason="stop")

    res = asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=_P(), max_turns=10))
    assert calls["n"] == _MAX_SAME_CALL - 1  # 连续第 _MAX_SAME_CALL 次起被拦，只有前 N-1 次真执行
    assert any(s.type == "tool_result" and "别重复了" in s.content for s in res.steps)


def test_anti_spin_consecutive_streak_resets_when_interrupted():
    """"连续"语义：A 调用了几次后被 B 打断，A 的连续计数应该清零重来——即便 A+B 加起来的总出现
    次数早就超过阈值，只要中途被打断过，就不该被当成"连续同参数打转"拦下。"""
    calls = {"a": 0, "b": 0}

    async def handler_a(args, ctx):
        calls["a"] += 1
        return "resultA"

    async def handler_b(args, ctx):
        calls["b"] += 1
        return "resultB"

    reg = ToolRegistry()
    reg.register(Tool(name="probe_a", description="t", parameters={"type": "object", "properties": {}}, handler=handler_a))
    reg.register(Tool(name="probe_b", description="t", parameters={"type": "object", "properties": {}}, handler=handler_b))

    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.turn = 0

        async def generate(self, request):
            self.turn += 1
            # A 连调 4 次（不到阈值 5）→ 插一次 B → A 再连调 4 次：A 的"连续"计数应该在 B 出现后清零，
            # 两段各自都不到阈值，全部应该真执行，一次都不该被拦。
            if self.turn <= 4:
                return TextResponse(content="", model="mock", tool_calls=[_tc("probe_a", f"a{self.turn}")], finish_reason="tool_calls")
            if self.turn == 5:
                return TextResponse(content="", model="mock", tool_calls=[_tc("probe_b", "b1")], finish_reason="tool_calls")
            if self.turn <= 9:
                return TextResponse(content="", model="mock", tool_calls=[_tc("probe_a", f"a{self.turn}")], finish_reason="tool_calls")
            return TextResponse(content="停", model="mock", finish_reason="stop")

    res = asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=_P(), max_turns=15))
    assert calls["a"] == 8  # 两段 4 次都真执行，没有一次被拦
    assert calls["b"] == 1
    assert not any(s.type == "tool_result" and "别重复了" in s.content for s in res.steps)


def test_anti_spin_concurrent_different_signatures_not_misjudged():
    """并发安全：一批参数各不相同的并发安全调用（典型的合法并发读批次）同时执行，不该被误判成
    打转（各签名都不相同，"连续"计数不该跨签名累计），也不该因为并发而崩/丢更新。"""
    async def handler(args, ctx):
        await asyncio.sleep(0.01)
        return f"ok-{args.get('q')}"

    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="t",
                      parameters={"type": "object", "properties": {"q": {"type": "string"}}}, handler=handler))
    ctx = AgentContext()

    async def _run():
        return await asyncio.gather(*(_execute_tool(reg, "probe", {"q": f"query{i}"}, ctx) for i in range(6)))

    results = asyncio.run(_run())
    assert not any("别重复了" in r for r in results)
    assert sorted(results) == sorted(f"ok-query{i}" for i in range(6))


def test_anti_spin_allows_different_args():
    """参数不同 → 不算打转，照常执行。"""
    calls = {"n": 0}

    async def handler(args, ctx):
        calls["n"] += 1
        return "结果"

    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="t",
                      parameters={"type": "object", "properties": {"q": {"type": "string"}}}, handler=handler))

    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.turn = 0

        async def generate(self, request):
            self.turn += 1
            if self.turn <= 5:  # 每次参数不同
                tc = {"id": f"c{self.turn}", "type": "function",
                      "function": {"name": "probe", "arguments": f'{{"q": "查询{self.turn}"}}'}}
                return TextResponse(content="", model="mock", tool_calls=[tc], finish_reason="tool_calls")
            return TextResponse(content="停", model="mock", finish_reason="stop")

    res = asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=_P(), max_turns=10))
    assert calls["n"] == 5  # 参数都不同，5 次全执行
    assert not any(s.type == "tool_result" and "别重复了" in s.content for s in res.steps)
