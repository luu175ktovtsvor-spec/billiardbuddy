from typing import Annotated

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import UnauthorizedException, ForbiddenException
from core.tenant import set_tenant
from db.session import async_session
from models.user import User
from models.store import Store


async def get_db():
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def get_current_user(db: Annotated[AsyncSession, Depends(get_db)]) -> User:
    """本地单用户身份：返回库里唯一的 owner（首启 `init_local._seed_local_owner` 已建）。

    桌面=装老板自己电脑上的本机单人 App，已删 SaaS 的手机号/密码/JWT 登录——不再解析
    Authorization/token，直接取本地 owner。签名保持返回 User，故所有 `Depends(get_current_user)`
    的业务路由零改动。"""
    user = (await db.execute(select(User).order_by(User.created_at).limit(1))).scalars().first()
    if not user:
        # 自愈：首启建库被中断（强杀/断电/超时闸刀）会留下"库在、身份没种上"的残局——重启也修不好，
        # 前端每个请求都 401"本地身份异常"（1.0.0 真机事故）。这里按需补种一次（幂等，内部有
        # "已有用户则跳过"守卫），补完重查；仍然没有才报错。
        from db.init_local import _seed_local_owner

        await _seed_local_owner()
        user = (await db.execute(select(User).order_by(User.created_at).limit(1))).scalars().first()
        if not user:
            raise UnauthorizedException("本地用户未初始化（请重启 App 完成首启 seed）")
    return user


async def get_current_store(db: Annotated[AsyncSession, Depends(get_db)]) -> Store:
    """本地单门店：返回库里唯一门店并设租户上下文。

    门店/store_id/租户自动过滤是"数据组织地基"（不是 SaaS 鉴权），保留——set_tenant 必须有真实
    store_id，否则租户过滤把数据读空。"""
    store = (await db.execute(select(Store).order_by(Store.created_at).limit(1))).scalars().first()
    if not store:
        raise ForbiddenException("本地门店未初始化")
    set_tenant(store.id)
    return store
