"""SH-6 · 三级上下文压缩第三级 autocompact（超长对话顶满窗口时的语义兜底）。

锁住：
- 未配 model_ctx_window（交互式默认）→ autocompact 整段跳过，messages 一动不动（对现有行为零影响）。
- 未临近窗口（估算 token < 窗口*ratio）→ 不触发、不花 LLM。
- 超阈值 + 较早段够长 → 触发：调一次 provider.generate 总结，messages 变短、最近 N 轮原文保留、出现摘要消息。
- 摘要生成失败（抛错 / 空摘要）→ 故障安全，回退用原 messages、绝不崩。
- 触发顺序：microcompact 先清旧只读结果，再轮到 autocompact。
- 同步与流式两入口一致。
- token_budget / max_turns 等不受影响。
"""
import asyncio

from services.agent.context import AgentContext
from services.agent.loop import (
    run_agent_loop, run_agent_loop_stream,
    _compact_pipeline, _autocompact, _estimate_tokens, _split_for_autocompact,
    _AUTOCOMPACT_SUMMARY_MARK, _AUTOCOMPACT_MIN_OLD,
)
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


async def _collect(agen):
    return [ev async for ev in agen]


def _long_history(n_pairs: int, chunk: int = 4000) -> list[dict]:
    """造一段超长 user/assistant 来回（每条 chunk 字，撑爆窗口估算）。"""
    msgs: list[dict] = [{"role": "system", "content": "你是台球房运营助手"}]
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"老板诉求{i}：" + "啊" * chunk})
        msgs.append({"role": "assistant", "content": f"助手答复{i}：" + "好" * chunk})
    return msgs


# ---------- 纯逻辑 ----------

def test_estimate_tokens_counts_content_and_tool_calls():
    msgs = [
        {"role": "user", "content": "x" * 400},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "probe", "arguments": "{}"}}]},
    ]
    est = _estimate_tokens(msgs)
    assert est >= 100  # 至少 400//4 来自 content；tool_calls 序列化再加一点


def test_estimate_tokens_never_raises():
    # content 是怪类型 / 缺字段都不该抛
    assert _estimate_tokens([{"role": "x"}, {"content": 123}, {}]) >= 0


def test_split_keeps_system_and_recent():
    msgs = _long_history(10)  # 1 system + 20 条 = 21
    idx = _split_for_autocompact(msgs, keep=12)
    assert idx >= 1                 # system 不进较早段
    assert len(msgs) - idx == 12    # 最近 12 条保留


def test_split_no_old_when_short():
    msgs = [{"role": "system", "content": "s"},
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"}]
    idx = _split_for_autocompact(msgs, keep=12)
    assert idx == 1  # 只够 system，没有可压的较早段


def test_split_does_not_start_recent_with_orphan_tool():
    """分界落在 role:tool 上时往前挪，确保最近段不以孤儿 tool_result 开头。"""
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "u0"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "probe", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "r1"},
        {"role": "assistant", "content": "done"},
    ]
    # keep=2 会让分界初值落在 index=3（role:tool）→ 应往前挪到 assistant(index=2) 之前
    idx = _split_for_autocompact(msgs, keep=2)
    assert msgs[idx].get("role") != "tool"


# ---------- _autocompact 直接驱动 ----------

def test_autocompact_disabled_without_window():
    """未配 model_ctx_window → 直接 None（不启用）。"""
    ctx = AgentContext(model_ctx_window=None)
    provider = MockTextProvider(scripted=[TextResponse(content="摘要", model="mock")])
    out = asyncio.run(_autocompact(_long_history(10), ctx, provider, "mock", 0.3))
    assert out is None


