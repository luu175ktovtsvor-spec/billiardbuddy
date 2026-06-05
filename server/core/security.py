import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(
        plain_password.encode("utf-8"), hashed_password.encode("utf-8")
    )


def create_access_token(user_id: uuid.UUID, expires_delta: timedelta | None = None) -> str:
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=settings.jwt_expire_minutes))
    to_encode = {
        "sub": str(user_id),
        "iat": now,
        "jti": uuid.uuid4().hex,
        "exp": expire,
    }
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> uuid.UUID:
    try:
        payload = jwt.decode(
            token, settings.secret_key, algorithms=[settings.jwt_algorithm]
        )
        user_id = payload.get("sub")
        if user_id is None:
            raise ValueError("missing sub claim")
        return uuid.UUID(user_id)
    except (jwt.InvalidTokenError, ValueError):
        raise


def decode_token_allow_expired(token: str) -> dict:
    """Decode JWT without verifying expiration.

    Used by the refresh endpoint to extract user_id from an expired token
    as long as it is within the 24-hour refresh window.
    Raises jwt.InvalidTokenError if the token is malformed or signature is invalid.
    """
    payload = jwt.decode(
        token,
        settings.secret_key,
        algorithms=[settings.jwt_algorithm],
        options={"verify_exp": False},
    )
    return payload
