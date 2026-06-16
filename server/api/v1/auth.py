import time
from typing import Annotated

import jwt
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user
from core.exceptions import AppException
from core.security import create_access_token, decode_token_allow_expired
from models.user import User
from schemas.auth import (
    RegisterRequest,
    LoginRequest,
    RefreshTokenRequest,
    TokenResponse,
    UserResponse,
    ChangePasswordRequest,
)
from services.auth_service import register_user, login_user, change_password

router = APIRouter(tags=["认证"])


# ─── 登录频率限制 ───

class LoginRateLimiter:
    """基于内存的 IP 登录频率限制器。5 分钟内同一 IP 最多 10 次请求。"""

    def __init__(self, max_attempts: int = 10, window_seconds: int = 300):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self._attempts: dict[str, list[float]] = {}

    def _cleanup(self, ip: str) -> None:
        """移除窗口外的过期记录。"""
        cutoff = time.monotonic() - self.window_seconds
        self._attempts[ip] = [
            t for t in self._attempts.get(ip, []) if t > cutoff
        ]

    def is_limited(self, ip: str) -> bool:
        self._cleanup(ip)
        return len(self._attempts.get(ip, [])) >= self.max_attempts

    def record_attempt(self, ip: str) -> None:
        self._attempts.setdefault(ip, []).append(time.monotonic())

    def reset(self, ip: str) -> None:
        """登录成功后清零该 IP 的计数。"""
        self._attempts.pop(ip, None)


_rate_limiter = LoginRateLimiter()


# ─── 端点 ───

@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(
    body: RegisterRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    user, token = await register_user(
        db, body.phone, body.password, body.name,
        invite_code=body.invite_code,
    )
    return TokenResponse(access_token=token)


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    client_ip = request.client.host if request.client else "unknown"

    if _rate_limiter.is_limited(client_ip):
        raise AppException("登录请求过于频繁，请 5 分钟后再试", status_code=429)

    _rate_limiter.record_attempt(client_ip)

    user, token = await login_user(db, body.phone, body.password)

    _rate_limiter.reset(client_ip)
    return TokenResponse(access_token=token)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    body: RefreshTokenRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """刷新 access_token。允许已过期 token 在 24 小时刷新窗口内换取新 token。"""
    try:
        payload = decode_token_allow_expired(body.access_token)
    except jwt.InvalidTokenError:
        raise AppException("无效的令牌", status_code=401)

    # 检查刷新窗口：token 过期后 24 小时内可刷新
    exp = payload.get("exp")
    if exp is not None:
        refresh_deadline = exp + 24 * 3600  # 过期后 24 小时
        now = time.time()
        if now > refresh_deadline:
            raise AppException("令牌已超过刷新有效期，请重新登录", status_code=401)

    user_id_str = payload.get("sub")
    if user_id_str is None:
        raise AppException("无效的令牌", status_code=401)

    # 验证用户仍然存在且活跃
    from uuid import UUID
    try:
        user_uuid = UUID(user_id_str)
    except ValueError:
        raise AppException("无效的令牌", status_code=401)

    result = await db.execute(select(User).where(User.id == user_uuid))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise AppException("用户不存在或已禁用", status_code=401)

    new_token = create_access_token(user.id)
    return TokenResponse(access_token=new_token)


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: Annotated[User, Depends(get_current_user)],
):
    return current_user


@router.put("/password")
async def change_my_password(
    body: ChangePasswordRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """用户自助修改密码：验证当前密码 → 设新密码（密码走请求体、不进日志）。旧 token 仍有效。"""
    await change_password(db, current_user, body.old_password, body.new_password)
    return {"status": "ok"}
