import uuid

from sqlalchemy import Boolean, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base


class SavedView(Entity, Base):
    """A reusable list definition (search + filters + sort) for any module."""

    __tablename__ = "saved_views"

    name: Mapped[str] = mapped_column(String(160))
    module: Mapped[str] = mapped_column(String(60), index=True)
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    visibility: Mapped[str] = mapped_column(String(20), default="private")  # private | team | company
    owner_id: Mapped[uuid.UUID] = fk("users", nullable=False, ondelete="CASCADE")
    team_id: Mapped[uuid.UUID | None] = fk("teams")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
