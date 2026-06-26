"""Gap A · DeepSeek 指数退避 + full jitter 重试。

旧逻辑只在 429+Retry-After 时白试一次；5xx/超时/连接错误一次都不重试 → 上游一抖整轮崩。
新逻辑：可重试集合(408/429/500/502/503/504/529 + 超时 + 连接错误)做【指数退避 + full jitter】重试，
429(限流) 用满 _MAX_RETRIES、529(过载) 只试 _OVERLOAD_MAX_RETRIES 次就交给 failover 切下一档；
有合法 Retry-After 头则尊重它(封顶 _RETRY_AFTER_CAP)；不可重试(400/401/402…)直接抛。

与 failover 分层验证：本函数最终抛的仍是带 status_code 的 AIProviderError，failover 据此切档。
全部 mock，不需要真 key、注入假 sleep/rand → 不真睡、确定性。
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from openai import APIStatusError, APITimeoutError, APIConnectionError

from core.exceptions import AIProviderError
from services.ai.providers.deepseek import (
    DeepSeekProvider,
    _MAX_RETRIES, _OVERLOAD_MAX_RETRIES, _BACKOFF_BASE, _BACKOFF_CAP,
    _RETRY_AFTER_CAP, _RETRYABLE_STATUS,
)

_REQ = httpx.Request("POST", "https://api.deepseek.com/v1/chat/completions")


def _status_error(code: int, retry_after: str | None = None) -> APIStatusError:
    headers = {}
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    resp = httpx.Response(code, headers=headers, request=_REQ)
    return APIStatusError(f"status {code}", response=resp, body=None)


def _ok():
    choice = MagicMock()
    choice.message.content = "ok"
    choice.message.tool_calls = None
    choice.finish_reason = "stop"
    usage = MagicMock()
    usage.total_tokens = 3
    usage.prompt_tokens = 2
    r = MagicMock()
    r.choices = [choice]
    r.usage = usage
    return r


def _client(*side_effect):
    c = AsyncMock()
    c.chat.completions.create = AsyncMock(side_effect=list(side_effect))
    return c


class _Recorder:
    """假 sleep：记录每次等待秒数、绝不真睡。"""
    def __init__(self):
        self.waits: list[float] = []

    async def __call__(self, secs):
        self.waits.append(secs)


# ---------------------------------------------------------------------------
# 5xx / 超时 / 连接错误现在都会退避重试
# ---------------------------------------------------------------------------

class TestRetriesTransientErrors:
    @pytest.mark.asyncio
    async def test_500_then_503_then_success(self):
        client = _client(_status_error(500), _status_error(503), _ok())
        sleep = _Recorder()
        result = await DeepSeekProvider._call_with_retry(
            client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        assert result.choices[0].message.content == "ok"
        assert client.chat.completions.create.await_count == 3
        assert len(sleep.waits) == 2  # 两次失败 → 两次退避

    @pytest.mark.asyncio
    async def test_timeout_is_retried(self):
        client = _client(APITimeoutError(request=_REQ), _ok())
        sleep = _Recorder()
        result = await DeepSeekProvider._call_with_retry(
            client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        assert result.choices[0].message.content == "ok"
        assert client.chat.completions.create.await_count == 2

    @pytest.mark.asyncio
    async def test_connection_error_is_retried(self):
        client = _client(APIConnectionError(message="boom", request=_REQ), _ok())
        sleep = _Recorder()
        result = await DeepSeekProvider._call_with_retry(
            client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        assert result.choices[0].message.content == "ok"
        assert client.chat.completions.create.await_count == 2

    @pytest.mark.asyncio
    async def test_retryable_set_covers_expected_codes(self):
        assert _RETRYABLE_STATUS == {408, 429, 500, 502, 503, 504, 529}


# ---------------------------------------------------------------------------
# 退避曲线：指数增长、full jitter、封顶
# ---------------------------------------------------------------------------

class TestBackoffCurve:
    @pytest.mark.asyncio
    async def test_exponential_growth_capped(self):
        """rand=1.0(无随机) → 每次等待 == min(base*2**attempt, cap)，重试 _MAX_RETRIES 次后抛。"""
        client = _client(*([_status_error(503)] * (_MAX_RETRIES + 1)))
        sleep = _Recorder()
        with pytest.raises(AIProviderError):
            await DeepSeekProvider._call_with_retry(
                client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        expected = [min(_BACKOFF_BASE * (2 ** i), _BACKOFF_CAP) for i in range(_MAX_RETRIES)]
        assert sleep.waits == expected
        assert client.chat.completions.create.await_count == _MAX_RETRIES + 1

    @pytest.mark.asyncio
    async def test_full_jitter_scales_delay(self):
        """full jitter：wait == rand() * delay（这里 rand=0.5 → 半个 delay）。"""
        client = _client(_status_error(503), _ok())
        sleep = _Recorder()
        await DeepSeekProvider._call_with_retry(
            client, {"model": "m"}, sleep=sleep, rand=lambda: 0.5)
        assert sleep.waits == [0.5 * _BACKOFF_BASE]  # attempt0: delay=base, jitter 0.5

    @pytest.mark.asyncio
    async def test_jitter_never_exceeds_delay(self):
        """rand∈[0,1) → wait < delay，绝不超过封顶。"""
        client = _client(*([_status_error(500)] * (_MAX_RETRIES + 1)))
        sleep = _Recorder()
        with pytest.raises(AIProviderError):
            await DeepSeekProvider._call_with_retry(
                client, {"model": "m"}, sleep=sleep, rand=lambda: 0.999)
        for i, w in enumerate(sleep.waits):
            assert w <= min(_BACKOFF_BASE * (2 ** i), _BACKOFF_CAP)


# ---------------------------------------------------------------------------
# 429 vs 529 分治 + 不可重试
# ---------------------------------------------------------------------------

class TestStatusPolicy:
    @pytest.mark.asyncio
    async def test_529_overload_fewer_retries(self):
        """529(他家过载) 只退避 _OVERLOAD_MAX_RETRIES 次就抛、交给 failover 切下一档。"""
        client = _client(*([_status_error(529)] * (_MAX_RETRIES + 1)))
        sleep = _Recorder()
        with pytest.raises(AIProviderError):
            await DeepSeekProvider._call_with_retry(
                client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        assert client.chat.completions.create.await_count == _OVERLOAD_MAX_RETRIES + 1
        assert _OVERLOAD_MAX_RETRIES < _MAX_RETRIES  # 529 确实比一般少试

    @pytest.mark.asyncio
    async def test_400_not_retried(self):
        client = _client(_status_error(400))
        with pytest.raises(AIProviderError) as ei:
            await DeepSeekProvider._call_with_retry(
                client, {"model": "m"}, sleep=_Recorder(), rand=lambda: 1.0)
        assert ei.value.status_code == 400
        assert client.chat.completions.create.await_count == 1

    @pytest.mark.asyncio
    async def test_401_not_retried(self):
        client = _client(_status_error(401))
        with pytest.raises(AIProviderError):
            await DeepSeekProvider._call_with_retry(
                client, {"model": "m"}, sleep=_Recorder(), rand=lambda: 1.0)
        assert client.chat.completions.create.await_count == 1

    @pytest.mark.asyncio
    async def test_final_error_keeps_status_for_failover(self):
        """退避用尽后抛的 AIProviderError 仍带可容灾 status_code，让 failover 接力切档。"""
        from services.ai.failover import _RETRYABLE_STATUS as FAILOVER_RETRYABLE
        client = _client(*([_status_error(503)] * (_MAX_RETRIES + 1)))
        with pytest.raises(AIProviderError) as ei:
            await DeepSeekProvider._call_with_retry(
                client, {"model": "m"}, sleep=_Recorder(), rand=lambda: 1.0)
        assert ei.value.status_code in FAILOVER_RETRYABLE


# ---------------------------------------------------------------------------
# Retry-After 头
# ---------------------------------------------------------------------------

class TestRetryAfter:
    @pytest.mark.asyncio
    async def test_retry_after_honored_no_jitter(self):
        client = _client(_status_error(429, retry_after="2.5"), _ok())
        sleep = _Recorder()
        await DeepSeekProvider._call_with_retry(
            client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        assert sleep.waits == [2.5]  # 尊重头部值、不叠 jitter

    @pytest.mark.asyncio
    async def test_retry_after_capped(self):
        client = _client(_status_error(429, retry_after="9999"), _ok())
        sleep = _Recorder()
        await DeepSeekProvider._call_with_retry(
            client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        assert sleep.waits == [_RETRY_AFTER_CAP]  # 封顶防服务端给超大值挂死

    @pytest.mark.asyncio
    async def test_invalid_retry_after_falls_back_to_backoff(self):
        client = _client(_status_error(429, retry_after="not-a-number"), _ok())
        sleep = _Recorder()
        await DeepSeekProvider._call_with_retry(
            client, {"model": "m"}, sleep=sleep, rand=lambda: 1.0)
        # 非法 Retry-After → 退避兜底(attempt0: base*2^0=base)，仍重试不直接抛
        assert sleep.waits == [_BACKOFF_BASE]
        assert client.chat.completions.create.await_count == 2
