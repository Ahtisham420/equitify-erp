import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from app.core.security import utcnow


class UUIDPk:
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class Timestamps:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class Actors:
    @declared_attr
    def created_by_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    @declared_attr
    def updated_by_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class SoftDelete:
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)


class Entity(UUIDPk, Timestamps, Actors, SoftDelete):
    """Stable id, created/modified timestamps, actor attribution and soft-delete for every core entity."""


def fk(table: str, *, nullable: bool = True, ondelete: str = "SET NULL", index: bool = True) -> Mapped:
    return mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{table}.id", ondelete=ondelete), nullable=nullable, index=index
    )
