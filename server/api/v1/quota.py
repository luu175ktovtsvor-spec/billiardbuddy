"""配额查询 API"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from api.deps import get_db, get_current_store
from core.rbac import Permission, require_permission
from models.plan import Plan, StoreSubscription
from services.quota_service import get_or_create_quota

router = APIRouter()


class QuotaResponse(BaseModel):
    monthly_generation_limit: int
    monthly_generations_used: int
    monthly_tokens_limit: int
    monthly_tokens_used: int
    remaining: int
    plan_name: str | None = None  # 无有效订阅 = 试用版

    model_config = {"from_attributes": True}


@router.get("/", response_model=QuotaResponse)
async def get_quota(
    _perm: None = Depends(require_permission(Permission.QUOTA_VIEW)),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    quota = await get_or_create_quota(db, str(store.id))

    # 当前有效套餐名（前端用于区分"试用版/正式套餐"展示）
    now = datetime.now(timezone.utc)
    plan_name = None
    sub = await db.scalar(
        select(StoreSubscription).where(
            StoreSubscription.store_id == store.id,
            StoreSubscription.status == "active",
            StoreSubscription.current_period_end > now,
        )
    )
    if sub:
        plan = await db.get(Plan, sub.plan_id)
        plan_name = plan.name if plan else None

    return QuotaResponse(
        monthly_generation_limit=quota.monthly_generation_limit,
        monthly_generations_used=quota.monthly_generations_used,
        monthly_tokens_limit=quota.monthly_tokens_limit,
        monthly_tokens_used=quota.monthly_tokens_used,
        remaining=max(0, quota.monthly_generation_limit - quota.monthly_generations_used),
        plan_name=plan_name,
    )
