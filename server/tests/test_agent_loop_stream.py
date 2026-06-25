"""P0.6 流式 Agent 循环（边跑边吐事件，供 SSE 推给前端）。

锁住事件协议：
- 最终答复逐 token 以 {"type":"token"} 吐出，并以 {"type":"final"} 给完整答复
- 工具调用轮吐 {"type":"tool_call"}（含 tool/args/id）与 {"type":"tool_result"}（含结果）
- 末尾恒为 {"type":"done"}（带 turns / stopped_reason）
- 工具调用→结果回灌→再出最终答复 的多轮顺序正确
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
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


def test_stream_loop_emits_final_tokens():
    async def handler(args, ctx):
        return "unused"

    reg = _registry_with(handler)
    provider = MockTextProvider(scripted=[TextResponse(content="直接回答你", model="mock", finish_reason="stop")])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="你好", registry=reg, provider=provider)))

    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert tokens == "直接回答你"
    finals = [e for e in events if e["type"] == "final"]
    assert finals and finals[0]["content"] == "直接回答你"
    assert events[-1]["type"] == "done"
    assert events[-1]["stopped_reason"] == "final"


def test_stream_loop_tool_then_final():
    async def handler(args, ctx):
        return "今天是周六"

    reg = _registry_with(handler, "get_today")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("get_today")], finish_reason="tool_calls"),
        TextResponse(content="周末建议搞个充值活动", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="今天该干啥", registry=reg, provider=provider)))

    types = [e["type"] for e in events]
    assert "tool_call" in types and "tool_result" in types
    # 顺序：tool_call 在 tool_result 之前，done 收尾
    assert types.index("tool_call") < types.index("tool_result")
    assert types[-1] == "done"

    tcall = [e for e in events if e["type"] == "tool_call"][0]
    assert tcall["tool"] == "get_today"
    tresult = [e for e in events if e["type"] == "tool_result"][0]
    assert tresult["content"] == "今天是周六"
    final = [e for e in events if e["type"] == "final"][0]
    assert final["content"] == "周末建议搞个充值活动"


def test_agent_chat_route_registered():
    """端点回归：/agent/chat 必须挂上（且 router 能干净 import）。"""
    from api.v1.router import router as v1_router
    paths = {r.path for r in v1_router.routes}
    assert "/agent/chat" in paths


def test_stream_keepalive_during_slow_tool():
    """M1 修复: 长工具执行(生图等)静默期应 yield keepalive 防 SSE 代理断流。"""
    async def slow_handler(args, ctx):
        await asyncio.sleep(6)
        return "生成完成"

    reg = _registry_with(slow_handler, "slow_tool")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("slow_tool")], finish_reason="tool_calls"),
        TextResponse(content="好了", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="做海报", registry=reg, provider=provider)))

    keepalives = [e for e in events if e.get("type") == "keepalive"]
    assert len(keepalives) >= 1, f"expected keepalive during 6s silence, got {len(keepalives)}"
    types = [e["type"] for e in events]
    tc_idx = types.index("tool_call")
    tr_idx = types.index("tool_result")
    ka_idx = types.index("keepalive")
    assert tc_idx < ka_idx < tr_idx, "keepalive should appear between tool_call and tool_result"


def test_stream_loop_done_always_last():
    async def handler(args, ctx):
        return "ok"

    reg = _registry_with(handler)
    provider = MockTextProvider(scripted=[TextResponse(content="回答", model="mock")])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="x", registry=reg, provider=provider)))
    assert sum(1 for e in events if e["type"] == "done") == 1
    assert events[-1]["type"] == "done"
