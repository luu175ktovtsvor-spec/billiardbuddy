"""共享测试 fixture(供 data_sync 相关测试用)。

仓库里没有全局 conftest，各测试文件此前各自建内存 SQLite（见
test_store_memory_manual.py 的 session_maker fixture 写法）。这里新增的
fixture 只是**定义**，不加 autouse、不在 import 期建全局 engine，
对现有 100+ 测试零影响（全量跑一遍需保持全绿）。
"""

import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from db.base import Base
import models  # noqa: F401  触发全部模型注册(含 sync_outbox/sync_state)


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        yield s
    await engine.dispose()


@pytest_asyncio.fixture
def seed_usage_event(db_session):
    from models.usage_event import UsageEvent

    async def _seed(**kw):
        kw.setdefault("event", "agent_chat")
        kw.setdefault("props", {})
        row = UsageEvent(**kw)
        db_session.add(row)
        await db_session.commit()
        return row

    return _seed
