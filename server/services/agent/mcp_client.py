"""MCP (Model Context Protocol) 客户端 —— 基于官方 `mcp` SDK（stdio 传输）。

连接外部 MCP server，把其 tools 暴露给 Agent（命名 `mcp__<server>__<tool>`，缓存稳定排序保前缀缓存）。
- 配置：`.mcp.json`（`{"mcpServers": {"<name>": {"command":.., "args":[..], "env":{..}}}}`），
  来源同下 `_load_mcp_config`（桌面只读门店库；非桌面读 cwd + ~/.claude）。
- 每次操作起一次 stdio 会话 → initialize → (list/call) → 关（无长连接/生命周期管理，简单稳；
  SDK 的 `stdio_client` + `ClientSession` 负责协议握手/版本协商/通知）。tools/list 结果缓存。
- 安全：MCP 工具按 `annotations.readOnlyHint` 分级——只读→免确认；否则 requires_approval（走审批闸）。
- 异步桥：SDK 全异步；对外仍保留同步的 `_StdioMCP`/`load_mcp_tools`/`mcp_status`，
  内部用 `_run_async`（独立线程跑一个新事件循环）兜住"可能已在事件循环里被调用"的场景。
"""
import asyncio
import json
import os
import threading
import time
from datetime import timedelta
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from services.agent.registry import Tool

_OP_TIMEOUT = 120.0  # 单次会话总超时（含 npx/uvx 首启现下载包的冷启动）


def _server_params(cfg: dict) -> StdioServerParameters:
    return StdioServerParameters(
        command=cfg["command"],
        args=cfg.get("args") or [],
        env={**os.environ, **(cfg.get("env") or {})},
    )


def _run_async(coro_factory):
    """在独立线程的新事件循环里把协程跑完——无论调用方是否已在事件循环中都安全。

    coro_factory 是「返回一个新协程的函数」（协程必须在目标循环里创建，故传工厂而非协程对象）。"""
    box: dict = {}

    def _runner():
        try:
            box["v"] = asyncio.run(coro_factory())
        except Exception as e:  # noqa: BLE001
            box["e"] = e

    th = threading.Thread(target=_runner, daemon=True)
    th.start()
    th.join()
    if "e" in box:
        raise box["e"]
    return box.get("v")


async def _a_list_tools(cfg: dict) -> list[dict]:
    async def _go():
        async with stdio_client(_server_params(cfg)) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                res = await session.list_tools()
                return [t.model_dump(by_alias=True, exclude_none=True) for t in res.tools]
    return await asyncio.wait_for(_go(), timeout=_OP_TIMEOUT)


def _format_call_result(res) -> str:
    parts = []
    for c in (res.content or []):
        if getattr(c, "type", None) == "text":
            parts.append(c.text or "")
        else:
            parts.append(json.dumps(c.model_dump(by_alias=True, exclude_none=True), ensure_ascii=False))
    out = "\n".join(parts).strip()
    if getattr(res, "isError", False):
        return f"[MCP 工具出错] {out}"
    return out or "(无输出)"


async def _a_call_tool(cfg: dict, name: str, arguments: dict) -> str:
    async def _go():
        async with stdio_client(_server_params(cfg)) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                res = await session.call_tool(name, arguments or {})
                return _format_call_result(res)
    return await asyncio.wait_for(_go(), timeout=_OP_TIMEOUT)


def _load_mcp_config() -> dict:
    """合并各处 .mcp.json 的 mcpServers（先出现者优先）。"""
    servers: dict = {}
    lib = os.environ.get("DESKTOP_LIBRARY_DIR")
    # 桌面产品【绝不扫 ~/.claude/】：那是开发者私有配置。只读门店自己库里的 .mcp.json（店主自配 MCP）。
    if os.environ.get("DESKTOP_LOCAL") == "1":
        base = Path(lib) if lib else (Path.home() / ".billiards-desktop" / "library")
        paths = [base / ".mcp.json"]
    else:
        paths = [Path.cwd() / ".mcp.json", Path.home() / ".claude" / "mcp.json"]
        if lib:
            paths.append(Path(lib) / ".mcp.json")
    for p in paths:
        try:
            if p.is_file():
                data = json.loads(p.read_text(encoding="utf-8"))
                for name, cfg in (data.get("mcpServers") or {}).items():
                    # 老板在界面停用的 server 标了 disabled:true → 跳过（不连、不发现工具），但配置仍留着可一键开回。
                    if isinstance(cfg, dict) and not cfg.get("disabled"):
                        servers.setdefault(name, cfg)
        except Exception:
            continue
    # 启用插件提供的 MCP server（自动并入工具池 + /mcp 列表）
    try:
        from services.agent import plugins as _plugins
        for name, cfg in _plugins.plugin_mcp_servers().items():
            servers.setdefault(name, cfg)
    except Exception:
        pass
    return servers


