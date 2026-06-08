from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from config import settings

# 注册租户自动过滤事件监听器
import core.tenant  # noqa: F401

engine = create_async_engine(
    settings.database_url,
    echo=False,
    pool_size=20,
    max_overflow=40,
    pool_recycle=1800,
    pool_pre_ping=True,
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
