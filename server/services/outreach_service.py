import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import AIServiceError, AIProviderError
from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.prompt_engine import get_prompt_engine
from services.ai.base import TextRequest
from services.content_service import _append_guardrails
from services.quota_service import check_quota, increment_usage

prompt_engine = get_prompt_engine()

CUSTOMER_TYPE_LABELS = {
    "new": "新客",
    "old": "老客",
    "vip": "VIP",
    "groupbuy": "团购客",
    "competition": "竞技客户",
    "assistant": "助教客户",
}

STYLE_LABELS = {
    "friendly": "亲切",
    "professional": "专业",
    "lively": "活泼",
    "warm": "温暖",
}


async def generate_outreach(
    db: AsyncSession,
    store: Store,
    user: User,
    customer_name: str,
    customer_type: str,
    relationship: str,
    style: str,
    extra_note: str = "",
) -> Generation:
    template_key = "operation.assistant_outreach"

    extra_vars = {
        "customer_name": customer_name,
        "customer_type": CUSTOMER_TYPE_LABELS.get(customer_type, customer_type),
        "relationship": relationship,
        "style": STYLE_LABELS.get(style, style),
        "extra_note": extra_note or "无",
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt = _append_guardrails(rendered_prompt, store, role="assistant_manager")

    await check_quota(db, str(store.id))

    provider = ProviderFactory.get_text_provider()
    request = TextRequest(prompt=rendered_prompt, max_tokens=2000)
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
        type="outreach",
        sub_type="generate",
        input_params={
            "customer_name": customer_name,
            "customer_type": customer_type,
            "relationship": relationship,
            "style": style,
            "extra_note": extra_note,
        },
        prompt_used=rendered_prompt,
        result=response.content,
        model_used=response.model,
        tokens_used=response.tokens_used,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)
    await increment_usage(db, str(store.id), tokens=response.tokens_used or 0)

    return generation
