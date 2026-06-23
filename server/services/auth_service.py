from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from core.exceptions import AppException
from core.security import hash_password, verify_password, create_access_token
from models.user import User
from models.store import StoreMember


class PhoneAlreadyRegisteredError(AppException):
    def __init__(self):
        super().__init__("该手机号已注册", status_code=409)


class InvalidCredentialsError(AppException):
    def __init__(self):
        super().__init__("手机号或密码错误", status_code=401)


class IncorrectPasswordError(AppException):
    def __init__(self):
        super().__init__("当前密码不正确", status_code=400)


async def register_user(
    db: AsyncSession, phone: str, password: str, name: str | None,
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

    # 防并发/重复提交：SELECT 检查与 INSERT 之间若有竞态（如连点两次「注册」），
    # 第二条会撞 phone 唯一约束 → IntegrityError。这里兜成友好的 409，绝不暴露成裸 500。
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise PhoneAlreadyRegisteredError()
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
