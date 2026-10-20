import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import Select, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.receivables.models import (
    Charge,
    CollectionStatus,
    DelinquencyNotice,
    Payment,
    PaymentApplication,
    PaymentPlan,
    PaymentPlanInstallment,
    ReceivablesSetting,
    SyncBatch,
    SyncConflict,
)
from app.modules.receivables.schemas import (
    ApplyIn,
    Buckets,
    ChargeOut,
    Dashboard,
    DashboardRow,
    EvaluateIn,
    EvaluateOut,
    ExportIn,
    GenerateIn,
    GenerateOut,
    ImportIn,
    LadderStep,
    LateFeeDefaults,
    LedgerEntry,
    LedgerOut,
    ManualChargeIn,
    PaymentIn,
    PlanIn,
    ReconBillIn,
    ReconBillOut,
    ResolveIn,
    SettingsIn,
    SettingsOut,
    TenantBalance,
    UnapplyIn,
)

ENTITY = "receivables"
OPEN_STATUSES = ["open", "partial", "credit"]
CENT = 0.005

DEFAULT_LADDER: list[dict] = [
    {"key": "reminder", "label": "Payment reminder", "days_past_due": 5, "min_balance": 0, "create_task": False,
     "task_priority": "normal", "collection_status": "delinquent",
     "subject": "Payment reminder: {property_name}",
     "body": "Dear {tenant_name},\n\nOur records show a past-due balance of {balance} as of {as_of} "
             "({days_past_due} days past due). Please remit payment at your earliest convenience.\n\nThank you."},
    {"key": "notice", "label": "Past-due notice", "days_past_due": 15, "min_balance": 0, "create_task": True,
     "task_priority": "normal", "collection_status": "delinquent",
     "subject": "Past-due notice: {property_name}",
     "body": "Dear {tenant_name},\n\nYour account is {days_past_due} days past due with a balance of {balance} "
             "as of {as_of}. Late fees may apply under your lease. Please pay by {cure_by}."},
    {"key": "default_notice", "label": "Notice of default", "days_past_due": 30, "min_balance": 0, "create_task": True,
     "task_priority": "high", "collection_status": "delinquent",
     "subject": "Notice of default: {property_name}",
     "body": "Dear {tenant_name},\n\nYou are in default of your lease for failure to pay {balance}, now "
             "{days_past_due} days past due as of {as_of}. If the default is not cured by {cure_by}, the landlord "
             "may exercise its remedies under the lease."},
    {"key": "legal", "label": "Refer to legal", "days_past_due": 60, "min_balance": 0, "create_task": True,
     "task_priority": "urgent", "collection_status": "legal",
     "subject": "Referral to counsel: {tenant_name}",
     "body": "{tenant_name} at {property_name} owes {balance}, {days_past_due} days past due as of {as_of}. "
             "Refer to counsel for collection / default remedies."},
]
DEFAULT_ALERT_DAYS = 90


# --------------------------------------------------------------------------- helpers

def _round(v: float) -> float:
    return round(float(v or 0) + 0, 2)


def charge_status(c: Charge) -> str:
    if c.voided_at:
        return "void"
    if c.status == "pending_approval":
        return "pending_approval"
    amount, paid = float(c.amount), float(c.amount_paid or 0)
    if amount < 0:
        return "credit"
    if paid >= amount - CENT:
        return "paid"
    return "partial" if paid > CENT else "open"


def charge_balance(c: Charge) -> float:
    if c.status in ("void", "pending_approval"):
        return 0.0
    return _round(float(c.amount) - float(c.amount_paid or 0))


def charge_out(c: Charge, as_of: date | None = None) -> ChargeOut:
    as_of = as_of or date.today()
    out = ChargeOut.model_validate(c)
    out.balance = charge_balance(c)
    out.days_past_due = max(0, (as_of - c.due_on).days) if out.balance > CENT else 0
    return out


def bucket_of(due_on: date, as_of: date) -> str:
    days = (as_of - due_on).days
    if days <= 0:
        return "current"
    if days <= 30:
        return "d1_30"
    if days <= 60:
        return "d31_60"
    if days <= 90:
        return "d61_90"
    return "d90_plus"


def bucket_columns(as_of: date):
    bal = Charge.amount - Charge.amount_paid
    c30, c60, c90 = as_of - timedelta(days=30), as_of - timedelta(days=60), as_of - timedelta(days=90)
    return [
        func.coalesce(func.sum(case((Charge.due_on >= as_of, bal), else_=0)), 0).label("current"),
        func.coalesce(func.sum(case(((Charge.due_on < as_of) & (Charge.due_on >= c30), bal), else_=0)), 0).label("d1_30"),
        func.coalesce(func.sum(case(((Charge.due_on < c30) & (Charge.due_on >= c60), bal), else_=0)), 0).label("d31_60"),
        func.coalesce(func.sum(case(((Charge.due_on < c60) & (Charge.due_on >= c90), bal), else_=0)), 0).label("d61_90"),
        func.coalesce(func.sum(case((Charge.due_on < c90, bal), else_=0)), 0).label("d90_plus"),
        func.coalesce(func.sum(bal), 0).label("total"),
    ]


def _buckets(row) -> Buckets:
    return Buckets(current=_round(row.current), d1_30=_round(row.d1_30), d31_60=_round(row.d31_60),
                   d61_90=_round(row.d61_90), d90_plus=_round(row.d90_plus), total=_round(row.total))


def _open_charge_filter():
    return [Charge.deleted_at.is_(None), Charge.status.in_(OPEN_STATUSES)]


async def get_lease(db: AsyncSession, lease_id: uuid.UUID):
    from app.modules.leases.models import Lease

    lease = await db.get(Lease, lease_id)
    if not lease or lease.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lease not found")
    return lease


