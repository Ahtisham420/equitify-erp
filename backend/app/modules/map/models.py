import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import DateTime, Float, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

OBSERVATION_CATEGORIES = ["general", "vacancy", "signage", "condition", "construction", "tenant", "access", "other"]


class MapFieldObservation(Entity, Base):
    """A field note captured on a property drive: coordinates, optional photos (documents) and a note.

    `field_observations` is the provenance table (app.common.provenance), so this lives in its own table.
    `client_uuid` is generated on the device so offline re-sends are idempotent.
    """

    __tablename__ = "map_field_observations"

    client_uuid: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, index=True)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    location = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True)
    accuracy_m: Mapped[float | None] = mapped_column(Float)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    category: Mapped[str] = mapped_column(String(40), default="general", index=True)
    note: Mapped[str | None] = mapped_column(Text)
    photo_document_ids: Mapped[list] = mapped_column(JSONB, default=list)
