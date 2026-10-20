import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

INTEREST_ROLES = [
    "fee_owner", "tenant_in_common", "general_partner", "limited_partner", "managing_member", "member",
    "beneficial_owner", "ground_lessor", "trustee", "other",
]
FINANCING_TYPES = ["all_cash", "bank_loan", "cmbs", "life_company", "seller_financing", "assumed", "private", "unknown"]
LINK_RELATIONSHIPS = [
    "manager", "member", "officer", "director", "registered_agent", "parent", "affiliate", "family", "advisor",
]
# Relationships where `from` controls `to`.
CONTROL_RELATIONSHIPS = {"manager", "member", "officer", "director", "parent"}
EVIDENCE_TYPES = [
    "shared_mailing_address", "shared_phone", "shared_email_domain", "registered_agent", "officer_director_record",
    "deed_signatory", "corroborated_name", "other",
]
NOTE_CATEGORIES = ["preference", "financing", "hold_strategy", "prior_offer", "advisor", "family", "circumstance", "other"]
VERIFICATION = ["unverified", "verified", "rejected"]


class OwnershipInterest(Entity, Base):
    """Owner → property interest. Time-bound: ending an interest sets effective_to; rows are never deleted."""

    __tablename__ = "ownership_interests"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    owner_kind: Mapped[str] = mapped_column(String(20), index=True)  # person | organization
    owner_person_id: Mapped[uuid.UUID | None] = fk("people")
    owner_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    interest_pct: Mapped[float | None] = mapped_column(Numeric(7, 3, asdecimal=False))
    role: Mapped[str] = mapped_column(String(40), default="fee_owner", index=True)
    effective_from: Mapped[date | None] = mapped_column(Date, index=True)
    effective_to: Mapped[date | None] = mapped_column(Date, index=True)
    acquired_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    disposed_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    financing_type: Mapped[str | None] = mapped_column(String(40))
    deed_reference: Mapped[str | None] = mapped_column(String(120))
    end_reason: Mapped[str | None] = mapped_column(String(200))
    evidence: Mapped[list] = mapped_column(JSONB, default=list)
    source: Mapped[str] = mapped_column(String(200), default="Manual entry")
    observed_on: Mapped[date | None] = mapped_column(Date)
    confidence: Mapped[float] = mapped_column(Float, default=0.8)
    verification: Mapped[str] = mapped_column(String(20), default="unverified", index=True)
    verified_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class EntityLink(Entity, Base):
    """Entity↔entity / person↔entity relationship with evidence and confidence. Suggestions need human review."""

    __tablename__ = "entity_links"

    from_kind: Mapped[str] = mapped_column(String(20), index=True)
    from_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    to_kind: Mapped[str] = mapped_column(String(20), index=True)
    to_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    relationship: Mapped[str] = mapped_column(String(30), index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    status: Mapped[str] = mapped_column(String(20), default="suggested", index=True)  # suggested|confirmed|rejected
    evidence: Mapped[list] = mapped_column(JSONB, default=list)
    source: Mapped[str] = mapped_column(String(200), default="Manual entry")
    suggested_by: Mapped[str] = mapped_column(String(20), default="user")  # user | engine
    signature: Mapped[str] = mapped_column(String(120), index=True)
    reviewed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    effective_from: Mapped[date | None] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class OwnerNote(Entity, Base):
    """Owner preferences, financing patterns, advisors/family (where lawful). `sensitive` notes never leave the system."""

    __tablename__ = "owner_notes"

    owner_kind: Mapped[str] = mapped_column(String(20), index=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    category: Mapped[str] = mapped_column(String(30), default="other")
    body: Mapped[str] = mapped_column(Text)
    sensitive: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    source: Mapped[str | None] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
