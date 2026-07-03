"""F-7 只读并发（读写锁）：一批 tool_calls 里，【确证并发安全】的工具（Tool.concurrent_safe=True）
并发跑（asyncio.gather），写类/非执行类工具（错误/提问/回退/待确认/写改）继续独占串行，且回灌进
messages 的 tool 结果必须按原 tool_calls 顺序（保序 + tool_call_id 配对完整——错了会触发 provider 400）。

⚠️ F-7 复审修复（Critical 竞态，2026-07-03）：分组判据【曾经】是 `read_only=True`，但审计发现部分
read_only=True 的工具（如 get_today_recommendation/recall_my_content/diagnose_from_pos）handler 内部
真碰 `ctx.db`（AsyncSession），并发跑会撞 `InvalidRequestError`（AsyncSession 不允许并发操作，真实用
sqlite+aiosqlite 复现 100% 必炸）。现改为 fail-safe 的显式白名单字段 `concurrent_safe`（默认 False），
本文件的 `_ro_tool` 测试替身相应改为同时设 `read_only=True, concurrent_safe=True`（模拟"审计确认过、
真安全"的工具）；真实 ctx.db 竞态回归测试 + 真实注册表审计闸见 `test_agent_loop_db_concurrency_safety.py`。

覆盖：
- 纯算法层：`_group_plans_for_concurrency` 的分组编排（连续并发安全工具合并、写/非执行类打断连续段、
  模型自评 high 风险升级为 needs_approval 的工具不进并发组、`concurrent_safe` 与 `read_only` 解耦——
  只信前者）——不涉及真执行、瞬时跑完。
- 行为层（真跑 asyncio.sleep 计时）：并发确实同时跑（更快）、保序回灌（与完成顺序无关）、
  写类与并发段互不重叠（不管写在前/在后/夹在两段并发段中间）、单个并发调用抛错不拖垮整批且配对完整。
  两个状态机（同步 run_agent_loop / 流式 run_agent_loop_stream）都覆盖，别只测一处。
"""
import asyncio
import time

from services.agent.loop import (
    _ToolPlan,
    _group_plans_for_concurrency,
    run_agent_loop,
    run_agent_loop_stream,
)
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, cid):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": "{}"}}


async def _noop(args, ctx):
    return "ok"


def _reg(*tools) -> ToolRegistry:
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    return reg


def _ro_tool(name, handler=_noop):
    """测试替身："审计确认过、真安全"的工具——同时设 read_only=True（无副作用契约）与
    concurrent_safe=True（并发分组判据）。真实工具里两者不总是同时为 True（如 get_today_recommendation
    是 read_only=True 但 concurrent_safe=False，见 test_agent_loop_db_concurrency_safety.py）。"""
    return Tool(name=name, description="t", parameters={"type": "object", "properties": {}},
                handler=handler, read_only=True, concurrent_safe=True)


def _rw_tool(name, handler=_noop):
    return Tool(name=name, description="t", parameters={"type": "object", "properties": {}}, handler=handler)


async def _collect(agen):
    return [ev async for ev in agen]


# ══════════════════════════════ 纯算法层：分组编排 ══════════════════════════════

def _plan(name, error=None, is_question=False, fallback=False, needs_approval=False):
    return _ToolPlan(name=name, args={}, tool_call_id=name, error=error,
                     is_question=is_question, fallback=fallback, needs_approval=needs_approval)


def test_group_two_contiguous_reads_become_one_read_group():
    reg = _reg(_ro_tool("r1"), _ro_tool("r2"))
    plans = [_plan("r1"), _plan("r2")]
    assert _group_plans_for_concurrency(plans, reg) == [("read", plans)]


def test_group_single_read_is_solo_not_read():
    """单独一个只读不必多绕一层 gather，直接走原有的单条顺序路径。"""
    reg = _reg(_ro_tool("r1"))
    plans = [_plan("r1")]
    assert _group_plans_for_concurrency(plans, reg) == [("solo", plans)]


