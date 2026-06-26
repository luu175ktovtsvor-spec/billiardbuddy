"""Gap K · 流式 idle 看门狗 + 建流/首响应整流重试（配合 Gap A）。

旧逻辑：上游建流后"卡住不吐 token"只能干等 httpx 读超时（生产 300s = 转圈到天荒地老）。
新逻辑：
- 逐块加 idle 计时（asyncio.wait_for 包每次取 chunk）：首块预算更长（MiMo 带 reasoning 首字慢），之后更短；
  无新 chunk 超时 → 中断、按可重试错误(504)抛。
- 建流即错 / 首块前卡住（yielded=False）→ 可整流退避重试 `_STREAM_MAX_RETRIES` 次；
- 一旦吐过 token（yielded=True）→ 只能抛（重试会重复执行已展示内容，不安全）。

全部 mock + 注入极小超时/假 sleep，不真睡、跑得快。
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from openai import APIStatusError

from core.exceptions import AIProviderError
from services.ai.base import TextRequest
from services.ai.providers import deepseek as ds
from services.ai.providers.deepseek import DeepSeekProvider

_REQ = httpx.Request("POST", "https://api.deepseek.com/v1/chat/completions")


def _chunk(content=None, finish_reason=None, usage=None):
    delta = SimpleNamespace(content=content, tool_calls=None)
    choice = SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice], usage=usage)


def _status_error(code, retry_after=None):
    headers = {}
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    resp = httpx.Response(code, headers=headers, request=_REQ)
    return APIStatusError(f"status {code}", response=resp, body=None)


class _Stream:
    """假流：按脚本吐 chunk，吐到 stall_after 个后在下一次 __anext__ 永久挂起（模拟上游卡住不吐）。
    stall_after=None → 正常吐完所有 chunk 后 StopAsyncIteration。"""
    def __init__(self, chunks, stall_after=None):
        self._chunks = list(chunks)
        self._stall_after = stall_after
        self._i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._stall_after is not None and self._i >= self._stall_after:
            await asyncio.Event().wait()  # 永久挂起 → 触发 idle 看门狗 wait_for 超时
        if self._i >= len(self._chunks):
            raise StopAsyncIteration
        c = self._chunks[self._i]
        self._i += 1
        return c


def _provider_with_streams(*streams_or_errors):
    """provider，其 create 依次返回给定的流对象（或抛给定异常）。"""
    p = DeepSeekProvider(api_key="k", base_url="https://api.deepseek.com/v1")
    p._client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(
            create=AsyncMock(side_effect=list(streams_or_errors)))))
    return p


async def _collect(provider, **sinks):
    out = []
    async for tok in provider.generate_stream(TextRequest(prompt="x"), **sinks):
        if isinstance(tok, str):
            out.append(tok)
    return out


# ---------------------------------------------------------------------------
# 看门狗预算
# ---------------------------------------------------------------------------

def test_first_chunk_budget_longer_than_idle():
    """首块预算 > 之后的 idle 预算（首字慢、之后从严）。"""
    assert ds._STREAM_FIRST_CHUNK_TIMEOUT > ds._STREAM_IDLE_TIMEOUT


def test_budget_selection_first_then_idle(monkeypatch):
    """首块用 first 预算、之后每块用 idle 预算（直接拦 wait_for 看传入的 timeout）。"""
    captured = []
    real = asyncio.wait_for

    async def spy(aw, timeout):
        captured.append(timeout)
        return await real(aw, timeout=timeout)

    monkeypatch.setattr(ds.asyncio, "wait_for", spy)
    p = _provider_with_streams(_Stream([_chunk(content="a"), _chunk(content="b"),
                                        _chunk(finish_reason="stop")]))
    out = asyncio.run(_collect(p))
    assert out == ["a", "b"]
    assert captured[0] == ds._STREAM_FIRST_CHUNK_TIMEOUT
    assert all(t == ds._STREAM_IDLE_TIMEOUT for t in captured[1:])


# ---------------------------------------------------------------------------
# idle 卡住 → 中断、抛可重试
# ---------------------------------------------------------------------------

def test_stall_after_token_raises_retryable_no_retry(monkeypatch):
    """吐过 token 后卡住 → idle 看门狗中断、抛可重试(504)；但已吐 token 故【不】整流重试。"""
    monkeypatch.setattr(ds, "_STREAM_IDLE_TIMEOUT", 0.05)
    monkeypatch.setattr(ds, "_STREAM_MAX_RETRIES", 3)  # 即便允许重试，吐过 token 也不该重试
    p = _provider_with_streams(_Stream([_chunk(content="半句")], stall_after=1))
    got = []

    async def run():
        async for tok in p.generate_stream(TextRequest(prompt="x")):
            if isinstance(tok, str):
                got.append(tok)

    with pytest.raises(AIProviderError) as ei:
        asyncio.run(run())
    assert ei.value.status_code == 504
    assert got == ["半句"]                                   # 已吐的保留
    assert p._client.chat.completions.create.await_count == 1  # 没整流重试


def test_first_chunk_stall_raises_retryable_when_no_retry(monkeypatch):
    """建流后首块就卡住、且不允许整流重试 → 抛可重试(504)。"""
    monkeypatch.setattr(ds, "_STREAM_FIRST_CHUNK_TIMEOUT", 0.05)
    monkeypatch.setattr(ds, "_STREAM_MAX_RETRIES", 0)
    p = _provider_with_streams(_Stream([_chunk(content="never")], stall_after=0))
    with pytest.raises(AIProviderError) as ei:
        asyncio.run(_collect(p))
    assert ei.value.status_code == 504


def test_first_chunk_stall_retries_then_succeeds(monkeypatch):
    """首块卡住（yielded=False）→ 整流退避重试，第二条流正常吐出。"""
    monkeypatch.setattr(ds, "_STREAM_FIRST_CHUNK_TIMEOUT", 0.05)
    monkeypatch.setattr(ds, "_STREAM_MAX_RETRIES", 2)
    stalled = _Stream([_chunk(content="x")], stall_after=0)         # 第一条：首块就卡
    good = _Stream([_chunk(content="好"), _chunk(content="了", finish_reason="stop")])
    p = _provider_with_streams(stalled, good)
    with patch_sleep():
        out = asyncio.run(_collect(p))
    assert out == ["好", "了"]
    assert p._client.chat.completions.create.await_count == 2


# ---------------------------------------------------------------------------
# 建流即错（5xx/429）→ 整流重试（未吐 token）
# ---------------------------------------------------------------------------

def test_creation_5xx_retries_then_succeeds(monkeypatch):
    """建流就抛 503（yielded=False）→ 整流退避重试，第二次拿到正常流。"""
    monkeypatch.setattr(ds, "_STREAM_MAX_RETRIES", 2)
    good = _Stream([_chunk(content="ok", finish_reason="stop")])
    p = _provider_with_streams(_status_error(503), good)
    with patch_sleep():
        out = asyncio.run(_collect(p))
    assert out == ["ok"]
    assert p._client.chat.completions.create.await_count == 2


def test_creation_400_not_retried(monkeypatch):
    """建流抛 400（不可重试）→ 不重试、直接抛。"""
    monkeypatch.setattr(ds, "_STREAM_MAX_RETRIES", 3)
    p = _provider_with_streams(_status_error(400))
    with pytest.raises(AIProviderError) as ei:
        asyncio.run(_collect(p))
    assert ei.value.status_code == 400
    assert p._client.chat.completions.create.await_count == 1


def test_creation_error_after_yield_not_retried(monkeypatch):
    """第一条流吐了 token 后中途抛 502 → 已吐 token，不整流重试、原样抛。"""
    monkeypatch.setattr(ds, "_STREAM_MAX_RETRIES", 3)

    class _MidErr:
        def __init__(self):
            self._i = 0
        def __aiter__(self):
            return self
        async def __anext__(self):
            self._i += 1
            if self._i == 1:
                return _chunk(content="先吐一句")
            raise _status_error(502)

    p = DeepSeekProvider(api_key="k", base_url="https://api.deepseek.com/v1")
    p._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
        create=AsyncMock(side_effect=[_MidErr()]))))
    got = []

    async def run():
        async for tok in p.generate_stream(TextRequest(prompt="x")):
            if isinstance(tok, str):
                got.append(tok)

    with pytest.raises(AIProviderError):
        asyncio.run(run())
    assert got == ["先吐一句"]
    assert p._client.chat.completions.create.await_count == 1  # 吐过 token → 没重试


# ---------------------------------------------------------------------------
# 工具调用累积仍正常（看门狗不破坏既有流式工具解析）
# ---------------------------------------------------------------------------

def test_tool_calls_still_accumulate_under_watchdog():
    def _dtc(index, call_id=None, name=None, args=None):
        return SimpleNamespace(index=index, id=call_id,
                               type="function" if call_id else None,
                               function=SimpleNamespace(name=name, arguments=args))

    def _tc_chunk(tcs):
        delta = SimpleNamespace(content=None, tool_calls=tcs)
        return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=None)], usage=None)

    chunks = [
        _tc_chunk([_dtc(0, call_id="c1", name="get_today", args='{"ci')]),
        _tc_chunk([_dtc(0, args='ty":"成都"}')]),
    ]
    p = _provider_with_streams(_Stream(chunks))
    sink: list = []
    asyncio.run(_collect(p, tool_calls_sink=sink))
    assert sink == [{"id": "c1", "type": "function",
                     "function": {"name": "get_today", "arguments": '{"city":"成都"}'}}]


# small helper: patch asyncio.sleep so backoff between retries doesn't really wait
class patch_sleep:
    def __enter__(self):
        from unittest.mock import patch as _p
        self._ctx = _p("services.ai.providers.deepseek.asyncio.sleep", new_callable=AsyncMock)
        self._m = self._ctx.__enter__()
        return self._m

    def __exit__(self, *a):
        return self._ctx.__exit__(*a)
