"""Plugins —— 对标 Claude Code 的插件（把 skills / commands / output-styles / MCP 打包分发）。

v1：本地目录插件。一个插件 = 目录 + `plugin.json`。来源 `~/.claude/plugins` + 项目 `.claude/plugins` + 库。
组件按约定目录：`skills/`、`output-styles/`、`commands/` + `<plugin>/.mcp.json`（或 manifest.mcpServers）。
**已就绪的 skills/output-styles/MCP 加载器会自动并入【启用】插件的同类组件** → 插件技能直接出现在
`/` 命令面板、风格出现在工具条下拉、MCP server 出现在 /mcp 与工具池里（无需新前端）。
启用：`plugin.json` 的 `enabled:false` 才禁用，否则默认启用。
"""
import json
import os
from pathlib import Path


def _plugin_roots() -> list[Path]:
    lib = os.environ.get("DESKTOP_LIBRARY_DIR")
    # 桌面产品【绝不扫 ~/.claude/】：那是开发者私有配置，会把个人插件塞进店主面板。只用门店自己的库。
    if os.environ.get("DESKTOP_LOCAL") == "1":
        base = Path(lib) if lib else (Path.home() / ".billiards-desktop" / "library")
        return [base / "plugins"]
    roots = [Path.home() / ".claude" / "plugins", Path.cwd() / ".claude" / "plugins"]
    if lib:
        roots.append(Path(lib) / "plugins")
    return roots


def discover_plugins(roots=None) -> list[dict]:
    """返回插件列表 [{name, dir, manifest, enabled}]（同名先到先得）。"""
    found: dict[str, dict] = {}
    for root in (roots or _plugin_roots()):
        try:
            if not Path(root).is_dir():
                continue
            for child in sorted(Path(root).iterdir()):
                if not child.is_dir():
                    continue
                manifest = {}
                mf = child / "plugin.json"
                if mf.is_file():
                    try:
                        manifest = json.loads(mf.read_text(encoding="utf-8")) or {}
                    except Exception:
                        manifest = {}
                if not isinstance(manifest, dict):
                    manifest = {}
                name = str(manifest.get("name") or child.name)
                if name in found:
                    continue
                found[name] = {
                    "name": name, "dir": str(child), "manifest": manifest,
                    "enabled": manifest.get("enabled", True) is not False,
                }
        except Exception:
            continue
    return list(found.values())


def _enabled_plugins(roots=None) -> list[dict]:
    return [p for p in discover_plugins(roots) if p["enabled"]]


def plugin_component_dirs(component: str, roots=None) -> list[tuple[str, Path]]:
    """启用插件的某类组件目录 [(source, dir)]，component 如 'skills'/'output-styles'。"""
    out: list[tuple[str, Path]] = []
    for p in _enabled_plugins(roots):
        d = Path(p["dir"]) / component
        if d.is_dir():
            out.append((f"plugin:{p['name']}", d))
    return out


def plugin_mcp_servers(roots=None) -> dict:
    """合并启用插件的 mcpServers（manifest.mcpServers 或 <plugin>/.mcp.json）。"""
    servers: dict = {}
    for p in _enabled_plugins(roots):
        ms = p["manifest"].get("mcpServers")
        if isinstance(ms, dict):
            for n, cfg in ms.items():
                if isinstance(cfg, dict):
                    servers.setdefault(n, cfg)
        mj = Path(p["dir"]) / ".mcp.json"
        if mj.is_file():
            try:
                data = json.loads(mj.read_text(encoding="utf-8"))
                for n, cfg in (data.get("mcpServers") or {}).items():
                    if isinstance(cfg, dict):
                        servers.setdefault(n, cfg)
            except Exception:
                pass
    return servers