def test_group_write_breaks_read_run_into_separate_solo_groups():
    reg = _reg(_ro_tool("r1"), _rw_tool("w1"), _ro_tool("r2"))
    plans = [_plan("r1"), _plan("w1"), _plan("r2")]
    groups = _group_plans_for_concurrency(plans, reg)
    # 写类打断连续段：r1 落单成 solo，w1 自己 solo，r2 落单成 solo —— 三组都各自独立、都不并发
    assert groups == [("solo", [plans[0]]), ("solo", [plans[1]]), ("solo", [plans[2]])]


def test_group_two_writes_never_merge_even_if_contiguous():
    reg = _reg(_rw_tool("w1"), _rw_tool("w2"))
    plans = [_plan("w1"), _plan("w2")]
    groups = _group_plans_for_concurrency(plans, reg)
    assert groups == [("solo", [plans[0]]), ("solo", [plans[1]])]


def test_group_error_plan_breaks_read_run():
    """入参错误的计划即使工具名对应只读工具，也不算"可执行只读"，不会被并入并发组。"""
    reg = _reg(_ro_tool("r1"), _ro_tool("r2"))
    err_plan = _plan("r1", error="参数不对")
    ok_plan = _plan("r2")
    groups = _group_plans_for_concurrency([err_plan, ok_plan], reg)
    assert groups == [("solo", [err_plan]), ("solo", [ok_plan])]


def test_group_question_and_fallback_plans_break_read_run():
    reg = _reg(_ro_tool("r1"), _ro_tool("r2"), _ro_tool("r3"))
    q_plan = _plan("r1", is_question=True)
    fb_plan = _plan("r2", fallback=True)
    ok_plan = _plan("r3")
    groups = _group_plans_for_concurrency([q_plan, fb_plan, ok_plan], reg)
    assert groups == [("solo", [q_plan]), ("solo", [fb_plan]), ("solo", [ok_plan])]


def test_group_risk_escalated_readonly_tool_excluded_from_concurrency():
    """审批闸 2.0 · 模型自评 high 风险会把一个本不需要审批的只读工具升级成 needs_approval——
    这类计划不能混进并发只读组（它根本不执行 handler，且不能绕过审批闸）。"""
    reg = _reg(_ro_tool("r1"), _ro_tool("r2"))
    escalated = _plan("r1", needs_approval=True)
    ok_plan = _plan("r2")
    groups = _group_plans_for_concurrency([escalated, ok_plan], reg)
    assert groups == [("solo", [escalated]), ("solo", [ok_plan])]


def test_group_unknown_tool_name_treated_as_non_readonly():
    """registry 里找不到的工具名（理论不该发生，但故障安全）→ 当非只读处理，独立成组。"""
    reg = _reg(_ro_tool("r1"))
    unknown = _plan("does_not_exist")
    ok_plan = _plan("r1")
    groups = _group_plans_for_concurrency([unknown, ok_plan], reg)
    assert groups == [("solo", [unknown]), ("solo", [ok_plan])]


def test_group_readonly_true_without_concurrent_safe_stays_solo_even_if_contiguous():
    """F-7 复审修复的核心判据变化：两个 read_only=True 但【没有】标 concurrent_safe（fail-safe
    默认 False）的连续工具，不能再像旧代码那样被合并成一个并发 read 组——必须各自独立 solo。
    这正是 get_today_recommendation/recall_my_content/diagnose_from_pos 这类真碰 ctx.db 的
    read_only 工具在真实注册表里的形状（见 test_agent_loop_db_concurrency_safety.py 的真实复现）。"""
    reg = _reg(
        Tool(name="r1", description="t", parameters={"type": "object", "properties": {}},
             handler=_noop, read_only=True),  # 故意不设 concurrent_safe
        Tool(name="r2", description="t", parameters={"type": "object", "properties": {}},
             handler=_noop, read_only=True),
    )
    plans = [_plan("r1"), _plan("r2")]
    groups = _group_plans_for_concurrency(plans, reg)
    assert groups == [("solo", [plans[0]]), ("solo", [plans[1]])]


