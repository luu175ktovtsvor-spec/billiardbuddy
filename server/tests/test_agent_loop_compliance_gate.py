"""P1-2：主对话合规闸测试。

背景（全仓七路审查 2026-07-02 第二节#2）：`filter_compliance`（违广告法绝对化用语确定性替换）此前
只在生成类工具内部生效（经 `filter_output_leak`），主对话正文完全不过闸——广告法红线只靠模型自觉。
修法：同步 `run_agent_loop` 与流式 `run_agent_loop_stream` 的最终 final 文本，在 `_finalize_text`
统一出口处都过一遍 `filter_compliance`；流式已吐给前端的逐 token 不追改，只保证【最终 final 事件 /
落库 / 轨迹 / 回灌历史】都是过滤后的文本。

本文件锁住：
- 同步路径三个收尾分支（正常收敛 / max_turns 强制收尾）final_text 都被过滤。
- 流式路径 final 事件内容被过滤，但已吐出的逐 token 原样不追改。
- 流式路径的 ctx.final_messages（落盘轨迹/续接历史）同样是过滤后的文本，不是只过滤对外展示的那份。
- 命中时打一行 DEBUG 日志（可观测）。
- 干净文本（不含违规词）不受影响，行为零变化。
"""
import asyncio
import logging

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _registry_with(handler, name="get_today"):
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="测试工具",
                      parameters={"type": "object", "properties": {}}, handler=handler))
    return reg


def _empty_reg():
    return ToolRegistry()


# ──────────────── 同步路径 ────────────────

def test_sync_final_text_compliance_filtered():
    provider = MockTextProvider(scripted=[
        TextResponse(content="本店全网最低价，充值终身免费", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="写个文案", registry=_empty_reg(), provider=provider))
    assert res.final_text == "本店实惠价格，充值长期优惠"
    assert "最低价" not in res.final_text
    assert "终身免费" not in res.final_text


def test_sync_clean_text_unaffected():
    provider = MockTextProvider(scripted=[
        TextResponse(content="周末建议搞个充值活动", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="写个文案", registry=_empty_reg(), provider=provider))
    assert res.final_text == "周末建议搞个充值活动"


def test_sync_max_turns_forced_final_compliance_filtered():
    """强制收尾（max_turns 兜底）路径同样要过合规闸——别改一处漏一处。"""
    async def handler(args, ctx):
        return "ok"

    reg = _registry_with(handler)

    class _ToolsThenFinalProvider(MockTextProvider):
        async def generate(self, request):
            if request.tools:
                return TextResponse(content="", model="mock",
                                    tool_calls=[_tc("get_today")], finish_reason="tool_calls")
            return TextResponse(content="全城最低价，走过路过", model="mock",
                                tool_calls=None, finish_reason="stop")

    res = asyncio.run(run_agent_loop(user_message="x", registry=reg,
                                     provider=_ToolsThenFinalProvider(), max_turns=3))
    assert res.stopped_reason == "max_turns"
    assert res.final_text == "实惠价格，走过路过"


def test_sync_compliance_hit_logs_debug(caplog):
    provider = MockTextProvider(scripted=[
        TextResponse(content="史上最低价冲量", model="mock", finish_reason="stop"),
    ])
    with caplog.at_level(logging.DEBUG, logger="services.agent.loop"):
        res = asyncio.run(run_agent_loop(user_message="x", registry=_empty_reg(), provider=provider))
    assert res.final_text == "超值价格冲量"
    assert any("合规闸命中" in r.message for r in caplog.records)


# ──────────────── 流式路径 ────────────────

def test_stream_final_event_filtered_but_raw_tokens_untouched():
    provider = MockTextProvider(scripted=[
        TextResponse(content="全城最低价大促销", model="mock", finish_reason="stop"),
    ])

    async def _run():
        return [ev async for ev in run_agent_loop_stream(
            user_message="写个海报文案", registry=_empty_reg(), provider=provider)]

    events = asyncio.run(_run())
    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1
    assert finals[0]["content"] == "实惠价格大促销"
    # 已吐给前端的逐 token 不追改（流式过滤只在最终收口生效，不做逐 token 拦截）
    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert tokens == "全城最低价大促销"


def test_stream_trajectory_also_compliance_filtered():
    """ctx.final_messages（落盘轨迹/续接历史）也必须是过滤后的文本，不能只让对外 final 事件过滤。"""
    provider = MockTextProvider(scripted=[
        TextResponse(content="全网最低价冲量", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext()

    async def _run():
        return [ev async for ev in run_agent_loop_stream(
            user_message="写个文案", registry=_empty_reg(), provider=provider, ctx=ctx)]

    asyncio.run(_run())
    assistant_msgs = [m for m in (ctx.final_messages or []) if m.get("role") == "assistant"]
    assert assistant_msgs, "轨迹应包含最终答复"
    assert assistant_msgs[-1]["content"] == "实惠价格冲量"


def test_stream_max_turns_forced_final_compliance_filtered():
    async def handler(args, ctx):
        return "ok"

    reg = _registry_with(handler)

    class _ToolLoopProvider:
        async def generate_stream(self, request, usage_sink=None,
                                  tool_calls_sink=None, finish_sink=None):
            if request.tools:  # 主循环轮：一直吐工具调用，不收敛 → 触发 max_turns 强制收尾
                if tool_calls_sink is not None:
                    tool_calls_sink.append(_tc("get_today"))
            else:  # 强制收尾轮（不带 tools）
                yield "终身免费加全城最低价"

    ctx = AgentContext()

    async def _run():
        return [ev async for ev in run_agent_loop_stream(
            user_message="x", registry=reg, provider=_ToolLoopProvider(), ctx=ctx, max_turns=1)]

    events = asyncio.run(_run())
    assert events[-1]["type"] == "done"
    assert events[-1]["stopped_reason"] == "max_turns"
    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1
    assert finals[0]["content"] == "长期优惠加实惠价格"


def test_stream_compliance_hit_logs_debug(caplog):
    provider = MockTextProvider(scripted=[
        TextResponse(content="永久免费畅打", model="mock", finish_reason="stop"),
    ])

    async def _run():
        return [ev async for ev in run_agent_loop_stream(
            user_message="x", registry=_empty_reg(), provider=provider)]

    with caplog.at_level(logging.DEBUG, logger="services.agent.loop"):
        events = asyncio.run(_run())
    finals = [e for e in events if e["type"] == "final"]
    assert finals[0]["content"] == "长期优惠畅打"
    assert any("合规闸命中" in r.message for r in caplog.records)
