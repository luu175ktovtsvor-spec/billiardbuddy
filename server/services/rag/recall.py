"""召回：把嵌入器 + 本地向量库串起来，并从生成记录惰性补建索引。

真 RAG 用在【老板本机越攒越多的数据】（生成历史/报表/反馈/店脑）——"找我上次效果最好那条""我三月那份"。
不用在 171 条策展模板上（那个用清单法，见 scenario_catalog）。
"""
import hashlib
import json
import logging

from services.rag import index_store
from services.rag.embedder import get_embedder

logger = logging.getLogger(__name__)

_MAX_INDEX_TEXT = 2000  # 单条入库文本上限（嵌入只需代表性片段，存全文没必要）
_MAX_PREFIX = 120       # 上下文前缀上限（确定性元数据拼出来，不该长）

# A-7 Contextual Retrieval（确定性版，不调 LLM、不花 BYOK 钱）：
# 入库时给每条原文加一段【从元数据确定性拼出来的上下文前缀】再一起 embed，
# 让"找我三月那份效果好的""上次双十一那条"这类带场景/时间/效果意图的查询也能命中。
# 审计建议的是 LLM 生成前缀——这里用元数据确定性拼，更省、更稳、可重复测。

# input_params 里【最能表意图/活动】的键（按优先级，命中第一个非空即用）
_INTENT_KEYS = ("scenario", "topic", "activity", "prompt", "customer_name", "extra_note")

# 月份数字 → 中文月（让"三月"这类查询能与前缀里的"3月"经词面 bigram 互相命中）
_CN_MONTH = {1: "一月", 2: "二月", 3: "三月", 4: "四月", 5: "五月", 6: "六月",
             7: "七月", 8: "八月", 9: "九月", 10: "十月", 11: "十一月", 12: "十二月"}


def _cn_month(ts: str) -> str:
    """从 ISO 时间串里抠出月份，给出中文月（如 '3月/三月'）；抠不出返回空。"""
    try:
        mm = int(str(ts)[5:7])
        if 1 <= mm <= 12:
            return f"{mm}月/{_CN_MONTH[mm]}"
    except (ValueError, TypeError):
        pass
    return ""


def build_context_prefix(meta: dict | None) -> str:
    """从生成记录的元数据【确定性】拼一段上下文前缀（不调 LLM）。

    拼入：场景(sub_type) · 日期(YYYY-MM-DD + 中文月) · 意图/活动(input_params) · 效果好(评级/收藏)。
    全空则返回空串（不硬塞前缀）。形如：【朋友圈 · 2026-03-08 3月/三月 · 双十一五折 · 效果好】
    """
    meta = meta or {}
    parts: list[str] = []

    sub_type = (meta.get("sub_type") or "").strip()
    if sub_type:
        parts.append(sub_type)

    ts = str(meta.get("ts") or meta.get("created_at") or "").strip()
    if ts:
        date_part = ts[:10]  # YYYY-MM-DD
        cn = _cn_month(ts)
        parts.append(f"{date_part} {cn}".strip() if cn else date_part)

    params = meta.get("input_params") or {}
    if isinstance(params, dict):
        for k in _INTENT_KEYS:
            v = params.get(k)
            if isinstance(v, str) and v.strip():
                parts.append(v.strip()[:40])
                break

    # 效果好：显式好评 或 收藏 → 加"效果好"，让"效果好的"类查询命中
    if (str(meta.get("effect_rating") or "").lower() == "good") or meta.get("is_favorite"):
        parts.append("效果好")

    if not parts:
        return ""
    return ("【" + " · ".join(parts) + "】")[:_MAX_PREFIX]


def _content_fingerprint(text: str, ts: str, meta: dict | None, embedder) -> str:
    """一条记录入库内容的指纹：覆盖原文 + 时间 + 拼前缀用的元数据 + 嵌入器身份(名/维度)。
    源记录被编辑（含改文案/标题/评级/收藏）或换了嵌入后端，指纹都会变 → 补建时据此重嵌、不留陈旧向量。"""
    sig = [getattr(embedder, "name", "?"), int(getattr(embedder, "dim", 0) or 0)]
    payload = json.dumps([text, ts, meta or {}, sig], sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def index_text(store_id, source_type: str, source_id: str, text: str, ts: str = "",
               meta: dict | None = None, fp: str = "") -> None:
    if not text or not text.strip():
        return
    # A-7：带元数据则在原文前拼确定性上下文前缀，一起 embed（前缀也进索引文本，召回时能命中）
    prefix = build_context_prefix({**(meta or {}), "ts": ts}) if (meta or ts) else ""
    body = text[:_MAX_INDEX_TEXT]
    indexed = f"{prefix}\n{body}" if prefix else body
    emb = get_embedder().embed(indexed)
    index_store.upsert(str(store_id), source_type, str(source_id), indexed, emb, ts, fp=fp)


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

        done = index_store.existing_fingerprints(str(store_id), "generation")
        embedder = get_embedder()
        rows = (await db.execute(
            select(
                Generation.id, Generation.title, Generation.result, Generation.created_at,
                Generation.sub_type, Generation.input_params,
                Generation.effect_rating, Generation.is_favorite,
            )
            .where(Generation.store_id == store_id, Generation.is_deleted == False)  # noqa: E712
            .order_by(Generation.created_at.desc())
            .limit(limit)
        )).all()
        n = 0
        for gid, title, result, created, sub_type, input_params, effect_rating, is_favorite in rows:
            sid = str(gid)
            text = ((title or "") + "\n" + (result or "")).strip()
            if not text:
                continue
            # A-7：把场景/意图/效果等元数据带上，index_text 拼成确定性上下文前缀一起 embed
            meta = {
                "sub_type": sub_type,
                "input_params": input_params,
                "effect_rating": effect_rating,
                "is_favorite": is_favorite,
            }
            ts = str(created or "")
            fp = _content_fingerprint(text, ts, meta, embedder)
            # 指纹一致 = 内容/元数据/嵌入后端都没变 → 跳过；变了（被编辑/换后端）才重嵌
            if done.get(sid) == fp:
                continue
            index_text(store_id, "generation", sid, text, ts=ts, meta=meta, fp=fp)
            n += 1
        return n
    except Exception:
        logger.exception("RAG 补建索引失败（忽略，仍可召回已索引部分）")
        return 0
