"""Output Styles 测试（对标 Claude Code 的 .md 输出风格）。"""
from pathlib import Path

from services.agent import output_styles as osm


def _make(root: Path, name: str, body: str = "风格正文", **fm):
    lines = ["---", f"name: {name}"]
    for k, v in fm.items():
        lines.append(f"{k.replace('_', '-')}: {v}")
    lines += ["---", body]
    (root / f"{name}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_load_output_styles(tmp_path):
    _make(tmp_path, "concise", body="精简点", description="极简")
    styles = osm.load_output_styles(dirs=[("user", tmp_path)])
    assert len(styles) == 1
    assert styles[0].name == "concise"
    assert styles[0].description == "极简"
    assert "精简点" in styles[0].prompt
    assert styles[0].source == "user"


def test_filename_is_name_when_no_frontmatter(tmp_path):
    (tmp_path / "myst.md").write_text("just a style body, no frontmatter", encoding="utf-8")
    styles = osm.load_output_styles(dirs=[("user", tmp_path)])
    assert styles[0].name == "myst"
    assert "just a style body" in styles[0].prompt


def test_dedup_priority(tmp_path):
    u = tmp_path / "u"; p = tmp_path / "p"
    u.mkdir(); p.mkdir()
    _make(u, "s", body="用户版")
    _make(p, "s", body="项目版")
    styles = osm.load_output_styles(dirs=[("user", u), ("project", p)])
    assert len(styles) == 1
    assert "项目版" in styles[0].prompt


def test_get_and_render(tmp_path):
    _make(tmp_path, "explain", body="多解释为什么")
    styles = osm.load_output_styles(dirs=[("user", tmp_path)])
    s = osm.get_output_style("explain", styles)
    assert s is not None and "多解释" in s.prompt
    assert osm.get_output_style("nope", styles) is None


def test_render_output_style_prompt_empty_name():
    assert osm.render_output_style_prompt("") == ""


def test_keep_coding_instructions_default_true(tmp_path):
    _make(tmp_path, "s1", body="x")
    assert osm.load_output_styles(dirs=[("user", tmp_path)])[0].keep_coding_instructions is True


def test_bundled_output_styles_present():
    names = {s.name for s in osm.load_output_styles()}
    assert "explanatory" in names
    assert "concise" in names
