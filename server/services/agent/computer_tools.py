"""Computer Use 工具（桌面专属 DESKTOP_LOCAL=1）—— 让 Agent 操作电脑：看屏 / 点击 / 键入 / 滚动。

对标 Claude Code 的 computer 工具。执行借本机 pyautogui + osascript（经独立 python 子进程调用，
复用其已授予的「辅助功能 / 屏幕录制」权限），**不给 server 加依赖**。
  - `DESKTOP_COMPUTER_PYTHON` 可覆盖；默认走 desktop-control skill 的 venv。

安全分级：
  - `computer_view`（截屏 / 屏幕信息）= 只读，免确认。
  - `computer_control`（点击 / 键入 / 滚动 / 移动 / 热键）= 操作真机，requires_approval + **force_confirm**
    （任何权限模式都先弹确认，永不被旁路——操作真实鼠标键盘有后果）。
"""
import json
import os
import subprocess
import uuid
from pathlib import Path

from services import notify_service
from services.agent.registry import tool


def _computer_python() -> str | None:
    p = os.environ.get("DESKTOP_COMPUTER_PYTHON") or str(
        Path.home() / ".claude" / "skills" / "desktop-control" / ".venv" / "bin" / "python3"
    )
    return p if Path(p).exists() else None


def _run_py(code: str, timeout: int = 20) -> tuple[str | None, str | None]:
    """跑一段 pyautogui 代码，返回 (stdout, err)。err 非空=失败。"""
    py = _computer_python()
    if not py:
        return None, "没找到可用的桌面控制运行环境（pyautogui）。请装好 desktop-control，或设 DESKTOP_COMPUTER_PYTHON。"
    try:
        r = subprocess.run([py, "-c", code], capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            return None, (r.stderr or r.stdout or "执行失败").strip()
        return (r.stdout or "").strip(), None
    except subprocess.TimeoutExpired:
        return None, "操作超时"
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def _frontmost_app() -> str:
    try:
        r = subprocess.run(
            ["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
            capture_output=True, text=True, timeout=8,
        )
        return (r.stdout or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _screenshot_dir() -> Path:
    base = os.environ.get("UPLOAD_DIR") or str(Path.home() / ".billiards-desktop" / "uploads")
    d = Path(base) / "computer"
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _view_handler(args: dict, ctx) -> str:
    action = str(args.get("action") or "screenshot").strip()
    if action == "screen_info":
        out, err = _run_py("import pyautogui; s=pyautogui.size(); print(f'{s.width}x{s.height}')")
        if err:
            return f"[看屏失败] {err}"
        app = _frontmost_app()
        return f"屏幕分辨率：{out}" + (f"；当前前台应用：{app}" if app else "")
    # default = screenshot
    path = _screenshot_dir() / f"{uuid.uuid4().hex}.png"
    out, err = _run_py(f"import pyautogui; pyautogui.screenshot().save({str(path)!r})")
    if err:
        return f"[截屏失败] {err}"
    # 把截图路径挂给 loop：本批 tool 结果追加完后会拼成一条 user 图片消息回灌，让我下一轮真【看见】这张屏。
    pending = getattr(ctx, "pending_view_images", None)
    if pending is not None:
        try:
            pending.append(str(path))
        except Exception:
            pass
    return f"已截屏并保存：{path}（图已附给我，下一步我会据此画面继续）"


async def _control_handler(args: dict, ctx) -> str:
    action = str(args.get("action") or "").strip()
    if action in ("click", "double_click", "right_click", "move"):
        x, y = args.get("x"), args.get("y")
        if x is None or y is None:
            return "[参数缺失] 该动作需要 x, y 坐标"
        try:
            x, y = int(x), int(y)
        except (TypeError, ValueError):
            return "[参数错误] x, y 必须是数字"
        fn = {"click": "click", "double_click": "doubleClick", "right_click": "rightClick", "move": "moveTo"}[action]
        out, err = _run_py(f"import pyautogui; pyautogui.{fn}({x},{y})")
    elif action == "type":
        text = str(args.get("text") or "")
        if not text:
            return "[参数缺失] type 动作需要 text"
        out, err = _run_py(f"import pyautogui; pyautogui.write({json.dumps(text)})")
    elif action == "key":
        keys = str(args.get("keys") or "")
        parts = [k.strip() for k in keys.split(",") if k.strip()]
        if not parts:
            return "[参数缺失] key 动作需要 keys（如 'enter' 或 'command,c'）"
        if len(parts) > 1:
            out, err = _run_py(f"import pyautogui; pyautogui.hotkey(*{json.dumps(parts)})")
        else:
            out, err = _run_py(f"import pyautogui; pyautogui.press({json.dumps(parts[0])})")
    elif action == "scroll":
        try:
            amount = int(args.get("amount") or -3)
        except (TypeError, ValueError):
            amount = -3
        out, err = _run_py(f"import pyautogui; pyautogui.scroll({amount})")
    else:
        return f"[不支持的动作] {action}（支持 click/double_click/right_click/move/type/key/scroll）"
    if err:
        return f"[操作失败] {err}"
    return f"已执行：{action}"


async def _notify_handler(args: dict, ctx) -> str:
    title = str(args.get("title") or "台球运营管家")
    message = str(args.get("message") or "")
    if not message:
        return "[参数缺失] notify 需要 message"
    # F1b：归一到通知中心（跨平台，Electron 侧轮询转发成真系统通知），不再直连 osascript
    # （旧实现 mac-only，Windows 装机包上静默失败）。push() 故障安全，这里不需要再包 try/except。
    notify_service.push(title, message, kind="agent_notify")
    return f"已通知老板：{message}"


_VIEW_PARAMS = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["screenshot", "screen_info"], "description": "screenshot=截屏；screen_info=屏幕分辨率+前台应用"},
    },
}
_CONTROL_PARAMS = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["click", "double_click", "right_click", "move", "type", "key", "scroll"], "description": "要执行的操作"},
        "x": {"type": "integer", "description": "点击/移动的横坐标（像素）"},
        "y": {"type": "integer", "description": "点击/移动的纵坐标（像素）"},
        "text": {"type": "string", "description": "type 动作要输入的文字"},
        "keys": {"type": "string", "description": "key 动作的按键，单键如 'enter'，组合键逗号分隔如 'command,c'"},
        "amount": {"type": "integer", "description": "scroll 滚动量（负=下，正=上）"},
    },
    "required": ["action"],
}

