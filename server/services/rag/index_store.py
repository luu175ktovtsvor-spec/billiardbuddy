"""本地向量索引存储（真 RAG 的"存向量 + 搜"那一步）。

刻意用【独立的本地 SQLite 文件 + 暴力 cosine】，不碰主业务库 schema、不上向量数据库：
- 单店语料就几百到几千条，暴力 cosine（纯 Python/标准库）足够快，零额外依赖。
- 独立文件（桌面数据目录下）→ 与主库完全解耦，不需要迁移、不连累生成热路径。
- 主键 (store_id, source_type, source_id) → 同一条记录重复索引就覆盖，不会重。

向量按 struct 打包成 BLOB 存；维度随行存，搜索时按"与查询同维度"过滤，换嵌入后端后的旧向量自动忽略。
"""
import os
import sqlite3
import struct
from pathlib import Path

from services.rag.embedder import cosine

_conn_cache: dict[str, sqlite3.Connection] = {}


def _db_path() -> Path:
    base = Path(os.environ.get("DESKTOP_RAG_DIR") or (Path.home() / ".billiards-desktop" / "rag"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "index.db"


def _conn() -> sqlite3.Connection:
    key = str(_db_path())
    c = _conn_cache.get(key)
    if c is None:
        c = sqlite3.connect(key)
        c.execute(
            "CREATE TABLE IF NOT EXISTS vectors ("
            "store_id TEXT, source_type TEXT, source_id TEXT, "
            "text TEXT, dim INTEGER, emb BLOB, ts TEXT, "
            "PRIMARY KEY (store_id, source_type, source_id))"
        )
        c.commit()
        _conn_cache[key] = c
    return c


def reset_for_test() -> None:
    """测试用：清掉连接缓存（配合 DESKTOP_RAG_DIR 指向 tmp 目录隔离）。"""
    _conn_cache.clear()


def upsert(store_id: str, source_type: str, source_id: str, text: str, emb: list[float], ts: str = "") -> None:
    blob = struct.pack(f"{len(emb)}f", *emb)
    c = _conn()
    c.execute(
        "INSERT OR REPLACE INTO vectors (store_id, source_type, source_id, text, dim, emb, ts) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(store_id), source_type, source_id, text, len(emb), blob, ts),
    )
    c.commit()


def existing_ids(store_id: str, source_type: str) -> set[str]:
    """某店某来源已索引的 source_id 集合（供惰性增量补建：只索引没索引过的）。"""
    c = _conn()
    rows = c.execute(
        "SELECT source_id FROM vectors WHERE store_id=? AND source_type=?",
        (str(store_id), source_type),
    ).fetchall()
    return {r[0] for r in rows}


def search(store_id: str, query_emb: list[float], top: int = 5, min_score: float = 0.05) -> list[dict]:
    """暴力 cosine 搜本店向量，返回 top 条 [{source_type, source_id, text, score, ts}]。
    只比同维度向量（换嵌入后端后旧向量自动忽略）；分数低于 min_score 的丢弃。"""
    qdim = len(query_emb)
    c = _conn()
    rows = c.execute(
        "SELECT source_type, source_id, text, dim, emb, ts FROM vectors WHERE store_id=?",
        (str(store_id),),
    ).fetchall()
    scored = []
    for st, sid, text, dim, blob, ts in rows:
        if dim != qdim:
            continue
        emb = list(struct.unpack(f"{dim}f", blob))
        score = cosine(query_emb, emb)
        if score >= min_score:
            scored.append({"source_type": st, "source_id": sid, "text": text, "score": score, "ts": ts})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top]
