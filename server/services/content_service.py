import logging
import os
import time
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.exceptions import AIServiceError, AIProviderError
from core.timezone import business_today

from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.prompt_engine import get_prompt_engine, PromptTemplateNotFoundError, PromptVariableMissingError
from services.ai.base import TextRequest
from services.workbench_fewshot_service import select_workbench_fewshots
from services.store_profile_service import render_operation_profile_context
from services.quota_service import check_quota, increment_usage
from services.brand_voice_service import get_brand_voice_context
from services.memory_service import load_store_memory, with_store_brain
from core.security_guard import check_input_injection, filter_output_leak, AI_RESPONSE_PREFIXES
from services.scenario_role_map import SCENARIO_ROLE_MAP

logger = logging.getLogger(__name__)

prompt_engine = get_prompt_engine()


def _validate_provider_for_production() -> None:
    """生产环境禁止使用 mock provider。"""
    if settings.app_env == "production" and settings.text_model_provider == "mock":
        raise AIServiceError("生产环境禁止使用 Mock Provider，请配置真实 AI 模型")


async def run_generation(
    db: AsyncSession,
    store: Store,
    user: User | None,
    *,
    prompt: str,
    gen_type: str,
    sub_type: str | None = None,
    input_params: dict | None = None,
    user_input: str = "",
    max_tokens: int = 3000,
    strip_prefixes: bool = True,
    use_fallback: bool = False,
    thinking: dict | None = None,
) -> Generation:
    """统一生成管道：注入检查 → 配额 → 调AI → 去前缀 → 泄露过滤 → 落库 → 计费。

    所有非流式生成路径必须走这里。历史教训：poster/batch/repurpose/专项服务
    各自手写"渲染→调AI→落库"时，配额/注入/过滤/落库四件套总会漏掉某一环。
    user_input 传用户自由文本（用于注入检查），纯模板渲染场景可传空串。
    """
    if user_input:
        injection_check = check_input_injection(user_input)
        if injection_check:
            raise AIServiceError(injection_check)

    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    # 店脑：注入这家店的长期记忆 → 让所有走统一管道的生成（诊断/绩效/SOP/玩法/约客/变体/批量）
    # 都"懂这家店"。必须追加在 prompt 末尾（近因效应压过旧画像，实现改价/纠错优先），其后不可再 append。
    # 故障安全：店脑读取/格式化失败不影响主生成。
    try:
        prompt = with_store_brain(prompt, await load_store_memory(db, store.id), intent=user_input)
    except Exception:
        logger.warning("run_generation 注入店脑失败，跳过 store_id=%s", store.id, exc_info=True)

    _t0 = time.monotonic()
    request = TextRequest(prompt=prompt, max_tokens=max_tokens, thinking=thinking)
    # 按门店路由：BYOK 门店用自己的 key/base_url/model（token 成本与并发自担）；否则平台默认。
    # （use_fallback 历史上无真备份 provider，已统一走 for_store；参数保留兼容调用方签名）
    provider = ProviderFactory.get_text_provider_for_store(store)
    try:
        response = await provider.generate(request)
    except Exception as e:
        # 把"看不见的失败"记成使用事件(故障安全)，再按原映射抛出——行为与原三段 except 等价
        await _safe_log_generation(store, user, gen_type, sub_type, outcome="failure",
                                   error_type=type(e).__name__, t0=_t0)
        if isinstance(e, AIProviderError):
            raise AIServiceError(e.message, status_code=e.status_code) from e
        if isinstance(e, AIServiceError):
            raise
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    # 可观测性：扫原始输出铁律违反率（对外平台/团购内容尤其敏感，故障安全）
    try:
        from services.usage_event_service import observe_compliance
        await observe_compliance(response.content, store_id=str(store.id), sub_type=sub_type)
    except Exception:
        pass

    content = response.content
    if strip_prefixes:
        content = _strip_ai_prefixes(content)
    content = filter_output_leak(content)

    # B-2 依据可见：input_params 里若没带 knowledge_used（调用方走 _append_guardrails 时会传），
    # 兜个空列表，保证 Generation.input_params 恒有该键、前端拿得到（无依赖即空）。
    final_params = dict(input_params or {})
    final_params.setdefault("knowledge_used", [])

    generation = Generation(
        id=uuid.uuid4(),
        store_id=store.id,
        user_id=user.id if user else None,
        type=gen_type,
        sub_type=sub_type,
        input_params=final_params,
        prompt_used=prompt,
        result=content,
        model_used=response.model,
        tokens_used=response.tokens_used or 0,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)
    await increment_usage(db, str(store.id), tokens=response.tokens_used or 0)
    await _safe_log_generation(store, user, gen_type, sub_type, outcome="success",
                               tokens=response.tokens_used or 0, t0=_t0)
    return generation


