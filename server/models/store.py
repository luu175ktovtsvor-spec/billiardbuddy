import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, Text, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.base import Base
from db.types import GUID, JSONType


class Store(Base):
    __tablename__ = "stores"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("users.id"), nullable=False, index=True
    )

    # 基础信息
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    city: Mapped[str | None] = mapped_column(String(100))
    district: Mapped[str | None] = mapped_column(String(100))
    address: Mapped[str | None] = mapped_column(String(500))
    phone: Mapped[str | None] = mapped_column(String(50))
    business_hours: Mapped[str | None] = mapped_column(String(200))

    # 球桌信息
    table_count: Mapped[int | None] = mapped_column(Integer)
    table_types: Mapped[str | None] = mapped_column(String(500))

    # 灵活信息
    pricing: Mapped[dict | None] = mapped_column(JSONType)
    member_cards: Mapped[dict | None] = mapped_column(JSONType)
    operation_profile: Mapped[dict | None] = mapped_column(JSONType)

    # 图片
    logo_url: Mapped[str | None] = mapped_column(String(500))
    qrcode_url: Mapped[str | None] = mapped_column(String(500))

    # 设施标识
    has_private_room: Mapped[bool] = mapped_column(Boolean, default=False)
    has_coaching: Mapped[bool] = mapped_column(Boolean, default=False)
    has_tournament: Mapped[bool] = mapped_column(Boolean, default=False)
    has_parking: Mapped[bool] = mapped_column(Boolean, default=False)

    # 助教资料
    coach_count: Mapped[int | None] = mapped_column(Integer)
    coach_service_types: Mapped[str | None] = mapped_column(String(500))
    coach_price_range: Mapped[str | None] = mapped_column(String(200))

    # 球杆定价
    cue_price_range: Mapped[str | None] = mapped_column(String(200))
    # 已弃用(2026-06-13 商品种类过多,不再让用户填写):保留休眠列不 drop,避免破坏性迁移
    beverage_price_range: Mapped[str | None] = mapped_column(String(200))
    snack_price_range: Mapped[str | None] = mapped_column(String(200))

    # 设备品牌
    table_brands: Mapped[str | None] = mapped_column(String(500))
    cue_brands: Mapped[str | None] = mapped_column(String(500))
    other_equipment: Mapped[str | None] = mapped_column(Text)

    # 会员体系
    membership_types: Mapped[dict | None] = mapped_column(JSONType)
    recharge_rules: Mapped[dict | None] = mapped_column(JSONType)
    membership_benefits: Mapped[dict | None] = mapped_column(JSONType)

    # 营业数据
    daily_avg_customers: Mapped[int | None] = mapped_column(Integer)
    peak_hours: Mapped[str | None] = mapped_column(String(200))
    avg_spend_range: Mapped[str | None] = mapped_column(String(200))

    # 运营信息
    target_customers: Mapped[str | None] = mapped_column(String(500))
    style: Mapped[str | None] = mapped_column(String(200))
    advantages: Mapped[str | None] = mapped_column(Text)
    common_activities: Mapped[str | None] = mapped_column(Text)
    brand_style: Mapped[str | None] = mapped_column(String(50))  # "lively" / "professional" / "youthful" / "premium"

    # BYOK（门店自带大模型 Key，自担 API 成本与并发；解决"全员共用平台单 key"的并发瓶颈+成本不可持续）
    # key 经 core/crypto 加密存 byok_api_key_enc，绝不明文落库；base_url/model 支持任意 OpenAI 兼容模型
    byok_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    byok_base_url: Mapped[str | None] = mapped_column(String(300))
    byok_api_key_enc: Mapped[str | None] = mapped_column(Text)
    byok_model: Mapped[str | None] = mapped_column(String(100))
    # 生图 BYOK：门店自带生图模型(OpenAI gpt-image 兼容)。与文字模型分开——文字多用 DeepSeek、生图用 OpenAI，
    # key/base_url 通常不同。未配则回退平台默认(config.openai_*)。key 同样 Fernet 加密、绝不明文落库。
    byok_image_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    byok_image_base_url: Mapped[str | None] = mapped_column(String(300))
    byok_image_api_key_enc: Mapped[str | None] = mapped_column(Text)
    byok_image_model: Mapped[str | None] = mapped_column(String(100))

    # 做海报自动出图上限（B-5）：full(跳过确认)模式下一轮内免确认自动花钱的张数上限，老板可在 UI 调。
    # None=用默认(env DESKTOP_AGENT_AUTO_SPEND_LIMIT，默认5)；>=0=上限(0=每张都先问)；-1=老板关闭上限闸(他自己的 BYOK key/钱)。
    agent_auto_spend_limit: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    members = relationship("StoreMember", back_populates="store")


class StoreMember(Base):
    __tablename__ = "store_members"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4
    )
    store_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("stores.id"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("users.id"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    store = relationship("Store", back_populates="members")
    user = relationship("User", back_populates="store_memberships")

    __table_args__ = (
        UniqueConstraint("store_id", "user_id", name="uq_store_member"),
    )


# StoreInvitation（凭邀请码入店）= 多成员团队 SaaS 遗留，2026-06-23 已删（桌面单用户无此概念）。
