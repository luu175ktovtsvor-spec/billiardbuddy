"""dataeye/receiver/app.py — 接收端 FastAPI:POST /ingest。

接口契约(客户端↔服务器,锁定,不能改):
  POST /ingest
  Header: Authorization: Bearer <app令牌>、Content-Encoding: gzip、Content-Type: application/json
  Body(gzip 前 JSON): {"machine_id": str, "batch": [{"kind","ref_id","payload"}, ...]}
  响应: 200 {"accepted": n, "duplicated": m};令牌无效 401。

出处:docs/plans/用户数据留存与利用-机制设计-2026-07-02.md Task P1.S1 Step2。
"""
from __future__ import annotations

import gzip
import json
import logging
import os

from fastapi import FastAPI, HTTPException, Request

from db import insert_batch  # 同目录 dataeye/receiver/db.py

logger = logging.getLogger("dataeye.app")

app = FastAPI(title="dataeye-receiver")


def _allowed_tokens() -> set[str]:
    """现读 env(而非模块级冻结常量),方便单测 monkeypatch.setenv 直接生效、不必 importlib.reload。"""
    return set(filter(None, os.environ.get("INGEST_TOKENS", "").split(",")))


@app.get("/health")
async def health():
    """给 systemd/nginx 探活用。"""
    return {"ok": True}


@app.post("/ingest")
async def ingest(request: Request):
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    if not token or token not in _allowed_tokens():
        raise HTTPException(status_code=401, detail="invalid token")

    raw = await request.body()
    if (request.headers.get("content-encoding") or "").lower() == "gzip":
        raw = gzip.decompress(raw)

    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid json body") from exc

    machine_id = body.get("machine_id")
    batch = body.get("batch") or []
    accepted, duplicated = await insert_batch(machine_id, batch)
    return {"accepted": accepted, "duplicated": duplicated}