async def _safe_log_generation(
    store, user, gen_type: str, sub_type: str | None, *,
    outcome: str, t0: float, tokens: int = 0, error_type: str | None = None,
) -> None:
    """故障安全记录一条 generation 使用事件(成功/失败)，喂版本迭代。绝不影响生成。"""
    try:
        from services.usage_event_service import log_event
        props = {
            "scenario": sub_type or gen_type,
            "gen_type": gen_type,
            "outcome": outcome,
            "latency_ms": int((time.monotonic() - t0) * 1000),
        }
        if tokens:
            props["tokens"] = tokens
        if error_type:
            props["error_type"] = error_type
        await log_event(
            "generation",
            store_id=str(store.id),
            user_id=(str(user.id) if user else None),
            props=props,
        )
    except Exception:
        pass  # 打点绝不影响生成

TONE_LABELS = {
    "lively": "活泼",
    "professional": "专业",
    "friendly": "亲切",
    "humorous": "幽默",
}

SCENARIO_LABELS = {
    "daily": "日常",
    "promotion": "促销",
    "tournament": "赛事",
    "holiday": "节日",
    "evening": "晚间邀约",
    "student": "学生",
    "rainy": "雨天",
}

GROUP_NOTICE_SCENARIO_LABELS = {
    "activity_notice": "活动通知",
    "matchmaking": "约球接龙",
    "group_rule": "群规",
    "newcomer_welcome": "新人欢迎",
    "benefit_notice": "福利通知",
}

ACTIVITY_GOAL_LABELS = {
    "traffic": "拉人气",
    "membership": "卖会员卡",
    "tournament": "做比赛",
    "comeback": "老客回流",
    "student": "学生优惠",
    "community": "搭子群活跃",
    "team_building": "团建包场",
    "holiday": "节日营销",
    "coaching": "陪练推广",
}

BUDGET_LABELS = {
    "light": "轻度优惠",
    "medium": "中度优惠",
    "heavy": "大力优惠",
}

ROLE_LABELS = {
    "boss": "老板",
    "manager": "店长",
    "assistant_manager": "助教管理",
    "coach": "教练 / 赛事负责人",
    "frontdesk": "前厅主管",
    "operator": "运营负责人",
}

CUSTOMER_LABELS = {
    "groupbuy": "散客 / 团购客户",
    "new": "新客户（第 1-2 次到店）",
    "old": "老客户（3 次以上）",
    "competition": "竞技客户",
    "assistant": "助教客户",
    "light_competition": "轻竞技 / 台费局客户",
    "vip": "大客户 / 充值客户",
    "all": "全部客户",
}

OUTPUT_LABELS = {
    "moments": "朋友圈文案",
    "group_notice": "群公告",
    "private_chat": "私聊话术",
    "poster_copy": "海报文案",
    "short_video": "短视频配文",
    "execution_tips": "执行建议",
    "daily_report": "日报 / 汇报",
    "activity_plan": "活动方案",
    "sop_checklist": "SOP / 检查表",
    "pk_plan": "目标表 / PK 方案",
}


def _load_rule_safe(template_key: str, store: Store) -> str:
    """尝试加载规则模板，如不存在则返回空字符串。"""
    try:
        return prompt_engine.render(template_key, store, {})
    except PromptTemplateNotFoundError:
        return ""


# 核心知识：无论用户意图如何都注入（合规/术语/核心运营逻辑/服务理念 + 岗位每日流程）
CORE_KNOWLEDGE_KEYS = {
    "knowledge.compliance_rules",
    "knowledge.term_whitelist",
    "knowledge.core_operations",
    "knowledge.service_philosophy",
}