def test_autocompact_rebuilds_shorter():
    """配窗口 + 较早段够长 → 压成一条摘要，messages 变短、保留 system + 最近段。"""
    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    provider = MockTextProvider(scripted=[TextResponse(content="老板要一周文案，已产出周一周二，待办周三到周日", model="mock")])
    src = _long_history(10)  # 21 条
    out = asyncio.run(_autocompact(src, ctx, provider, "mock", 0.3))
    assert out is not None
    assert len(out) < len(src)
    assert out[0]["role"] == "system"                 # system 原样在最前
    assert any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in out)  # 有摘要消息
    # 最近 6 条原文逐字保留在尾部
    assert out[-6:] == src[-6:]


def test_autocompact_short_old_skipped():
    """较早段不足 _AUTOCOMPACT_MIN_OLD → 不值得压、返回 None。"""
    ctx = AgentContext(model_ctx_window=100, autocompact_keep=12)
    provider = MockTextProvider(scripted=[TextResponse(content="摘要", model="mock")])
    # 只有少量较早段（system + 13 条，keep=12 → 较早段=1 条 < MIN_OLD）
    msgs = [{"role": "system", "content": "s"}] + [
        {"role": "user", "content": f"u{i}"} for i in range(13)]
    assert len(msgs) - 1 - 12 < _AUTOCOMPACT_MIN_OLD
    out = asyncio.run(_autocompact(msgs, ctx, provider, "mock", 0.3))
    assert out is None


def test_autocompact_empty_summary_skipped():
    """模型返回空摘要 → 不用空摘要顶掉历史，返回 None。"""
    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    provider = MockTextProvider(scripted=[TextResponse(content="   ", model="mock")])
    out = asyncio.run(_autocompact(_long_history(10), ctx, provider, "mock", 0.3))
    assert out is None


def test_autocompact_summary_failure_safe():
    """总结调用抛错 → 故障安全返回 None、绝不抛。"""
    class _Boom(MockTextProvider):
        async def generate(self, request):
            raise RuntimeError("模型炸了")

    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    out = asyncio.run(_autocompact(_long_history(10), ctx, _Boom(), "mock", 0.3))
    assert out is None  # 没崩，干净回退


# ---------- _compact_pipeline 阈值门控 ----------

def test_pipeline_skips_autocompact_under_threshold():
    """未临近窗口 → 不调 provider.generate（不花 LLM），messages 不变。"""
    called = {"n": 0}

    class _Counting(MockTextProvider):
        async def generate(self, request):
            called["n"] += 1
            return TextResponse(content="摘要", model="mock")

    ctx = AgentContext(model_ctx_window=1_000_000)  # 窗口巨大，永远不临近
    msgs = _long_history(3)
    before = list(msgs)
    out = asyncio.run(_compact_pipeline(msgs, _reg(), ctx, _Counting(), "mock", 0.3))
    assert called["n"] == 0       # 没花 LLM
    assert out == before          # 原样


def test_pipeline_triggers_autocompact_over_threshold():
    """超阈值 → 调一次 provider.generate 总结，返回更短 messages。"""
    called = {"n": 0}

    class _Counting(MockTextProvider):
        async def generate(self, request):
            called["n"] += 1
            return TextResponse(content="精简摘要", model="mock")

    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    msgs = _long_history(10)  # 估算远超 8000*0.7
    out = asyncio.run(_compact_pipeline(msgs, _reg(), ctx, _Counting(), "mock", 0.3))
    assert called["n"] == 1
    assert len(out) < len(msgs)
    assert any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in out)


def test_pipeline_disabled_window_no_call():
    """未配窗口 → autocompact 整段跳过、不花 LLM；microcompact 仍照常（这里无只读结果故无变化）。"""
    called = {"n": 0}

    class _Counting(MockTextProvider):
        async def generate(self, request):
            called["n"] += 1
            return TextResponse(content="摘要", model="mock")

    ctx = AgentContext(model_ctx_window=None)
    msgs = _long_history(10)
    before = list(msgs)
    out = asyncio.run(_compact_pipeline(msgs, _reg(), ctx, _Counting(), "mock", 0.3))
    assert called["n"] == 0
    assert out == before


