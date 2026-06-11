import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import AIServiceError, AIProviderError
from core.security_guard import check_input_injection, filter_output_leak
from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.prompt_engine import get_prompt_engine
from services.ai.base import TextRequest
from services.content_service import _append_guardrails
from services.quota_service import check_quota, increment_usage

prompt_engine = get_prompt_engine()

SKILL_LEVEL_LABELS = {
    "beginner": "新手",
    "intermediate": "一般",
    "advanced": "高手",
    "mixed": "混合",
}


async def recommend_games(
    db: AsyncSession,
    store: Store,
    user: User,
    customer_count: int,
    skill_level: str,
    time_available: str,
) -> Generation:
    injection_check = check_input_injection(time_available)
    if injection_check:
        raise AIServiceError(injection_check)

    template_key = "operation.game_recommend"

    extra_vars = {
        "customer_count": str(customer_count),
        "skill_level": SKILL_LEVEL_LABELS.get(skill_level, skill_level),
        "time_available": time_available,
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt = _append_guardrails(
        rendered_prompt, store, role="coach",
        intent_text=f"小游戏 {SKILL_LEVEL_LABELS.get(skill_level, skill_level)} {time_available}",
    )

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
        type="games",
        sub_type="recommend",
        input_params={
            "customer_count": customer_count,
            "skill_level": skill_level,
            "time_available": time_available,
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
