# -*- coding: utf-8 -*-
"""U5(E3d)：改图循环增强 + 交付存档扩展 + 二维码可选印刷兜底。

背景(owner 2026-07-04 §3-4)：默认全交大模型、不做程序叠层——唯一窄例外是"印刷/关键投放"场景
才用程序生成的真二维码保证能扫，别的场景(默认)完全不动现状。

本文件覆盖四件：
1. 改图侧独立路由(不碰 U2 的生成路由)：字错/改字 → Seedream；改内容 → GPT edits(高保真)。
2. preserve list 拼回：改图轮没显式传 poster_text 时，从被改的原图承接上一轮硬要素，防漂移
   （连带修复一个 gap：之前 studio_edit 从不传 poster_text，导致 U4 的 OCR 质检在改图轮从不触发）。
3. 门店品牌包：Store.brand_color/brand_reference_images 自动附带进生图（参考图进 input_images、
   品牌色写进 prompt）。
4. 二维码印刷兜底：print_mode 默认 False 完全不动现状；True 时才用 qrcode+cv2 解码重绘真二维码
   （新独立函数 `_overlay_print_qr`，不是 `_overlay_logo`——那个依旧是死代码）。

Seed 落库：查证 OpenAI Images API（generate/edit 均无 seed 字段）+ 火山方舟官方文档（seed 参数
只有 seedream-3-0-t2i / seededit-3-0-i2i 支持，本项目实际使用的 4.0/4.5/5.0 系列不支持）后，
两个 provider 均不支持——本单未加 Generation.seed 列，无对应测试（见 u5-report.md）。
"""
import asyncio
import io
import uuid

import pytest
from PIL import Image
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import models  # noqa: F401  触发全部模型注册
from db.base import Base
from models.generation import Generation
from models.store import Store
from models.user import User
from services import poster_service
from services.poster_service import (
    _AUTO_ROUTE_GPT_MODEL,
    _AUTO_ROUTE_SEEDREAM_MODEL,
    _infer_edit_type,
    _route_edit_model,
)


# ────────────────────────────── 1. 改图路由纯函数（无 DB） ──────────────────────────────


def test_infer_edit_type_detects_text_fix_keywords():
    assert _infer_edit_type("电话号码打错了，帮我改一下") == "text_fix"
    assert _infer_edit_type("标题里有个错别字") == "text_fix"
    assert _infer_edit_type("这几个字看着重复字，改一下") == "text_fix"


def test_infer_edit_type_defaults_to_content():
    """大多数改图诉求是换背景/加减元素这类内容改动，不是文字问题 → 默认 content。"""
    assert _infer_edit_type("把背景换成蓝色的") == "content"
    assert _infer_edit_type("去掉桌上那个杯子") == "content"
    assert _infer_edit_type("") == "content"
    assert _infer_edit_type(None) == "content"


def test_route_edit_model_text_fix_prefers_seedream():
    assert _route_edit_model("字打错了，重新写一下", "", None) == _AUTO_ROUTE_SEEDREAM_MODEL
    assert _route_edit_model("随便什么内容", "", "text_fix") == _AUTO_ROUTE_SEEDREAM_MODEL


def test_route_edit_model_content_prefers_gpt():
    assert _route_edit_model("把背景换成蓝色", "", None) == _AUTO_ROUTE_GPT_MODEL
    assert _route_edit_model("随便什么内容", "", "content") == _AUTO_ROUTE_GPT_MODEL


def test_route_edit_model_explicit_user_choice_wins():
    """调用方显式手选(如前端 imageModel 下拉框)一律尊重，不管 edit_type 判据指向哪。"""
    assert _route_edit_model("错别字", "doubao-seedream-5-0-260128", "content") == "doubao-seedream-5-0-260128"
    assert _route_edit_model("换背景", "gpt-image-2", "text_fix") == "gpt-image-2"


# ────────────────────────────── 2. `_overlay_print_qr` 真实解码测试（无 DB） ──────────────────────────────


def test_overlay_print_qr_produces_a_scannable_code():
    """核心正确性：真实生成一张 QR、贴上去、再用 OpenCV 解码——必须解出同样的内容。"""
    import cv2
    import numpy as np
    import qrcode

    from services.poster_service import _overlay_print_qr

    qr_img = qrcode.make("https://example.com/store/42")
    qr_buf = io.BytesIO()
    qr_img.save(qr_buf, "PNG")
    qr_bytes = qr_buf.getvalue()

    poster = Image.new("RGB", (1152, 1536), (30, 90, 200))
    poster_buf = io.BytesIO()
    poster.save(poster_buf, "PNG")
    poster_bytes = poster_buf.getvalue()

    out_bytes = _overlay_print_qr(poster_bytes, qr_bytes)
    assert out_bytes != poster_bytes, "贴了二维码后图片字节应该变化"

    arr = np.frombuffer(out_bytes, dtype=np.uint8)
    cv_img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    content, _points, _ = cv2.QRCodeDetector().detectAndDecode(cv_img)
    assert content == "https://example.com/store/42", f"贴上去的码解不出原内容，实际解出：{content!r}"

    out_img = Image.open(io.BytesIO(out_bytes))
    assert out_img.size == poster.size, "叠层不该改变整图尺寸(会连累比例校验)"


