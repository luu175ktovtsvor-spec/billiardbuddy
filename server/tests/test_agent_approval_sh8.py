"""SH-8 壳加固：审批理由结构化 + 连续拒绝自动回退。

锁住：
- approval_request 事件/步骤带结构化 reason{what/why/impact}（流式 + 非流式两路都要）；
- 工具可用 approval_reason 生成器自定义理由，缺字段会被补全；
- 没自定义时据 approval_class 兜底也能给出三件套；
- 同一动作连续被拒达阈值 N 后，循环不再提请该动作（不吐 approval_request），改回灌"换法子"提示；
- denial_tracker 按会话累计：record→fallback 生效；clear（成功确认）→ 复位；全局累计闸触发回退。
"""
import asyncio

from services.agent import denial_tracker
from services.agent.context import AgentContext
from services.agent.loop import (
    _DENIAL_FALLBACK_N,
    _DENIAL_FALLBACK_TOTAL,
    _action_key,
    _build_approval_reason,
    run_agent_loop,
    run_agent_loop_stream,
)
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


async def _collect(agen):
    return [ev async for ev in agen]


def _guarded_registry(handler=None, name="publish_post", reason=None, approval_class="spend"):
    async def _h(args, ctx):
        if handler:
            return await handler(args, ctx)
        return "X"
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="发布到平台（对外，需确认）",
                      parameters={"type": "object", "properties": {}},
                      handler=_h, requires_approval=True,
                      approval_class=approval_class, approval_reason=reason))
    return reg


# ── ① 结构化审批理由 ──

def test_stream_approval_request_carries_structured_reason():
    reg = _guarded_registry(name="publish_post")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("publish_post", '{"text":"周末活动"}')], finish_reason="tool_calls"),
        TextResponse(content="准备发，确认吗", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="发个动态", registry=reg, provider=provider)))
    ar = [e for e in events if e["type"] == "approval_request"][0]
    assert isinstance(ar.get("reason"), dict), "approval_request 必须带结构化 reason"
    for k in ("what", "why", "impact"):
        assert k in ar["reason"] and ar["reason"][k], f"reason 缺 {k}"


def test_nonstream_approval_step_carries_structured_reason():
    reg = _guarded_registry(name="publish_post")
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("publish_post")], finish_reason="tool_calls"),
        TextResponse(content="确认吗", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="发布", registry=reg, provider=provider))
    ar = next(s for s in res.steps if s.type == "approval_request")
    assert isinstance(ar.reason, dict)
    assert ar.reason["what"] and ar.reason["why"] and ar.reason["impact"]


def test_file_class_reason_mentions_backup_and_path():
    reg = _guarded_registry(name="edit_excel", approval_class="file")
    tool = reg.get("edit_excel")
    reason = _build_approval_reason(tool, {"path": "报表.xlsx"}, AgentContext())
    assert "报表.xlsx" in reason["impact"]
    assert "备份" in reason["impact"], "文件类理由应说明改前自动备份可回滚"


def test_custom_approval_reason_generator_used_and_completed():
    def gen(args, ctx):
        return {"what": f"发布《{args.get('title')}》"}  # 故意只给 what，缺 why/impact
    reg = _guarded_registry(name="publish_post", reason=gen)
    tool = reg.get("publish_post")
    reason = _build_approval_reason(tool, {"title": "国庆活动"}, AgentContext())
    assert reason["what"] == "发布《国庆活动》"
    assert "why" in reason and "impact" in reason, "缺的字段应被补全为键（不报 KeyError）"


def test_custom_approval_reason_error_falls_back():
    def boom(args, ctx):
        raise RuntimeError("生成炸了")
    reg = _guarded_registry(name="publish_post", reason=boom)
    tool = reg.get("publish_post")
    reason = _build_approval_reason(tool, {}, AgentContext())  # 不应抛，退回兜底
    assert reason["what"] and reason["why"] and reason["impact"]