# 场景化知识：仅当用户意图/补充说明命中关键词时才注入，避免每次全量灌入
KNOWLEDGE_KEYWORDS: dict[str, list[str]] = {
    "knowledge.account_nurturing": ["养号", "账号", "起号", "权重", "限流", "新号"],
    "knowledge.assistant_coaching_sop": ["陪练", "教学", "训练", "球技", "动作", "纠正", "练球", "指导"],
    "knowledge.assistant_difficult_situations": ["刁钻", "难缠", "尴尬", "拒绝", "难题", "不好处理", "投诉", "越界", "想法", "红包", "疑难", "难伺候", "灌酒"],
    "knowledge.pk_incentive": ["PK", "对赌", "激励", "排名", "比拼", "奖惩", "冲业绩"],
    "knowledge.assistant_promotion": ["助教推广", "助教获客", "助教朋友圈", "推广助教", "助教引流", "自我推广", "推广自己",
                                      "短视频", "视频文案", "拍视频", "拍个视频", "视频脚本", "吸粉", "涨粉", "发抖音", "抖音文案", "发快手"],
    "knowledge.assistant_salary": ["助教薪资", "助教工资", "助教提成", "保底", "分成", "薪资"],
    "knowledge.assistant_service_sop": ["上钟", "服务流程", "助教服务", "陪打", "陪玩", "点助教", "约助教"],
    "knowledge.assistant_tier_system": ["等级", "晋升", "助教等级", "赋能", "分级", "升级"],
    "knowledge.billiards_game_rules": ["规则", "中八", "中式八球", "中式九球", "斯诺克", "九球", "黑八", "打法", "比赛规则", "怎么打", "玩法规则", "摸牌", "抽牌"],
    "knowledge.game_rules": ["玩法活动", "玩法策划", "玩法说明", "搭子局", "台费局", "饮料局", "抢一大战", "奖品挑战", "报名费", "怎么组织", "收多少钱", "玩法文案", "组局", "设奖金", "让球", "把玩法办成活动"],
    "knowledge.business_cases": ["案例", "参考案例", "成功案例", "同行", "别人家"],
    "knowledge.competitive_group_ops": ["竞技群", "群运营", "维护群", "搭子群", "群活跃", "群里"],
    "knowledge.contract_basics": ["合同", "租约", "签约", "条款", "租赁"],
    "knowledge.core_metrics": ["指标", "数据", "台费", "上座率", "翻台", "复购", "趋势", "营收", "报表"],
    "knowledge.diagnostic_logic": ["诊断", "复盘", "下滑", "上不去", "冷清", "为什么", "提升营业额", "业绩", "没客人", "客流少", "经营问题", "分析原因", "怎么提升", "生意差"],
    "knowledge.assistant_scripts": ["话术", "怎么说", "怎么开口", "迎宾", "走访", "排钟", "转介绍", "办卡", "邀约", "搭话", "加微信", "私聊", "约客"],
    "knowledge.customer_profile_template": ["档案", "客户资料", "客户信息", "建档", "客户档案"],
    "knowledge.customer_tagging": ["标签", "打标", "分级", "客户分类", "客户标签"],
    "knowledge.customer_types": ["客户", "客群", "客户类型", "新客", "老客", "客户分类"],
    "knowledge.frontdesk_training": ["前厅", "前台", "接待", "服务标准", "台呢", "前厅培训"],
    "knowledge.industry_data": ["行业数据", "市场", "行情", "大盘"],
    "knowledge.management_recruitment": ["招聘", "招人", "面试", "管理岗", "店长招聘"],
    "knowledge.manager_compensation": ["店长薪资", "管理层薪资", "底薪", "店长工资"],
    "knowledge.mini_games": ["小游戏", "游戏", "互动", "破冰", "暖场", "活跃气氛"],
    "knowledge.opening_preparation": ["开业", "筹备", "开店", "试营业", "开张", "新店"],
    "knowledge.performance_standards": ["绩效", "考核", "kpi", "提成", "标准", "考评"],
    "knowledge.platform_operations": ["平台", "美团", "抖音", "点评", "团购", "线上", "本地生活"],
    "knowledge.profit_model": ["定价", "价格", "利润", "盈利", "成本", "套餐", "收入", "团购", "毛利"],
    "knowledge.recharge_strategy": ["充值", "储值", "会员卡", "办卡", "续费", "一卡通", "会员"],
    "knowledge.recruitment_compliance": ["招聘合规", "用工", "劳动", "合同合规"],
    "knowledge.review_generation_rules": ["好评", "评价", "点评", "晒图", "评论", "review"],
    "knowledge.site_selection": ["选址", "位置", "店面", "商圈", "门面"],
    "knowledge.tournament_rules": ["比赛", "赛事", "周赛", "月赛", "锦标", "排位", "积分赛", "战报", "主持", "联赛", "主题之夜", "单身", "情侣", "女生场", "闺蜜", "团建", "包场", "看球", "双业态"],
    "knowledge.traffic_generation": ["引流", "拉新", "获客", "人气", "客流", "流量", "冷清"],
    "knowledge.traffic_priority": ["引流渠道", "拉新渠道", "获客渠道", "推广渠道", "怎么推广", "渠道优先", "优先级", "先做啥", "先做哪个", "先搞哪个", "从哪开始", "第一步做", "哪个渠道", "渠道选择", "合规引流", "合规获客", "能不能碰", "踩红线", "会不会违规", "抖音引流", "美团引流", "小红书引流", "视频号", "地推", "异业合作"],
    "knowledge.growth_playbook": ["裂变", "老带新", "转介绍", "集赞", "邀请", "打卡", "拼台", "积分", "排行榜", "抽奖", "留存", "复购", "召回", "唤醒", "月卡", "增长打法", "增长体系", "复购体系", "裂变玩法", "存量盘活"],
    "knowledge.female_customer_ops": ["女生", "女性", "闺蜜", "姐妹", "女士", "女孩", "小姐妹", "女客", "女性客群", "女生场", "闺蜜局", "女生向", "女性向", "出片", "拍照打卡"],
    "knowledge.scale_guide": ["规模", "几台", "小店", "独立店", "台数", "10台", "20台", "连锁", "中小店", "夫妻店", "大店", "门店大小", "多少台", "台球桌数量", "几张台"],
    "knowledge.gaming_customer_ops": ["追分", "约局", "博弈", "台费局", "赢一把", "小赌", "下注", "对局", "围观", "高手局", "追分客", "彩头"],
    "knowledge.assistant_overtime_service": ["超休", "买超休", "陪出去", "出去吃饭", "陪客户出去", "外出陪", "陪伴服务", "超休时长", "超休奖励"],
    "knowledge.cost_control": ["控成本", "成本控制", "成材率", "损耗", "耗材", "电费", "台呢更换", "皮头", "巧粉", "降本", "省成本", "能耗"],
    "knowledge.positioning_design": ["定位", "差异化", "卖点", "口号", "slogan", "心智", "竞争对手", "凭什么选", "宣传特色", "品牌传播", "找搭子", "怎么宣传", "占领心智"],
    "knowledge.price_raise": ["涨价", "提价", "上调价格", "调价", "价格上调", "提毛利", "加价", "能不能涨", "敢不敢涨", "提价格"],
    "knowledge.assistant_persona_building": ["人设", "美女人设", "形象", "颜值", "气质", "风格", "穿搭", "妆容", "妆造", "出镜", "包装助教", "助教形象", "性感", "可爱", "飒爽", "潮酷"],
    "knowledge.store_manager_competency": ["店长能力", "店长职责", "店长该", "带团队", "赛马", "店长核心", "怎么当店长", "考核店长", "抓店长", "店长素质", "店长工作"],
    "knowledge.casual_customer_segments": ["散客", "初次进店", "第一次来", "新散客", "散客维护", "散客转化", "留散客", "娱乐型", "刚上瘾", "散客分层"],
}

