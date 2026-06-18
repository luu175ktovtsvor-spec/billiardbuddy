from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from config import settings

# 注册租户自动过滤事件监听器
import core.tenant  # noqa: F401

_url = settings.database_url

if _url.startswith("sqlite"):
    # 桌面全本地版（SQLite + aiosqlite）：连接池参数（pool_size/max_overflow）对单文件库无意义，
    # 传了会报错。aiosqlite 默认把连接绑到创建它的线程，FastAPI 异步多协程下需关掉 check_same_thread。
    engine = create_async_engine(
        _url,
        echo=False,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_async_engine(
        _url,
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
