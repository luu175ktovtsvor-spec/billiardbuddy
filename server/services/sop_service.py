from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import _append_guardrails, run_generation

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
    rendered_prompt = _append_guardrails(
        rendered_prompt, store, role="frontdesk",
        intent_text=f"{SCENARIO_LABELS.get(scenario, scenario)} {ROLE_LABELS.get(role, role)}",
    )

    return await run_generation(
        db, store, user,
        prompt=rendered_prompt,
        gen_type="sop",
        sub_type=scenario,
        input_params={
            "role": role,
            "scenario": scenario,
            "customer_type": customer_type,
        },
        max_tokens=2000,
    )
