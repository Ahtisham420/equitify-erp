import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class LinkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    document_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    label: str | None = None
    created_at: datetime


class LinkIn(BaseModel):
    entity_type: str = Field(pattern=r"^[a-z][a-z_]{1,39}$")
    entity_id: uuid.UUID


class DocumentRef(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    filename: str
    version: int
    created_at: datetime


class DocumentListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    doc_class: str
    classification_source: str
    filename: str
    mime_type: str
    size_bytes: int
    version: int
    is_sensitive: bool
    legal_hold: bool
    retention_until: date | None
    extraction_status: str
    uploaded_by_id: uuid.UUID | None
    uploaded_by_name: str | None = None
    pending_values: int = 0
    links: list[LinkOut] = []
    tags: list[str] = []
    created_at: datetime
    updated_at: datetime


class DocumentOut(DocumentListItem):
    description: str | None
    classification_confidence: float | None
    sha256: str
    parent_document_id: uuid.UUID | None
    is_latest: bool
    has_text: bool = False
    text_content: str | None = None
    text_source: str | None
    can_delete: bool = False
    delete_blocked_reason: str | None = None
    duplicates: list[DocumentRef] = []


class DocumentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    doc_class: str | None = None
    is_sensitive: bool | None = None
    retention_until: date | None = None
    legal_hold: bool | None = None
    tags: list[str] | None = None


class TextIn(BaseModel):
    text: str = Field(max_length=5_000_000)


class DocumentFacets(BaseModel):
    doc_class: dict[str, int]
    sensitivity: dict[str, int]
    linked_type: dict[str, int]
    extraction_status: dict[str, int]


class AccessLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    action: str
    occurred_at: datetime
    user_id: uuid.UUID | None
    user_name: str | None = None
    ip_address: str | None


class SignedUrlOut(BaseModel):
    url: str
    expires_at: datetime
    inline: bool


# --- Extraction & verification -------------------------------------------------------------------

class ExtractIn(BaseModel):
    target_entity_type: str | None = Field(default=None, pattern=r"^[a-z][a-z_]{1,39}$")
    target_entity_id: uuid.UUID | None = None
    fields: list[str] | None = None


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    document_id: uuid.UUID
    status: str
    target_entity_type: str | None
    target_entity_id: uuid.UUID | None
    fields: list
    provider: str | None
    model: str | None
    values_count: int
    message: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime


class ManualValueIn(BaseModel):
    """Human-abstracted value with citation; follows the same verification path as AI output."""

    field: str = Field(min_length=1, max_length=80)
    value: Any
    value_type: Literal["text", "number", "money", "date", "percent"] = "text"
    page: int | None = Field(default=None, ge=1)
    clause: str | None = Field(default=None, max_length=200)
    citation_text: str | None = None
    confidence: float = Field(default=0.9, ge=0, le=1)
    target_entity_type: str | None = Field(default=None, pattern=r"^[a-z][a-z_]{1,39}$")
    target_entity_id: uuid.UUID | None = None


class ExtractedValueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    document_id: uuid.UUID
    document_title: str | None = None
    job_id: uuid.UUID | None
    origin: str
    target_entity_type: str | None
    target_entity_id: uuid.UUID | None
    target_label: str | None = None
    field: str
    value_type: str
    value: Any
    original_value: Any
    page: int | None
    clause: str | None
    citation_text: str | None
    confidence: float
    status: str
    reviewer_id: uuid.UUID | None
    reviewer_name: str | None = None
    reviewed_at: datetime | None
    review_note: str | None
    ai_model: str | None
    applied_observation_id: uuid.UUID | None
    is_date: bool = False
    applicable: bool = False
    current_value: Any = None
    conflict: bool | None = None
    created_at: datetime


class ConfirmIn(BaseModel):
    accept_conflict: bool = False
    note: str | None = None


class EditIn(ConfirmIn):
    value: Any


class RejectIn(BaseModel):
    note: str | None = None


class ValueFacets(BaseModel):
    status: dict[str, int]
    field: dict[str, int]
    target_entity_type: dict[str, int]


# --- Retrieval, summaries, drafting --------------------------------------------------------------

class Citation(BaseModel):
    document_id: uuid.UUID | None = None
    page: int | None = None
    clause: str | None = None
    text: str | None = None


class SearchHit(BaseModel):
    document_id: uuid.UUID
    title: str
    doc_class: str
    filename: str
    is_sensitive: bool
    matched_in: list[str]
    snippet: str | None
    citations: list[Citation] = []
    links: list[LinkOut] = []


class SummarizeIn(BaseModel):
    document_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    entity_type: str | None = None
    entity_id: uuid.UUID | None = None
    purpose: Literal["document_set", "deal_history", "calls", "portfolio"] = "document_set"


class SummaryOut(BaseModel):
    ai_used: bool
    provider: str
    summary: str | None
    citations: list[Citation] = []
    document_ids: list[uuid.UUID] = []
    message: str | None = None


class DraftIn(BaseModel):
    kind: Literal["outreach", "offer", "proposal", "report"]
    entity_type: Literal["property"] = "property"
    entity_id: uuid.UUID
    instructions: str | None = Field(default=None, max_length=2000)


class DraftSource(BaseModel):
    field: str
    value: Any
    source: str


class DraftOut(BaseModel):
    ai_used: bool
    provider: str
    draft: str
    sources: list[DraftSource] = []


class AICallOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider: str
    model: str | None
    purpose: str
    prompt_hash: str
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int
    status: str
    error: str | None
    document_id: uuid.UUID | None
    created_by_id: uuid.UUID | None
    created_at: datetime
