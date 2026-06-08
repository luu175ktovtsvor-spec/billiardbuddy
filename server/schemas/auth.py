from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    phone: str = Field(min_length=11, max_length=20, pattern=r"^\d+$")
    password: str = Field(min_length=8, max_length=100, description="密码至少8位")
    name: str | None = Field(default=None, max_length=100)
    invite_code: str | None = Field(default=None, max_length=8, description="邀请码（可选）")


class LoginRequest(BaseModel):
    phone: str = Field(min_length=11, max_length=20, pattern=r"^\d+$")
    password: str = Field(min_length=1, max_length=100)


class RefreshTokenRequest(BaseModel):
    access_token: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: UUID
    phone: str
    name: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
