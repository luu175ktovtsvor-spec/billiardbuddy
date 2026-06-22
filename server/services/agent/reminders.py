"""定时提醒（Cron-lite）—— 对标 Claude Code 的 ScheduleCron（简化版）。

N 分钟后弹系统通知提醒。落盘 JSON，进程内 loop 每 30s 检查触发。桌面专属 DESKTOP_LOCAL=1。
v1：仅"N 分钟后"相对定时（最简、无时区歧义）；app 关了不触发（in-process）。
"""
import json
import os
import subprocess
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from services.agent.registry import tool


def _store_path() -> Path:
    base = os.environ.get("UPLOAD_DIR") or str(Path.home() / ".billiards-desktop" / "uploads")
    return Path(base) / "reminders.json"


def _load() -> list:
    try:
        p = _store_path()
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else []
    except Exception:
        return []


def _save(items: list) -> None:
    try:
        p = _store_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def add_reminder(in_minutes: float, message: str) -> dict:
    fire_at = (datetime.now() + timedelta(minutes=in_minutes)).isoformat()
    item = {"id": uuid.uuid4().hex[:8], "fire_at": fire_at, "message": message, "fired": False}
    items = _load()
    items.append(item)
    _save(items)
    return item


def list_reminders() -> list:
    return [r for r in _load() if not r.get("fired")]


def cancel_reminder(rid: str) -> bool:
    items = _load()
    kept = [r for r in items if r.get("id") != rid]
    _save(kept)
    return len(kept) < len(items)


def due_reminders(now: datetime | None = None) -> list:
    """返回到点未触发的提醒，并标记 fired（落盘）。"""
    now = now or datetime.now()
    items = _load()
    due, changed = [], False
    for r in items:
        if r.get("fired"):
            continue
        try:
            if datetime.fromisoformat(r["fire_at"]) <= now:
                r["fired"] = True
                changed = True
                due.append(r)
        except Exception:
            continue
    if changed:
        _save(items)
    return due


def _fire(message: str) -> None:
    try:
        m = (message or "").replace('"', "'")[:120]
        subprocess.run(["osascript", "-e", f'display notification "{m}" with title "定时提醒"'],
                       capture_output=True, timeout=8)
    except Exception:
        pass


async def reminders_loop(stop_event) -> None:
    """进程内 loop：每 30s 检查到点提醒、弹系统通知。"""
    import asyncio
    while not stop_event.is_set():
        try:
            for r in due_reminders():
                _fire(r.get("message", ""))
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass


# ── 工具 ──
async def _schedule_handler(args: dict, ctx) -> str:
    msg = str(args.get("message") or "").strip()
    if not msg:
        return "[参数缺失] schedule_reminder 需要 message"
    try:
        mins = float(args.get("in_minutes"))
    except (TypeError, ValueError):
        return "[参数错误] in_minutes 需要数字（分钟）"
    if mins <= 0:
        return "[参数错误] in_minutes 需 > 0"
    item = add_reminder(mins, msg)
    return f"好的，{mins:g} 分钟后提醒你：{msg}（id {item['id']}；app 开着才会弹通知）"


async def _list_handler(args: dict, ctx) -> str:
    items = list_reminders()
    if not items:
        return "当前没有待触发的提醒。"
    return "待触发提醒：\n" + "\n".join(f"- [{r['id']}] {r['fire_at'][11:16]} {r['message']}" for r in items)


async def _cancel_handler(args: dict, ctx) -> str:
    rid = str(args.get("id") or "").strip()
    if not rid:
        return "[参数缺失] cancel_reminder 需要 id"
    return "已取消该提醒。" if cancel_reminder(rid) else "没找到该 id 的提醒。"


if os.environ.get("DESKTOP_LOCAL") == "1":
    tool(name="schedule_reminder",
         description="设个定时提醒：N 分钟后弹系统通知提醒你某事（app 开着才触发）。",
         parameters={"type": "object", "properties": {
             "in_minutes": {"type": "number", "description": "几分钟后提醒"},
             "message": {"type": "string", "description": "提醒内容"},
         }, "required": ["in_minutes", "message"]})(_schedule_handler)
    tool(name="list_reminders", description="列出当前待触发的提醒。",
         parameters={"type": "object", "properties": {}}, read_only=True)(_list_handler)
    tool(name="cancel_reminder", description="按 id 取消一个提醒。",
         parameters={"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]})(_cancel_handler)
