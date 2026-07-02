"""上行器 flush_once：成功标 synced_at；失败留队列 + attempts+1 + last_error。
mock 掉 httpx，不发真网络。"""

import gzip
import json

import pytest
from sqlalchemy import select

from models.sync_outbox import SyncOutbox
from services.data_sync.uploader import flush_once


class _FakeResp:
    def __init__(self, code):
        self.status_code = code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}")


class _FakeClient:
    def __init__(self, code=200):
        self.code = code
        self.sent = []

    async def post(self, url, content=None, headers=None):
        self.sent.append(gzip.decompress(content))
        return _FakeResp(self.code)


@pytest.mark.asyncio
async def test_flush_marks_synced_on_200(db_session, monkeypatch):
    from config import settings
    monkeypatch.setattr(settings, "data_sync_endpoint", "http://x/ingest")
    monkeypatch.setattr(settings, "data_sync_token", "tok")
    db_session.add(SyncOutbox(kind="event", ref_id="e1", payload={"event": "agent_chat"}))
    await db_session.commit()

    client = _FakeClient(200)
    ok, fail = await flush_once(db_session, client=client)
    assert ok == 1 and fail == 0
    row = (await db_session.execute(select(SyncOutbox))).scalars().one()
    assert row.synced_at is not None
    # 发出去的是 gzip 后的 JSON，含 machine_id + batch
    body = json.loads(client.sent[0])
    assert body["machine_id"] and body["batch"][0]["ref_id"] == "e1"


@pytest.mark.asyncio
async def test_flush_keeps_on_failure(db_session, monkeypatch):
    from config import settings
    monkeypatch.setattr(settings, "data_sync_endpoint", "http://x/ingest")
    monkeypatch.setattr(settings, "data_sync_token", "tok")
    db_session.add(SyncOutbox(kind="event", ref_id="e2", payload={"event": "x"}))
    await db_session.commit()

    ok, fail = await flush_once(db_session, client=_FakeClient(500))
    assert ok == 0 and fail == 1
    row = (await db_session.execute(select(SyncOutbox))).scalars().one()
    assert row.synced_at is None and row.attempts == 1 and row.last_error


@pytest.mark.asyncio
async def test_flush_noop_without_endpoint(db_session, monkeypatch):
    """没配 endpoint/token → 直接 (0,0)，不动队列。"""
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
async def test_flush_reads_trace_file_content(db_session, monkeypatch, tmp_path):
    """trace 行上行时把落盘 jsonl 的内容读进 payload.content。"""
    from config import settings
    monkeypatch.setattr(settings, "data_sync_endpoint", "http://x/ingest")
    monkeypatch.setattr(settings, "data_sync_token", "tok")
    f = tmp_path / "conv-1.jsonl"
    f.write_text('{"role":"user"}\n', encoding="utf-8")
    db_session.add(SyncOutbox(kind="trace", ref_id="conv-1",
                              payload={"conversation_id": "conv-1", "path": str(f)}))
    await db_session.commit()

    client = _FakeClient(200)
    ok, fail = await flush_once(db_session, client=client)
    assert ok == 1
    body = json.loads(client.sent[0])
    assert body["batch"][0]["payload"]["content"] == '{"role":"user"}\n'
