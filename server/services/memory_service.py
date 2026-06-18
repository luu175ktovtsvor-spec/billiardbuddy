# -*- coding: utf-8 -*-
"""店脑（AI 记忆中枢）核心服务。

职责：从交互里抽取门店记忆、把新旧记忆整合成去重最新的一份、格式化注入 prompt。
设计要点（来自真实评估的结论）：
- 用 DeepSeek JSON 模式做抽取/整合（已验证支持且可靠）。
- consolidate 直接返回**整合后的最终列表**（不是 ADD/UPDATE 操作）——绕开标签模糊，按结果对错衡量。
- 严禁编造：prompt 明确"没提到的不写"，并在评估里用防幻觉用例守住。
- 验收标准见 tests/eval_store_brain.py。
"""
import json
import logging
import uuid
from dataclasses import dataclass

import httpx
from openai import AsyncOpenAI
from sqlalchemy import select, delete, text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db.session import async_session
from models.store_memory import StoreMemory

logger = logging.getLogger(__name__)


@dataclass
class Memory:
    type: str             # semantic | preference | operational | episodic
    content: str
    confidence: str = "medium"


_TYPE_MAP = {
    "semantic": "semantic", "语义事实": "semantic", "语义": "semantic", "事实": "semantic",
    "preference": "preference", "偏好": "preference",
    "operational": "operational", "运营模式": "operational", "运营": "operational",
    "episodic": "episodic", "情景": "episodic", "事件": "episodic",
}
_CONF_MAP = {"high": "high", "medium": "medium", "low": "low", "高": "high", "中": "medium", "低": "low"}


def _norm_type(t: str) -> str:
    return _TYPE_MAP.get((t or "").strip(), "semantic")


def _norm_conf(c: str) -> str:
    return _CONF_MAP.get((c or "").strip(), "medium")


_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url=settings.deepseek_base_url,
            api_key=settings.deepseek_api_key,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
    return _client


def _provider_client_and_model(store=None) -> tuple[AsyncOpenAI, str]:
    """按门店路由记忆调用：BYOK 门店用自己的 key/base_url/model（让店脑学习与正文生成走同一 key、
    成本归属一致）；否则平台默认。解密失败安全回退平台。"""
    if store is not None and getattr(store, "byok_enabled", False) and getattr(store, "byok_api_key_enc", None):
        from core.crypto import try_decrypt
        key = try_decrypt(store.byok_api_key_enc)
        if key:
            return (
                AsyncOpenAI(
                    base_url=getattr(store, "byok_base_url", None) or settings.deepseek_base_url,
                    api_key=key,
                    timeout=httpx.Timeout(120.0, connect=10.0),
                ),
                getattr(store, "byok_model", None) or settings.text_model_name,
            )
    return _get_client(), settings.text_model_name


async def _json_call(system: str, user: str, store=None) -> dict:
    """调 JSON 模式（BYOK 门店走门店自带模型），解析失败返回 {}（不抛，调用方兜底）。"""
    client, model = _provider_client_and_model(store)
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={"type": "json_object"},
        temperature=0,  # 记忆抽取/整合求稳定可复现，温度拉到 0
        max_tokens=900,
    )
    raw = resp.choices[0].message.content or ""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("memory_service JSON 解析失败: %s", raw[:200])
        return {}


_EXTRACT_SYS = (
    "你是门店记忆抽取器。从下面这段门店对话/内容里，抽取值得长期记住的信息，输出 JSON。\n"
    "规则：\n"
    "1. 只抽对话里**明确说了**或**能可靠推断**的；**绝不编造没提到的信息**"
    "（没提价格就不写价格，没提助教/包厢就不写）。\n"
    "2. 否定也要如实记（说'没有包厢'就记'没有包厢'，不能记成有）。\n"
    "3. 每条精炼成一句可复用的事实/偏好；天气、吃饭等与门店运营无关的闲聊不要记。\n"
    "type 取值（英文）：semantic(门店客观事实) | preference(老板的风格/喜好) | "
    "operational(运营模式/客流节奏) | episodic(发生过的具体事件)\n"
    '格式：{"memories":[{"type":"semantic","content":"...","confidence":"high|medium|low"}]}\n'
    '没有值得记的就返回 {"memories":[]}。'
)

