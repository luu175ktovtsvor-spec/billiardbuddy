"""本地图像处理工具（edit_image）测试：沙箱 + 备份 + 各操作正确性 + 故障安全。

复用 local_tools 的沙箱(_resolve)与备份(_backup)，所以这里重点验证：
- 各操作真改对了像素/尺寸/格式；覆盖原图前进了 .backups。
- 沙箱外的图未授权 → 友好拒绝（不抛崩）；不认识的操作/非图片 → 友好提示。
- 工具元信息：requires_approval=True、approval_class="file"、有 preview。
"""
from types import SimpleNamespace

import pytest

from services.agent.context import AgentContext


@pytest.fixture
def library(tmp_path, monkeypatch):
    """内容库指向临时目录，隔离真实 ~/.billiards-desktop。"""
    lib = tmp_path / "library"
    lib.mkdir()
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(lib))
    return lib


@pytest.fixture
def sample_png(library):
    """在内容库里放一张 800×600 测试图。"""
    from PIL import Image
    img = Image.new("RGB", (800, 600), (200, 40, 40))
    p = library / "pic.png"
    img.save(p)
    return p


def _open(path):
    from PIL import Image
    return Image.open(path)


# ────────────────────────────── 注册 + 元信息 ──────────────────────────────

def test_edit_image_registered_and_metadata():
    from services.agent.image_tools import register_image_tools
    from services.agent.registry import ToolRegistry
    reg = ToolRegistry()
    register_image_tools(reg)
    t = reg.get("edit_image")
    assert t is not None
    assert t.requires_approval is True
    assert t.approval_class == "file"  # 跟写类文件工具同档（信任模式可免确认，改前已备份）
    assert t.preview is not None
    # schema 可导出
    schema = t.to_openai_schema()
    assert schema["function"]["name"] == "edit_image"


# ────────────────────────────── 各操作正确性 ──────────────────────────────

@pytest.mark.asyncio
async def test_crop_square(library, sample_png):
    from services.agent.image_tools import edit_image
    out = await edit_image(
        {"path": "pic.png", "operation": "crop", "shape": "square", "output_path": "sq.png"},
        AgentContext(),
    )
    assert "正方形" in out
    assert _open(library / "sq.png").size == (600, 600)


@pytest.mark.asyncio
async def test_crop_box(library, sample_png):
    from services.agent.image_tools import edit_image
    await edit_image(
        {"path": "pic.png", "operation": "crop", "left": 100, "top": 50, "right": 400, "bottom": 250,
         "output_path": "box.png"},
        AgentContext(),
    )
    assert _open(library / "box.png").size == (300, 200)


@pytest.mark.asyncio
async def test_resize_by_width_keeps_ratio(library, sample_png):
    from services.agent.image_tools import edit_image
    await edit_image({"path": "pic.png", "operation": "resize", "width": 400, "output_path": "r.png"}, AgentContext())
    assert _open(library / "r.png").size == (400, 300)  # 高按比例 600*400/800=300


@pytest.mark.asyncio
async def test_resize_by_scale(library, sample_png):
    from services.agent.image_tools import edit_image
    await edit_image({"path": "pic.png", "operation": "resize", "scale": 0.5, "output_path": "s.png"}, AgentContext())
    assert _open(library / "s.png").size == (400, 300)


@pytest.mark.asyncio
async def test_rotate_expands_canvas(library, sample_png):
    from services.agent.image_tools import edit_image
    await edit_image({"path": "pic.png", "operation": "rotate", "angle": 90, "output_path": "rot.png"}, AgentContext())
    assert _open(library / "rot.png").size == (600, 800)  # 转 90° 宽高互换


@pytest.mark.asyncio
async def test_watermark_keeps_size_and_changes_pixels(library, sample_png):
    from services.agent.image_tools import edit_image
    out = await edit_image(
        {"path": "pic.png", "operation": "watermark", "text": "台球运营管家", "output_path": "wm.png"},
        AgentContext(),
    )
    assert "水印" in out
    wm = _open(library / "wm.png")
    assert wm.size == (800, 600)  # 尺寸不变


