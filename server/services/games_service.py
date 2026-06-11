from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import _append_guardrails, run_generation

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

    return await run_generation(
        db, store, user,
        prompt=rendered_prompt,
        gen_type="games",
        sub_type="recommend",
        input_params={
            "customer_count": customer_count,
            "skill_level": skill_level,
            "time_available": time_available,
        },
        user_input=time_available,
        max_tokens=2000,
    )
