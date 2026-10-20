import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
import pyotp

from app.core.config import settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def create_token(subject: uuid.UUID, purpose: str, minutes: int, session_id: uuid.UUID | None = None) -> str:
    now = utcnow()
    payload = {
        "sub": str(subject),
        "purpose": purpose,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=minutes)).timestamp()),
    }
    if session_id:
        payload["sid"] = str(session_id)
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])


def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=settings.MFA_ISSUER)


def verify_totp(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)


def new_api_key() -> tuple[str, str, str]:
    """Returns (plain_key, prefix, sha256_hash). The plain key is shown once only."""
    prefix = secrets.token_hex(4)
    plain = f"eqf_{prefix}_{secrets.token_urlsafe(32)}"
    return plain, prefix, hash_api_key(plain)


def hash_api_key(plain: str) -> str:
    return hashlib.sha256(plain.encode()).hexdigest()
