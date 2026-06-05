import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import AIServiceError, AIProviderError
from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.prompt_engine import get_prompt_engine
from services.ai.base import TextRequest
from services.content_service import _append_guardrails, _strip_ai_prefixes
from services.quota_service import check_quota, increment_usage

prompt_engine = get_prompt_engine()

PROBLEM_AREA_LABELS = {
    "traffic": "客流",
    "revenue": "营收",
    "customer_loss": "服务",
    "staff": "团队",
    "competition": "竞争",
    "activity_effect": "综合",
}


async def analyze_diagnosis(
    db: AsyncSession,
    store: Store,
    user: User,
    problem_area: str,
    current_situation: str,
) -> Generation:
    template_key = "operation.diagnosis_tool"

    extra_vars = {
        "problem_area": PROBLEM_AREA_LABELS.get(problem_area, problem_area),
        "current_situation": current_situation,
    }

    rendered_prompt = prompt_engine.render(template_key, store, extra_vars)
    rendered_prompt = _append_guardrails(rendered_prompt, store, role="manager")

    await check_quota(db, str(store.id))

    provider = ProviderFactory.get_text_provider()
    request = TextRequest(prompt=rendered_prompt, max_tokens=3000)
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
        type="diagnosis",
        sub_type=problem_area,
        input_params={
            "problem_area": problem_area,
            "current_situation": current_situation,
        },
        prompt_used=rendered_prompt,
        result=response.content,
        model_used=response.model,
        tokens_used=response.tokens_used,
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)
    await increment_usage(db, str(store.id), tokens=response.tokens_used)

    return generation
