"""SH-1 · 缺失 tool_result 自愈（消息配对修复）。

锁住 ensure_tool_pairing 的四个不变量：
- 完整配对的消息原样不变
- assistant 声明的 tool_call 缺 role:tool 结果 → 紧随其后补一条合成占位结果
- 无对应 tool_call 的孤儿 role:tool → 删除
- 同一 tool_call_id 多条 role:tool → 只保第一条
- 模拟压缩造孤儿后能修复，且配对最终满足"每个 tool_call 有且仅有一条结果"
并验证它真接进了 loop（同步+流式两入口都在 provider.generate 前调过）。
"""
import asyncio

from services.agent.message_repair import ensure_tool_pairing, _MISSING_RESULT_MARK
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _assistant(call_ids):
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {"id": cid, "type": "function", "function": {"name": "probe", "arguments": "{}"}}
            for cid in call_ids
        ],
    }


def _toolmsg(cid, content="结果"):
    return {"role": "tool", "tool_call_id": cid, "content": content}


def _pairs(messages):
    """返回 (expected tool_call id 集合, present role:tool id 列表)。"""
    expected = set()
    present = []
    for m in messages:
        if m.get("role") == "assistant":
            for tc in (m.get("tool_calls") or []):
                expected.add(tc.get("id"))
        if m.get("role") == "tool":
            present.append(m.get("tool_call_id"))
    return expected, present


def test_complete_pairing_unchanged():
    msgs = [
        {"role": "user", "content": "hi"},
        _assistant(["c1"]),
        _toolmsg("c1"),
        {"role": "assistant", "content": "done"},
    ]
    out = ensure_tool_pairing(msgs)
    assert out == msgs  # 完整配对不动


def test_missing_result_synthesized():
    msgs = [_assistant(["c1", "c2"]), _toolmsg("c1")]  # c2 缺结果
    out = ensure_tool_pairing(msgs)
    expected, present = _pairs(out)
    assert expected == {"c1", "c2"}
    assert sorted(present) == ["c1", "c2"]  # c2 被补
    synth = [m for m in out if m.get("tool_call_id") == "c2"]
    assert synth and synth[0]["content"] == _MISSING_RESULT_MARK
    # 补的位置在 assistant 之后
    a_idx = out.index([m for m in out if m.get("role") == "assistant"][0])
    c2_idx = out.index(synth[0])
    assert c2_idx > a_idx


def test_orphan_result_removed():
    msgs = [
        {"role": "user", "content": "hi"},
        _toolmsg("ghost"),  # 没有任何 assistant 声明过 ghost
    ]
    out = ensure_tool_pairing(msgs)
    _, present = _pairs(out)
    assert present == []  # 孤儿被删


def test_duplicate_id_dedup():
    msgs = [_assistant(["c1"]), _toolmsg("c1", "第一条"), _toolmsg("c1", "第二条")]
    out = ensure_tool_pairing(msgs)
    keep = [m for m in out if m.get("tool_call_id") == "c1"]
    assert len(keep) == 1
    assert keep[0]["content"] == "第一条"  # 只保第一条


def test_compaction_creates_orphan_then_repaired():
    """模拟 SH-6 压缩丢掉了某 assistant，剩下它的 tool_result 成孤儿 → 被删；
    同时另一个 assistant 的结果被压没 → 补回。最终每个保留的 tool_call 都恰好一条结果。"""
    msgs = [
        # 这个 assistant 被"压缩"删了，只剩孤儿结果 orphan
        _toolmsg("orphan"),
        _assistant(["keep1", "keep2"]),
        _toolmsg("keep1"),  # keep2 缺
    ]
    out = ensure_tool_pairing(msgs)
    expected, present = _pairs(out)
    # orphan 被删（不在 expected 里）
    assert "orphan" not in [m.get("tool_call_id") for m in out if m.get("role") == "tool"]
    # 每个 expected 恰好一条结果
    for cid in expected:
        assert present.count(cid) == 1


def test_pure_function_does_not_mutate_input():
    msgs = [_assistant(["c1"])]  # 缺结果
    snapshot = [dict(m) for m in msgs]
    ensure_tool_pairing(msgs)
    assert msgs == snapshot  # 入参未被改


def test_empty_messages():
    assert ensure_tool_pairing([]) == []


# ---- 接进 loop 的端到端验证（同步 + 流式两入口都在发请求前调了 ensure_tool_pairing）----

def _tc(name, cid, arguments="{}"):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": arguments}}


def test_loop_sync_repairs_before_request():
    """构造一条永远不回灌结果的"幽灵工具"路径不易在 loop 内自然造缺失，
    改为：用 history 注入一条带孤儿 tool_result 的脏历史，断言首轮请求前被修掉（不崩、能正常收尾）。"""
    seen_messages = {}

    class _Capture(MockTextProvider):
        async def generate(self, request):
            seen_messages.setdefault("first", list(request.messages))
            return TextResponse(content="好的", model="mock", finish_reason="stop")

    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    dirty_history = [
        {"role": "user", "content": "上一轮"},
        _toolmsg("orphan_old"),  # 脏历史：孤儿 tool_result
    ]
    res = asyncio.run(run_agent_loop(user_message="新问题", registry=reg,
                                     provider=_Capture(), history=dirty_history))
    assert res.final_text == "好的"
    # 首次请求的 messages 里不应再有孤儿 orphan_old
    first = seen_messages["first"]
    assert not any(m.get("tool_call_id") == "orphan_old" for m in first)


def test_loop_stream_repairs_before_request():
    captured = {}

    class _Capture(MockTextProvider):
        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            captured.setdefault("first", list(request.messages))
            yield "好的"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"

    reg = ToolRegistry()
    reg.register(Tool(name="probe", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    dirty_history = [
        {"role": "user", "content": "上一轮"},
        _toolmsg("orphan_old"),
    ]

    async def _collect():
        return [ev async for ev in run_agent_loop_stream(
            user_message="新问题", registry=reg, provider=_Capture(), history=dirty_history)]

    asyncio.run(_collect())
    first = captured["first"]
    assert not any(m.get("tool_call_id") == "orphan_old" for m in first)
