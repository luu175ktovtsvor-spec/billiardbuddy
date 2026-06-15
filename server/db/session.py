from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from config import settings

# 注册租户自动过滤事件监听器
import core.tenant  # noqa: F401

engine = create_async_engine(
    settings.database_url,
    echo=False,
    # 2核4G + 2 worker：旧值 20+40=60/worker × 2 = 120，超过 PG 默认 max_connections=100
    # → 并发上来报 "too many connections"。本应用并发受生图信号量/慢请求天然压低，
    # 5+10=15/worker × 2 = 30 足够，且留足余量给 cron/psql。
    pool_size=5,
    max_overflow=10,
    pool_recycle=1800,
    pool_pre_ping=True,
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
