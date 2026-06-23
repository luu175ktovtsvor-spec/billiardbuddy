"""身份 schema（桌面单用户）。SaaS 的注册/登录/改密/token schema 已随免登录改造删除。"""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class UserResponse(BaseModel):
    id: UUID
    phone: str
    name: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
