import uuid
from datetime import datetime

from sqlalchemy import String, Text, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID


class StoreMemory(Base):
    """店脑：一家门店的 AI 长期记忆条目。
    被 memory_service 读写；所有查询显式按 store_id 过滤（绕开租户自动过滤的无上下文 fail-safe）。"""

    __tablename__ = "store_memories"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4
    )
    store_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("stores.id"), nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="semantic")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[str] = mapped_column(String(10), nullable=False, default="medium")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
