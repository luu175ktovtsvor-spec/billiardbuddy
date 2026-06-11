"""配额检查与更新服务"""

import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from models.quota import UsageQuota

logger = logging.getLogger(__name__)

# 默认配额
DEFAULT_GENERATION_LIMIT = 100
DEFAULT_TOKENS_LIMIT = 500000

# 业务时区（月度配额按中国时区重置，避免 UTC 月底错位数小时）
BUSINESS_TZ = ZoneInfo("Asia/Shanghai")


def _period_start_now() -> datetime:
    now = datetime.now(BUSINESS_TZ)
    start_local = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return start_local.astimezone(timezone.utc)


def _is_new_period(quota: UsageQuota) -> bool:
    if quota.current_period_start is None:
        return True
    now = datetime.now(BUSINESS_TZ)
    start = quota.current_period_start
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    start_local = start.astimezone(BUSINESS_TZ)
    return now.year > start_local.year or now.month > start_local.month


async def get_or_create_quota(db: AsyncSession, store_id: str) -> UsageQuota:
    result = await db.execute(
        select(UsageQuota).where(UsageQuota.store_id == store_id)
    )
    quota = result.scalar_one_or_none()
    if quota is None:
        # ON CONFLICT DO NOTHING：store_id 唯一约束下并发首建不再抛 IntegrityError
        import uuid as _uuid
        await db.execute(
            pg_insert(UsageQuota)
            .values(
                id=_uuid.uuid4(),
                store_id=store_id,
                monthly_generation_limit=DEFAULT_GENERATION_LIMIT,
                monthly_tokens_limit=DEFAULT_TOKENS_LIMIT,
                monthly_generations_used=0,
                monthly_tokens_used=0,
                current_period_start=_period_start_now(),
            )
            .on_conflict_do_nothing(index_elements=["store_id"])
        )
        await db.commit()
        result = await db.execute(
            select(UsageQuota).where(UsageQuota.store_id == store_id)
        )
        quota = result.scalar_one()
    if _is_new_period(quota):
        quota.monthly_generations_used = 0
        quota.monthly_tokens_used = 0
        quota.current_period_start = _period_start_now()
        await db.commit()
        await db.refresh(quota)
    return quota


async def check_quota(db: AsyncSession, store_id: str) -> UsageQuota:
    quota = await get_or_create_quota(db, store_id)
    if quota.monthly_generations_used >= quota.monthly_generation_limit:
        from core.exceptions import QuotaExceededError
        raise QuotaExceededError(
            f"本月生成次数已达上限 ({quota.monthly_generation_limit} 次)"
        )
    if quota.monthly_tokens_limit and quota.monthly_tokens_used >= quota.monthly_tokens_limit:
        from core.exceptions import QuotaExceededError
        raise QuotaExceededError("本月 AI 用量已达上限，请联系管理员升级套餐")
    return quota


async def increment_usage(
    db: AsyncSession, store_id: str, tokens: int = 0, count: int = 1
) -> None:
    # 先确保配额行存在并完成跨月重置
    await get_or_create_quota(db, store_id)
    # 数据库级原子递增，避免读-改-写并发下的丢失更新（计数偏低 → 配额被绕过）
    await db.execute(
        update(UsageQuota)
        .where(UsageQuota.store_id == store_id)
        .values(
            monthly_generations_used=UsageQuota.monthly_generations_used + count,
            monthly_tokens_used=UsageQuota.monthly_tokens_used + tokens,
        )
    )
    await db.commit()
