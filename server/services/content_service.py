import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.exceptions import AIServiceError, AIProviderError

from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.prompt_engine import get_prompt_engine, PromptTemplateNotFoundError, PromptVariableMissingError
from services.ai.base import TextRequest
from services.workbench_fewshot_service import select_workbench_fewshots
from services.store_profile_service import render_operation_profile_context
from services.quota_service import check_quota, increment_usage
from core.security_guard import check_input_injection, filter_output_leak, AI_RESPONSE_PREFIXES
from services.scenario_role_map import SCENARIO_ROLE_MAP

logger = logging.getLogger(__name__)

prompt_engine = get_prompt_engine()


def _validate_provider_for_production() -> None:
    """生产环境禁止使用 mock provider。"""
    if settings.app_env == "production" and settings.text_model_provider == "mock":
        raise AIServiceError("生产环境禁止使用 Mock Provider，请配置真实 AI 模型")

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

OPERATION_SCENARIO_LABELS = {
    "groupbuy_to_private": "团购转私域",
    "assistant_promo": "助教推广",
    "partner_match": "搭子局/竞技局",
    "tournament": "周赛/月赛",
    "old_customer_recall": "老客维护",
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
    "knowledge.assistant_difficult_situations": ["刁钻", "难缠", "尴尬", "拒绝", "难题", "不好处理", "投诉"],
    "knowledge.assistant_promotion": ["助教推广", "助教获客", "助教朋友圈", "推广助教", "助教引流"],
    "knowledge.assistant_salary": ["助教薪资", "助教工资", "助教提成", "保底", "分成", "薪资"],
    "knowledge.assistant_service_sop": ["上钟", "服务流程", "助教服务", "陪打", "陪玩", "点助教", "约助教"],
    "knowledge.assistant_tier_system": ["等级", "晋升", "助教等级", "赋能", "分级", "升级"],
    "knowledge.billiards_game_rules": ["规则", "玩法", "中八", "斯诺克", "九球", "黑八", "打法", "比赛规则"],
    "knowledge.business_cases": ["案例", "参考案例", "成功案例", "同行", "别人家"],
    "knowledge.competitive_group_ops": ["竞技群", "群运营", "维护群", "搭子群", "群活跃", "群里"],
    "knowledge.contract_basics": ["合同", "租约", "签约", "条款", "租赁"],
    "knowledge.core_metrics": ["指标", "数据", "台费", "上座率", "翻台", "复购", "趋势", "营收", "报表"],
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
    "knowledge.tournament_rules": ["比赛", "赛事", "周赛", "月赛", "锦标", "排位", "积分赛", "战报", "主持"],
    "knowledge.traffic_generation": ["引流", "拉新", "获客", "人气", "客流", "流量", "冷清"],
}

# 命中关键词的场景知识最多额外注入的条数（核心知识不计入此上限）
_MAX_SCENE_KNOWLEDGE = 4


def _is_core_knowledge(key: str) -> bool:
    """核心知识：固定集合 + 岗位每日流程（daily_workflow*）。"""
    return key in CORE_KNOWLEDGE_KEYS or key.startswith("knowledge.daily_workflow")


def _select_knowledge_keys(required_keys: list[str], intent_text: str) -> list[str]:
    """根据用户意图筛选需要注入的知识键。

    - intent_text 为空时不筛选，返回全部（保持非工作台路径的原有行为）。
    - 核心知识始终注入；场景知识按关键词命中数排序，取前 _MAX_SCENE_KNOWLEDGE 条。
    - 未命中任何场景知识时，只注入核心知识，大幅压缩 prompt 体积。
    - 保留 required_keys 的原始顺序，确保 prompt 结构稳定。
    """
    if not intent_text or not intent_text.strip():
        return required_keys

    intent_lower = intent_text.lower()
    scored: list[tuple[int, str]] = []
    for key in required_keys:
        if _is_core_knowledge(key):
            continue
        keywords = KNOWLEDGE_KEYWORDS.get(key, [])
        score = sum(1 for kw in keywords if kw.lower() in intent_lower)
        if score > 0:
            scored.append((score, key))

    scored.sort(key=lambda x: x[0], reverse=True)
    selected = {k for _, k in scored[:_MAX_SCENE_KNOWLEDGE]}
    selected.update(k for k in required_keys if _is_core_knowledge(k))

    return [k for k in required_keys if k in selected]