# 仅桌面全本地模式注册（云端 web 版不设 DESKTOP_LOCAL → 拿不到操作电脑能力）
if os.environ.get("DESKTOP_LOCAL") == "1":
    tool(
        name="computer_view",
        description="看电脑屏幕：截屏（save 到本地）或获取屏幕分辨率/当前前台应用。只读、不操作鼠标键盘。",
        parameters=_VIEW_PARAMS,
        read_only=True,
        # F-7 复审：⚠️ 不标 concurrent_safe——截屏动作会 `pending.append(str(path))` 写
        # ctx.pending_view_images（跨工具共享的可变列表），出于 fail-safe 保守不纳入并发组。
    )(_view_handler)
    tool(
        name="computer_control",
        description="操作电脑：在指定坐标点击/双击/右键/移动鼠标、键入文字、按键或热键、滚动。会先弹确认再执行。",
        parameters=_CONTROL_PARAMS,
        requires_approval=True,
        force_confirm=True,
        approval_class="spend",
    )(_control_handler)
    tool(
        name="notify",
        description="弹一条系统通知给老板（比如长任务完成时提醒）。",
        parameters={"type": "object", "properties": {
            "title": {"type": "string", "description": "通知标题（可选）"},
            "message": {"type": "string", "description": "通知内容"},
        }, "required": ["message"]},
    )(_notify_handler)
