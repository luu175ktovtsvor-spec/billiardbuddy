# -*- coding: utf-8 -*-
"""U2(E3b)：生图自动路由 + 并行生成 + 失败降级回 Seedream(安全网)。

背景：现状生图是纯用户手选模型 + 顺序 for 循环生成 N 张。下一批(E2)要砍掉前端模型选择器——
请求不再传 image_model 时会落到后端默认，**默认绝不能是 gpt-image-2**(大陆客户机握到美国 relay
的长连接约 60s 会被网络掐断=图丢+白扣 owner 的 key 钱，2026-07-03 实测确证)。

本文件覆盖三件：
1. 路由纯函数 `_route_image_model`（用户手选优先；没手选时启发式判断；默认落 Seedream——本单
   最重要的正确性要求，配单测钉死"不传 image_model → 不落 gpt-image-2"）。
2. 并行生成（`asyncio.gather`，在 `_get_image_semaphore()` 闸内；单张失败不拖垮整批；结果顺序
   按请求下标稳定回填，不因完成时机不同而错位）。
3. GPT 失败自动降级回 Seedream 一跳（安全网），返回结构带 `model_switched` 标记；Seedream 也失败
   才如实报错；非 GPT 路由的失败不触发降级（没有"安全网"这回事，如实失败）。

路由纯函数是无 DB 单测；并行/降级用真实 AsyncSession(sqlite+aiosqlite，与 test_run_generation_real_db.py
同款写法) + monkeypatch `ProviderFactory.build_image_provider` 返回可控假 provider(不碰真实网络/不花钱)。
"""
import asyncio
import io
import uuid

import pytest
from PIL import Image
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import models  # noqa: F401  触发全部模型注册
from db.base import Base
from models.store import Store
from models.user import User
from services import poster_service
from services.poster_service import (
    _AUTO_ROUTE_GPT_MODEL,
    _AUTO_ROUTE_SEEDREAM_MODEL,
    _route_image_model,
)


# ────────────────────────────── 1. 路由纯函数（无 DB） ──────────────────────────────


def test_route_default_no_signal_lands_seedream():
    """核心正确性要求：不传 image_model 且没有明显信号 → 默认落 Seedream，绝不落 gpt-image-2。"""
    model = _route_image_model("周年庆活动海报", None, None)
    assert model == _AUTO_ROUTE_SEEDREAM_MODEL
    assert "gpt-image" not in model


def test_route_empty_prompt_still_lands_seedream():
    """极端场景（prompt/poster_text 都空）——安全默认依旧是 Seedream，不能因为判断不出就滑向 GPT。"""
    assert _route_image_model("", None, None) == _AUTO_ROUTE_SEEDREAM_MODEL
    assert _route_image_model(None, None, None) == _AUTO_ROUTE_SEEDREAM_MODEL


def test_route_user_choice_always_wins():
    """调用方显式手选（向后兼容 studio 现有手选）一律尊重，不管内容信号指向哪。"""
    assert _route_image_model("随便什么内容", None, "gpt-image-2") == "gpt-image-2"
    assert _route_image_model(
        "A photorealistic western portrait", None, "doubao-seedream-5-0-260128"
    ) == "doubao-seedream-5-0-260128"


def test_route_hard_chinese_text_prefers_seedream():
    """有硬文字要素(poster_text) → 中文精确文字/排版场景，路由 Seedream。"""
    poster_text = {"title": "开业大吉", "contact": "13800001111"}
    assert _route_image_model("给我做个开业海报", poster_text, None) == _AUTO_ROUTE_SEEDREAM_MODEL


def test_route_western_dominant_prefers_gpt():
    """西文为主(中文字符占比很低) → 路由 GPT。"""
    model = _route_image_model(
        "A photorealistic portrait of a young woman playing billiards, cinematic lighting, high detail",
        None, None,
    )
    assert model == _AUTO_ROUTE_GPT_MODEL


def test_route_complex_creative_keyword_prefers_gpt():
    """明显"高保真人像/复杂创意"关键词 → 路由 GPT。"""
    assert _route_image_model("帮我做一张写实人像风格的高保真海报", None, None) == _AUTO_ROUTE_GPT_MODEL


def test_route_chinese_prompt_no_hard_text_still_seedream():
    """纯中文描述，没有硬文字要素、也没复杂创意关键词 → 仍默认 Seedream（安全默认，不是瞎猜）。"""
    model = _route_image_model("台球房里灯光温暖，几个年轻人在打球，氛围轻松愉快", None, None)
    assert model == _AUTO_ROUTE_SEEDREAM_MODEL


# ────────────────────────────── 真实 DB 环境搭建（同 test_run_generation_real_db.py 写法） ──────────────────────────────


