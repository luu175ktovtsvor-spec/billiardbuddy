"""Output Styles —— 对标 Claude Code 的输出风格（clean-room：只复刻开放契约）。

切换 agent 的"输出人格/模式"，本质 = 往系统提示追加一段风格指令。
- 单个 `.md` 文件 = 一个风格（文件名=风格名，可被 frontmatter `name` 覆盖）。
- 来源（优先级 低→高，同名后者覆盖）：bundled(`server/output-styles/`) → user(`~/.claude/output-styles/`) → 库。
- frontmatter：name / description / keep-coding-instructions。正文 = 要追加的提示词。
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from services.agent.skills import parse_frontmatter, _as_bool, _get  # 复用解析器


@dataclass
class OutputStyle:
    name: str
    description: str
    prompt: str
    source: str
    path: str
    keep_coding_instructions: bool = True


def _bundled_output_styles_dir() -> Path | None:
    base = getattr(sys, "_MEIPASS", None)
    if base:
        p = Path(base) / "output-styles"
        if p.is_dir():
            return p
    p = Path(__file__).resolve().parent.parent.parent / "output-styles"  # server/output-styles
    return p if p.is_dir() else None


def _output_style_dirs() -> list[tuple[str, Path]]:
    dirs: list[tuple[str, Path]] = []
    b = _bundled_output_styles_dir()
    if b:
        dirs.append(("bundled", b))
    dirs.append(("user", Path.home() / ".claude" / "output-styles"))
    lib = os.environ.get("DESKTOP_LIBRARY_DIR")
    if lib:
        dirs.append(("project", Path(lib) / "output-styles"))
    # 启用插件提供的输出风格（自动并入 → 直接出现在工具条风格下拉）
    try:
        from services.agent import plugins as _plugins
        dirs.extend(_plugins.plugin_component_dirs("output-styles"))
    except Exception:
        pass
    return dirs


def _load_output_style_file(md: Path, source: str) -> OutputStyle | None:
    try:
        text = md.read_text(encoding="utf-8")
    except Exception:
        return None
    meta, body = parse_frontmatter(text)
    name = str(_get(meta, "name", default=md.stem) or md.stem).strip()
    desc = str(_get(meta, "description", default="") or "").strip()
    return OutputStyle(
        name=name,
        description=desc,
        prompt=(body or "").strip(),
        source=source,
        path=str(md),
        keep_coding_instructions=_as_bool(_get(meta, "keep-coding-instructions", "keep_coding_instructions", default=True), True),
    )


def load_output_styles(dirs: list[tuple[str, Path]] | None = None) -> list[OutputStyle]:
    use = dirs if dirs is not None else _output_style_dirs()
    found: dict[str, OutputStyle] = {}
    for source, root in use:
        try:
            if not Path(root).is_dir():
                continue
            for f in sorted(Path(root).glob("*.md")):
                st = _load_output_style_file(f, source)
                if st and st.name:
                    found[st.name] = st
        except Exception:
            continue
    return list(found.values())


def get_output_style(name: str, styles: list[OutputStyle] | None = None) -> OutputStyle | None:
    if not name:
        return None
    for s in (styles if styles is not None else load_output_styles()):
        if s.name == name:
            return s
    return None


def render_output_style_prompt(name: str) -> str:
    """取某风格要追加进系统提示的段落；空名/不存在/空正文 → ""。"""
    s = get_output_style(name)
    if not s or not s.prompt:
        return ""
    return f"【输出风格 · {s.name}】\n{s.prompt}"
