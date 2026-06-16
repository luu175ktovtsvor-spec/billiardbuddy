from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from core.exceptions import AppException
from core.security import hash_password, verify_password, create_access_token
from models.user import User
from models.store import StoreMember, StoreInvitation


class PhoneAlreadyRegisteredError(AppException):
    def __init__(self):
        super().__init__("该手机号已注册", status_code=409)


class InvalidCredentialsError(AppException):
    def __init__(self):
        super().__init__("手机号或密码错误", status_code=401)


class InvalidInviteCodeError(AppException):
    def __init__(self):
        super().__init__("邀请码无效或已过期，请向管理员索取新的邀请码", status_code=400)


class IncorrectPasswordError(AppException):
    def __init__(self):
        super().__init__("当前密码不正确", status_code=400)


async def register_user(
    db: AsyncSession, phone: str, password: str, name: str | None,
    invite_code: str | None = None,
) -> tuple[User, str]:
    existing = await db.execute(select(User).where(User.phone == phone))
    if existing.scalar_one_or_none():
        raise PhoneAlreadyRegisteredError()

    user = User(
        phone=phone,
        password_hash=hash_password(password),
        name=name,
    )
    db.add(user)
    await db.flush()

    # 如果提供了邀请码，自动加入门店
    if invite_code:
        code = invite_code.strip().upper()
        # 行级锁，串行化并发注册，避免 use_count 竞态突破次数上限
        result = await db.execute(
            select(StoreInvitation).where(StoreInvitation.code == code).with_for_update()
        )
        invitation = result.scalar_one_or_none()

        now = datetime.now(timezone.utc)
        valid = (
            invitation is not None
            and invitation.is_active
            and (not invitation.expires_at or invitation.expires_at > now)
            and (invitation.max_uses is None or invitation.use_count < invitation.max_uses)
        )
        # 邀请码失效不能静默放过：否则会建出"未入店的孤儿号"，员工再自建店 → 脱离老板门店、
        # 团队数据散架。此时整单注册失败回滚(未 commit → 不建号)，让员工拿新码重试。
        if not valid:
            raise InvalidInviteCodeError()

        member = StoreMember(
            store_id=invitation.store_id,
            user_id=user.id,
            role=invitation.role,
        )
        db.add(member)
        invitation.use_count += 1

    await db.commit()
    await db.refresh(user)

    token = create_access_token(user.id)
    return user, token


async def login_user(
    db: AsyncSession, phone: str, password: str
) -> tuple[User, str]:
    result = await db.execute(select(User).where(User.phone == phone))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise InvalidCredentialsError()

    if not verify_password(password, user.password_hash):
        raise InvalidCredentialsError()

    token = create_access_token(user.id)
    return user, token


async def change_password(
    db: AsyncSession, user: User, old_password: str, new_password: str
) -> None:
    """用户自助改密码：验证旧密码 → 设新密码（新密码强度由 schema 校验）。
    只更新 password_hash，不动用户/门店/历史任何数据；不签发新 token（旧 token 仍有效）。"""
    if not verify_password(old_password, user.password_hash):
        raise IncorrectPasswordError()
    if verify_password(new_password, user.password_hash):
        raise AppException("新密码不能与旧密码相同", status_code=400)
    user.password_hash = hash_password(new_password)
    await db.commit()
