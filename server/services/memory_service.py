# -*- coding: utf-8 -*-
"""店脑（AI 记忆中枢）核心服务。

职责：从交互里抽取门店记忆、把新旧记忆整合成去重最新的一份、格式化注入 prompt。
设计要点（来自真实评估的结论）：
- 用 DeepSeek JSON 模式做抽取/整合（已验证支持且可靠）。
- consolidate 直接返回**整合后的最终列表**（不是 ADD/UPDATE 操作）——绕开标签模糊，按结果对错衡量。
- 严禁编造：prompt 明确"没提到的不写"，并在评估里用防幻觉用例守住。
- 验收标准见 tests/eval_store_brain.py。
"""
import hashlib
import json
import logging
import os
import re
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
    source: str = "auto"  # manual=老板亲定的店规矩(AI 绝不删改、注入最高优先) | auto=AI 学到


def memory_reference_labels(memories: list[Memory], intent=None, limit: int = 5) -> list[str]:
    """给前端展示的“用了这些资料”摘要；与 prompt 召回同源，pending 不会出现在这里。"""
    if not memories:
        return []
    selected = select_relevant_memories(memories, intent) if intent else memories
    out: list[str] = []
    for m in selected:
        content = (m.content or "").strip().replace("\n", " ")
        if not content:
            continue
        out.append(content[:36] + ("…" if len(content) > 36 else ""))
        if len(out) >= limit:
            break
    return out


_TYPE_MAP = {
    "semantic": "semantic", "语义事实": "semantic", "语义": "semantic", "事实": "semantic",
    "preference": "preference", "偏好": "preference",
    "operational": "operational", "运营模式": "operational", "运营": "operational",
    "episodic": "episodic", "情景": "episodic", "事件": "episodic",
}
_CONF_MAP = {"high": "high", "medium": "medium", "low": "low", "高": "high", "中": "medium", "低": "low"}
_WORKDIR_MARK_RE = re.compile(r"^【工作目录:([^】]+)】\s*")


def _norm_type(t: str) -> str:
    return _TYPE_MAP.get((t or "").strip(), "semantic")


def _norm_conf(c: str) -> str:
    return _CONF_MAP.get((c or "").strip(), "medium")


def canon_workdir_path(path: str | None) -> str:
    """工作目录归一成可比较的规范路径（展开 ~ + 绝对路径 + 去尾斜杠）。

    marker 写入(store_memory)与召回匹配(本文件)共用这一把尺，保证项目记忆**按完整路径隔离**——
    不同位置但同名的两个文件夹(如桌面/下载里都叫「素材」)不会互相串记忆。
    """
    raw = (path or "").strip()
    if not raw:
        return ""
    try:
        return os.path.abspath(os.path.expanduser(raw)).rstrip("/\\")
    except Exception:
        return raw.rstrip("/\\")


def _workdir_keys(path: str | None) -> set[str]:
    """当前工作目录的可比较 key 集：完整规范路径 + 原始/展开变体（容忍 marker 的轻微格式差）。

    **不含纯文件夹名**——否则不同路径下的同名目录会互相串记忆。改用完整路径隔离（2026-06-28）。
    """
    raw = (path or "").strip()
    if not raw:
        return set()
    keys = {raw, raw.rstrip("/\\"), os.path.expanduser(raw).rstrip("/\\"), canon_workdir_path(raw)}
    return {k for k in keys if k}


def _memory_workdir(content: str | None) -> str | None:
    m = _WORKDIR_MARK_RE.match(content or "")
    return m.group(1).strip() if m else None


def _strip_workdir_mark(content: str | None) -> str:
    return _WORKDIR_MARK_RE.sub("", content or "").strip()


def memory_matches_workdir(content: str | None, working_dir: str | None) -> bool:
    """带工作目录标签的记忆只在对应工作目录召回；无标签记忆是门店/用户全局记忆。"""
    scope = _memory_workdir(content)
    if not scope:
        return True
    return scope in _workdir_keys(working_dir)


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


