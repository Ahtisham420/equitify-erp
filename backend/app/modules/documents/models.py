import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

DOC_CLASSES = [
    "acquisition", "lease", "amendment", "estoppel", "snda", "debt", "loan_agreement", "tax", "insurance",
    "closing", "settlement_statement", "survey", "title", "environmental", "pca", "appraisal", "bov", "entity",
    "correspondence", "contract", "loi", "other",
]
EXTRACTION_STATUSES = ["none", "queued", "running", "completed", "skipped", "failed"]
JOB_STATUSES = ["queued", "running", "completed", "skipped", "failed"]
VALUE_STATUSES = ["pending", "confirmed", "rejected", "edited"]
ACCESS_ACTIONS = ["view", "download", "preview"]
# Record types a document can be linked to (polymorphic). Any lower_snake type is accepted; these are offered in the UI.
LINK_TYPES = [
    "property", "person", "organization", "opportunity", "offer", "contract", "closing", "asset", "lease", "loan",
    "disposition", "work_order", "vendor", "capital_project", "insurance_policy", "capital_partner", "listing",
    "brokerage_deal", "uw_model",
]


class Document(Entity, Base):
    """A stored file version. Versions of one logical document share `parent_document_id` (the chain root)."""

    __tablename__ = "documents"

    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    doc_class: Mapped[str] = mapped_column(String(40), default="other", index=True)
    classification_source: Mapped[str] = mapped_column(String(20), default="manual")  # manual | ai
    classification_confidence: Mapped[float | None] = mapped_column(Float)
    filename: Mapped[str] = mapped_column(String(300))
    mime_type: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    storage_key: Mapped[str] = mapped_column(String(400))
    version: Mapped[int] = mapped_column(Integer, default=1)
    parent_document_id: Mapped[uuid.UUID | None] = fk("documents")
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    retention_until: Mapped[date | None] = mapped_column(Date)
    legal_hold: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_sensitive: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    uploaded_by_id: Mapped[uuid.UUID | None] = fk("users")
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    # Plain text used for search/extraction: read from text files, or pasted / supplied by a future extractor.
    text_content: Mapped[str | None] = mapped_column(Text)
    text_source: Mapped[str | None] = mapped_column(String(20))  # file | manual | extractor
    extraction_status: Mapped[str] = mapped_column(String(20), default="none", index=True)

    @property
    def root_id(self) -> uuid.UUID:
        return self.parent_document_id or self.id


class DocumentLink(UUIDPk, Base):
    """Polymorphic record linkage. Links are attached to the chain root so they follow every version."""

    __tablename__ = "document_links"
    __table_args__ = (UniqueConstraint("document_id", "entity_type", "entity_id", name="uq_document_links_target"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    entity_type: Mapped[str] = mapped_column(String(40), index=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class DocumentAccessLog(UUIDPk, Base):
    """Immutable access trail: every view, download and preview."""

    __tablename__ = "document_access_log"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = fk("users")
    action: Mapped[str] = mapped_column(String(20), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    ip_address: Mapped[str | None] = mapped_column(String(64))


class ExtractionJob(Entity, Base):
    """Non-blocking AI extraction run. `skipped` when no provider (or no text) is available."""

    __tablename__ = "extraction_jobs"

    document_id: Mapped[uuid.UUID] = fk("documents", nullable=False, ondelete="CASCADE")
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    target_entity_type: Mapped[str | None] = mapped_column(String(40))
    target_entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    fields: Mapped[list] = mapped_column(JSONB, default=list)
    provider: Mapped[str | None] = mapped_column(String(60))
    model: Mapped[str | None] = mapped_column(String(120))
    values_count: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ExtractedValue(Entity, Base):
    """A candidate value with page/clause citation and confidence. Never authoritative until a named human confirms."""

    __tablename__ = "extracted_values"

    document_id: Mapped[uuid.UUID] = fk("documents", nullable=False, ondelete="CASCADE")
    job_id: Mapped[uuid.UUID | None] = fk("extraction_jobs")
    origin: Mapped[str] = mapped_column(String(20), default="ai")  # ai | manual
    target_entity_type: Mapped[str | None] = mapped_column(String(40), index=True)
    target_entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    field: Mapped[str] = mapped_column(String(80), index=True)
    value_type: Mapped[str] = mapped_column(String(20), default="text")  # text | number | money | date | percent
    value: Mapped[Any] = mapped_column(JSONB)
    original_value: Mapped[Any] = mapped_column(JSONB)
    page: Mapped[int | None] = mapped_column(Integer)
    clause: Mapped[str | None] = mapped_column(String(200))
    citation_text: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    reviewer_id: Mapped[uuid.UUID | None] = fk("users")
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    ai_model: Mapped[str | None] = mapped_column(String(120))
    applied_observation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class AICall(UUIDPk, Base):
    """Prompt/model/output logging for AI provenance. Prompts are stored as hashes only."""

    __tablename__ = "ai_calls"

    provider: Mapped[str] = mapped_column(String(60), index=True)
    model: Mapped[str | None] = mapped_column(String(120))
    purpose: Mapped[str] = mapped_column(String(60), index=True)
    prompt_hash: Mapped[str] = mapped_column(String(64))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="ok")  # ok | error
    error: Mapped[str | None] = mapped_column(Text)
    output_summary: Mapped[dict | None] = mapped_column(JSONB)
    document_id: Mapped[uuid.UUID | None] = fk("documents")
    created_by_id: Mapped[uuid.UUID | None] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
