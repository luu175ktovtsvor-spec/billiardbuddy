"""配额检查与更新服务"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.quota import UsageQuota

logger = logging.getLogger(__name__)

# 默认配额
DEFAULT_GENERATION_LIMIT = 100
DEFAULT_TOKENS_LIMIT = 500000


def _period_start_now() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _is_new_period(quota: UsageQuota) -> bool:
    if quota.current_period_start is None:
        return True
    now = datetime.now(timezone.utc)
    start = quota.current_period_start
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return now.year > start.year or now.month > start.month


async def get_or_create_quota(db: AsyncSession, store_id: str) -> UsageQuota:
    result = await db.execute(
        select(UsageQuota).where(UsageQuota.store_id == store_id)
    )
    quota = result.scalar_one_or_none()
    if quota is None:
        quota = UsageQuota(
            store_id=store_id,
            monthly_generation_limit=DEFAULT_GENERATION_LIMIT,
            monthly_tokens_limit=DEFAULT_TOKENS_LIMIT,
            monthly_generations_used=0,
            monthly_tokens_used=0,
            current_period_start=_period_start_now(),
        )
        db.add(quota)
        await db.commit()
        await db.refresh(quota)
    elif _is_new_period(quota):
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
    return quota


async def increment_usage(
    db: AsyncSession, store_id: str, tokens: int = 0
) -> None:
    quota = await get_or_create_quota(db, store_id)
    quota.monthly_generations_used += 1
    quota.monthly_tokens_used += tokens
    await db.commit()