async def _json_call(system: str, user: str, store=None, max_tokens: int = 2000) -> dict:
    """调 JSON 模式（BYOK 门店走门店自带模型），解析/调用失败返回 {}（不抛，调用方兜底）。
    店脑学习是【辅助功能】：没配 key（纯 BYOK 未配 → 构造空 key client 即报错）或 provider 任何报错，
    都静默跳过、绝不让主对话崩——"还没配 key"的友好引导由主生成的 503 守卫负责给。
    1-2 修复：显式关思考（MiMo 默认开，reasoning 会把 max_tokens 挤光、JSON 被截断 → 静默返回 {}，
    店脑一直学不到东西）；max_tokens 默认 900 → 2000 留余量。temperature=0 在关思考后才真正生效。"""
    try:
        client, model = _provider_client_and_model(store)
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=max_tokens,
            extra_body={"thinking": {"type": "disabled"}},
        )
        raw = resp.choices[0].message.content or ""
    except Exception as e:
        logger.warning("memory_service 调用失败(辅助功能，已跳过): %s", type(e).__name__)
        return {}
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
    "4. **一次性任务诉求/临时情景不要记**：用户让做海报、写文案、做个图、查个数据——这些是临时指令；"
    "还有【为完成这次任务顺带提到的一次性情景】也不要记——比如'某客户多久没来了(让你写挽回话)'、"
    "'今天/这次的待办或安排(让你列清单)'、'这次活动的临时细节'——这些是任务上下文、不是长期门店事实，**不要抽取**。\n"
    "   反例(不要记)：'老顾客小张半个月没来'、'今天安排上午盘货下午发抖音'。\n"
    "   正例(可记)：'本店主打学生和竞技客群'、'老板偏好简洁直接的文案'、'周二会员日台费五折'。\n"
    "5. **confidence 就是路由**：客观门店事实(价格/设施/规则等明确信息) → confidence:\"high\"；"
    "老板的风格/语气/喜好 → type 写 preference；**拿不准是不是长期事实、或者信息不全**"
    "（说得模糊、可能只是这次的特殊情况、不确定会不会一直有效）→ 标**低置信**（confidence:\"low\"），"
    "交人工确认，别硬记成 high。\n"
    "type 取值（英文）：semantic(门店客观事实) | preference(老板的风格/喜好) | "
    "operational(运营模式/客流节奏) | episodic(发生过的具体事件)\n"
    '格式：{"memories":[{"type":"semantic","content":"...","confidence":"high|medium|low"}]}\n'
    '没有值得记的就返回 {"memories":[]}。'
)

_TASK_PATTERNS = re.compile(
    r"^(帮我|请|麻烦|给我|我想|帮忙)?(把.{0,12}?)?"
    r"(做|写|画|生成|制作|设计|弄|搞|出|来|想|列|算|查|看看|拟|编|排|回复?)(一?[张个份篇条幅])?",
)

_REDLINE_PATTERNS = re.compile(
    r"陪伴服务|陪侍|性服务|色情|卖淫|嫖|赌[场博]|坐庄|抽水|定盘口|放高利贷|洗钱|贩毒",
)

_BILLIARDS_MEMORY_PATTERNS = re.compile(
    r"台球|球房|球馆|球厅|球台|台费|开台|翻台|助教|陪打|陪练|教练|前厅|收银|店长|"
    r"会员卡|一卡通|充值|团购|美团|大众点评|抖音同城|小红书|好评|周赛|会员赛|"
    r"追分|彩头|包厢|吧台|商品费|器材|球杆|台泥|竞技客户|散客|客流|到店|拉客"
)


def _is_one_off_task(text: str) -> bool:
    text = text.strip()
    if len(text) > 80:
        return False
    return bool(_TASK_PATTERNS.search(text))


_CLAUSE_SPLIT_RE = re.compile(r"[。！？；，、\n]+")


def _split_clauses(text: str) -> list[str]:
    """按中文标点把文本切成小句，用于按小句判断"是不是纯一次性任务"（M4尾巴①）。"""
    return [c.strip() for c in _CLAUSE_SPLIT_RE.split(text) if c.strip()]


def _extract_key_phrases(text: str) -> list[str]:
    """从文本提取关键短语（2~6字的中文/英文连续片段）用于接地校验。不依赖分词库。"""
    phrases: list[str] = []
    for seg in re.findall(r"[一-鿿]+", text):
        for length in (4, 3, 2):
            for i in range(len(seg) - length + 1):
                phrases.append(seg[i:i + length])
    phrases.extend(re.findall(r"[a-zA-Z]{3,}", text))
    phrases.extend(re.findall(r"\d{2,}", text))
    return phrases


