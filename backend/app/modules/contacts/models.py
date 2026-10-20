import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

ROLES = [
    "owner", "principal", "broker", "agent", "tenant_contact", "vendor_contact", "lender", "attorney",
    "title_officer", "capital_partner", "other",
]
ORG_TYPES = [
    "owner_entity", "llc", "corporation", "partnership", "trust", "brokerage", "lender", "law_firm",
    "title_company", "tenant", "vendor", "capital_partner", "government", "other",
]
PHONE_TYPES = ["mobile", "landline", "voip", "fax", "unknown"]
STRENGTHS = ["none", "weak", "moderate", "strong"]
RESPONSIVENESS = ["unknown", "low", "medium", "high"]


class Person(Entity, Base):
    __tablename__ = "people"

    first_name: Mapped[str | None] = mapped_column(String(120))
    last_name: Mapped[str | None] = mapped_column(String(120))
    full_name: Mapped[str] = mapped_column(String(240), index=True)
    normalized_name: Mapped[str] = mapped_column(String(240), index=True, default="")
    title: Mapped[str | None] = mapped_column(String(160))
    primary_email: Mapped[str | None] = mapped_column(String(255), index=True)
    primary_phone: Mapped[str | None] = mapped_column(String(40))
    mailing_address: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str | None] = mapped_column(String(120))
    state: Mapped[str | None] = mapped_column(String(40), index=True)
    postal_code: Mapped[str | None] = mapped_column(String(20))
    contact_preferences: Mapped[dict] = mapped_column(JSONB, default=dict)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    # Relationship intelligence. last_touch_at / next_action_at are maintained by the outreach module.
    last_touch_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    next_action: Mapped[str | None] = mapped_column(String(300))
    responsiveness: Mapped[str] = mapped_column(String(20), default="unknown", index=True)
    relationship_strength: Mapped[str] = mapped_column(String(20), default="none", index=True)
    preferences: Mapped[dict] = mapped_column(JSONB, default=dict)
    source: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    merged_into_id: Mapped[uuid.UUID | None] = fk("people")


class Organization(Entity, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(240), index=True)
    legal_name: Mapped[str | None] = mapped_column(String(240))
    normalized_name: Mapped[str] = mapped_column(String(240), index=True, default="")
    org_type: Mapped[str] = mapped_column(String(40), default="other", index=True)
    website: Mapped[str | None] = mapped_column(String(255))
    domain: Mapped[str | None] = mapped_column(String(160), index=True)
    phone: Mapped[str | None] = mapped_column(String(40))
    mailing_address: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str | None] = mapped_column(String(120))
    state: Mapped[str | None] = mapped_column(String(40), index=True)
    postal_code: Mapped[str | None] = mapped_column(String(20))
    state_of_formation: Mapped[str | None] = mapped_column(String(40))
    registered_agent: Mapped[str | None] = mapped_column(String(240))
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    last_touch_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    next_action: Mapped[str | None] = mapped_column(String(300))
    responsiveness: Mapped[str] = mapped_column(String(20), default="unknown")
    relationship_strength: Mapped[str] = mapped_column(String(20), default="none")
    preferences: Mapped[dict] = mapped_column(JSONB, default=dict)
    source: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    merged_into_id: Mapped[uuid.UUID | None] = fk("organizations")


class ContactPoint(Entity, Base):
    __tablename__ = "contact_points"

    person_id: Mapped[uuid.UUID | None] = fk("people", ondelete="CASCADE")
    organization_id: Mapped[uuid.UUID | None] = fk("organizations", ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(10), index=True)  # phone | email
    value: Mapped[str] = mapped_column(String(255))
    normalized_value: Mapped[str] = mapped_column(String(255), index=True)
    label: Mapped[str | None] = mapped_column(String(60))
    phone_type: Mapped[str | None] = mapped_column(String(20))
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str | None] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    # Set by outreach on a wrong-number disposition; the value is kept for history.
    is_valid: Mapped[bool] = mapped_column(Boolean, default=True)
    invalid_reason: Mapped[str | None] = mapped_column(String(200))
    invalid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Affiliation(Entity, Base):
    __tablename__ = "affiliations"

    person_id: Mapped[uuid.UUID] = fk("people", nullable=False, ondelete="CASCADE")
    organization_id: Mapped[uuid.UUID] = fk("organizations", nullable=False, ondelete="CASCADE")
    role: Mapped[str] = mapped_column(String(30), index=True)
    title: Mapped[str | None] = mapped_column(String(160))
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    started_on: Mapped[date | None] = mapped_column(Date)
    ended_on: Mapped[date | None] = mapped_column(Date)
    source: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)


class ContactEnrichment(Entity, Base):
    """One enrichment pull: provider, date, cost, reliability and usage restrictions."""

    __tablename__ = "contact_enrichments"

    person_id: Mapped[uuid.UUID | None] = fk("people", ondelete="CASCADE")
    organization_id: Mapped[uuid.UUID | None] = fk("organizations", ondelete="CASCADE")
    provider: Mapped[str] = mapped_column(String(120))
    enriched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    cost: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    reliability: Mapped[float | None] = mapped_column(Float)  # 0..1
    fields: Mapped[list] = mapped_column(JSONB, default=list)
    restrictions: Mapped[dict] = mapped_column(JSONB, default=dict)
    notes: Mapped[str | None] = mapped_column(Text)


class DuplicateReview(Entity, Base):
    """Review-queue item for a likely duplicate pair. Never merged automatically."""

    __tablename__ = "contact_duplicate_reviews"
    __table_args__ = (UniqueConstraint("entity_type", "a_id", "b_id", name="uq_contact_dup_pair"),)

    entity_type: Mapped[str] = mapped_column(String(20), index=True)  # person | organization
    a_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    b_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    reasons: Mapped[list] = mapped_column(JSONB, default=list)
    score: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)  # open | merged | dismissed
    reviewed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MergeRecord(Entity, Base):
    """Reversible merge: full snapshot of the merged record and every repointed FK row."""

    __tablename__ = "contact_merges"

    entity_type: Mapped[str] = mapped_column(String(20), index=True)
    survivor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    merged_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)
    survivor_before: Mapped[dict] = mapped_column(JSONB, default=dict)
    repointed: Mapped[list] = mapped_column(JSONB, default=list)
    review_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    reason: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="merged", index=True)  # merged | reversed
    merged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
