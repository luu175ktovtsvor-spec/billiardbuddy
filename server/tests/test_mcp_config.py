"""界面管 MCP server：增/删/启停 .mcp.json（原子写 + 故障安全 + 库内）。"""
import json

import pytest

from services.agent import mcp_config as mcfg
from services.agent import mcp_client as mc


@pytest.fixture(autouse=True)
def _lib(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path))
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    yield


def _read(tmp_path):
    p = tmp_path / ".mcp.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def test_add_creates_file_and_entry(tmp_path):
    ok, msg = mcfg.add_server("fetch", "uvx", ["mcp-server-fetch"])
    assert ok and "加上" in msg
    doc = _read(tmp_path)
    assert doc["mcpServers"]["fetch"] == {"command": "uvx", "args": ["mcp-server-fetch"]}
    # 列出
    servers = mcfg.list_servers()
    assert servers[0]["name"] == "fetch"
    assert servers[0]["disabled"] is False


def test_add_requires_name_and_command():
    assert mcfg.add_server("", "uvx")[0] is False
    assert mcfg.add_server("x", "")[0] is False


def test_memory_preset_removed():
    """长期记忆 memory 预设已从出厂清单移除：它和店脑记忆是竞争且不互通的第二套记忆，
    一键装上只会让两套记忆打架。其余免 key 预设（fetch/time/ddg）保留。"""
    ids = {p["id"] for p in mcfg.MCP_PRESETS}
    assert "memory" not in ids
    assert {"fetch", "time", "ddg"} <= ids


def test_add_overwrites_existing(tmp_path):
    mcfg.add_server("a", "npx", ["one"])
    ok, msg = mcfg.add_server("a", "uvx", ["two"])
    assert ok and "更新" in msg
    assert _read(tmp_path)["mcpServers"]["a"]["command"] == "uvx"


def test_remove(tmp_path):
    mcfg.add_server("a", "npx")
    ok, _ = mcfg.remove_server("a")
    assert ok
    assert "a" not in _read(tmp_path)["mcpServers"]
    # 删不存在 → 友好失败
    assert mcfg.remove_server("nope")[0] is False


def test_toggle_writes_disabled_flag(tmp_path):
    mcfg.add_server("a", "npx")
    ok, _ = mcfg.set_server_disabled("a", True)
    assert ok
    assert _read(tmp_path)["mcpServers"]["a"]["disabled"] is True
    # 启用回来 → 标记移除
    mcfg.set_server_disabled("a", False)
    assert "disabled" not in _read(tmp_path)["mcpServers"]["a"]


def test_disabled_server_skipped_by_loader(tmp_path):
    """停用的 server 不被 mcp_client 扫到（不连、不发现工具），但配置还在。"""
    mcfg.add_server("a", "npx")
    mcfg.set_server_disabled("a", True)
    assert "a" not in mc._load_mcp_config()  # 被过滤
    mcfg.set_server_disabled("a", False)
    assert "a" in mc._load_mcp_config()       # 开回来就有


def test_read_corrupt_file_is_safe(tmp_path):
    (tmp_path / ".mcp.json").write_text("{ not json", encoding="utf-8")
    assert mcfg.list_servers() == []           # 读坏不崩
    ok, _ = mcfg.add_server("a", "npx")        # 还能正常写回（覆盖坏文件）
    assert ok and _read(tmp_path)["mcpServers"]["a"]["command"] == "npx"


def test_atomic_no_tmp_left(tmp_path):
    mcfg.add_server("a", "npx")
    assert not (tmp_path / ".mcp.json.tmp").exists()  # 临时文件已被 replace 掉
