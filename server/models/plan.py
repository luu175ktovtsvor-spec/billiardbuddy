import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID, JSONType


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    slug: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    price_monthly: Mapped[int] = mapped_column(Integer, default=0)  # 分
    price_yearly: Mapped[int] = mapped_column(Integer, default=0)   # 分
    generation_limit: Mapped[int] = mapped_column(Integer, default=20)
    token_limit: Mapped[int] = mapped_column(Integer, default=100000)
    poster_limit: Mapped[int] = mapped_column(Integer, default=5)
    max_members: Mapped[int] = mapped_column(Integer, default=1)
    features: Mapped[dict | None] = mapped_column(JSONType)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StoreSubscription(Base):
    __tablename__ = "store_subscriptions"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id"), unique=True, nullable=False, index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id"), nullable=False)
    # status：到期降级 cron(server/scripts/expire_subscriptions.py，每小时)会把过期订阅置 "expired"。
    # 但 cron 最长有 1 小时延迟窗，且"无订阅的店"根本没有此行——故判断订阅是否有效仍以
    # current_period_end > now 实时计算为准(见 quota.py / admin.py)，status 只作展示/统计辅助，
    # 不要单独依赖 status == "active" 判定有效。
    status: Mapped[str] = mapped_column(String(20), default="active")
    current_period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    current_period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    activated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    payment_note: Mapped[str | None] = mapped_column(String(500))
    payment_amount: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
