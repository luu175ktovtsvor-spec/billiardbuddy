"""Word(.docx) / PPT(.pptx) 「文字级编辑 + 写回原文件」。

思路（关键）：把文档拆成带【稳定 id】的文本块给前端编辑；保存时按 id 回到原文件、
【原地只改这几段的文字】、保留文档其余结构与格式，再写回（改前自动备份）。
不重造文档 = 真·写回，符合"只改我改的、别动其它"。

扩展：要支持别的可按块编辑的格式，加一对 _xxx_blocks / _xxx_write 即可。
"""
from __future__ import annotations

import re
from pathlib import Path


# ───────────────── 读：文档 → 带 id 的文本块 ─────────────────

def _para_kind(style_name: str) -> str:
    s = (style_name or "").lower()
    if s.startswith("heading 1") or s == "title":
        return "h1"
    if s.startswith("heading 2"):
        return "h2"
    if s.startswith("heading 3"):
        return "h3"
    if "list" in s or s.startswith("bullet"):
        return "li"
    return "p"


def _docx_blocks(path: Path) -> list[dict]:
    import docx

    d = docx.Document(str(path))
    blocks: list[dict] = []
    for i, p in enumerate(d.paragraphs):
        if not (p.text or "").strip():
            continue
        blocks.append({"id": f"p{i}", "kind": _para_kind(p.style.name if p.style else ""), "text": p.text})
    for ti, tbl in enumerate(d.tables):
        for ri, row in enumerate(tbl.rows):
            for ci, cell in enumerate(row.cells):
                if (cell.text or "").strip():
                    blocks.append({"id": f"t{ti}-{ri}-{ci}", "kind": "cell", "text": cell.text})
    return blocks


def _pptx_blocks(path: Path) -> list[dict]:
    from pptx import Presentation

    prs = Presentation(str(path))
    blocks: list[dict] = []
    for si, slide in enumerate(prs.slides):
        title_id = None
        try:
            if slide.shapes.title is not None:
                title_id = slide.shapes.title.shape_id
        except Exception:  # noqa: BLE001
            title_id = None
        for shi, shape in enumerate(slide.shapes):
            if not shape.has_text_frame:
                continue
            is_title = title_id is not None and shape.shape_id == title_id
            for pi, para in enumerate(shape.text_frame.paragraphs):
                if not (para.text or "").strip():
                    continue
                blocks.append({
                    "id": f"s{si}-{shi}-{pi}",
                    "kind": "title" if is_title else "body",
                    "text": para.text,
                    "slide": si + 1,
                })
    return blocks


def read_blocks(path: Path) -> dict:
    """读 docx/pptx → {kind, blocks:[{id, kind, text, slide?}]}。"""
    ext = path.suffix.lower()
    if ext == ".docx":
        return {"kind": "docx", "blocks": _docx_blocks(path)}
    if ext == ".pptx":
        return {"kind": "pptx", "blocks": _pptx_blocks(path)}
    raise ValueError(f"不支持按块编辑：{ext}")


# ───────────────── 写：把改动按 id 原地写回原文件 ─────────────────

def _set_para_runs(para, text: str) -> None:
    """把段落文字换成 text，保留段落样式：改第一个 run、清空其余；无 run 则新建。"""
    runs = para.runs
    if runs:
        runs[0].text = text
        for r in runs[1:]:
            r.text = ""
    else:
        para.add_run(text)


def _docx_write(path: Path, edits: dict) -> None:
    import docx

    d = docx.Document(str(path))
    paras = d.paragraphs
    for key, new in edits.items():
        if key.startswith("p"):
            i = int(key[1:])
            if 0 <= i < len(paras):
                _set_para_runs(paras[i], new)
        elif key.startswith("t"):
            m = re.match(r"t(\d+)-(\d+)-(\d+)$", key)
            if not m:
                continue
            ti, ri, ci = (int(x) for x in m.groups())
            try:
                cell = d.tables[ti].rows[ri].cells[ci]
            except (IndexError, AttributeError):
                continue
            # 单元格：改第一个段落，清掉其余段落文字
            cps = cell.paragraphs
            if cps:
                _set_para_runs(cps[0], new)
                for extra in cps[1:]:
                    for r in extra.runs:
                        r.text = ""
    d.save(str(path))


def _pptx_write(path: Path, edits: dict) -> None:
    from pptx import Presentation

    prs = Presentation(str(path))
    slides = list(prs.slides)
    for key, new in edits.items():
        m = re.match(r"s(\d+)-(\d+)-(\d+)$", key)
        if not m:
            continue
        si, shi, pi = (int(x) for x in m.groups())
        if si >= len(slides):
            continue
        shapes = list(slides[si].shapes)
        if shi >= len(shapes) or not shapes[shi].has_text_frame:
            continue
        paras = shapes[shi].text_frame.paragraphs
        if pi >= len(paras):
            continue
        _set_para_runs(paras[pi], new)
    prs.save(str(path))


def write_blocks(path: Path, edits: dict) -> None:
    """把 {id: 新文字} 原地写回原文件（改前自动备份）。"""
    from services.agent.local_tools import _backup

    if not edits:
        return
    ext = path.suffix.lower()
    if ext not in (".docx", ".pptx"):
        raise ValueError(f"不支持写回：{ext}")
    _backup(path)
    if ext == ".docx":
        _docx_write(path, edits)
    else:
        _pptx_write(path, edits)