def test_group_concurrent_safe_true_without_read_only_still_becomes_read_group():
    """反向验证判据已真正切换：两个 concurrent_safe=True 但 read_only=False（不寻常但用于证明
    解耦）的连续工具，仍会被合并成并发 read 组——分组逻辑只看 concurrent_safe，不再受 read_only
    影响（也不要求两者同时为 True）。"""
    reg = _reg(
        Tool(name="c1", description="t", parameters={"type": "object", "properties": {}},
             handler=_noop, concurrent_safe=True),  # read_only 默认 False
        Tool(name="c2", description="t", parameters={"type": "object", "properties": {}},
             handler=_noop, concurrent_safe=True),
    )
    plans = [_plan("c1"), _plan("c2")]
    groups = _group_plans_for_concurrency(plans, reg)
    assert groups == [("read", plans)]


# ══════════════════════════════ 行为层：真跑计时（同步 run_agent_loop） ══════════════════════════════

def _timed_handler(tag, delay, timeline):
    async def handler(args, ctx):
        timeline[tag] = [time.perf_counter(), None]
        await asyncio.sleep(delay)
        timeline[tag][1] = time.perf_counter()
        return f"result-{tag}"
    return handler


def test_sync_loop_concurrent_reads_faster_than_serial():
    """两个只读各睡 0.25s：并发跑应明显快于串行的 0.5s+（留足余量防慢机器偶发红）。"""
    timeline = {}
    reg = _reg(_ro_tool("r1", _timed_handler("r1", 0.25, timeline)),
              _ro_tool("r2", _timed_handler("r2", 0.25, timeline)))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("r1", "id1"), _tc("r2", "id2")],
                     finish_reason="tool_calls"),
        TextResponse(content="都查完了", model="mock", finish_reason="stop"),
    ])
    start = time.perf_counter()
    res = asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=provider))
    elapsed = time.perf_counter() - start

    assert res.final_text == "都查完了"
    assert elapsed < 0.45  # 并发≈0.25s；串行会≈0.5s+，留足余量防抖
    # 两个只读的执行区间确实重叠（互不等待）
    assert timeline["r1"][0] < timeline["r2"][1]
    assert timeline["r2"][0] < timeline["r1"][1]


def test_sync_loop_preserves_order_regardless_of_completion_timing():
    """3 个只读，最先出现的反而睡最久（最后完成）——回灌进 messages 的顺序必须仍按原 tool_calls 顺序，
    与实际完成先后无关（否则下一轮模型看到的顺序就乱了、tool_call_id 配对也会跟着乱）。"""
    timeline = {}
    reg = _reg(
        _ro_tool("slow", _timed_handler("slow", 0.3, timeline)),
        _ro_tool("fast", _timed_handler("fast", 0.05, timeline)),
        _ro_tool("mid", _timed_handler("mid", 0.15, timeline)),
    )
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("slow", "c-slow"), _tc("fast", "c-fast"), _tc("mid", "c-mid")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=provider))

    # 真实完成顺序应是 fast → mid → slow（验证测试本身确实制造了"完成顺序≠出现顺序"的场景）
    assert timeline["fast"][1] < timeline["mid"][1] < timeline["slow"][1]

    tool_msgs = [m for m in res.messages if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["c-slow", "c-fast", "c-mid"]
    assert [m["content"] for m in tool_msgs] == ["result-slow", "result-fast", "result-mid"]


def test_sync_loop_write_waits_for_preceding_concurrent_reads():
    """读连续段(r1,r2) 在前、写(w1) 在后：w1 必须等两个读都做完才开始（不与任何读重叠）。"""
    timeline = {}
    reg = _reg(
        _ro_tool("r1", _timed_handler("r1", 0.15, timeline)),
        _ro_tool("r2", _timed_handler("r2", 0.15, timeline)),
        _rw_tool("w1", _timed_handler("w1", 0.05, timeline)),
    )
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("r1", "r1id"), _tc("r2", "r2id"), _tc("w1", "w1id")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=provider))

    assert timeline["r1"][0] < timeline["r2"][1] and timeline["r2"][0] < timeline["r1"][1]  # 两读重叠
    assert timeline["w1"][0] >= timeline["r1"][1]
    assert timeline["w1"][0] >= timeline["r2"][1]


