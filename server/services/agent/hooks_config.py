"""配置驱动 Hooks —— 对标 Claude Code 的 settings.json hooks（command 类型 · Pre/Post/Stop）。

让用户在 `.claude/settings.json` 写"以后每次 X 就跑命令 Y"（模型本身无法承诺的自动化）。

契约（与 Claude Code 一致）：
  settings.json: {"hooks": {"PreToolUse": [{"matcher":"run_command|Write|*",
                  "hooks":[{"type":"command","command":"..."}]}], "PostToolUse":[...], "Stop":[...]}}
  钩子命令 stdin 收 JSON：{hook_event_name, tool_name, tool_input?, tool_response?}
  钩子 stdout 可回 {"decision":"block","reason":..} 或 **退出码 2** → 阻断（Pre 拦工具 / Stop 拦停止让继续）。
启用：仅当 env `DESKTOP_CONFIG_HOOKS=1`（产品桌面端开；测试默认不开 → 零干扰）。
来源：`~/.claude/settings.json` + 项目 `.claude/settings.json` + `DESKTOP_LIBRARY_DIR/settings.json`。
"""
import fnmatch
import json
import os
import subprocess
from pathlib import Path

from services.agent.hooks import (
    register_event_hook, register_post_tool_hook, register_pre_tool_hook, register_stop_hook,
)


def _settings_paths() -> list[Path]:
    paths = [Path.home() / ".claude" / "settings.json", Path.cwd() / ".claude" / "settings.json"]
    lib = os.environ.get("DESKTOP_LIBRARY_DIR")
    if lib:
        paths.append(Path(lib) / "settings.json")
    return paths


def _load_hooks_config(paths=None) -> dict:
    merged: dict = {}
    for p in (paths or _settings_paths()):
        try:
            if Path(p).is_file():
                data = json.loads(Path(p).read_text(encoding="utf-8"))
                for event, matchers in (data.get("hooks") or {}).items():
                    if isinstance(matchers, list):
                        merged.setdefault(event, []).extend(matchers)
        except Exception:
            continue
    return merged


def _matches(matcher: str, tool_name: str) -> bool:
    m = (matcher or "").strip()
    if not m or m == "*":
        return True
    for part in m.split("|"):
        part = part.strip()
        if part and (part == tool_name or fnmatch.fnmatch(tool_name or "", part)):
            return True
    return False


def _run_command_hook(command: str, payload: dict, timeout: float = 20.0) -> tuple[bool, str]:
    """跑一个 command 钩子，返回 (blocked, message)。故障安全：异常不阻断。"""
    try:
        r = subprocess.run(
            ["bash", "-c", command], input=json.dumps(payload, ensure_ascii=False),
            capture_output=True, text=True, timeout=timeout,
        )
    except Exception:
        return False, ""
    if r.returncode == 2:
        return True, (r.stderr or r.stdout or "被 hook 拦截").strip()
    out = (r.stdout or "").strip()
    if out:
        try:
            j = json.loads(out)
            if isinstance(j, dict) and j.get("decision") == "block":
                return True, str(j.get("reason") or "被 hook 拦截")
        except Exception:
            pass
    return False, ""


def _run_event_command_hook(command: str, payload: dict, timeout: float = 20.0):
    """事件钩子：返回 (block_msg|None, context|None)。退出码2/JSON block→拦截；stdout 文本/additionalContext→注入。"""
    try:
        r = subprocess.run(["bash", "-c", command], input=json.dumps(payload, ensure_ascii=False),
                           capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None, None
    if r.returncode == 2:
        return (r.stderr or r.stdout or "被 hook 拦截").strip(), None
    out = (r.stdout or "").strip()
    if not out:
        return None, None
    try:
        j = json.loads(out)
        if isinstance(j, dict):
            if j.get("decision") == "block":
                return str(j.get("reason") or "被 hook 拦截"), None
            ctx = (j.get("hookSpecificOutput") or {}).get("additionalContext") or j.get("additionalContext")
            return None, (str(ctx) if ctx else None)
    except Exception:
        pass
    return None, out


def _iter_commands(matchers: list, tool_name: str):
    for matcher in matchers:
        if not isinstance(matcher, dict):
            continue
        if not _matches(matcher.get("matcher", ""), tool_name):
            continue
        for h in (matcher.get("hooks") or []):
            if isinstance(h, dict) and h.get("type") == "command" and h.get("command"):
                yield h["command"]


def install_config_hooks(force: bool = False) -> int:
    """读 settings.json 的 hooks，注册成 Pre/Post/Stop 回调。返回注册的事件钩子数。
    仅当 DESKTOP_CONFIG_HOOKS=1（或 force=True）才启用——避免测试/非桌面环境误装。"""
    if not force and os.environ.get("DESKTOP_CONFIG_HOOKS") != "1":
        return 0
    cfg = _load_hooks_config()
    count = 0

    pre = cfg.get("PreToolUse") or []
    if pre:
        async def _pre(tool_name, args, ctx, _m=pre):
            import asyncio
            for cmd in _iter_commands(_m, tool_name):
                blocked, msg = await asyncio.to_thread(
                    _run_command_hook, cmd,
                    {"hook_event_name": "PreToolUse", "tool_name": tool_name, "tool_input": args})
                if blocked:
                    return {"deny": msg}
            return None
        register_pre_tool_hook(_pre)
        count += 1

    post = cfg.get("PostToolUse") or []
    if post:
        async def _post(tool_name, args, result, ctx, _m=post):
            import asyncio
            for cmd in _iter_commands(_m, tool_name):
                await asyncio.to_thread(
                    _run_command_hook, cmd,
                    {"hook_event_name": "PostToolUse", "tool_name": tool_name,
                     "tool_input": args, "tool_response": result})
        register_post_tool_hook(_post)
        count += 1

    stop = cfg.get("Stop") or []
    if stop:
        async def _stop(messages, ctx, _m=stop):
            import asyncio
            for cmd in _iter_commands(_m, ""):
                blocked, msg = await asyncio.to_thread(
                    _run_command_hook, cmd, {"hook_event_name": "Stop"})
                if blocked:
                    return {"continue": msg}
            return None
        register_stop_hook(_stop)
        count += 1

    for event in ("UserPromptSubmit", "SessionStart"):
        matchers = cfg.get(event) or []
        if not matchers:
            continue

        def _make_event(_event, _m):
            async def _ev(payload):
                import asyncio
                for cmd in _iter_commands(_m, ""):
                    block, ctx = await asyncio.to_thread(
                        _run_event_command_hook, cmd, {"hook_event_name": _event, **payload})
                    if block:
                        return {"block": block}
                    if ctx:
                        return {"context": ctx}
                return None
            return _ev

        register_event_hook(event, _make_event(event, matchers))
        count += 1

    return count