class _StdioMCP:
    """同步门面：保留旧接口（`with _StdioMCP(cfg) as s: s.list_tools()/s.call_tool()`）。

    每个方法各起一次 SDK stdio 会话（initialize→操作→关），内部经 `_run_async` 在新循环里跑，
    故无论调用方是否已在事件循环中都安全。command 缺失立即报错（与旧行为一致）。"""

    def __init__(self, cfg: dict):
        if not cfg.get("command"):
            raise RuntimeError("MCP 配置缺少 command")
        self.cfg = cfg

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def list_tools(self) -> list[dict]:
        return _run_async(lambda: _a_list_tools(self.cfg))

    def call_tool(self, name: str, arguments: dict) -> str:
        return _run_async(lambda: _a_call_tool(self.cfg, name, arguments or {}))


def _make_mcp_tool(server_name: str, cfg: dict, t: dict) -> Tool:
    tool_name = f"mcp__{server_name}__{t.get('name')}"
    desc = (t.get("description") or f"MCP 工具 {t.get('name')}").strip()
    schema = t.get("inputSchema") or {"type": "object", "properties": {}}
    ann = t.get("annotations") or {}
    read_only = bool(ann.get("readOnlyHint"))
    raw_name = t.get("name")

    async def handler(args, ctx, _cfg=cfg, _tn=raw_name):
        # handler 本就在 agent 事件循环里被 await——SDK 异步调用直接 await（stdio_client 走 anyio/asyncio 后端）。
        try:
            return await _a_call_tool(_cfg, _tn, args or {})
        except Exception as e:  # noqa: BLE001
            return f"[MCP 调用失败] {e}"

    return Tool(
        name=tool_name, description=f"[MCP·{server_name}] {desc}", parameters=schema, handler=handler,
        read_only=read_only, requires_approval=(not read_only), approval_class="spend",
    )


_cached_tools: list[Tool] | None = None
# MCP 状态缓存：每次冷拉要 spawn npx/uvx 跟每个 server 握手（5 个 server ≈ 9s）。设置页"外接工具"反复打开
# 不该每次都重握手 → 短 TTL 缓存（默认 30s）。配置变更（add/remove）即失效，手动 refresh 也能强刷。
_STATUS_TTL = 30.0
_status_cache: tuple[float, list[dict]] | None = None


def invalidate_mcp_cache() -> None:
    """配置变更后清空工具 + 状态缓存，下次取即重握手（add/remove server 后调）。"""
    global _cached_tools, _status_cache
    _cached_tools = None
    _status_cache = None


def load_mcp_tools(force: bool = False) -> list[Tool]:
    """发现所有已配置 MCP server 的工具，包成我们的 Tool。结果缓存（spawn 开销大）。"""
    global _cached_tools
    if _cached_tools is not None and not force:
        return _cached_tools
    out: list[Tool] = []
    for name, cfg in _load_mcp_config().items():
        if not cfg.get("command"):
            continue
        try:
            with _StdioMCP(cfg) as s:
                for t in s.list_tools():
                    if t.get("name"):
                        out.append(_make_mcp_tool(name, cfg, t))
        except Exception:
            continue
    out.sort(key=lambda t: t.name)  # 稳定排序，保前缀缓存
    _cached_tools = out
    return out


def mcp_status(force: bool = False) -> list[dict]:
    """各 MCP server 的连接状态 + 工具数（供前端 /mcp 展示）。短 TTL 缓存：避免设置页反复打开每次都重握手。
    force=True 强制重探（用户手动刷新）；配置变更后由 invalidate_mcp_cache() 失效。"""
    global _status_cache
    if not force and _status_cache is not None and (time.monotonic() - _status_cache[0]) < _STATUS_TTL:
        return _status_cache[1]
    items = []
    for name, cfg in _load_mcp_config().items():
        entry = {"name": name, "command": cfg.get("command", ""), "status": "failed", "tools": 0}
        if not cfg.get("command"):
            entry["status"] = "misconfigured"
            items.append(entry)
            continue
        try:
            with _StdioMCP(cfg) as s:
                entry["tools"] = len(s.list_tools())
                entry["status"] = "connected"
        except Exception as e:  # noqa: BLE001
            entry["status_detail"] = str(e)[:200]
        items.append(entry)
    _status_cache = (time.monotonic(), items)
    return items
