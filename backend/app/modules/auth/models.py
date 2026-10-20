import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow


class Role(Entity, Base):
    __tablename__ = "roles"

    key: Mapped[str] = mapped_column(String(60), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    permissions: Mapped[dict] = mapped_column(JSONB, default=dict)
    approval_limits: Mapped[dict] = mapped_column(JSONB, default=dict)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)


class Team(Entity, Base):
    __tablename__ = "teams"

    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str | None] = mapped_column(Text)


class User(Entity, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str | None] = mapped_column(String(200))
    job_title: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(40))
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id"), index=True)
    team_id: Mapped[uuid.UUID | None] = fk("teams")
    manager_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    is_service: Mapped[bool] = mapped_column(Boolean, default=False)
    mfa_secret: Mapped[str | None] = mapped_column(String(64))
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    role: Mapped[Role] = relationship(foreign_keys=[role_id], lazy="joined")


class UserSession(UUIDPk, Base):
    __tablename__ = "user_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(400))


class ServiceCredential(Entity, Base):
    """Least-privilege programmatic credential bound to a service user."""

    __tablename__ = "service_credentials"

    name: Mapped[str] = mapped_column(String(120))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    key_prefix: Mapped[str] = mapped_column(String(16), index=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    scopes: Mapped[list] = mapped_column(JSONB, default=list)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