async def _make_store_and_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    db = session_maker()
    u = User(id=uuid.uuid4(), phone=f"1{uuid.uuid4().int % 10**10:010d}", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    s = Store(id=uuid.uuid4(), owner_id=u.id, name="测试球房")
    db.add(s)
    await db.commit()
    return engine, db, s, u


def _png_bytes(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, "PNG")
    return buf.getvalue()


class _FakeProvider:
    """可控假 provider：generate_image 由测试注入的 callable 驱动（记录调用/控制成功失败/耗时）。"""

    def __init__(self, name, call_fn):
        self.name = name
        self._call_fn = call_fn

    async def generate_image(self, **kwargs) -> bytes:
        return await self._call_fn(**kwargs)


def _patch_desktop_ark(monkeypatch):
    """桌面盒子 + 已配置 ark key 的通用前置（大多数用例都要这个环境）。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    from config import settings

    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(settings, "ark_api_key", "ark-test-key")
    monkeypatch.setattr(settings, "image_model_name", "")


# ─────────────── 1b. BYOK 门店 + 未指定模型时，自动路由不该硬塞模型 ID 给门店 endpoint ───────────────


async def test_byok_store_without_model_does_not_force_routed_model_id(monkeypatch):
    """回归：门店 byok_image_enabled=True 但没填 byok_image_model 时（image_model_cfg 恒为 None），
    U2 自动路由绝不能把算出来的具体模型 ID（如 Seedream 专属的 doubao-seedream-*）硬塞给门店自己的
    （非 ARK）endpoint——那是任意厂商 API，收到未知模型大概率直接报错，且这类失败不以 gpt-image
    开头，降级安全网也救不了。同一门店只要 prompt 命中"硬文字要素"（poster_text 有 title）就会
    触发自动路由算出 Seedream 模型 ID——本用例就覆盖这个"内容触发型回归"组合。

    修复后：build_image_provider 拿到的 base_url 仍是门店自己的 endpoint（不切 ARK，符合既有行为）；
    真正送进 provider.generate_image 的 model 必须是 None（交给门店 endpoint 自己的默认值），
    不能是被自动路由算出来的 Seedream 模型 ID 字符串。
    """
    from unittest.mock import patch as _patch

    engine, db, store, user = await _make_store_and_db()

    # 门店自带生图 BYOK：已启用 + 已配 key，但没填具体模型（最常见的"填了 key 图省事没填模型"配置）。
    store.byok_image_enabled = True
    store.byok_image_api_key_enc = "enc-does-not-matter"  # 只要非空，实际解密结果由下面 patch 控制
    store.byok_image_model = None
    store.byok_image_base_url = "https://byok-vendor.example.com/v1"

    captured = {}

    async def _call(**kwargs):
        captured["model"] = kwargs.get("model")
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        captured["base_url"] = base_url
        captured["build_model"] = model
        return _FakeProvider("byok-vendor", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    poster_text = {"title": "开业大吉"}  # 命中"硬文字要素" → 自动路由会算出 Seedream 模型 ID

    try:
        with _patch("core.crypto.try_decrypt", return_value="byok-real-key"):
            result = await poster_service.generate_images(
                db=db, store=store, user_id=user.id, prompt="给我做个开业海报",
                image_model=None, ratio="3:4", count=1, poster_text=poster_text,
            )
    finally:
        await engine.dispose()

    # base_url 必须仍是门店自己的 endpoint（没有被误切去 ARK）
    assert captured["base_url"] == "https://byok-vendor.example.com/v1"
    # build_image_provider 拿到的 model（image_model_cfg）本就该是 None（factory 层已保证，非本单范围）
    assert captured["build_model"] is None
    # 核心断言：真正送进 provider.generate_image 的 model 不能是自动路由算出的 Seedream 模型 ID
    assert captured["model"] is None, (
        f"BYOK 门店未指定模型时，不该把自动路由的模型 ID 塞给门店 endpoint，实际={captured['model']!r}"
    )
    assert result["count"] == 1


# ────────────────────────────── 2. 默认路由端到端：不传 image_model → 不落 gpt-image-2 ──────────────────────────────


async def test_generate_images_default_routes_to_seedream_not_gpt(monkeypatch):
    """核心正确性要求（端到端）：image_model=None 时，真正落地调用的必须是 Seedream(ARK)，不是 gpt-image-2。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        captured["base_url"] = base_url
        captured["routed_model"] = model
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="周年庆海报，店里搞活动",
            image_model=None, ratio="3:4", count=1,
        )
    finally:
        await engine.dispose()

    assert "volces" in captured["base_url"], f"没落地到火山方舟 ARK，实际 base_url={captured['base_url']}"
    assert "gpt-image" not in (captured["routed_model"] or "")
    assert "gpt-image-2" not in result["model_used"]
    assert result["images"][0]["model_switched"] is False


# ────────────────────────────── 3. 并行生成：真并行 + 闸内 + 顺序稳定 ──────────────────────────────


