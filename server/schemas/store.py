from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class OperationProfileUpdate(BaseModel):
    """运营画像 — 接受前端发送的嵌套结构，保留所有模块。"""
    basic: dict | None = Field(default=None)
    business_goals: dict | None = Field(default=None)
    customer_structure: dict | None = Field(default=None)
    private_domain_groups: dict | None = Field(default=None)
    assistant_system: dict | None = Field(default=None)
    events: dict | None = Field(default=None)
    commerce_rules: dict | None = Field(default=None)
    equipment: dict | None = Field(default=None)
    content_style: dict | None = Field(default=None)
    ai_preferences: dict | None = Field(default=None)
    # 允许未知键（兼容前端可能增加的模块）
    model_config = {"extra": "allow"}


class StoreCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    city: str | None = Field(default=None, max_length=100)
    district: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=50)
    business_hours: str | None = Field(default=None, max_length=200)
    table_count: int | None = Field(default=None, ge=0)
    table_types: str | None = Field(default=None, max_length=500)
    pricing: Any = None
    member_cards: Any = None
    has_private_room: bool = False
    has_coaching: bool = False
    has_tournament: bool = False
    has_parking: bool = False
    target_customers: str | None = Field(default=None, max_length=500)
    style: str | None = Field(default=None, max_length=200)
    advantages: str | None = None
    common_activities: str | None = None
    operation_profile: OperationProfileUpdate | None = None
    # 助教资料
    coach_count: int | None = Field(default=None, ge=0)
    coach_service_types: str | None = Field(default=None, max_length=500)
    coach_price_range: str | None = Field(default=None, max_length=200)
    # 球杆定价
    cue_price_range: str | None = Field(default=None, max_length=200)
    # 设备品牌
    table_brands: str | None = Field(default=None, max_length=500)
    cue_brands: str | None = Field(default=None, max_length=500)
    other_equipment: str | None = None
    # 会员体系
    membership_types: Any = None
    recharge_rules: Any = None
    membership_benefits: Any = None
    # 营业数据
    daily_avg_customers: int | None = Field(default=None, ge=0)
    peak_hours: str | None = Field(default=None, max_length=200)
    avg_spend_range: str | None = Field(default=None, max_length=200)


class StoreUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    city: str | None = Field(default=None, max_length=100)
    district: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=50)
    business_hours: str | None = Field(default=None, max_length=200)
    table_count: int | None = Field(default=None, ge=0)
    table_types: str | None = Field(default=None, max_length=500)
    pricing: Any = None
    member_cards: Any = None
    has_private_room: bool | None = None
    has_coaching: bool | None = None
    has_tournament: bool | None = None
    has_parking: bool | None = None
    target_customers: str | None = Field(default=None, max_length=500)
    style: str | None = Field(default=None, max_length=200)
    # 品牌风格（影响 AI 语气）：此前 schema 缺该字段，前端一直在发但被静默丢弃
    brand_style: str | None = Field(default=None, max_length=50)
    advantages: str | None = None
    common_activities: str | None = None
    operation_profile: OperationProfileUpdate | None = None
    # 助教资料
    coach_count: int | None = Field(default=None, ge=0)
    coach_service_types: str | None = Field(default=None, max_length=500)
    coach_price_range: str | None = Field(default=None, max_length=200)
    # 球杆定价
    cue_price_range: str | None = Field(default=None, max_length=200)
    # 设备品牌
    table_brands: str | None = Field(default=None, max_length=500)
    cue_brands: str | None = Field(default=None, max_length=500)
    other_equipment: str | None = None
    # 会员体系
    membership_types: Any = None
    recharge_rules: Any = None
    membership_benefits: Any = None
    # 营业数据
    daily_avg_customers: int | None = Field(default=None, ge=0)
    peak_hours: str | None = Field(default=None, max_length=200)
    avg_spend_range: str | None = Field(default=None, max_length=200)


class StoreResponse(BaseModel):
    id: UUID
    owner_id: UUID
    name: str
    city: str | None
    district: str | None
    address: str | None
    phone: str | None
    business_hours: str | None
    table_count: int | None
    table_types: str | None
    pricing: Any
    member_cards: Any
    logo_url: str | None
    qrcode_url: str | None
    has_private_room: bool
    has_coaching: bool
    has_tournament: bool
    has_parking: bool
    target_customers: str | None
    style: str | None
    brand_style: str | None = None
    advantages: str | None
    common_activities: str | None
    operation_profile: Any = None
    operation_profile_completeness: Any = None
    completeness: int = 0
    # 本地单用户：恒为 owner（RBAC 多角色已随 SaaS 删除）
    my_role: str | None = None
    # 助教资料
    coach_count: int | None = None
    coach_service_types: str | None = None
    coach_price_range: str | None = None
    # 球杆定价
    cue_price_range: str | None = None
    # 设备品牌
    table_brands: str | None = None
    cue_brands: str | None = None
    other_equipment: str | None = None
    # 会员体系
    membership_types: Any = None
    recharge_rules: Any = None
    membership_benefits: Any = None
    # 营业数据
    daily_avg_customers: int | None = None
    peak_hours: str | None = None
    avg_spend_range: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class StoreListItem(BaseModel):
    """门店列表项（仅 id + name）"""
    id: UUID
    name: str

    model_config = {"from_attributes": True}


class UploadResponse(BaseModel):
    url: str
