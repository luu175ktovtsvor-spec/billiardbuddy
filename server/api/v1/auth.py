"""身份 API（桌面本机单用户·免登录）。

SaaS 的登录/注册/JWT/刷新/限流/改密已全删——桌面=老板自己电脑上的单人 App，
`api/deps.get_current_user` 直接返回本地 seed 的 owner。这里只留 /me 给前端取身份显示。"""
from typing import Annotated

from fastapi import APIRouter, Depends

from api.deps import get_current_user
from models.user import User
from schemas.auth import UserResponse

router = APIRouter(tags=["认证"])


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: Annotated[User, Depends(get_current_user)]):
    return current_user
