"""dataeye/tests/test_receiver.py — 接收端 HTTP 层单元测试(不需要真 PG)。

只验证 app.py 的鉴权 / gzip 解压 / 参数透传是否正确;db.py 的落库逻辑靠这里
monkeypatch 掉(换成假实现),避免依赖一个真 Postgres 才能跑测试。

跑法:
    cd dataeye && python -m pytest tests/ -q
需要 fastapi + httpx + pytest(装 receiver/requirements.txt 外加 pytest/httpx)。
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# app.py 用 `from db import insert_batch`(同目录相对导入),
# 所以把 receiver/ 目录加进 sys.path 才能 `import app`。
RECEIVER_DIR = Path(__file__).resolve().parent.parent / "receiver"
if str(RECEIVER_DIR) not in sys.path:
    sys.path.insert(0, str(RECEIVER_DIR))

import app as app_module  # noqa: E402  (必须在 sys.path 插入之后 import)


def _gzip_json(body: dict) -> bytes:
    return gzip.compress(json.dumps(body).encode("utf-8"))


GZIP_HEADERS = {"Content-Encoding": "gzip", "Content-Type": "application/json"}


@pytest.fixture
def fake_insert_batch(monkeypatch):
    """把 app.py 里绑定的 insert_batch 换成假实现,记录收到的参数、返回固定 (n, 0)。"""
    calls: list[tuple[str, list]] = []

    async def _fake(machine_id, batch):
        calls.append((machine_id, batch))
        return (len(batch), 0)

    monkeypatch.setattr(app_module, "insert_batch", _fake)
    return calls


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("INGEST_TOKENS", "tok-a,tok-b")
    return TestClient(app_module.app)


def test_health_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_missing_bearer_returns_401(client, fake_insert_batch):
    resp = client.post(
        "/ingest",
        content=_gzip_json({"machine_id": "m1", "batch": []}),
        headers=GZIP_HEADERS,
    )
    assert resp.status_code == 401
    assert fake_insert_batch == []  # 鉴权失败不该碰到落库逻辑


def test_wrong_token_returns_401(client, fake_insert_batch):
    resp = client.post(
        "/ingest",
        content=_gzip_json({"machine_id": "m1", "batch": []}),
        headers={**GZIP_HEADERS, "Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401
    assert fake_insert_batch == []


def test_revoked_token_no_longer_works(client, fake_insert_batch, monkeypatch):
    """吊销 = 从 INGEST_TOKENS 清单删掉;删掉后同一个令牌应该变成 401。"""
    monkeypatch.setenv("INGEST_TOKENS", "tok-b")  # tok-a 已被吊销,清单里只剩 tok-b
    resp = client.post(
        "/ingest",
        content=_gzip_json({"machine_id": "m1", "batch": []}),
        headers={**GZIP_HEADERS, "Authorization": "Bearer tok-a"},
    )
    assert resp.status_code == 401


def test_valid_token_gzip_body_returns_200_and_forwards_batch(client, fake_insert_batch):
    batch = [
        {
            "kind": "event",
            "ref_id": "e1",
            "payload": {"id": "e1", "event": "agent_chat", "props": {}, "created_at": None},
        },
        {
            "kind": "gen",
            "ref_id": "g1",
            "payload": {"id": "g1", "store_id": "s1", "type": "image", "tokens_used": 100},
        },
    ]
    body = {"machine_id": "machine-abc", "batch": batch}

    resp = client.post(
        "/ingest",
        content=_gzip_json(body),
        headers={**GZIP_HEADERS, "Authorization": "Bearer tok-a"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"accepted": 2, "duplicated": 0}

    # 假 insert_batch 确实收到了解压后的正确 machine_id / batch(证明 gzip 解压+JSON 解析走对了)
    assert len(fake_insert_batch) == 1
    got_machine_id, got_batch = fake_insert_batch[0]
    assert got_machine_id == "machine-abc"
    assert got_batch == batch


def test_empty_batch_is_valid_and_accepted_zero(client, fake_insert_batch):
    resp = client.post(
        "/ingest",
        content=_gzip_json({"machine_id": "m1", "batch": []}),
        headers={**GZIP_HEADERS, "Authorization": "Bearer tok-b"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"accepted": 0, "duplicated": 0}


def test_non_gzip_content_encoding_treats_body_as_plain_json(client, fake_insert_batch):
    """没标 gzip 时按明文 JSON 处理(客户端契约固定用 gzip,这里只是确认没有误判)。"""
    body = {"machine_id": "m2", "batch": []}
    raw = json.dumps(body).encode("utf-8")
    resp = client.post(
        "/ingest",
        content=raw,
        headers={"Authorization": "Bearer tok-a", "Content-Type": "application/json"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"accepted": 0, "duplicated": 0}
