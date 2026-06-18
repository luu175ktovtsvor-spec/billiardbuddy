"""召回：把嵌入器 + 本地向量库串起来，并从生成记录惰性补建索引。

真 RAG 用在【老板本机越攒越多的数据】（生成历史/报表/反馈/店脑）——"找我上次效果最好那条""我三月那份"。
不用在 171 条策展模板上（那个用清单法，见 scenario_catalog）。
"""
import logging

from services.rag import index_store
from services.rag.embedder import get_embedder

logger = logging.getLogger(__name__)

_MAX_INDEX_TEXT = 2000  # 单条入库文本上限（嵌入只需代表性片段，存全文没必要）


def index_text(store_id, source_type: str, source_id: str, text: str, ts: str = "") -> None:
    if not text or not text.strip():
        return
    emb = get_embedder().embed(text)
    index_store.upsert(str(store_id), source_type, str(source_id), text[:_MAX_INDEX_TEXT], emb, ts)


def recall(store_id, query: str, top: int = 5) -> list[dict]:
    if not query or not query.strip():
        return []
    qe = get_embedder().embed(query)
    return index_store.search(str(store_id), qe, top=top)


async def backfill_from_generations(db, store_id, limit: int = 300) -> int:
    """把本店最近 limit 条生成记录里【还没索引】的补进索引（惰性增量）。返回新索引条数。
    故障安全：任何异常都吞掉、不影响对已索引部分的召回。"""
    try:
        from sqlalchemy import select

        from models.generation import Generation

        done = index_store.existing_ids(str(store_id), "generation")
        rows = (await db.execute(
            select(Generation.id, Generation.title, Generation.result, Generation.created_at)
            .where(Generation.store_id == store_id, Generation.is_deleted == False)  # noqa: E712
            .order_by(Generation.created_at.desc())
            .limit(limit)
        )).all()
        n = 0
        for gid, title, result, created in rows:
            sid = str(gid)
            if sid in done:
                continue
            text = ((title or "") + "\n" + (result or "")).strip()
            if text:
                index_text(store_id, "generation", sid, text, ts=str(created or ""))
                n += 1
        return n
    except Exception:
        logger.exception("RAG 补建索引失败（忽略，仍可召回已索引部分）")
        return 0
