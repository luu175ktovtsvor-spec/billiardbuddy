"""批次一 · MiMo 适配五连修（Harness优化专项 2026-07-02）的单测。全 mock，不真调模型。

覆盖：
- 1-1 内部工具性调用显式关思考：autocompact 摘要 / 强制收尾（同步+流式）/ 店脑记忆 JSON 抽取
- 1-3 温度分叉：思考开着或没传（MiMo 默认开）→ 请求【不带】temperature；显式关思考 → 带
- 1-5 max_tokens 默认提档 16384（DESKTOP_AGENT_MAX_TOKENS 覆盖逻辑保留）
- 1-6 超时对齐：内置/BYOK 统一 TEXT_PROVIDER_TIMEOUT_SECONDS(300s)，且 流式看门狗首块预算 < httpx 超时
- 1-7 缓存命中字段兼容：OpenAI 风格 usage.prompt_tokens_details.cached_tokens（MiMo）优先，
      DeepSeek 风格 usage.prompt_cache_hit_tokens 兜底；值透出 TextResponse.cached_tokens /
      usage_sink["cache_hit_tokens"]，并在 loop 记账进 ctx.last_cached_tokens / cached_tokens_total。
"""
import asyncio
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.ai.base import TEXT_PROVIDER_TIMEOUT_SECONDS, TextRequest, TextResponse
from services.ai.providers.deepseek import (
    DeepSeekProvider,
    _cached_prompt_tokens,
    _thinking_disabled,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _usage_openai_style(cached=123):
    """MiMo/OpenAI 风格：prompt_tokens_details.cached_tokens。故意同时带 DeepSeek 字段验证优先级。"""
    return SimpleNamespace(
        prompt_tokens=100, completion_tokens=10, total_tokens=110,
        prompt_tokens_details=SimpleNamespace(cached_tokens=cached),
        prompt_cache_hit_tokens=999,  # 干扰项：OpenAI 风格必须优先于它
    )


def _usage_deepseek_style(cached=77):
    """DeepSeek 风格：只有 prompt_cache_hit_tokens，没有 prompt_tokens_details。"""
    return SimpleNamespace(
        prompt_tokens=100, completion_tokens=10, total_tokens=110,
        prompt_cache_hit_tokens=cached,
    )


def _usage_plain():
    """两种缓存字段都没有。"""
    return SimpleNamespace(prompt_tokens=100, completion_tokens=10, total_tokens=110)


def _fake_completion(usage):
    choice = SimpleNamespace(
        message=SimpleNamespace(content="ok", tool_calls=None),
        finish_reason="stop",
    )
    return SimpleNamespace(choices=[choice], usage=usage)


def _provider_with_mock_client(response) -> tuple[DeepSeekProvider, AsyncMock]:
    p = DeepSeekProvider(api_key="test-key", base_url="https://api.xiaomimimo.com/v1")
    mock_client = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(return_value=response)
    p._client = mock_client  # 跳过真实 AsyncOpenAI 构造
    return p, mock_client


class _FakeStream:
    """最简可 async 迭代的假流。"""

    def __init__(self, chunks):
        self._chunks = list(chunks)

    def __aiter__(self):
        async def gen():
            for c in self._chunks:
                yield c
        return gen()


def _stream_chunks(usage):
    """一片正文 + 一片收尾 usage（OpenAI 兼容流的惯例形态）。"""
    content_chunk = SimpleNamespace(
        usage=None,
        choices=[SimpleNamespace(finish_reason=None, delta=SimpleNamespace(content="hey"))],
    )
    usage_chunk = SimpleNamespace(usage=usage, choices=[])
    return [content_chunk, usage_chunk]


# ---------------------------------------------------------------------------
# 1-3 温度分叉：思考开(或默认开) → 不发送 temperature；显式关 → 发送
# ---------------------------------------------------------------------------


class TestTemperatureFork:
    @pytest.mark.asyncio
    async def test_generate_default_thinking_omits_temperature(self):
        """MiMo 模型 + thinking=None（默认开思考）→ 请求里没有 temperature，也没有 extra_body。"""
        p, client = _provider_with_mock_client(_fake_completion(_usage_plain()))
        await p.generate(TextRequest(prompt="hi", temperature=0.3, model="mimo-v2.5"))
        kwargs = client.chat.completions.create.call_args.kwargs
        assert "temperature" not in kwargs
        assert "extra_body" not in kwargs

    @pytest.mark.asyncio
    async def test_generate_thinking_enabled_omits_temperature(self):
        """MiMo 显式开思考 → 不发送 temperature，但 extra_body 带 thinking。"""
        p, client = _provider_with_mock_client(_fake_completion(_usage_plain()))
        await p.generate(TextRequest(prompt="hi", temperature=0.3, model="mimo-v2.5", thinking={"type": "enabled"}))
        kwargs = client.chat.completions.create.call_args.kwargs
        assert "temperature" not in kwargs
        assert kwargs["extra_body"] == {"thinking": {"type": "enabled"}}

    @pytest.mark.asyncio
    async def test_generate_non_mimo_model_sends_temperature(self):
        """非 MiMo 模型（BYOK 通用端点）thinking=None 就是没思考，温度是真旋钮必须照发——
        温度分叉只对 MiMo 生效，别把 GPT/Kimi/DeepSeek 的 0.3 防跑题调校静默吞掉（复扫误伤面）。"""
        p, client = _provider_with_mock_client(_fake_completion(_usage_plain()))
        await p.generate(TextRequest(prompt="hi", temperature=0.3, model="deepseek-v4-flash"))
        kwargs = client.chat.completions.create.call_args.kwargs
        assert kwargs["temperature"] == 0.3
        assert "extra_body" not in kwargs

    @pytest.mark.asyncio
    async def test_generate_thinking_disabled_sends_temperature(self):
        """显式关思考 → 发送 temperature（此时官方才支持自定义采样）。"""
        p, client = _provider_with_mock_client(_fake_completion(_usage_plain()))
        await p.generate(TextRequest(prompt="hi", temperature=0.3, thinking={"type": "disabled"}))
        kwargs = client.chat.completions.create.call_args.kwargs
        assert kwargs["temperature"] == 0.3
        assert kwargs["extra_body"] == {"thinking": {"type": "disabled"}}

    @pytest.mark.asyncio
    async def test_stream_default_thinking_omits_temperature(self):
        """流式同款：MiMo 模型 + thinking=None → 请求不带 temperature。"""
        p, client = _provider_with_mock_client(_FakeStream(_stream_chunks(_usage_plain())))
        [t async for t in p.generate_stream(TextRequest(prompt="hi", temperature=0.3, model="mimo-v2.5"))]
        kwargs = client.chat.completions.create.call_args.kwargs
        assert "temperature" not in kwargs

    @pytest.mark.asyncio
    async def test_stream_thinking_disabled_sends_temperature(self):
        p, client = _provider_with_mock_client(_FakeStream(_stream_chunks(_usage_plain())))
        [t async for t in p.generate_stream(
            TextRequest(prompt="hi", temperature=0.5, thinking={"type": "disabled"}))]
        kwargs = client.chat.completions.create.call_args.kwargs
        assert kwargs["temperature"] == 0.5
        assert kwargs["extra_body"] == {"thinking": {"type": "disabled"}}

    def test_thinking_disabled_helper(self):
        assert _thinking_disabled({"type": "disabled"}) is True
        assert _thinking_disabled({"type": "enabled"}) is False
        assert _thinking_disabled(None) is False
        assert _thinking_disabled({}) is False


# ---------------------------------------------------------------------------
# 1-7 缓存命中字段：两种响应形态都解析对
# ---------------------------------------------------------------------------


class TestCachedTokensParsing:
    def test_openai_style_preferred(self):
        assert _cached_prompt_tokens(_usage_openai_style(cached=123)) == 123

    def test_deepseek_style_fallback(self):
        assert _cached_prompt_tokens(_usage_deepseek_style(cached=77)) == 77

    def test_details_as_dict(self):
        usage = SimpleNamespace(prompt_tokens_details={"cached_tokens": 55})
        assert _cached_prompt_tokens(usage) == 55

    def test_neither_field_is_zero(self):
        assert _cached_prompt_tokens(_usage_plain()) == 0
        assert _cached_prompt_tokens(None) == 0

    def test_magicmock_usage_defensive_zero(self):
        """MagicMock 自动属性（非 int）绝不污染统计——一律按 0。"""
        assert _cached_prompt_tokens(MagicMock()) == 0

    @pytest.mark.asyncio
    async def test_generate_exposes_cached_tokens_openai_style(self):
        p, _ = _provider_with_mock_client(_fake_completion(_usage_openai_style(cached=123)))
        resp = await p.generate(TextRequest(prompt="hi"))
        assert resp.cached_tokens == 123

    @pytest.mark.asyncio
    async def test_generate_exposes_cached_tokens_deepseek_style(self):
        p, _ = _provider_with_mock_client(_fake_completion(_usage_deepseek_style(cached=77)))
        resp = await p.generate(TextRequest(prompt="hi"))
        assert resp.cached_tokens == 77

    @pytest.mark.asyncio
    async def test_stream_usage_sink_cache_hit_openai_style(self):
        """旧 bug：流式只读 DeepSeek 字段名 → MiMo 命中恒 0。现在 OpenAI 风格也要读到。"""
        p, _ = _provider_with_mock_client(_FakeStream(_stream_chunks(_usage_openai_style(cached=88))))
        usage: dict = {}
        [t async for t in p.generate_stream(TextRequest(prompt="hi"), usage_sink=usage)]
        assert usage["cache_hit_tokens"] == 88

    @pytest.mark.asyncio
    async def test_stream_usage_sink_cache_hit_deepseek_style(self):
        p, _ = _provider_with_mock_client(_FakeStream(_stream_chunks(_usage_deepseek_style(cached=66))))
        usage: dict = {}
        [t async for t in p.generate_stream(TextRequest(prompt="hi"), usage_sink=usage)]
        assert usage["cache_hit_tokens"] == 66

    def test_loop_accumulate_usage_records_cache_hits(self):
        """loop 记账：本轮值存 ctx.last_cached_tokens，会话累计存 ctx.cached_tokens_total。"""
        from services.agent.context import AgentContext
        from services.agent.loop import _accumulate_usage

        ctx = AgentContext()
        _accumulate_usage(ctx, 100, "x", prompt_tokens=90, cached_tokens=50)
        assert ctx.last_cached_tokens == 50
        assert ctx.cached_tokens_total == 50
        _accumulate_usage(ctx, 100, "x", prompt_tokens=90, cached_tokens=30)
        assert ctx.last_cached_tokens == 30
        assert ctx.cached_tokens_total == 80
        # 端点没返回/异常类型 → 按 0 处理、累计不动
        _accumulate_usage(ctx, 100, "x", cached_tokens=MagicMock())
        assert ctx.last_cached_tokens == 0
        assert ctx.cached_tokens_total == 80


# ---------------------------------------------------------------------------
# 1-1 内部工具性调用显式关思考
# ---------------------------------------------------------------------------


class _CapturingProvider:
    """记录每次 generate/generate_stream 收到的 TextRequest。"""

    def __init__(self, content="好的"):
        self.requests: list[TextRequest] = []
        self._content = content

    async def generate(self, request: TextRequest) -> TextResponse:
        self.requests.append(request)
        return TextResponse(content=self._content, model="m", tokens_used=10)

    async def generate_stream(self, request: TextRequest, usage_sink=None,
                              tool_calls_sink=None, finish_sink=None):
        self.requests.append(request)
        yield self._content


class TestInternalCallsDisableThinking:
    @pytest.mark.asyncio
    async def test_autocompact_summary_disables_thinking(self):
        """autocompact 摘要调用必须显式关思考（不关 → reasoning 吃光 1024 → content 空 → 压缩恒失败）。"""
        from services.agent.context import AgentContext
        from services.agent.loop import _AUTOCOMPACT_SUMMARY_MAX_TOKENS, _autocompact

        provider = _CapturingProvider(content="这是摘要")
        ctx = AgentContext(model_ctx_window=1000, autocompact_keep=1)
        msgs = [{"role": "system", "content": "s"}] + [
            {"role": ("user" if i % 2 == 0 else "assistant"), "content": f"msg{i}"}
            for i in range(10)
        ]
        rebuilt = await _autocompact(msgs, ctx, provider, "m", 0.3)
        assert rebuilt is not None, "压缩应成功（摘要非空）"
        assert len(provider.requests) == 1
        req = provider.requests[0]
        assert req.thinking == {"type": "disabled"}
        assert req.max_tokens == _AUTOCOMPACT_SUMMARY_MAX_TOKENS  # 内部小值保留（关思考后够用）

    @pytest.mark.asyncio
    async def test_force_final_text_disables_thinking(self):
        from services.agent.loop import _force_final_text

        provider = _CapturingProvider(content="最终答复")
        text = await _force_final_text(provider, [{"role": "user", "content": "hi"}],
                                       "m", 4096, 0.3)
        assert text == "最终答复"
        assert provider.requests[-1].thinking == {"type": "disabled"}

    def test_stream_force_final_disables_thinking(self):
        """流式 max_turns 强制收尾那次 generate_stream 也要关思考；主循环轮不受影响（跟随入参）。"""
        from services.agent.loop import run_agent_loop_stream
        from services.agent.registry import Tool, ToolRegistry

        requests: list[TextRequest] = []

        async def _dummy_handler(args, ctx):
            return "ok"

        # 注册一个工具让主循环轮真的带 tools（空注册表 → tools=[] 为假值，主循环轮会被误判成收尾轮）
        reg = ToolRegistry()
        reg.register(Tool(name="dummy", description="d",
                          parameters={"type": "object", "properties": {}}, handler=_dummy_handler))

        class _ToolLoopProvider:
            async def generate_stream(self, request, usage_sink=None,
                                      tool_calls_sink=None, finish_sink=None):
                requests.append(request)
                if request.tools:  # 主循环轮：一直吐工具调用，不收敛 → 触发 max_turns 强制收尾
                    if tool_calls_sink is not None:
                        tool_calls_sink.append({"id": "t1", "type": "function",
                                                "function": {"name": "dummy", "arguments": "{}"}})
                else:  # 强制收尾轮（不带 tools）
                    yield "收尾"

        async def _run():
            return [ev async for ev in run_agent_loop_stream(
                user_message="hi", registry=reg,
                provider=_ToolLoopProvider(), max_turns=1)]

        events = asyncio.run(_run())
        assert events[-1]["stopped_reason"] == "max_turns"
        assert requests[0].thinking is None                      # 主循环轮：跟随入参（默认 None）
        assert requests[-1].thinking == {"type": "disabled"}     # 强制收尾轮：显式关

    @pytest.mark.asyncio
    async def test_memory_json_call_disables_thinking_and_raises_budget(self):
        """1-2 店脑记忆 JSON 抽取：extra_body 关思考 + max_tokens 默认 900 → 2000。"""
        import services.memory_service as ms

        mock_client = AsyncMock()
        resp = MagicMock()
        resp.choices = [MagicMock()]
        resp.choices[0].message.content = '{"memories": []}'
        mock_client.chat.completions.create = AsyncMock(return_value=resp)
        with patch.object(ms, "_provider_client_and_model", return_value=(mock_client, "mimo-v2.5")):
            out = await ms._json_call("sys", "user")
        kwargs = mock_client.chat.completions.create.call_args.kwargs
        assert kwargs["extra_body"] == {"thinking": {"type": "disabled"}}
        assert kwargs["max_tokens"] == 2000
        assert out == {"memories": []}


# ---------------------------------------------------------------------------
# 1-5 max_tokens 提档 + 1-6 超时对齐
# ---------------------------------------------------------------------------


class TestKnobDefaults:
    def test_default_agent_max_tokens_raised_to_16384(self):
        if os.environ.get("DESKTOP_AGENT_MAX_TOKENS"):
            pytest.skip("环境已设 DESKTOP_AGENT_MAX_TOKENS 覆盖，跳过默认值断言")
        from services.agent.loop import _DEFAULT_AGENT_MAX_TOKENS
        assert _DEFAULT_AGENT_MAX_TOKENS == 16384

    def test_text_provider_timeout_aligned_300s(self):
        """内置主路径（不传 timeout）与 BYOK 路径统一 300s；看门狗首块预算 < httpx 超时才有意义。"""
        from services.ai.providers.deepseek import _STREAM_FIRST_CHUNK_TIMEOUT

        assert TEXT_PROVIDER_TIMEOUT_SECONDS == 300.0
        p = DeepSeekProvider(api_key="k")  # 内置路径同款：默认构造
        assert p._timeout == TEXT_PROVIDER_TIMEOUT_SECONDS
        assert _STREAM_FIRST_CHUNK_TIMEOUT < TEXT_PROVIDER_TIMEOUT_SECONDS

    def test_byok_path_uses_shared_timeout_constant(self):
        """factory BYOK 路径构造的 provider 也走同一常量（不再各写各的字面量）。"""
        from services.ai.factory import ProviderFactory

        store = SimpleNamespace(
            byok_enabled=True, byok_api_key_enc="enc", byok_base_url="https://api.xiaomimimo.com/v1",
            byok_model="mimo-v2.5", id="s1",
        )
        with patch("core.crypto.try_decrypt", return_value="real-key"):
            p = ProviderFactory.get_text_provider_for_store(store)
        assert isinstance(p, DeepSeekProvider)
        assert p._timeout == TEXT_PROVIDER_TIMEOUT_SECONDS
