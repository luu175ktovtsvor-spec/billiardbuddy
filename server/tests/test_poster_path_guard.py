"""安全护栏回归：logo_path/qr_path/store_photo_path/reference_image_paths/mask_path 不能读任意本机文件。

背景：这几个参数桌面版下经【Agent 工具】传入，工具入参是【模型自己填的】——旧实现在 DESKTOP_LOCAL 下
对"uploads 沙箱外的绝对路径"来者不拒（Path(path).read_bytes()），等于给了模型/prompt 注入一个
"读任意本机文件、把内容发给外部生图 API"的后门。修法对齐 video_service._resolve_first_frame 的
allow_paths 校验模式：沙箱外绝对路径必须 ∈ 老板当场经 OS 文件选择器选定的 allowed_paths，否则越界拒绝。

只单测抽出来的纯函数（_resolve_allowed_paths / _resolve_agent_selected_bytes），不拉全套
DB/quota/AI provider 起 generate_images 端到端（成本太高，且现有测试里这条主流程也一贯只 mock 到
poster_service.generate_images 这一层，见 test_m2_image_roles.py）。
"""
from pathlib import Path

import pytest

from core.exceptions import AIServiceError
from services.poster_service import (
    _is_path_allowed,
    _load_upload_bytes,
    _resolve_agent_selected_bytes,
    _resolve_allowed_paths,
)


# ────────────────────────────── _resolve_allowed_paths ──────────────────────────────

def test_resolve_allowed_paths_empty_and_none():
    assert _resolve_allowed_paths(None) == set()
    assert _resolve_allowed_paths([]) == set()


def test_resolve_allowed_paths_resolves_and_drops_bad(tmp_path):
    good = tmp_path / "a.png"
    good.write_bytes(b"x")
    resolved = _resolve_allowed_paths([str(good), "\x00bad"])
    assert resolved == {good.resolve()}


def test_is_path_allowed_exact_and_dir_membership(tmp_path):
    d = tmp_path / "selected_dir"
    d.mkdir()
    f_in_dir = d / "inside.png"
    f_in_dir.write_bytes(b"x")
    standalone = tmp_path / "standalone.png"
    standalone.write_bytes(b"x")

    allowed = {d.resolve(), standalone.resolve()}
    assert _is_path_allowed(f_in_dir.resolve(), allowed) is True   # 选中目录内的文件
    assert _is_path_allowed(standalone.resolve(), allowed) is True  # 精确选中的文件
    other = tmp_path / "other.png"
    other.write_bytes(b"x")
    assert _is_path_allowed(other.resolve(), allowed) is False


# ────────────────────────────── _resolve_agent_selected_bytes ──────────────────────────────

def test_empty_path_returns_none():
    assert _resolve_agent_selected_bytes(None, set(), "Logo 图片") is None
    assert _resolve_agent_selected_bytes("", set(), "Logo 图片") is None


def test_uploads_sandbox_path_always_allowed(tmp_path, monkeypatch):
    """uploads 沙箱内的路径不管 DESKTOP_LOCAL / allowed 都能读——studio 前端走文件选择器的正常路径。"""
    from config import settings as cfg_settings
    monkeypatch.setattr(cfg_settings, "upload_dir", str(tmp_path))
    monkeypatch.delenv("DESKTOP_LOCAL", raising=False)
    p = tmp_path / "logo.png"
    p.write_bytes(b"\x89PNG-logo")
    assert _resolve_agent_selected_bytes("/uploads/logo.png", set(), "Logo 图片") == b"\x89PNG-logo"


def test_desktop_path_in_allowed_set_is_read(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    logo = tmp_path / "外部logo.png"
    logo.write_bytes(b"\x89PNG-real")
    allowed = _resolve_allowed_paths([str(logo)])
    out = _resolve_agent_selected_bytes(str(logo), allowed, "Logo 图片")
    assert out == b"\x89PNG-real"


def test_desktop_path_in_allowed_directory_is_read(tmp_path, monkeypatch):
    """老板选的是一个目录（而不是单个文件）——目录内的文件也算允许。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    d = tmp_path / "选定的文件夹"
    d.mkdir()
    logo = d / "logo.png"
    logo.write_bytes(b"\x89PNG-dir")
    allowed = _resolve_allowed_paths([str(d)])
    out = _resolve_agent_selected_bytes(str(logo), allowed, "Logo 图片")
    assert out == b"\x89PNG-dir"


def test_desktop_path_outside_allowed_raises(tmp_path, monkeypatch):
    """核心回归：DESKTOP_LOCAL 下，不在 allowed 里的绝对路径必须拒绝，不能来者不拒。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    victim = tmp_path / "不该被读到的文件.jpg"
    victim.write_bytes(b"secret-bytes")
    with pytest.raises(AIServiceError) as exc_info:
        _resolve_agent_selected_bytes(str(victim), set(), "Logo 图片")
    msg = exc_info.value.message
    assert "没有读取" in msg or "出于安全" in msg
    assert "Logo 图片" in msg


def test_desktop_path_outside_allowed_but_other_file_allowed_still_raises(tmp_path, monkeypatch):
    """allowed 非空但不含目标路径——同样必须拒绝，不能"只要 allowed 非空就放行"。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    victim = tmp_path / "victim.jpg"
    victim.write_bytes(b"secret-bytes")
    unrelated = tmp_path / "unrelated.png"
    unrelated.write_bytes(b"x")
    allowed = _resolve_allowed_paths([str(unrelated)])
    with pytest.raises(AIServiceError):
        _resolve_agent_selected_bytes(str(victim), allowed, "参考图")


def test_non_desktop_outside_sandbox_silently_skipped(tmp_path, monkeypatch):
    """云端 web 版没有"老板当场选定本机文件"的概念——沙箱外静默跳过（None），不抛错、也不读。"""
    monkeypatch.delenv("DESKTOP_LOCAL", raising=False)
    victim = tmp_path / "victim.jpg"
    victim.write_bytes(b"secret-bytes")
    out = _resolve_agent_selected_bytes(str(victim), set(), "参考图")
    assert out is None


def test_invalid_path_raises_friendly_error(monkeypatch):
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    with pytest.raises(AIServiceError) as exc_info:
        _resolve_agent_selected_bytes("\x00bad-path", set(), "二维码图片")
    assert "路径无效" in exc_info.value.message


def test_desktop_missing_file_in_allowed_returns_none(tmp_path, monkeypatch):
    """路径在 allowed 里但文件其实不存在——按"没这个文件"处理（None），不是越界错误。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    missing = tmp_path / "已经删了.png"
    allowed = _resolve_allowed_paths([str(missing)])
    out = _resolve_agent_selected_bytes(str(missing), allowed, "Logo 图片")
    assert out is None


# ────────────────────────────── generate_images 接线回归（不起真实生图，只查签名/源码）──────────────────────────────

def test_generate_images_accepts_allowed_paths_param():
    import inspect
    from services.poster_service import generate_images
    params = inspect.signature(generate_images).parameters
    assert "allowed_paths" in params
    assert params["allowed_paths"].default is None


def test_generate_images_uses_guarded_helper_not_raw_read():
    """回归防呆：源码里 logo/qr/store_photo/参考图 的读取必须走 _resolve_agent_selected_bytes，
    不能又双叒退回 Path(...).read_bytes() 的裸读老路。"""
    import inspect
    from services import poster_service
    src = inspect.getsource(poster_service.generate_images)
    assert "_resolve_agent_selected_bytes" in src
    assert "Path(logo_path).read_bytes()" not in src
    assert "Path(qr_path).read_bytes()" not in src
