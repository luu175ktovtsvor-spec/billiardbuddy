"""Gap C · autocompact 触发用【真实 token】+ 阈值口径(窗口−buffer) + 图片 token 估值。

旧问题：① 触发纯靠估算（明明已从 provider 拿到 usage.prompt_tokens 却没喂触发判断）；
        ② 阈值"窗口×0.7"在 1M 窗口下 700k 就压（太早，白丢上下文/毁缓存）；③ 图片 token 低估。
本批锁住：
- 阈值 = max(窗口−buffer, 窗口×ratio)：大窗(1M)由 buffer 主导→接近满(~952k)才压、不是 700k；小窗仍走 ratio 不回归。
- 触发判据 effective = max(估算, ctx.last_prompt_tokens)：有真值用真值兜住估算误差；无真值退估算。
- 压缩成功后 last_prompt_tokens 复位 0：防"旧的大真值"在下一轮立刻又触发一次（双重压缩）。
- _IMG_TOKEN_EST 1000→2000。
- 三级压缩本体逻辑（怎么压）不变，只改"何时触发 + 用什么数触发"。
不需要真 key，全部 mock。
"""
import asyncio
from unittest.mock import MagicMock

from services.agent.context import AgentContext
from services.agent.loop import (
    run_agent_loop, run_agent_loop_stream,
    _compact_pipeline, _autocompact, _estimate_tokens,
    _IMG_TOKEN_EST, _AUTOCOMPACT_BUFFER_TOKENS, _AUTOCOMPACT_SUMMARY_MARK,
)
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


def _history(n_pairs, chunk=4000):
    msgs = [{"role": "system", "content": "你是台球房运营助手"}]
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"老板诉求{i}：" + "啊" * chunk})
        msgs.append({"role": "assistant", "content": f"助手答复{i}：" + "好" * chunk})
    return msgs


class _CountingProvider(MockTextProvider):
    def __init__(self):
        super().__init__()
        self.calls = 0

    async def generate(self, request):
        self.calls += 1
        return TextResponse(content="精简摘要", model="mock")


# ---------------------------------------------------------------------------
# 图片 token 估值 1000 → 2000
# ---------------------------------------------------------------------------

def test_img_token_est_is_2000():
    assert _IMG_TOKEN_EST == 2000


def test_estimate_counts_image_as_2000():
    msgs = [{"role": "user", "content": [
        {"type": "text", "text": "看看这张"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
    ]}]
    est = _estimate_tokens(msgs)
    assert _IMG_TOKEN_EST <= est < _IMG_TOKEN_EST + 200  # ≈ 2000 + 几个文字 token


# ---------------------------------------------------------------------------
# 阈值口径：大窗用 窗口−buffer（接近满才压），小窗仍走 ratio 不回归
# ---------------------------------------------------------------------------

def test_large_window_does_not_trigger_below_buffer_threshold():
    """1M 窗口 + 真实 900k token（> 0.7×窗口=700k，但 < 窗口−buffer≈952k）→ 不压。
    证明阈值已是"窗口−buffer"而非"窗口×0.7"（否则 900k>700k 早就触发了）。"""
    ctx = AgentContext(model_ctx_window=1_000_000)
    ctx.last_prompt_tokens = 900_000
    prov = _CountingProvider()
    msgs = _history(20)  # 估算 ~160k，远低于阈值；触发与否全看真值
    out = asyncio.run(_compact_pipeline(msgs, _reg(), ctx, prov, "mock", 0.3))
    assert prov.calls == 0
    assert out == msgs


def test_large_window_triggers_via_real_tokens_above_buffer_threshold():
    """1M 窗口 + 真实 960k token（> 窗口−buffer≈952k）→ 触发；而消息估算仅 ~160k(< 阈值)，
    证明是【真实 token】喂进了触发判据（不是估算）。"""
    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=12)
    ctx.last_prompt_tokens = 960_000
    prov = _CountingProvider()
    msgs = _history(20)
    assert _estimate_tokens(msgs) < 1_000_000 - _AUTOCOMPACT_BUFFER_TOKENS  # 估算确实不到阈值
    out = asyncio.run(_compact_pipeline(msgs, _reg(), ctx, prov, "mock", 0.3))
    assert prov.calls == 1
    assert len(out) < len(msgs)


