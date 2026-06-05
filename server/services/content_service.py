import uuid
import logging

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


def _load_knowledge_for_role(role: str, store: Store) -> str:
    """根据岗位规则中声明的 required_knowledge，加载并拼接对应知识库。"""
    role_template = prompt_engine._templates.get(f"rules.role.{role}")
    if not role_template:
        return ""

    required_keys = role_template.get("required_knowledge", [])
    if not required_keys:
        return ""

    parts: list[str] = []
    for key in required_keys:
        try:
            rendered = prompt_engine.render(key, store, {})
            if rendered.strip():
                parts.append(rendered.strip())
        except (PromptTemplateNotFoundError, PromptVariableMissingError):
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
    """去除 AI 回应语前缀。"""
    prefixes_to_strip = [
        "好的，店长！",
        "好的，店长",
        "好的！",
        "没问题，我来帮你",
        "以下是为你生成的",
        "好的，没问题！",
    ]
    for prefix in prefixes_to_strip:
        if content.startswith(prefix):
            content = content[len(prefix):].lstrip("\n").lstrip()
            break
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
    request = TextRequest(prompt=rendered_prompt)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    content = _strip_ai_prefixes(response.content)

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

    template_key = f"operation.{scenario}"

    # 根据场景推断岗位，用于注入对应的 role_rules 和 knowledge
    scenario_role_map = {
        "groupbuy_to_private": "frontdesk",
        "assistant_promo": "assistant_manager",
        "partner_match": "coach",
        "tournament": "coach",
        "old_customer_recall": "manager",
    }
    inferred_role = scenario_role_map.get(scenario, "manager")

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
) -> Generation:
    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    if prompt_key:
        # promptKey 路径：使用指定场景模板（如 operation.qiangyi_battle），再追加防护上下文
        extra_vars = {
            "tone": TONE_LABELS.get("friendly", "friendly"),
            "target": CUSTOMER_LABELS.get(target_customer_type or "all", "全部客户"),
            "extra_note": extra_note or "无",
        }
        rendered_prompt = prompt_engine.render(prompt_key, store, extra_vars)

        # 推断岗位用于注入对应 role_rules 和 knowledge
        scenario_role_map = {
            "groupbuy_to_private": "frontdesk",
            "assistant_promo": "assistant_manager",
            "partner_match": "coach",
            "tournament": "coach",
            "old_customer_recall": "manager",
            "assistant_outreach": "assistant_manager",
            "assistant_booking": "assistant_manager",
            "member_assistant_notice": "assistant_manager",
            "daily_report": role,
            "performance_template": "assistant_manager",
            "daily_task_list": role,
            "vip_maintenance": "manager",
            "group_content": "operator",
            "short_video": "operator",
            "complaint_handling": "frontdesk",
            "frontdesk_sop": "frontdesk",
            "tournament_signup": "coach",
            "tournament_report": "coach",
            "qiangyi_battle": "coach",
            "review_guidance": "coach",
            "cart_promotion": "frontdesk",
            "opening_event": "operator",
            "recruitment": "assistant_manager",
            "training_exam": "assistant_manager",
            "diagnosis_tool": "boss",
            "coaching_promo": "coach",
            "competition_customer": "coach",
            "empty_table_promo": "frontdesk",
            "departure_followup": "frontdesk",
            "customer_group_guide": "frontdesk",
            "opening_closing_sop": "frontdesk",
            "equipment_management": "frontdesk",
            "store_atmosphere": "operator",
            "poster_copy": "operator",
            "sports_event_watching": "manager",
            "staff_birthday": "manager",
            "hygiene_check": "frontdesk",
            "champion_poster": "coach",
            "tournament_rules": "coach",
            "monthly_report": "boss",
            "activity_direction": "boss",
            "business_strategy": "boss",
            "table_content_plan": "operator",
            "game_recommend": "coach",
            "ip_cooperation": "assistant_manager",
            "review_meeting": "manager",
            "holiday_promo": "operator",
            "new_store_opening": "operator",
            "member_day": "operator",
        }
        # 从 prompt_key 提取场景名（如 "operation.qiangyi_battle" → "qiangyi_battle"）
        scenario_name = prompt_key.split(".", 1)[-1] if "." in prompt_key else prompt_key
        inferred_role = scenario_role_map.get(scenario_name, role)
        rendered_prompt = _append_guardrails(rendered_prompt, store, role=inferred_role)
    else:
        # 通用 free_intent 路径：在模板内注入规则和知识
        baseline_rules = _load_rule_safe("rules.baseline", store)
        role_rules = _load_rule_safe(f"rules.role.{role}", store)

        customer_type = target_customer_type or "all"
        customer_rules = _load_rule_safe(f"rules.customer.{customer_type}", store)

        knowledge_context = _load_knowledge_for_role(role, store)

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

    provider = ProviderFactory.get_text_provider()
    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    content = response.content
    prefixes_to_strip = [
        "好的，店长！",
        "好的，店长",
        "好的！",
        "没问题，我来帮你",
        "以下是为你生成的",
        "好的，没问题！",
    ]
    for prefix in prefixes_to_strip:
        if content.startswith(prefix):
            content = content[len(prefix):].lstrip("\n").lstrip()
            break

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
