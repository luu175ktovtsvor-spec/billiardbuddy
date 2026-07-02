"""采集器增量游标：记每个数据源(usage_events/generations/...)扫到哪一行了，
下一轮只取 created_at > last_ts 的新行，避免每轮全表扫。"""

from datetime import datetime, timezone

from sqlalchemy import String, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class SyncState(Base):
    __tablename__ = "sync_state"

    source: Mapped[str] = mapped_column(String(40), primary_key=True)
    last_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    last_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
