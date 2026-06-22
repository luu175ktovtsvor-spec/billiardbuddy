"""Word/PPT 按块读 + 写回 单测：读出块 → 改其中一块 → 写回 → 复读验证只改了那块。"""
import docx
from pptx import Presentation

from services import canvas_docedit


def test_docx_read_edit_writeback(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path / "lib"))
    p = tmp_path / "方案.docx"
    d = docx.Document()
    d.add_heading("活动方案", level=1)
    d.add_paragraph("周末满 100 送 30。")
    d.add_paragraph("仅限堂食。")
    d.save(str(p))

    data = canvas_docedit.read_blocks(p)
    assert data["kind"] == "docx"
    texts = {b["id"]: b["text"] for b in data["blocks"]}
    assert "活动方案" in texts.values()
    # 找到"周末满 100 送 30。"那块的 id
    target = next(b["id"] for b in data["blocks"] if "周末满" in b["text"])
    canvas_docedit.write_blocks(p, {target: "周末满 200 送 80，力度加倍！"})

    after = {b["text"] for b in canvas_docedit.read_blocks(p)["blocks"]}
    assert "周末满 200 送 80，力度加倍！" in after
    assert "周末满 100 送 30。" not in after
    assert "仅限堂食。" in after      # 没动的块原样
    assert "活动方案" in after        # 标题原样
    # 改前自动备份了（落在内容库 .backups）
    assert (tmp_path / "lib" / ".backups").exists()


def test_pptx_read_edit_writeback(tmp_path):
    p = tmp_path / "培训.pptx"
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "助教服务标准"
    body = slide.placeholders[1].text_frame
    body.text = "热情主动"
    body.add_paragraph().text = "不越界"
    prs.save(str(p))

    data = canvas_docedit.read_blocks(p)
    assert data["kind"] == "pptx"
    target = next(b["id"] for b in data["blocks"] if "热情主动" in b["text"])
    canvas_docedit.write_blocks(p, {target: "热情主动、有分寸"})

    after = {b["text"] for b in canvas_docedit.read_blocks(p)["blocks"]}
    assert "热情主动、有分寸" in after
    assert "热情主动" not in after
    assert "不越界" in after            # 没动的块原样
    assert "助教服务标准" in after      # 标题原样


def test_writeback_empty_noop(tmp_path):
    p = tmp_path / "x.docx"
    d = docx.Document()
    d.add_paragraph("一")
    d.save(str(p))
    canvas_docedit.write_blocks(p, {})  # 不抛错
    assert "一" in {b["text"] for b in canvas_docedit.read_blocks(p)["blocks"]}
