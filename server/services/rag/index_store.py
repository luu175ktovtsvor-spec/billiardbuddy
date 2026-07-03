"""本地向量索引存储（真 RAG 的"存向量 + 搜"那一步）。

刻意用【独立的本地 SQLite 文件 + 暴力 cosine】，不碰主业务库 schema、不上向量数据库：
- 单店语料就几百到几千条，暴力 cosine（纯 Python/标准库）足够快，零额外依赖。
- 独立文件（桌面数据目录下）→ 与主库完全解耦，不需要迁移、不连累生成热路径。
- 主键 (store_id, source_type, source_id) → 同一条记录重复索引就覆盖，不会重。

向量按 struct 打包成 BLOB 存；维度随行存，搜索时按"与查询同维度"过滤，换嵌入后端后的旧向量自动忽略。
另存一列 fp（内容指纹）：源记录被编辑后指纹变、补建时据此重嵌，不再永远返回旧向量（M11 #2a）。
"""
import heapq
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
            "text TEXT, dim INTEGER, emb BLOB, ts TEXT, fp TEXT DEFAULT '', "
            "PRIMARY KEY (store_id, source_type, source_id))"
        )
        # 老库迁移：缺 fp 列就补（幂等，老安装包升级后第一次连接时执行）
        cols = {r[1] for r in c.execute("PRAGMA table_info(vectors)").fetchall()}
        if "fp" not in cols:
            c.execute("ALTER TABLE vectors ADD COLUMN fp TEXT DEFAULT ''")
        c.commit()
        _conn_cache[key] = c
    return c


def reset_for_test() -> None:
    """测试用：清掉连接缓存（配合 DESKTOP_RAG_DIR 指向 tmp 目录隔离）。"""
    _conn_cache.clear()


def upsert(store_id: str, source_type: str, source_id: str, text: str, emb: list[float],
           ts: str = "", fp: str = "") -> None:
    blob = struct.pack(f"{len(emb)}f", *emb)
    c = _conn()
    c.execute(
        "INSERT OR REPLACE INTO vectors (store_id, source_type, source_id, text, dim, emb, ts, fp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (str(store_id), source_type, source_id, text, len(emb), blob, ts, fp),
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


def existing_fingerprints(store_id: str, source_type: str) -> dict[str, str]:
    """某店某来源已索引的 {source_id: fp} 指纹表（供增量补建：指纹变了才重嵌）。"""
    c = _conn()
    rows = c.execute(
        "SELECT source_id, fp FROM vectors WHERE store_id=? AND source_type=?",
        (str(store_id), source_type),
    ).fetchall()
    return {r[0]: (r[1] or "") for r in rows}


def search(store_id: str, query_emb: list[float], top: int = 5, min_score: float = 0.05,
           source_type: str | None = None) -> list[dict]:
    """暴力 cosine 搜本店向量，返回 top 条 [{source_type, source_id, text, score, ts}]。
    只比同维度向量（换嵌入后端后旧向量自动忽略）；分数低于 min_score 的丢弃。

    source_type=None（默认）＝ 不分来源，全店所有 source_type 一起搜（原有行为，向后兼容）。
    传具体值（如 "store_doc"）＝ 只搜这一类来源——店铺资料检索(search_store_docs)靠这个参数
    与 recall_my_content(只搜 "generation") 互相隔离，别把老板过去的生成记录跟他导入的文档混着搜。"""
    if top <= 0:
        return []
    qdim = len(query_emb)
    c = _conn()
    if source_type is not None:
        rows = c.execute(
            "SELECT source_type, source_id, text, dim, emb, ts FROM vectors WHERE store_id=? AND source_type=?",
            (str(store_id), source_type),
        ).fetchall()
    else:
        rows = c.execute(
            "SELECT source_type, source_id, text, dim, emb, ts FROM vectors WHERE store_id=?",
            (str(store_id),),
        ).fetchall()

    def _candidates():
        # 流式打分：同维度 + 过门槛的才产出，配合 heapq 只留 top 条，不把全店算完再整列排序
        for st, sid, text, dim, blob, ts in rows:
            if dim != qdim:
                continue
            score = cosine(query_emb, list(struct.unpack(f"{dim}f", blob)))
            if score >= min_score:
                yield (score, {"source_type": st, "source_id": sid, "text": text, "score": score, "ts": ts})

    best = heapq.nlargest(top, _candidates(), key=lambda x: x[0])
    return [d for _, d in best]


def delete_ids(store_id: str, source_type: str, source_ids: list[str]) -> int:
    """删掉指定 source_id 集合的向量行。用于店铺资料增量索引时清掉"文件改小/删段落后不再存在"
    的陈旧 chunk（否则搜索会一直命中已经不在文档里的旧内容）。返回删除行数。"""
    if not source_ids:
        return 0
    c = _conn()
    placeholders = ",".join("?" for _ in source_ids)
    cur = c.execute(
        f"DELETE FROM vectors WHERE store_id=? AND source_type=? AND source_id IN ({placeholders})",
        (str(store_id), source_type, *source_ids),
    )
    c.commit()
    return cur.rowcount


def delete_by_source_type(store_id: str, source_type: str) -> int:
    """删掉某店某来源的【全部】向量行。用于老板清除店铺资料库配置时整批清库。返回删除行数。"""
    c = _conn()
    cur = c.execute(
        "DELETE FROM vectors WHERE store_id=? AND source_type=?",
        (str(store_id), source_type),
    )
    c.commit()
    return cur.rowcount