def test_sync_loop_write_before_reads_blocks_reads_from_starting():
    """写(w1) 在前：后面的读连续段必须等 w1 做完才开始跑（写独占，不许任何东西跟它重叠）。"""
    timeline = {}
    reg = _reg(
        _rw_tool("w1", _timed_handler("w1", 0.15, timeline)),
        _ro_tool("r1", _timed_handler("r1", 0.1, timeline)),
        _ro_tool("r2", _timed_handler("r2", 0.1, timeline)),
    )
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("w1", "w1id"), _tc("r1", "r1id"), _tc("r2", "r2id")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=provider))

    assert timeline["r1"][0] >= timeline["w1"][1]
    assert timeline["r2"][0] >= timeline["w1"][1]
    assert timeline["r1"][0] < timeline["r2"][1] and timeline["r2"][0] < timeline["r1"][1]  # 两读仍互相并发


def test_sync_loop_write_between_two_solo_reads_prevents_their_concurrency():
    """两个只读被一个写隔开（不连续）→ 不该被合并并发：r1 先独立跑完，再 w1，再 r2，全程互不重叠。"""
    timeline = {}
    reg = _reg(
        _ro_tool("r1", _timed_handler("r1", 0.1, timeline)),
        _rw_tool("w1", _timed_handler("w1", 0.1, timeline)),
        _ro_tool("r2", _timed_handler("r2", 0.1, timeline)),
    )
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("r1", "r1id"), _tc("w1", "w1id"), _tc("r2", "r2id")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=provider))

    assert timeline["w1"][0] >= timeline["r1"][1]
    assert timeline["r2"][0] >= timeline["w1"][1]


def test_sync_loop_one_bad_read_does_not_sink_the_batch(monkeypatch):
    """并发只读组里一个抛异常，不拖垮整批 gather：其余正常回灌、失败的那条转错误文本回灌，
    tool_call_id 配对完整、顺序不乱，循环照常收敛到最终答复（不崩）。"""
    import services.agent.loop as loop_mod
    real_execute = loop_mod._execute_tool

    async def _patched(registry, name, args, ctx):
        if name == "bad":
            raise RuntimeError("下游炸了")
        return await real_execute(registry, name, args, ctx)

    monkeypatch.setattr(loop_mod, "_execute_tool", _patched)

    reg = _reg(_ro_tool("ok1"), _ro_tool("bad"), _ro_tool("ok2"))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("ok1", "id1"), _tc("bad", "id2"), _tc("ok2", "id3")],
                     finish_reason="tool_calls"),
        TextResponse(content="都处理完了", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(loop_mod.run_agent_loop(user_message="x", registry=reg, provider=provider))

    assert res.final_text == "都处理完了"
    tool_msgs = [m for m in res.messages if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["id1", "id2", "id3"]  # 配对完整、顺序不乱
    assert tool_msgs[0]["content"] == "ok"
    assert "工具执行失败" in tool_msgs[1]["content"] and "下游炸了" in tool_msgs[1]["content"]
    assert tool_msgs[2]["content"] == "ok"


def test_sync_loop_call_counts_exact_under_concurrent_identical_calls():
    """并发安全：N 个并发调用同一工具+同参数（同一批里模型偶尔会重复调），anti-spin 计数不能因
    并发而丢更新/错乱——最终计数必须恰好等于并发调用次数（借助 call_counts_lock 防御性加锁）。"""
    from services.agent.context import AgentContext
    from services.agent.loop import _execute_tool, _MAX_SAME_CALL

    async def handler(args, ctx):
        await asyncio.sleep(0.01)
        return "x"

    reg = _reg(_ro_tool("probe", handler))
    ctx = AgentContext()

    async def _run():
        return await asyncio.gather(*(_execute_tool(reg, "probe", {}, ctx) for _ in range(5)))

    results = asyncio.run(_run())
    sig = 'probe|{}'
    assert ctx.call_counts[sig] == 5
    # 前 _MAX_SAME_CALL 次正常执行，超出的被"别重复了"拦下（无论并发调度顺序，计数总数都对）
    blocked = [r for r in results if "别重复了" in r]
    normal = [r for r in results if r == "x"]
    assert len(blocked) == 5 - _MAX_SAME_CALL
    assert len(normal) == _MAX_SAME_CALL


# ══════════════════════════════ 行为层：真跑计时（流式 run_agent_loop_stream） ══════════════════════════════

def test_stream_loop_concurrent_reads_faster_than_serial():
    timeline = {}
    reg = _reg(_ro_tool("r1", _timed_handler("r1", 0.25, timeline)),
              _ro_tool("r2", _timed_handler("r2", 0.25, timeline)))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("r1", "id1"), _tc("r2", "id2")],
                     finish_reason="tool_calls"),
        TextResponse(content="都查完了", model="mock", finish_reason="stop"),
    ])
    start = time.perf_counter()
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="x", registry=reg, provider=provider)))
    elapsed = time.perf_counter() - start

    finals = [e for e in events if e["type"] == "final"]
    assert finals and finals[0]["content"] == "都查完了"
    assert elapsed < 0.45
    assert timeline["r1"][0] < timeline["r2"][1]
    assert timeline["r2"][0] < timeline["r1"][1]
    # tool_call 事件两条都在 tool_result 之前吐出（先亮出"都在跑了"，再等结果）
    types = [e["type"] for e in events]
    tc_idxs = [i for i, t in enumerate(types) if t == "tool_call"]
    tr_idxs = [i for i, t in enumerate(types) if t == "tool_result"]
    assert max(tc_idxs) < min(tr_idxs)


