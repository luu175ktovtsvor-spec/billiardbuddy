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
    mc._status_cache = None  # 状态缓存也清，避免测试间串味（某测填了缓存，下个不带 force 拿到旧值）


def _cfg():
    return {"command": sys.executable, "args": [FAKE]}


def test_initialize_list_call():
    with mc._StdioMCP(_cfg()) as s:
        tools = s.list_tools()
        assert any(t["name"] == "echo" for t in tools)
        out = s.call_tool("echo", {"text": "hi"})
        assert "echo: hi" in out


def test_load_mcp_tools_wraps(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda **k: {"fake": _cfg()})
    tools = mc.load_mcp_tools(force=True)
    names = [t.name for t in tools]
    assert "mcp__fake__echo" in names
    echo = next(t for t in tools if t.name == "mcp__fake__echo")
    assert echo.read_only is True  # readOnlyHint → 只读、免确认
    assert echo.requires_approval is False


def test_mcp_tool_handler_calls(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda **k: {"fake": _cfg()})
    echo = next(t for t in mc.load_mcp_tools(force=True) if t.name == "mcp__fake__echo")
    out = asyncio.run(echo.handler({"text": "yo"}, None))
    assert "echo: yo" in out


def test_mcp_status(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda **k: {"fake": _cfg()})
    st = mc.mcp_status()
    assert st[0]["name"] == "fake"
    assert st[0]["status"] == "connected"
    assert st[0]["tools"] == 1


def test_no_config_no_tools(monkeypatch):
    monkeypatch.setattr(mc, "_load_mcp_config", lambda **k: {})
    assert mc.load_mcp_tools(force=True) == []


# ─── mcp_status 并行探测 + 短超时（设置页不被某个慢/挂的 server 拖死）───

def test_mcp_status_probes_in_parallel(monkeypatch):
    """多个 server 应并行探测：用一个会"在飞时记录并发数"的假探测，验证同时在飞 ≥2（串行只会 ==1）。"""
    fake = {"s1": {"command": "x"}, "s2": {"command": "x"}, "s3": {"command": "x"}}
    monkeypatch.setattr(mc, "_load_mcp_config", lambda **k: dict(fake))
    state = {"cur": 0, "max": 0}

    async def fake_list_tools(cfg, timeout=mc._OP_TIMEOUT):
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        await asyncio.sleep(0.05)
        state["cur"] -= 1
        return [{"name": "t"}]

    monkeypatch.setattr(mc, "_a_list_tools", fake_list_tools)
    st = mc.mcp_status(force=True)
    assert len(st) == 3
    assert all(e["status"] == "connected" and e["tools"] == 1 for e in st)
    assert state["max"] >= 2  # 并行：至少两个同时握手；串行的话峰值并发恒为 1


def test_mcp_status_uses_short_probe_timeout(monkeypatch):
    """探测走短超时（_STATUS_PROBE_TIMEOUT）而非 120s 的 _OP_TIMEOUT——一个配错的不让用户干等两分钟。"""
    assert mc._STATUS_PROBE_TIMEOUT < mc._OP_TIMEOUT
    assert mc._STATUS_PROBE_TIMEOUT <= 15.0
    captured = {}
    monkeypatch.setattr(mc, "_load_mcp_config", lambda **k: {"s": {"command": "x"}})

    async def fake_list_tools(cfg, timeout=mc._OP_TIMEOUT):
        captured["timeout"] = timeout
        return []

    monkeypatch.setattr(mc, "_a_list_tools", fake_list_tools)
    mc.mcp_status(force=True)
    assert captured["timeout"] == mc._STATUS_PROBE_TIMEOUT


def test_mcp_status_disabled_and_misconfigured(monkeypatch):
    """并行路径仍正确处理停用/缺命令的 server（不去真连），与原串行行为一致。"""
    monkeypatch.setattr(
        mc, "_load_mcp_config",
        lambda **k: {"off": {"command": "x", "disabled": True}, "bad": {"args": []}},
    )
    st = {e["name"]: e for e in mc.mcp_status(force=True)}
    assert st["off"]["status"] == "disabled" and st["off"]["disabled"] is True
    assert st["bad"]["status"] == "misconfigured"
