import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class UsageEvent(Base):
    """使用事件（产品分析 / AI 可观测性）——append-only 事件日志，喂版本迭代。

    刻意**不设 store_id/user_id 外键**：这是解耦的 append-only 分析表，不随门店/用户
    删除而级联、便于保留历史；跨店只做**统计聚合**（admin），不参与租户自动过滤
    （归入 test_coupling_guards 的 _MANUAL_FILTER_TABLES）。写入一律走 usage_event_service
    的故障安全 log_event，绝不影响主流程。
    """

    __tablename__ = "usage_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # 事件名（小写下划线），如 generation / generation_failed。按它聚合，故建索引。
    event: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # 解耦冗余列（无外键）：用于分组统计。
    store_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # 小上下文：scenario / outcome / error_type / latency_ms / tokens 等。
    props: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
