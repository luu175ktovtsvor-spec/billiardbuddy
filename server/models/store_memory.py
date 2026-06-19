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
    # 来源：manual=老板亲自定的店规矩（最高优先、AI 绝不删改）；auto=AI 从交互里学到的。
    # init_local 的 _reconcile_columns 会给老库自动补这一列（server_default="auto" 让旧行默认归 auto）。
    source: Mapped[str] = mapped_column(
        String(10), nullable=False, default="auto", server_default="auto"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
