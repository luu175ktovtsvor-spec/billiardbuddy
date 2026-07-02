"""上行器 flush_once:
- 服务器确认全批(accepted+duplicated==条数)才标 synced;部分确认/失败留队列续传。
- 单批字节上限 + 单条 trace 截断:防超大对话把队列 413 卡死(poison pill)。
mock 掉 httpx,不发真网络。"""

import gzip
import json

import pytest
from sqlalchemy import select

from models.sync_outbox import SyncOutbox
from services.data_sync import uploader
from services.data_sync.uploader import flush_once


class _FakeResp:
    def __init__(self, code, body=None):
        self.status_code = code
        self._body = body if body is not None else {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}")

    def json(self):
        return self._body


class _FakeClient:
    """ack: full=确认全批 / partial=少确认一条 / none=不给计数(退化成 HTTP 200 即成功)。"""

    def __init__(self, code=200, ack="full"):
        self.code = code
        self.ack = ack
        self.sent = []

    async def post(self, url, content=None, headers=None):
        decoded = gzip.decompress(content)
        self.sent.append(decoded)
        n = len(json.loads(decoded)["batch"])
        if self.ack == "full":
            body = {"accepted": n, "duplicated": 0}
        elif self.ack == "partial":
            body = {"accepted": max(0, n - 1), "duplicated": 0}
        else:
            body = {}
        return _FakeResp(self.code, body)


def _cfg(monkeypatch):
    from config import settings
    monkeypatch.setattr(settings, "data_sync_endpoint", "http://x/ingest")
    monkeypatch.setattr(settings, "data_sync_token", "tok")


@pytest.mark.asyncio
async def test_flush_marks_synced_on_full_ack(db_session, monkeypatch):
    _cfg(monkeypatch)
    db_session.add(SyncOutbox(kind="event", ref_id="e1", payload={"event": "agent_chat"}))
    await db_session.commit()

    client = _FakeClient(200, ack="full")
    ok, fail = await flush_once(db_session, client=client)
    assert ok == 1 and fail == 0
    row = (await db_session.execute(select(SyncOutbox))).scalars().one()
    assert row.synced_at is not None
    body = json.loads(client.sent[0])
    assert body["machine_id"] and body["batch"][0]["ref_id"] == "e1"


@pytest.mark.asyncio
async def test_flush_partial_ack_keeps_queue(db_session, monkeypatch):
    """服务器只确认了一部分(仍返回 200)→ 整批不标 synced,留队列续传(靠幂等去重不重复)。"""
    _cfg(monkeypatch)
    db_session.add(SyncOutbox(kind="event", ref_id="e1", payload={}))
    db_session.add(SyncOutbox(kind="event", ref_id="e2", payload={}))
    await db_session.commit()

    ok, fail = await flush_once(db_session, client=_FakeClient(200, ack="partial"))
    assert ok == 0 and fail == 2
    rows = (await db_session.execute(select(SyncOutbox))).scalars().all()
    assert all(r.synced_at is None and r.attempts == 1 and r.last_error for r in rows)


@pytest.mark.asyncio
async def test_flush_keeps_on_failure(db_session, monkeypatch):
    _cfg(monkeypatch)
    db_session.add(SyncOutbox(kind="event", ref_id="e2", payload={"event": "x"}))
    await db_session.commit()

    ok, fail = await flush_once(db_session, client=_FakeClient(500))
    assert ok == 0 and fail == 1
    row = (await db_session.execute(select(SyncOutbox))).scalars().one()
    assert row.synced_at is None and row.attempts == 1 and row.last_error


@pytest.mark.asyncio
async def test_flush_noop_without_endpoint(db_session, monkeypatch):
    from config import settings
    monkeypatch.setattr(settings, "data_sync_endpoint", "")
    monkeypatch.setattr(settings, "data_sync_token", "")
    db_session.add(SyncOutbox(kind="event", ref_id="e3", payload={}))
    await db_session.commit()
    ok, fail = await flush_once(db_session, client=_FakeClient(200))
    assert ok == 0 and fail == 0
    row = (await db_session.execute(select(SyncOutbox))).scalars().one()
    assert row.synced_at is None and row.attempts == 0


@pytest.mark.asyncio
async def test_flush_reads_and_truncates_trace(db_session, monkeypatch, tmp_path):
    """trace 上行时读落盘 jsonl 内容;超单条上限则截断(防 poison)。"""
    _cfg(monkeypatch)
    monkeypatch.setattr(uploader, "_MAX_TRACE_BYTES", 16)  # 缩小上限便于测试
    f = tmp_path / "conv-1.jsonl"
    f.write_text("A" * 100, encoding="utf-8")  # 远超 16 字节
    db_session.add(SyncOutbox(kind="trace", ref_id="conv-1:123",
                              payload={"conversation_id": "conv-1", "path": str(f)}))
    await db_session.commit()

    client = _FakeClient(200, ack="full")
    ok, fail = await flush_once(db_session, client=client)
    assert ok == 1
    p = json.loads(client.sent[0])["batch"][0]["payload"]
    assert p["truncated"] is True and len(p["content"]) == 16


@pytest.mark.asyncio
async def test_flush_batch_byte_cap_paginates(db_session, monkeypatch):
    """单批字节超上限 → 本次只发能装下的,剩下的下次;至少发 1 条(不 poison)。"""
    _cfg(monkeypatch)
    monkeypatch.setattr(uploader, "_MAX_BATCH_BYTES", 120)  # 极小,一次基本只装 1 条
    for i in range(3):
        db_session.add(SyncOutbox(kind="event", ref_id=f"e{i}",
                                  payload={"event": "x", "pad": "y" * 80}))
    await db_session.commit()

    ok, _ = await flush_once(db_session, client=_FakeClient(200, ack="full"))
    assert ok >= 1  # 至少发出去 1 条(没被单条撑爆卡死)
    remaining = (await db_session.execute(
        select(SyncOutbox).where(SyncOutbox.synced_at.is_(None))
    )).scalars().all()
    assert len(remaining) == 3 - ok  # 剩下的留队列,下轮续传
