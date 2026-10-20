"""Authentication + authorization dependencies.

Every API request is authorized here, independently of the UI. Use:
    user: CurrentUser = Depends(require("properties", "view"))
"""
import uuid
from dataclasses import dataclass, field
from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_token, hash_api_key, utcnow
from app.modules.auth.models import ServiceCredential, User, UserSession
from app.modules.auth.permissions import allows, scopes_to_permissions

bearer = HTTPBearer(auto_error=False)
DB = Annotated[AsyncSession, Depends(get_db)]


@dataclass
class CurrentUser:
    user: User
    permissions: dict[str, list[str]]
    approval_limits: dict = field(default_factory=dict)
    session_id: uuid.UUID | None = None
    ip_address: str | None = None

    @property
    def id(self) -> uuid.UUID:
        return self.user.id

    @property
    def full_name(self) -> str:
        return self.user.full_name

    @property
    def is_admin(self) -> bool:
        return "*" in self.permissions.get("*", [])

    def can(self, module: str, action: str) -> bool:
        return allows(self.permissions, module, action)

    def can_approve(self, kind: str, amount: float | None) -> bool:
        if self.is_admin:
            return True
        if kind not in self.approval_limits:
            return False
        limit = self.approval_limits[kind]
        return limit is None or (amount is not None and amount <= limit)


_unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", {"WWW-Authenticate": "Bearer"})


async def get_current_user(
    request: Request,
    db: DB,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    x_api_key: str | None = Header(default=None),
) -> CurrentUser:
    ip = request.client.host if request.client else None

    if x_api_key:
        cred = await db.scalar(
            select(ServiceCredential).where(
                ServiceCredential.key_hash == hash_api_key(x_api_key), ServiceCredential.revoked_at.is_(None)
            )
        )
        if not cred:
            raise _unauthorized
        user = await db.get(User, cred.user_id)
        if not user or user.status != "active":
            raise _unauthorized
        cred.last_used_at = utcnow()
        await db.commit()
        return CurrentUser(user=user, permissions=scopes_to_permissions(cred.scopes), ip_address=ip)

    if not creds:
        raise _unauthorized
    try:
        payload = decode_token(creds.credentials)
    except jwt.PyJWTError:
        raise _unauthorized
    if payload.get("purpose") != "access" or "sid" not in payload:
        raise _unauthorized

    session = await db.get(UserSession, uuid.UUID(payload["sid"]))
    if not session or session.revoked_at or session.expires_at < utcnow():
        raise _unauthorized
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or user.status != "active" or user.deleted_at:
        raise _unauthorized
    return CurrentUser(
        user=user,
        permissions=user.role.permissions or {},
        approval_limits=user.role.approval_limits or {},
        session_id=session.id,
        ip_address=ip,
    )


Authed = Annotated[CurrentUser, Depends(get_current_user)]


def require(module: str, action: str = "view"):
    async def checker(user: Authed) -> CurrentUser:
        if not user.can(module, action):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing permission {module}:{action}")
        return user

    return checker