async def get_row(db: AsyncSession, model, row_id: uuid.UUID, label: str):
    row = await db.get(model, row_id)
    if not row or getattr(row, "deleted_at", None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    return row


async def _property_name(db: AsyncSession, property_id: uuid.UUID) -> str | None:
    from app.modules.properties.models import Property

    p = await db.get(Property, property_id)
    return (p.name or p.address_line) if p else None


# --------------------------------------------------------------------------- settings

async def _setting(db: AsyncSession, key: str):
    return await db.scalar(select(ReceivablesSetting).where(ReceivablesSetting.key == key))


async def get_settings(db: AsyncSession) -> SettingsOut:
    fees = await _setting(db, "late_fee_defaults")
    ladder = await _setting(db, "escalation_ladder")
    alert = await _setting(db, "alert_days")
    return SettingsOut(
        late_fee_defaults=LateFeeDefaults(**(fees.value if fees else {})),
        ladder=[LadderStep(**s) for s in (ladder.value if ladder else DEFAULT_LADDER)],
        alert_days=int(alert.value.get("days", DEFAULT_ALERT_DAYS)) if alert else DEFAULT_ALERT_DAYS,
    )


async def save_settings(db: AsyncSession, data: SettingsIn, actor: CurrentUser) -> SettingsOut:
    updates: dict = {}
    if data.late_fee_defaults is not None:
        updates["late_fee_defaults"] = data.late_fee_defaults.model_dump()
    if data.ladder is not None:
        keys = [s.key for s in data.ladder]
        if len(set(keys)) != len(keys):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ladder step keys must be unique")
        updates["escalation_ladder"] = [s.model_dump() for s in sorted(data.ladder, key=lambda s: s.days_past_due)]
    if data.alert_days is not None:
        updates["alert_days"] = {"days": data.alert_days}
    changes = {}
    for key, value in updates.items():
        row = await _setting(db, key)
        if row:
            if row.value != value:
                changes[key] = {"from": row.value, "to": value}
                row.value = value
                row.updated_by_id = actor.id
        else:
            db.add(ReceivablesSetting(key=key, value=value, created_by_id=actor.id, updated_by_id=actor.id))
            changes[key] = {"from": None, "to": value}
    if changes:
        await audit.record(db, actor=actor, action="receivables.settings_updated", entity_type=ENTITY,
                           changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return await get_settings(db)


# --------------------------------------------------------------------------- charges

@dataclass
class ChargeFilters:
    q: str | None = None
    lease_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    charge_type: list[str] | None = None
    status: list[str] | None = None
    source: list[str] | None = None
    period: str | None = None
    due_from: date | None = None
    due_to: date | None = None
    overdue: bool | None = None


def build_charge_query(f: ChargeFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Charge).where(Charge.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Charge.tenant_name, Charge.description, Charge.external_ref])
    if f.lease_id:
        stmt = stmt.where(Charge.lease_id == f.lease_id)
    if f.property_id:
        stmt = stmt.where(Charge.property_id == f.property_id)
    if f.asset_id:
        stmt = stmt.where(Charge.asset_id == f.asset_id)
    if "charge_type" not in skip:
        stmt = in_filter(stmt, Charge.charge_type, f.charge_type)
    if "status" not in skip:
        stmt = in_filter(stmt, Charge.status, f.status)
    if "source" not in skip:
        stmt = in_filter(stmt, Charge.source, f.source)
    if f.period:
        y, m = (int(x) for x in f.period.split("-"))
        start = date(y, m, 1)
        end = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
        stmt = stmt.where(or_(Charge.period_start.between(start, end),
                              Charge.period_start.is_(None) & Charge.due_on.between(start, end)))
    if f.due_from:
        stmt = stmt.where(Charge.due_on >= f.due_from)
    if f.due_to:
        stmt = stmt.where(Charge.due_on <= f.due_to)
    if f.overdue:
        stmt = stmt.where(Charge.status.in_(["open", "partial"]), Charge.due_on < date.today())
    return stmt


def _new_charge(lease, *, charge_type: str, amount: float, due_on: date, source: str, source_ref: dict,
                actor: CurrentUser, description: str | None = None, period_start: date | None = None,
                period_end: date | None = None, idempotency_key: str | None = None,
                status_: str | None = None) -> Charge:
    c = Charge(
        lease_id=lease.id, property_id=lease.property_id, asset_id=lease.asset_id, tenant_name=lease.tenant_name,
        charge_type=charge_type, amount=_round(amount), amount_paid=0, due_on=due_on, period_start=period_start,
        period_end=period_end, source=source, source_ref=audit.to_jsonable(source_ref), description=description,
        idempotency_key=idempotency_key, created_by_id=actor.id, updated_by_id=actor.id,
        status=status_ or ("credit" if amount < 0 else "open"),
    )
    return c


async def generate_charges(db: AsyncSession, data: GenerateIn, actor: CurrentUser) -> GenerateOut:
    """Recurring charges for a month from VERIFIED lease schedules. Idempotent per lease+period+charge type."""
    from app.modules.leases.models import Lease
    from app.modules.leases.service import rent_schedule

    y, m = (int(x) for x in data.period.split("-"))
    if not 1 <= m <= 12:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid period")
    p0 = date(y, m, 1)
    p1 = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
    stmt = select(Lease).where(Lease.deleted_at.is_(None), Lease.status == "active")
    if data.property_id:
        stmt = stmt.where(Lease.property_id == data.property_id)
    if data.lease_ids:
        stmt = stmt.where(Lease.id.in_(data.lease_ids))
    created = existing = unverified = n_leases = 0
    total = 0.0
    for lease in await db.scalars(stmt):
        n_leases += 1
        if not lease.verified:
            unverified += 1
            continue
        grouped: dict[tuple, dict] = {}
        for r in await rent_schedule(db, lease.id, verified_only=True):
            if not (p0 <= r["period_start"] <= p1):
                continue
            g = grouped.setdefault((r["period_start"], r["charge_type"]), {
                "period_start": r["period_start"], "period_end": r["period_end"], "charge_type": r["charge_type"],
                "amount": 0.0, "refs": []})
            g["amount"] += r["amount"]
            g["period_end"] = max(g["period_end"], r["period_end"])
            g["refs"].append(r["source_ref"])
        for r in grouped.values():
            r["source_ref"] = r["refs"][0] if len(r["refs"]) == 1 else {"components": r["refs"]}
            key = f"sched:{lease.id}:{r['period_start'].isoformat()}:{r['charge_type']}"
            if await db.scalar(select(Charge.id).where(Charge.idempotency_key == key)):
                existing += 1
                continue
            label = r["charge_type"].replace("_", " ").capitalize()
            db.add(_new_charge(
                lease, charge_type=r["charge_type"], amount=r["amount"], due_on=r["period_start"], source="schedule",
                source_ref={**r["source_ref"], "lease_id": lease.id, "period": data.period, "verified_terms": True},
                description=f"{label} {r['period_start']:%b %Y}", period_start=r["period_start"],
                period_end=r["period_end"], idempotency_key=key, actor=actor,
            ))
            created += 1
            total += r["amount"]
    await audit.record(db, actor=actor, action="receivables.charges_generated", entity_type=ENTITY,
                       summary=f"{data.period}: {created} charges", ip_address=actor.ip_address,
                       changes={"period": data.period, "created": created, "existing": existing,
                                "skipped_unverified": unverified, "property_id": data.property_id})
    await events.emit(db, "receivables.charges_generated", period=data.period, created=created, actor=actor)
    await db.commit()
    return GenerateOut(period=data.period, created=created, existing=existing, skipped_unverified=unverified,
                       leases=n_leases, amount=_round(total))


async def create_manual_charge(db: AsyncSession, data: ManualChargeIn, actor: CurrentUser) -> Charge:
    lease = await get_lease(db, data.lease_id)
    approved = actor.can("receivables", "approve")
    c = _new_charge(lease, charge_type=data.charge_type, amount=data.amount, due_on=data.due_on, source="manual",
                    source_ref={"entered_by_id": actor.id, "entered_by": actor.full_name},
                    description=data.description, period_start=data.period_start, period_end=data.period_end,
                    actor=actor, status_=None if approved else "pending_approval")
    if approved:
        c.approved_by_id = actor.id
        c.approved_at = utcnow()
    db.add(c)
    await db.flush()
    await audit.record(db, actor=actor, action="charge.created_manual", entity_type="charge", entity_id=c.id,
                       summary=f"{lease.tenant_name}: {data.description} {data.amount:,.2f}",
                       changes={"lease_id": lease.id, "amount": c.amount, "approved": approved},
                       ip_address=actor.ip_address)
    await db.commit()
    return c


async def create_charge(db: AsyncSession, *, lease_id: uuid.UUID, amount: float, charge_type: str, description: str,
                        due_on: date, source_type: str, source_id: uuid.UUID, actor: CurrentUser) -> Charge:
    """Public contract: a charge raised by another module (e.g. maintenance chargeback). Idempotent per source.
    Follows the manual-charge approval rule. Does not commit."""
    key = f"{source_type}:{source_id}:{charge_type}"
    existing = await db.scalar(select(Charge).where(Charge.idempotency_key == key))
    if existing:
        return existing
    lease = await get_lease(db, lease_id)
    approved = actor.can("receivables", "approve")
    c = _new_charge(lease, charge_type=charge_type, amount=amount, due_on=due_on, source="manual",
                    source_ref={"source_type": source_type, "source_id": source_id, "entered_by_id": actor.id},
                    description=description[:300], idempotency_key=key, actor=actor,
                    status_=None if approved else "pending_approval")
    if approved:
        c.approved_by_id, c.approved_at = actor.id, utcnow()
    db.add(c)
    await db.flush()
    await audit.record(db, actor=actor, action="charge.created_manual", entity_type="charge", entity_id=c.id,
                       summary=f"{lease.tenant_name}: {description} {c.amount:,.2f}",
                       changes={"lease_id": lease.id, "amount": c.amount, "source_type": source_type,
                                "source_id": source_id, "approved": approved}, ip_address=actor.ip_address)
    return c


async def approve_charge(db: AsyncSession, c: Charge, actor: CurrentUser) -> Charge:
    if c.status != "pending_approval":
        raise HTTPException(status.HTTP_409_CONFLICT, "Charge is not awaiting approval")
    if c.created_by_id == actor.id and not actor.is_admin:
        raise HTTPException(status.HTTP_409_CONFLICT, "A manual charge must be approved by someone other than its author")
    c.status = "open"
    c.status = charge_status(c)
    c.approved_by_id = actor.id
    c.approved_at = utcnow()
    c.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="charge.approved", entity_type="charge", entity_id=c.id,
                       summary=f"{c.tenant_name}: {c.amount:,.2f}", ip_address=actor.ip_address)
    await db.commit()
    return c


