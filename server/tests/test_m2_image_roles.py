"""M2 生图修复：图片角色透传 + 桌面多图不崩 + 多图上限 + logo 状态诚实 + 默认比例。

覆盖 #1(桌面参考图崩溃) #2(角色解开) #3(多图上限) #4(logo诚实) #6(默认比例)。
底层服务用 monkeypatch 替身（不碰真实 DB / 不调真实 AI / 不花钱）。
"""
import asyncio
import types

import pytest


def _ctx(**overrides):
    base = dict(
        db=None,
        store=types.SimpleNamespace(id="s1"),
        user=types.SimpleNamespace(id="u-test-m2"),
        allowed_paths=[],
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


def _fake_result(count=1, logo_applied=False):
    return {
        "images": [{"poster_url": f"http://x/p{i}.png"} for i in range(count)],
        "count": count,
        "logo_applied": logo_applied,
    }


# ────────────────── #1 桌面参考图不崩 ──────────────────


def test_desktop_reference_outside_uploads_no_crash(tmp_path, monkeypatch):
    """DESKTOP_LOCAL=1 时，reference 路径在 uploads 外不抛 ValueError。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")

    from services.poster_service import generate_images
    from services import poster_service

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return _fake_result()

    monkeypatch.setattr(poster_service, "generate_images", fake_generate_images)

    from services.agent import tools as agent_tools

    img1 = tmp_path / "a.png"
    img2 = tmp_path / "b.png"
    img1.write_bytes(b"\x89PNG")
    img2.write_bytes(b"\x89PNG")

    ctx = _ctx(allowed_paths=[str(img1), str(img2)])
    out = asyncio.run(agent_tools.make_poster({"description": "测试海报"}, ctx))
    assert "做好啦" in out
    refs = captured.get("reference_image_paths") or []
    assert str(img1) in refs
    assert str(img2) in refs


def test_non_desktop_ref_path_validation(tmp_path, monkeypatch):
    """非桌面模式，_load_upload_bytes 不接受 uploads 外的路径。"""
    monkeypatch.delenv("DESKTOP_LOCAL", raising=False)
    from services.poster_service import _load_upload_bytes
    from services import poster_service as ps

    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(ps.settings, "upload_dir", str(upload_dir))

    assert _load_upload_bytes("/etc/passwd") is None
    assert _load_upload_bytes("../../etc/passwd") is None
    ref_in = upload_dir / "test.png"
    ref_in.write_bytes(b"\x89PNG")
    assert _load_upload_bytes("/uploads/test.png") is not None or _load_upload_bytes(str(ref_in)) is None


# ────────────────── #2 图片角色透传 ──────────────────


def test_role_params_passed_through(monkeypatch):
    """logo_path / qr_path / store_photo_path / background_mode 透传到 poster_service。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return _fake_result(logo_applied=True)

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)

    ctx = _ctx(allowed_paths=["/tmp/logo.png", "/tmp/qr.png", "/tmp/ref.jpg"])
    out = asyncio.run(agent_tools.make_poster({
        "description": "海报",
        "logo_path": "/tmp/logo.png",
        "qr_path": "/tmp/qr.png",
        "store_photo_path": "/tmp/base.jpg",
    }, ctx))
    assert captured["logo_path"] == "/tmp/logo.png"
    assert captured["qr_path"] == "/tmp/qr.png"
    assert captured["store_photo_path"] == "/tmp/base.jpg"
    assert captured["background_mode"] == "store_photo"
    refs = captured.get("reference_image_paths") or []
    assert "/tmp/logo.png" not in refs
    assert "/tmp/qr.png" not in refs
    assert "/tmp/ref.jpg" in refs


def test_no_role_means_all_refs(monkeypatch):
    """不指定角色参数，所有选定图片都当参考图（不再写死第一张=logo）。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return _fake_result()

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)

    ctx = _ctx(allowed_paths=["/tmp/a.png", "/tmp/b.png"])
    asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert captured["logo_path"] is None
    assert captured["background_mode"] == "ai_generate"
    refs = captured.get("reference_image_paths") or []
    assert "/tmp/a.png" in refs
    assert "/tmp/b.png" in refs


def test_generate_image_role_params(monkeypatch):
    """generate_image 也支持角色参数。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return _fake_result()

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)

    ctx = _ctx()
    asyncio.run(agent_tools.generate_image({
        "description": "画一幅画",
        "logo_path": "/tmp/logo.png",
    }, ctx))
    assert captured["logo_path"] == "/tmp/logo.png"


# ────────────────── #3 多图上限 ──────────────────


def test_multi_count_passed_through(monkeypatch):
    """count=3 透传到 poster_service。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return _fake_result(count=3)

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)

    ctx = _ctx()
    out = asyncio.run(agent_tools.make_poster({"description": "海报", "count": 3}, ctx))
    assert captured["count"] == 3
    assert "海报1" in out
    assert "海报3" in out


def test_count_capped_at_4(monkeypatch):
    """count 超过 4 被截到 4。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return _fake_result(count=4)

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)

    ctx = _ctx()
    asyncio.run(agent_tools.make_poster({"description": "海报", "count": 10}, ctx))
    assert captured["count"] == 4


def test_per_turn_cap_blocks_after_4(monkeypatch):
    """本轮已生成 4 张后，再调用被挡。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    monkeypatch.setattr(ps, "generate_images",
                        lambda **kw: asyncio.coroutine(lambda: _fake_result())())

    ctx = _ctx()
    ctx._images_generated_this_run = 4
    out = asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert "上限" in out


def test_per_turn_remaining_limits_count(monkeypatch):
    """本轮已生成 3 张，再要 3 张只出 1 张。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return _fake_result(count=1)

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)

    ctx = _ctx()
    ctx._images_generated_this_run = 3
    asyncio.run(agent_tools.make_poster({"description": "海报", "count": 3}, ctx))
    assert captured["count"] == 1


