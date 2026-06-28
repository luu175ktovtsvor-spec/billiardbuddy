import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Integer, Text, DateTime, ForeignKey, func, Index
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID, JSONType


class MediaJob(Base):
    """生成工作室异步任务(生图/改图/变体/图生视频/多镜合成)。

    单用户本地 in-process,不上 Celery/Redis(过度工程+打包负担)——提交即返 id、
    进度写 DB(轮询/SSE 读)、完成推送。这是工作室地基,顺带救活"慢任务只干转无进度"。
    """
    __tablename__ = "media_jobs"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    store_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("stores.id"), nullable=False, index=True)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(GUID, nullable=True, index=True)
    # generate / edit / variations / i2v / compose
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # queued / running / done / error
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", index=True)
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 0-100
    stage: Mapped[str | None] = mapped_column(String(120))  # 大白话阶段文案给用户看:"正在出图…"
    params: Mapped[dict | None] = mapped_column(JSONType)   # 入参快照(可重做)
    result: Mapped[dict | None] = mapped_column(JSONType)   # 产物 {urls:[], generation_ids:[]}
    error: Mapped[str | None] = mapped_column(Text)
    # Python 侧 default(异步 SQLite refresh 会崩,见 generation.py 注释):flush 即落值
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
        onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_media_jobs_store_status", "store_id", "status"),
    )