async def void_charge(db: AsyncSession, c: Charge, reason: str, actor: CurrentUser) -> Charge:
    if c.voided_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Charge is already void")
    if float(c.amount_paid or 0) > CENT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Unapply payments from this charge before voiding it")
    prev = c.status
    c.voided_at = utcnow()
    c.voided_by_id = actor.id
    c.void_reason = reason
    c.status = "void"
    c.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="charge.voided", entity_type="charge", entity_id=c.id,
                       summary=reason, changes={"status": {"from": prev, "to": "void"}}, ip_address=actor.ip_address)
    await db.commit()
    return c


# --------------------------------------------------------------------------- payments & application

async def payment_out(db: AsyncSession, p: Payment):
    from app.modules.receivables.schemas import ApplicationOut, PaymentOut

    out = PaymentOut.model_validate(p)
    apps = await db.scalars(select(PaymentApplication).where(PaymentApplication.payment_id == p.id)
                            .order_by(PaymentApplication.created_at))
    out.applications = [ApplicationOut.model_validate(a) for a in apps]
    return out


async def _apply(db: AsyncSession, p: Payment, c: Charge, amount: float, method: str, actor: CurrentUser) -> None:
    if c.lease_id != p.lease_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Charge belongs to another lease")
    if c.status not in ("open", "partial"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Charge is {c.status} and cannot take payment")
    amount = _round(amount)
    if amount > float(p.unapplied_amount) + CENT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Allocation exceeds the payment's unapplied cash")
    if amount > charge_balance(c) + CENT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Allocation exceeds the charge balance")
    db.add(PaymentApplication(payment_id=p.id, charge_id=c.id, amount=amount, applied_on=date.today(), method=method,
                              created_by_id=actor.id, updated_by_id=actor.id))
    c.amount_paid = _round(float(c.amount_paid or 0) + amount)
    c.status = charge_status(c)
    c.updated_by_id = actor.id
    p.unapplied_amount = _round(float(p.unapplied_amount) - amount)
    p.updated_by_id = actor.id


async def _auto_apply(db: AsyncSession, p: Payment, actor: CurrentUser) -> float:
    """Oldest-first: charges by due date, then creation."""
    applied = 0.0
    rows = await db.scalars(select(Charge).where(
        Charge.lease_id == p.lease_id, Charge.deleted_at.is_(None), Charge.status.in_(["open", "partial"]),
        Charge.amount > 0).order_by(Charge.due_on, Charge.created_at))
    for c in rows:
        remaining = float(p.unapplied_amount)
        if remaining <= CENT:
            break
        amt = min(remaining, charge_balance(c))
        if amt > CENT:
            await _apply(db, p, c, amt, "auto", actor)
            applied += amt
    return _round(applied)


async def _apply_allocations(db: AsyncSession, p: Payment, allocations, actor: CurrentUser) -> float:
    applied = 0.0
    for a in allocations:
        c = await get_row(db, Charge, a.charge_id, "Charge")
        await _apply(db, p, c, a.amount, "manual", actor)
        applied += a.amount
    return _round(applied)


async def record_payment(db: AsyncSession, data: PaymentIn, actor: CurrentUser) -> Payment:
    lease = await get_lease(db, data.lease_id)
    p = Payment(lease_id=lease.id, property_id=lease.property_id, tenant_name=lease.tenant_name,
                received_on=data.received_on, amount=_round(data.amount), unapplied_amount=_round(data.amount),
                method=data.method, reference=data.reference, notes=data.notes, status="received",
                created_by_id=actor.id, updated_by_id=actor.id)
    db.add(p)
    await db.flush()
    if data.allocations:
        applied = await _apply_allocations(db, p, data.allocations, actor)
    elif data.auto_apply:
        applied = await _auto_apply(db, p, actor)
    else:
        applied = 0.0
    await audit.record(db, actor=actor, action="payment.received", entity_type="payment", entity_id=p.id,
                       summary=f"{lease.tenant_name}: {p.amount:,.2f} ({p.method})",
                       changes={"lease_id": lease.id, "amount": p.amount, "applied": applied,
                                "unapplied": p.unapplied_amount, "reference": p.reference},
                       ip_address=actor.ip_address)
    await _refresh_collection(db, lease, date.today())
    await events.emit(db, "receivables.payment_received", payment_id=p.id, lease_id=lease.id, amount=p.amount,
                      actor=actor)
    await db.commit()
    return p


async def apply_payment(db: AsyncSession, p: Payment, data: ApplyIn, actor: CurrentUser) -> Payment:
    if p.status != "received":
        raise HTTPException(status.HTTP_409_CONFLICT, "Reversed payments cannot be applied")
    if float(p.unapplied_amount) <= CENT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Payment is fully applied")
    applied = await (_apply_allocations(db, p, data.allocations, actor) if data.allocations else _auto_apply(db, p, actor))
    await audit.record(db, actor=actor, action="payment.applied", entity_type="payment", entity_id=p.id,
                       changes={"applied": applied, "mode": "manual" if data.allocations else "oldest_first",
                                "unapplied": p.unapplied_amount}, ip_address=actor.ip_address)
    await _refresh_collection(db, await get_lease(db, p.lease_id), date.today())
    await db.commit()
    return p


async def _unapply(db: AsyncSession, p: Payment, app: PaymentApplication, reason: str, actor: CurrentUser) -> None:
    c = await db.get(Charge, app.charge_id)
    app.reversed_at = utcnow()
    app.reversed_by_id = actor.id
    app.reversal_reason = reason
    app.updated_by_id = actor.id
    if c:
        c.amount_paid = _round(float(c.amount_paid or 0) - float(app.amount))
        c.status = charge_status(c)
        c.updated_by_id = actor.id
    p.unapplied_amount = _round(float(p.unapplied_amount) + float(app.amount))


async def unapply(db: AsyncSession, p: Payment, data: UnapplyIn, actor: CurrentUser) -> Payment:
    app = await db.get(PaymentApplication, data.application_id)
    if not app or app.payment_id != p.id or app.reversed_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Active application not found")
    await _unapply(db, p, app, data.reason, actor)
    await audit.record(db, actor=actor, action="payment.unapplied", entity_type="payment", entity_id=p.id,
                       summary=data.reason, changes={"charge_id": app.charge_id, "amount": app.amount},
                       ip_address=actor.ip_address)
    await _refresh_collection(db, await get_lease(db, p.lease_id), date.today())
    await db.commit()
    return p


async def reverse_payment(db: AsyncSession, p: Payment, reason: str, actor: CurrentUser) -> Payment:
    """Reversal, never deletion: applications are reversed and the payment keeps its history."""
    if p.status == "reversed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Payment is already reversed")
    apps = list(await db.scalars(select(PaymentApplication).where(
        PaymentApplication.payment_id == p.id, PaymentApplication.reversed_at.is_(None))))
    for app in apps:
        await _unapply(db, p, app, f"Payment reversed: {reason}", actor)
    p.status = "reversed"
    p.reversed_at = utcnow()
    p.reversed_by_id = actor.id
    p.reversal_reason = reason
    p.unapplied_amount = 0
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="payment.reversed", entity_type="payment", entity_id=p.id,
                       summary=reason, changes={"amount": p.amount, "applications_reversed": len(apps)},
                       ip_address=actor.ip_address)
    await events.emit(db, "receivables.payment_reversed", payment_id=p.id, lease_id=p.lease_id, actor=actor)
    await _refresh_collection(db, await get_lease(db, p.lease_id), date.today())
    await db.commit()
    return p


# --------------------------------------------------------------------------- balances, ledger, aging

