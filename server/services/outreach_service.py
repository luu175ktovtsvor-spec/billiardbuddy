from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from models.store import Store
from models.generation import Generation
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import _append_guardrails, run_generation

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
    rendered_prompt = _append_guardrails(
        rendered_prompt, store, role="assistant_manager",
        intent_text=f"约客 {CUSTOMER_TYPE_LABELS.get(customer_type, customer_type)} {relationship} {extra_note}",
    )

    return await run_generation(
        db, store, user,
        prompt=rendered_prompt,
        gen_type="outreach",
        sub_type="generate",
        input_params={
            "customer_name": customer_name,
            "customer_type": customer_type,
            "relationship": relationship,
            "style": style,
            "extra_note": extra_note,
        },
        user_input=f"{customer_name} {relationship} {extra_note}",
        max_tokens=2000,
    )
