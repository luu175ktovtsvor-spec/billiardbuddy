"""
统一 RBAC 权限系统。

通过权限矩阵 + FastAPI 依赖注入工厂实现集中式权限控制。
用法：在路由函数中添加 _perm: None = Depends(require_permission(Permission.XXX))
"""

from enum import Enum
from typing import Annotated

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import ForbiddenException
from models.store import StoreMember
from models.user import User
from models.store import Store


class Permission(str, Enum):
    """系统权限枚举。"""
    STORE_UPDATE = "store_update"
    STORE_DELETE = "store_delete"
    GENERATION_CREATE = "generation_create"
    GENERATION_LIST = "generation_list"
    GENERATION_DELETE = "generation_delete"
    POSTER_CREATE = "poster_create"
    POSTER_LIST = "poster_list"
    MEMBER_MANAGE = "member_manage"
    QUOTA_VIEW = "quota_view"
    DASHBOARD_VIEW = "dashboard_view"


# 权限矩阵：角色 → 允许的权限集合
ROLE_PERMISSIONS: dict[str, set[Permission]] = {
    "owner": {p for p in Permission},
    "manager": {
        Permission.STORE_UPDATE,
        Permission.GENERATION_CREATE, Permission.GENERATION_LIST, Permission.GENERATION_DELETE,
        Permission.POSTER_CREATE, Permission.POSTER_LIST,
        Permission.MEMBER_MANAGE,
        Permission.QUOTA_VIEW, Permission.DASHBOARD_VIEW,
    },
    "assistant_manager": {
        Permission.GENERATION_CREATE, Permission.GENERATION_LIST,
        Permission.POSTER_CREATE, Permission.POSTER_LIST,
        Permission.QUOTA_VIEW, Permission.DASHBOARD_VIEW,
    },
    "coach": {
        Permission.GENERATION_CREATE, Permission.GENERATION_LIST,
        Permission.POSTER_CREATE, Permission.POSTER_LIST,
        Permission.QUOTA_VIEW, Permission.DASHBOARD_VIEW,
    },
    "frontdesk": {
        Permission.GENERATION_CREATE, Permission.GENERATION_LIST,
        Permission.POSTER_CREATE, Permission.POSTER_LIST,
        Permission.QUOTA_VIEW, Permission.DASHBOARD_VIEW,
    },
    "operator": {
        Permission.GENERATION_CREATE, Permission.GENERATION_LIST,
        Permission.POSTER_CREATE, Permission.POSTER_LIST,
        Permission.QUOTA_VIEW, Permission.DASHBOARD_VIEW,
    },
}


def require_permission(permission: Permission):
    """FastAPI 依赖工厂。检查当前用户是否有指定权限。

    用法：
        @router.post("/something")
        async def endpoint(
            _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
            ...
        ):
    """
    async def _check(
        current_user: Annotated[User, Depends(get_current_user)],
        current_store: Annotated[Store, Depends(get_current_store)],
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> None:
        result = await db.execute(
            select(StoreMember).where(
                StoreMember.store_id == current_store.id,
                StoreMember.user_id == current_user.id,
            )
        )
        member = result.scalar_one_or_none()
        if not member:
            raise ForbiddenException("您不属于该门店")

        allowed = ROLE_PERMISSIONS.get(member.role, set())
        if permission not in allowed:
            raise ForbiddenException(f"您的角色 ({member.role}) 无权执行此操作")

    return _check
