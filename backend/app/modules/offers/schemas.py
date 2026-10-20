import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Structure = Literal["all_cash", "conventional_financing", "assumption", "seller_financing", "joint_venture", "other"]
Outcome = Literal["accepted", "countered", "rejected", "expired", "withdrawn"]


class OfferTerms(BaseModel):
    """Every negotiable term; all optional so the same schema serves partial updates and counter overrides."""

    model_config = ConfigDict(extra="forbid")

    price: float | None = Field(default=None, gt=0)
    structure: Structure | None = None
    earnest_money: float | None = Field(default=None, ge=0)
    earnest_money_hard_days: int | None = Field(default=None, ge=0, le=3650)
    feasibility_days: int | None = Field(default=None, ge=0, le=3650)
    closing_days: int | None = Field(default=None, ge=0, le=3650)
    extension_count: int | None = Field(default=None, ge=0, le=20)
    extension_days: int | None = Field(default=None, ge=0, le=3650)
    extension_cost: float | None = Field(default=None, ge=0)
    financing_contingency: bool | None = None
    financing_days: int | None = Field(default=None, ge=0, le=3650)
    title_survey_days: int | None = Field(default=None, ge=0, le=3650)
    title_survey_terms: str | None = None
    assignment_allowed: bool | None = None
    assignment_terms: str | None = None
    access_terms: str | None = None
    exclusivity_days: int | None = Field(default=None, ge=0, le=3650)
    expiration_at: datetime | None = None
    buyer_entity: str | None = Field(default=None, max_length=200)
    seller_name: str | None = Field(default=None, max_length=200)
    other_terms: str | None = None
    notes: str | None = None
    tags: list[str] | None = None


class OfferCreate(OfferTerms):
    opportunity_id: uuid.UUID
    uw_model_id: uuid.UUID
    price: float = Field(gt=0)


class CounterIn(OfferTerms):
    """Create the next version. origin=seller records the counterparty's counter to our sent version verbatim;
    origin=buyer starts our next draft from the latest version."""

    origin: Literal["buyer", "seller"] = "buyer"
    uw_model_id: uuid.UUID | None = None
    response_note: str | None = None
    responded_at: datetime | None = None


class ApprovalIn(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str | None = Field(default=None, max_length=4000)


class SendIn(BaseModel):
    sent_to: str | None = Field(default=None, max_length=300)
    sent_via: str | None = Field(default=None, max_length=60)
    response_due_at: datetime | None = None
    note: str | None = None


class RespondIn(BaseModel):
    outcome: Outcome
    note: str | None = Field(default=None, max_length=4000)
    responded_at: datetime | None = None
    # When countered: the counterparty's terms (merged over this version's terms).
    counter_terms: OfferTerms | None = None
    # When lost (rejected / expired / withdrawn) and discoverable.
    winning_price: float | None = Field(default=None, gt=0)
    winning_buyer: str | None = Field(default=None, max_length=200)
    winning_price_source: str | None = Field(default=None, max_length=200)


class WinningPriceIn(BaseModel):
    winning_price: float = Field(gt=0)
    winning_buyer: str | None = Field(default=None, max_length=200)
    winning_price_source: str = Field(min_length=1, max_length=200)


class OfferSettingsIn(BaseModel):
    price_threshold: float | None = Field(default=None, ge=0)
    deviation_threshold_pct: float = Field(ge=0, le=100)
    second_approval_deviation_pct: float = Field(ge=0, le=100)
    approval_structures: list[Structure] = []
    max_feasibility_days: int | None = Field(default=None, ge=0)
    max_earnest_money_pct: float | None = Field(default=None, ge=0, le=100)
    require_approval_always: bool = False
    default_response_days: int = Field(ge=1, le=60)


class OfferSettingsOut(OfferSettingsIn):
    model_config = ConfigDict(from_attributes=True)

    approval_structures: list[str] = []
    updated_at: datetime | None = None
    updated_by_id: uuid.UUID | None = None


class OfferListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    opportunity_id: uuid.UUID
    opportunity_title: str | None = None
    owner_id: uuid.UUID | None = None
    owner_name: str | None = None
    property_id: uuid.UUID | None
    property_label: str | None = None
    uw_model_id: uuid.UUID
    uw_model_version: int | None
    root_offer_id: uuid.UUID | None
    parent_offer_id: uuid.UUID | None
    version: int
    is_latest: bool
    origin: str
    status: str
    price: float
    structure: str
    model_price: float | None
    deviation_pct: float | None
    earnest_money: float | None
    feasibility_days: int | None
    closing_days: int | None
    approval_required: bool
    sent_at: datetime | None
    response_due_at: datetime | None
    hours_to_due: float | None = None
    overdue: bool = False
    winning_price: float | None
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class OfferOut(OfferListItem):
    model_outputs: dict
    earnest_money_hard_days: int | None
    extension_count: int | None
    extension_days: int | None
    extension_cost: float | None
    financing_contingency: bool
    financing_days: int | None
    title_survey_days: int | None
    title_survey_terms: str | None
    assignment_allowed: bool
    assignment_terms: str | None
    access_terms: str | None
    exclusivity_days: int | None
    expiration_at: datetime | None
    buyer_entity: str | None
    seller_name: str | None
    other_terms: str | None
    notes: str | None
    approvals_required: int
    approval_reasons: list
    submission_no: int
    submitted_at: datetime | None
    submitted_by_id: uuid.UUID | None
    approved_at: datetime | None
    approvals_received: int = 0
    sent_by_id: uuid.UUID | None
    sent_to: str | None
    sent_via: str | None
    critical_date_id: uuid.UUID | None
    follow_up_task_id: uuid.UUID | None
    escalation_task_id: uuid.UUID | None
    responded_at: datetime | None
    response_note: str | None
    expired_at: datetime | None
    winning_buyer: str | None
    winning_price_source: str | None
    winning_price_recorded_at: datetime | None
    has_loi: bool = False
    can_edit: bool = False
    can_approve: bool = False
    created_by_id: uuid.UUID | None


class ApprovalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    offer_id: uuid.UUID
    submission_no: int
    decision: str
    approver_id: uuid.UUID | None
    approver_name: str | None
    decided_at: datetime
    note: str | None
    price: float | None
    deviation_pct: float | None
    reasons: list


class TermDelta(BaseModel):
    field: str
    label: str
    from_value: Any = None
    to_value: Any = None
    change: float | None = None
    change_pct: float | None = None


class DeltaOut(BaseModel):
    from_offer_id: uuid.UUID
    from_version: int
    to_offer_id: uuid.UUID
    to_version: int
    changes: list[TermDelta]
    unchanged: list[str]


class OfferFacets(BaseModel):
    status: dict[str, int]
    origin: dict[str, int]
    due: dict[str, int]


class ApprovedModelOut(BaseModel):
    id: uuid.UUID
    name: str | None = None
    version: int | None = None
    property_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    approved_at: datetime | None = None
    purchase_price: float | None = None
    going_in_cap: float | None = None
    irr: float | None = None


class ExpireScanOut(BaseModel):
    expired: int
    offer_ids: list[uuid.UUID]
