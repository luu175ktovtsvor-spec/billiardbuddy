"""桌面全本地版（SQLite）建库。

云端 web 版用 Alembic 迁移建/改表（22 个迁移含 PG 专属 DDL，SQLite 跑不通，也不该跑）。
桌面本地版改用 SQLAlchemy 的 metadata.create_all：按当前模型一次性建出所有表。
跨库列类型由 db/types.py 的 with_variant 在 SQLite 上自动降级（JSONB→JSON、UUID→CHAR）。

只在 SQLite 时调用（见 main.py lifespan）。PostgreSQL 路径完全不碰，仍走 Alembic。
"""

import logging

from db.base import Base
from db.session import engine

# 触发全部模型注册到 Base.metadata（漏导入 = 漏建表）
import models  # noqa: F401

logger = logging.getLogger(__name__)


async def init_local_db() -> None:
    """SQLite 本地库：表不存在则按模型建全。已存在的表 create_all 不动（幂等）。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("本地 SQLite 数据库已就绪（create_all）")
