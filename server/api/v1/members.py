"""成员管理 API：邀请码、加入门店、成员列表、角色调整、移除成员。"""

import secrets
import string
import uuid as uuid_mod
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from core.exceptions import AppException, ForbiddenException, NotFoundException
from core.rbac import Permission, require_permission
from models.user import User
from models.store import Store, StoreMember, StoreInvitation

router = APIRouter(tags=["成员管理"])


# ─── Schemas ───

class CreateInvitationRequest(BaseModel):
    role: str = Field(..., description="邀请码绑定的角色")
    max_uses: int | None = Field(None, ge=1, description="最大使用次数，null 为不限")
    expires_in_hours: int | None = Field(None, ge=1, description="有效期（小时），null 为永不过期")


class InvitationResponse(BaseModel):
    # UUID 类型：ORM 给的是 uuid.UUID 对象，声明 str 会让 Pydantic v2 响应校验直接 500
    id: uuid_mod.UUID
    code: str
    role: str
    is_active: bool
    max_uses: int | None
    use_count: int
    expires_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class JoinRequest(BaseModel):
    invite_code: str = Field(..., min_length=8, max_length=8)


class MemberResponse(BaseModel):
    user_id: str
    name: str | None
    phone: str
    role: str
    joined_at: datetime

    model_config = {"from_attributes": True}


class ChangeRoleRequest(BaseModel):
    role: str = Field(..., description="新角色")


class AddMemberRequest(BaseModel):
    phone: str = Field(..., min_length=11, max_length=20, description="员工手机号")
    role: str = Field(..., description="分配的角色")


# ─── 工具函数 ───

VALID_ROLES = {"owner", "manager", "assistant_manager", "coach", "frontdesk", "operator"}
# 可由邀请码/手动添加/改角色授予的角色：owner 不在内——否则店长（持 STORE_UPDATE）
# 可铸造 owner 邀请码或把同伙加为 owner，进而接管门店。owner 转让需另走专门流程。
GRANTABLE_ROLES = VALID_ROLES - {"owner"}


def _generate_code(length: int = 8) -> str:
    # 用密码学安全随机数，避免邀请码可预测/被枚举
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


# ─── 邀请码管理 ───