def late_fee_terms(lease, defaults: LateFeeDefaults) -> dict:
    """Lease late-fee terms when the lease is verified and specifies them; otherwise the configured defaults."""
    has_terms = lease.verified and any(v is not None for v in (lease.late_fee_grace_days, lease.late_fee_pct,
                                                                lease.late_fee_flat))
    if has_terms:
        return {"basis": "lease_terms", "grace_days": lease.late_fee_grace_days if lease.late_fee_grace_days is not None
                else defaults.grace_days, "pct": lease.late_fee_pct, "flat": lease.late_fee_flat}
    return {"basis": "defaults", "grace_days": defaults.grace_days, "pct": defaults.pct, "flat": defaults.flat}


async def _unapplied_by_lease(db: AsyncSession, lease_ids: list[uuid.UUID] | None = None) -> dict[uuid.UUID, float]:
    stmt = select(Payment.lease_id, func.coalesce(func.sum(Payment.unapplied_amount), 0)).where(
        Payment.deleted_at.is_(None), Payment.status == "received").group_by(Payment.lease_id)
    if lease_ids is not None:
        stmt = stmt.where(Payment.lease_id.in_(lease_ids))
    return {k: float(v) for k, v in (await db.execute(stmt)).all()}


def tenants_statement(as_of: date, *, property_id: uuid.UUID | None = None, asset_id: uuid.UUID | None = None,
                      q: str | None = None, collection_status: list[str] | None = None,
                      delinquent_only: bool = False):
    from app.modules.leases.models import Lease
    from app.modules.properties.models import Property

    agg = (select(Charge.lease_id.label("lease_id"), *bucket_columns(as_of))
           .where(*_open_charge_filter()).group_by(Charge.lease_id).subquery())
    unapp = (select(Payment.lease_id.label("lease_id"),
                    func.coalesce(func.sum(Payment.unapplied_amount), 0).label("unapplied"))
             .where(Payment.deleted_at.is_(None), Payment.status == "received").group_by(Payment.lease_id).subquery())
    past_due = (func.coalesce(agg.c.d1_30, 0) + func.coalesce(agg.c.d31_60, 0) + func.coalesce(agg.c.d61_90, 0)
                + func.coalesce(agg.c.d90_plus, 0))
    balance = func.coalesce(agg.c.total, 0) - func.coalesce(unapp.c.unapplied, 0)
    stmt = (
        select(Lease.id, Lease.tenant_name, Lease.property_id, Lease.status.label("lease_status"),
               func.coalesce(Property.name, Property.address_line).label("property_name"),
               func.coalesce(agg.c.current, 0).label("current"), func.coalesce(agg.c.d1_30, 0).label("d1_30"),
               func.coalesce(agg.c.d31_60, 0).label("d31_60"), func.coalesce(agg.c.d61_90, 0).label("d61_90"),
               func.coalesce(agg.c.d90_plus, 0).label("d90_plus"), func.coalesce(agg.c.total, 0).label("total"),
               func.coalesce(unapp.c.unapplied, 0).label("unapplied"), balance.label("balance"),
               past_due.label("past_due"), CollectionStatus.status.label("collection_status"),
               CollectionStatus.step_key, CollectionStatus.days_past_due)
        .join(Property, Property.id == Lease.property_id)
        .outerjoin(agg, agg.c.lease_id == Lease.id)
        .outerjoin(unapp, unapp.c.lease_id == Lease.id)
        .outerjoin(CollectionStatus, CollectionStatus.lease_id == Lease.id)
        .where(Lease.deleted_at.is_(None), or_(Lease.status == "active", agg.c.lease_id.isnot(None),
                                               unapp.c.lease_id.isnot(None)))
    )
    if property_id:
        stmt = stmt.where(Lease.property_id == property_id)
    if asset_id:
        stmt = stmt.where(Lease.asset_id == asset_id)
    if q:
        for term in q.split():
            stmt = stmt.where(or_(Lease.tenant_name.ilike(f"%{term}%"), Property.name.ilike(f"%{term}%")))
    if collection_status:
        stmt = stmt.where(func.coalesce(CollectionStatus.status, "current").in_(collection_status))
    if delinquent_only:
        stmt = stmt.where(past_due > CENT)
    sorts = {"tenant_name": Lease.tenant_name, "balance": balance, "past_due": past_due,
             "d90_plus": func.coalesce(agg.c.d90_plus, 0), "property_name": Property.name}
    return stmt, sorts, balance


async def tenant_rows(db: AsyncSession, rows) -> list[TenantBalance]:
    ids = [r.id for r in rows]
    plans = set(await db.scalars(select(PaymentPlan.lease_id).where(
        PaymentPlan.lease_id.in_(ids), PaymentPlan.status == "active", PaymentPlan.deleted_at.is_(None)))) if ids else set()
    return [TenantBalance(
        id=r.id, lease_id=r.id, tenant_name=r.tenant_name, property_id=r.property_id, property_name=r.property_name,
        lease_status=r.lease_status, balance=_round(r.balance), past_due=_round(r.past_due),
        unapplied=_round(r.unapplied), buckets=_buckets(r), collection_status=r.collection_status or "current",
        step_key=r.step_key, days_past_due=r.days_past_due or 0, has_plan=r.id in plans,
    ) for r in rows]


async def tenant_balance(db: AsyncSession, lease_id: uuid.UUID, as_of: date) -> TenantBalance:
    from app.modules.leases.models import Lease

    stmt, _, _ = tenants_statement(as_of)
    row = (await db.execute(stmt.where(Lease.id == lease_id))).first()
    if row is None:
        lease = await get_lease(db, lease_id)
        return TenantBalance(id=lease.id, lease_id=lease.id, tenant_name=lease.tenant_name, property_id=lease.property_id,
                             property_name=await _property_name(db, lease.property_id), lease_status=lease.status,
                             balance=0, past_due=0, unapplied=0, buckets=Buckets())
    return (await tenant_rows(db, [row]))[0]


async def ledger(db: AsyncSession, lease_id: uuid.UUID, as_of: date | None = None) -> LedgerOut:
    as_of = as_of or date.today()
    lease = await get_lease(db, lease_id)
    charges = list(await db.scalars(select(Charge).where(Charge.lease_id == lease_id, Charge.deleted_at.is_(None))
                                    .order_by(Charge.due_on, Charge.created_at)))
    payments = list(await db.scalars(select(Payment).where(Payment.lease_id == lease_id, Payment.deleted_at.is_(None))
                                     .order_by(Payment.received_on, Payment.created_at)))
    raw: list[tuple[date, int, LedgerEntry]] = []
    for c in charges:
        if c.status == "pending_approval":
            continue
        amt = float(c.amount)
        raw.append((c.due_on, 0, LedgerEntry(
            id=f"c:{c.id}", on=c.due_on, kind="charge", description=c.description or c.charge_type,
            charge_type=c.charge_type, debit=max(amt, 0), credit=max(-amt, 0), status=c.status, ref_id=c.id,
            source=c.source, source_ref=c.source_ref or {})))
        if c.voided_at:
            raw.append((c.voided_at.date(), 2, LedgerEntry(
                id=f"v:{c.id}", on=c.voided_at.date(), kind="void", description=f"Void: {c.void_reason or ''}".strip(),
                charge_type=c.charge_type, debit=max(-amt, 0), credit=max(amt, 0), status="void", ref_id=c.id)))
    for p in payments:
        raw.append((p.received_on, 1, LedgerEntry(
            id=f"p:{p.id}", on=p.received_on, kind="payment",
            description=f"Payment ({p.method}{', ' + p.reference if p.reference else ''})", credit=float(p.amount),
            status=p.status, ref_id=p.id)))
        if p.reversed_at:
            raw.append((p.reversed_at.date(), 2, LedgerEntry(
                id=f"r:{p.id}", on=p.reversed_at.date(), kind="reversal",
                description=f"Payment reversed: {p.reversal_reason or ''}".strip(), debit=float(p.amount),
                status="reversed", ref_id=p.id)))
    raw.sort(key=lambda t: (t[0], t[1]))
    running = 0.0
    entries = []
    for _, _, e in raw:
        running = _round(running + e.debit - e.credit)
        e.balance = running
        entries.append(e)
    open_charges = [charge_out(c, as_of) for c in charges if c.status in ("open", "partial", "credit", "pending_approval")]
    settings = await get_settings(db)
    return LedgerOut(tenant=await tenant_balance(db, lease_id, as_of), entries=entries, open_charges=open_charges,
                     late_fee_terms=late_fee_terms(lease, settings.late_fee_defaults))


