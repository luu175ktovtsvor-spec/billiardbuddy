import json
import uuid
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

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
    model = body.model

    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    if prompt_key:
        # 从 prompt_key 推断 scenario（如 copywriting.moments → moments）
        scenario_name = prompt_key.split(".", 1)[-1] if "." in prompt_key else prompt_key
        extra_vars = {
            "tone": TONE_LABELS.get("friendly", "friendly"),
            "target": CUSTOMER_LABELS.get(target_customer_type or "all", "全部客户"),
            "extra_note": extra_note or "无",
            "scenario": scenario_name,
        }
        rendered_prompt = prompt_engine.render(prompt_key, store, extra_vars)
        rendered_prompt = _append_guardrails(rendered_prompt, store, role=role)
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

    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)

    async def event_generator():
        full_content = ""
        generation_id = str(uuid.uuid4())
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

        try:
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
                tokens_used=0,
            )
            db.add(generation)
            await db.commit()
            await increment_usage(db, str(store.id), tokens=0)
        except Exception as e:
            logger.error("Failed to save stream generation: %s", e)

        yield f"data: {json.dumps({'token': '', 'done': True, 'full_content': content, 'generation_id': generation_id}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )