from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_, desc
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_db
from models.user import User
from models.store import Store, StoreMember
from models.plan import Plan, StoreSubscription, SubscriptionPayment
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
    # store_id.isnot(None) 让自动租户过滤跳过本查询（管理后台需全局统计），同时过滤软删除
    total_generations = await db.scalar(
        select(func.count(Generation.id)).where(
            Generation.is_deleted == False, Generation.store_id.isnot(None)
        )
    )

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

    # 显式序列化，禁止把 ORM 对象直接下发（会泄露 password_hash）
    items = [
        {
            "id": str(u.id),
            "phone": u.phone,
            "name": u.name,
            "is_active": u.is_active,
            "is_admin": u.is_admin,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users.all()
    ]
    return {"items": items, "total": total, "page": page}


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
    await db.flush()

    # 收款流水（收入统计以流水为准）
    if payment_amount > 0:
        db.add(SubscriptionPayment(
            subscription_id=subscription.id,
            amount=payment_amount,
            note=payment_note,
            kind="new",
            created_by=user.id,
        ))

    # 更新配额：无配额行时创建（否则套餐限额被首次生成的默认值顶掉）
    quota = await db.scalar(select(UsageQuota).where(UsageQuota.store_id == member.store_id))
    if quota is None:
        from services.quota_service import _period_start_now
        quota = UsageQuota(
            store_id=member.store_id,
            monthly_generations_used=0,
            monthly_tokens_used=0,
            current_period_start=_period_start_now(),
        )
        db.add(quota)
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


# ========== 用户详情 ==========
@router.get("/users/{user_id}")
async def get_user_detail(
    user_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    target = await db.scalar(select(User).where(User.id == user_id))
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 获取门店信息
    member = await db.scalar(select(StoreMember).where(StoreMember.user_id == user_id))
    store_info = None
    subscription_info = None
    quota_info = None
    if member:
        store = await db.scalar(select(Store).where(Store.id == member.store_id))
        if store:
            store_info = {"id": str(store.id), "name": store.name, "city": store.city}
        sub = await db.scalar(select(StoreSubscription).where(StoreSubscription.store_id == member.store_id).order_by(desc(StoreSubscription.created_at)))
        if sub:
            plan = await db.scalar(select(Plan).where(Plan.id == sub.plan_id))
            subscription_info = {
                "plan_name": plan.name if plan else "未知",
                "status": sub.status,
                "period_end": sub.current_period_end.isoformat() if sub.current_period_end else None,
                "payment_amount": sub.payment_amount,
                "payment_note": sub.payment_note,
            }
        quota = await db.scalar(select(UsageQuota).where(UsageQuota.store_id == member.store_id))
        if quota:
            quota_info = {
                "monthly_generation_limit": quota.monthly_generation_limit,
                "monthly_generations_used": quota.monthly_generations_used,
                "monthly_tokens_used": quota.monthly_tokens_used,
            }

    # 获取生成统计（store_id.isnot(None) 跳过自动租户过滤 + 过滤软删除）
    total_generations = await db.scalar(
        select(func.count(Generation.id)).where(
            Generation.user_id == user_id, Generation.is_deleted == False, Generation.store_id.isnot(None)
        )
    )
    recent_generations = await db.scalars(
        select(Generation)
        .where(Generation.user_id == user_id, Generation.is_deleted == False, Generation.store_id.isnot(None))
        .order_by(desc(Generation.created_at)).limit(10)
    )
    recent_list = [{"id": str(g.id), "type": g.type, "sub_type": g.sub_type, "created_at": g.created_at.isoformat()} for g in recent_generations.all()]

    return {
        "user": {"id": str(target.id), "phone": target.phone, "name": target.name, "is_active": target.is_active, "is_admin": target.is_admin, "created_at": target.created_at.isoformat()},
        "store": store_info,
        "subscription": subscription_info,
        "quota": quota_info,
        "stats": {"total_generations": total_generations or 0},
        "recent_generations": recent_list,
    }


# ========== 用户禁用/启用 ==========
@router.put("/users/{user_id}/status")
async def toggle_user_status(
    user_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    target = await db.scalar(select(User).where(User.id == user_id))
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    target.is_active = not target.is_active
    await db.commit()
    return {"status": "ok", "is_active": target.is_active}


# ========== 订阅列表 ==========
@router.get("/subscriptions")
async def list_subscriptions(
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    status: str = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    query = select(StoreSubscription).order_by(desc(StoreSubscription.current_period_end))
    if status:
        query = query.where(StoreSubscription.status == status)
    offset = (page - 1) * page_size
    subs = await db.scalars(query.offset(offset).limit(page_size))
    total = await db.scalar(select(func.count(StoreSubscription.id)))

    # 批量预取，避免逐行 N+1 查询（原先每条订阅 4 次查询）
    subs_list = subs.all()
    plan_ids = {s.plan_id for s in subs_list}
    store_ids = {s.store_id for s in subs_list}
    plans_map = {p.id: p for p in (await db.scalars(select(Plan).where(Plan.id.in_(plan_ids)))).all()} if plan_ids else {}
    stores_map = {st.id: st for st in (await db.scalars(select(Store).where(Store.id.in_(store_ids)))).all()} if store_ids else {}
    member_by_store: dict = {}
    if store_ids:
        for mb in (await db.scalars(select(StoreMember).where(StoreMember.store_id.in_(store_ids)))).all():
            member_by_store.setdefault(mb.store_id, mb)
    user_ids = {mb.user_id for mb in member_by_store.values()}
    users_map = {u.id: u for u in (await db.scalars(select(User).where(User.id.in_(user_ids)))).all()} if user_ids else {}

    result = []
    for sub in subs_list:
        plan = plans_map.get(sub.plan_id)
        store = stores_map.get(sub.store_id)
        member = member_by_store.get(sub.store_id)
        user_info = users_map.get(member.user_id) if member else None
        result.append({
            "id": str(sub.id),
            "store_name": store.name if store else "未知",
            "user_phone": user_info.phone if user_info else "未知",
            "plan_name": plan.name if plan else "未知",
            "status": sub.status,
            "period_start": sub.current_period_start.isoformat(),
            "period_end": sub.current_period_end.isoformat(),
            "payment_amount": sub.payment_amount,
            "payment_note": sub.payment_note,
        })

    return {"items": result, "total": total, "page": page}


# ========== 续费 ==========
@router.post("/subscriptions/{sub_id}/renew")
async def renew_subscription(
    sub_id: str,
    months: int = 1,
    payment_note: str = "",
    payment_amount: int = 0,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    sub = await db.scalar(select(StoreSubscription).where(StoreSubscription.id == sub_id))
    if not sub:
        raise HTTPException(status_code=404, detail="订阅不存在")

    now = datetime.now(timezone.utc)
    base = sub.current_period_end if sub.current_period_end > now else now
    sub.current_period_end = base + timedelta(days=30 * months)
    sub.status = "active"
    # payment_amount/payment_note 仅作"最近一笔"展示；历史收款进流水表，统计不再失真
    sub.payment_note = payment_note
    sub.payment_amount = payment_amount
    sub.updated_at = now
    if payment_amount > 0:
        db.add(SubscriptionPayment(
            subscription_id=sub.id,
            amount=payment_amount,
            note=payment_note,
            kind="renew",
            created_by=user.id,
        ))
    await db.commit()
    return {"status": "ok", "new_period_end": sub.current_period_end.isoformat()}


# ========== 收入统计 ==========
@router.get("/revenue")
async def get_revenue_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    # 收入统计基于收款流水：续费各算一笔、计入实际收款月份（订阅字段只存最近一笔）
    month_revenue = await db.scalar(
        select(func.sum(SubscriptionPayment.amount))
        .where(SubscriptionPayment.created_at >= month_start)
    ) or 0

    # 总收入
    total_revenue = await db.scalar(select(func.sum(SubscriptionPayment.amount))) or 0

    # 本月收款笔数
    month_count = await db.scalar(
        select(func.count(SubscriptionPayment.id))
        .where(SubscriptionPayment.created_at >= month_start)
    ) or 0

    # 即将到期（7天内）
    week_later = now + timedelta(days=7)
    expiring_soon = await db.scalar(
        select(func.count(StoreSubscription.id))
        .where(and_(StoreSubscription.current_period_end <= week_later, StoreSubscription.current_period_end > now, StoreSubscription.status == "active"))
    ) or 0

    # 已过期
    expired = await db.scalar(
        select(func.count(StoreSubscription.id))
        .where(and_(StoreSubscription.current_period_end < now, StoreSubscription.status == "active"))
    ) or 0

    return {
        "month_revenue": month_revenue,
        "total_revenue": total_revenue,
        "month_count": month_count,
        "expiring_soon": expiring_soon,
        "expired": expired,
    }


# ========== 套餐创建 ==========
@router.post("/plans")
async def create_plan(
    name: str,
    slug: str,
    price_monthly: int = 0,
    generation_limit: int = 100,
    token_limit: int = 500000,
    poster_limit: int = 5,
    max_members: int = 1,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    existing = await db.scalar(select(Plan).where(Plan.slug == slug))
    if existing:
        raise HTTPException(status_code=400, detail="套餐slug已存在")
    plan = Plan(name=name, slug=slug, price_monthly=price_monthly, generation_limit=generation_limit, token_limit=token_limit, poster_limit=poster_limit, max_members=max_members)
    db.add(plan)
    await db.commit()
    return {"status": "ok", "id": str(plan.id)}


# ========== 套餐编辑 ==========
@router.put("/plans/{plan_id}")
async def update_plan(
    plan_id: str,
    name: str = None,
    price_monthly: int = None,
    generation_limit: int = None,
    token_limit: int = None,
    poster_limit: int = None,
    max_members: int = None,
    is_active: bool = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    require_admin(user)
    plan = await db.scalar(select(Plan).where(Plan.id == plan_id))
    if not plan:
        raise HTTPException(status_code=404, detail="套餐不存在")
    if name is not None: plan.name = name
    if price_monthly is not None: plan.price_monthly = price_monthly
    if generation_limit is not None: plan.generation_limit = generation_limit
    if token_limit is not None: plan.token_limit = token_limit
    if poster_limit is not None: plan.poster_limit = poster_limit
    if max_members is not None: plan.max_members = max_members
    if is_active is not None: plan.is_active = is_active
    await db.commit()
    return {"status": "ok"}