async def dashboard(db: AsyncSession, *, property_id: uuid.UUID | None, asset_id: uuid.UUID | None,
                    as_of: date | None) -> Dashboard:
    from app.modules.properties.models import Property

    as_of = as_of or date.today()
    scope = list(_open_charge_filter())
    pay_scope = [Payment.deleted_at.is_(None), Payment.status == "received"]
    if property_id:
        scope.append(Charge.property_id == property_id)
        pay_scope.append(Payment.property_id == property_id)
    if asset_id:
        scope.append(Charge.asset_id == asset_id)
        pay_scope.append(Payment.property_id.in_(select(Charge.property_id).where(Charge.asset_id == asset_id)))
    totals = (await db.execute(select(*bucket_columns(as_of)).where(*scope))).one()
    unapplied = float(await db.scalar(select(func.coalesce(func.sum(Payment.unapplied_amount), 0)).where(*pay_scope)) or 0)

    by_prop_rows = (await db.execute(
        select(Charge.property_id, func.coalesce(Property.name, Property.address_line).label("name"),
               func.count(func.distinct(Charge.lease_id)).label("tenants"), *bucket_columns(as_of))
        .join(Property, Property.id == Charge.property_id).where(*scope)
        .group_by(Charge.property_id, Property.name, Property.address_line)
    )).all()
    by_property = sorted([DashboardRow(id=str(r.property_id), label=r.name, property_id=r.property_id,
                                       buckets=_buckets(r), tenants=r.tenants) for r in by_prop_rows],
                         key=lambda d: -d.buckets.total)

    stmt, _, _ = tenants_statement(as_of, property_id=property_id, asset_id=asset_id, delinquent_only=True)
    t_rows = (await db.execute(stmt.order_by(stmt.selected_columns.past_due.desc()))).all()
    delinquent = len(t_rows)
    by_tenant = [DashboardRow(id=str(r.id), label=r.tenant_name, lease_id=r.id, property_id=r.property_id,
                              buckets=_buckets(r), unapplied=_round(r.unapplied)) for r in t_rows[:15]]

    m0 = as_of.replace(day=1)
    billed = float(await db.scalar(select(func.coalesce(func.sum(Charge.amount), 0)).where(
        Charge.deleted_at.is_(None), Charge.status.notin_(["void", "pending_approval"]), Charge.amount > 0,
        Charge.due_on >= m0, Charge.due_on <= as_of,
        *([Charge.property_id == property_id] if property_id else []),
        *([Charge.asset_id == asset_id] if asset_id else []))) or 0)
    collected = float(await db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(
        *pay_scope, Payment.received_on >= m0, Payment.received_on <= as_of)) or 0)
    return Dashboard(as_of=as_of, totals=_buckets(totals), unapplied=_round(unapplied), delinquent_tenants=delinquent,
                     billed_this_month=_round(billed), collected_this_month=_round(collected),
                     collection_rate=round(collected / billed * 100, 1) if billed else None,
                     by_property=by_property, by_tenant=by_tenant)


# --------------------------------------------------------------------------- late fees

async def _assess_late_fees(db: AsyncSession, as_of: date, property_id: uuid.UUID | None, actor: CurrentUser) -> int:
    from app.modules.leases.models import Lease

    defaults = (await get_settings(db)).late_fee_defaults
    stmt = select(Charge).where(*_open_charge_filter(), Charge.status.in_(["open", "partial"]), Charge.amount > 0,
                                Charge.charge_type.in_(defaults.charge_types), Charge.due_on < as_of)
    if property_id:
        stmt = stmt.where(Charge.property_id == property_id)
    leases: dict[uuid.UUID, Lease] = {}
    created = 0
    for c in list(await db.scalars(stmt)):
        lease = leases.get(c.lease_id) or await db.get(Lease, c.lease_id)
        if not lease or lease.deleted_at:
            continue
        leases[c.lease_id] = lease
        terms = late_fee_terms(lease, defaults)
        if (as_of - c.due_on).days <= (terms["grace_days"] or 0):
            continue
        key = f"late:{c.id}"
        if await db.scalar(select(Charge.id).where(Charge.idempotency_key == key)):
            continue
        balance = charge_balance(c)
        fee = balance * (terms["pct"] or 0) / 100 + float(terms["flat"] or 0)
        if fee <= CENT:
            continue
        db.add(_new_charge(lease, charge_type="late_fee", amount=fee, due_on=as_of, source="late_fee",
                           source_ref={**terms, "charge_id": c.id, "charge_due_on": c.due_on,
                                       "balance_at_assessment": balance},
                           description=f"Late fee on {c.description or c.charge_type}", period_start=c.period_start,
                           period_end=c.period_end, idempotency_key=key, actor=actor))
        created += 1
    if created:
        await audit.record(db, actor=actor, action="receivables.late_fees_assessed", entity_type=ENTITY,
                           summary=f"{created} late fees as of {as_of}", ip_address=actor.ip_address)
    return created


async def assess_late_fees(db: AsyncSession, as_of: date | None, property_id: uuid.UUID | None,
                           actor: CurrentUser) -> int:
    n = await _assess_late_fees(db, as_of or date.today(), property_id, actor)
    await db.commit()
    return n


# --------------------------------------------------------------------------- delinquency ladder & notices

class _SafeDict(dict):
    def __missing__(self, key):
        return "{" + key + "}"


def render(template: str, ctx: dict) -> str:
    try:
        return template.format_map(_SafeDict(ctx))
    except (ValueError, IndexError):
        return template


async def _collection(db: AsyncSession, lease_id: uuid.UUID, actor) -> CollectionStatus:
    cs = await db.scalar(select(CollectionStatus).where(CollectionStatus.lease_id == lease_id))
    if not cs:
        cs = CollectionStatus(lease_id=lease_id, status="current", step_index=0, past_due_balance=0, days_past_due=0,
                              on_hold=False, created_by_id=getattr(actor, "id", None))
        db.add(cs)
        await db.flush()
    return cs


async def _past_due(db: AsyncSession, lease_id: uuid.UUID, as_of: date) -> tuple[float, date | None]:
    await db.flush()  # sessions do not autoflush; pending applications must be visible to the sums below
    row =(await db.execute(select(func.coalesce(func.sum(Charge.amount - Charge.amount_paid), 0), func.min(Charge.due_on))
                            .where(Charge.lease_id == lease_id, Charge.deleted_at.is_(None),
                                   Charge.status.in_(["open", "partial"]), Charge.amount > 0,
                                   Charge.due_on < as_of))).one()
    unapplied = (await _unapplied_by_lease(db, [lease_id])).get(lease_id, 0.0)
    credits = float(await db.scalar(select(func.coalesce(func.sum(Charge.amount), 0)).where(
        Charge.lease_id == lease_id, Charge.deleted_at.is_(None), Charge.status == "credit")) or 0)
    return _round(float(row[0]) - unapplied + credits), row[1]


async def _refresh_collection(db: AsyncSession, lease, as_of: date) -> None:
    """After payment activity: clear the ladder if the tenant is no longer past due. Never escalates."""
    cs = await db.scalar(select(CollectionStatus).where(CollectionStatus.lease_id == lease.id))
    if not cs:
        return
    past_due, oldest = await _past_due(db, lease.id, as_of)
    cs.past_due_balance = max(past_due, 0)
    cs.oldest_due_on = oldest if past_due > CENT else None
    cs.days_past_due = (as_of - oldest).days if oldest and past_due > CENT else 0
    if past_due <= CENT and cs.status != "current":
        cs.status = "current"
        cs.step_index = 0
        cs.step_key = None