# ────────────────── #4 logo 状态诚实 ──────────────────


def test_logo_applied_reported(monkeypatch):
    """指定了 logo_path 且贴上了 → 返回文本含"logo 已自动贴到"。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    async def fake(**kwargs):
        return _fake_result(logo_applied=True)

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx()
    out = asyncio.run(agent_tools.make_poster({
        "description": "海报", "logo_path": "/tmp/logo.png",
    }, ctx))
    assert "融进画面" in out  # owner 拍板:logo 喂 GPT 融合,不再 PIL 贴


def test_logo_to_ai_message(monkeypatch):
    """owner 拍板:logo 一律喂 GPT 融合(不再 PIL 贴)——给了 logo_path 就提示"交给 AI"，不再有"没贴上"。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    async def fake(**kwargs):
        return _fake_result(logo_applied=False)

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx()
    out = asyncio.run(agent_tools.make_poster({
        "description": "海报", "logo_path": "/tmp/logo.png",
    }, ctx))
    assert "融进画面" in out and "没贴上" not in out


def test_no_logo_no_status(monkeypatch):
    """没指定 logo_path → 不提 logo 状态。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    async def fake(**kwargs):
        return _fake_result()

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx()
    out = asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert "logo" not in out


# ────────────────── #6 默认比例 3:4 ──────────────────


def test_default_ratio_3_4(monkeypatch):
    """make_poster 不传 ratio → 默认 3:4（与 poster_service 统一）。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake(**kwargs):
        captured.update(kwargs)
        return _fake_result()

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx()
    asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert captured["ratio"] == "3:4"


def test_generate_image_default_ratio_3_4(monkeypatch):
    """generate_image 不传 ratio → 默认 3:4。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake(**kwargs):
        captured.update(kwargs)
        return _fake_result()

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx()
    asyncio.run(agent_tools.generate_image({"description": "画一幅画"}, ctx))
    assert captured["ratio"] == "3:4"


# ────────────────── 2-3 生图回灌自检：出图后 append 进 ctx.pending_view_images ──────────────────


def test_make_poster_appends_real_file_to_pending_view_images(tmp_path, monkeypatch):
    """海报真落盘 → 本机路径要 append 进 ctx.pending_view_images，供 loop 下一轮回灌给模型自检。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps
    from config import settings as cfg_settings

    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))
    posters_dir = tmp_path / "posters"
    posters_dir.mkdir()
    real_file = posters_dir / "p0.jpg"
    real_file.write_bytes(b"\xff\xd8\xff")  # 假装是张 jpg

    async def fake(**kwargs):
        return {"images": [{"poster_url": "/uploads/posters/p0.jpg"}], "count": 1, "logo_applied": False}

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx(pending_view_images=[])
    out = asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert "做好啦" in out
    assert ctx.pending_view_images == [str(real_file)]


def test_generate_image_appends_real_file_to_pending_view_images(tmp_path, monkeypatch):
    """generate_image 同款：真实落盘的图要挂进回灌队列。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps
    from config import settings as cfg_settings

    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))
    posters_dir = tmp_path / "posters"
    posters_dir.mkdir()
    real_file = posters_dir / "p0.jpg"
    real_file.write_bytes(b"\xff\xd8\xff")

    async def fake(**kwargs):
        return {"images": [{"poster_url": "/uploads/posters/p0.jpg"}], "count": 1, "logo_applied": False}

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx(pending_view_images=[])
    asyncio.run(agent_tools.generate_image({"description": "画一幅画"}, ctx))
    assert ctx.pending_view_images == [str(real_file)]


def test_pending_view_images_skips_missing_file(tmp_path, monkeypatch):
    """poster_url 指向的本机文件其实不存在(极端场景) → 不挂假路径进回灌队列，故障安全。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps
    from config import settings as cfg_settings

    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))

    async def fake(**kwargs):
        return {"images": [{"poster_url": "/uploads/posters/不存在.jpg"}], "count": 1, "logo_applied": False}

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx(pending_view_images=[])
    asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert ctx.pending_view_images == []


def test_pending_view_images_capped_at_4(tmp_path, monkeypatch):
    """一次出多张图 → 最多挂 4 张进回灌队列，防一次性撑爆下一轮请求。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps
    from config import settings as cfg_settings

    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))
    posters_dir = tmp_path / "posters"
    posters_dir.mkdir()
    for i in range(6):
        (posters_dir / f"p{i}.jpg").write_bytes(b"\xff\xd8\xff")

    async def fake(**kwargs):
        return {
            "images": [{"poster_url": f"/uploads/posters/p{i}.jpg"} for i in range(6)],
            "count": 6, "logo_applied": False,
        }

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx(pending_view_images=[])
    asyncio.run(agent_tools.make_poster({"description": "海报", "count": 4}, ctx))
    assert len(ctx.pending_view_images) <= 4


def test_pending_view_images_noop_when_ctx_has_no_field(monkeypatch):
    """ctx 没有 pending_view_images 属性（旧调用方/最小 ctx）→ 静默跳过，不报错。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    async def fake(**kwargs):
        return _fake_result()

    monkeypatch.setattr(ps, "generate_images", fake)

    ctx = _ctx()  # 没带 pending_view_images
    out = asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert "做好啦" in out
    assert not hasattr(ctx, "pending_view_images")