@pytest.mark.asyncio
async def test_convert_png_to_jpg_default_suffix(library, sample_png):
    from services.agent.image_tools import edit_image
    out = await edit_image({"path": "pic.png", "operation": "convert", "format": "jpg"}, AgentContext())
    assert (library / "pic.jpg").exists()
    assert _open(library / "pic.jpg").format == "JPEG"


@pytest.mark.asyncio
async def test_convert_via_output_extension(library, sample_png):
    from services.agent.image_tools import edit_image
    # 不给 format，靠 output_path 扩展名定目标格式
    await edit_image({"path": "pic.png", "operation": "convert", "output_path": "out.webp"}, AgentContext())
    assert _open(library / "out.webp").format == "WEBP"


@pytest.mark.asyncio
async def test_convert_missing_format_friendly(library, sample_png):
    from services.agent.image_tools import edit_image
    out = await edit_image({"path": "pic.png", "operation": "convert"}, AgentContext())
    assert "format" in out  # 既没 format 也没 output_path → 提示要给 format


@pytest.mark.asyncio
async def test_compress_overwrites_with_backup(library, sample_png):
    from services.agent.image_tools import edit_image
    # 先转成 jpg（压缩对 jpg 质量有效）
    await edit_image({"path": "pic.png", "operation": "convert", "format": "jpg"}, AgentContext())
    out = await edit_image({"path": "pic.jpg", "operation": "compress", "quality": 30}, AgentContext())
    assert "已覆盖原图" in out
    assert "备份" in out
    # 覆盖前进了 .backups
    backups = list((library / ".backups").glob("*.bak"))
    assert len(backups) >= 1


# ────────────────────────────── 沙箱 + 故障安全 ──────────────────────────────

@pytest.mark.asyncio
async def test_outside_sandbox_denied_friendly(library, tmp_path):
    from PIL import Image
    from services.agent.image_tools import edit_image
    outside = tmp_path / "outside.png"
    Image.new("RGB", (10, 10)).save(outside)
    # 未选定、未开全盘 → 友好拒绝，不抛
    out = await edit_image({"path": str(outside), "operation": "compress"}, AgentContext())
    assert "越界" in out or "处理不了" in out


@pytest.mark.asyncio
async def test_selected_outside_file_allowed(library, tmp_path):
    from PIL import Image
    from services.agent.image_tools import edit_image
    sel = tmp_path / "desktop" / "海报.png"
    sel.parent.mkdir(parents=True)
    Image.new("RGB", (400, 400), (10, 10, 10)).save(sel)
    ctx = AgentContext(allowed_paths=[str(sel)])
    # 选定的库外文件可读改；另存到内容库（沙箱内）——兄弟目录未授权，故输出落库
    out = await edit_image(
        {"path": str(sel), "operation": "resize", "scale": 0.5, "output_path": "小.png"},
        ctx,
    )
    assert "缩放" in out
    assert _open(library / "小.png").size == (200, 200)


@pytest.mark.asyncio
async def test_unknown_operation_friendly(library, sample_png):
    from services.agent.image_tools import edit_image
    out = await edit_image({"path": "pic.png", "operation": "flip"}, AgentContext())
    assert "不认识" in out


@pytest.mark.asyncio
async def test_non_image_friendly(library):
    from services.agent.image_tools import edit_image
    (library / "note.txt").write_text("hi")
    out = await edit_image({"path": "note.txt", "operation": "resize", "width": 100}, AgentContext())
    assert "不是能识别的图片" in out or "图片" in out


@pytest.mark.asyncio
async def test_missing_path_friendly(library):
    from services.agent.image_tools import edit_image
    out = await edit_image({"operation": "compress"}, AgentContext())
    assert "path" in out


def test_preview_never_raises(library):
    from services.agent.image_tools import preview_edit_image
    # 各操作的预览都返回字符串、不抛
    for op, extra in [
        ("crop", {"shape": "square"}),
        ("resize", {"width": 300}),
        ("watermark", {"text": "abc"}),
        ("compress", {"quality": 50}),
        ("convert", {"format": "jpg"}),
        ("rotate", {"angle": 90}),
    ]:
        s = preview_edit_image({"path": "pic.png", "operation": op, **extra}, AgentContext())
        assert isinstance(s, str) and len(s) > 0