async def _create_notice(db: AsyncSession, lease, step: LadderStep, index: int, balance: float, days: int,
                         as_of: date, actor, key: str | None) -> DelinquencyNotice:
    if key:
        existing = await db.scalar(select(DelinquencyNotice).where(DelinquencyNotice.idempotency_key == key))
        if existing:
            return existing
    ctx = {"tenant_name": lease.tenant_name, "property_name": await _property_name(db, lease.property_id) or "",
           "balance": f"${balance:,.2f}", "days_past_due": days, "as_of": as_of.strftime("%B %d, %Y"),
           "cure_by": (as_of + timedelta(days=10)).strftime("%B %d, %Y"), "step": step.label}
    n = DelinquencyNotice(lease_id=lease.id, property_id=lease.property_id, step_key=step.key, step_index=index,
                          label=step.label, balance=_round(balance), days_past_due=days,
                          subject=render(step.subject, ctx)[:300], body=render(step.body, ctx), status="draft",
                          idempotency_key=key, created_by_id=getattr(actor, "id", None))
    db.add(n)
    await db.flush()
    return n


async def _evaluate_plan(db: AsyncSession, plan: PaymentPlan, as_of: date, actor) -> bool:
    """Recompute installment status; returns True when the plan is newly breached."""
    paid_since = float(await db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.lease_id == plan.lease_id, Payment.deleted_at.is_(None), Payment.status == "received",
        Payment.received_on >= plan.created_at.date())) or 0)
    # Ongoing obligations are satisfied first; only the excess counts toward the plan.
    new_charges = float(await db.scalar(select(func.coalesce(func.sum(Charge.amount), 0)).where(
        Charge.lease_id == plan.lease_id, Charge.deleted_at.is_(None), Charge.amount > 0,
        Charge.status.notin_(["void", "pending_approval"]), Charge.due_on >= plan.start_on,
        Charge.due_on <= as_of)) or 0)
    remaining = max(0.0, paid_since - new_charges)
    plan.paid_amount = _round(min(remaining, float(plan.total_amount)))
    breach = False
    insts = list(await db.scalars(select(PaymentPlanInstallment).where(
        PaymentPlanInstallment.plan_id == plan.id, PaymentPlanInstallment.deleted_at.is_(None))
        .order_by(PaymentPlanInstallment.sequence)))
    for i in insts:
        paid = min(float(i.amount), remaining)
        remaining -= paid
        i.paid_amount = _round(paid)
        if paid >= float(i.amount) - CENT:
            i.status = "paid"
        elif i.due_on + timedelta(days=plan.grace_days) < as_of:
            i.status = "missed"
            breach = True
        else:
            i.status = "partial" if paid > CENT else "scheduled"
    if insts and all(i.status == "paid" for i in insts) and plan.status == "active":
        plan.status = "completed"
    if breach and plan.status == "active":
        from app.modules.tasks.service import raise_alert

        plan.status = "breached"
        plan.breached_at = utcnow()
        lease = await get_lease(db, plan.lease_id)
        await raise_alert(db, title=f"Payment plan breached: {lease.tenant_name}",
                          reason=f"An installment is more than {plan.grace_days} days past due.", severity="high",
                          owner_id=lease.manager_id, related_type="lease", related_id=lease.id,
                          related_label=lease.tenant_name, rule_key="receivables.plan_breach",
                          idempotency_key=f"receivables:plan_breach:{plan.id}")
        await audit.record(db, actor=actor, action="payment_plan.breached", entity_type="payment_plan",
                           entity_id=plan.id, summary=lease.tenant_name)
        await events.emit(db, "receivables.payment_plan_breached", plan_id=plan.id, lease_id=plan.lease_id, actor=actor)
        return True
    return False


async def evaluate(db: AsyncSession, data: EvaluateIn, actor: CurrentUser) -> EvaluateOut:
    """Aging drives automations: late fees, ladder escalation (notices + tasks), plan breaches, aging alerts."""
    from app.modules.leases.models import Lease
    from app.modules.tasks.service import create_task, raise_alert

    as_of = data.as_of or date.today()
    settings = await get_settings(db)
    ladder = sorted(settings.ladder, key=lambda s: s.days_past_due)
    late = await _assess_late_fees(db, as_of, data.property_id, actor)

    plans_q = select(PaymentPlan).where(PaymentPlan.status == "active", PaymentPlan.deleted_at.is_(None))
    if data.property_id:
        plans_q = plans_q.where(PaymentPlan.property_id == data.property_id)
    breached = 0
    for plan in list(await db.scalars(plans_q)):
        if await _evaluate_plan(db, plan, as_of, actor):
            breached += 1
            cs = await _collection(db, plan.lease_id, actor)
            cs.on_hold = False

    ids_q = select(Charge.lease_id).where(*_open_charge_filter()).distinct()
    cs_q = select(CollectionStatus.lease_id).where(CollectionStatus.status != "current")
    if data.property_id:
        ids_q = ids_q.where(Charge.property_id == data.property_id)
    lease_ids = set(await db.scalars(ids_q)) | set(await db.scalars(cs_q))
    evaluated = escalated = resolved = notices = 0
    for lease_id in lease_ids:
        lease = await db.get(Lease, lease_id)
        if not lease or lease.deleted_at or (data.property_id and lease.property_id != data.property_id):
            continue
        evaluated += 1
        cs = await _collection(db, lease.id, actor)
        past_due, oldest = await _past_due(db, lease.id, as_of)
        days = (as_of - oldest).days if oldest and past_due > CENT else 0
        cs.past_due_balance = max(past_due, 0)
        cs.days_past_due = days
        cs.oldest_due_on = oldest if past_due > CENT else None
        cs.last_evaluated_at = utcnow()
        cs.updated_by_id = actor.id
        if past_due <= CENT:
            if cs.status != "current":
                resolved += 1
                await audit.record(db, actor=actor, action="collection.resolved", entity_type="lease",
                                   entity_id=lease.id, summary=lease.tenant_name, ip_address=actor.ip_address)
            cs.status, cs.step_index, cs.step_key, cs.on_hold = "current", 0, None, False
            continue
        active_plan = await db.scalar(select(PaymentPlan.id).where(
            PaymentPlan.lease_id == lease.id, PaymentPlan.status == "active", PaymentPlan.deleted_at.is_(None)))
        if active_plan:
            cs.status, cs.on_hold = "payment_plan", True
            continue
        cs.on_hold = False
        target = 0
        for i, step in enumerate(ladder, start=1):
            if days >= step.days_past_due and past_due >= step.min_balance:
                target = i
        if target > cs.step_index:
            step = ladder[target - 1]
            n = await _create_notice(db, lease, step, target, past_due, days, as_of, actor,
                                     key=f"ladder:{lease.id}:{step.key}:{oldest.isoformat() if oldest else ''}")
            notices += 1
            if step.create_task:
                task = await create_task(
                    db, title=f"{step.label}: {lease.tenant_name}", assignee_id=lease.manager_id,
                    due_at=utcnow() + timedelta(days=2), task_type="follow_up", priority=step.task_priority,
                    description=f"{days} days past due, balance ${past_due:,.2f}. Review and send the drafted notice.",
                    related_type="lease", related_id=lease.id, related_label=lease.tenant_name, source="receivables",
                    idempotency_key=f"receivables:{lease.id}:{step.key}:{oldest.isoformat() if oldest else ''}",
                    actor_id=actor.id)
                n.task_id = task.id
            await audit.record(db, actor=actor, action="collection.escalated", entity_type="lease", entity_id=lease.id,
                               summary=f"{step.label} ({days} days, ${past_due:,.2f})",
                               changes={"step": {"from": cs.step_key, "to": step.key}}, ip_address=actor.ip_address)
            cs.step_index, cs.step_key, cs.status = target, step.key, step.collection_status
            escalated += 1
            await events.emit(db, "receivables.delinquency_escalated", lease_id=lease.id, step_key=step.key,
                              notice_id=n.id, actor=actor)
        elif cs.step_index == 0:
            cs.status = "delinquent"
        if days >= settings.alert_days:
            await raise_alert(db, title=f"{lease.tenant_name} is {days} days past due",
                              reason=f"Past-due balance ${past_due:,.2f} exceeds the {settings.alert_days}-day aging "
                                     f"threshold.", severity="high", owner_id=lease.manager_id, related_type="lease",
                              related_id=lease.id, related_label=lease.tenant_name, rule_key="receivables.aging",
                              idempotency_key=f"receivables:aging:{lease.id}:{oldest.isoformat() if oldest else ''}")
    await db.commit()
    return EvaluateOut(evaluated=evaluated, escalated=escalated, resolved=resolved, notices=notices,
                       breached_plans=breached, late_fees=late)


