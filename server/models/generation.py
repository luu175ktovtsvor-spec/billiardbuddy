import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, Text, DateTime, ForeignKey, func, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class Generation(Base):
    __tablename__ = "generations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    store_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stores.id"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True
    )
    type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    sub_type: Mapped[str | None] = mapped_column(String(50))
    input_params: Mapped[dict | None] = mapped_column(JSONB)
    prompt_used: Mapped[str | None] = mapped_column(Text)
    result: Mapped[str | None] = mapped_column(Text)
    model_used: Mapped[str | None] = mapped_column(String(100))
    tokens_used: Mapped[int | None] = mapped_column(Integer)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False, server_default=func.false())
    # 用户自定义命名(海报找图/历史检索友好);空则前端用 prompt 派生展示名
    title: Mapped[str | None] = mapped_column(String(80), nullable=True)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    openai_response_id: Mapped[str | None] = mapped_column(String(200))
    effect_rating: Mapped[str | None] = mapped_column(String(20))  # "good" / "bad"
    effect_note: Mapped[str | None] = mapped_column(String(500))
    rated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    quality_used: Mapped[str | None] = mapped_column(String(20))
    image_size: Mapped[str | None] = mapped_column(String(20))
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index('ix_generations_store_type', 'store_id', 'type'),
        Index('ix_generations_store_created', 'store_id', 'created_at'),
    )
