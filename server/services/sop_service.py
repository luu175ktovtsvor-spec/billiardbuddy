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

ROLE_LABELS = {
    "frontdesk": "服务员",
    "coach": "教练",
    "assistant_manager": "助教",
    "manager": "店长",
}

SCENARIO_LABELS = {
    "greeting": "迎宾接待",
    "checkout": "买单送客",
    "complaint": "投诉处理",
    "coaching": "教学",
    "promotion": "推广",
    "vip_service": "VIP服务",
}

CUSTOMER_TYPE_LABELS = {
    "new": "新客",
    "old": "普通客户",
    "vip": "VIP",
    "groupbuy": "团购客",
    "competition": "竞技客户",
    "all": "普通客户",
}


async def query_sop(
    db: AsyncSession,
    store: Store,
    user: User,
    role: str,
    scenario: str,
    customer_type: str = "all",
) -> Generation:
    template_key = "operation.frontdesk_sop"

    extra_vars = {
        "role": ROLE_LABELS.get(role, role),
        "scenario": SCENARIO_LABELS.get(scenario, scenario),
        "customer_type": CUSTOMER_TYPE_LABELS.get(customer_type, customer_type),
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt = _append_guardrails(rendered_prompt, store, role="frontdesk")

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
        type="sop",
        sub_type=scenario,
        input_params={
            "role": role,
            "scenario": scenario,
            "customer_type": customer_type,
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