async def create_notice(db: AsyncSession, lease_id: uuid.UUID, step_key: str, actor: CurrentUser) -> DelinquencyNotice:
    lease = await get_lease(db, lease_id)
    settings = await get_settings(db)
    steps = sorted(settings.ladder, key=lambda s: s.days_past_due)
    match = [(i, s) for i, s in enumerate(steps, start=1) if s.key == step_key]
    if not match:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown ladder step")
    index, step = match[0]
    as_of = date.today()
    past_due, oldest = await _past_due(db, lease.id, as_of)
    days = (as_of - oldest).days if oldest and past_due > CENT else 0
    n = await _create_notice(db, lease, step, index, max(past_due, 0), days, as_of, actor, key=None)
    await audit.record(db, actor=actor, action="notice.drafted", entity_type="lease", entity_id=lease.id,
                       summary=n.subject, changes={"notice_id": n.id}, ip_address=actor.ip_address)
    await db.commit()
    return n


async def send_notice(db: AsyncSession, n: DelinquencyNotice, method: str, actor: CurrentUser) -> DelinquencyNotice:
    if n.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Notice is already {n.status}")
    n.status = "sent"
    n.sent_at = utcnow()
    n.sent_by_id = actor.id
    n.delivery_method = method
    n.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="notice.sent", entity_type="lease", entity_id=n.lease_id,
                       summary=n.subject, changes={"notice_id": n.id, "delivery_method": method},
                       ip_address=actor.ip_address)
    await db.commit()
    return n


async def cancel_notice(db: AsyncSession, n: DelinquencyNotice, actor: CurrentUser) -> DelinquencyNotice:
    if n.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft notices can be cancelled")
    n.status = "cancelled"
    n.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="notice.cancelled", entity_type="lease", entity_id=n.lease_id,
                       summary=n.subject, changes={"notice_id": n.id}, ip_address=actor.ip_address)
    await db.commit()
    return n


# --------------------------------------------------------------------------- payment plans

def _add_months(d: date, months: int) -> date:
    from app.modules.leases.service import add_months

    return add_months(d, months)


async def create_plan(db: AsyncSession, data: PlanIn, actor: CurrentUser) -> PaymentPlan:
    lease = await get_lease(db, data.lease_id)
    if await db.scalar(select(PaymentPlan.id).where(PaymentPlan.lease_id == lease.id, PaymentPlan.status == "active",
                                                    PaymentPlan.deleted_at.is_(None))):
        raise HTTPException(status.HTTP_409_CONFLICT, "This tenant already has an active payment plan")
    total = data.total_amount
    if total is None:
        total, _ = await _past_due(db, lease.id, data.start_on)
    if total <= CENT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nothing is past due to put on a plan")
    plan = PaymentPlan(lease_id=lease.id, property_id=lease.property_id, total_amount=_round(total),
                       start_on=data.start_on, installment_count=data.installment_count,
                       frequency_months=data.frequency_months, grace_days=data.grace_days, status="active",
                       paid_amount=0, approved_by_id=actor.id, notes=data.notes, created_by_id=actor.id,
                       updated_by_id=actor.id)
    db.add(plan)
    await db.flush()
    each = _round(total / data.installment_count)
    for i in range(data.installment_count):
        amount = each if i < data.installment_count - 1 else _round(total - each * (data.installment_count - 1))
        db.add(PaymentPlanInstallment(plan_id=plan.id, sequence=i + 1,
                                      due_on=_add_months(data.start_on, i * data.frequency_months), amount=amount,
                                      paid_amount=0, status="scheduled", created_by_id=actor.id))
    cs = await _collection(db, lease.id, actor)
    cs.status, cs.on_hold = "payment_plan", True
    await audit.record(db, actor=actor, action="payment_plan.created", entity_type="payment_plan", entity_id=plan.id,
                       summary=f"{lease.tenant_name}: {plan.total_amount:,.2f} over {data.installment_count}",
                       changes={"lease_id": lease.id}, ip_address=actor.ip_address)
    await db.commit()
    return plan


async def cancel_plan(db: AsyncSession, plan: PaymentPlan, actor: CurrentUser) -> PaymentPlan:
    if plan.status != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only active plans can be cancelled")
    plan.status = "cancelled"
    plan.updated_by_id = actor.id
    cs = await _collection(db, plan.lease_id, actor)
    cs.on_hold = False
    if cs.status == "payment_plan":
        cs.status = "delinquent"
    await audit.record(db, actor=actor, action="payment_plan.cancelled", entity_type="payment_plan",
                       entity_id=plan.id, ip_address=actor.ip_address)
    await db.commit()
    return plan


async def plan_out(db: AsyncSession, plan: PaymentPlan):
    from app.modules.receivables.schemas import InstallmentOut, PlanOut

    out = PlanOut.model_validate(plan)
    lease = await get_lease(db, plan.lease_id)
    out.tenant_name = lease.tenant_name
    out.installments = [InstallmentOut.model_validate(i) for i in await db.scalars(
        select(PaymentPlanInstallment).where(PaymentPlanInstallment.plan_id == plan.id,
                                             PaymentPlanInstallment.deleted_at.is_(None))
        .order_by(PaymentPlanInstallment.sequence))]
    return out


# --------------------------------------------------------------------------- recovery reconciliation billing

async def bill_reconciliations(db: AsyncSession, data: ReconBillIn, actor: CurrentUser) -> ReconBillOut:
    from app.modules.leases.models import Lease, RecoveryReconciliation
    from app.modules.leases.service import mark_reconciliation_billed

    billed = skipped = 0
    total = 0.0
    for rid in dict.fromkeys(data.reconciliation_ids):
        rec = await db.get(RecoveryReconciliation, rid)
        if not rec or rec.deleted_at or rec.status != "final":
            skipped += 1
            continue
        lease = await db.get(Lease, rec.lease_id)
        if not lease or lease.deleted_at:
            skipped += 1
            continue
        amount = float(rec.true_up_amount or 0)
        key = f"recon:{rec.id}"
        if abs(amount) <= CENT or await db.scalar(select(Charge.id).where(Charge.idempotency_key == key)):
            skipped += 1
            continue
        c = _new_charge(lease, charge_type="recovery_true_up", amount=amount, due_on=data.due_on,
                        source="reconciliation", period_start=date(rec.year, 1, 1), period_end=date(rec.year, 12, 31),
                        description=f"{rec.year} recovery reconciliation {'true-up' if amount > 0 else 'credit'}",
                        source_ref={"reconciliation_id": rec.id, "year": rec.year, "actual_share": rec.actual_share,
                                    "estimates_billed": rec.estimates_billed, "cap_reduction": rec.cap_reduction},
                        idempotency_key=key, actor=actor)
        c.approved_by_id = rec.finalized_by_id
        c.approved_at = rec.finalized_at
        db.add(c)
        await db.flush()
        mark_reconciliation_billed(rec, c.id, actor)
        await audit.record(db, actor=actor, action="charge.reconciliation_billed", entity_type="charge",
                           entity_id=c.id, summary=f"{lease.tenant_name} {rec.year}: {amount:,.2f}",
                           changes={"reconciliation_id": rec.id}, ip_address=actor.ip_address)
        billed += 1
        total += amount
    await db.commit()
    return ReconBillOut(billed=billed, skipped=skipped, amount=_round(total))


# --------------------------------------------------------------------------- accounting / banking sync