# 场景知识注入条数上限（A-3 动态化）：默认 8（原死 4 会把相关知识静默挤掉=C-2）；经 DESKTOP_KNOWLEDGE_MAX_SCENE 可配。
# 真正的"动态"靠下面的语义门槛 _SEM_THRESHOLD：简单需求命中少、自然注得少；复杂多意图命中多、才注到上限——不再被死 4 一刀切。
_MAX_SCENE_KNOWLEDGE_DEFAULT = 8


def _scene_cap() -> int:
    try:
        return max(1, int(os.environ.get("DESKTOP_KNOWLEDGE_MAX_SCENE", str(_MAX_SCENE_KNOWLEDGE_DEFAULT))))
    except (TypeError, ValueError):
        return _MAX_SCENE_KNOWLEDGE_DEFAULT
# A-2：语义召回提为主路径——语义相关门槛(cosine≥此值即算相关、可单独纳入) + 关键词命中的加分权重(降为加分项、非门槛)。
_SEM_THRESHOLD = 0.45
_KW_BONUS = 0.15


def _is_core_knowledge(key: str) -> bool:
    """核心知识：固定集合 + 岗位每日流程（daily_workflow*）。"""
    return key in CORE_KNOWLEDGE_KEYS or key.startswith("knowledge.daily_workflow")


_CONTENT_BIGRAM_CACHE: dict[str, set] = {}


def _intent_bigrams(text: str) -> set:
    s = "".join((text or "").lower().split())
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) >= 2 else set()


def _content_bigrams(key: str) -> set:
    """某条知识【内容本身】的字 bigram 集合（缓存）。用于"按内容找料"：
    知识里本来就写了的词（如"短视频"），intent 提到就能命中，不依赖手维护的关键词表——
    根治"忘加暗号就翻不到对应知识"那类脆弱性。"""
    cached = _CONTENT_BIGRAM_CACHE.get(key)
    if cached is not None:
        return cached
    data = prompt_engine._templates.get(key) or {}
    text = " ".join(str(v) for v in data.values() if isinstance(v, str))
    grams = _intent_bigrams(text)
    _CONTENT_BIGRAM_CACHE[key] = grams
    return grams


_KNOWLEDGE_EMB_CACHE: dict[str, list] = {}


def _semantic_available() -> bool:
    """装了 fastembed 本地语义模型 → True（用"按意思找料"）；否则回退字面 bigram。"""
    try:
        from services.rag.embedder import get_embedder
        return getattr(get_embedder(), "name", "") == "fastembed"
    except Exception:
        return False


def _knowledge_emb(key: str):
    """某条知识片段（名+正文截断）的语义向量，缓存。"""
    cached = _KNOWLEDGE_EMB_CACHE.get(key)
    if cached is not None:
        return cached
    from services.rag.embedder import get_embedder
    data = prompt_engine._templates.get(key) or {}
    name = str(data.get("name", ""))
    # A-2：有 description(知识索引)就优先用它做语义向量——比一股脑塞正文更准、更稳；没有再退回正文截断。
    desc = str(data.get("description", "")).strip()
    text = desc if desc else " ".join(str(v) for v in data.values() if isinstance(v, str))
    emb = get_embedder().embed((name + "。" + text)[:400])
    _KNOWLEDGE_EMB_CACHE[key] = emb
    return emb


