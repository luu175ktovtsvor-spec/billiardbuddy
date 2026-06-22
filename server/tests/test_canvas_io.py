"""画板成品落地（canvas_io）单测：各格式渲染 + 存内容库。"""
import docx
import pytest

from services import canvas_io

MD = "# 周末活动\n\n两人同行立减 30 元。\n- 周六日全天\n- **免费**教练陪打"


def test_render_md_roundtrip():
    assert canvas_io.render_bytes(MD, "md").decode("utf-8") == MD


def test_render_txt_strips_markdown():
    txt = canvas_io.render_bytes(MD, "txt").decode("utf-8")
    assert "#" not in txt
    assert "**" not in txt
    assert "• 周六日全天" in txt
    assert "免费教练陪打" in txt


def test_render_html_structure_and_escape():
    html = canvas_io.render_bytes("# 标题\n<script>x</script>\n- 项", "html").decode("utf-8")
    assert "<h1>标题</h1>" in html
    assert "<li>项</li>" in html
    assert "<script>" not in html  # 必须转义
    assert "&lt;script&gt;" in html


def test_render_docx_opens_and_has_heading(tmp_path):
    data = canvas_io.render_bytes(MD, "docx")
    p = tmp_path / "o.docx"
    p.write_bytes(data)
    d = docx.Document(str(p))
    texts = [para.text for para in d.paragraphs]
    assert "周末活动" in texts  # 标题段
    assert any("两人同行立减 30 元" in t for t in texts)


def test_render_unsupported_raises():
    with pytest.raises(ValueError):
        canvas_io.render_bytes(MD, "pdf")


def test_save_to_library_writes_and_backups(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path / "lib"))
    p1 = canvas_io.save_to_library(MD, "md", "周末活动")
    assert p1.exists() and p1.suffix == ".md"
    assert p1.read_text(encoding="utf-8") == MD
    # 重名再存 → 原件先备份，仍写成功
    p2 = canvas_io.save_to_library("# 新版", "md", "周末活动")
    assert p2 == p1
    assert p2.read_text(encoding="utf-8") == "# 新版"
    backups = list((tmp_path / "lib" / ".backups").glob("*"))
    assert len(backups) >= 1


def test_save_to_library_sanitizes_name(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path / "lib"))
    p = canvas_io.save_to_library(MD, "txt", "../../坏/名:字")
    assert p.parent.name == "成品"  # 没被路径穿越带出去
    assert "/" not in p.name and ":" not in p.name


def test_strip_code_fence():
    from services.canvas_service import _strip_code_fence
    assert _strip_code_fence("```html\n<p>x</p>\n```") == "<p>x</p>"
    assert _strip_code_fence("<p>x</p>") == "<p>x</p>"
    assert _strip_code_fence("```\nhi\n```") == "hi"
