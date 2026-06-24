"""并发治理：生图 429(限流·没扣费)退避重试;非 429(可能已扣费)绝不重试。"""
import asyncio

import httpx
from openai import RateLimitError

from services.ai.providers.openai_image import _image_call_with_429_retry


def _resp429():
    return httpx.Response(429, headers={"retry-after": "0.01"},
                          request=httpx.Request("POST", "http://x"))


def test_image_429_retried_then_succeeds():
    calls = {"n": 0}

    async def factory():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise RateLimitError("rate limited", response=_resp429(), body=None)
        return "图字节"

    out = asyncio.run(_image_call_with_429_retry(factory, max_retries=3))
    assert out == "图字节"
    assert calls["n"] == 3  # 前两次 429 退避重试，第三次成功


def test_image_429_gives_up_after_max():
    calls = {"n": 0}

    async def factory():
        calls["n"] += 1
        raise RateLimitError("rate limited", response=_resp429(), body=None)

    try:
        asyncio.run(_image_call_with_429_retry(factory, max_retries=2))
        assert False, "超过上限应抛出"
    except RateLimitError:
        pass
    assert calls["n"] == 3  # 1 + 2 retries


def test_image_non_429_not_retried():
    """超时/连接错误这类可能已扣费 → 绝不重试，立刻抛。"""
    calls = {"n": 0}

    async def factory():
        calls["n"] += 1
        raise RuntimeError("超时之类")

    try:
        asyncio.run(_image_call_with_429_retry(factory, max_retries=3))
        assert False
    except RuntimeError:
        pass
    assert calls["n"] == 1
