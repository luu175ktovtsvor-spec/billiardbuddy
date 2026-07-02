"""上行器：把 sync_outbox 里未同步的批量打包 gzip、POST 到接收端；成功标 synced_at，
失败留队列 + attempts+1 + last_error（下次续传，指数退避）。

故障安全（铁律3）：上行任何异常都吞掉、只记本地日志，绝不阻断用户主流程/SSE。
默认关（铁律5）：uploader_loop 在 data_sync_enabled 关（或没配 endpoint/token）时直接 return；
flush_once 在没配 endpoint/token 时返回 (0,0)。客户端只带可吊销 app 令牌，真凭据在服务器。

可靠性护栏：
- 只有服务器**确认接收**(accepted+duplicated == 本批条数)才整批标 synced,否则留队列续传(靠幂等去重,不重复)。
- 单批有字节上限、单条 trace 内容有上限:防某个超大对话把整条队列 413 卡死(poison pill)。
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

# 单条 trace 正文上限:超大对话截断上传(整段仍在本机,首要保证队列不被单条撑爆)
_MAX_TRACE_BYTES = 4 * 1024 * 1024
# 单批未压缩上限:远小于 nginx client_max_body_size(50m);文本 gzip 后再缩一大截,稳不触 413
_MAX_BATCH_BYTES = 16 * 1024 * 1024


def _trace_payload(payload: dict) -> dict:
    """trace 行:把落盘 jsonl 内容读进 payload.content;超限截断;读失败记 read_error。"""
    path = payload.get("path")
    if not path:
        return payload
    try:
        data = Path(path).read_bytes()
        truncated = False
        if len(data) > _MAX_TRACE_BYTES:
            data = data[:_MAX_TRACE_BYTES]
            truncated = True
        content = data.decode("utf-8", "ignore")
        out = {**payload, "content": content}
        if truncated:
            out["truncated"] = True
        return out
    except Exception as e:
        return {**payload, "content": None, "read_error": str(e)[:200]}


def _build_items(rows) -> list:
    """把 outbox 行转成上行 item,受单批字节上限约束(至少发 1 条,避免超大单条 poison)。
    返回 [(row, item), ...],只含真正要发这批的行。"""
    picked = []
    total = 0
    for r in rows:
        payload = _trace_payload(r.payload) if (r.kind == "trace" and r.payload) else r.payload
        item = {"kind": r.kind, "ref_id": r.ref_id, "payload": payload}
        size = len(json.dumps(item, ensure_ascii=False).encode("utf-8"))
        if picked and total + size > _MAX_BATCH_BYTES:
            break  # 达批上限,剩下的下批再传(至少已 picked 1 条 → 不会永久卡)
        picked.append((r, item))
        total += size
    return picked


def _pack(items) -> bytes:
    body = {"machine_id": get_machine_id(), "batch": [it for _, it in items]}
    return gzip.compress(json.dumps(body, ensure_ascii=False).encode("utf-8"))


def _confirmed_count(resp, expected: int) -> int | None:
    """从服务器响应读 accepted+duplicated;读不出返回 None(退化成'HTTP 200 即成功')。"""
    try:
        result = resp.json()
        return int(result.get("accepted", 0)) + int(result.get("duplicated", 0))
    except Exception:
        return None


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

    items = _build_items(rows)
    picked_rows = [r for r, _ in items]
    content = _pack(items)
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
        # HTTP 200 不等于每条都落库:服务器可能中途丢了某条(仍返回 200)。只有确认数对得上才整批标 synced。
        confirmed = _confirmed_count(resp, len(picked_rows))
        if confirmed is not None and confirmed < len(picked_rows):
            for r in picked_rows:
                r.attempts = (r.attempts or 0) + 1
                r.last_error = f"partial ack {confirmed}/{len(picked_rows)}"[:500]
            await db.commit()
            logger.warning("data_sync 部分确认 %s/%s,整批留队列续传(幂等不重复)",
                           confirmed, len(picked_rows))
            return (0, len(picked_rows))
        now = datetime.now(timezone.utc)
        for r in picked_rows:
            r.synced_at = now
        await db.commit()
        return (len(picked_rows), 0)
    except Exception as e:
        for r in picked_rows:
            r.attempts = (r.attempts or 0) + 1
            r.last_error = str(e)[:500]
        await db.commit()
        logger.warning("data_sync 上行失败（留队列续传）: %s", e)
        return (0, len(picked_rows))
    finally:
        if own:
            await client.aclose()


async def uploader_loop(stop_event) -> None:
    """后台协程：周期跑 collect_once + flush_once；失败指数退避。默认关时直接 return。"""
    if not settings.data_sync_enabled:
        return
    if not settings.data_sync_endpoint or not settings.data_sync_token:
        # 开了但没配接收端 → 采集只进不出会撑爆本地队列。直接不启动。
        logger.info("data_sync 已开但未配 endpoint/token,不启动采集(避免只进不出撑队列)")
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
