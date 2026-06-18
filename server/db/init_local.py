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


def _reconcile_columns(sync_conn) -> None:
    """给【已存在的表】补上模型里新增、但库里还没有的列。

    create_all 对已存在的表是幂等的——不会加新列。桌面版无 Alembic，老库升级新版后
    若漏列，一查就 OperationalError(no such column)。这里逐表对比、ALTER ADD COLUMN 补差，
    让老库平滑升级、不丢数据、未来加字段也不再犯。仅 SQLite 走这里（桌面专属）。
    """
    from sqlalchemy import text
    dialect = sync_conn.dialect
    for table in Base.metadata.sorted_tables:
        rows = sync_conn.exec_driver_sql(f'PRAGMA table_info("{table.name}")').fetchall()
        if not rows:
            continue  # 表不存在（create_all 刚建的全表，无需补）
        existing = {r[1] for r in rows}
        for col in table.columns:
            if col.name in existing:
                continue
            coltype = col.type.compile(dialect=dialect)
            # 默认值：把 server_default 映射成 SQLite 可用字面量（false/true → 0/1）
            default_sql = ""
            sd = col.server_default
            if sd is not None and getattr(sd, "arg", None) is not None:
                arg = sd.arg
                raw = getattr(arg, "text", None) or str(arg)
                low = raw.strip().lower()
                raw = {"false": "0", "true": "1"}.get(low, raw)
                default_sql = f" DEFAULT {raw}"
            # NOT NULL 无默认会 ALTER 失败 → 兜个空串默认
            if not col.nullable and not default_sql:
                default_sql = " DEFAULT ''"
            null_sql = "" if col.nullable else " NOT NULL"
            sync_conn.exec_driver_sql(
                f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype}{null_sql}{default_sql}'
            )
            logger.info("补列 %s.%s（老库升级）", table.name, col.name)


async def init_local_db() -> None:
    """SQLite 本地库：表不存在则按模型建全；已存在的表补上新增列（老库平滑升级）。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_reconcile_columns)
    logger.info("本地 SQLite 数据库已就绪（create_all + 补缺列）")
