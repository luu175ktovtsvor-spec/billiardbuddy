"""防打转（anti-spin）：同一工具+完全相同参数反复调，超阈值拦下逼模型换思路。"""
import asyncio

from services.agent.loop import run_agent_loop, _MAX_SAME_CALL
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, cid):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": "{}"}}


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
    assert calls["n"] == _MAX_SAME_CALL  # 只前 N 次真执行
    assert any(s.type == "tool_result" and "别重复了" in s.content for s in res.steps)


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
