"""dataeye/receiver/db.py — PG 连接 + 落库。

三层写入:
  1. raw_inbox(原始层,append-only,幂等按 (machine_id,kind,ref_id))——先写这层,冲突算 duplicated 直接跳过整理。
  2. 六模块整理层(events/generations/transcripts/stores)——只有 raw_inbox 真插入成功的才整理,单条坏不连累整批。
  3. transcripts 的长文本正文落大盘文件,表里只留索引卡片。

出处:docs/plans/用户数据留存与利用-机制设计-2026-07-02.md Task P1.S1。
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import asyncpg

logger = logging.getLogger("dataeye.db")

TRANSCRIPT_STORE_DIR = os.environ.get("TRANSCRIPT_STORE_DIR", "/data/transcripts")

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """模块级 lazy 连接池,首次调用才真连库。"""
    global _pool
    if _pool is None:
        dsn = os.environ.get("PGDSN", "postgresql://dataeye:dataeye@127.0.0.1/dataeye")
        _pool = await asyncpg.create_pool(dsn)
    return _pool


async def close_pool() -> None:
    """给测试/优雅关闭用;非必须路径。"""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def _rows_affected(status: str) -> int:
    """asyncpg execute() 返回形如 'INSERT 0 1' / 'INSERT 0 0' / 'UPDATE 1' 的状态串,取末尾数字。"""
    try:
        return int(status.split()[-1])
    except (ValueError, IndexError):
        return 0


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "t", "yes")
    return None


def _parse_dt(value: Any) -> datetime | None:
    """created_at 字段容错解析:客户端传 ISO8601 字符串(或 None)。

    注意:asyncpg 对 `$N::timestamptz` 这种"参数+服务端 cast"的写法要求参数本身就是
    datetime 实例(不像 psycopg2 能把裸字符串丢给 PG 文本解析再 cast),裸字符串会在
    协议层直接报 DataError。所以这里在 Python 侧先解析成 datetime 对象再传给 asyncpg。
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(s)
        except ValueError:
            return None
    return None


def _to_text(value: Any) -> str | None:
    """result/prompt_used 等列是 TEXT;若客户端不小心塞了 dict/list,序列化成字符串而不是报错丢批。"""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


async def _insert_raw_inbox(
    conn: asyncpg.Connection, machine_id: str, kind: str, ref_id: str, payload: Any
) -> bool:
    """返回 True = 真插入(此前没见过这条),False = 冲突(已处理过,duplicated)。"""
    payload_json = json.dumps(payload, ensure_ascii=False) if payload is not None else None
    status = await conn.execute(
        """
        INSERT INTO raw_inbox (machine_id, kind, ref_id, payload)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (machine_id, kind, ref_id) DO NOTHING
        """,
        machine_id,
        kind,
        ref_id,
        payload_json,
    )
    return _rows_affected(status) > 0


async def _handle_event(conn: asyncpg.Connection, machine_id: str, payload: dict) -> None:
    await conn.execute(
        """
        INSERT INTO events (machine_id, event_id, store_id, user_id, event, props, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (machine_id, event_id) DO NOTHING
        """,
        machine_id,
        payload.get("id"),
        payload.get("store_id"),
        payload.get("user_id"),
        payload.get("event"),
        json.dumps(payload.get("props") or {}, ensure_ascii=False),
        _parse_dt(payload.get("created_at")),
    )


async def _handle_gen(conn: asyncpg.Connection, machine_id: str, payload: dict) -> None:
    await conn.execute(
        """
        INSERT INTO generations (
            machine_id, gen_id, store_id, type, sub_type, prompt_used, result,
            model_used, tokens_used, effect_rating, effect_note, is_favorite,
            source_rec_id, conversation_id, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (machine_id, gen_id) DO NOTHING
        """,
        machine_id,
        payload.get("id"),
        payload.get("store_id"),
        payload.get("type"),
        payload.get("sub_type"),
        _to_text(payload.get("prompt_used")),
        _to_text(payload.get("result")),
        payload.get("model_used"),
        _to_int(payload.get("tokens_used")),
        payload.get("effect_rating"),
        payload.get("effect_note"),
        _to_bool(payload.get("is_favorite")),
        payload.get("source_rec_id"),
        payload.get("conversation_id"),
        _parse_dt(payload.get("created_at")),
    )


async def _handle_store(conn: asyncpg.Connection, machine_id: str, payload: dict) -> None:
    snapshot = payload.get("snapshot", payload)
    store_id = snapshot.get("id") if isinstance(snapshot, dict) else None
    await conn.execute(
        """
        INSERT INTO stores (machine_id, store_id, snapshot)
        VALUES ($1, $2, $3)
        ON CONFLICT (machine_id, store_id)
        DO UPDATE SET snapshot = EXCLUDED.snapshot, received_at = now()
        """,
        machine_id,
        store_id,
        json.dumps(snapshot, ensure_ascii=False),
    )


async def _handle_trace(conn: asyncpg.Connection, machine_id: str, payload: dict) -> None:
    conversation_id = payload.get("conversation_id")
    content = payload.get("content")
    file_path = ""
    turns = 0
    summary = ""
    if content:
        turns = len(content.splitlines())
        summary = content[:200]
        dest_dir = Path(TRANSCRIPT_STORE_DIR) / str(machine_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_dir / f"{conversation_id}.jsonl"
        dest_file.write_text(content, encoding="utf-8")
        file_path = str(dest_file)
    await conn.execute(
        """
        INSERT INTO transcripts (machine_id, conversation_id, file_path, summary, turns, created_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (machine_id, conversation_id)
        DO UPDATE SET file_path = EXCLUDED.file_path, summary = EXCLUDED.summary, turns = EXCLUDED.turns
        """,
        machine_id,
        conversation_id,
        file_path,
        summary,
        turns,
    )


_HANDLERS = {
    "event": _handle_event,
    "gen": _handle_gen,
    "store": _handle_store,
    "trace": _handle_trace,
}


async def insert_batch(machine_id: str, batch: list[dict]) -> tuple[int, int]:
    """落 raw_inbox(幂等)→ 真插入的再整理进六模块表。返回 (accepted, duplicated)。"""
    pool = await get_pool()
    accepted = 0
    duplicated = 0
    async with pool.acquire() as conn:
        for item in batch:
            kind = item.get("kind")
            ref_id = item.get("ref_id")
            payload = item.get("payload")
            try:
                is_new = await _insert_raw_inbox(conn, machine_id, kind, ref_id, payload)
            except Exception:
                logger.exception(
                    "raw_inbox insert failed machine_id=%s kind=%s ref_id=%s", machine_id, kind, ref_id
                )
                continue
            if not is_new:
                duplicated += 1
                continue
            accepted += 1
            handler = _HANDLERS.get(kind)
            if handler is None:
                logger.warning("unknown kind=%s machine_id=%s ref_id=%s", kind, machine_id, ref_id)
                continue
            try:
                await handler(conn, machine_id, payload if isinstance(payload, dict) else {})
            except Exception:
                # 单条整理失败不连累整批;原文已经安全落在 raw_inbox,后续可重放修复。
                logger.exception(
                    "integrate failed machine_id=%s kind=%s ref_id=%s", machine_id, kind, ref_id
                )
    return accepted, duplicated
