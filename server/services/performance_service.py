from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import _append_guardrails, run_generation

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
    rendered_prompt, knowledge_names = _append_guardrails(
        rendered_prompt, store, role="assistant_manager",
        intent_text=f"绩效考核 {ROLE_LABELS.get(role, role)} {PERIOD_LABELS.get(period, period)}",
    )

    return await run_generation(
        db, store, user,
        prompt=rendered_prompt,
        gen_type="performance",
        sub_type="template",
        input_params={"role": role, "period": period, "knowledge_used": knowledge_names},
        max_tokens=2500,
    )