def list_plugins(roots=None) -> list[dict]:
    """供前端展示：名字/启用/描述/组件计数。"""
    items = []
    for p in discover_plugins(roots):
        pdir = Path(p["dir"])
        counts = {}
        for comp in ("skills", "commands", "output-styles"):
            d = pdir / comp
            counts[comp] = len([x for x in d.iterdir() if not x.name.startswith(".")]) if d.is_dir() else 0
        counts["mcp"] = 1 if (pdir / ".mcp.json").is_file() or isinstance(p["manifest"].get("mcpServers"), dict) else 0
        items.append({
            "name": p["name"], "enabled": p["enabled"], "dir": p["dir"],
            "description": str(p["manifest"].get("description", "") or ""), "components": counts,
        })
    return items


def _install_dir() -> Path:
    # 必须和 _plugin_roots() 装到同一处，否则桌面版装了发现不了（曾是 bug）。桌面用门店库、不碰 ~/.claude。
    if os.environ.get("DESKTOP_LOCAL") == "1":
        lib = os.environ.get("DESKTOP_LIBRARY_DIR")
        base = Path(lib) if lib else (Path.home() / ".billiards-desktop" / "library")
        return base / "plugins"
    return Path.home() / ".claude" / "plugins"


def install_plugin_from_github(repo: str) -> tuple[bool, str]:
    """从 GitHub 装插件（owner/repo 或 url）：git clone --depth 1 到用户插件目录。返回 (ok, message)。"""
    repo = (repo or "").strip()
    if not repo:
        return False, "没给 repo（owner/repo 或 https url）"
    if repo.startswith("http"):
        url, name = repo, repo.rstrip("/").split("/")[-1].replace(".git", "")
    elif "/" in repo and not repo.startswith("/") and " " not in repo:
        url, name = f"https://github.com/{repo}.git", repo.rstrip("/").split("/")[-1]
    else:
        return False, "格式应为 owner/repo 或 https://... url"
    if not name:
        return False, "解析不出插件名"
    dest = _install_dir() / name
    if dest.exists():
        return False, f"插件目录已存在：{name}（先删了再装）"
    import subprocess
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["git", "clone", "--depth", "1", url, str(dest)],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return False, ("clone 失败：" + (r.stderr or r.stdout or "")).strip()[:300]
        return True, f"已安装插件：{name}（它的技能/风格/MCP 已可用，重开会话生效）"
    except Exception as e:  # noqa: BLE001
        return False, f"安装出错：{e}"


def set_plugin_enabled(name: str, enabled: bool, roots=None) -> tuple[bool, str]:
    """启用/停用一个本地插件：改它的 plugin.json 的 `enabled` 字段。原子写 + 故障安全。返回 (ok, message)。
    停用后该插件的技能/风格/MCP 都不再并入（_enabled_plugins 过滤掉它）。"""
    name = (name or "").strip()
    if not name:
        return False, "没说要操作哪个插件。"
    target = next((p for p in discover_plugins(roots) if p["name"] == name), None)
    if target is None:
        return False, f"没找到插件「{name}」。"
    mf = Path(target["dir"]) / "plugin.json"
    manifest = dict(target.get("manifest") or {})
    manifest["enabled"] = bool(enabled)
    manifest.setdefault("name", name)
    try:
        tmp = mf.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(manifest, ensure_ascii=False, indent=2))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, mf)
    except Exception as e:  # noqa: BLE001
        return False, f"保存没成功：{e}"
    return True, (f"已启用「{name}」（重开会话生效）" if enabled else f"已停用「{name}」")


async def _install_handler(args: dict, ctx) -> str:
    _ok, msg = install_plugin_from_github(str(args.get("repo") or ""))
    return msg


if os.environ.get("DESKTOP_LOCAL") == "1":
    from services.agent.registry import tool
    tool(
        name="install_plugin",
        description="从 GitHub 安装一个插件（owner/repo 或完整 url），git clone 到门店插件库。会先弹确认。",
        parameters={"type": "object", "properties": {
            "repo": {"type": "string", "description": "GitHub owner/repo 或完整 https url"},
        }, "required": ["repo"]},
        requires_approval=True, force_confirm=True, approval_class="spend",
    )(_install_handler)
