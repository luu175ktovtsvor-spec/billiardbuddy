import json
import uuid
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from api.deps import get_current_user, get_current_store, get_db
from core.rbac import Permission, require_permission
from models.user import User
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.base import TextRequest
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import (
    _load_rule_safe,
    _load_knowledge_for_role,
    _format_output_package,
    _strip_ai_prefixes,
    _append_guardrails,
    ROLE_LABELS,
    CUSTOMER_LABELS,
    TONE_LABELS,
    _validate_provider_for_production,
)
from schemas.generate import WorkbenchRequest
from services.store_profile_service import render_operation_profile_context
from services.quota_service import check_quota, increment_usage
from services.workbench_fewshot_service import select_workbench_fewshots
from services.brand_voice_service import get_brand_voice_context
from core.security_guard import check_input_injection, filter_output_leak

logger = logging.getLogger(__name__)
router = APIRouter()
prompt_engine = get_prompt_engine()


@router.post("/workbench")
async def stream_workbench(
    body: WorkbenchRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    user_intent = body.user_intent
    role = body.role.value if hasattr(body.role, 'value') else body.role
    target_customer_type = body.target_customer_type.value if body.target_customer_type and hasattr(body.target_customer_type, 'value') else body.target_customer_type
    output_package = [item.value if hasattr(item, 'value') else item for item in (body.output_package or [])]
    extra_note = body.extra_note
    prompt_key = body.prompt_key

    # 输入安全检查
    injection_check = check_input_injection((user_intent or "") + " " + (extra_note or ""))
    if injection_check:
        from core.exceptions import AIServiceError
        raise AIServiceError(injection_check)
    model = body.model
    conversation_id = body.conversation_id

    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    if prompt_key:
        extra_vars = {
            "tone": TONE_LABELS.get("friendly", "friendly"),
            "target": CUSTOMER_LABELS.get(target_customer_type or "all", "全部客户"),
            "extra_note": extra_note or "无",
            "scenario": "日常",
        }
        rendered_prompt = prompt_engine.render(prompt_key, store, extra_vars)
        # 根据prompt_key推断岗位角色，与content_service.py保持一致
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
        scenario_name = prompt_key.split(".", 1)[-1] if "." in prompt_key else prompt_key
        inferred_role = scenario_role_map.get(scenario_name, role)
        rendered_prompt = _append_guardrails(rendered_prompt, store, role=inferred_role)
    else:
        baseline_rules = _load_rule_safe("rules.baseline", store)
        role_rules = _load_rule_safe(f"rules.role.{role}", store)
        customer_type = target_customer_type or "all"
        customer_rules = _load_rule_safe(f"rules.customer.{customer_type}", store)
        knowledge_context = _load_knowledge_for_role(role, store)
        profile_context = render_operation_profile_context(store)

        # 轻量 few-shot 选择
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
            "user_intent": user_intent,
            "role_label": ROLE_LABELS.get(role, role),
            "target_customer_label": CUSTOMER_LABELS.get(customer_type, customer_type),
            "output_package_label": _format_output_package(output_package),
            "extra_note": extra_note or "无",
            "profile_context": profile_context,
            "fewshot_examples": fewshot_examples,
        }

        rendered_prompt = prompt_engine.render("workbench.free_intent", store, extra_vars)

    # 构建 messages 数组（支持多轮对话）
    messages = []

    # 获取品牌声音上下文
    brand_voice = await get_brand_voice_context(db, store.id)
    if brand_voice:
        rendered_prompt = f"{rendered_prompt}\n\n---\n{brand_voice}\n---"

    # 1. System prompt
    if rendered_prompt:
        messages.append({"role": "system", "content": rendered_prompt})

    # 2. 历史对话（最近 5 轮）
    if conversation_id:
        try:
            hist_stmt = (
                select(Generation)
                .where(
                    Generation.conversation_id == uuid.UUID(conversation_id),
                    Generation.type == "workbench",
                )
                .order_by(Generation.created_at)
            )
            hist_result = await db.execute(hist_stmt)
            history_gens = hist_result.scalars().all()

            for hg in history_gens[-5:]:
                hist_params = hg.input_params or {}
                hist_intent = hist_params.get("user_intent", "")
                hist_result_text = hg.result or ""
                if hist_intent:
                    messages.append({"role": "user", "content": hist_intent})
                if hist_result_text:
                    messages.append({"role": "assistant", "content": hist_result_text[:2000]})
        except Exception:
            logger.warning("加载对话历史失败", exc_info=True)

    # 3. 当前用户输入
    messages.append({"role": "user", "content": user_intent or rendered_prompt})

    # 传入 TextRequest
    request = TextRequest(
        prompt=user_intent or rendered_prompt,
        system_prompt=rendered_prompt if not conversation_id else None,
        messages=messages if conversation_id else None,
        max_tokens=3000,
    )

    async def event_generator():
        full_content = ""
        generation_id = str(uuid.uuid4())
        provider = ProviderFactory.resolve_provider(model)
        try:
            async for token, fallback_used in ProviderFactory.generate_stream_with_fallback(request, model=model):
                full_content += token
                data = json.dumps({"token": token, "done": False, "fallback_used": fallback_used}, ensure_ascii=False)
                yield f"data: {data}\n\n"

        except Exception as e:
            logger.error("SSE stream error: %s", e)
            yield f"data: {json.dumps({'error': '生成过程中出现错误，请重试'}, ensure_ascii=False)}\n\n"
            return

        content = _strip_ai_prefixes(full_content)
        content = filter_output_leak(content)

        # 获取 tokens_used（从 provider 的 _last_usage 获取）
        tokens_used = 0
        if hasattr(provider, '_last_usage') and provider._last_usage:
            tokens_used = provider._last_usage.get("total_tokens", 0)

        try:
            # 使用传入的 conversation_id，或用本次 generation_id 作为新对话的 conversation_id
            conv_id = uuid.UUID(conversation_id) if conversation_id else uuid.UUID(generation_id)

            generation = Generation(
                id=uuid.UUID(generation_id),
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
                    "stream": True,
                },
                prompt_used=rendered_prompt,
                result=content,
                model_used="stream",
                tokens_used=tokens_used,
                conversation_id=conv_id,
            )
            db.add(generation)
            await db.commit()
            await increment_usage(db, str(store.id), tokens=tokens_used)
        except Exception as e:
            logger.error("Failed to save stream generation: %s", e)

        yield f"data: {json.dumps({'token': '', 'done': True, 'full_content': content, 'generation_id': generation_id, 'conversation_id': str(conv_id), 'tokens_used': tokens_used}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )