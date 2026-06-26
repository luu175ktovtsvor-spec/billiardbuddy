"""DeepSeekProvider 重试退避（Gap A）+ 并发信号量测试。

⚠️ Gap A 后行为变更：5xx/超时/连接错误、429 无 Retry-After、非法 Retry-After 现在【都会】指数退避重试，
不再"白试一次/直接抛"。退避曲线/jitter/429vs529/分层的细粒度断言见 test_deepseek_backoff.py，本文件保留
"Retry-After 头 + 信号量 + generate/stream 整合"几条；retry 用例统一注入假 sleep（不真睡、跑得快）。
不需要真 API key，全部 mock。
"""
import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from openai import APIStatusError

from core.exceptions import AIProviderError
from services.ai.providers.deepseek import DeepSeekProvider, _get_semaphore, _gateway_sem_limit


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_429_error(retry_after: str | None = None) -> APIStatusError:
    """构造一个带可选 Retry-After 头的 429 APIStatusError。"""
    headers = {}
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    response = httpx.Response(
        429,
        headers=headers,
        request=httpx.Request("POST", "https://api.deepseek.com/v1/chat/completions"),
    )
    return APIStatusError("rate limited", response=response, body=None)


def _make_500_error() -> APIStatusError:
    response = httpx.Response(
        500,
        request=httpx.Request("POST", "https://api.deepseek.com/v1/chat/completions"),
    )
    return APIStatusError("server error", response=response, body=None)


def _fake_response():
    """返回一个最简 chat completion 响应 mock。"""
    choice = MagicMock()
    choice.message.content = "hello"
    choice.message.tool_calls = None
    choice.finish_reason = "stop"
    usage = MagicMock()
    usage.total_tokens = 10
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = usage
    return resp


def _provider() -> DeepSeekProvider:
    """返回一个跳过真实客户端初始化的 provider 实例。"""
    p = DeepSeekProvider(api_key="test-key", base_url="https://api.deepseek.com/v1")
    return p


# ---------------------------------------------------------------------------
# 429 retry tests
# ---------------------------------------------------------------------------


