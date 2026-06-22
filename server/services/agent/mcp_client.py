"""MCP (Model Context Protocol) 客户端 —— 最小实现（stdio JSON-RPC，不引第三方 SDK）。

连接外部 MCP server，把其 tools 暴露给 Agent（命名 `mcp__<server>__<tool>`，缓存稳定排序保前缀缓存）。
- 配置：`.mcp.json`（`{"mcpServers": {"<name>": {"command":.., "args":[..], "env":{..}}}}`），
  来源 `<cwd>/.mcp.json` + `~/.claude/mcp.json` + `DESKTOP_LIBRARY_DIR/.mcp.json`（先出现者优先）。
- v1：每次操作 spawn server → initialize → (list/call) → close（无长连接/生命周期管理，简单稳；
  长连接优化留后）。tools/list 结果缓存；tools/call 每次新起进程。
- 安全：MCP 工具按 `annotations.readOnlyHint` 分级——只读→免确认；否则 requires_approval（走审批闸）。
- 平台：stdio 读用 select 做超时（Unix/macOS）。Windows 管道 select 受限，留后用线程兜。
"""
import json
import os
import select
import subprocess
import time
from pathlib import Path

from services.agent.registry import Tool

_PROTO = "2024-11-05"


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
    """一次性 stdio 会话：spawn → initialize → (list_tools / call_tool) → close。"""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.proc: subprocess.Popen | None = None
        self._id = 0

    def __enter__(self):
        command = self.cfg.get("command")
        if not command:
            raise RuntimeError("MCP 配置缺少 command")
        args = self.cfg.get("args") or []
        env = {**os.environ, **(self.cfg.get("env") or {})}
        self.proc = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, env=env, bufsize=1,
        )
        # initialize 给足超时：npx / uvx 类服务首启要现下载包（首次几十秒），20s 不够会"初始化超时"。
        self._request("initialize", {
            "protocolVersion": _PROTO, "capabilities": {},
            "clientInfo": {"name": "billiards-desktop", "version": "1.0"},
        }, timeout=90.0)
        self._notify("notifications/initialized", {})
        return self

    def __exit__(self, *_a):
        try:
            if self.proc:
                if self.proc.stdin:
                    self.proc.stdin.close()
                self.proc.terminate()
                self.proc.wait(timeout=3)
        except Exception:
            try:
                if self.proc:
                    self.proc.kill()
            except Exception:
                pass

    def _send(self, obj: dict):
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def _notify(self, method: str, params: dict):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _request(self, method: str, params: dict, timeout: float = 20.0) -> dict:
        assert self.proc and self.proc.stdout
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"MCP 请求超时（{method}）")
            try:
                r, _, _ = select.select([self.proc.stdout], [], [], remaining)
                if not r:
                    raise RuntimeError(f"MCP 请求超时（{method}）")
            except (OSError, ValueError):
                pass  # 平台不支持 select(pipe)：退回阻塞 readline
            line = self.proc.stdout.readline()
            if line == "":
                raise RuntimeError("MCP server 已退出/无响应")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") == rid:
                if msg.get("error"):
                    raise RuntimeError(str(msg["error"]))
                return msg.get("result") or {}
            # 其它 id / 通知：忽略，继续读

    def list_tools(self) -> list[dict]:
        return self._request("tools/list", {}).get("tools") or []

    def call_tool(self, name: str, arguments: dict) -> str:
        res = self._request("tools/call", {"name": name, "arguments": arguments or {}})
        parts = []
        for c in (res.get("content") or []):
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text") or "")
            else:
                parts.append(json.dumps(c, ensure_ascii=False))
        out = "\n".join(parts).strip()
        if res.get("isError"):
            return f"[MCP 工具出错] {out}"
        return out or "(无输出)"


def _make_mcp_tool(server_name: str, cfg: dict, t: dict) -> Tool:
    tool_name = f"mcp__{server_name}__{t.get('name')}"
    desc = (t.get("description") or f"MCP 工具 {t.get('name')}").strip()
    schema = t.get("inputSchema") or {"type": "object", "properties": {}}
    ann = t.get("annotations") or {}
    read_only = bool(ann.get("readOnlyHint"))
    raw_name = t.get("name")

    async def handler(args, ctx, _cfg=cfg, _tn=raw_name):
        import asyncio

        def _call():
            with _StdioMCP(_cfg) as s:
                return s.call_tool(_tn, args or {})

        try:
            return await asyncio.to_thread(_call)
        except Exception as e:  # noqa: BLE001
            return f"[MCP 调用失败] {e}"

    return Tool(
        name=tool_name, description=f"[MCP·{server_name}] {desc}", parameters=schema, handler=handler,
        read_only=read_only, requires_approval=(not read_only), approval_class="spend",
    )


_cached_tools: list[Tool] | None = None


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


def mcp_status() -> list[dict]:
    """各 MCP server 的连接状态 + 工具数（供前端 /mcp 展示）。"""
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
    return items
