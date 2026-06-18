"""跨库列类型：同一套模型既能跑云端 PostgreSQL，又能跑本地 SQLite。

用 SQLAlchemy 的 with_variant 做"方言降级"——
- PostgreSQL 上：JSONType 仍编译成原生 JSONB、GUID 仍是原生 UUID（行为与改造前完全一致）。
- SQLite 上：JSONType 退成通用 JSON（存为 TEXT），GUID 退成 Uuid（存为 CHAR(32)）。

注意：只是"列类型"在不同方言上换实现，Python 侧拿到的依旧是 dict / uuid.UUID，
业务代码无感知。PG 生产路径不受任何影响。
"""

import uuid as _uuid

from sqlalchemy import JSON, Uuid
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.types import TypeDecorator

# JSON 列：PG=JSONB（二进制、可索引），SQLite=JSON（TEXT 存储）
JSONType = JSONB().with_variant(JSON(), "sqlite")


class _SqliteGuid(TypeDecorator):
    """SQLite 上的 UUID 列：绑定参数时把字符串强制成 uuid.UUID，再交给 Uuid 处理器。

    桌面 SQLite 用 Uuid(as_uuid=True)，其 bind 处理器对值调 .hex —— 业务里大量查询写成
    `Col == str(store.id)`（如 quota_service），传字符串会 'str' object has no attribute 'hex' 崩。
    在类型层统一 str→uuid.UUID，所有 UUID 列的查询/写入都不再因传字符串而崩；读出来仍是 uuid.UUID，
    Python 侧行为不变。PG 路径完全不走这里（仍原生 UUID），生产无感知。
    """
    impl = Uuid(as_uuid=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if isinstance(value, str):
            try:
                return _uuid.UUID(value)
            except ValueError:
                return value
        return value


# UUID 列：PG=原生 uuid；SQLite=可吞字符串的 Uuid（落库 CHAR(32)，Python 侧仍 uuid.UUID）
GUID = UUID(as_uuid=True).with_variant(_SqliteGuid(), "sqlite")
