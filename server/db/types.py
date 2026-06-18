"""跨库列类型：同一套模型既能跑云端 PostgreSQL，又能跑本地 SQLite。

用 SQLAlchemy 的 with_variant 做"方言降级"——
- PostgreSQL 上：JSONType 仍编译成原生 JSONB、GUID 仍是原生 UUID（行为与改造前完全一致）。
- SQLite 上：JSONType 退成通用 JSON（存为 TEXT），GUID 退成 Uuid（存为 CHAR(32)）。

注意：只是"列类型"在不同方言上换实现，Python 侧拿到的依旧是 dict / uuid.UUID，
业务代码无感知。PG 生产路径不受任何影响。
"""

from sqlalchemy import JSON, Uuid
from sqlalchemy.dialects.postgresql import JSONB, UUID

# JSON 列：PG=JSONB（二进制、可索引），SQLite=JSON（TEXT 存储）
JSONType = JSONB().with_variant(JSON(), "sqlite")

# UUID 列：PG=原生 uuid，SQLite=Uuid（as_uuid=True 时 Python 侧仍是 uuid.UUID，落库 CHAR(32)）
GUID = UUID(as_uuid=True).with_variant(Uuid(as_uuid=True), "sqlite")