def test_overlay_print_qr_falls_back_to_original_when_source_not_a_valid_qr():
    """源图解不出二维码(不是合法码/模糊到读不出)→ 安全返回原图，不让整张海报因为这步失败。"""
    from services.poster_service import _overlay_print_qr

    poster = Image.new("RGB", (800, 600), (10, 10, 10))
    poster_buf = io.BytesIO()
    poster.save(poster_buf, "PNG")
    poster_bytes = poster_buf.getvalue()

    not_a_qr = Image.new("RGB", (200, 200), (255, 0, 0))  # 纯色红块，不是二维码
    not_a_qr_buf = io.BytesIO()
    not_a_qr.save(not_a_qr_buf, "PNG")
    not_a_qr_bytes = not_a_qr_buf.getvalue()

    out_bytes = _overlay_print_qr(poster_bytes, not_a_qr_bytes)
    assert out_bytes == poster_bytes


def test_overlay_logo_still_dead_code_after_u5():
    """U1 的回归守卫在 U5 之后依旧要成立：_overlay_print_qr 是全新函数，没有复用/复活 _overlay_logo。"""
    import inspect

    src = inspect.getsource(poster_service.generate_images)
    assert "_overlay_logo(" not in src
    # 新函数确实被 generate_images 用到了(不是加了没接线的死代码)——经 asyncio.to_thread 引用传入，
    # 不是直接调用形态，故不带括号比对。
    assert "_apply_print_qr_overlay" in src


# ────────────────────────────── 3. tools.py 过时描述已修正 ──────────────────────────────


def test_make_poster_tool_description_no_longer_claims_pil_overlay():
    from services.agent.registry import default_registry
    import services.agent.tools  # noqa: F401  确保工具已注册

    make_poster = default_registry.get("make_poster")
    assert make_poster is not None
    full_text = make_poster.description + str(make_poster.parameters)
    assert "PIL 像素级贴到右上角" not in full_text
    assert "PIL 精确贴到右上角" not in full_text
    assert "原样喂给模型" in full_text or "原样喂给模型融合" in make_poster.description


# ────────────────────────────── 真实 DB 环境搭建（同 U2/U4 测试写法） ──────────────────────────────


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


def _png_bytes(w: int, h: int, color=(120, 60, 200)) -> bytes:
    from PIL import ImageDraw
    img = Image.new("RGB", (w, h), color)
    d = ImageDraw.Draw(img)
    for y in range(0, h, 60):
        d.rectangle([0, y, w, y + 20], fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


class _FakeProvider:
    def __init__(self, name, call_fn):
        self.name = name
        self._call_fn = call_fn

    async def generate_image(self, **kwargs) -> bytes:
        return await self._call_fn(**kwargs)


def _patch_desktop_ark(monkeypatch):
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    from config import settings
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(settings, "ark_api_key", "ark-test-key")
    monkeypatch.setattr(settings, "image_model_name", "")


# ────────────────────────────── 4. 改图路由端到端：字错→Seedream / 改内容→GPT+input_fidelity ──────────────────────────────


async def test_edit_content_routes_to_gpt_with_input_fidelity(monkeypatch):
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    orig_id = uuid.uuid4()
    db.add(Generation(id=orig_id, store_id=store.id, type="poster", result="/uploads/orig.jpg",
                       input_params={"poster_text": None}))
    await db.commit()

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("openai", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="把背景换成蓝色的",
            image_model=None, ratio="3:4", count=1,
            refine_from=str(orig_id), edit_type="content",
        )
    finally:
        await engine.dispose()

    assert captured.get("model") == _AUTO_ROUTE_GPT_MODEL, f"改内容该路由 GPT，实际={captured.get('model')}"
    assert captured.get("input_fidelity") == "high", "改内容这轮该给 input_fidelity=high"
    assert result["count"] == 1


async def test_edit_text_fix_routes_to_seedream_no_input_fidelity(monkeypatch):
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    orig_id = uuid.uuid4()
    db.add(Generation(id=orig_id, store_id=store.id, type="poster", result="/uploads/orig.jpg",
                       input_params={"poster_text": None}))
    await db.commit()

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="电话号码打错了，帮我改一下",
            image_model=None, ratio="3:4", count=1,
            refine_from=str(orig_id), edit_type="text_fix",
        )
    finally:
        await engine.dispose()

    assert captured.get("model") == _AUTO_ROUTE_SEEDREAM_MODEL, f"改文字该路由 Seedream，实际={captured.get('model')}"
    assert captured.get("input_fidelity") is None, "Seedream 分支不该带 GPT 专属的 input_fidelity"
    assert result["count"] == 1


