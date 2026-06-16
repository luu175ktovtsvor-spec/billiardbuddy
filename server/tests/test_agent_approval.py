"""P2.1 审批闸：requires_approval 的工具不在循环内执行，改提请确认。

锁住：
- 流式循环遇 requires_approval 工具 → 吐 approval_request(带 tool/args/id) + 不调 handler + 把"待确认"回灌让模型讲方案
- 非审批工具行为不变（照常执行）
- 非流式循环同样不执行审批工具，记 approval_request 步骤
"""
import asyncio

from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


async def _collect(agen):
    return [ev async for ev in agen]


def _guarded_registry(handler, name="make_poster"):
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="做海报（花钱，需确认）",
                      parameters={"type": "object", "properties": {}},
                      handler=handler, requires_approval=True))
    return reg


def test_stream_approval_tool_not_executed_emits_request():
    executed = []

    async def handler(args, ctx):
        executed.append(args)
        return "不该执行"

    reg = _guarded_registry(handler)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("make_poster", '{"desc":"周末双人半价海报"}')], finish_reason="tool_calls"),
        TextResponse(content="我准备做这张海报，确认就生成", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="做张海报", registry=reg, provider=provider)))

    types = [e["type"] for e in events]
    assert "approval_request" in types, "审批工具应吐 approval_request"
    ar = [e for e in events if e["type"] == "approval_request"][0]
    assert ar["tool"] == "make_poster"
    assert ar["args"] == {"desc": "周末双人半价海报"}
    assert executed == [], "审批工具的 handler 在循环里绝不能被执行"
    assert events[-1]["type"] == "done"
    assert [e for e in events if e["type"] == "final"], "模型应给出最终答复（讲方案请确认）"


def test_stream_non_approval_tool_still_executes():
    executed = []

    async def handler(args, ctx):
        executed.append(args)
        return "查到了"

    reg = ToolRegistry()
    reg.register(Tool(name="get_x", description="查", parameters={"type": "object", "properties": {}}, handler=handler))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("get_x")], finish_reason="tool_calls"),
        TextResponse(content="结果是…", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="查", registry=reg, provider=provider)))
    assert executed == [{}], "非审批工具应照常执行"
    assert "approval_request" not in [e["type"] for e in events]


def test_agent_execute_route_registered():
    """确认执行端点 /agent/execute 必须挂上（且 router 干净 import）。"""
    from api.v1.router import router as v1_router
    paths = {r.path for r in v1_router.routes}
    assert "/agent/execute" in paths


def test_nonstream_approval_tool_not_executed():
    executed = []

    async def handler(args, ctx):
        executed.append(args)
        return "X"

    reg = _guarded_registry(handler)
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("make_poster")], finish_reason="tool_calls"),
        TextResponse(content="确认吗？", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="做海报", registry=reg, provider=provider))
    assert executed == [], "非流式循环同样不能执行审批工具"
    assert any(s.type == "approval_request" for s in res.steps), "应记 approval_request 步骤"
