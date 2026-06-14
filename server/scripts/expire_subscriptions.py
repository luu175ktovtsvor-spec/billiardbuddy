# -*- coding: utf-8 -*-
"""自动降级到期会员（cron 定时跑，实现会员到期自动失效）。

把"已过期但状态仍 active"的订阅置为 expired，并把对应门店的配额降回**试用档**(30/3)。
- 只动有过期订阅的门店；**无订阅的店（试用 / 手动设的不限额账号如老板自己）一律不碰**。
- 用量计数不清零（保留），只降上限。
- 续费会把配额刷回该档位（见 admin.renew_subscription），与本脚本配套。

手动运行：在 server/ 下
    PYTHONPATH=. .venv/bin/python scripts/expire_subscriptions.py
建议 cron 每小时跑一次（见 docs/服务器部署交接文档.md）。
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from db.session import async_session
from models.plan import StoreSubscription
from models.quota import UsageQuota
from services.quota_service import (
    DEFAULT_GENERATION_LIMIT,
    DEFAULT_TOKENS_LIMIT,
    DEFAULT_POSTER_LIMIT,
)

logger = logging.getLogger(__name__)


async def expire_overdue_subscriptions(db) -> list[str]:
    """处理所有过期订阅，返回被降级的 store_id 列表。"""
    now = datetime.now(timezone.utc)
    subs = (
        await db.execute(
            select(StoreSubscription).where(
                StoreSubscription.status == "active",
                StoreSubscription.current_period_end < now,
            )
        )
    ).scalars().all()
    done: list[str] = []
    for sub in subs:
        sub.status = "expired"
        # 显式 store_id 过滤 → 绕开租户自动过滤的无上下文 fail-safe
        quota = await db.scalar(
            select(UsageQuota).where(UsageQuota.store_id == sub.store_id)
        )
        if quota is not None:
            quota.monthly_generation_limit = DEFAULT_GENERATION_LIMIT
            quota.monthly_tokens_limit = DEFAULT_TOKENS_LIMIT
            quota.monthly_poster_limit = DEFAULT_POSTER_LIMIT
        done.append(str(sub.store_id))
    await db.commit()
    return done


async def _main() -> None:
    async with async_session() as db:
        done = await expire_overdue_subscriptions(db)
    print(f"[expire_subscriptions] 降级 {len(done)} 个过期会员到试用档: {done}")


if __name__ == "__main__":
    asyncio.run(_main())