async def test_edit_without_explicit_edit_type_infers_from_prompt(monkeypatch):
    """不传 edit_type 时从改图指令文本推断——"错别字"这类关键词该落 Seedream。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    orig_id = uuid.uuid4()
    db.add(Generation(id=orig_id, store_id=store.id, type="poster", result="/uploads/orig.jpg",
                       input_params={"poster_text": None}))
    await db.commit()

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="标题里有个错别字，改一下",
            image_model=None, ratio="3:4", count=1,
            refine_from=str(orig_id), edit_type=None,
        )
    finally:
        await engine.dispose()

    assert captured.get("model") == _AUTO_ROUTE_SEEDREAM_MODEL


# ────────────────────────────── 5. preserve list 拼回（改图轮承接上一轮硬要素） ──────────────────────────────


async def test_edit_round_carries_forward_hard_elements_without_explicit_poster_text(monkeypatch):
    """studio_edit 目前没有 poster_text 入口——没显式传时该从被改的原图承接上一轮硬要素，
    重新拼进这轮改图的 prompt 里(防漂移)。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    orig_id = uuid.uuid4()
    db.add(Generation(
        id=orig_id, store_id=store.id, type="poster", result="/uploads/orig.jpg",
        input_params={"poster_text": {"title": "抢一大战", "contact": "15984632071"}},
    ))
    await db.commit()

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))
    # 本用例测的是 prompt 拼回逻辑本身，不是 U4 的 OCR 质检——假图片没有真的画上这几个字，
    # 让 OCR 直接判定"读到了"，避免被质检重出逻辑干扰这里的断言(同 U2 测试文件的既有写法)。
    monkeypatch.setattr(poster_service, "_run_ocr_texts", lambda path: ["抢一大战", "15984632071"])

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="把背景换成夜晚",
            image_model=None, ratio="3:4", count=1,
            refine_from=str(orig_id), poster_text=None,  # 调用方(studio_edit)没传
        )
    finally:
        await engine.dispose()

    sent_prompt = captured.get("prompt") or ""
    assert "抢一大战" in sent_prompt, f"没有承接上一轮店名，实际 prompt={sent_prompt!r}"
    assert "15984632071" in sent_prompt, f"没有承接上一轮联系方式，实际 prompt={sent_prompt!r}"
    assert result["count"] == 1


async def test_edit_round_explicit_poster_text_overrides_carry_forward(monkeypatch):
    """调用方这轮显式传了新的 poster_text(比如改价格)→ 以这轮为准，不被旧值覆盖。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    orig_id = uuid.uuid4()
    db.add(Generation(
        id=orig_id, store_id=store.id, type="poster", result="/uploads/orig.jpg",
        input_params={"poster_text": {"title": "旧标题"}},
    ))
    await db.commit()

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))
    monkeypatch.setattr(poster_service, "_run_ocr_texts", lambda path: ["新标题"])

    try:
        await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="改一下标题",
            image_model=None, ratio="3:4", count=1,
            refine_from=str(orig_id), poster_text={"title": "新标题"},
        )
    finally:
        await engine.dispose()

    sent_prompt = captured.get("prompt") or ""
    assert "新标题" in sent_prompt
    assert "旧标题" not in sent_prompt


async def test_edit_round_carry_forward_triggers_ocr_quality_check(monkeypatch):
    """回归：之前 studio_edit 从不传 poster_text，导致 U4 的 OCR 质检在改图轮从不触发——
    承接上一轮硬要素后，改图轮也该正常跑 OCR 校验。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    orig_id = uuid.uuid4()
    db.add(Generation(
        id=orig_id, store_id=store.id, type="poster", result="/uploads/orig.jpg",
        input_params={"poster_text": {"title": "抢一大战"}},
    ))
    await db.commit()

    async def _call(**kwargs):
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    ocr_calls = {"n": 0}

    def fake_run_ocr(path):
        ocr_calls["n"] += 1
        return ["抢一大战"]  # 假装 OCR 读到了正确文字，让质检直接通过

    monkeypatch.setattr(poster_service, "_run_ocr_texts", fake_run_ocr)

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="把背景换成夜晚",
            image_model=None, ratio="3:4", count=1,
            refine_from=str(orig_id), poster_text=None,
        )
    finally:
        await engine.dispose()

    assert ocr_calls["n"] == 1, "承接上一轮硬要素后，改图轮该跑 OCR 质检(之前这条从不触发)"
    assert result["count"] == 1


