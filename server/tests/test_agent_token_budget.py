"""SH-2 · token 预算递减早停 + usage 累加。

锁住：
- token_budget=None → 一轮即停，行为与现行一致（交互式零影响）、ctx.tokens_used 仍累加（喂成本看板）
- 设小预算 + 高用量 → 到 90% 强制停（优先级高于 Stop hook）
- 连续多轮增量极小（diminishing/空转）→ diminishing 停
- 推动语仅在「还有预算且本轮有产出」时出现
- 同步 run_agent_loop 与流式 run_agent_loop_stream 两入口都正确累加 + 早停
- usage 端点没返回时按 len//4 粗估
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.context import AgentContext
from services.agent.loop import (
    run_agent_loop, run_agent_loop_stream,
    _check_budget, _accumulate_usage,
    _BUDGET_OK, _BUDGET_PUSH, _BUDGET_STOP,
    _BUDGET_PUSH_MSG, _BUDGET_DIMINISH_DELTA, _BUDGET_DIMINISH_TURNS,  # noqa: F401 (用于阈值断言/可读性)
)
from services.agent.registry import Tool, ToolRegistry


def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


async def _collect(agen):
    return [ev async for ev in agen]


# ---------- _check_budget 纯逻辑 ----------

def test_budget_none_is_ok():
    ctx = AgentContext(token_budget=None)
    ctx.tokens_used = 999999
    assert _check_budget(ctx) == _BUDGET_OK


def test_budget_90_percent_stops():
    ctx = AgentContext(token_budget=1000)
    ctx.tokens_used = 900  # 正好 90%
    ctx.last_delta = 800
    assert _check_budget(ctx) == _BUDGET_STOP


def test_budget_diminishing_stops():
    ctx = AgentContext(token_budget=100000)  # 远没到 90%
    ctx.tokens_used = 1000
    ctx.last_delta = 10  # 极小增量
    ctx.budget_continuations = _BUDGET_DIMINISH_TURNS  # 连续多轮都极小
    assert _check_budget(ctx) == _BUDGET_STOP


def test_budget_push_only_with_remaining_and_output():
    ctx = AgentContext(token_budget=1000)
    ctx.tokens_used = 600  # 过半、未到 90%
    ctx.last_delta = _BUDGET_DIMINISH_DELTA + 100  # 本轮有产出
    ctx.budget_continuations = 0
    assert _check_budget(ctx) == _BUDGET_PUSH


def test_budget_no_push_when_no_output():
    ctx = AgentContext(token_budget=1000)
    ctx.tokens_used = 600
    ctx.last_delta = 10  # 没产出
    ctx.budget_continuations = 0
    assert _check_budget(ctx) == _BUDGET_OK


# ---------- _accumulate_usage ----------

def test_accumulate_real_tokens():
    ctx = AgentContext(token_budget=10000)
    _accumulate_usage(ctx, 300, "随便")
    assert ctx.tokens_used == 300
    assert ctx.last_delta == 300


def test_accumulate_fallback_estimate():
    ctx = AgentContext(token_budget=10000)
    _accumulate_usage(ctx, 0, "x" * 400)  # 端点没返回 → len//4
    assert ctx.tokens_used == 100


def test_accumulate_diminishing_counter():
    ctx = AgentContext(token_budget=10000)
    _accumulate_usage(ctx, 10, "")   # 低增量 → +1
    assert ctx.budget_continuations == 1
    _accumulate_usage(ctx, 10, "")
    assert ctx.budget_continuations == 2
    _accumulate_usage(ctx, 9999, "")  # 高增量 → 清零
    assert ctx.budget_continuations == 0


# ---------- 同步 loop ----------

def test_sync_budget_none_one_turn_stop():
    """预算 None：一轮即停，现行为不变；tokens_used 仍累加。"""
    provider = MockTextProvider(scripted=[TextResponse(content="答复", model="mock", tokens_used=500, finish_reason="stop")])
    ctx = AgentContext(token_budget=None)
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(), provider=provider, ctx=ctx))
    assert res.final_text == "答复"
    assert res.turns == 1
    assert ctx.tokens_used == 500  # 累加了（喂成本看板）


def test_sync_budget_stops_overrides_stop_hook_at_90():
    """到 90% 预算时，预算闸强制停、优先级高于 Stop hook（Stop hook 要它继续也不放行，防把空转拉回来）。"""
    # 一轮就把用量推过 90%（950/1000），自然停在无 tool_calls 分支
    provider = MockTextProvider(scripted=[
        TextResponse(content="一段很费 token 的答复", model="mock", tokens_used=950, finish_reason="stop"),
    ])
    import services.agent.loop as loopmod
    orig = loopmod.run_stop_hooks
    hook_called = {"n": 0}

    async def _always_continue(messages, ctx):
        hook_called["n"] += 1
        return "继续干别停"
    loopmod.run_stop_hooks = _always_continue
    try:
        ctx = AgentContext(token_budget=1000)
        res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(),
                                         provider=provider, ctx=ctx, max_turns=50))
    finally:
        loopmod.run_stop_hooks = orig
    assert res.stopped_reason == "final"
    assert res.turns == 1          # 预算到顶、一轮即停
    assert hook_called["n"] == 0   # Stop hook 根本没被叫（预算优先级更高）
    assert ctx.tokens_used == 950


def test_sync_stop_hook_runs_when_budget_ok():
    """对照：预算充裕时 Stop hook 照常生效（不破坏 Hook 三件之 Stop hook）。"""
    provider = MockTextProvider(scripted=[
        TextResponse(content="第一段", model="mock", tokens_used=100, finish_reason="stop"),
        TextResponse(content="补充段", model="mock", tokens_used=100, finish_reason="stop"),
    ])
    import services.agent.loop as loopmod
    orig = loopmod.run_stop_hooks
    hook_called = {"n": 0}

    async def _continue_once(messages, ctx):
        hook_called["n"] += 1
        return "再补一句"
    loopmod.run_stop_hooks = _continue_once
    try:
        ctx = AgentContext(token_budget=100000)  # 远没到预算
        res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(),
                                         provider=provider, ctx=ctx, max_turns=50))
    finally:
        loopmod.run_stop_hooks = orig
    assert hook_called["n"] == 1   # Stop hook 生效了
    assert res.turns == 2


def test_sync_push_loop_bounded_by_90_stop():
    """PUSH 持续把"已收尾"的模型再推一轮（让它收口），但用量爬到 90% 必然被 STOP 刹住，
    不会因 PUSH 无限续轮（防"一直推一直没完"）。每轮都高产出 → 用量稳步爬向 90%。"""
    scripted = [TextResponse(content=f"第{i}段", model="mock", tokens_used=1100, finish_reason="stop")
                for i in range(20)]
    provider = MockTextProvider(scripted=scripted)
    # turn1=1100(55%过半+有产出→PUSH续轮) turn2=2200(>90%→STOP刹住)
    ctx = AgentContext(token_budget=2000)
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(),
                                     provider=provider, ctx=ctx, max_turns=50))
    assert res.stopped_reason == "final"
    assert res.turns == 2             # push 一轮后被 90% 闸刹住，没跑飞
    assert ctx.tokens_used >= 2000 * 0.9


def test_sync_push_message_injected():
    """还有预算 + 有产出 + 过半 → 注入推动语再来一轮（让它收口）。"""
    # 第1轮高产出把用量推过 50%（触发 push），第2轮收尾
    provider = MockTextProvider(scripted=[
        TextResponse(content="第一段长内容", model="mock", tokens_used=600, finish_reason="stop"),
        TextResponse(content="最终收口", model="mock", tokens_used=50, finish_reason="stop"),
    ])
    ctx = AgentContext(token_budget=1000)
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(), provider=provider, ctx=ctx))
    # 第1轮 push（600/1000=60%、有产出）→ 注入推动语 continue；第2轮收尾
    assert res.turns == 2
    assert res.final_text == "最终收口"
    # 推动语进了 messages
    push_seen = any(_BUDGET_PUSH_MSG.split("{")[0] in (m.get("content") or "")
                    for m in res.messages if m.get("role") == "user")
    assert push_seen


# ---------- 流式 loop ----------

def test_stream_budget_none_one_turn():
    provider = MockTextProvider(scripted=[TextResponse(content="答复", model="mock", tokens_used=200, finish_reason="stop")])
    ctx = AgentContext(token_budget=None)
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="x", registry=_reg(), provider=provider, ctx=ctx)))
    done = [e for e in events if e["type"] == "done"][0]
    assert done["tokens_used"] == 200
    assert ctx.tokens_used == 200


def test_stream_budget_stops_overrides_stop_hook():
    """流式：到 90% 预算强制停、优先级高于 Stop hook，done 事件带真实 tokens_used。"""
    class _Burner(MockTextProvider):
        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "很费 token 的一段"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"
            if usage_sink is not None:
                usage_sink.update({"total_tokens": 950})  # 一轮就到 95%

    import services.agent.loop as loopmod
    orig = loopmod.run_stop_hooks
    hook_called = {"n": 0}

    async def _always_continue(messages, ctx):
        hook_called["n"] += 1
        return "继续"
    loopmod.run_stop_hooks = _always_continue
    try:
        ctx = AgentContext(token_budget=1000)
        events = asyncio.run(_collect(run_agent_loop_stream(
            user_message="x", registry=_reg(), provider=_Burner(), ctx=ctx, max_turns=50)))
    finally:
        loopmod.run_stop_hooks = orig
    done = [e for e in events if e["type"] == "done"][0]
    assert done["stopped_reason"] == "final"
    assert done["tokens_used"] == 950
    assert hook_called["n"] == 0  # 预算优先级高于 Stop hook
