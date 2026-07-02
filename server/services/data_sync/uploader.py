"""上行器：把 sync_outbox 里未同步的批量打包 gzip、POST 到接收端；成功标 synced_at，
失败留队列 + attempts+1 + last_error（下次续传，指数退避）。

故障安全（铁律3）：上行任何异常都吞掉、只记本地日志，绝不阻断用户主流程/SSE。
默认关（铁律5）：uploader_loop 在 data_sync_enabled 关时直接 return；
flush_once 在没配 endpoint/token 时返回 (0,0)。客户端只带可吊销 app 令牌，真凭据在服务器。
"""

import asyncio
import gzip
import json
import logging
from pathlib import Path

from datetime import datetime, timezone

from sqlalchemy import select

from config import settings
from models.sync_outbox import SyncOutbox
from services.data_sync.machine_id import get_machine_id

logger = logging.getLogger(__name__)


def _pack(rows) -> bytes:
    """组批 → JSON → gzip。trace 行在此把落盘 jsonl 内容读进 payload.content。"""
    batch = []
    for r in rows:
        item = {"kind": r.kind, "ref_id": r.ref_id, "payload": r.payload}
        if r.kind == "trace" and r.payload and r.payload.get("path"):
            try:
                content = Path(r.payload["path"]).read_text(encoding="utf-8")
                item["payload"] = {**r.payload, "content": content}
            except Exception as e:
                item["payload"] = {**r.payload, "content": None, "read_error": str(e)[:200]}
        batch.append(item)
    body = {"machine_id": get_machine_id(), "batch": batch}
    return gzip.compress(json.dumps(body, ensure_ascii=False).encode("utf-8"))


async def flush_once(db, client=None) -> tuple[int, int]:
    """取一批未同步 → 上行 → 标记/留队列。返回 (成功数, 失败数)。"""
    if not settings.data_sync_endpoint or not settings.data_sync_token:
        return (0, 0)

    rows = (await db.execute(
        select(SyncOutbox)
        .where(SyncOutbox.synced_at.is_(None))
        .order_by(SyncOutbox.created_at)
        .limit(settings.data_sync_batch)
    )).scalars().all()
    if not rows:
        return (0, 0)

    content = _pack(rows)
    headers = {
        "Authorization": f"Bearer {settings.data_sync_token}",
        "Content-Encoding": "gzip",
        "Content-Type": "application/json",
    }

    own = client is None
    if own:
        import httpx
        client = httpx.AsyncClient(timeout=30)
    try:
        resp = await client.post(settings.data_sync_endpoint, content=content, headers=headers)
        resp.raise_for_status()
        now = datetime.now(timezone.utc)
        for r in rows:
            r.synced_at = now
        await db.commit()
        return (len(rows), 0)
    except Exception as e:
        for r in rows:
            r.attempts = (r.attempts or 0) + 1
            r.last_error = str(e)[:500]
        await db.commit()
        logger.warning("data_sync 上行失败（留队列续传）: %s", e)
        return (0, len(rows))
    finally:
        if own:
            await client.aclose()


async def uploader_loop(stop_event) -> None:
    """后台协程：周期跑 collect_once + flush_once；失败指数退避。默认关时直接 return。"""
    if not settings.data_sync_enabled:
        return

    from db.session import async_session
    from services.data_sync.collector import collect_once

    logger.info("data_sync 上行协程已启动（interval=%ss, batch=%s）",
                settings.data_sync_interval_s, settings.data_sync_batch)
    backoff = 1
    while not stop_event.is_set():
        try:
            async with async_session() as db:
                await collect_once(db)
                ok, fail = await flush_once(db)
            backoff = 1 if fail == 0 else min(backoff * 2, 60)
        except Exception:
            logger.warning("data_sync loop 异常（不影响主流程）", exc_info=True)
            backoff = min(backoff * 2, 60)
        try:
            await asyncio.wait_for(stop_event.wait(),
                                   timeout=settings.data_sync_interval_s * backoff)
        except asyncio.TimeoutError:
            pass
