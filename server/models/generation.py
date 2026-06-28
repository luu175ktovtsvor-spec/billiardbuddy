import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Integer, Boolean, Text, DateTime, ForeignKey, func, Index
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID, JSONType


class Generation(Base):
    __tablename__ = "generations"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4
    )
    store_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("stores.id"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("users.id"), nullable=True, index=True
    )
    type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    sub_type: Mapped[str | None] = mapped_column(String(50))
    input_params: Mapped[dict | None] = mapped_column(JSONType)
    prompt_used: Mapped[str | None] = mapped_column(Text)
    result: Mapped[str | None] = mapped_column(Text)
    model_used: Mapped[str | None] = mapped_column(String(100))
    tokens_used: Mapped[int | None] = mapped_column(Integer)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False, server_default=func.false())
    # 用户自定义命名(海报找图/历史检索友好);空则前端用 prompt 派生展示名
    title: Mapped[str | None] = mapped_column(String(80), nullable=True)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, nullable=True, index=True
    )
    openai_response_id: Mapped[str | None] = mapped_column(String(200))
    effect_rating: Mapped[str | None] = mapped_column(String(20))  # "good" / "bad"
    effect_note: Mapped[str | None] = mapped_column(String(500))
    rated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    quality_used: Mapped[str | None] = mapped_column(String(20))
    image_size: Mapped[str | None] = mapped_column(String(20))
    # 隐式反馈闭环：这条生成由今日推荐的哪一条触发（rec.id，如 "festival"/"daily_focus"/"frequent"）。
    # 空=非推荐触发（老板自己发起）。轻量、可空；SQLite 由 init_local._reconcile_columns 自动补列。
    # 被采纳多的推荐类别在排序时上浮、长期没人点的下沉（见 behavior_service.adopted_rec_ids）。
    source_rec_id: Mapped[str | None] = mapped_column(String(50))
    # 阶段2 成品血缘:这条由哪条成品派生而来(图→改图→图生视频可追溯)。空=原始生成。
    # 可空;SQLite 由 init_local._reconcile_columns 自动补列(无 Alembic)。
    parent_generation_id: Mapped[uuid.UUID | None] = mapped_column(GUID, nullable=True, index=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    # Python 侧 default：flush 时即落值，commit 后无需 db.refresh 回填——
    # 异步 SQLite 上 refresh 会失败并使对象 expired、随后属性访问触发惰性加载崩（详见 content_service._safe_refresh）。
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
        onupdate=func.now()
    )

    __table_args__ = (
        Index('ix_generations_store_type', 'store_id', 'type'),
        Index('ix_generations_store_created', 'store_id', 'created_at'),
    )