@router.post("/invitations", response_model=InvitationResponse, status_code=201)
async def create_invitation(
    body: CreateInvitationRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """创建邀请码。"""
    if body.role not in GRANTABLE_ROLES:
        raise AppException(f"无效角色: {body.role}，可选: {', '.join(GRANTABLE_ROLES)}")

    # 生成唯一邀请码
    for _ in range(10):
        code = _generate_code()
        existing = await db.execute(
            select(StoreInvitation).where(StoreInvitation.code == code)
        )
        if not existing.scalar_one_or_none():
            break
    else:
        raise AppException("邀请码生成失败，请重试")

    expires_at = None
    if body.expires_in_hours:
        from datetime import timedelta
        expires_at = datetime.now(timezone.utc) + timedelta(hours=body.expires_in_hours)

    invitation = StoreInvitation(
        store_id=current_store.id,
        code=code,
        role=body.role,
        created_by=current_user.id,
        max_uses=body.max_uses,
        expires_at=expires_at,
    )
    db.add(invitation)
    await db.commit()
    await db.refresh(invitation)
    return invitation


@router.get("/invitations", response_model=list[InvitationResponse])
async def list_invitations(
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """列出门店的所有邀请码。"""
    result = await db.execute(
        select(StoreInvitation)
        .where(StoreInvitation.store_id == current_store.id)
        .order_by(StoreInvitation.created_at.desc())
    )
    return result.scalars().all()


@router.patch("/invitations/{invitation_id}")
async def toggle_invitation(
    invitation_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """启用/禁用邀请码。"""
    import uuid
    result = await db.execute(
        select(StoreInvitation).where(
            StoreInvitation.id == uuid.UUID(invitation_id),
            StoreInvitation.store_id == current_store.id,
        )
    )
    invitation = result.scalar_one_or_none()
    if not invitation:
        raise NotFoundException("邀请码不存在")

    invitation.is_active = not invitation.is_active
    await db.commit()
    return {"is_active": invitation.is_active}


@router.delete("/invitations/{invitation_id}")
async def delete_invitation(
    invitation_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """删除邀请码。"""
    import uuid
    result = await db.execute(
        select(StoreInvitation).where(
            StoreInvitation.id == uuid.UUID(invitation_id),
            StoreInvitation.store_id == current_store.id,
        )
    )
    invitation = result.scalar_one_or_none()
    if not invitation:
        raise NotFoundException("邀请码不存在")

    await db.delete(invitation)
    await db.commit()
    return {"detail": "已删除"}


# ─── 加入门店 ───

@router.post("/join")
async def join_store(
    body: JoinRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """用邀请码加入门店。"""
    code = body.invite_code.strip().upper()

    # 行级锁：与注册路径一致，串行化并发使用，避免 use_count 竞态突破次数上限
    result = await db.execute(
        select(StoreInvitation).where(StoreInvitation.code == code).with_for_update()
    )
    invitation = result.scalar_one_or_none()

    if not invitation:
        raise NotFoundException("邀请码不存在")
    if not invitation.is_active:
        raise AppException("邀请码已禁用")
    if invitation.expires_at and invitation.expires_at < datetime.now(timezone.utc):
        raise AppException("邀请码已过期")
    if invitation.max_uses is not None and invitation.use_count >= invitation.max_uses:
        raise AppException("邀请码已达使用上限")

    # 检查用户是否已是该门店成员
    existing = await db.execute(
        select(StoreMember).where(
            StoreMember.store_id == invitation.store_id,
            StoreMember.user_id == current_user.id,
        )
    )
    if existing.scalar_one_or_none():
        raise AppException("您已是该门店成员")

    # 加入门店
    member = StoreMember(
        store_id=invitation.store_id,
        user_id=current_user.id,
        role=invitation.role,
    )
    db.add(member)
    invitation.use_count += 1
    await db.commit()

    return {"detail": "加入成功", "store_id": str(invitation.store_id), "role": invitation.role}


# ─── 成员管理 ───

@router.get("/list", response_model=list[MemberResponse])
async def list_members(
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """列出门店所有成员。"""
    result = await db.execute(
        select(StoreMember, User)
        .join(User, User.id == StoreMember.user_id)
        .where(StoreMember.store_id == current_store.id)
        .order_by(StoreMember.created_at)
    )
    rows = result.all()
    return [
        MemberResponse(
            user_id=str(row.StoreMember.user_id),
            name=row.User.name,
            phone=row.User.phone,
            role=row.StoreMember.role,
            joined_at=row.StoreMember.created_at,
        )
        for row in rows
    ]


@router.patch("/{user_id}/role")
async def change_member_role(
    user_id: str,
    body: ChangeRoleRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """调整成员角色。"""
    if body.role not in GRANTABLE_ROLES:
        raise AppException(f"无效角色: {body.role}")

    # 不能修改自己的角色
    if str(current_user.id) == user_id:
        raise AppException("不能修改自己的角色")

    try:
        target_uuid = uuid_mod.UUID(user_id)
    except ValueError:
        raise NotFoundException("该用户不是门店成员")

    result = await db.execute(
        select(StoreMember).where(
            StoreMember.store_id == current_store.id,
            StoreMember.user_id == target_uuid,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise NotFoundException("该用户不是门店成员")

    # 不能降级/改动 owner——否则店长可把店主降为前台，接管门店
    if member.role == "owner":
        raise ForbiddenException("不能修改店主（owner）的角色")

    member.role = body.role
    await db.commit()
    return {"detail": "角色已更新", "role": member.role}


@router.delete("/{user_id}")
async def remove_member(
    user_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """移除成员。仅 owner 可操作。"""
    import uuid

    # 检查当前用户是否是 owner
    result = await db.execute(
        select(StoreMember).where(
            StoreMember.store_id == current_store.id,
            StoreMember.user_id == current_user.id,
        )
    )
    my_member = result.scalar_one_or_none()
    if not my_member or my_member.role != "owner":
        raise ForbiddenException("仅 owner 可移除成员")

    # 不能移除自己
    if str(current_user.id) == user_id:
        raise AppException("不能移除自己")

    result = await db.execute(
        select(StoreMember).where(
            StoreMember.store_id == current_store.id,
            StoreMember.user_id == uuid.UUID(user_id),
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise NotFoundException("该用户不是门店成员")

    await db.delete(member)
    await db.commit()
    return {"detail": "已移除"}


# ─── 手动添加成员 ───

@router.post("/add", status_code=201)
async def add_member_by_phone(
    body: AddMemberRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """管理员通过手机号直接添加成员。"""
    if body.role not in GRANTABLE_ROLES:
        raise AppException(f"无效角色: {body.role}")

    # 查找用户
    result = await db.execute(select(User).where(User.phone == body.phone))
    user = result.scalar_one_or_none()
    if not user:
        raise NotFoundException(f"手机号 {body.phone} 未注册，请先注册")

    # 检查是否已是成员
    existing = await db.execute(
        select(StoreMember).where(
            StoreMember.store_id == current_store.id,
            StoreMember.user_id == user.id,
        )
    )
    if existing.scalar_one_or_none():
        raise AppException("该用户已是门店成员")

    member = StoreMember(
        store_id=current_store.id,
        user_id=user.id,
        role=body.role,
    )
    db.add(member)
    await db.commit()
    return {"detail": "添加成功", "user_id": str(user.id), "role": body.role}