def _semantic_fill(intent_text: str, candidates: list[str]) -> list[str]:
    """按【意思】给候选知识排序，返回相关度够（cosine≥0.45）的 key。
    "拍个视频"也能命中"短视频知识"（字面零重叠）——根治"换说法就漏"。"""
    from services.rag.embedder import get_embedder, cosine
    q = get_embedder().embed(intent_text)
    scored: list[tuple[float, str]] = []
    for key in candidates:
        try:
            s = cosine(q, _knowledge_emb(key))
        except Exception:
            s = 0.0
        if s >= 0.45:
            scored.append((s, key))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [k for _, k in scored]


def _bigram_fill(intent_text: str, candidates: list[str]) -> list[str]:
    """没装语义模型时的回退：字面强重叠（半数命中且≥4）才补。"""
    ib = _intent_bigrams(intent_text)
    scored: list[tuple[float, str]] = []
    for key in candidates:
        cb = _content_bigrams(key)
        ov = len(ib & cb) if (ib and cb) else 0
        frac = ov / len(ib) if ib else 0.0
        if frac >= 0.5 and ov >= 4:
            scored.append((frac, key))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [k for _, k in scored]


def _semantic_scores(intent_text: str, candidates: list[str]) -> dict:
    """给候选知识按【意思】打分，返回 {key: cosine}（不过滤，供统一排序用）。"""
    from services.rag.embedder import get_embedder, cosine
    q = get_embedder().embed(intent_text)
    out: dict[str, float] = {}
    for key in candidates:
        try:
            out[key] = cosine(q, _knowledge_emb(key))
        except Exception:
            out[key] = 0.0
    return out


def _log_recall(intent_text: str, scored: list, cap: int) -> None:
    """X-4 可观测打点：记本次知识召回的 key+分数 + 被上限截掉了哪些（喂迭代揪死知识/误召）。结构化 logger、故障安全。"""
    try:
        sel = [(k, round(sc, 3)) for sc, k in scored[:cap]]
        cut = [(k, round(sc, 3)) for sc, k in scored[cap:]]
        if sel or cut:
            logger.info("知识召回 | intent=%.50s | 选中=%s | 上限截掉=%s", intent_text, sel, cut)
    except Exception:
        pass


def _select_knowledge_keys(required_keys: list[str], intent_text: str) -> list[str]:
    """根据用户意图筛选需要注入的知识键。

    - intent_text 为空时不筛选，返回全部（保持非工作台路径的原有行为）。
    - 核心知识始终注入。
    - 场景知识（A-2 改造）：装了语义模型时【语义召回为主路径】——按"意思"统一打分，关键词命中
      降为【加分项】(不再是必须先命中的门槛)，所以"换说法/没配暗号"但相关的知识也能进；没装语义
      模型时回退原行为（关键词命中为主 + bigram 字面补）。取前 _MAX_SCENE_KNOWLEDGE 条。
    - 保留 required_keys 的原始顺序，确保 prompt 结构稳定。
    """
    if not intent_text or not intent_text.strip():
        return required_keys

    intent_lower = intent_text.lower()
    core = [k for k in required_keys if _is_core_knowledge(k)]
    scene = [k for k in required_keys if not _is_core_knowledge(k)]
    cap = _scene_cap()  # A-3：动态上限（默认 8、可配），不再死 4

    def _kw_hits(key: str) -> int:
        return sum(1 for w in KNOWLEDGE_KEYWORDS.get(key, []) if w.lower() in intent_lower)

    if _semantic_available():
        # 【语义为主】对所有场景候选按意思打分；关键词命中作加分项、不当门槛。
        sem = _semantic_scores(intent_text, scene)
        scored: list[tuple[float, str]] = []
        for key in scene:
            s = sem.get(key, 0.0)
            kw = _kw_hits(key)
            # 纳入：语义够相关 或 有关键词命中（任一即可）——语义不再只是"填空位"，而是主路径。
            if s >= _SEM_THRESHOLD or kw > 0:
                scored.append((s + _KW_BONUS * kw, key))
        scored.sort(key=lambda x: x[0], reverse=True)
        selected_keys = [k for _, k in scored[:cap]]
        _log_recall(intent_text, scored, cap)  # X-4 可观测打点：选中/截掉
    else:
        # 回退（没装语义模型）：关键词命中为主，按命中数排序取前 N；不足再 bigram 字面补。保持原行为。
        kw_scored = sorted(((_kw_hits(k), k) for k in scene if _kw_hits(k) > 0),
                           key=lambda x: x[0], reverse=True)
        selected_keys = [k for _, k in kw_scored[:cap]]
        if len(selected_keys) < cap:
            candidates = [k for k in scene if k not in selected_keys]
            for key in _bigram_fill(intent_text, candidates):
                if len(selected_keys) >= cap:
                    break
                selected_keys.append(key)

    selected = set(selected_keys) | set(core)
    return [k for k in required_keys if k in selected]


