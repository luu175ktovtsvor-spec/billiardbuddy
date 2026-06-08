import uuid
from typing import Annotated

from fastapi import Depends, Header, Path
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import UnauthorizedException, ForbiddenException
from core.security import decode_access_token
from core.tenant import set_tenant
from db.session import async_session
from models.user import User
from models.store import Store, StoreMember

security_scheme = HTTPBearer()


async def get_db():
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    try:
        user_id = decode_access_token(credentials.credentials)
    except (jwt.InvalidTokenError, ValueError):
        raise UnauthorizedException("token 无效或已过期")

    user = await db.get(User, user_id)
    if not user:
        raise UnauthorizedException("用户不存在")
    if not user.is_active:
        raise UnauthorizedException("账号已被禁用")
    return user


async def get_current_store(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    x_store_id: Annotated[str | None, Header()] = None,
) -> Store:
    """获取当前用户所属门店。

    优先使用 X-Store-Id header 指定的门店 ID；
    如果没有 header，则回退到用户关联的第一个门店。
    """
    if x_store_id:
        try:
            target_store_id = uuid.UUID(x_store_id)
        except ValueError:
            raise ForbiddenException("X-Store-Id 格式无效")

        # 验证用户属于该门店
        result = await db.execute(
            select(StoreMember).where(
                StoreMember.store_id == target_store_id,
                StoreMember.user_id == current_user.id,
            )
        )
        member = result.scalar_one_or_none()
        if not member:
            raise ForbiddenException("您不属于该门店")

        store = await db.get(Store, target_store_id)
        if not store:
            raise ForbiddenException("门店不存在")
        set_tenant(store.id)
        return store

    # 回退：取用户关联的第一个门店
    result = await db.execute(
        select(StoreMember).where(StoreMember.user_id == current_user.id)
    )
    member = result.scalar_one_or_none()
    if not member:
        raise ForbiddenException("您不属于任何门店")
    store = await db.get(Store, member.store_id)
    if not store:
        raise ForbiddenException("门店不存在")
    set_tenant(store.id)
    return store


async def get_verified_store(
    store_id: Annotated[uuid.UUID, Path(description="门店ID")],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Store:
    """接收 store_id 路径参数，验证当前用户是否属于该门店，不属于则抛 403"""
    result = await db.execute(
        select(StoreMember).where(
            StoreMember.store_id == store_id,
            StoreMember.user_id == current_user.id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise ForbiddenException("您不属于该门店")

    store = await db.get(Store, store_id)
    if not store:
        raise ForbiddenException("门店不存在")
    set_tenant(store.id)
    return store