_HARD_SIGNAL_RE = re.compile(r"\d{2,}|[a-zA-Z]{3,}")


def _grounding_check(memory: Memory, source_text: str) -> bool:
    """接地校验：防"凭空脑补没提过的信息"（M4尾巴②）。
    - 硬信号（数字/长英文串）是改写也不会变的强证据：记忆里若带硬信号，必须原样出现在源文，
      否则直接判脑补——这条不因下面阈值下调而放松，护栏没塌。
    - 字面短语（2~4字中文片段）重叠比例阈值从 30% 降到 20%：容忍纯措辞层面的重度改写造成的
      字面误杀（LLM 把事实换了种说法，短语重叠天然会降，但没编造新信息就不该被误杀）。
    """
    content = memory.content or ""
    source_lower = source_text.lower()
    for sig in _HARD_SIGNAL_RE.findall(content):
        if sig.lower() not in source_lower:
            return False
    phrases = _extract_key_phrases(content)
    if not phrases:
        return True
    matched = sum(1 for p in phrases if p.lower() in source_lower)
    return matched / len(phrases) >= 0.2


def _redline_filter(memory: Memory) -> bool:
    """红线过滤：记忆内容触犯安全红线则丢弃。"""
    return not bool(_REDLINE_PATTERNS.search(memory.content))


def memory_is_billiards_domain(memory: Memory) -> bool:
    """判断一条记忆是否属于台球门店事实。

    通用 Agent 也应该有长期记忆，但不能把“26 张台、台费、助教、周赛”这类门店事实
    带进普通文件/代码/合同任务。没有台球行业词的偏好和用户习惯（如“老板喜欢简洁”）
    仍可在通用模式注入。
    """
    return bool(_BILLIARDS_MEMORY_PATTERNS.search(memory.content or ""))


def filter_memories_for_mode(memories: list[Memory], billiards_mode: bool) -> list[Memory]:
    """按当前行业包过滤可注入记忆。

    - @台球：全部确认记忆可注入。
    - 通用：只注入非台球领域的长期偏好/用户事实，避免门店旧资料污染普通任务。
    """
    if billiards_mode:
        return memories
    return [m for m in memories if not memory_is_billiards_domain(m)]

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
    """从一次交互（对话/生成需求/反馈）里抽取值得长期记住的门店记忆。store 给定且 BYOK 则走门店模型。
    抽取后三道过滤：一次性任务跳过 → 接地校验 → 红线过滤。

    M4尾巴①：一次性任务判定按【小句】拆开看，不再整句一杆子跳过——混合句
    （"帮我写个海报，对了我们店周二会员日台费五折"）只要有一句不像纯任务，就照常送抽取器
    （抽取器 system prompt 本就有"一次性任务不记"的规则，会正确只留事实那条）；
    纯一次性任务（每个小句都像指令）仍整句跳过、不白烧一次 LLM 调用。"""
    if not interaction_text or not interaction_text.strip():
        return []
    text = interaction_text.strip()
    clauses = _split_clauses(text)
    if clauses and all(_is_one_off_task(c) for c in clauses):
        return []
    raw = _to_memories(await _json_call(_EXTRACT_SYS, text, store))
    return [m for m in raw if _grounding_check(m, text) and _redline_filter(m)]


