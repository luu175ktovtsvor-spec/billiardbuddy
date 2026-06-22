"""定时提醒（Cron-lite）测试：增/列/删 + 到点判定 + 工具入参。"""
import asyncio
from datetime import datetime, timedelta

from services.agent import reminders as rm


def test_add_list_cancel(monkeypatch, tmp_path):
    monkeypatch.setattr(rm, "_store_path", lambda: tmp_path / "r.json")
    item = rm.add_reminder(30, "喝水")
    assert item["id"]
    lst = rm.list_reminders()
    assert len(lst) == 1 and lst[0]["message"] == "喝水"
    assert rm.cancel_reminder(item["id"]) is True
    assert rm.list_reminders() == []
    assert rm.cancel_reminder("nope") is False


def test_due(monkeypatch, tmp_path):
    monkeypatch.setattr(rm, "_store_path", lambda: tmp_path / "r.json")
    rm.add_reminder(10, "future")
    assert rm.due_reminders(datetime.now()) == []  # 还没到
    due = rm.due_reminders(datetime.now() + timedelta(minutes=20))  # 过了
    assert len(due) == 1 and due[0]["message"] == "future"
    assert rm.due_reminders(datetime.now() + timedelta(minutes=20)) == []  # 已 fired 不再触发


def test_schedule_handler(monkeypatch, tmp_path):
    monkeypatch.setattr(rm, "_store_path", lambda: tmp_path / "r.json")
    out = asyncio.run(rm._schedule_handler({"in_minutes": 5, "message": "测试"}, None))
    assert "5" in out and "测试" in out
    assert "[参数缺失]" in asyncio.run(rm._schedule_handler({"message": ""}, None))
    assert "[参数错误]" in asyncio.run(rm._schedule_handler({"in_minutes": "x", "message": "y"}, None))