def _load_knowledge_for_role(role: str, store: Store, intent_text: str = "") -> tuple[str, list[str]]:
    """根据岗位规则中声明的 required_knowledge，加载并拼接对应知识库。

    intent_text（用户意图 + 补充说明）非空时，只注入核心知识 + 命中场景的知识，
    避免每次把全部知识全量灌入 prompt（manager 角色原本约 12 万字符）。

    返回 (text, names)：text 是拼好的知识文本；names 是本次真正注入的每条知识的【大白话 name】
    （取自 prompt_engine._templates[key]["name"]，空的跳过）。B-2「依据可见」据 names 在成品卡上
    显示「依据：name1、name2」。两者一一对应：渲染成功(进 parts)的 key 才进 names。
    """
    role_template = prompt_engine._templates.get(f"rules.role.{role}")
    if not role_template:
        return "", []

    required_keys = role_template.get("required_knowledge", [])
    if not required_keys:
        return "", []

    selected_keys = _select_knowledge_keys(required_keys, intent_text)

    parts: list[str] = []
    names: list[str] = []
    for key in selected_keys:
        try:
            rendered = prompt_engine.render(key, store, {})
            if rendered.strip():
                parts.append(rendered.strip())
                name = prompt_engine.template_name(key)
                if name:
                    names.append(name)
        except (PromptTemplateNotFoundError, PromptVariableMissingError) as e:
            logger.warning("知识加载跳过: %s - %s", key, str(e))
            continue

    if not parts:
        return "", []

    return "\n\n---\n\n".join(parts), names


def _format_output_package(output_package: list[str] | None) -> str:
    if not output_package:
        return "请根据用户需求自行判断最合适的输出内容"
    labels = [OUTPUT_LABELS.get(p, p) for p in output_package]
    return "、".join(labels)


def _strip_ai_prefixes(content: str) -> str:
    """去除 AI 回应语前缀。前缀列表与流式过滤共用 security_guard.AI_RESPONSE_PREFIXES。"""
    for prefix in AI_RESPONSE_PREFIXES:
        if content.startswith(prefix):
            return content[len(prefix):].lstrip("\n").lstrip()
    return content


def _append_guardrails(rendered_prompt: str, store: Store, role: str | None = None, intent_text: str = "") -> tuple[str, list[str]]:
    """在渲染后的 prompt 后追加防护上下文（baseline_rules + role_rules + knowledge + profile）。

    非 workbench 路径（copywriting/activity/operation）的模板没有 {baseline_rules} 等占位符，
    所以不能用 extra_vars 注入。改为在渲染后的 prompt 后追加，确保合规约束生效。

    intent_text（用户意图 + 补充说明）非空时，按场景筛选注入的行业知识，避免 prompt_key
    路径（占工作台卡片的绝大多数）每次全量灌入知识。为空时保持原有全量行为。

    返回 (text, knowledge_names)：text 是追加完护栏后的 prompt；knowledge_names 是本次注入的
    行业知识【大白话 name】列表（B-2「依据可见」用，无 role/无知识时为空列表）。
    """
    sections: list[str] = []
    knowledge_names: list[str] = []

    baseline_rules = _load_rule_safe("rules.baseline", store)
    if baseline_rules:
        sections.append(f"## 通用强制规则\n\n{baseline_rules}")

    if role:
        role_rules = _load_rule_safe(f"rules.role.{role}", store)
        if role_rules:
            sections.append(f"## 岗位规则\n\n{role_rules}")

        knowledge_context, knowledge_names = _load_knowledge_for_role(role, store, intent_text)
        if knowledge_context:
            sections.append(f"## 行业知识参考\n\n{knowledge_context}")

    profile_context = render_operation_profile_context(store)
    if profile_context:
        sections.append(f"## 门店运营画像\n\n{profile_context}")

    if not sections:
        return rendered_prompt, knowledge_names

    guardrails_text = "\n\n---\n\n".join(sections)
    return f"{rendered_prompt}\n\n---\n\n{guardrails_text}", knowledge_names


async def generate_copywriting(
    db: AsyncSession,
    store: Store,
    user: User,
    sub_type: str,
    tone: str,
    scenario: str,
    extra_note: str = "",
) -> Generation:
    # 输入安全检查
    injection_check = check_input_injection(extra_note)
    if injection_check:
        raise AIServiceError(injection_check)

    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    template_key = f"copywriting.{sub_type}"

    scenario_label = (
        GROUP_NOTICE_SCENARIO_LABELS.get(scenario, scenario)
        if sub_type == "group_notice"
        else SCENARIO_LABELS.get(scenario, scenario)
    )
    extra_vars = {
        "tone": TONE_LABELS.get(tone, tone),
        "scenario": scenario_label,
        "extra_note": extra_note or "无",
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    # intent 用中文标签：英文枚举值匹配不到中文知识关键词，筛选会形同虚设
    rendered_prompt, knowledge_names = _append_guardrails(rendered_prompt, store, role="manager", intent_text=f"{scenario_label} {extra_note}")

    brand_voice = await get_brand_voice_context(db, store.id)
    if brand_voice:
        rendered_prompt = f"{rendered_prompt}\n\n---\n{brand_voice}\n---"

    provider = ProviderFactory.get_text_provider_for_store(store)
    request = TextRequest(prompt=rendered_prompt, thinking={"type": "disabled"})
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message, status_code=e.status_code) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    content = _strip_ai_prefixes(response.content)
    content = filter_output_leak(content)

    generation = Generation(
        id=uuid.uuid4(),
        store_id=store.id,
        user_id=user.id,
        type="copywriting",
        sub_type=sub_type,
        input_params={
            "tone": tone,
            "scenario": scenario,
            "extra_note": extra_note,
            "knowledge_used": knowledge_names,  # B-2 依据可见：本次注入的行业知识名
        },
        prompt_used=rendered_prompt,
        result=content,
        model_used=response.model,
        tokens_used=response.tokens_used,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)

    await increment_usage(db, str(store.id), tokens=response.tokens_used or 0)

    return generation


