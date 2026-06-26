"""prewarm_prompt_engine 异步预热：Startup 时在线程里加载模板，不阻塞事件循环。"""
import asyncio
from unittest.mock import patch, MagicMock

import pytest

import services.ai.prompt_engine as pe_mod
from services.ai.prompt_engine import (
    PromptEngine,
    get_prompt_engine,
    prewarm_prompt_engine,
)


@pytest.fixture(autouse=True)
def _reset_singleton():
    """每个用例前清空单例，避免互相干扰。"""
    pe_mod._instance = None
    yield
    pe_mod._instance = None


@pytest.mark.asyncio
async def test_prewarm_returns_engine_with_templates():
    """prewarm 结束后应返回一个已加载模板的 PromptEngine。"""
    engine = await prewarm_prompt_engine()
    assert isinstance(engine, PromptEngine)
    # 项目里至少有几十个 YAML 模板（明文 prompts/ 或加密包）
    assert len(engine._templates) > 0


@pytest.mark.asyncio
async def test_get_prompt_engine_returns_same_instance_after_prewarm():
    """prewarm 写入的单例应被 get_prompt_engine 复用，不再重新加载。"""
    engine = await prewarm_prompt_engine()
    same = get_prompt_engine()
    assert same is engine


@pytest.mark.asyncio
async def test_prewarm_uses_to_thread():
    """prewarm 必须经 asyncio.to_thread 把 _load_all 放线程跑，不阻塞事件循环。"""
    with patch("services.ai.prompt_engine.asyncio") as mock_asyncio:
        # 让 to_thread 返回一个 coroutine 以便 await
        async def _fake_to_thread(fn, *a, **kw):
            fn(*a, **kw)
        mock_asyncio.to_thread = MagicMock(side_effect=_fake_to_thread)

        engine = await prewarm_prompt_engine()
        mock_asyncio.to_thread.assert_called_once()
        # 传给 to_thread 的应该是 _load_all 方法
        args = mock_asyncio.to_thread.call_args
        assert args[0][0].__name__ == "_load_all"


@pytest.mark.asyncio
async def test_prewarm_idempotent():
    """连续调两次 prewarm 只加载一次，返回同一个实例。"""
    first = await prewarm_prompt_engine()
    second = await prewarm_prompt_engine()
    assert first is second
