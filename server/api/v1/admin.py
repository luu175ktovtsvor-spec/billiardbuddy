from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_db
from models.user import User
from models.store import Store, StoreMember
from models.plan import Plan, StoreSubscription
from models.generation import Generation
from models.quota import UsageQuota

router = APIRouter(prefix="/admin", tags=["admin"])


def require_admin(user: User):
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="需要管理员权限")


@router.get("/dashboard")
async def admin_dashboard(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)

    total_users = await db.scalar(select(func.count(User.id)))
    total_stores = await db.scalar(select(func.count(Store.id)))
    total_generations = await db.scalar(select(func.count(Generation.id)))

    return {
        "total_users": total_users,
        "total_stores": total_stores,
        "total_generations": total_generations,
    }


@router.get("/users")
async def list_users(
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)

    offset = (page - 1) * page_size
    users = await db.scalars(
        select(User).order_by(User.created_at.desc()).offset(offset).limit(page_size)
    )
    total = await db.scalar(select(func.count(User.id)))

    return {"items": users.all(), "total": total, "page": page}


@router.post("/users/{user_id}/activate")
async def activate_user(
    user_id: str,
    plan_slug: str,
    months: int = 1,
    payment_note: str = "",
    payment_amount: int = 0,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)

    # 获取套餐
    plan = await db.scalar(select(Plan).where(Plan.slug == plan_slug))
    if not plan:
        raise HTTPException(status_code=404, detail="套餐不存在")

    # 获取用户的门店
    member = await db.scalar(
        select(StoreMember).where(StoreMember.user_id == user_id)
    )
    if not member:
        raise HTTPException(status_code=404, detail="用户没有门店")

    # 创建订阅
    now = datetime.now(timezone.utc)
    subscription = StoreSubscription(
        store_id=member.store_id,
        plan_id=plan.id,
        status="active",
        current_period_start=now,
        current_period_end=now + timedelta(days=30 * months),
        activated_by=user.id,
        payment_note=payment_note,
        payment_amount=payment_amount,
    )
    db.add(subscription)

    # 更新配额
    quota = await db.scalar(select(UsageQuota).where(UsageQuota.store_id == member.store_id))
    if quota:
        quota.monthly_generation_limit = plan.generation_limit
        quota.monthly_tokens_limit = plan.token_limit

    await db.commit()
    return {"status": "ok", "plan": plan.name, "expires": subscription.current_period_end}


@router.get("/plans")
async def list_plans(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    plans = await db.scalars(select(Plan).where(Plan.is_active == True))
    return plans.all()
