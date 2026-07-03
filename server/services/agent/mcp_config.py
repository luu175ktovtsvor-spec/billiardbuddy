"""门店 .mcp.json 的读/写（增删启停）—— 给非技术老板用界面管 MCP server。

只动 `DESKTOP_LIBRARY_DIR/.mcp.json`（门店自己的库，绝不碰 ~/.claude/）。所有写操作：
- 原子写（先写 .tmp 再 os.replace，避免半截文件）；
- 故障安全（读坏文件当空配置，不崩）；
- 库内（写之前确保库目录存在）。

`mcp_client.py` 负责"扫 .mcp.json → 连 server → 发现工具"；本模块只负责"老板在界面上加/删/停某个 server"
落到同一个 .mcp.json 上，两边读的是同一份文件，所以改完下次对话即生效。

停用：往 server 配置里写 `"disabled": true`；mcp_client 的 `_load_mcp_config` 会跳过它（见该文件过滤）。
"""
import json
import os
from pathlib import Path

# 免 key / 免费的官方 MCP server 预设：老板点一下就加，不用懂命令行。
# 命令参照官方 modelcontextprotocol/servers 仓库（Python 系用 uvx，Node 系用 npx）。
#
# A2(2026-07-03)：出厂预设已清空。原先的 fetch/time/ddg 三条与内置工具重复（本项目已有内置网页
# 抓取工具、模型自带时间感知、内置联网搜索工具），一键装上只是白白多一份下载和维护负担，对小白
# 老板没有增量价值。memory 此前也因为和「店脑记忆」打架被移除（见下方历史注释）。
# 机制本身（add_server/list_servers/.mcp.json 读写）原样保留，老板仍可在界面「自己加」手动配置
# 任意 MCP server；未来如果真有值得推荐的免 key 预设，往这个列表里加回即可。
MCP_PRESETS: list[dict] = [
    # 注意：故意不预设 @modelcontextprotocol/server-memory。它是和「店脑记忆」竞争、且不互通的
    # 第二套记忆系统（各记各的、各注入各的），一键装上只会让老板困惑、两套记忆打架。
    # 老板真要它仍可在界面手动添加（add_server），但出厂预设不主动推它。
]


def _mcp_json_path() -> Path:
    """门店库里的 .mcp.json 路径（与 mcp_client._load_mcp_config 桌面分支同一处）。"""
    lib = os.environ.get("DESKTOP_LIBRARY_DIR")
    base = Path(lib) if lib else (Path.home() / ".billiards-desktop" / "library")
    return base / ".mcp.json"


def _read_doc() -> dict:
    """读 .mcp.json 整个文档。文件不存在/读坏 → 当空配置（故障安全，不崩）。"""
    p = _mcp_json_path()
    try:
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                if not isinstance(data.get("mcpServers"), dict):
                    data["mcpServers"] = {}
                return data
    except Exception:
        pass
    return {"mcpServers": {}}


def _atomic_write(doc: dict) -> None:
    """原子写回：先写同目录 .tmp、fsync，再 os.replace 顶替（避免被读到半截 JSON）。"""
    p = _mcp_json_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)


def list_servers() -> list[dict]:
    """列出 .mcp.json 里已配置的 server（名/命令/参数/是否停用）。供界面展示，不触网。
    连接状态/工具数由 mcp_client.mcp_status() 另外给（要真连一下才知道）。"""
    doc = _read_doc()
    out: list[dict] = []
    for name, cfg in (doc.get("mcpServers") or {}).items():
        if not isinstance(cfg, dict):
            continue
        out.append({
            "name": name,
            "command": str(cfg.get("command") or ""),
            "args": list(cfg.get("args") or []),
            "disabled": bool(cfg.get("disabled", False)),
        })
    out.sort(key=lambda x: x["name"])
    return out


def add_server(name: str, command: str, args: list[str] | None = None,
               env: dict | None = None) -> tuple[bool, str]:
    """加/覆盖一个 MCP server。返回 (ok, message)。名字/命令必填。"""
    name = (name or "").strip()
    command = (command or "").strip()
    if not name:
        return False, "请先给这个 MCP 起个名字（随便取，方便你自己认）。"
    if not command:
        return False, "命令不能为空（比如 npx 或 uvx）。"
    cfg: dict = {"command": command, "args": [str(a) for a in (args or []) if str(a).strip()]}
    if env and isinstance(env, dict):
        cfg["env"] = {str(k): str(v) for k, v in env.items()}
    doc = _read_doc()
    existed = name in doc["mcpServers"]
    doc["mcpServers"][name] = cfg
    try:
        _atomic_write(doc)
    except Exception as e:  # noqa: BLE001
        return False, f"保存没成功：{e}"
    return True, (f"已更新「{name}」" if existed else f"已加上「{name}」，下次对话就能用了。")


def remove_server(name: str) -> tuple[bool, str]:
    """删掉一个 MCP server。返回 (ok, message)。"""
    name = (name or "").strip()
    if not name:
        return False, "没说要删哪个。"
    doc = _read_doc()
    if name not in doc["mcpServers"]:
        return False, f"没找到「{name}」，可能已经删过了。"
    doc["mcpServers"].pop(name, None)
    try:
        _atomic_write(doc)
    except Exception as e:  # noqa: BLE001
        return False, f"删除没成功：{e}"
    return True, f"已删掉「{name}」。"


def set_server_disabled(name: str, disabled: bool) -> tuple[bool, str]:
    """启用/停用一个 server（写 disabled 标记，不删配置——以后想用一键开回来）。"""
    name = (name or "").strip()
    if not name:
        return False, "没说要操作哪个。"
    doc = _read_doc()
    cfg = doc["mcpServers"].get(name)
    if not isinstance(cfg, dict):
        return False, f"没找到「{name}」。"
    if disabled:
        cfg["disabled"] = True
    else:
        cfg.pop("disabled", None)
    try:
        _atomic_write(doc)
    except Exception as e:  # noqa: BLE001
        return False, f"保存没成功：{e}"
    return True, (f"已停用「{name}」" if disabled else f"已启用「{name}」")