async def test_parallel_generation_respects_semaphore_and_preserves_order(monkeypatch):
    """并行生成必须真并行(不是顺序 for 循环)、在并发闸内、且结果顺序按请求下标回填(不因完成时机错位)。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)
    from config import settings

    monkeypatch.setattr(settings, "poster_max_concurrency", 2)
    monkeypatch.setattr(poster_service, "_image_semaphore", None)  # 强制按新配置重建信号量

    active = 0
    max_active = 0
    counter = {"n": 0}
    # 先发起的睡得更久、后发起的更快完成 —— 若实现按"完成顺序"回填就会乱序，暴露 bug。
    sleep_by_index = [0.09, 0.05, 0.01]
    widths_by_index = [1152, 1168, 1184]  # 都按 3:4 比例给高度

    async def _call(**kwargs):
        nonlocal active, max_active
        idx = counter["n"]
        counter["n"] += 1
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(sleep_by_index[idx])
        active -= 1
        w = widths_by_index[idx]
        h = int(w / 0.75)
        return _png_bytes(w, h)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报",
            image_model=None, ratio="3:4", count=3,
        )
    finally:
        await engine.dispose()

    assert max_active > 1, "生图调用没有真并行(仍像是顺序 for 循环)"
    assert max_active <= 2, "并行度超过了并发闸(poster_max_concurrency=2)上限"
    assert result["count"] == 3
    got_widths = [img["width"] for img in result["images"]]
    assert got_widths == widths_by_index, f"结果顺序未按请求下标回填，乱序了：{got_widths}"


async def test_single_failure_does_not_sink_whole_batch(monkeypatch):
    """一张失败不能拖垮整批 —— 其它张照常成功返回；非 GPT 路由的失败不触发降级、如实失败。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    counter = {"n": 0}

    async def _call(**kwargs):
        idx = counter["n"]
        counter["n"] += 1
        if idx == 1:
            raise RuntimeError("模拟第2张失败")
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报",
            image_model=None, ratio="3:4", count=3,
        )
    finally:
        await engine.dispose()

    assert result["count"] == 2  # 3 张里 1 张失败，其余 2 张照常返回


# ────────────────────────────── 4. GPT 失败自动降级回 Seedream（安全网） ──────────────────────────────


async def test_gpt_failure_falls_back_to_seedream_once_with_marker(monkeypatch):
    """路由到 GPT 但 GPT 失败(连接被掐/5xx/超时/审核拒都算) → 自动降级 Seedream 重试一次，带标记。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    calls = []

    async def _gpt_call(**kwargs):
        calls.append(("gpt", kwargs.get("model")))
        raise RuntimeError("relay 连接被掐断(模拟)")

    async def _seedream_call(**kwargs):
        calls.append(("seedream", kwargs.get("model")))
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("openai", _gpt_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))
    monkeypatch.setattr(
        poster_service, "_build_seedream_fallback_provider",
        lambda: _FakeProvider("seedream", _seedream_call),
    )

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id,
            prompt="a photorealistic portrait, high fidelity, cinematic",
            image_model="gpt-image-2", ratio="3:4", count=1,
        )
    finally:
        await engine.dispose()

    assert result["count"] == 1
    assert result["images"][0]["model_switched"] is True
    assert [c[0] for c in calls] == ["gpt", "seedream"]
    assert calls[1][1] == _AUTO_ROUTE_SEEDREAM_MODEL


async def test_gpt_and_seedream_fallback_both_fail_reports_real_error(monkeypatch):
    """降级也失败 → 如实报错(不装作有安全网、不静默吞掉)。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    async def _gpt_call(**kwargs):
        raise RuntimeError("GPT 失败(模拟)")

    async def _seedream_call(**kwargs):
        raise RuntimeError("Seedream 降级也失败(模拟)")

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("openai", _gpt_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))
    monkeypatch.setattr(
        poster_service, "_build_seedream_fallback_provider",
        lambda: _FakeProvider("seedream", _seedream_call),
    )

    from core.exceptions import AIServiceError

    try:
        with pytest.raises(AIServiceError):
            await poster_service.generate_images(
                db=db, store=store, user_id=user.id, prompt="a high fidelity photorealistic portrait",
                image_model="gpt-image-2", ratio="3:4", count=1,
            )
    finally:
        await engine.dispose()


async def test_non_gpt_failure_does_not_attempt_fallback(monkeypatch):
    """安全网只针对 GPT——路由/手选到 Seedream 本身失败时不该去"降级到 Seedream"(同一家，没意义)，
    _build_seedream_fallback_provider 不该被调用。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    fallback_called = {"n": 0}

    async def _call(**kwargs):
        raise RuntimeError("Seedream 自己失败(模拟)")

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    def fake_fallback():
        fallback_called["n"] += 1
        return None

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))
    monkeypatch.setattr(poster_service, "_build_seedream_fallback_provider", fake_fallback)

    from core.exceptions import AIServiceError

    try:
        with pytest.raises(AIServiceError):
            await poster_service.generate_images(
                db=db, store=store, user_id=user.id, prompt="活动海报",
                image_model=None, ratio="3:4", count=1,
            )
    finally:
        await engine.dispose()

    assert fallback_called["n"] == 0, "非 GPT 路由的失败不该尝试构造降级 provider"
