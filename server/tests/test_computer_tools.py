"""Computer Use 工具测试（看屏/操作分级 + 参数校验 + 故障安全）。"""
import asyncio

from services.agent import computer_tools as ct


def _run(coro):
    return asyncio.run(coro)


def test_screen_info(monkeypatch):
    async def fake_run_py(code, timeout=20):
        return ("1470x956", None)
    async def fake_frontmost():
        return "Finder"
    monkeypatch.setattr(ct, "_run_py", fake_run_py)
    monkeypatch.setattr(ct, "_frontmost_app", fake_frontmost)
    out = _run(ct._view_handler({"action": "screen_info"}, ctx=None))
    assert "1470x956" in out
    assert "Finder" in out


def test_screenshot(monkeypatch, tmp_path):
    async def fake_run_py(code, timeout=20):
        return ("", None)
    monkeypatch.setattr(ct, "_screenshot_dir", lambda: tmp_path)
    monkeypatch.setattr(ct, "_run_py", fake_run_py)
    out = _run(ct._view_handler({"action": "screenshot"}, ctx=None))
    assert "已截屏" in out
    assert ".png" in out


def test_screenshot_failure(monkeypatch, tmp_path):
    async def fake_run_py(code, timeout=20):
        return (None, "权限不足")
    monkeypatch.setattr(ct, "_screenshot_dir", lambda: tmp_path)
    monkeypatch.setattr(ct, "_run_py", fake_run_py)
    out = _run(ct._view_handler({"action": "screenshot"}, ctx=None))
    assert "[截屏失败]" in out and "权限不足" in out


def test_control_click(monkeypatch):
    captured = {}
    async def fake(code, timeout=20):
        captured["code"] = code
        return ("", None)
    monkeypatch.setattr(ct, "_run_py", fake)
    out = _run(ct._control_handler({"action": "click", "x": 100, "y": 200}, ctx=None))
    assert "已执行：click" in out
    assert "click(100,200)" in captured["code"]


def test_control_click_missing_coords():
    out = _run(ct._control_handler({"action": "click"}, ctx=None))
    assert "[参数缺失]" in out


def test_control_type(monkeypatch):
    captured = {}
    async def fake_run_py(code, timeout=20):
        captured["code"] = code
        return ("", None)
    monkeypatch.setattr(ct, "_run_py", fake_run_py)
    out = _run(ct._control_handler({"action": "type", "text": "hello"}, ctx=None))
    assert "已执行：type" in out
    assert "hello" in captured["code"]


def test_control_hotkey(monkeypatch):
    captured = {}
    async def fake_run_py(code, timeout=20):
        captured["code"] = code
        return ("", None)
    monkeypatch.setattr(ct, "_run_py", fake_run_py)
    out = _run(ct._control_handler({"action": "key", "keys": "command,c"}, ctx=None))
    assert "已执行：key" in out
    assert "hotkey" in captured["code"]


def test_control_unsupported_action():
    out = _run(ct._control_handler({"action": "teleport"}, ctx=None))
    assert "[不支持的动作]" in out


def test_run_py_no_python(monkeypatch):
    monkeypatch.setattr(ct, "_computer_python", lambda: None)
    out, err = _run(ct._run_py("print('x')"))
    assert out is None
    assert "没找到" in err


def test_notify(monkeypatch):
    # F1b：通知归一到 notify_service.push()，不再直连 osascript（mac-only，Windows 静默失败）。
    calls = {}

    def fake_push(title, body, kind="info", **meta):
        calls["title"] = title
        calls["body"] = body
        calls["kind"] = kind

    monkeypatch.setattr(ct.notify_service, "push", fake_push)
    out = _run(ct._notify_handler({"message": "完成了"}, ctx=None))
    assert "已通知老板" in out
    assert calls["body"] == "完成了"
    assert calls["kind"] == "agent_notify"


def test_notify_custom_title(monkeypatch):
    calls = {}
    monkeypatch.setattr(ct.notify_service, "push", lambda title, body, kind="info", **m: calls.update(title=title))
    _run(ct._notify_handler({"title": "老板你好", "message": "有客到店"}, ctx=None))
    assert calls["title"] == "老板你好"


def test_notify_missing_message():
    out = _run(ct._notify_handler({}, ctx=None))
    assert "[参数缺失]" in out
