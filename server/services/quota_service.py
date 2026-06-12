"""配额检查与更新服务"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.timezone import BUSINESS_TZ
from models.quota import UsageQuota

logger = logging.getLogger(__name__)

# token 上限由"次数上限"自动推导,二者永不错配——管理员/套餐只需设置生成次数,
# token 仅作防滥用安全网(单次约 3-5k token,留足余量按 8000/次)。
TOKENS_PER_GENERATION = 8000


def token_ceiling(generation_limit: int) -> int:
    """由生成次数上限推导 token 安全网上限。"""
    return max(0, generation_limit) * TOKENS_PER_GENERATION


# 默认配额 = 试用档（未开通套餐的新门店）。
# 30 次/月：店长日均 3-5 次可体验约一周，足够判断"好不好用"；
# 生图与文本共用此池，30 次全用于生图的成本也可控。
# 开通套餐后由 plan 的限额覆盖；管理后台也可单店调整。
DEFAULT_GENERATION_LIMIT = 30
DEFAULT_TOKENS_LIMIT = token_ceiling(DEFAULT_GENERATION_LIMIT)

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
            f"本月生成次数已达上限（{quota.monthly_generation_limit} 次）。如需提升额度，请联系您的服务商"
        )
    # token 安全网由次数上限推导(而非读 stored 字段),保证永远不会先于次数触发,
    # 只拦截异常的超大用量(防滥用)。stored monthly_tokens_limit 仅供展示。
    ceiling = token_ceiling(quota.monthly_generation_limit)
    if ceiling and quota.monthly_tokens_used >= ceiling:
        from core.exceptions import QuotaExceededError
        raise QuotaExceededError("本月 AI 用量异常偏高，已达安全上限，请联系您的服务商")
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
