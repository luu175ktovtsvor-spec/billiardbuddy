"""MCP 客户端测试：对着最小假 MCP server 验 initialize/list/call/工具包装/状态。"""
import asyncio
import sys
from pathlib import Path

from services.agent import mcp_client as mc

FAKE = str(Path(__file__).parent / "fixtures" / "fake_mcp_server.py")


import pytest


@pytest.fixture(autouse=True)
def _reset_mcp_cache():
    yield
    mc._cached_tools = None


def _cfg():
    return {"command": sys.executable, "args": [FAKE]}


def test_initialize_list_call():
    with mc._StdioMCP(_cfg()) as s:
        tools = s.list_tools()
        assert any(t["name"] == "echo" for t in tools)
        out = s.call_tool("echo", {"text": "hi"})
        assert "echo: hi" in out


def test_load_mcp_tools_wraps(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda: {"fake": _cfg()})
    tools = mc.load_mcp_tools(force=True)
    names = [t.name for t in tools]
    assert "mcp__fake__echo" in names
    echo = next(t for t in tools if t.name == "mcp__fake__echo")
    assert echo.read_only is True  # readOnlyHint → 只读、免确认
    assert echo.requires_approval is False


def test_mcp_tool_handler_calls(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda: {"fake": _cfg()})
    echo = next(t for t in mc.load_mcp_tools(force=True) if t.name == "mcp__fake__echo")
    out = asyncio.run(echo.handler({"text": "yo"}, None))
    assert "echo: yo" in out


def test_mcp_status(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda: {"fake": _cfg()})
    st = mc.mcp_status()
    assert st[0]["name"] == "fake"
    assert st[0]["status"] == "connected"
    assert st[0]["tools"] == 1


def test_no_config_no_tools(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda: {})
    assert mc.load_mcp_tools(force=True) == []