# ---------- autocompact 连续失败熔断（借鉴 CC s08）----------

def test_autocompact_failure_increments_streak_and_success_resets():
    """真失败（空摘要 / 抛错）累加 autocompact_fail_streak；一次成功清零。"""
    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    # 空摘要 = 真失败 → +1
    empty = MockTextProvider(scripted=[TextResponse(content="  ", model="mock")])
    asyncio.run(_autocompact(_long_history(10), ctx, empty, "mock", 0.3))
    assert ctx.autocompact_fail_streak == 1

    class _Boom(MockTextProvider):
        async def generate(self, request):
            raise RuntimeError("炸")

    # 抛错 = 真失败 → +1
    asyncio.run(_autocompact(_long_history(10), ctx, _Boom(), "mock", 0.3))
    assert ctx.autocompact_fail_streak == 2
    # 成功 → 清零
    ok = MockTextProvider(scripted=[TextResponse(content="一段有效摘要", model="mock")])
    asyncio.run(_autocompact(_long_history(10), ctx, ok, "mock", 0.3))
    assert ctx.autocompact_fail_streak == 0


def test_autocompact_too_short_not_counted_as_failure():
    """"较早段太短"是"不值得压"不是失败 → 不计入熔断计数（别把正常跳过误判成失败）。"""
    ctx = AgentContext(model_ctx_window=100, autocompact_keep=12)
    msgs = [{"role": "system", "content": "s"}] + [
        {"role": "user", "content": f"u{i}"} for i in range(13)]  # 较早段仅 1 条 < MIN_OLD
    prov = MockTextProvider(scripted=[TextResponse(content="摘要", model="mock")])
    asyncio.run(_autocompact(msgs, ctx, prov, "mock", 0.3))
    assert ctx.autocompact_fail_streak == 0  # 没真失败 → 计数不动


def test_pipeline_circuit_breaker_stops_burning_llm():
    """连续真失败达 _AUTOCOMPACT_FAIL_MAX → 熔断：_compact_pipeline 不再调昂贵摘要 LLM。"""
    from services.agent.loop import _AUTOCOMPACT_FAIL_MAX
    called = {"n": 0}

    class _FailCounting(MockTextProvider):
        async def generate(self, request):
            called["n"] += 1
            return TextResponse(content="", model="mock")  # 空摘要 = 真失败

    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    prov = _FailCounting()
    for _ in range(_AUTOCOMPACT_FAIL_MAX):          # 每轮都临近窗口 → 真调 LLM、失败累加
        asyncio.run(_compact_pipeline(_long_history(10), _reg(), ctx, prov, "mock", 0.3))
    assert called["n"] == _AUTOCOMPACT_FAIL_MAX
    assert ctx.autocompact_fail_streak == _AUTOCOMPACT_FAIL_MAX
    # 已达上限 → 再来一轮直接熔断，generate 不再被触达
    asyncio.run(_compact_pipeline(_long_history(10), _reg(), ctx, prov, "mock", 0.3))
    assert called["n"] == _AUTOCOMPACT_FAIL_MAX     # 没增加 = 熔断生效，不再空烧


def test_pipeline_circuit_breaker_recovers_after_success():
    """熔断阈值差一次时，一次成功清零，不会因历史失败永久停摆。"""
    from services.agent.loop import _AUTOCOMPACT_FAIL_MAX
    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    ctx.autocompact_fail_streak = _AUTOCOMPACT_FAIL_MAX - 1  # 差一次就熔断
    ok = MockTextProvider(scripted=[TextResponse(content="精简摘要B", model="mock")])
    out = asyncio.run(_compact_pipeline(_long_history(10), _reg(), ctx, ok, "mock", 0.3))
    assert ctx.autocompact_fail_streak == 0  # 成功清零
    assert any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in out)


# ---------- 同步 loop 端到端 ----------

