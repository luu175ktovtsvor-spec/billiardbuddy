from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

# 数字序列（正/反），用于挡住"12345678""87654321"这类太弱的密码
_DIGITS = "0123456789"


def validate_password_strength(pwd: str) -> str:
    """轻量密码强度：至少8位 + 不能整串同一字符 + 不能是纯连续数字。
    不强制字母+数字（避免太烦），只挡明显弱口令。"""
    if len(pwd) < 8:
        raise ValueError("密码至少 8 位")
    if len(set(pwd)) == 1:
        raise ValueError("密码不能是同一个字符重复")
    if pwd in _DIGITS or pwd in _DIGITS[::-1]:
        raise ValueError("密码太简单（别用连续数字），请换一个")
    return pwd


class RegisterRequest(BaseModel):
    phone: str = Field(min_length=11, max_length=20, pattern=r"^\d+$")
    password: str = Field(min_length=8, max_length=100, description="密码至少8位")
    name: str | None = Field(default=None, max_length=100)


class ChangePasswordRequest(BaseModel):
    """用户自助改密码：验旧设新。密码走请求体（不进 URL/日志）。"""
    old_password: str = Field(min_length=1, max_length=100)
    new_password: str = Field(min_length=8, max_length=100)

    @field_validator("new_password")
    @classmethod
    def _strength(cls, v: str) -> str:
        return validate_password_strength(v)


class AdminResetPasswordRequest(BaseModel):
    """管理员重置用户密码：新密码走请求体（不进 URL/日志）。"""
    new_password: str = Field(min_length=8, max_length=100)

    @field_validator("new_password")
    @classmethod
    def _strength(cls, v: str) -> str:
        return validate_password_strength(v)


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
    is_admin: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}
