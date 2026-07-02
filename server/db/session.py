from sqlalchemy import event
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

    # SQLite 默认日志模式(rollback journal)写时独占锁库，稍微并发一点(生图任务后台写进度 +
    # 前端同时轮询读)就容易"database is locked"。WAL 让读写不互斥；busy_timeout 兜底剩下的
    # 写写冲突——遇到锁时等最多 5s 重试，而不是立刻报错。每条新连接都要设一次(SQLite 的 PRAGMA
    # 是连接级、不持久化在库文件里的那几个除外，journal_mode=WAL 会持久化，但 busy_timeout 不会)。
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()
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