def test_sync_loop_autocompact_shrinks_history():
    """同步入口：超长历史在每轮开头被 autocompact 压短，最终答复正常、不崩。"""
    # 主循环答复用 generate；autocompact 总结也用 generate（同一 provider）。用脚本顺序喂：
    #   第1次 generate = autocompact 摘要；第2次 generate = 主循环收尾答复。
    provider = MockTextProvider(scripted=[
        TextResponse(content="此前要点：老板要一周文案，已产出大半，待办收尾", model="mock", finish_reason="stop"),
        TextResponse(content="这是最终答复", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    history = _long_history(10)[1:]  # 去掉 system（loop 自己加 system_prompt）
    res = asyncio.run(run_agent_loop(
        user_message="继续完成", registry=_reg(), provider=provider, ctx=ctx,
        system_prompt="你是台球房助手", history=history, max_turns=5))
    assert res.final_text == "这是最终答复"
    # 历史被压短：摘要消息在轨迹里
    assert any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in res.messages)


def test_sync_loop_no_autocompact_when_disabled():
    """未配窗口：同步入口完全不碰历史（对现有交互式行为零影响）。"""
    provider = MockTextProvider(scripted=[TextResponse(content="答复", model="mock", finish_reason="stop")])
    ctx = AgentContext(model_ctx_window=None)
    history = _long_history(10)[1:]
    res = asyncio.run(run_agent_loop(
        user_message="x", registry=_reg(), provider=provider, ctx=ctx,
        system_prompt="sys", history=history, max_turns=5))
    assert res.final_text == "答复"
    assert not any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in res.messages)


def test_sync_loop_autocompact_failure_does_not_crash():
    """autocompact 期间总结抛错：主循环故障安全继续，仍给出答复、不崩。"""
    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.n = 0

        async def generate(self, request):
            self.n += 1
            # 第1次调用是 autocompact 摘要 → 抛错（触发故障安全回退）
            if self.n == 1:
                raise RuntimeError("摘要炸了")
            return TextResponse(content="照常答复", model="mock", finish_reason="stop")

    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    history = _long_history(10)[1:]
    res = asyncio.run(run_agent_loop(
        user_message="x", registry=_reg(), provider=_P(), ctx=ctx,
        system_prompt="sys", history=history, max_turns=5))
    assert res.final_text == "照常答复"  # 没崩
    # 压缩失败 → 没有摘要消息
    assert not any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in res.messages)


# ---------- 流式 loop 端到端 ----------

def test_stream_loop_autocompact_shrinks_history():
    """流式入口：autocompact 用 generate 总结、主循环用 generate_stream 收尾，两路一致地压短历史。"""
    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.gen_n = 0

        async def generate(self, request):  # autocompact 走这里
            self.gen_n += 1
            return TextResponse(content="此前要点摘要", model="mock")

        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "流式最终答复"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"
            if usage_sink is not None:
                usage_sink.update({"total_tokens": 50})

    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    history = _long_history(10)[1:]
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="继续", registry=_reg(), provider=_P(), ctx=ctx,
        system_prompt="sys", history=history, max_turns=5)))
    final = [e for e in events if e["type"] == "final"][0]
    assert final["content"] == "流式最终答复"
    done = [e for e in events if e["type"] == "done"][0]
    assert done["stopped_reason"] == "final"


def test_stream_loop_no_autocompact_when_disabled():
    """流式 + 未配窗口：不碰历史、不调 generate。"""
    called = {"gen": 0}

    class _P(MockTextProvider):
        async def generate(self, request):
            called["gen"] += 1
            return TextResponse(content="摘要", model="mock")

        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "答复"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"

    ctx = AgentContext(model_ctx_window=None)
    history = _long_history(10)[1:]
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="x", registry=_reg(), provider=_P(), ctx=ctx,
        system_prompt="sys", history=history, max_turns=5)))
    assert called["gen"] == 0  # autocompact 没触发
    final = [e for e in events if e["type"] == "final"][0]
    assert final["content"] == "答复"
