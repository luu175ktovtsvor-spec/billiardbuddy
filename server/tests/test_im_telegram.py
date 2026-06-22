"""Telegram IM 适配测试：允许名单 / 更新解析 / 路由 / IM 安全工具集。"""
import asyncio

from services.agent import im_telegram as tg


def test_allowed():
    assert tg._allowed(123, set())          # 空名单=全允许
    assert tg._allowed(123, {"123"})
    assert not tg._allowed(999, {"123"})


def test_get_updates_parsing(monkeypatch):
    monkeypatch.setattr(tg, "_api_call", lambda token, method, params=None, timeout=35: {
        "ok": True, "result": [
            {"update_id": 5, "message": {"text": "hi", "chat": {"id": 1}}},
            {"update_id": 6, "message": {"text": "yo", "chat": {"id": 1}}},
        ]})
    updates, offset = tg.get_updates("t", 0)
    assert len(updates) == 2
    assert offset == 7  # max(update_id)+1


def test_get_updates_error(monkeypatch):
    monkeypatch.setattr(tg, "_api_call", lambda *a, **k: {"ok": False})
    updates, offset = tg.get_updates("t", 3)
    assert updates == [] and offset == 3


async def _runner_ok(text):
    return f"回:{text}"


def test_handle_update_routes(monkeypatch):
    sent = {}
    monkeypatch.setattr(tg, "send_message", lambda token, chat_id, text: sent.update(chat=chat_id, text=text))
    asyncio.run(tg.handle_update({"message": {"text": "hello", "chat": {"id": 42}}}, "t", set(), _runner_ok))
    assert sent["chat"] == 42
    assert "回:hello" in sent["text"]


def test_handle_update_blocks_unallowed(monkeypatch):
    sent = {}
    monkeypatch.setattr(tg, "send_message", lambda token, chat_id, text: sent.update(x=1))
    asyncio.run(tg.handle_update({"message": {"text": "hi", "chat": {"id": 999}}}, "t", {"42"}, _runner_ok))
    assert "x" not in sent  # 不在名单 → 不回


def test_handle_update_ignores_non_text(monkeypatch):
    sent = {}
    monkeypatch.setattr(tg, "send_message", lambda token, chat_id, text: sent.update(x=1))
    asyncio.run(tg.handle_update({"message": {"chat": {"id": 42}}}, "t", set(), _runner_ok))
    assert "x" not in sent


def test_webhook_forbidden_without_secret(monkeypatch):
    monkeypatch.delenv("IM_WEBHOOK_SECRET", raising=False)
    status, _ = asyncio.run(tg.handle_im_webhook("hi", "anything"))
    assert status == 403


def test_webhook_ok_with_secret(monkeypatch):
    monkeypatch.setenv("IM_WEBHOOK_SECRET", "s3cret")

    async def fake_runner(text):
        return f"reply:{text}"

    monkeypatch.setattr(tg, "_run_agent_for_im", fake_runner)
    status, body = asyncio.run(tg.handle_im_webhook("hello", "s3cret"))
    assert status == 200 and body["reply"] == "reply:hello"


def test_webhook_wrong_secret(monkeypatch):
    monkeypatch.setenv("IM_WEBHOOK_SECRET", "s3cret")
    status, _ = asyncio.run(tg.handle_im_webhook("hi", "wrong"))
    assert status == 403


def test_im_safe_registry_excludes_side_effects():
    reg = tg._im_safe_registry()
    names = set(reg.names())
    assert "web_search" in names          # 只读保留
    assert "run_subagent" in names        # 只读保留
    assert "run_command" not in names     # 跑命令排除
    assert "computer_control" not in names
    assert "run_background" not in names