def test_stream_loop_preserves_order_and_pairing_regardless_of_completion_timing():
    timeline = {}
    reg = _reg(
        _ro_tool("slow", _timed_handler("slow", 0.3, timeline)),
        _ro_tool("fast", _timed_handler("fast", 0.05, timeline)),
        _ro_tool("mid", _timed_handler("mid", 0.15, timeline)),
    )
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("slow", "c-slow"), _tc("fast", "c-fast"), _tc("mid", "c-mid")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="x", registry=reg, provider=provider)))

    assert timeline["fast"][1] < timeline["mid"][1] < timeline["slow"][1]  # 真实完成顺序 ≠ 出现顺序

    results = [e for e in events if e["type"] == "tool_result"]
    assert [e["id"] for e in results] == ["c-slow", "c-fast", "c-mid"]
    assert [e["content"] for e in results] == ["result-slow", "result-fast", "result-mid"]


def test_stream_loop_write_waits_for_preceding_concurrent_reads():
    timeline = {}
    reg = _reg(
        _ro_tool("r1", _timed_handler("r1", 0.15, timeline)),
        _ro_tool("r2", _timed_handler("r2", 0.15, timeline)),
        _rw_tool("w1", _timed_handler("w1", 0.05, timeline)),
    )
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("r1", "r1id"), _tc("r2", "r2id"), _tc("w1", "w1id")],
                     finish_reason="tool_calls"),
        TextResponse(content="done", model="mock", finish_reason="stop"),
    ])
    asyncio.run(_collect(run_agent_loop_stream(user_message="x", registry=reg, provider=provider)))

    assert timeline["w1"][0] >= timeline["r1"][1]
    assert timeline["w1"][0] >= timeline["r2"][1]


def test_stream_loop_one_bad_read_does_not_sink_the_batch(monkeypatch):
    import services.agent.loop as loop_mod
    real_execute = loop_mod._execute_tool

    async def _patched(registry, name, args, ctx):
        if name == "bad":
            raise RuntimeError("下游炸了")
        return await real_execute(registry, name, args, ctx)

    monkeypatch.setattr(loop_mod, "_execute_tool", _patched)

    reg = _reg(_ro_tool("ok1"), _ro_tool("bad"), _ro_tool("ok2"))
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("ok1", "id1"), _tc("bad", "id2"), _tc("ok2", "id3")],
                     finish_reason="tool_calls"),
        TextResponse(content="都处理完了", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(loop_mod.run_agent_loop_stream(user_message="x", registry=reg, provider=provider)))

    finals = [e for e in events if e["type"] == "final"]
    assert finals and finals[0]["content"] == "都处理完了"
    results = [e for e in events if e["type"] == "tool_result"]
    assert [e["id"] for e in results] == ["id1", "id2", "id3"]
    assert results[0]["content"] == "ok"
    assert "工具执行失败" in results[1]["content"] and "下游炸了" in results[1]["content"]
    assert results[2]["content"] == "ok"
    assert events[-1]["type"] == "done"
