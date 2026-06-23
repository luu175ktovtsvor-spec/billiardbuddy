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
            # 默认值：把 server_default 映射成 SQLite ALTER 可用字面量。
            # 注意 func.false()/func.true()/func.now() 渲染成 'false()'/'true()'/'now()'，
            # SQLite ALTER ADD COLUMN 不接受非常量默认（CURRENT_TIMESTAMP 例外）→ 必须处理，否则建库崩。
            default_sql = ""
            sd = col.server_default
            if sd is not None and getattr(sd, "arg", None) is not None:
                raw = str(getattr(sd.arg, "text", None) or sd.arg).strip()
                low = raw.lower().rstrip("()")  # 'false()'→'false'、'now()'→'now'
                if low == "false":
                    default_sql = " DEFAULT 0"
                elif low == "true":
                    default_sql = " DEFAULT 1"
                elif low in ("now", "current_timestamp"):
                    default_sql = " DEFAULT CURRENT_TIMESTAMP"
                elif "(" not in raw:  # 纯常量(数字/字符串字面量)直接用
                    default_sql = f" DEFAULT {raw}"
                # 其它函数型默认 → 不加 DEFAULT（避免 SQLite 非常量默认报错）
            # NOT NULL 无默认会 ALTER 失败 → 兜个空串默认
            if not col.nullable and not default_sql:
                default_sql = " DEFAULT ''"
            null_sql = "" if col.nullable else " NOT NULL"
            sync_conn.exec_driver_sql(
                f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype}{null_sql}{default_sql}'
            )
            logger.info("补列 %s.%s（老库升级）", table.name, col.name)


async def _seed_local_owner() -> None:
    """桌面本机单用户：库里没有任何 user 时，seed 一个固定 owner + 门店 + 成员关系。

    免登录的本地身份（`api/deps.py` 的 get_current_user/get_current_store）就返回这唯一的
    owner/store。幂等：已有用户（老库/已注册过）则跳过。门店/store_id/租户过滤作为"数据组织
    地基"保留——seed 出一个真实门店让 set_tenant 有值可喂，否则租户自动过滤会把数据读空。"""
    from sqlalchemy import select
    from db.session import async_session
    from models.user import User
    from models.store import Store, StoreMember

    async with async_session() as db:
        if (await db.execute(select(User).limit(1))).scalars().first():
            return  # 已有用户（含老库已注册的 owner）→ 不重复 seed
        user = User(phone="local-owner", password_hash="", name="店主", is_active=True)
        db.add(user)
        await db.flush()
        store = Store(owner_id=user.id, name="我的球房")
        db.add(store)
        await db.flush()
        db.add(StoreMember(store_id=store.id, user_id=user.id, role="owner"))
        await db.commit()
    logger.info("已 seed 本地 owner + 门店（首启单用户，免登录）")


async def init_local_db() -> None:
    """SQLite 本地库：表不存在则按模型建全；已存在的表补上新增列（老库平滑升级）；首启 seed 单 owner。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_reconcile_columns)
    await _seed_local_owner()
    logger.info("本地 SQLite 数据库已就绪（create_all + 补缺列 + seed owner）")
