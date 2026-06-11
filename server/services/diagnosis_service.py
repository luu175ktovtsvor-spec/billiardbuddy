from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import _append_guardrails, run_generation

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
    rendered_prompt = _append_guardrails(
        rendered_prompt, store, role="manager",
        intent_text=f"{PROBLEM_AREA_LABELS.get(problem_area, problem_area)} {current_situation}",
    )

    return await run_generation(
        db, store, user,
        prompt=rendered_prompt,
        gen_type="diagnosis",
        sub_type=problem_area,
        input_params={
            "problem_area": problem_area,
            "current_situation": current_situation,
        },
        user_input=current_situation,
    )
