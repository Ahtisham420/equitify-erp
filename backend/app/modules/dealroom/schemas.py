import copy
import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model


def partial(model: type[BaseModel], name: str) -> type[BaseModel]:
    """Same fields as `model`, all optional (PATCH bodies). Unknown keys are rejected."""
    fields: dict[str, Any] = {}
    for key, f in model.model_fields.items():
        fi = copy.copy(f)
        fi.default, fi.default_factory = None, None
        fi.metadata = list(f.metadata)
        if isinstance(getattr(fi, "_attributes_set", None), dict):
            attrs = {k: v for k, v in fi._attributes_set.items() if k != "default_factory"}
            attrs["default"] = None
            fi._attributes_set = attrs
        fields[key] = (f.annotation | None, fi)  # type: ignore[operator]
    return create_model(name, __config__=ConfigDict(extra="forbid"), **fields)


class Labels(BaseModel):
    property_label: str | None = None
    agent_name: str | None = None
    person_label: str | None = None
    organization_label: str | None = None


# ------------------------------------------------------------------ tours

class Participant(BaseModel):
    kind: Literal["user", "person", "organization", "external"] = "external"
    id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=80)


class TourBase(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    agent_id: uuid.UUID | None = None
    client_person_id: uuid.UUID | None = None
    client_organization_id: uuid.UUID | None = None
    brokerage_deal_id: uuid.UUID | None = None
    requirement_id: uuid.UUID | None = None
    scheduled_on: date
    start_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    status: Literal["planned", "confirmed", "completed", "cancelled"] = "planned"
    start_label: str | None = Field(default=None, max_length=255)
    start_lat: float | None = Field(default=None, ge=-90, le=90)
    start_lng: float | None = Field(default=None, ge=-180, le=180)
    participants: list[Participant] = []
    notes: str | None = None


class TourCreate(TourBase):
    property_ids: list[uuid.UUID] = []


TourUpdate = partial(TourBase, "TourUpdate")


class TourOut(TourBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    title: str
    total_distance_miles: float | None
    optimized_at: datetime | None
    stop_count: int = 0
    feedback_count: int = 0
    created_at: datetime
    updated_at: datetime


class StopIn(BaseModel):
    property_id: uuid.UUID
    listing_id: uuid.UUID | None = None
    arrive_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    duration_minutes: int = Field(default=30, ge=5, le=480)
    access_notes: str | None = None


class StopUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    arrive_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    duration_minutes: int | None = Field(default=None, ge=5, le=480)
    status: Literal["planned", "visited", "skipped"] | None = None
    access_notes: str | None = None
    sequence: int | None = Field(default=None, ge=0)


class StopOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    tour_id: uuid.UUID
    property_id: uuid.UUID
    listing_id: uuid.UUID | None
    sequence: int
    arrive_time: str | None
    duration_minutes: int
    distance_from_prev_miles: float | None
    status: str
    access_notes: str | None
    property_label: str | None = None
    address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    has_location: bool = False


class FeedbackIn(BaseModel):
    stop_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None
    rating: int | None = Field(default=None, ge=1, le=5)
    interest_level: Literal["none", "low", "medium", "high"] | None = None
    feedback: str | None = None
    objections: str | None = None
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None


class FeedbackOut(FeedbackIn, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    tour_id: uuid.UUID
    listing_id: uuid.UUID | None
    follow_up_task_id: uuid.UUID | None
    showing_id: uuid.UUID | None
    created_at: datetime


class OptimizeOut(BaseModel):
    total_distance_miles: float
    unlocated: int
    stops: list[StopOut]


# ------------------------------------------------------------------ NDAs & deal rooms

class NdaBase(BaseModel):
    counterparty_kind: Literal["person", "organization"] = "person"
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    deal_room_id: uuid.UUID | None = None
    listing_id: uuid.UUID | None = None
    brokerage_deal_id: uuid.UUID | None = None
    status: Literal["not_sent", "sent", "signed", "declined", "expired"] = "not_sent"
    sent_at: datetime | None = None
    signed_at: datetime | None = None
    expires_on: date | None = None
    signer_name: str | None = Field(default=None, max_length=200)
    signer_email: str | None = Field(default=None, max_length=255)
    document_id: uuid.UUID | None = None
    notes: str | None = None


NdaUpdate = partial(NdaBase, "NdaUpdate")


class NdaOut(NdaBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    is_effective: bool = False
    created_at: datetime
    updated_at: datetime


class RoomBase(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    listing_id: uuid.UUID | None = None
    brokerage_deal_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    status: Literal["draft", "open", "closed", "archived"] = "draft"
    requires_nda: bool = True
    allow_offers: bool = True
    offer_deadline: datetime | None = None
    description: str | None = None


class RoomCreate(RoomBase):
    default_folders: bool = True


RoomUpdate = partial(RoomBase, "RoomUpdate")


class RoomOut(RoomBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    opened_at: datetime | None
    closed_at: datetime | None
    property_label: str | None = None
    owner_name: str | None = None
    grant_count: int = 0
    document_count: int = 0
    view_count: int = 0
    offer_count: int = 0
    last_activity_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    sort_order: int = 0
    is_restricted: bool = False
    document_ids: list[uuid.UUID] = []


FolderUpdate = partial(FolderIn, "FolderUpdate")


class DocRef(BaseModel):
    id: uuid.UUID
    title: str | None = None
    filename: str | None = None
    doc_class: str | None = None
    mime_type: str | None = None


class FolderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    room_id: uuid.UUID
    name: str
    sort_order: int
    is_restricted: bool
    document_ids: list[uuid.UUID]
    documents: list[DocRef] = []


class AccessIn(BaseModel):
    grantee_kind: Literal["person", "organization", "user"] = "person"
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    email: str | None = Field(default=None, max_length=255)
    folder_ids: list[uuid.UUID] = []
    can_download: bool = False
    can_submit_offers: bool = True
    expires_at: datetime | None = None
    nda_id: uuid.UUID | None = None


class AccessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    folder_ids: list[uuid.UUID] | None = None
    can_download: bool | None = None
    can_submit_offers: bool | None = None
    expires_at: datetime | None = None
    nda_id: uuid.UUID | None = None


class AccessOut(AccessIn, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    room_id: uuid.UUID
    status: str
    effective_status: str = "active"
    nda_status: str | None = None
    revoked_at: datetime | None
    last_accessed_at: datetime | None
    user_name: str | None = None
    created_at: datetime


class AccessLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    room_id: uuid.UUID
    access_id: uuid.UUID | None
    folder_id: uuid.UUID | None
    document_id: uuid.UUID | None
    document_title: str | None = None
    action: str
    user_id: uuid.UUID | None
    person_id: uuid.UUID | None
    organization_id: uuid.UUID | None
    actor_name: str | None
    is_internal: bool
    detail: str | None
    at: datetime


class AnalyticsOut(BaseModel):
    total_views: int
    total_downloads: int
    denied: int
    unique_viewers: int
    by_viewer: list[dict]
    by_document: list[dict]
    recent: list[AccessLogOut]


class OpenOut(BaseModel):
    document_id: uuid.UUID
    url: str | None
    action: str


class PortalRoomOut(BaseModel):
    room: RoomOut
    access_id: uuid.UUID | None
    can_download: bool
    can_submit_offers: bool
    folders: list[FolderOut]


# ------------------------------------------------------------------ offers

class OfferIn(BaseModel):
    submitter_person_id: uuid.UUID | None = None
    submitter_organization_id: uuid.UUID | None = None
    submitter_name: str | None = Field(default=None, max_length=200)
    submitter_email: str | None = Field(default=None, max_length=255)
    buyer_entity: str | None = Field(default=None, max_length=255)
    price: float = Field(gt=0)
    earnest_money: float | None = Field(default=None, ge=0)
    due_diligence_days: int | None = Field(default=None, ge=0, le=730)
    closing_days: int | None = Field(default=None, ge=0, le=1095)
    financing_type: Literal["cash", "conventional", "sba", "seller_financing", "assumption", "other"] | None = None
    contingencies: list[str] = []
    terms: str | None = None
    expires_at: datetime | None = None
    document_id: uuid.UUID | None = None
    parent_submission_id: uuid.UUID | None = None


class OfferReviewIn(BaseModel):
    status: Literal["under_review", "shortlisted", "countered", "accepted", "rejected", "withdrawn"]
    review_notes: str | None = None


class OfferOut(OfferIn, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    room_id: uuid.UUID | None
    listing_id: uuid.UUID | None
    brokerage_deal_id: uuid.UUID | None
    property_id: uuid.UUID | None
    access_id: uuid.UUID | None
    version: int
    status: str
    submitted_at: datetime
    reviewed_by_id: uuid.UUID | None
    reviewed_at: datetime | None
    reviewer_name: str | None = None


# ------------------------------------------------------------------ compliance

class LicenseBase(BaseModel):
    user_id: uuid.UUID | None = None
    holder_name: str | None = Field(default=None, max_length=200)
    license_type: Literal["salesperson", "broker", "broker_associate", "managing_broker", "firm"] = "salesperson"
    license_number: str = Field(min_length=1, max_length=60)
    state: str = Field(min_length=1, max_length=40)
    issued_on: date | None = None
    expires_on: date | None = None
    status: Literal["active", "pending_renewal", "expired", "suspended", "inactive"] = "active"
    ce_hours_required: float | None = Field(default=None, ge=0)
    ce_hours_completed: float | None = Field(default=None, ge=0)
    sponsoring_broker: str | None = Field(default=None, max_length=200)
    document_id: uuid.UUID | None = None
    notes: str | None = None


LicenseUpdate = partial(LicenseBase, "LicenseUpdate")


class LicenseOut(LicenseBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    holder_name: str
    critical_date_id: uuid.UUID | None
    days_to_expiry: int | None = None
    alert_level: str | None = None
    user_name: str | None = None
    created_at: datetime
    updated_at: datetime


class ScanOut(BaseModel):
    licenses_checked: int
    license_alerts: int
    licenses_expired: int
    disclosure_alerts: int


class DisclosureBase(BaseModel):
    brokerage_deal_id: uuid.UUID | None = None
    listing_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    disclosure_type: Literal["agency", "dual_agency", "intermediary", "seller_property_condition", "lead_paint",
                             "environmental", "material_defect", "affiliated_business", "other"] = "agency"
    title: str | None = Field(default=None, max_length=255)
    recipient_person_id: uuid.UUID | None = None
    recipient_organization_id: uuid.UUID | None = None
    recipient_name: str | None = Field(default=None, max_length=200)
    due_on: date | None = None
    is_blocking: bool = True
    requires_acknowledgement: bool | None = None
    owner_id: uuid.UUID | None = None
    evidence_note: str | None = None


DisclosureUpdate = partial(DisclosureBase, "DisclosureUpdate")


class DeliverIn(BaseModel):
    delivered_at: datetime | None = None
    delivery_method: Literal["email", "in_person", "portal", "mail", "e_sign"]
    evidence_document_id: uuid.UUID | None = None
    evidence_note: str | None = None


class AcknowledgeIn(BaseModel):
    acknowledged_at: datetime | None = None
    acknowledged_by_name: str = Field(min_length=1, max_length=200)
    acknowledgement_document_id: uuid.UUID | None = None


class WaiveIn(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class DisclosureOut(DisclosureBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    title: str
    requires_acknowledgement: bool
    status: str
    delivered_at: datetime | None
    delivery_method: str | None
    evidence_document_id: uuid.UUID | None
    acknowledged_at: datetime | None
    acknowledged_by_name: str | None
    acknowledgement_document_id: uuid.UUID | None
    waived_reason: str | None
    critical_date_id: uuid.UUID | None
    is_overdue: bool = False
    is_satisfied: bool = False
    created_at: datetime


class AdReviewBase(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    listing_id: uuid.UUID | None = None
    marketing_item_id: uuid.UUID | None = None
    brokerage_deal_id: uuid.UUID | None = None
    channel: str | None = Field(default=None, max_length=40)
    content_summary: str | None = None
    document_id: uuid.UUID | None = None


class AdDecisionIn(BaseModel):
    status: Literal["approved", "rejected", "changes_requested"]
    review_notes: str | None = None
    checklist: list[dict[str, Any]] = []


class AdReviewOut(AdReviewBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    submitted_by_id: uuid.UUID | None
    submitted_at: datetime
    status: str
    checklist: list
    reviewer_id: uuid.UUID | None
    reviewed_at: datetime | None
    review_notes: str | None
    submitted_by_name: str | None = None
    reviewer_name: str | None = None
    property_label: str | None = None


class FileItemIn(BaseModel):
    label: str = Field(min_length=1, max_length=255)
    category: Literal["agreement", "disclosure", "contract", "compliance", "closing", "financial", "other"] = "other"
    is_required: bool = True


class FileItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["missing", "provided", "approved", "waived", "rejected"] | None = None
    document_id: uuid.UUID | None = None
    evidence_note: str | None = None
    waived_reason: str | None = None
    is_required: bool | None = None


class FileItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    file_id: uuid.UUID
    key: str
    label: str
    category: str
    is_required: bool
    sort_order: int
    status: str
    document_id: uuid.UUID | None
    evidence_note: str | None
    linked_type: str | None
    linked_id: uuid.UUID | None
    reviewed_by_id: uuid.UUID | None
    reviewed_at: datetime | None
    waived_reason: str | None
    is_satisfied: bool = False
    document_title: str | None = None


class FileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    brokerage_deal_id: uuid.UUID
    template_key: str
    status: str
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    notes: str | None
    deal_title: str | None = None
    deal_stage: str | None = None
    agent_name: str | None = None
    completeness_pct: float = 0
    required_total: int = 0
    required_done: int = 0
    complete: bool = False
    blockers: list[str] = []
    items: list[FileItemOut] = []
    updated_at: datetime


class CompletenessOut(BaseModel):
    brokerage_deal_id: uuid.UUID
    complete: bool
    blockers: list[str]
