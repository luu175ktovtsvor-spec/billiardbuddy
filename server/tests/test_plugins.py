"""Plugins 测试：发现/启用/组件目录/MCP 合并/经 skills 加载器并入。"""
import json
from pathlib import Path

from services.agent import plugins as pl
from services.agent import skills as sk
from services.agent import output_styles as osm


def _make_plugin(root: Path, name: str, manifest=None, skills=None, styles=None, mcp=None):
    pdir = root / name
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "plugin.json").write_text(json.dumps({"name": name, **(manifest or {})}), encoding="utf-8")
    for sname, body in (skills or {}).items():
        sd = pdir / "skills" / sname
        sd.mkdir(parents=True, exist_ok=True)
        (sd / "SKILL.md").write_text(f"---\nname: {sname}\ndescription: {body}\n---\n{body}\n", encoding="utf-8")
    if styles:
        (pdir / "output-styles").mkdir(parents=True, exist_ok=True)
        for stn, body in styles.items():
            (pdir / "output-styles" / f"{stn}.md").write_text(f"---\nname: {stn}\n---\n{body}\n", encoding="utf-8")
    if mcp:
        (pdir / ".mcp.json").write_text(json.dumps({"mcpServers": mcp}), encoding="utf-8")
    return pdir


def test_discover_and_enabled(tmp_path):
    _make_plugin(tmp_path, "p1", skills={"foo": "do foo"})
    plugins = pl.discover_plugins([tmp_path])
    assert len(plugins) == 1
    assert plugins[0]["name"] == "p1"
    assert plugins[0]["enabled"] is True


def test_disabled_plugin_excluded(tmp_path):
    _make_plugin(tmp_path, "p1", manifest={"enabled": False})
    assert pl._enabled_plugins([tmp_path]) == []


def test_component_dirs(tmp_path):
    _make_plugin(tmp_path, "p1", skills={"foo": "x"}, styles={"calm": "y"})
    sd = pl.plugin_component_dirs("skills", [tmp_path])
    assert len(sd) == 1 and sd[0][0] == "plugin:p1"
    assert len(pl.plugin_component_dirs("output-styles", [tmp_path])) == 1


def test_plugin_mcp_servers(tmp_path):
    _make_plugin(tmp_path, "p1", mcp={"echo": {"command": "x"}})
    assert "echo" in pl.plugin_mcp_servers([tmp_path])


def test_plugin_skills_loadable_via_skills_loader(tmp_path):
    _make_plugin(tmp_path, "p1", skills={"plugfoo": "from plugin"})
    dirs = pl.plugin_component_dirs("skills", [tmp_path])
    names = {s.name for s in sk.load_skills(dirs=dirs)}
    assert "plugfoo" in names


def test_plugin_styles_loadable(tmp_path):
    _make_plugin(tmp_path, "p1", styles={"plugcalm": "calm body"})
    dirs = pl.plugin_component_dirs("output-styles", [tmp_path])
    names = {s.name for s in osm.load_output_styles(dirs=dirs)}
    assert "plugcalm" in names


def test_install_rejects_bad_format():
    assert pl.install_plugin_from_github("")[0] is False
    assert pl.install_plugin_from_github("notarepo")[0] is False


def test_install_rejects_existing(monkeypatch, tmp_path):
    monkeypatch.setattr(pl, "_install_dir", lambda: tmp_path)
    (tmp_path / "repo").mkdir(parents=True)
    ok, msg = pl.install_plugin_from_github("owner/repo")
    assert ok is False and "已存在" in msg


def test_list_plugins_counts(tmp_path):
    _make_plugin(tmp_path, "p1", manifest={"description": "test"}, skills={"a": "x", "b": "y"})
    items = pl.list_plugins([tmp_path])
    assert items[0]["name"] == "p1"
    assert items[0]["description"] == "test"
    assert items[0]["components"]["skills"] == 2


def test_set_plugin_enabled_writes_manifest(tmp_path):
    _make_plugin(tmp_path, "p1")
    ok, msg = pl.set_plugin_enabled("p1", False, roots=[tmp_path])
    assert ok and "停用" in msg
    mf = json.loads((tmp_path / "p1" / "plugin.json").read_text(encoding="utf-8"))
    assert mf["enabled"] is False
    # 停用后被 _enabled_plugins 过滤掉
    assert pl._enabled_plugins([tmp_path]) == []
    # 开回来
    pl.set_plugin_enabled("p1", True, roots=[tmp_path])
    assert json.loads((tmp_path / "p1" / "plugin.json").read_text(encoding="utf-8"))["enabled"] is True
    assert len(pl._enabled_plugins([tmp_path])) == 1
    assert not (tmp_path / "p1" / "plugin.json.tmp").exists()  # 原子写、无残留 tmp


def test_set_plugin_enabled_missing():
    assert pl.set_plugin_enabled("nope", True, roots=[])[0] is False
