"""客户端数据汇聚上行队列：本机后台采集器把要上传的事件/生成记录/门店快照/对话轨迹
先幂等入队到这张表，再由上行器批量 gzip POST 到 owner 服务器。

(kind, ref_id) 唯一约束是幂等的关键：采集器重复跑（比如轮询周期内同一行被扫两次）
靠数据库层唯一约束天然去重，不用采集器自己记"我扫到哪了"这种脆弱状态。
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Integer, DateTime, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID, JSONType


class SyncOutbox(Base):
    __tablename__ = "sync_outbox"
    __table_args__ = (
        UniqueConstraint("kind", "ref_id", name="uq_outbox_kind_ref"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, index=True)  # event|gen|trace|store
    ref_id: Mapped[str] = mapped_column(String(80), nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
