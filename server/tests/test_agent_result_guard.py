"""超大工具结果护栏（借鉴 cc-haha maxResultSizeChars）：

- 只读/查询类的超大结果回灌前截断 + 提示，护上下文窗口与 BYOK token 成本
- 成品（deliverable）是给老板的最终产物，再长也绝不截断
"""
import asyncio

from services.agent.loop import _MAX_TOOL_RESULT_CHARS, run_agent_loop
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider

_BIG = "甲" * (_MAX_TOOL_RESULT_CHARS + 8000)


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _run_with(tool: Tool):
    reg = ToolRegistry()
    reg.register(tool)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc(tool.name)], finish_reason="tool_calls"),
        TextResponse(content="好了", model="mock", finish_reason="stop"),
    ])
    return asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=provider))


async def _big_handler(args, ctx):
    return _BIG


def test_large_readonly_result_truncated():
    res = _run_with(Tool(name="reader", description="读", parameters={"type": "object", "properties": {}},
                         handler=_big_handler, read_only=True))
    tr = next(s for s in res.steps if s.type == "tool_result")
    assert "已截断" in tr.content
    assert len(tr.content) < len(_BIG)


def test_large_deliverable_result_not_truncated():
    res = _run_with(Tool(name="writer", description="写", parameters={"type": "object", "properties": {}},
                         handler=_big_handler, deliverable=True))
    tr = next(s for s in res.steps if s.type == "tool_result")
    assert tr.content == _BIG  # 成品完整、不截断
    assert "已截断" not in tr.content