# ── ② 连续拒绝自动回退 ──

def _approval_scripts():
    """模型每轮都想调 publish_post（被审批/回退拦），最后给一句话。够喂多轮。"""
    return [
        TextResponse(content="", model="mock",
                     tool_calls=[_tc("publish_post", '{"text":"同一条"}')], finish_reason="tool_calls"),
        TextResponse(content="好的那不发了", model="mock", finish_reason="stop"),
    ]


def test_consecutive_denials_trigger_fallback_no_more_approval():
    handled = []

    async def handler(args, ctx):
        handled.append(args)
        return "执行了"

    reg = _guarded_registry(handler=handler, name="publish_post")
    args = {"text": "同一条"}
    key = _action_key("publish_post", args)

    # 预置：该动作已被连续拒绝达阈值 N
    ctx = AgentContext()
    ctx.denials_by_action = {key: _DENIAL_FALLBACK_N}

    provider = MockTextProvider(scripted=_approval_scripts())
    events = asyncio.run(_collect(
        run_agent_loop_stream(user_message="再发一次", registry=reg, ctx=ctx, provider=provider)))
    types = [e["type"] for e in events]
    assert "approval_request" not in types, "连拒达阈值后不应再提请该动作"
    # 应有一条 tool_result 回灌"换法子"提示
    trs = [e for e in events if e["type"] == "tool_result"]
    assert any("先不做了" in (e.get("content") or "") for e in trs), "应回灌'这个先不做了、换法子'提示"
    assert handled == [], "回退不执行工具"


def test_below_threshold_still_asks_approval():
    reg = _guarded_registry(name="publish_post")
    args = {"text": "同一条"}
    ctx = AgentContext()
    ctx.denials_by_action = {_action_key("publish_post", args): _DENIAL_FALLBACK_N - 1}  # 还差一次
    provider = MockTextProvider(scripted=_approval_scripts())
    events = asyncio.run(_collect(
        run_agent_loop_stream(user_message="再发一次", registry=reg, ctx=ctx, provider=provider)))
    assert "approval_request" in [e["type"] for e in events], "未达阈值仍应正常提请确认"


def test_global_total_denials_trigger_fallback():
    reg = _guarded_registry(name="publish_post")
    ctx = AgentContext()
    ctx.denials_total = _DENIAL_FALLBACK_TOTAL  # 全局累计拒太多 → 整体回退
    provider = MockTextProvider(scripted=_approval_scripts())
    events = asyncio.run(_collect(
        run_agent_loop_stream(user_message="发", registry=reg, ctx=ctx, provider=provider)))
    assert "approval_request" not in [e["type"] for e in events], "全局累计达阈值也应回退"


# ── denial_tracker 跨请求计数 ──

def test_denial_tracker_record_and_clear():
    conv = "conv-sh8-test-1"
    key = _action_key("publish_post", {"text": "x"})
    # 连拒 N 次 → 注入 ctx 后判定回退
    for _ in range(_DENIAL_FALLBACK_N):
        denial_tracker.record_denial(conv, key)
    ctx = AgentContext()
    denial_tracker.load_into_ctx(ctx, conv)
    assert ctx.denials_by_action.get(key) == _DENIAL_FALLBACK_N
    # 成功确认 → 清零
    denial_tracker.clear_denial(conv, key)
    ctx2 = AgentContext()
    denial_tracker.load_into_ctx(ctx2, conv)
    assert ctx2.denials_by_action.get(key, 0) == 0, "确认执行后该动作连续拒绝计数应复位"


def test_denial_tracker_failsafe_on_none_conversation():
    # conversation_id 为空不应抛
    denial_tracker.record_denial(None, "k")
    denial_tracker.clear_denial(None, "k")
    ctx = AgentContext()
    denial_tracker.load_into_ctx(ctx, None)
    assert ctx.denials_total == 0