def _load_knowledge_for_role(role: str, store: Store, intent_text: str = "") -> str:
    """根据岗位规则中声明的 required_knowledge，加载并拼接对应知识库。

    intent_text（用户意图 + 补充说明）非空时，只注入核心知识 + 命中场景的知识，
    避免每次把全部知识全量灌入 prompt（manager 角色原本约 12 万字符）。
    """
    role_template = prompt_engine._templates.get(f"rules.role.{role}")
    if not role_template:
        return ""

    required_keys = role_template.get("required_knowledge", [])
    if not required_keys:
        return ""

    selected_keys = _select_knowledge_keys(required_keys, intent_text)

    parts: list[str] = []
    for key in selected_keys:
        try:
            rendered = prompt_engine.render(key, store, {})
            if rendered.strip():
                parts.append(rendered.strip())
        except (PromptTemplateNotFoundError, PromptVariableMissingError) as e:
            logger.warning("知识加载跳过: %s - %s", key, str(e))
            continue

    if not parts:
        return ""

    return "\n\n---\n\n".join(parts)


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


def _append_guardrails(rendered_prompt: str, store: Store, role: str | None = None) -> str:
    """在渲染后的 prompt 后追加防护上下文（baseline_rules + role_rules + knowledge + profile）。

    非 workbench 路径（copywriting/activity/operation）的模板没有 {baseline_rules} 等占位符，
    所以不能用 extra_vars 注入。改为在渲染后的 prompt 后追加，确保合规约束生效。
    """
    sections: list[str] = []

    baseline_rules = _load_rule_safe("rules.baseline", store)
    if baseline_rules:
        sections.append(f"## 通用强制规则\n\n{baseline_rules}")

    if role:
        role_rules = _load_rule_safe(f"rules.role.{role}", store)
        if role_rules:
            sections.append(f"## 岗位规则\n\n{role_rules}")

        knowledge_context = _load_knowledge_for_role(role, store)
        if knowledge_context:
            sections.append(f"## 行业知识参考\n\n{knowledge_context}")

    profile_context = render_operation_profile_context(store)
    if profile_context:
        sections.append(f"## 门店运营画像\n\n{profile_context}")

    if not sections:
        return rendered_prompt

    guardrails_text = "\n\n---\n\n".join(sections)
    return f"{rendered_prompt}\n\n---\n\n{guardrails_text}"


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

    extra_vars = {
        "tone": TONE_LABELS.get(tone, tone),
        "scenario": (
            GROUP_NOTICE_SCENARIO_LABELS.get(scenario, scenario)
            if sub_type == "group_notice"
            else SCENARIO_LABELS.get(scenario, scenario)
        ),
        "extra_note": extra_note or "无",
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt = _append_guardrails(rendered_prompt, store, role="manager")

    provider = ProviderFactory.get_text_provider()
    request = TextRequest(prompt=rendered_prompt, thinking={"type": "disabled"})
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message) from e
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
    rendered_prompt = _append_guardrails(rendered_prompt, store, role="manager")

    provider = ProviderFactory.get_text_provider()
    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message) from e
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
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt = _append_guardrails(rendered_prompt, store, role=inferred_role)

    provider = ProviderFactory.get_text_provider()
    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message) from e
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
) -> Generation:
    # 输入安全检查
    injection_check = check_input_injection(user_intent + " " + extra_note)
    if injection_check:
        raise AIServiceError(injection_check)

    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    if prompt_key:
        # promptKey 路径：使用指定场景模板（如 operation.qiangyi_battle），再追加防护上下文
        extra_vars = {
            "tone": TONE_LABELS.get("friendly", "friendly"),
            "target": CUSTOMER_LABELS.get(target_customer_type or "all", "全部客户"),
            "extra_note": extra_note or "无",
            "scenario": "日常",
        }
        rendered_prompt = prompt_engine.render(prompt_key, store, extra_vars)

        # 推断岗位用于注入对应 role_rules 和 knowledge
        # 从 prompt_key 提取场景名（如 "operation.qiangyi_battle" → "qiangyi_battle"）
        scenario_name = prompt_key.split(".", 1)[-1] if "." in prompt_key else prompt_key
        inferred_role = SCENARIO_ROLE_MAP.get(scenario_name) or role
        rendered_prompt = _append_guardrails(rendered_prompt, store, role=inferred_role)
    else:
        # 通用 free_intent 路径：在模板内注入规则和知识
        baseline_rules = _load_rule_safe("rules.baseline", store)
        role_rules = _load_rule_safe(f"rules.role.{role}", store)

        customer_type = target_customer_type or "all"
        customer_rules = _load_rule_safe(f"rules.customer.{customer_type}", store)

        knowledge_context = _load_knowledge_for_role(role, store, f"{user_intent} {extra_note}")

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

    # 获取文本 provider
    provider = ProviderFactory.get_text_provider()

    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

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
