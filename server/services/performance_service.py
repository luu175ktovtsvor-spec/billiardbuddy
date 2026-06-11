import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import AIServiceError, AIProviderError
from core.security_guard import filter_output_leak
from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.prompt_engine import get_prompt_engine
from services.ai.base import TextRequest
from services.content_service import _append_guardrails
from services.quota_service import check_quota, increment_usage

prompt_engine = get_prompt_engine()

ROLE_LABELS = {
    "coach": "教练",
    "frontdesk": "收银员",
    "assistant_manager": "助教",
    "manager": "店长",
    "operator": "主管",
}

PERIOD_LABELS = {
    "weekly": "周度",
    "monthly": "月度",
    "quarterly": "季度",
}


async def generate_performance_template(
    db: AsyncSession,
    store: Store,
    user: User,
    role: str,
    period: str = "monthly",
) -> Generation:
    template_key = "operation.performance_template"

    extra_vars = {
        "role": ROLE_LABELS.get(role, role),
        "period": PERIOD_LABELS.get(period, period),
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt = _append_guardrails(
        rendered_prompt, store, role="assistant_manager",
        intent_text=f"绩效考核 {ROLE_LABELS.get(role, role)} {PERIOD_LABELS.get(period, period)}",
    )

    await check_quota(db, str(store.id))

    provider = ProviderFactory.get_text_provider()
    request = TextRequest(prompt=rendered_prompt, max_tokens=2500)
    try:
        response = await provider.generate(request)
    except AIProviderError as e:
        raise AIServiceError(e.message) from e
    except Exception as e:
        raise AIServiceError("AI 生成服务暂时不可用，请稍后重试") from e

    generation = Generation(
        id=uuid.uuid4(),
        store_id=store.id,
        user_id=user.id,
        type="performance",
        sub_type="template",
        input_params={
            "role": role,
            "period": period,
        },
        prompt_used=rendered_prompt,
        result=filter_output_leak(response.content),
        model_used=response.model,
        tokens_used=response.tokens_used,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)
    await increment_usage(db, str(store.id), tokens=response.tokens_used or 0)

    return generation