async def generate_activity(
    db: AsyncSession,
    store: Store,
    user: User,
    activity_goal: str,
    target_customer: str | None = None,
    budget_level: str | None = None,
    duration: str | None = None,
    extra_note: str = "",
) -> Generation:
    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    injection_check = check_input_injection(extra_note)
    if injection_check:
        raise AIServiceError(injection_check)

    template_key = "activity.planning"

    extra_vars = {
        "activity_goal": ACTIVITY_GOAL_LABELS.get(activity_goal, activity_goal),
        "target_customer": target_customer or store.target_customers or "全部客群",
        "budget_level": BUDGET_LABELS.get(budget_level, "中度优惠") if budget_level else "中度优惠",
        "duration": duration or "待定",
        "extra_note": extra_note or "无",
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt, knowledge_names = _append_guardrails(rendered_prompt, store, role="manager", intent_text=f"{activity_goal} {target_customer or ''} {extra_note}")

    brand_voice = await get_brand_voice_context(db, store.id)
    if brand_voice:
        rendered_prompt = f"{rendered_prompt}\n\n---\n{brand_voice}\n---"

    provider = ProviderFactory.get_text_provider_for_store(store)
    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message, status_code=e.status_code) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    content = _strip_ai_prefixes(response.content)
    content = filter_output_leak(content)

    generation = Generation(
        id=uuid.uuid4(),
        store_id=store.id,
        user_id=user.id,
        type="activity",
        sub_type="planning",
        input_params={
            "activity_goal": activity_goal,
            "target_customer": target_customer,
            "budget_level": budget_level,
            "duration": duration,
            "extra_note": extra_note,
            "knowledge_used": knowledge_names,  # B-2 依据可见
        },
        prompt_used=rendered_prompt,
        result=content,
        model_used=response.model,
        tokens_used=response.tokens_used,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)

    await increment_usage(db, str(store.id), tokens=response.tokens_used or 0)

    return generation


async def generate_operation(
    db: AsyncSession,
    store: Store,
    user: User,
    scenario: str,
    tone: str,
    target: str | None = None,
    extra_note: str = "",
) -> Generation:
    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    injection_check = check_input_injection(extra_note)
    if injection_check:
        raise AIServiceError(injection_check)

    template_key = f"operation.{scenario}"

    # 根据场景推断岗位，用于注入对应的 role_rules 和 knowledge
    inferred_role = SCENARIO_ROLE_MAP.get(scenario, "manager")

    extra_vars = {
        "tone": TONE_LABELS.get(tone, tone),
        "target": target or "全部客户",
        "extra_note": extra_note or "无",
        "role": ROLE_LABELS.get(inferred_role, inferred_role),
        "date": business_today().isoformat(),
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars, lenient=True)
    # intent 用模板中文名：英文场景键匹配不到中文知识关键词
    template_label = prompt_engine.template_name(template_key) or scenario
    rendered_prompt, knowledge_names = _append_guardrails(rendered_prompt, store, role=inferred_role, intent_text=f"{template_label} {target or ''} {extra_note}")

    brand_voice = await get_brand_voice_context(db, store.id)
    if brand_voice:
        rendered_prompt = f"{rendered_prompt}\n\n---\n{brand_voice}\n---"

    provider = ProviderFactory.get_text_provider_for_store(store)
    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message, status_code=e.status_code) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    content = _strip_ai_prefixes(response.content)
    content = filter_output_leak(content)

    generation = Generation(
        id=uuid.uuid4(),
        store_id=store.id,
        user_id=user.id,
        type="operation",
        sub_type=scenario,
        input_params={
            "scenario": scenario,
            "tone": tone,
            "target": target,
            "extra_note": extra_note,
            "knowledge_used": knowledge_names,  # B-2 依据可见
        },
        prompt_used=rendered_prompt,
        result=content,
        model_used=response.model,
        tokens_used=response.tokens_used,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)

    await increment_usage(db, str(store.id), tokens=response.tokens_used or 0)

    return generation


def concise_directive(concise: bool) -> str:
    """#3 精简档：要求只出一条，不堆多个方案/版本。concise=False 时无影响（返回空串）。"""
    if not concise:
        return ""
    return (
        "\n\n【篇幅要求】本次只要一条：直接给最合适的那一条成品，"
        "不要给多个方案/版本/标题候选，不要罗列「方案一/方案二/方案三」。"
    )


