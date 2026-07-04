# -*- coding: utf-8 -*-
"""U4(E3c)：生图确定性预筛(零依赖) + RapidOCR 中文文字校验 + 抽风自动重出。

背景(owner 2026-07-04 真机实测拍板)：产品生图主力 Seedream，唯一短板=中文精确文字偶发"抽风"
(实测出过"充充"这种重复字、多出一行没要求的促销文案)。本单做两道确定性质检：
1. 零依赖预筛(黑图/纯色/分辨率下限)——只用 Pillow(已是硬依赖)，不引入 numpy/cv2。
2. RapidOCR 中文文字校验(新依赖 rapidocr-onnxruntime)——只在 poster_text 有硬文字要素时才查，
   比对 OCR 读出的文字与期望的硬要素(店名/日期/价格/联系方式)，要求【一字不差包含】(零容忍模糊)——
   这类字段本就要求分毫不差，模糊匹配会放过"关键数字错一位"这种最不能接受的错误。

三块全部零 token(预筛是像素统计，OCR 是本地 onnx 推理，都不调 LLM)。

抽风/全废 → 自动重出，都严格封顶 1 次(防烧钱)：
- 单张 OCR/预筛不过 → 该张重出 1 次(仅 1 次)，重出后仍不过就放弃这张(不拖累其它张)。
- 一整批全部被判废 → 整批补生成 1 轮(仅 1 次,复用 U2 的并行入口 `_generate_one`/`asyncio.gather`)，
  仍全废 → 如实抛错告知用户，不静默返回空、不硬塞废图。

OCR 测试全部走 mock(monkeypatch `_run_ocr_texts`/`_screen_generated_image`)，不依赖真跑 OCR 模型
(brief 明确要求：慢、且我们只要验证"抽风检出→触发重出"这条逻辑本身，不是验证 RapidOCR 准确率)。
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


# ────────────────────────────── 1. 零依赖确定性预筛（纯函数，无 DB） ──────────────────────────────


def _save(img: Image.Image, tmp_path, name="x.jpg") -> "object":
    p = tmp_path / name
    img.convert("RGB").save(p, "JPEG", quality=90)
    return p


def test_screen_rejects_pure_black_image(tmp_path):
    """近全黑图（生成失败常见形态之一）应被判废。"""
    img = Image.new("RGB", (1152, 1536), (0, 0, 0))
    path = _save(img, tmp_path)
    ok, reason = poster_service._screen_generated_image(path)
    assert ok is False
    assert reason


def test_screen_rejects_solid_color_image(tmp_path):
    """纯色占位图（非黑，如纯白/纯蓝）方差极低，同样应被判废。"""
    img = Image.new("RGB", (1152, 1536), (30, 90, 200))
    path = _save(img, tmp_path)
    ok, reason = poster_service._screen_generated_image(path)
    assert ok is False
    assert reason


def test_screen_rejects_too_small_resolution(tmp_path):
    """分辨率异常偏低（远低于 SIZE_MAP 最小边 1024）→ 判废，不管内容有没有变化。"""
    img = Image.new("RGB", (64, 64), (10, 10, 10))
    # 加一点点噪声避免同时被"纯色"分支命中，单独验证分辨率分支能独立拦下
    px = img.load()
    for i in range(0, 64, 3):
        px[i, i] = (200, 200, 200)
    path = _save(img, tmp_path)
    ok, reason = poster_service._screen_generated_image(path)
    assert ok is False
    assert reason


def test_screen_does_not_kill_normal_content_image(tmp_path):
    """宁漏勿误杀：正常有内容的图（有对比度的图案+文字）不该被误杀，哪怕整体偏暗。"""
    img = Image.new("RGB", (1152, 1536), (20, 20, 20))  # 深色背景（简约风格海报常见）
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    # 画点高对比度内容模拟真实海报的文字/图形（足够的方差）
    for y in range(200, 1300, 80):
        d.rectangle([100, y, 1000, y + 40], fill=(230, 230, 230))
    path = _save(img, tmp_path)
    ok, reason = poster_service._screen_generated_image(path)
    assert ok is True, f"正常深色系海报被误杀：{reason}"


def test_screen_does_not_kill_bright_minimal_image(tmp_path):
    """宁漏勿误杀：明亮简约风格（大片留白+少量图案）也不该被误杀。"""
    img = Image.new("RGB", (1152, 1536), (250, 250, 248))
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    d.ellipse([300, 600, 850, 1000], fill=(20, 120, 90))
    path = _save(img, tmp_path)
    ok, reason = poster_service._screen_generated_image(path)
    assert ok is True, f"正常简约风格海报被误杀：{reason}"


# ────────────────────────────── 2. RapidOCR 文字比对(纯函数，mock OCR 结果) ──────────────────────────────


def test_ocr_anomaly_none_when_all_hard_elements_present():
    hard_values = {"title": "开业大吉", "contact": "13800001111"}
    ocr_texts = ["球房", "开业大吉", "电话13800001111", "欢迎光临"]
    anomalies = poster_service.detect_ocr_text_anomalies(ocr_texts, hard_values)
    assert anomalies == {}


def test_ocr_anomaly_detects_missing_hard_element():
    hard_values = {"title": "开业大吉", "contact": "13800001111"}
    ocr_texts = ["球房", "欢迎光临"]  # 两个硬要素都没出现
    anomalies = poster_service.detect_ocr_text_anomalies(ocr_texts, hard_values)
    assert "title" in anomalies
    assert "contact" in anomalies


def test_ocr_anomaly_detects_repeated_char_glitch():
    """"抽风"典型形态：重复字，如"续充"被画成"续充充"。"""
    hard_values = {"title": "续充"}
    ocr_texts = ["球房大促", "续充充", "欢迎办卡"]
    anomalies = poster_service.detect_ocr_text_anomalies(ocr_texts, hard_values)
    assert "title" in anomalies


def test_ocr_anomaly_detects_wrong_digit_in_phone():
    """"抽风"典型形态：电话号码错一位数字——必须零容忍抓出来，不能被模糊匹配放过。"""
    hard_values = {"contact": "13800001111"}
    ocr_texts = ["13800001112"]  # 最后一位错了
    anomalies = poster_service.detect_ocr_text_anomalies(ocr_texts, hard_values)
    assert "contact" in anomalies


def test_ocr_anomaly_ignores_decorative_text_not_in_hard_values():
    """装饰字/花体不在 hard_values 里，OCR 读出啥都不该被拿来比对判废。"""
    hard_values = {"title": "开业大吉"}
    ocr_texts = ["开业大吉", "史上最强台球局，速来体验巅峰对决！"]  # 后面这行纯装饰文案
    anomalies = poster_service.detect_ocr_text_anomalies(ocr_texts, hard_values)
    assert anomalies == {}


def test_ocr_anomaly_empty_hard_values_short_circuits():
    """没有硬文字要素时，不该跑任何比对逻辑（调用方应据此跳过 OCR，见下面集成测试）。"""
    assert poster_service.detect_ocr_text_anomalies(["随便什么"], {}) == {}
    assert poster_service.detect_ocr_text_anomalies([], {}) == {}


# ────────────────────────────── 真实 DB 环境搭建（同 U2 测试写法） ──────────────────────────────


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
    """默认非纯色/非黑（掺一点条纹制造方差），确保走 provider 层测试时不会被预筛误杀。"""
    img = Image.new("RGB", (w, h), color)
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    for y in range(0, h, 60):
        d.rectangle([0, y, w, y + 20], fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _blank_png_bytes(w: int, h: int) -> bytes:
    """纯白，故意用来触发预筛判废。"""
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, "PNG")
    return buf.getvalue()


class _FakeProvider:
    def __init__(self, call_fn):
        self._call_fn = call_fn

    async def generate_image(self, **kwargs) -> bytes:
        return await self._call_fn(**kwargs)


def _patch_desktop_ark(monkeypatch):
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    from config import settings

    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(settings, "ark_api_key", "ark-test-key")
    monkeypatch.setattr(settings, "image_model_name", "")


# ────────────────────────────── 3. 无硬文字要素 → 不跑 OCR ──────────────────────────────


async def test_no_hard_text_skips_ocr_entirely(monkeypatch):
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    async def _call(**kwargs):
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider(_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    ocr_calls = {"n": 0}

    def fake_run_ocr(path):
        ocr_calls["n"] += 1
        return []

    monkeypatch.setattr(poster_service, "_run_ocr_texts", fake_run_ocr)

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="台球房氛围海报，不需要任何文字",
            image_model=None, ratio="3:4", count=1, poster_text=None,
        )
    finally:
        await engine.dispose()

    assert result["count"] == 1
    assert ocr_calls["n"] == 0, "没有硬文字要素时不该跑 OCR"


# ────────────────────────────── 4. 有硬文字 + OCR 抽风检出 → 自动重出 1 次，重出后过了就用 ──────────────────────────────


async def test_ocr_anomaly_triggers_single_regenerate_then_succeeds(monkeypatch):
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    call_count = {"n": 0}

    async def _call(**kwargs):
        call_count["n"] += 1
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider(_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    # 第一次 OCR 判定抽风；第二次(重出后)判定正常
    ocr_call_count = {"n": 0}

    def fake_run_ocr(path):
        ocr_call_count["n"] += 1
        return ["开业大吉"]  # 内容不重要，靠 detect 的 monkeypatch 控制判定结果

    def fake_detect(ocr_texts, hard_values):
        ocr_call_count.setdefault("detect_n", 0)
        ocr_call_count["detect_n"] += 1
        if ocr_call_count["detect_n"] == 1:
            return {"title": "标题文字疑似出错：应为「开业大吉」"}
        return {}

    monkeypatch.setattr(poster_service, "_run_ocr_texts", fake_run_ocr)
    monkeypatch.setattr(poster_service, "detect_ocr_text_anomalies", fake_detect)

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="开业海报",
            image_model=None, ratio="3:4", count=1,
            poster_text={"title": "开业大吉"},
        )
    finally:
        await engine.dispose()

    assert result["count"] == 1
    assert call_count["n"] == 2, "抽风后应该自动重出这一张恰好 1 次（provider 应被调用 2 次：首次+重出）"
    assert ocr_call_count["detect_n"] == 2


async def test_ocr_anomaly_persists_after_retry_drops_that_image_but_keeps_others(monkeypatch):
    """重出后仍抽风 → 放弃这一张，但不拖累同批其它正常张。"""
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    slot_calls = {"n": 0}

    async def _call(**kwargs):
        slot_calls["n"] += 1
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider(_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    # 输出文件名固定以 `_<下标>.jpg` 结尾（见 generate_images 内 filename 组装），借这个下标把
    # "第几张"编进 OCR 结果里，让 fake_detect 能按【图片身份】而非【全局调用序号】判断好坏——
    # 全局调用序号在 asyncio.gather 并发下顺序不稳定，按身份判断才能稳定复现"某一张持续抽风"。
    def fake_run_ocr(path):
        idx = int(path.stem.rsplit("_", 1)[-1])
        return [f"__SLOT__{idx}"]

    def fake_detect(ocr_texts, hard_values):
        tag = ocr_texts[0] if ocr_texts else ""
        idx = int(tag.replace("__SLOT__", "")) if tag.startswith("__SLOT__") else -1
        if idx == 1:  # 固定让下标 1 那张持续抽风（首次 + 重出都判坏），其它张永远正常
            return {"title": "坏"}
        return {}

    monkeypatch.setattr(poster_service, "_run_ocr_texts", fake_run_ocr)
    monkeypatch.setattr(poster_service, "detect_ocr_text_anomalies", fake_detect)

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报",
            image_model=None, ratio="3:4", count=3,
            poster_text={"title": "开业大吉"},
        )
    finally:
        await engine.dispose()

    # 下标 1 那张首次+重出都持续抽风 → 必然被放弃；其它 2 张始终正常 → 必然保留。
    assert result["count"] == 2, f"应该恰好放弃下标1那张、保留其它2张，实际 count={result['count']}"
    assert slot_calls["n"] == 4, f"3张里1张首次+重出(2次)+其它2张各1次(2次)=4次，实际={slot_calls['n']}"


# ────────────────────────────── 5. 全废兜底：整批判废 → 自动补 1 轮 ──────────────────────────────


async def test_whole_batch_rejected_by_prescreen_triggers_one_batch_retry_then_succeeds(monkeypatch):
    """第一轮全部生成出纯白占位图（预筛判废，且每张自身的"重出1次"也仍是白图）→ 整批自动补 1 轮
    → 第二轮换成正常图 → 最终成功。count=2 时第一轮要耗尽 2 张各自的"首次+重出"共 4 次调用
    才会触发"整批补 1 轮"，第 5/6 次调用才是补的那一轮——用调用序号阈值 4 精确卡住这个边界，
    不依赖 asyncio.gather 内部两个协程的交错顺序（这里不关心谁先谁后，只要求前 4 次统一是坏图）。
    """
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    call_count = {"n": 0}

    async def _call(**kwargs):
        call_count["n"] += 1
        # 前 4 次调用(=2 张 x 各自首次+重出)统一返回纯白占位图 → 第一轮必然整批判废；
        # 第 5 次起(=整批补的那一轮)才返回正常图。
        if call_count["n"] <= 4:
            return _blank_png_bytes(1152, 1536)
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider(_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报，不需要文字",
            image_model=None, ratio="3:4", count=2, poster_text=None,
        )
    finally:
        await engine.dispose()

    assert result["count"] == 2, "第一轮全废后应该自动补 1 轮并最终成功"
    assert call_count["n"] == 6, (
        f"应该恰好是第一轮 2 张各自首次+重出(4次) + 整批补 1 轮 2 张(2次) = 6 次，"
        f"实际={call_count['n']}（说明兜底触发次数不对，可能多补了或没补）"
    )


async def test_whole_batch_still_all_bad_after_one_retry_reports_honestly(monkeypatch):
    """整批补 1 轮后仍然全废 → 如实抛错，不能静默返回空/硬塞废图。"""
    from core.exceptions import AIServiceError

    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    async def _call(**kwargs):
        return _blank_png_bytes(1152, 1536)  # 无论重出多少次都是纯白占位图

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider(_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    try:
        with pytest.raises(AIServiceError):
            await poster_service.generate_images(
                db=db, store=store, user_id=user.id, prompt="活动海报",
                image_model=None, ratio="3:4", count=1, poster_text=None,
            )
    finally:
        await engine.dispose()


async def test_partial_failure_does_not_trigger_whole_batch_retry(monkeypatch):
    """不是整批全废（只坏 1 张、其它正常）时，不该触发"整批补 1 轮"这条更贵的兜底路径。

    provider 本身一直返回同样的"正常"图片字节——是否判废改由 mock `_screen_generated_image`
    按【输出文件名里的下标】(而非全局调用序号)决定：下标 0 永远判废、下标 1 永远正常。
    这样断言不依赖 asyncio.gather 内部两个协程谁先谁后交错执行（provider 调用之后还有真实的
    `await asyncio.to_thread(...)` 落盘/质检，两张图会在这些挂起点上真实交错，全局调用序号
    不能稳定对应到"第几张的第几次尝试"，按身份判断才是稳的）。
    """
    engine, db, store, user = await _make_store_and_db()
    _patch_desktop_ark(monkeypatch)

    provider_calls = {"n": 0}

    async def _call(**kwargs):
        provider_calls["n"] += 1
        return _png_bytes(1152, 1536)

    def fake_build_image_provider(api_key, base_url, model=None):
        return _FakeProvider(_call)

    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, "build_image_provider", staticmethod(fake_build_image_provider))

    def fake_screen(path):
        idx = int(path.stem.rsplit("_", 1)[-1])
        if idx == 0:
            return False, "模拟判废(下标0永远坏)"
        return True, ""

    monkeypatch.setattr(poster_service, "_screen_generated_image", fake_screen)

    try:
        result = await poster_service.generate_images(
            db=db, store=store, user_id=user.id, prompt="活动海报",
            image_model=None, ratio="3:4", count=2, poster_text=None,
        )
    finally:
        await engine.dispose()

    # 下标 0 首次+重出都判废 → 放弃；下标 1 始终正常 → 保留。只有 1 张成功。
    assert result["count"] == 1
    # provider 总调用次数应该恰好是 3 次（下标0首次+重出=2次，下标1仅1次），
    # 不该因为触发"全废补1轮"又多打一整批(否则会变成 3+2=5 次调用)。
    assert provider_calls["n"] == 3, f"不该触发整批重出兜底，实际 provider 调用次数={provider_calls['n']}"