# ────────────────────────────── 6. 门店品牌包自动附带 ──────────────────────────────


async def test_brand_pack_auto_attaches_reference_image_and_color(monkeypatch, tmp_path):
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)
    from config import settings as cfg_settings
    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))

    brand_img_bytes = _png_bytes(200, 200, color=(10, 200, 10))
    (tmp_path / "brand1.png").write_bytes(brand_img_bytes)
    store.brand_color = "#1a73e8"
    store.brand_reference_images = ["/uploads/brand1.png"]

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="日常氛围海报",
            image_model=None, ratio="3:4", count=1,
        )
    finally:
        await engine.dispose()

    assert "#1a73e8" in (captured.get("prompt") or ""), "品牌色没有写进 prompt"
    images_arg = captured.get("image") or []
    assert brand_img_bytes in images_arg, "品牌参考图没有进 input_images"
    assert result["count"] == 1


async def test_no_brand_pack_configured_behaves_as_before(monkeypatch):
    """门店没配品牌色/参考图(绝大多数现状) → 完全不受影响，prompt 里不出现品牌色提示文案。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)
    # store.brand_color / brand_reference_images 都是 None(默认)

    captured = {}

    async def _call(**kwargs):
        captured.update(kwargs)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="日常氛围海报",
            image_model=None, ratio="3:4", count=1,
        )
    finally:
        await engine.dispose()

    assert "品牌主色调" not in (captured.get("prompt") or "")


# ────────────────────────────── 7. print_mode 二维码印刷兜底：默认不叠 / 显式才叠 ──────────────────────────────


async def test_print_mode_false_never_calls_overlay(monkeypatch, tmp_path):
    """默认 False(绝大多数场景)：现状完全不变，_apply_print_qr_overlay 不该被调用。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)
    from config import settings as cfg_settings
    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))

    import qrcode
    qr_buf = io.BytesIO()
    qrcode.make("https://example.com/print-me").save(qr_buf, "PNG")
    (tmp_path / "qr.png").write_bytes(qr_buf.getvalue())

    async def _call(**kwargs):
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    overlay_calls = {"n": 0}
    monkeypatch.setattr(
        poster_service, "_apply_print_qr_overlay",
        lambda *a, **k: overlay_calls.__setitem__("n", overlay_calls["n"] + 1),
    )

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报",
            image_model=None, ratio="3:4", count=1,
            qr_path="/uploads/qr.png", print_mode=False,
        )
    finally:
        await engine.dispose()

    assert overlay_calls["n"] == 0, "print_mode=False 时不该叠印刷二维码(owner 铁律：默认不做程序叠层)"
    assert result["count"] == 1


async def test_print_mode_true_with_qr_calls_overlay(monkeypatch, tmp_path):
    """print_mode=True 且提供了二维码物料 → 该调用印刷叠层(owner §3-4 窄例外，显式才触发)。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)
    from config import settings as cfg_settings
    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))

    import qrcode
    qr_buf = io.BytesIO()
    qrcode.make("https://example.com/print-me").save(qr_buf, "PNG")
    (tmp_path / "qr.png").write_bytes(qr_buf.getvalue())

    async def _call(**kwargs):
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    overlay_calls = []
    monkeypatch.setattr(
        poster_service, "_apply_print_qr_overlay",
        lambda path, qr_bytes: overlay_calls.append((path, qr_bytes)),
    )

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报",
            image_model=None, ratio="3:4", count=1,
            qr_path="/uploads/qr.png", print_mode=True,
        )
    finally:
        await engine.dispose()

    assert len(overlay_calls) == 1, "print_mode=True 且提供了二维码 → 该恰好叠层一次"
    assert overlay_calls[0][1] == qr_buf.getvalue()
    assert result["count"] == 1


async def test_print_mode_true_without_qr_path_is_noop(monkeypatch):
    """print_mode=True 但没提供二维码物料 → 没东西可贴，安全跳过(不报错)。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    async def _call(**kwargs):
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider("seedream", _call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    overlay_calls = {"n": 0}
    monkeypatch.setattr(
        poster_service, "_apply_print_qr_overlay",
        lambda *a, **k: overlay_calls.__setitem__("n", overlay_calls["n"] + 1),
    )

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报",
            image_model=None, ratio="3:4", count=1,
            print_mode=True,  # 没传 qr_path
        )
    finally:
        await engine.dispose()

    assert overlay_calls["n"] == 0
    assert result["count"] == 1
