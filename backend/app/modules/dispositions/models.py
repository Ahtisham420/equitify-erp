import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

STAGES = ["candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed", "withdrawn"]
PROGRESSION = ["candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed"]
TERMINAL = ["closed", "withdrawn"]
OFFER_STATUSES = ["received", "countered", "best_and_final", "accepted", "backup", "rejected", "withdrawn"]
OFFER_OUTCOMES = ["closed", "fell_through"]
FINANCING_TYPES = ["cash", "new_loan", "assumption", "seller_financing"]
RETRADE_REASONS = ["inspection", "environmental", "title_survey", "financing", "appraisal", "tenant", "market", "other"]
RETRADE_DECISIONS = ["pending", "accepted", "countered", "rejected"]
RETRADE_OUTCOMES = ["pending", "closed", "buyer_walked", "seller_terminated"]
EXCHANGE_TYPES = ["forward", "reverse", "improvement"]
EXCHANGE_STATUSES = ["planned", "open", "identified", "completed", "failed", "cancelled"]
IDENTIFICATION_RULES = ["three_property", "two_hundred_percent", "ninety_five_percent"]
CANDIDATE_STATUSES = ["candidate", "identified", "under_contract", "acquired", "dropped"]


class Disposition(Entity, Base):
    __tablename__ = "dispositions"

    asset_id: Mapped[uuid.UUID] = fk("assets", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    name: Mapped[str] = mapped_column(String(200))
    stage: Mapped[str] = mapped_column(String(20), default="candidate", index=True)
    stage_entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    reason: Mapped[str | None] = mapped_column(Text)
    is_1031: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    target_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    list_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    pricing_notes: Mapped[str | None] = mapped_column(Text)
    broker_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    broker_name: Mapped[str | None] = mapped_column(String(200))
    commission_pct: Mapped[float | None] = mapped_column(Float)
    marketing_launched_on: Mapped[date | None] = mapped_column(Date)
    offers_due_on: Mapped[date | None] = mapped_column(Date)
    accepted_offer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    buyer_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    buyer_name: Mapped[str | None] = mapped_column(String(200))
    contract_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    contract_executed_on: Mapped[date | None] = mapped_column(Date)
    dd_expires_on: Mapped[date | None] = mapped_column(Date)
    target_closing_on: Mapped[date | None] = mapped_column(Date, index=True)
    closed_on: Mapped[date | None] = mapped_column(Date)
    sale_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cost_lines: Mapped[list] = mapped_column(JSONB, default=list)  # [{label, amount}]
    tax_inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    comparison: Mapped[dict] = mapped_column(JSONB, default=dict)
    comparison_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    withdrawn_reason: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class DispositionEvent(UUIDPk, Base):
    __tablename__ = "disposition_events"

    disposition_id: Mapped[uuid.UUID] = fk("dispositions", nullable=False, ondelete="CASCADE")
    from_stage: Mapped[str | None] = mapped_column(String(20))
    to_stage: Mapped[str] = mapped_column(String(20))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    reason: Mapped[str | None] = mapped_column(Text)
    override: Mapped[bool] = mapped_column(Boolean, default=False)
    unmet: Mapped[list] = mapped_column(JSONB, default=list)


class DispositionOffer(Entity, Base):
    __tablename__ = "disposition_offers"

    disposition_id: Mapped[uuid.UUID] = fk("dispositions", nullable=False, ondelete="CASCADE")
    buyer_name: Mapped[str] = mapped_column(String(200), index=True)
    buyer_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    buyer_person_id: Mapped[uuid.UUID | None] = fk("people")
    broker_name: Mapped[str | None] = mapped_column(String(200))
    price: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    earnest_money: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    dd_days: Mapped[int | None] = mapped_column(Integer)
    closing_days: Mapped[int | None] = mapped_column(Integer)
    financing_type: Mapped[str] = mapped_column(String(20), default="cash")
    contingencies: Mapped[str | None] = mapped_column(Text)
    received_on: Mapped[date] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), default="received", index=True)
    outcome: Mapped[str | None] = mapped_column(String(20))
    notes: Mapped[str | None] = mapped_column(Text)


class Retrade(Entity, Base):
    """Buyer retrade request — retained permanently for counterparty intelligence."""

    __tablename__ = "retrades"

    disposition_id: Mapped[uuid.UUID] = fk("dispositions", nullable=False, ondelete="CASCADE")
    offer_id: Mapped[uuid.UUID | None] = fk("disposition_offers")
    buyer_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    buyer_name: Mapped[str] = mapped_column(String(200), index=True)
    requested_on: Mapped[date] = mapped_column(Date)
    reason_category: Mapped[str] = mapped_column(String(20), default="other")
    reason: Mapped[str] = mapped_column(Text)
    amount_requested: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    decision: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    agreed_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    decided_on: Mapped[date | None] = mapped_column(Date)
    decided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    outcome: Mapped[str] = mapped_column(String(20), default="pending")
    notes: Mapped[str | None] = mapped_column(Text)


class Exchange1031(Entity, Base):
    __tablename__ = "exchanges_1031"
    __table_args__ = (UniqueConstraint("disposition_id", name="uq_exchanges_1031_disposition"),)

    disposition_id: Mapped[uuid.UUID] = fk("dispositions", nullable=False, ondelete="CASCADE")
    exchange_type: Mapped[str] = mapped_column(String(20), default="forward")
    status: Mapped[str] = mapped_column(String(20), default="planned", index=True)
    qi_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    qi_name: Mapped[str | None] = mapped_column(String(200))
    eat_organization_id: Mapped[uuid.UUID | None] = fk("organizations")  # reverse/improvement titleholder
    parked_property_id: Mapped[uuid.UUID | None] = fk("properties")
    start_on: Mapped[date | None] = mapped_column(Date)  # relinquished closing (forward) or parking date (reverse)
    identification_deadline: Mapped[date | None] = mapped_column(Date, index=True)
    replacement_deadline: Mapped[date | None] = mapped_column(Date, index=True)
    tax_return_due_on: Mapped[date | None] = mapped_column(Date)
    identification_rule: Mapped[str] = mapped_column(String(30), default="three_property")
    relinquished_sale_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    relinquished_costs: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    relinquished_debt_paid: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    relinquished_adjusted_basis: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cash_received: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    additional_cash_invested: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    improvement_budget: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    improvement_notes: Mapped[str | None] = mapped_column(Text)
    id_critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    replacement_critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class ExchangeCandidate(Entity, Base):
    __tablename__ = "exchange_candidates"

    exchange_id: Mapped[uuid.UUID] = fk("exchanges_1031", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    description: Mapped[str | None] = mapped_column(String(300))
    is_backup: Mapped[bool] = mapped_column(Boolean, default=False)
    rank: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(20), default="candidate", index=True)
    identified_on: Mapped[date | None] = mapped_column(Date)
    expected_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    expected_debt: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    acquired_on: Mapped[date | None] = mapped_column(Date)
    acquired_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    acquired_debt: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    notes: Mapped[str | None] = mapped_column(Text)
