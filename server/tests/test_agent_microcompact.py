"""microcompact（借鉴 cc-haha）：循环内清理旧的只读工具结果、保留最近 N 条，省上下文 token（零 LLM）。"""
import asyncio

from services.agent.loop import run_agent_loop, _CLEARED_RESULT_MARK, _MICROCOMPACT_KEEP
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, cid):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": "{}"}}


def test_microcompact_clears_old_readonly_results():
    calls = {"n": 0}

    async def handler(args, ctx):
        calls["n"] += 1
        return f"很长很长的查询结果{calls['n']}"

    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="只读查询", parameters={"type": "object", "properties": {}},
                      handler=handler, read_only=True))

    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.turn = 0

        async def generate(self, request):
            self.turn += 1
            if self.turn <= 6:  # 调 6 次只读工具
                return TextResponse(content="", model="mock", tool_calls=[_tc("probe", f"c{self.turn}")], finish_reason="tool_calls")
            return TextResponse(content="查完了", model="mock", finish_reason="stop")

    res = asyncio.run(run_agent_loop(user_message="查一堆", registry=reg, provider=_P(), max_turns=10))

    tool_msgs = [m for m in res.messages if m.get("role") == "tool"]
    cleared = [m for m in tool_msgs if m["content"] == _CLEARED_RESULT_MARK]
    kept = [m for m in tool_msgs if m["content"] != _CLEARED_RESULT_MARK]
    assert len(tool_msgs) == 6
    assert len(cleared) == 6 - _MICROCOMPACT_KEEP   # 最旧 2 条清理
    assert len(kept) == _MICROCOMPACT_KEEP          # 最近 4 条保留原文
    assert res.final_text == "查完了"


def test_microcompact_keeps_few_results_untouched():
    """只读结果不超过 KEEP 条 → 一条都不清。"""
    async def handler(args, ctx):
        return "查询结果"

    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="只读", parameters={"type": "object", "properties": {}},
                      handler=handler, read_only=True))

    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.turn = 0

        async def generate(self, request):
            self.turn += 1
            if self.turn <= 2:
                return TextResponse(content="", model="mock", tool_calls=[_tc("probe", f"c{self.turn}")], finish_reason="tool_calls")
            return TextResponse(content="好", model="mock", finish_reason="stop")

    res = asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=_P(), max_turns=10))
    assert not any(m.get("content") == _CLEARED_RESULT_MARK for m in res.messages)