_CONSOLIDATE_SYS = (
    "你是门店记忆整合器。给你这家店的【已有记忆】和【新记忆】，"
    "合并成一份**去重、最新**的完整记忆列表，输出 JSON。\n"
    "规则：\n"
    "1. 同一件事有了新值（改价、数量变化等）→ 用新的**替换**旧的，**不要两条都留**。\n"
    "2. 重复或只是换个说法 → 合并成**一条**。\n"
    "3. 互相矛盾 → 以**新记忆**为准。\n"
    "4. 不同的事实 → 都保留。\n"
    "5. 新记忆没带来新信息 → 保留已有那条即可。\n"
    "6. 情景类(发生过的事)只留最近、最重要的；零碎或过时的旧情景合并成一句简短总结，不要无限堆积。\n"
    "输出整合后的**完整列表**（是结果列表，不是操作指令）。\n"
    "type：semantic|preference|operational|episodic\n"
    '格式：{"memories":[{"type":"...","content":"...","confidence":"high|medium|low"}]}'
)


def _to_memories(data: dict) -> list[Memory]:
    out: list[Memory] = []
    for m in (data.get("memories") or []):
        content = (m.get("content") or "").strip()
        if content:
            out.append(Memory(_norm_type(m.get("type")), content, _norm_conf(m.get("confidence"))))
    return out


async def extract_memories(interaction_text: str, store=None) -> list[Memory]:
    """从一次交互（对话/生成需求/反馈）里抽取值得长期记住的门店记忆。store 给定且 BYOK 则走门店模型。"""
    if not interaction_text or not interaction_text.strip():
        return []
    return _to_memories(await _json_call(_EXTRACT_SYS, interaction_text.strip(), store))


async def consolidate_memories(existing: list[Memory], new: list[Memory], store=None) -> list[Memory]:
    """把新记忆并入已有记忆，返回去重、最新的**完整列表**。store 给定且 BYOK 则走门店模型。
    解析失败时兜底返回并集（宁可暂时重复，也不丢信息）。"""
    if not new:
        return list(existing)
    payload = (
        "【已有记忆】\n"
        + json.dumps([{"type": m.type, "content": m.content} for m in existing], ensure_ascii=False)
        + "\n【新记忆】\n"
        + json.dumps([{"type": m.type, "content": m.content} for m in new], ensure_ascii=False)
    )
    merged = _to_memories(await _json_call(_CONSOLIDATE_SYS, payload, store))
    return merged if merged else list(existing) + list(new)


# 店脑按需召回阈值：记忆多于这个数才启用相关性筛选（少则全留，无 context rot 风险）
_MEMORY_INJECT_CAP = 15


def select_relevant_memories(memories: list[Memory], intent, cap: int = _MEMORY_INJECT_CAP) -> list[Memory]:
    """按需召回：记忆多于 cap 时，只留与当前需求【语义最相关】的 cap 条（+置信度加权）。

    解决"店脑全量注入"——量大了把整包记忆塞进 prompt 会触发 context rot（弱模型召回变差）、
    还白烧 BYOK token。改成按相关性召回相关的几条。少于 cap 或无 intent → 全留（向后兼容）。
    用 RAG 嵌入器做【内存内】排序，不碰持久索引（记忆可编辑，避免同步问题）；失败安全回退全量。
    """
    if not memories or not intent or not str(intent).strip() or len(memories) <= cap:
        return memories
    try:
        from services.rag.embedder import get_embedder, cosine
        emb = get_embedder()
        q = emb.embed(str(intent))
        bonus = {"high": 0.10, "medium": 0.0, "low": -0.05}
        scored = [
            (cosine(q, emb.embed(m.content or "")) + bonus.get(getattr(m, "confidence", "medium"), 0.0), m)
            for m in memories
        ]
        scored.sort(key=lambda x: x[0], reverse=True)
        return [m for _, m in scored[:cap]]
    except Exception:
        return memories  # 召回失败不影响主流程，回退全量


def format_memories_for_prompt(memories: list[Memory], intent=None) -> str:
    """把店脑格式化成注入 prompt 的稳定前缀文本（空记忆返回空串）。
    传 intent 则先按需召回相关记忆（避免全量注入撑大 prompt）；不传则全留。"""
    if not memories:
        return ""
    if intent:
        memories = select_relevant_memories(memories, intent)
    lines = "\n".join(f"- {m.content}" for m in memories)
    return (
        "【这家店的最新记忆（AI 长期积累的最新最准信息；写内容时**如与其他门店资料/价格冲突，一律以这里为准**；"
        "自然运用、不要照抄、不要无关硬塞）】\n" + lines
    )