async def consolidate_memories(existing: list[Memory], new: list[Memory], store=None) -> list[Memory]:
    """把新记忆并入已有记忆，返回去重、最新的**完整列表**。store 给定且 BYOK 则走门店模型。

    M4尾巴③：整合失败（LLM 偶发失败/超时返回空）时不再把新记忆整批丢掉——
    走【有界兜底】：existing+new 按 content 去重后拼上，再交给已有的 _cap_memories() 封顶。
    这样既不丢新学到的事实，也不会无限膨胀（_cap 本身就是膨胀护栏，没被绕开）。"""
    if not new:
        return list(existing)
    payload = (
        "【已有记忆】\n"
        + json.dumps([{"type": m.type, "content": m.content} for m in existing], ensure_ascii=False)
        + "\n【新记忆】\n"
        + json.dumps([{"type": m.type, "content": m.content} for m in new], ensure_ascii=False)
    )
    token_budget = max(4096, len(payload) // 2)
    merged = _to_memories(await _json_call(_CONSOLIDATE_SYS, payload, store, max_tokens=token_budget))
    if merged:
        return merged
    logger.warning("consolidate_memories 整合失败，走有界兜底（保留新记忆+去重+封顶，不再整批丢弃）")
    seen: set[str] = set()
    fallback: list[Memory] = []
    for m in list(existing) + list(new):
        if m.content in seen:
            continue
        seen.add(m.content)
        fallback.append(m)
    return _cap_memories(fallback)


# 店脑按需召回阈值：记忆多于这个数才启用相关性筛选（少则全留，无 context rot 风险）
_MEMORY_INJECT_CAP = 15

# episodic（"发生过的具体事件"，如"老顾客小张半个月没来""今天安排盘货"）相关性下限：
# 这类一次性情景【只有跟当前任务相关时才注入】，否则会串到不相关任务里（用户："我问做视频，
# 你提小张干嘛"）。durable（semantic/preference/operational=店规矩/客群/定价/打法）是稳定店情、始终注入。
# 阈值按【装机包内置的 bge 语义嵌入】标定(实测:小张串到"做视频"≈0.385<0.45 被挡;串到"唤回老顾客"
# ≈0.767>0.45 留下)。若 bge 没加载成回退词面嵌器,episodic 一律不注入(那条路判不准,见 select_relevant_memories)。
try:
    _EPISODIC_RELEVANCE_FLOOR = float(os.environ.get("DESKTOP_EPISODIC_RELEVANCE_FLOOR") or 0.45)
except (TypeError, ValueError):
    _EPISODIC_RELEVANCE_FLOOR = 0.45

_embed_cache: dict[str, list[float]] = {}
_embed_cache_hash: str = ""


def _get_cached_embedding(emb, text: str, cache_key: str) -> list[float]:
    """带缓存的嵌入：记忆集合没变就不重嵌入。"""
    global _embed_cache, _embed_cache_hash
    if cache_key != _embed_cache_hash:
        _embed_cache.clear()
        _embed_cache_hash = cache_key
    if text not in _embed_cache:
        _embed_cache[text] = emb.embed(text)
    return _embed_cache[text]


def _memories_hash(memories: list[Memory]) -> str:
    h = hashlib.md5()
    for m in memories:
        h.update((m.content or "").encode())
    return h.hexdigest()


def select_relevant_memories(memories: list[Memory], intent, cap: int = _MEMORY_INJECT_CAP) -> list[Memory]:
    """按需召回：manual（老板亲定的店规矩）**始终全部注入**（不进 cap、最高优先、绝不被挤掉）；
    auto 记忆多于 cap 时，只留与当前需求【语义最相关】的 cap 条（+置信度加权）。

    解决"店脑全量注入"——auto 量大了把整包塞进 prompt 会触发 context rot（弱模型召回变差）、
    还白烧 BYOK token。改成 auto 按相关性召回。auto 少于 cap 或无 intent → auto 全留（向后兼容）。
    用 RAG 嵌入器做【内存内】排序，不碰持久索引（记忆可编辑，避免同步问题）；失败安全回退 auto 全量。
    返回顺序：manual 在前（最高优先），auto 在后。
    """
    if not memories:
        return memories
    manual = [m for m in memories if getattr(m, "source", "auto") == "manual"]
    auto = [m for m in memories if getattr(m, "source", "auto") != "manual"]
    if not intent or not str(intent).strip():
        return manual + auto  # 无意图(如批量/无上下文)：全留，向后兼容
    # durable=稳定店情(始终注入)；episodic=一次性情景(发生过的事)。
    # ★ episodic 不靠注入也在场——用户要做的任务相关的一次性情景，本来就在【当前这句话里】
    #   (例:"有个老顾客小张半个月没来,帮我写挽回话"——小张就在输入里,模型看得到)。
    #   所以 episodic 只该在【真能判准相关性】时按需注入,判不准就别注入,否则纯噪音串台。
    durable = [m for m in auto if getattr(m, "type", "") != "episodic"]
    episodic = [m for m in auto if getattr(m, "type", "") == "episodic"]
    try:
        from services.rag.embedder import get_embedder, cosine
        emb = get_embedder()
        cache_key = _memories_hash(auto)
        q = emb.embed(str(intent))

        def _sim(m):
            return cosine(q, _get_cached_embedding(emb, m.content or "", cache_key))
        bonus = {"high": 0.10, "medium": 0.0, "low": -0.05}
        # episodic：只有【语义嵌器(真bge)】才信它的相关性,过下限才注入;
        #           词面回退嵌器判不准(实测"盘货todo"对"列今日清单"反而比对"做视频"还低)→ 一律不注入,防串台。
        if getattr(emb, "semantic", False):
            kept_epi = [m for m in episodic if _sim(m) >= _EPISODIC_RELEVANCE_FLOOR]
        else:
            kept_epi = []
        # durable：≤cap 全留(店情就该一直在场)；多了才按相关性截到 cap，防 context rot
        if len(durable) <= cap:
            kept_dur = durable
        else:
            kept_dur = sorted(
                durable,
                key=lambda m: _sim(m) + bonus.get(getattr(m, "confidence", "medium"), 0.0),
                reverse=True,
            )[:cap]
        return manual + kept_dur + kept_epi
    except Exception:
        # 嵌入异常(极少)：店情全留；episodic 无法判定相关性 → 不注入(宁缺毋滥防串台)。
        return manual + durable


def format_memories_for_prompt(memories: list[Memory], intent=None) -> str:
    """把店脑格式化成注入 prompt 的稳定前缀文本（空记忆返回空串）。
    传 intent 则先按需召回相关记忆（避免全量注入撑大 prompt）；不传则全留。

    分两段：manual（老板亲定的店规矩）单独成块、标"优先级最高·冲突以此为准"；auto 保持原样。
    """
    if not memories:
        return ""
    if intent:
        memories = select_relevant_memories(memories, intent)
    manual = [m for m in memories if getattr(m, "source", "auto") == "manual"]
    auto = [m for m in memories if getattr(m, "source", "auto") != "manual"]
    blocks: list[str] = []
    if manual:
        blocks.append(
            "【店主亲自定的店规矩·优先级最高·与其它资料冲突时以此为准（必须严格遵守，不得违背）】\n"
            + "\n".join(f"- {m.content}" for m in manual)
        )
    if auto:
        blocks.append(
            "【这家店的最新记忆（AI 长期积累的最新最准信息）】\n"
            "（用法：**回答关于本店的问题**——卖什么、有没有某项、哪个套餐/活动火、客流规律、店里定的做法等"
            "——优先用下面这些记忆直接答，**别张口说『没数据/没报表』**，除非这里确实没有；"
            "写内容时如与其他门店资料/价格冲突一律以这里为准；自然运用、不要照抄、不要无关硬塞。"
            "**但用户在本次对话中明确说的信息优先于这里的旧记忆**——"
            "例如用户说'台费改成80了'，即使记忆里写60，也以用户本次所说为准。）\n"
            + "\n".join(f"- {m.content}" for m in auto)
        )
    return "\n\n".join(blocks)


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
    """读一家店已确认/可注入的记忆（manual + auto；pending 候选不进 prompt）。"""
    rows = (
        await db.execute(
            select(StoreMemory)
            .where(StoreMemory.store_id == _sid(store_id))
            .where(StoreMemory.is_deleted == False)  # noqa: E712
            .where(StoreMemory.source != "pending")
            .order_by(StoreMemory.created_at)
        )
    ).scalars().all()
    return [
        Memory(r.type, r.content, r.confidence, getattr(r, "source", None) or "auto")
        for r in rows
    ]


async def load_scoped_store_memory(db: AsyncSession, store_id, working_dir: str | None = None) -> list[Memory]:
    """按工作目录过滤后的可注入记忆。

    - 普通记忆：始终可用。
    - `【工作目录:xxx】...` 项目记忆：只有当前工作目录匹配 xxx 时可用。
    - 当前没有工作目录：不注入任何项目记忆，避免 A 项目背景污染 B 会话。
    """
    memories = await load_store_memory(db, store_id)
    out: list[Memory] = []
    for m in memories:
        if not memory_matches_workdir(m.content, working_dir):
            continue
        out.append(Memory(m.type, _strip_workdir_mark(m.content), m.confidence, m.source))
    return out


async def _replace_store_memory(db: AsyncSession, store_id, memories: list[Memory]) -> None:
    """只替换该店的 **auto 记忆**（delete + insert），manual（老板亲定的店规矩）原样保留绝不删改。

    `memories` 是整合后的【auto 列表】；只删 source!='manual' 的旧行，再插入新 auto 行。
    manual 行不在删除范围、也不重复插入 → 老板手填的店规矩永远不被 AI 覆盖。
    """
    sid = _sid(store_id)
    await db.execute(
        delete(StoreMemory).where(
            StoreMemory.store_id == sid,
            StoreMemory.source == "auto",
            StoreMemory.is_deleted == False,  # noqa: E712
        )
    )
    for m in memories:
        db.add(StoreMemory(
            store_id=sid, type=m.type, content=m.content,
            confidence=m.confidence, source="auto",
        ))
    await db.commit()


async def add_pending_memory_candidate(db: AsyncSession, store_id, content: str, type_: str = "semantic") -> StoreMemory | None:
    """把 AI 推断/文件提取出的长期候选先放到 pending，用户确认后才会进入 prompt。"""
    content = (content or "").strip()
    if not content:
        return None
    sid = _sid(store_id)
    exists = await db.scalar(
        select(StoreMemory).where(
            StoreMemory.store_id == sid,
            StoreMemory.content == content,
            StoreMemory.is_deleted == False,  # noqa: E712
        )
    )
    if exists:
        return exists
    row = StoreMemory(
        store_id=sid,
        type=type_,
        content=content[:1200],
        confidence="low",
        source="pending",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


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
    **并发安全**：用每店事务级咨询锁串行化同一家店的学习，根治"删全部再插入"的丢记忆竞态。

    F7②置信度分流：抽取出的 new 按 confidence 分两路——
    high（客观门店事实、抽取器判断拿得准）→ 走 auto（consolidate + 落库，即时生效，保住
    "越用越懂你"的即时性）；medium/low（拿不准/信息不全）→ 逐条进 pending 收件箱，
    人审后才生效，不进 auto、不即时注入 prompt（记忆面板 pending 态已现成）。
    manual（老板亲定的店规矩）不受这条分流影响，处理逻辑原样不动。"""
    try:
        from models.store import Store
        store = await db.get(Store, _sid(store_id))  # 取门店 BYOK 配置：开启则店脑学习也走门店自带 key
        new = await extract_memories(interaction_text, store)
        if not new:
            return await load_store_memory(db, store_id)
        new_high = [m for m in new if m.confidence == "high"]
        new_low = [m for m in new if m.confidence != "high"]
        for m in new_low:
            await add_pending_memory_candidate(db, store_id, m.content, m.type)
        if not new_high:
            return await load_store_memory(db, store_id)
        # 同店并发学习串行化（锁随本事务 commit/回滚释放；只挡同店、不挡跨店，不影响吞吐）
        # 仅 PostgreSQL 有 pg_advisory_xact_lock；桌面本地版 SQLite 单写、无多 worker 竞态，no-op 跳过即可。
        if db.bind.dialect.name == "postgresql":
            await db.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                {"k": f"store_memory:{store_id}"},
            )
        all_existing = await load_store_memory(db, store_id)
        # 只管理 auto 记忆：manual（老板亲定的店规矩）拆出来原样保留，绝不进 AI 整合/删改。
        existing_auto = [m for m in all_existing if m.source != "manual"]
        manual = [m for m in all_existing if m.source == "manual"]
        merged_auto = (
            await consolidate_memories(existing_auto, new_high, store) if existing_auto else new_high
        )
        merged_auto = _cap_memories(merged_auto)
        # _replace 只删/换 auto 行，manual 行不动 → 落库后店脑 = manual（原样）+ merged_auto。
        await _replace_store_memory(db, store_id, merged_auto)
        return manual + merged_auto
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