async def generate_workbench(
    db: AsyncSession,
    store: Store,
    user: User,
    user_intent: str,
    role: str,
    target_customer_type: str | None = None,
    output_package: list[str] | None = None,
    extra_note: str = "",
    prompt_key: str | None = None,
    model: str | None = None,
    concise: bool = False,
) -> Generation:
    # 输入安全检查
    injection_check = check_input_injection(user_intent + " " + extra_note)
    if injection_check:
        raise AIServiceError(injection_check)

    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    if prompt_key:
        # promptKey 路径：使用指定场景模板（如 operation.qiangyi_battle），再追加防护上下文
        # 从 prompt_key 提取场景名（如 "operation.qiangyi_battle" → "qiangyi_battle"），推断岗位
        scenario_name = prompt_key.split(".", 1)[-1] if "." in prompt_key else prompt_key
        inferred_role = SCENARIO_ROLE_MAP.get(scenario_name) or role
        extra_vars = {
            "tone": TONE_LABELS.get("friendly", "friendly"),
            "target": CUSTOMER_LABELS.get(target_customer_type or "all", "全部客户"),
            "extra_note": extra_note or "无",
            "scenario": "日常",
            "role": ROLE_LABELS.get(inferred_role, inferred_role),
            "date": business_today().isoformat(),
        }
        rendered_prompt = prompt_engine.render(prompt_key, store, extra_vars, lenient=True)
        # intent 带上模板中文名：用户意图为空时知识筛选仍能按场景命中
        template_label = prompt_engine.template_name(prompt_key)
        rendered_prompt, knowledge_names = _append_guardrails(rendered_prompt, store, role=inferred_role, intent_text=f"{template_label} {user_intent} {extra_note}")
    else:
        # 通用 free_intent 路径：在模板内注入规则和知识
        baseline_rules = _load_rule_safe("rules.baseline", store)
        role_rules = _load_rule_safe(f"rules.role.{role}", store)

        customer_type = target_customer_type or "all"
        customer_rules = _load_rule_safe(f"rules.customer.{customer_type}", store)

        knowledge_context, knowledge_names = _load_knowledge_for_role(role, store, f"{user_intent} {extra_note}")

        # 轻量 few-shot 选择 (10F-2)：根据请求字段选择最多 2 条优质正例
        try:
            fewshot_examples = select_workbench_fewshots(
                role=role,
                target_customer_type=customer_type,
                output_package=output_package or [],
                user_intent=user_intent,
                extra_note=extra_note,
                max_examples=2,
            )
        except Exception:
            fewshot_examples = ""

        extra_vars = {
            "baseline_rules": baseline_rules,
            "role_rules": role_rules,
            "customer_rules": customer_rules,
            "knowledge_context": knowledge_context,
            "fewshot_examples": fewshot_examples,
            "user_intent": user_intent,
            "role_label": ROLE_LABELS.get(role, role),
            "target_customer_label": CUSTOMER_LABELS.get(customer_type, customer_type),
            "output_package_label": _format_output_package(output_package),
            "extra_note": extra_note or "无",
            "profile_context": render_operation_profile_context(store),
        }

        rendered_prompt = prompt_engine.render("workbench.free_intent", store, extra_vars)

    # 品牌声音：与流式路径保持一致，让"点赞教 AI 学风格"在所有入口生效
    brand_voice = await get_brand_voice_context(db, store.id)
    if brand_voice:
        rendered_prompt = f"{rendered_prompt}\n\n---\n{brand_voice}\n---"

    # #3 精简档：要求只出一条（放最后，盖过模板里"给多个方案"的默认）
    rendered_prompt += concise_directive(concise)

    # 获取文本 provider
    provider = ProviderFactory.get_text_provider_for_store(store)

    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message, status_code=e.status_code) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    # 可观测性：扫原始输出的铁律违反率（喂"模型 slip 率"指标，故障安全、不影响生成）
    try:
        from services.usage_event_service import observe_compliance
        await observe_compliance(response.content, store_id=str(store.id), sub_type=prompt_key or role)
    except Exception:
        pass

    content = _strip_ai_prefixes(response.content)
    content = filter_output_leak(content)

    generation = Generation(
        id=uuid.uuid4(),
        store_id=store.id,
        user_id=user.id,
        type="workbench",
        sub_type=prompt_key or role,
        input_params={
            "user_intent": user_intent,
            "role": role,
            "target_customer_type": target_customer_type,
            "output_package": output_package,
            "extra_note": extra_note,
            "prompt_key": prompt_key,
            "knowledge_used": knowledge_names,  # B-2 依据可见：本次注入的行业知识名
        },
        prompt_used=rendered_prompt,
        result=content,
        model_used=response.model,
        tokens_used=response.tokens_used,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)

    await increment_usage(db, str(store.id), tokens=response.tokens_used or 0)

    return generation