async def export_batch(db: AsyncSession, data: ExportIn, actor: CurrentUser) -> SyncBatch:
    if data.period_to < data.period_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Period end is before start")
    cq = select(Charge).where(Charge.deleted_at.is_(None), Charge.status != "pending_approval",
                              Charge.due_on.between(data.period_from, data.period_to))
    pq = select(Payment).where(Payment.deleted_at.is_(None),
                               Payment.received_on.between(data.period_from, data.period_to))
    if data.property_id:
        cq = cq.where(Charge.property_id == data.property_id)
        pq = pq.where(Payment.property_id == data.property_id)
    entries: list[dict] = []
    for c in await db.scalars(cq.order_by(Charge.due_on)):
        entries.append({"kind": "charge", "local_id": c.id, "lease_id": c.lease_id, "tenant_name": c.tenant_name,
                        "charge_type": c.charge_type, "entry_date": c.due_on, "amount": c.amount, "status": c.status,
                        "external_ref": c.external_ref, "source": c.source})
    for p in await db.scalars(pq.order_by(Payment.received_on)):
        entries.append({"kind": "payment", "local_id": p.id, "lease_id": p.lease_id, "tenant_name": p.tenant_name,
                        "entry_date": p.received_on, "amount": p.amount, "status": p.status, "method": p.method,
                        "reference": p.reference, "external_ref": p.external_ref})
    b = SyncBatch(direction="export", system=data.system, status="completed", period_from=data.period_from,
                  period_to=data.period_to, property_id=data.property_id, entry_count=len(entries),
                  payload=audit.to_jsonable(entries), summary=f"{len(entries)} ledger entries exported",
                  created_by_id=actor.id, updated_by_id=actor.id)
    db.add(b)
    await db.flush()
    await audit.record(db, actor=actor, action="sync.exported", entity_type="sync_batch", entity_id=b.id,
                       summary=f"{data.system}: {len(entries)} entries", ip_address=actor.ip_address)
    await db.commit()
    return b


def _local_date(row) -> date:
    return row.due_on if isinstance(row, Charge) else row.received_on


async def import_batch(db: AsyncSession, data: ImportIn, actor: CurrentUser) -> SyncBatch:
    """Match external entries to our records. Disagreements become conflicts; nothing is overwritten."""
    b = SyncBatch(direction="import", system=data.system, status="pending", external_batch_id=data.external_batch_id,
                  entry_count=len(data.entries), payload=[e.model_dump(mode="json") for e in data.entries],
                  created_by_id=actor.id, updated_by_id=actor.id)
    db.add(b)
    await db.flush()
    matched = conflicts = 0

    def conflict(kind: str, row_id, ext_id: str, field: str, local, external) -> None:
        db.add(SyncConflict(batch_id=b.id, entity_type=kind, entity_id=row_id, external_id=ext_id, field=field,
                            local_value=audit.to_jsonable(local), external_value=audit.to_jsonable(external),
                            status="open", created_by_id=actor.id))

    for e in data.entries:
        model = Charge if e.kind == "charge" else Payment
        row = await db.get(model, e.local_id) if e.local_id else None
        if row is None:
            row = await db.scalar(select(model).where(model.external_ref == e.external_id, model.deleted_at.is_(None)))
        if row is None or row.deleted_at:
            conflict(e.kind, None, e.external_id, "unmatched", None, e.model_dump(mode="json"))
            conflicts += 1
            continue
        diffs = []
        if row.external_ref and row.external_ref != e.external_id:
            diffs.append(("external_ref", row.external_ref, e.external_id))
        if e.amount is not None and abs(float(row.amount) - e.amount) > CENT:
            diffs.append(("amount", float(row.amount), e.amount))
        if e.entry_date and e.entry_date != _local_date(row):
            diffs.append(("date", _local_date(row), e.entry_date))
        if e.status and e.status != row.status:
            diffs.append(("status", row.status, e.status))
        if diffs:
            for field, local, external in diffs:
                conflict(e.kind, row.id, e.external_id, field, local, external)
            conflicts += 1
        else:
            matched += 1
            if not row.external_ref:
                row.external_ref = e.external_id
            row.synced_at = utcnow()
    b.matched_count = matched
    b.conflict_count = conflicts
    b.status = "completed_with_conflicts" if conflicts else "completed"
    b.summary = f"{matched} matched, {conflicts} entries need review"
    await audit.record(db, actor=actor, action="sync.imported", entity_type="sync_batch", entity_id=b.id,
                       summary=f"{data.system}: {b.summary}", ip_address=actor.ip_address)
    await db.commit()
    return b


async def resolve_conflict(db: AsyncSession, cf: SyncConflict, data: ResolveIn, actor: CurrentUser) -> SyncConflict:
    if cf.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, "Conflict is already resolved")
    changes: dict = {}
    if data.resolution == "accept_external":
        if cf.field == "unmatched" or not cf.entity_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "Unmatched external entries must be entered manually (as an approved charge or payment)")
        ext = cf.external_value
        if cf.entity_type == "charge":
            c = await get_row(db, Charge, cf.entity_id, "Charge")
            if cf.field == "amount":
                if float(ext) < float(c.amount_paid or 0) - CENT:
                    raise HTTPException(status.HTTP_409_CONFLICT, "External amount is below what has been applied")
                changes["amount"] = {"from": c.amount, "to": float(ext)}
                c.amount = _round(float(ext))
                c.status = charge_status(c)
            elif cf.field == "date":
                changes["due_on"] = {"from": c.due_on, "to": ext}
                c.due_on = date.fromisoformat(str(ext)[:10])
            elif cf.field == "status" and ext == "void":
                await void_charge(db, c, f"Accepted from accounting sync ({cf.external_id})", actor)
                changes["status"] = {"from": cf.local_value, "to": "void"}
            elif cf.field == "external_ref":
                changes["external_ref"] = {"from": c.external_ref, "to": ext}
                c.external_ref = str(ext)
            else:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "This difference must be corrected manually")
            c.updated_by_id = actor.id
        else:
            p = await get_row(db, Payment, cf.entity_id, "Payment")
            if cf.field == "amount":
                applied = float(p.amount) - float(p.unapplied_amount)
                if float(ext) < applied - CENT:
                    raise HTTPException(status.HTTP_409_CONFLICT, "Unapply allocations before reducing the payment")
                changes["amount"] = {"from": p.amount, "to": float(ext)}
                p.amount = _round(float(ext))
                p.unapplied_amount = _round(float(ext) - applied)
            elif cf.field == "date":
                changes["received_on"] = {"from": p.received_on, "to": ext}
                p.received_on = date.fromisoformat(str(ext)[:10])
            elif cf.field == "status" and ext == "reversed":
                await reverse_payment(db, p, f"Accepted from accounting sync ({cf.external_id})", actor)
                changes["status"] = {"from": cf.local_value, "to": "reversed"}
            elif cf.field == "external_ref":
                changes["external_ref"] = {"from": p.external_ref, "to": ext}
                p.external_ref = str(ext)
            else:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "This difference must be corrected manually")
            p.updated_by_id = actor.id
        if changes:
            await audit.record(db, actor=actor, action=f"{cf.entity_type}.sync_accepted", entity_type=cf.entity_type,
                               entity_id=cf.entity_id, summary=f"Accepted external {cf.field} from sync",
                               changes=changes, ip_address=actor.ip_address)
    cf = await db.get(SyncConflict, cf.id, populate_existing=True)
    cf.status = data.resolution if data.resolution != "accept_external" else "accepted_external"
    cf.resolved_by_id = actor.id
    cf.resolved_at = utcnow()
    cf.resolution_note = data.note
    await audit.record(db, actor=actor, action="sync_conflict.resolved", entity_type="sync_batch", entity_id=cf.batch_id,
                       summary=f"{cf.entity_type} {cf.field}: {cf.status}", changes={"conflict_id": cf.id},
                       ip_address=actor.ip_address)
    open_left = await db.scalar(select(func.count()).select_from(SyncConflict).where(
        SyncConflict.batch_id == cf.batch_id, SyncConflict.status == "open", SyncConflict.id != cf.id))
    if not open_left:
        b = await db.get(SyncBatch, cf.batch_id)
        if b and b.status == "completed_with_conflicts":
            b.status = "completed"
    await db.commit()
    return cf