def with_store_brain(prompt: str, memories: list[Memory], intent=None) -> str:
    """把店脑记忆追加到 prompt **末尾**后返回；空记忆时原样返回。

    ⚠️ 必须放在 prompt 末尾（近因效应压过前面 profile 里的旧画像，实现"改价/纠错优先"）——
    这是耦合契约：在它之后再 append 任何段落都会让该优先级静默失效。
    （与 stream.py 的注入位置/语义保持一致，供所有非流式路径复用。）
    """
    brain = format_memories_for_prompt(memories, intent=intent)
    return f"{prompt}\n\n{brain}" if brain else prompt


# ── 持久化 + 学习流（DB）─────────────────────────────────────────
# 所有查询显式按 store_id 过滤 → 绕开租户自动过滤的"无上下文 fail-safe"，无需 set_tenant。

def _sid(store_id) -> uuid.UUID:
    return store_id if isinstance(store_id, uuid.UUID) else uuid.UUID(str(store_id))


async def load_store_memory(db: AsyncSession, store_id) -> list[Memory]:
    """读一家店的全部记忆。"""
    rows = (
        await db.execute(
            select(StoreMemory)
            .where(StoreMemory.store_id == _sid(store_id))
            .order_by(StoreMemory.created_at)
        )
    ).scalars().all()
    return [Memory(r.type, r.content, r.confidence) for r in rows]


async def _replace_store_memory(db: AsyncSession, store_id, memories: list[Memory]) -> None:
    """用整合后的列表整体替换该店记忆（delete + insert）。"""
    sid = _sid(store_id)
    await db.execute(delete(StoreMemory).where(StoreMemory.store_id == sid))
    for m in memories:
        db.add(StoreMemory(store_id=sid, type=m.type, content=m.content, confidence=m.confidence))
    await db.commit()


# 上限：防止店脑无限膨胀（耐久事实全留；情景类是会累积的，单独设较小上限）
_EPISODIC_CAP = 25
_TOTAL_CAP = 150


def _cap_memories(memories: list[Memory]) -> list[Memory]:
    """加上限防膨胀：耐久类(事实/偏好/运营模式)全留，情景类只留最近若干条，再封顶总数。"""
    durable = [m for m in memories if m.type != "episodic"]
    episodic = [m for m in memories if m.type == "episodic"]
    return (durable + episodic[-_EPISODIC_CAP:])[:_TOTAL_CAP]


async def remember(db: AsyncSession, store_id, interaction_text: str) -> list[Memory]:
    """从一次交互学习：抽取 → 与已有整合 → 存，返回整合后的店脑。
    设计为后台调用：失败静默（不影响主流程），不计用户配额。
    **并发安全**：用每店事务级咨询锁串行化同一家店的学习，根治"删全部再插入"的丢记忆竞态。"""
    try:
        from models.store import Store
        store = await db.get(Store, _sid(store_id))  # 取门店 BYOK 配置：开启则店脑学习也走门店自带 key
        new = await extract_memories(interaction_text, store)
        if not new:
            return await load_store_memory(db, store_id)
        # 同店并发学习串行化（锁随本事务 commit/回滚释放；只挡同店、不挡跨店，不影响吞吐）
        # 仅 PostgreSQL 有 pg_advisory_xact_lock；桌面本地版 SQLite 单写、无多 worker 竞态，no-op 跳过即可。
        if db.bind.dialect.name == "postgresql":
            await db.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                {"k": f"store_memory:{store_id}"},
            )
        existing = await load_store_memory(db, store_id)
        merged = await consolidate_memories(existing, new, store) if existing else new
        merged = _cap_memories(merged)
        await _replace_store_memory(db, store_id, merged)
        return merged
    except Exception:
        logger.exception("memory_service.remember 失败 store_id=%s", store_id)
        return []


async def learn_in_background(store_id, text: str) -> None:
    """后台学习封装：开独立 session 调 remember。供生成/反馈等后台调用，失败静默、不计配额。"""
    if not text or not text.strip():
        return
    try:
        async with async_session() as bg_db:
            await remember(bg_db, store_id, text)
    except Exception:
        logger.exception("店脑后台学习失败 store_id=%s", store_id)
