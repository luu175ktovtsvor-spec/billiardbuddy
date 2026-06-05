from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from core.exceptions import AppException
from core.security import hash_password, verify_password, create_access_token
from models.user import User


class PhoneAlreadyRegisteredError(AppException):
    def __init__(self):
        super().__init__("该手机号已注册", status_code=409)


class InvalidCredentialsError(AppException):
    def __init__(self):
        super().__init__("手机号或密码错误", status_code=401)


async def register_user(
    db: AsyncSession, phone: str, password: str, name: str | None
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
