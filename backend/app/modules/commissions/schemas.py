import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Side = Literal["listing", "buyer", "tenant", "landlord", "dual", "other"]


class Participant(BaseModel):
    agent_id: uuid.UUID
    share_pct: float = Field(default=100, gt=0, le=100)
    override_agent_pct: float | None = Field(default=None, ge=0, le=100)  # per-deal override of the plan


class Deduction(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    amount: float = Field(ge=0)
    agent_id: uuid.UUID | None = None  # None → charged to the primary agent


class CommissionCreate(BaseModel):
    brokerage_deal_id: uuid.UUID | None = None
    title: str | None = Field(default=None, max_length=255)
    agent_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    property_type: str | None = None
    source: str | None = None
    side: Side | None = None
    deal_volume: float | None = Field(default=None, ge=0)
    gross: float = Field(ge=0)
    probability: float | None = Field(default=None, ge=0, le=100)
    expected_close_on: date | None = None
    expected_on: date | None = None
    split_plan_id: uuid.UUID | None = None
    participants: list[Participant] = []
    referral_party: str | None = Field(default=None, max_length=200)
    referral_pct: float | None = Field(default=None, ge=0, le=100)
    referral_amount: float | None = Field(default=None, ge=0)
    deductions: list[Deduction] = []
    notes: str | None = None


class CommissionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=255)
    agent_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    property_type: str | None = None
    source: str | None = None
    side: Side | None = None
    deal_volume: float | None = Field(default=None, ge=0)
    gross: float | None = Field(default=None, ge=0)
    probability: float | None = Field(default=None, ge=0, le=100)
    expected_close_on: date | None = None
    expected_on: date | None = None
    split_plan_id: uuid.UUID | None = None
    participants: list[Participant] | None = None
    referral_party: str | None = None
    referral_pct: float | None = Field(default=None, ge=0, le=100)
    referral_amount: float | None = Field(default=None, ge=0)
    deductions: list[Deduction] | None = None
    notes: str | None = None


class SplitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    agent_id: uuid.UUID | None
    agent_name: str | None = None
    role: str
    label: str | None
    share_pct: float | None
    gci_amount: float
    agent_pct: float | None
    amount: float
    deductions: float
    net_amount: float
    ytd_gci_before: float | None
    capped: bool
    detail: dict


class CommissionListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    brokerage_deal_id: uuid.UUID | None
    title: str
    agent_id: uuid.UUID | None
    agent_name: str | None = None
    team_id: uuid.UUID | None
    property_type: str | None
    source: str | None
    side: str | None
    deal_volume: float | None
    gross: float
    status: str
    probability: float | None
    expected_close_on: date | None
    expected_on: date | None
    earned_on: date | None
    paid_on: date | None
    paid_total: float
    discrepancy: float
    reconciliation_status: str
    approved_at: datetime | None
    my_net: float | None = None
    house_amount: float | None = None
    updated_at: datetime


class InvoiceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    commission_id: uuid.UUID
    commission_title: str | None = None
    invoice_number: str
    bill_to: str
    issued_on: date
    due_on: date
    amount: float
    status: str
    rendered_text: str
    void_reason: str | None
    created_at: datetime


class PaymentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    commission_id: uuid.UUID
    invoice_id: uuid.UUID | None
    amount: float
    received_on: date
    reference: str | None
    method: str | None
    note: str | None
    created_at: datetime


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    action: str
    from_status: str | None
    to_status: str | None
    at: datetime
    actor_name: str | None
    note: str | None


class CommissionOut(CommissionListItem):
    property_id: uuid.UUID | None
    split_plan_id: uuid.UUID | None
    participants: list
    referral_party: str | None
    referral_pct: float | None
    referral_amount: float | None
    deductions: list
    agent_net_total: float | None = None
    calc: dict = {}
    approved_by_id: uuid.UUID | None
    released_at: datetime | None
    release_note: str | None
    notes: str | None
    created_at: datetime
    splits: list[SplitOut] = []
    invoices: list[InvoiceOut] = []
    payments: list[PaymentOut] = []
    deal: dict | None = None
    compliance: dict = {}
    restricted: bool = False


class CommissionFacets(BaseModel):
    status: dict[str, int]
    side: dict[str, int]
    property_type: dict[str, int]
    reconciliation_status: dict[str, int]


class EarnIn(BaseModel):
    earned_on: date | None = None
    note: str | None = None


class NoteIn(BaseModel):
    note: str | None = None


class CancelIn(BaseModel):
    reason: str = Field(min_length=3)


class InvoiceCreate(BaseModel):
    bill_to: str = Field(min_length=1, max_length=300)
    issued_on: date | None = None
    due_on: date | None = None
    amount: float | None = Field(default=None, gt=0)
    memo: str | None = None


class VoidIn(BaseModel):
    reason: str = Field(min_length=3)


class PaymentCreate(BaseModel):
    amount: float = Field(gt=0)
    received_on: date
    invoice_id: uuid.UUID | None = None
    reference: str | None = Field(default=None, max_length=120)
    method: str | None = Field(default=None, max_length=40)
    note: str | None = None


class ReleaseIn(BaseModel):
    accept_discrepancy: bool = False
    note: str | None = None


class PlanTier(BaseModel):
    min_ytd_gci: float = Field(ge=0)
    agent_pct: float = Field(ge=0, le=100)


class PlanIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    tiers: list[PlanTier] = Field(min_length=1, max_length=20)
    annual_cap: float | None = Field(default=None, ge=0)
    is_default: bool = False
    is_active: bool = True


class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    tiers: list
    annual_cap: float | None
    is_default: bool
    is_active: bool
    agent_count: int = 0
    updated_at: datetime


class AgentPlanIn(BaseModel):
    plan_id: uuid.UUID | None  # None removes the assignment (agent falls back to the default plan)
    effective_from: date | None = None


class AgentPlanOut(BaseModel):
    agent_id: uuid.UUID
    agent_name: str | None
    team_id: uuid.UUID | None
    plan_id: uuid.UUID | None
    plan_name: str | None
    effective_from: date | None
    ytd_gci: float
    ytd_house: float


class SyncOut(BaseModel):
    available: bool
    created: int = 0
    updated: int = 0
    earned: int = 0
    cancelled: int = 0
    message: str | None = None


class DealOption(BaseModel):
    id: uuid.UUID
    label: str
    stage: str | None = None
    agent_id: uuid.UUID | None = None
    expected_close_on: date | None = None
    probability: float | None = None
    gross_commission_estimate: float | None = None
    has_commission: bool = False
