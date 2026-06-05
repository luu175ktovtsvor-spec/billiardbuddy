import uuid

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from core.exceptions import AppException
from models.store import Store, StoreMember


class StoreAlreadyExistsError(AppException):
    def __init__(self):
        super().__init__("您已创建过门店", status_code=409)


class StoreNotFoundError(AppException):
    def __init__(self):
        super().__init__("未找到门店", status_code=404)


class NoPermissionError(AppException):
    def __init__(self):
        super().__init__("无权限执行该操作", status_code=403)


def calculate_completeness(store: Store) -> int:
    """计算门店资料完整度百分比"""
    score = 0
    # 必填项 60%
    if store.name: score += 10
    if store.city: score += 5
    if store.address: score += 10
    if store.business_hours: score += 10
    if store.phone: score += 5
    if store.pricing: score += 15
    if store.target_customers: score += 5
    # 建议项 40%
    if store.logo_url: score += 5
    if store.qrcode_url: score += 5
    if store.table_count and store.table_types: score += 3
    if store.member_cards: score += 7
    if store.has_private_room is not None: score += 2
    if store.has_coaching is not None: score += 2
    if store.has_tournament is not None: score += 2
    if store.has_parking is not None: score += 2
    if store.style: score += 3
    if store.advantages: score += 4
    if store.common_activities: score += 5
    return score


async def create_store(
    db: AsyncSession, user_id: uuid.UUID, data: dict
) -> Store:
    # 检查用户是否已有门店
    existing = await db.execute(
        select(StoreMember).where(StoreMember.user_id == user_id)
    )
    if existing.scalar_one_or_none():
        raise StoreAlreadyExistsError()

    store = Store(owner_id=user_id, **data)
    db.add(store)
    await db.flush()

    member = StoreMember(
        store_id=store.id,
        user_id=user_id,
        role="owner",
    )
    db.add(member)
    await db.commit()
    await db.refresh(store)
    return store


_UPDATE_ALLOWED_FIELDS = {
    "name", "city", "district", "address", "phone", "business_hours",
    "table_count", "table_types", "pricing", "member_cards",
    "target_customers", "advantages", "common_activities", "style",
    "has_private_room", "has_coaching", "has_tournament", "has_parking",
    "operation_profile",
    # 助教资料
    "coach_count", "coach_service_types", "coach_price_range",
    # 商品定价
    "beverage_price_range", "snack_price_range", "cue_price_range",
    # 设备品牌
    "table_brands", "cue_brands", "other_equipment",
    # 会员体系
    "membership_types", "recharge_rules", "membership_benefits",
    # 营业数据
    "daily_avg_customers", "peak_hours", "avg_spend_range",
}


async def update_store(
    db: AsyncSession, store: Store, data: dict
) -> Store:
    for field, value in data.items():
        if field not in _UPDATE_ALLOWED_FIELDS:
            continue
        setattr(store, field, value)
    await db.commit()
    await db.refresh(store)
    return store