def test_small_window_keeps_ratio_floor():
    """小窗(10000) + buffer(48000) 会让 窗口−buffer 变负 → 阈值退回 窗口×ratio(=7000)，不会"永远触发"。
    真实 6000 token(< 7000)→ 不压；6000 在 0.7 之下。"""
    ctx = AgentContext(model_ctx_window=10_000, autocompact_ratio=0.7)
    ctx.last_prompt_tokens = 6_000
    prov = _CountingProvider()
    msgs = _history(1, chunk=10)  # 估算极小
    out = asyncio.run(_compact_pipeline(msgs, _reg(), ctx, prov, "mock", 0.3))
    assert prov.calls == 0  # 6000 < 7000(=10000×0.7) → 不压（buffer 没把小窗压成永远触发）


def test_estimate_fallback_when_no_real_tokens():
    """没有真值(last_prompt_tokens=0)时退回估算触发（小窗 + 长历史）→ 照常压。"""
    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    assert ctx.last_prompt_tokens == 0
    prov = _CountingProvider()
    out = asyncio.run(_compact_pipeline(_history(10), _reg(), ctx, prov, "mock", 0.3))
    assert prov.calls == 1
    assert len(out) < len(_history(10))


# ---------------------------------------------------------------------------
# 压缩成功后真值复位（防双重压缩）
# ---------------------------------------------------------------------------

def test_last_prompt_tokens_reset_after_compaction():
    """autocompact 成功后 ctx.last_prompt_tokens 复位 0——否则旧的大真值下一轮会立刻再触发一次。"""
    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    ctx.last_prompt_tokens = 999_999
    ok = MockTextProvider(scripted=[TextResponse(content="一段有效摘要", model="mock")])
    out = asyncio.run(_autocompact(_history(10), ctx, ok, "mock", 0.3))
    assert out is not None
    assert ctx.last_prompt_tokens == 0


def test_no_double_compaction_on_stale_real_tokens():
    """大真值触发压缩后，紧接着再跑一次 pipeline（消息已压短）→ 不该因旧真值再次压缩。"""
    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=12)
    ctx.last_prompt_tokens = 960_000
    prov = _CountingProvider()
    msgs = _history(20)
    out1 = asyncio.run(_compact_pipeline(msgs, _reg(), ctx, prov, "mock", 0.3))
    assert prov.calls == 1                 # 第一次：真值触发
    out2 = asyncio.run(_compact_pipeline(out1, _reg(), ctx, prov, "mock", 0.3))
    assert prov.calls == 1                 # 第二次：真值已复位、估算又短 → 不再压
    assert out2 == out1


# ---------------------------------------------------------------------------
# provider.generate 透出 prompt_tokens → loop 写进 ctx.last_prompt_tokens
# ---------------------------------------------------------------------------

def test_textresponse_carries_prompt_tokens():
    from services.ai.providers.deepseek import DeepSeekProvider
    from services.ai.base import TextRequest

    async def run():
        choice = MagicMock()
        choice.message.content = "hi"
        choice.message.tool_calls = None
        choice.finish_reason = "stop"
        usage = MagicMock()
        usage.total_tokens = 20
        usage.prompt_tokens = 17
        resp = MagicMock()
        resp.choices = [choice]
        resp.usage = usage
        p = DeepSeekProvider(api_key="k", base_url="https://x/v1")
        from unittest.mock import AsyncMock
        p._client = MagicMock()
        p._client.chat.completions.create = AsyncMock(return_value=resp)
        return await p.generate(TextRequest(prompt="x", messages=[{"role": "user", "content": "x"}]))

    out = asyncio.run(run())
    assert out.prompt_tokens == 17


def test_sync_loop_records_last_prompt_tokens():
    """同步 loop：provider 返回带 prompt_tokens 的响应 → ctx.last_prompt_tokens 被记下。"""
    provider = MockTextProvider(scripted=[
        TextResponse(content="答复", model="mock", finish_reason="stop", prompt_tokens=4321),
    ])
    ctx = AgentContext()
    asyncio.run(run_agent_loop(
        user_message="x", registry=_reg(), provider=provider, ctx=ctx,
        system_prompt="sys", max_turns=3))
    assert ctx.last_prompt_tokens == 4321


def test_stream_loop_records_last_prompt_tokens():
    """流式 loop：usage_sink 带 prompt_tokens → ctx.last_prompt_tokens 被记下。"""
    class _P(MockTextProvider):
        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "答复"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"
            if usage_sink is not None:
                usage_sink.update({"prompt_tokens": 5678, "completion_tokens": 3, "total_tokens": 5681})

    ctx = AgentContext()

    async def run():
        return [ev async for ev in run_agent_loop_stream(
            user_message="x", registry=_reg(), provider=_P(), ctx=ctx,
            system_prompt="sys", max_turns=3)]

    asyncio.run(run())
    assert ctx.last_prompt_tokens == 5678