class TestRetryAfterBackoff:
    """429 + Retry-After 退避重试。"""

    @pytest.mark.asyncio
    async def test_429_with_retry_after_sleeps_and_retries(self):
        """有 Retry-After 头 → asyncio.sleep 等待 → 重试一次成功。"""
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[_make_429_error("0.01"), _fake_response()]
        )

        with patch("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            result = await DeepSeekProvider._call_with_retry(mock_client, {"model": "test"})

        mock_sleep.assert_awaited_once_with(0.01)
        assert mock_client.chat.completions.create.await_count == 2
        assert result.choices[0].message.content == "hello"

    @pytest.mark.asyncio
    async def test_429_without_retry_after_now_backs_off_and_retries(self):
        """Gap A：429 无 Retry-After 也退避重试，重试用尽后抛 429（旧逻辑是直接抛）。"""
        from services.ai.providers.deepseek import _MAX_RETRIES
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=_make_429_error(retry_after=None)
        )

        with patch("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(AIProviderError) as exc_info:
                await DeepSeekProvider._call_with_retry(mock_client, {"model": "test"})

        assert exc_info.value.status_code == 429
        assert mock_client.chat.completions.create.await_count == _MAX_RETRIES + 1

    @pytest.mark.asyncio
    async def test_persistent_429_exhausts_retries_then_raises(self):
        """持续 429（带 Retry-After）→ 退避重试用尽后抛 429。"""
        from services.ai.providers.deepseek import _MAX_RETRIES
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=_make_429_error("1"))

        with patch("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(AIProviderError) as exc_info:
                await DeepSeekProvider._call_with_retry(mock_client, {"model": "test"})

        assert exc_info.value.status_code == 429
        assert mock_client.chat.completions.create.await_count == _MAX_RETRIES + 1

    @pytest.mark.asyncio
    async def test_5xx_now_retried_then_succeeds(self):
        """Gap A：500 现在会退避重试（旧逻辑一次都不试）→ 第二次成功。"""
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[_make_500_error(), _fake_response()]
        )

        with patch("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock):
            result = await DeepSeekProvider._call_with_retry(mock_client, {"model": "test"})

        assert result.choices[0].message.content == "hello"
        assert mock_client.chat.completions.create.await_count == 2

    @pytest.mark.asyncio
    async def test_400_not_retried(self):
        """不可重试错误（400 参数错）→ 直接抛，不重试。"""
        response = httpx.Response(
            400, request=httpx.Request("POST", "https://api.deepseek.com/v1/chat/completions"))
        err = APIStatusError("bad request", response=response, body=None)
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=err)

        with pytest.raises(AIProviderError) as exc_info:
            await DeepSeekProvider._call_with_retry(mock_client, {"model": "test"})

        assert mock_client.chat.completions.create.await_count == 1
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_invalid_retry_after_falls_back_to_backoff(self):
        """Retry-After 非法 → 忽略它、改用退避兜底并重试（旧逻辑是直接抛）。"""
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[_make_429_error(retry_after="not-a-number"), _fake_response()]
        )

        with patch("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock):
            result = await DeepSeekProvider._call_with_retry(mock_client, {"model": "test"})

        assert result.choices[0].message.content == "hello"
        assert mock_client.chat.completions.create.await_count == 2


# ---------------------------------------------------------------------------
# Semaphore concurrency tests
# ---------------------------------------------------------------------------


class TestConcurrencySemaphore:
    """客户端并发信号量。"""

    @pytest.mark.asyncio
    async def test_semaphore_limits_concurrency(self):
        """信号量限制同时并发的 API 调用数不超过 limit。"""
        # 用一个小 limit 测试
        limit = 2
        sem = asyncio.Semaphore(limit)
        peak = {"current": 0, "max": 0}
        barrier = asyncio.Event()

        async def slow_call(**kwargs):
            peak["current"] += 1
            peak["max"] = max(peak["max"], peak["current"])
            await barrier.wait()  # 阻塞直到被释放
            peak["current"] -= 1
            return _fake_response()

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=slow_call)

        with patch("services.ai.providers.deepseek._get_semaphore", return_value=sem):
            provider = _provider()
            provider._client = mock_client

            from services.ai.base import TextRequest
            req = TextRequest(prompt="hi", messages=[{"role": "user", "content": "hi"}])

            # 启 5 个并发任务
            tasks = [asyncio.create_task(provider.generate(req)) for _ in range(5)]

            # 给一点时间让任务尝试获取信号量
            await asyncio.sleep(0.05)

            # 此刻应该只有 2 个在跑（信号量限制）
            assert peak["max"] == limit, f"expected max concurrency {limit}, got {peak['max']}"

            # 释放阻塞，让所有任务完成
            barrier.set()
            await asyncio.gather(*tasks)

    @pytest.mark.asyncio
    async def test_semaphore_default_limit(self):
        """默认信号量 limit 从环境变量读取，默认 5。"""
        assert _gateway_sem_limit == int(os.environ.get("GATEWAY_MAX_CONCURRENCY", "5"))

    @pytest.mark.asyncio
    async def test_semaphore_lazy_init(self):
        """_get_semaphore 惰性初始化，多次调用返回同一实例。"""
        import services.ai.providers.deepseek as mod
        # 重置全局状态
        old = mod._gateway_semaphore
        mod._gateway_semaphore = None
        try:
            s1 = _get_semaphore()
            s2 = _get_semaphore()
            assert s1 is s2
            assert isinstance(s1, asyncio.Semaphore)
        finally:
            mod._gateway_semaphore = old


# ---------------------------------------------------------------------------
# Integration: generate / generate_stream use semaphore + retry
# ---------------------------------------------------------------------------


class TestGenerateIntegration:
    """generate() 和 generate_stream() 整合：信号量 + 重试。"""

    @pytest.mark.asyncio
    async def test_generate_429_retries_under_semaphore(self):
        """generate() 遇 429 + Retry-After → 在信号量内等待重试后成功。"""
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[_make_429_error("0.01"), _fake_response()]
        )

        provider = _provider()
        provider._client = mock_client

        from services.ai.base import TextRequest
        req = TextRequest(prompt="test", messages=[{"role": "user", "content": "test"}])

        with patch("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock):
            result = await provider.generate(req)

        assert result.content == "hello"
        assert mock_client.chat.completions.create.await_count == 2

    @pytest.mark.asyncio
    async def test_generate_stream_429_retries_under_semaphore(self):
        """generate_stream() 遇 429 + Retry-After → 重试后拿到流。"""
        # 第一次 429，第二次返回一个 async iterator
        async def _fake_stream(**kwargs):
            chunk = MagicMock()
            chunk.usage = None
            choice = MagicMock()
            choice.finish_reason = "stop"
            delta = MagicMock()
            delta.content = "world"
            delta.tool_calls = None
            delta.reasoning_content = None
            delta.model_extra = None
            choice.delta = delta
            chunk.choices = [choice]
            yield chunk

        call_count = {"n": 0}

        async def side_effect(**kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise _make_429_error("0.01")
            return _fake_stream(**kwargs)

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=side_effect)

        provider = _provider()
        provider._client = mock_client

        from services.ai.base import TextRequest
        req = TextRequest(prompt="test", messages=[{"role": "user", "content": "test"}])

        collected = []
        with patch("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock):
            async for token in provider.generate_stream(req):
                if isinstance(token, str):
                    collected.append(token)

        assert collected == ["world"]
        assert call_count["n"] == 2
