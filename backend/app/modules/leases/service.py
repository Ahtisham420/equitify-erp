import calendar
import inspect
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, column, func, or_, select, table
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.provenance import ProvenanceIn
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.leases.models import (
    MATERIAL_FIELDS,
    OBLIGATION_CATEGORIES,
    OVERRIDABLE_FIELDS,
    Guaranty,
    Lease,
    LeaseAmendment,
    LeaseClause,
    LeaseOption,
    LeaseRecovery,
    RecoveryReconciliation,
    RentStep,
)
from app.modules.leases.schemas import (
    AmendmentIn,
    ClauseIn,
    EscalationIn,
    GuarantyIn,
    LeaseCreate,
    LeaseOut,
    LeaseUpdate,
    OperativeField,
    OperativeTerms,
    OptionEconomics,
    OptionIn,
    ReconRunIn,
    RecoveryIn,
    RentRoll,
    RentRollRow,
    RentRollTotals,
    RentStepIn,
    RentStepOut,
    Rollover,
    RolloverYear,
)

ENTITY = "lease"
DATE_FIELDS = {"commencement_on", "expiration_on", "rent_commencement_on", "execution_on"}
UUID_FIELDS = {"space_id", "tenant_organization_id"}
DEFAULT_RENEWAL_PROBABILITY = 0.65
DEFAULT_DOWNTIME_MONTHS = 6
RECOVERY_CHARGE_TYPES = ["recovery", "cam", "tax", "insurance", "utilities", "fixed_cam"]
SPACE_MATERIAL = {"area_sf", "occupancy_status", "tenant_name"}


# --------------------------------------------------------------------------- date helpers

def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def month_end(d: date) -> date:
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def _as_date(v: Any) -> date | None:
    if v is None or isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _num(v: Any) -> float | None:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _years_between(a: date, b: date) -> float:
    return max(0.0, (b - a).days / 365.25)


# --------------------------------------------------------------------------- lookups

async def get(db: AsyncSession, lease_id: uuid.UUID) -> Lease:
    lease = await db.get(Lease, lease_id)
    if not lease or lease.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lease not found")
    return lease


async def _child(db: AsyncSession, model, child_id: uuid.UUID, label: str):
    row = await db.get(model, child_id)
    if not row or row.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    return row


async def _check_space(db: AsyncSession, property_id: uuid.UUID, space_id: uuid.UUID | None) -> None:
    if not space_id:
        return
    from app.modules.parcels.models import Space

    s = await db.get(Space, space_id)
    if not s or s.deleted_at or s.property_id != property_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Space does not belong to this property")


def _rent_psf(annual: float | None, sf: float | None) -> float | None:
    return round(annual / sf, 4) if annual is not None and sf else None


# --------------------------------------------------------------------------- list

@dataclass
class LeaseFilters:
    q: str | None = None
    status: list[str] | None = None
    lease_type: list[str] | None = None
    verified: list[str] | None = None
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    tenant_organization_id: uuid.UUID | None = None
    expiring_within: int | None = None
    expires_from: date | None = None
    expires_to: date | None = None
    min_sf: float | None = None
    max_sf: float | None = None


def current_rent_expr(today: date | None = None):
    today = today or date.today()
    return (
        select(RentStep.annual_rent)
        .where(RentStep.lease_id == Lease.id, RentStep.deleted_at.is_(None), RentStep.start_on <= today,
               RentStep.end_on >= today)
        .order_by(RentStep.amendment_id.is_(None), RentStep.start_on.desc())
        .limit(1)
        .correlate(Lease)
        .scalar_subquery()
    )


def build_query(f: LeaseFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Lease).where(Lease.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Lease.tenant_name, Lease.landlord_name, Lease.premises_description])
    if "status" not in skip:
        stmt = in_filter(stmt, Lease.status, f.status)
    if "lease_type" not in skip:
        stmt = in_filter(stmt, Lease.lease_type, f.lease_type)
    if "verified" not in skip and f.verified:
        flags = [v.lower() in ("true", "1", "yes") for v in f.verified]
        stmt = stmt.where(Lease.verified.in_(flags))
    if f.property_id:
        stmt = stmt.where(Lease.property_id == f.property_id)
    if f.asset_id:
        stmt = stmt.where(Lease.asset_id == f.asset_id)
    if f.tenant_organization_id:
        stmt = stmt.where(Lease.tenant_organization_id == f.tenant_organization_id)
    if "expiring" not in skip and f.expiring_within:
        today = date.today()
        stmt = stmt.where(Lease.expiration_on >= today, Lease.expiration_on <= today + timedelta(days=f.expiring_within))
    if f.expires_from:
        stmt = stmt.where(Lease.expiration_on >= f.expires_from)
    if f.expires_to:
        stmt = stmt.where(Lease.expiration_on <= f.expires_to)
    if f.min_sf is not None:
        stmt = stmt.where(Lease.rentable_sf >= f.min_sf)
    if f.max_sf is not None:
        stmt = stmt.where(Lease.rentable_sf <= f.max_sf)
    return stmt


def list_statement(f: LeaseFilters) -> Select:
    from app.modules.parcels.models import Space
    from app.modules.properties.models import Property

    base = build_query(f).subquery()
    rent = current_rent_expr()
    return (
        select(Lease, func.coalesce(rent, Lease.base_rent_annual).label("current_rent"),
               func.coalesce(Property.name, Property.address_line).label("property_name"), Space.suite)
        .join(base, base.c.id == Lease.id)
        .join(Property, Property.id == Lease.property_id)
        .outerjoin(Space, Space.id == Lease.space_id)
    )


def list_items(rows) -> list[dict]:
    out = []
    for lease, rent, prop_name, suite in rows:
        d = {c: getattr(lease, c) for c in (
            "id", "property_id", "space_id", "tenant_name", "status", "lease_type", "commencement_on",
            "expiration_on", "rentable_sf", "verified", "ai_extracted", "updated_at")}
        d.update(property_name=prop_name, suite=suite, current_annual_rent=rent,
                 rent_psf=_rent_psf(rent, lease.rentable_sf))
        out.append(d)
    return out


async def expiring_counts(db: AsyncSession, f: LeaseFilters) -> dict[str, int]:
    today = date.today()
    out: dict[str, int] = {}
    base = build_query(f, skip={"expiring"})
    for days in (90, 180, 365, 730):
        sub = base.where(Lease.expiration_on >= today, Lease.expiration_on <= today + timedelta(days=days))
        out[str(days)] = int(await db.scalar(select(func.count()).select_from(sub.order_by(None).subquery())) or 0)
    return out


# --------------------------------------------------------------------------- detail

async def _unverified_count(db: AsyncSession, lease_id: uuid.UUID) -> int:
    total = 0
    for model in (LeaseRecovery, LeaseOption, LeaseClause, Guaranty, LeaseAmendment):
        total += int(await db.scalar(
            select(func.count()).select_from(model).where(
                model.lease_id == lease_id, model.deleted_at.is_(None), model.verified.is_(False))
        ) or 0)
    return total


async def to_out(db: AsyncSession, lease: Lease) -> LeaseOut:
    from app.modules.auth.models import User
    from app.modules.parcels.models import Space
    from app.modules.properties.models import Property

    out = LeaseOut.model_validate(lease)
    prop = await db.get(Property, lease.property_id)
    out.property_name = (prop.name or prop.address_line) if prop else None
    if lease.space_id:
        s = await db.get(Space, lease.space_id)
        out.suite = s.suite if s else None
    if lease.manager_id:
        u = await db.get(User, lease.manager_id)
        out.manager_name = u.full_name if u else None
    vals, steps = await _operative(db, lease)
    out.current_annual_rent = _rent_at(steps, date.today(), vals.get("base_rent_annual"))
    out.unverified_items = await _unverified_count(db, lease.id)
    out.provenance = {
        k: provenance.ObservationOut.model_validate(v)
        for k, v in (await provenance.current_observations(db, ENTITY, lease.id)).items()
    }
    return out


# --------------------------------------------------------------------------- side effects

async def _link_document(db: AsyncSession, document_id: uuid.UUID | None, entity_id: uuid.UUID, actor) -> None:
    if not document_id:
        return
    try:
        from app.modules.documents import service as doc_service
    except ImportError:
        return
    try:
        async with db.begin_nested():
            res = doc_service.link(db, document_id, "lease", entity_id, actor)
            if inspect.isawaitable(res):
                await res
    except HTTPException:
        pass


async def _sync_space(db: AsyncSession, lease: Lease, actor: CurrentUser) -> None:
    """Verified, active leases mark their space occupied; ended leases release it. Space facts keep provenance."""
    if not lease.space_id or not lease.verified:
        return
    from app.modules.parcels.models import Space

    s = await db.get(Space, lease.space_id)
    if not s or s.deleted_at:
        return
    if lease.status == "active":
        data = {"occupancy_status": "occupied", "tenant_name": lease.tenant_name,
                "tenant_organization_id": lease.tenant_organization_id, "lease_id": lease.id}
    elif lease.status in ("expired", "terminated") and s.lease_id == lease.id:
        data = {"occupancy_status": "vacant", "tenant_name": None, "tenant_organization_id": None, "lease_id": None}
    else:
        return
    prov = ProvenanceIn(source=f"Lease: {lease.tenant_name}", confidence=1.0, verified=True)
    changes = await provenance.apply_material(db, s, entity_type="space", data=data, material_fields=SPACE_MATERIAL,
                                              prov=prov, actor_id=actor.id)
    if changes:
        s.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="property.space_lease_synced", entity_type="property",
                           entity_id=s.property_id, summary=f"Suite {s.suite}", changes=changes,
                           ip_address=actor.ip_address)


# --------------------------------------------------------------------------- lease CRUD

async def create(db: AsyncSession, data: LeaseCreate, actor: CurrentUser) -> Lease:
    from app.modules.properties import service as property_service

    await property_service.get(db, data.property_id)
    await _check_space(db, data.property_id, data.space_id)
    prov = data.provenance
    human_verified = prov.verified and not prov.ai_derived
    values = data.model_dump(exclude={"provenance"})
    values["citations"] = audit.to_jsonable(values["citations"])
    lease = Lease(**values, escalation={}, verified=human_verified, ai_extracted=prov.ai_derived,
                  confidence=prov.confidence, verified_by_id=actor.id if human_verified else None,
                  verified_at=utcnow() if human_verified else None, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(lease)
    await db.flush()
    for field in MATERIAL_FIELDS:
        value = getattr(lease, field)
        if value is not None:
            await provenance.observe(db, entity_type=ENTITY, entity_id=lease.id, field=field, value=value, prov=prov,
                                     actor_id=actor.id)
    await _link_document(db, lease.document_id, lease.id, actor)
    await audit.record(db, actor=actor, action="lease.created", entity_type=ENTITY, entity_id=lease.id,
                       summary=lease.tenant_name, ip_address=actor.ip_address)
    await events.emit(db, "lease.created", lease_id=lease.id, property_id=lease.property_id, actor=actor)
    if lease.verified:
        await generate_critical_dates(db, lease, actor)
        await _sync_space(db, lease, actor)
    await db.commit()
    return lease


async def update(db: AsyncSession, lease: Lease, data: LeaseUpdate, actor: CurrentUser) -> Lease:
    values = data.model_dump(exclude_unset=True, exclude={"provenance"})
    if "citations" in values:
        values["citations"] = audit.to_jsonable(values["citations"] or {})
    if "space_id" in values:
        await _check_space(db, lease.property_id, values["space_id"])
    prov = data.provenance
    changes = await provenance.apply_material(db, lease, entity_type=ENTITY, data=values,
                                              material_fields=MATERIAL_FIELDS, prov=prov, actor_id=actor.id)
    if not changes:
        return lease
    material = set(changes) & MATERIAL_FIELDS
    if material and lease.verified and (prov.ai_derived or not prov.verified):
        # A material term changed without human verification: the abstract needs re-verification.
        lease.verified = False
        lease.verified_by_id = None
        lease.verified_at = None
        changes["verified"] = {"from": True, "to": False}
    if prov.ai_derived and material:
        lease.ai_extracted = True
    lease.updated_by_id = actor.id
    if "document_id" in changes:
        await _link_document(db, lease.document_id, lease.id, actor)
    await audit.record(db, actor=actor, action="lease.updated", entity_type=ENTITY, entity_id=lease.id,
                       changes=changes, summary=lease.tenant_name, ip_address=actor.ip_address)
    await events.emit(db, "lease.updated", lease_id=lease.id, property_id=lease.property_id, changed=set(changes),
                      actor=actor)
    if lease.verified:
        await generate_critical_dates(db, lease, actor)
        if {"status", "space_id", "tenant_name", "tenant_organization_id"} & changes.keys():
            await _sync_space(db, lease, actor)
    await db.commit()
    return lease


async def verify(db: AsyncSession, lease: Lease, verified: bool, actor: CurrentUser) -> Lease:
    if lease.verified == verified:
        return lease
    lease.verified = verified
    lease.verified_by_id = actor.id if verified else None
    lease.verified_at = utcnow() if verified else None
    lease.updated_by_id = actor.id
    if verified:
        for obs in (await provenance.current_observations(db, ENTITY, lease.id)).values():
            if obs.verification == "unverified":
                await provenance.set_verification(db, obs.id, "verified", actor.id)
    await audit.record(db, actor=actor, action="lease.verified" if verified else "lease.unverified", entity_type=ENTITY,
                       entity_id=lease.id, summary=lease.tenant_name, ip_address=actor.ip_address)
    if verified:
        await events.emit(db, "lease.verified", lease_id=lease.id, property_id=lease.property_id, actor=actor)
        await generate_critical_dates(db, lease, actor)
        await _sync_space(db, lease, actor)
    await db.commit()
    return lease


async def archive(db: AsyncSession, lease: Lease, actor: CurrentUser) -> None:
    lease.deleted_at = utcnow()
    lease.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="lease.archived", entity_type=ENTITY, entity_id=lease.id,
                       summary=lease.tenant_name, ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- generic child records

CHILD_LABELS = {
    LeaseRecovery: "recovery", LeaseOption: "option", LeaseClause: "clause", Guaranty: "guaranty",
}


async def list_children(db: AsyncSession, model, lease_id: uuid.UUID) -> list:
    order = {
        LeaseRecovery: [LeaseRecovery.category], LeaseOption: [LeaseOption.option_type, LeaseOption.sequence],
        LeaseClause: [LeaseClause.category, LeaseClause.created_at], Guaranty: [Guaranty.created_at],
    }[model]
    return list(await db.scalars(
        select(model).where(model.lease_id == lease_id, model.deleted_at.is_(None)).order_by(*order)))


async def add_child(db: AsyncSession, model, lease: Lease, data: RecoveryIn | OptionIn | ClauseIn | GuarantyIn,
                    actor: CurrentUser):
    label = CHILD_LABELS[model]
    values = data.model_dump()
    # Every abstracted term starts unverified; a named human verifies it explicitly.
    row = model(**values, lease_id=lease.id, verified=False, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(row)
    await db.flush()
    await _link_document(db, getattr(row, "document_id", None), lease.id, actor)
    await audit.record(db, actor=actor, action=f"lease.{label}_added", entity_type=ENTITY, entity_id=lease.id,
                       summary=getattr(row, "title", None) or getattr(row, "option_type", None) or label,
                       changes={f"{label}_id": str(row.id)}, ip_address=actor.ip_address)
    await db.commit()
    return row


async def update_child(db: AsyncSession, row, lease: Lease, data, actor: CurrentUser):
    label = CHILD_LABELS[type(row)]
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(row, values)
    if not changes:
        return row
    for k, v in values.items():
        setattr(row, k, v)
    # Any change to a verified term sends it back for human verification; prior values stay in history.
    for field in ("summary", "terms", "quoted_text", "option_rent_psf", "notice_end_on", "cap_pct", "method",
                  "base_amount", "fixed_amount_annual", "cap_amount", "expires_on", "due_on"):
        if field in changes and hasattr(row, field):
            await provenance.observe(db, entity_type=f"lease_{label}", entity_id=row.id, field=field,
                                     value=getattr(row, field), prov=ProvenanceIn(
                                         source="AI extraction" if row.ai_extracted else "Manual edit",
                                         confidence=row.confidence or 0.8, ai_derived=bool(row.ai_extracted)),
                                     actor_id=actor.id)
    if row.verified:
        row.verified = False
        row.verified_by_id = None
        row.verified_at = None
        changes["verified"] = {"from": True, "to": False}
    row.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"lease.{label}_updated", entity_type=ENTITY, entity_id=lease.id,
                       changes={f"{label}_id": str(row.id), **changes}, ip_address=actor.ip_address)
    await db.commit()
    return row


async def verify_child(db: AsyncSession, row, lease: Lease, verified: bool, actor: CurrentUser):
    label = CHILD_LABELS.get(type(row), "amendment")
    row.verified = verified
    row.verified_by_id = actor.id if verified else None
    row.verified_at = utcnow() if verified else None
    row.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"lease.{label}_{'verified' if verified else 'unverified'}",
                       entity_type=ENTITY, entity_id=lease.id, changes={f"{label}_id": str(row.id)},
                       ip_address=actor.ip_address)
    if lease.verified:
        await generate_critical_dates(db, lease, actor)
    await db.commit()
    return row


async def remove_child(db: AsyncSession, row, lease: Lease, actor: CurrentUser) -> None:
    label = CHILD_LABELS.get(type(row), "rent_step")
    row.deleted_at = utcnow()
    row.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"lease.{label}_removed", entity_type=ENTITY, entity_id=lease.id,
                       changes={f"{label}_id": str(row.id)}, ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- rent steps & escalations

async def all_steps(db: AsyncSession, lease_id: uuid.UUID) -> list[RentStep]:
    return list(await db.scalars(
        select(RentStep).where(RentStep.lease_id == lease_id, RentStep.deleted_at.is_(None))
        .order_by(RentStep.start_on, RentStep.created_at)))


def _new_step(lease: Lease, *, start_on: date, end_on: date, annual: float, sf: float | None, source: str,
              actor: CurrentUser, rent_psf: float | None = None, amendment_id: uuid.UUID | None = None,
              note: str | None = None, charge_type: str = "base_rent", citation: dict | None = None) -> RentStep:
    if end_on < start_on:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Rent step ends before it starts")
    annual = round(annual, 2)
    return RentStep(
        lease_id=lease.id, amendment_id=amendment_id, start_on=start_on, end_on=end_on, annual_rent=annual,
        monthly_rent=round(annual / 12, 2), rent_psf=rent_psf if rent_psf is not None else _rent_psf(annual, sf),
        charge_type=charge_type, source=source, note=note, created_by_id=actor.id, updated_by_id=actor.id,
        **(citation or {}),
    )


async def add_step(db: AsyncSession, lease: Lease, data: RentStepIn, actor: CurrentUser) -> RentStep:
    if data.amendment_id:
        a = await _child(db, LeaseAmendment, data.amendment_id, "Amendment")
        if a.lease_id != lease.id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Amendment belongs to another lease")
    step = _new_step(lease, start_on=data.start_on, end_on=data.end_on, annual=data.annual_rent, sf=lease.rentable_sf,
                     rent_psf=data.rent_psf, source="amendment" if data.amendment_id else "manual",
                     amendment_id=data.amendment_id, note=data.note, charge_type=data.charge_type, actor=actor,
                     citation=data.model_dump(include={"document_id", "page", "clause_ref", "quoted_text"}))
    db.add(step)
    await db.flush()
    await audit.record(db, actor=actor, action="lease.rent_step_added", entity_type=ENTITY, entity_id=lease.id,
                       changes={"start_on": step.start_on, "end_on": step.end_on, "annual_rent": step.annual_rent},
                       ip_address=actor.ip_address)
    if lease.verified:
        await generate_critical_dates(db, lease, actor)
    await db.commit()
    return step


def build_steps(esc: EscalationIn, *, start: date, end: date, sf: float | None,
                fallback_base: float | None) -> list[tuple[date, date, float, str | None]]:
    """Pure escalation engine: returns (start, end, annual_rent, note) periods."""
    if end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "End date is before start date")
    if esc.method == "step_table":
        if not esc.steps:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Step table needs at least one row")
        rows = sorted(esc.steps, key=lambda r: r.start_on)
        out = []
        for i, r in enumerate(rows):
            e = r.end_on or (rows[i + 1].start_on - timedelta(days=1) if i + 1 < len(rows) else end)
            if r.annual_rent is not None:
                annual = r.annual_rent
            elif r.rent_psf is not None and sf:
                annual = r.rent_psf * sf
            else:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Each step needs annual rent or rent PSF (with SF)")
            out.append((r.start_on, e, annual, None))
        return out

    base = esc.base_annual_rent
    if base is None and esc.base_rent_psf is not None and sf:
        base = esc.base_rent_psf * sf
    if base is None:
        base = fallback_base
    if base is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Provide a base annual rent or rent PSF")

    def escalate(rent: float) -> tuple[float, str | None]:
        if esc.method == "fixed_pct":
            return rent * (1 + (esc.pct or 0) / 100), None
        if esc.method == "fixed_amount":
            return rent + (esc.amount or 0), None
        if esc.method == "cpi":
            rate = esc.cpi_assumed_pct if esc.cpi_assumed_pct is not None else 0.0
            if esc.cpi_floor_pct is not None:
                rate = max(rate, esc.cpi_floor_pct)
            if esc.cpi_cap_pct is not None:
                rate = min(rate, esc.cpi_cap_pct)
            return rent * (1 + rate / 100), f"CPI {rate:g}% (assumed; floor/cap applied)"
        return rent, None

    periods: list[tuple[date, date, float, str | None]] = []
    rent, note, s = base, None, start
    while s <= end and len(periods) < 600:
        e = min(add_months(s, esc.frequency_months) - timedelta(days=1), end)
        periods.append((s, e, rent, note))
        s = e + timedelta(days=1)
        rent, note = escalate(rent)

    if esc.free_rent_months:
        free_end = add_months(start, esc.free_rent_months) - timedelta(days=1)
        split: list[tuple[date, date, float, str | None]] = []
        for s, e, r, n in periods:
            if e <= free_end:
                split.append((s, e, 0.0, "Free rent"))
            elif s <= free_end:
                split.append((s, free_end, 0.0, "Free rent"))
                split.append((free_end + timedelta(days=1), e, r, n))
            else:
                split.append((s, e, r, n))
        periods = split
    return periods


async def generate_steps(db: AsyncSession, lease: Lease, esc: EscalationIn, actor: CurrentUser) -> list[RentStep]:
    vals, _ = await _operative(db, lease)
    start = esc.start_on or _as_date(vals.get("rent_commencement_on")) or _as_date(vals.get("commencement_on"))
    end = esc.end_on or _as_date(vals.get("expiration_on"))
    if not start or not end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Lease needs commencement and expiration dates")
    sf = _num(vals.get("rentable_sf"))
    periods = build_steps(esc, start=start, end=end, sf=sf, fallback_base=_num(vals.get("base_rent_annual")))
    removed = 0
    if esc.replace:
        for s in await all_steps(db, lease.id):
            if s.amendment_id is None:
                s.deleted_at = utcnow()
                s.updated_by_id = actor.id
                removed += 1
    created = []
    for s, e, annual, note in periods:
        step = _new_step(lease, start_on=s, end_on=e, annual=annual, sf=sf, source="generated", note=note, actor=actor)
        db.add(step)
        created.append(step)
    old = lease.escalation
    lease.escalation = esc.model_dump(mode="json", exclude={"replace"})
    lease.updated_by_id = actor.id
    await db.flush()
    await audit.record(db, actor=actor, action="lease.rent_schedule_generated", entity_type=ENTITY, entity_id=lease.id,
                       summary=f"{len(created)} steps ({esc.method})",
                       changes={"escalation": {"from": old, "to": lease.escalation}, "replaced_steps": removed},
                       ip_address=actor.ip_address)
    if lease.verified:
        await generate_critical_dates(db, lease, actor)
    await db.commit()
    return created


# --------------------------------------------------------------------------- amendment chain / operative terms

async def amendments(db: AsyncSession, lease_id: uuid.UUID) -> list[LeaseAmendment]:
    return list(await db.scalars(
        select(LeaseAmendment).where(LeaseAmendment.lease_id == lease_id, LeaseAmendment.deleted_at.is_(None))
        .order_by(LeaseAmendment.effective_on, LeaseAmendment.sequence)))


def _coerce_override(field: str, value: Any) -> Any:
    if field in DATE_FIELDS:
        return _as_date(value)
    if field in UUID_FIELDS and value:
        return uuid.UUID(str(value))
    return value


def _operative_steps(steps: list[RentStep], chain: list[LeaseAmendment]) -> list[tuple[RentStep, date]]:
    """Original steps, then each amendment's steps replace everything from its effective date onward."""
    current: list[tuple[RentStep, date]] = [(s, s.end_on) for s in steps if s.amendment_id is None]
    for a in chain:
        a_steps = [s for s in steps if s.amendment_id == a.id]
        if not a_steps:
            continue
        cut = min([a.effective_on] + [s.start_on for s in a_steps])
        kept = []
        for s, end in current:
            if s.start_on >= cut:
                continue
            kept.append((s, min(end, cut - timedelta(days=1))))
        current = kept + [(s, s.end_on) for s in a_steps]
    return sorted(current, key=lambda t: t[0].start_on)


async def _operative(db: AsyncSession, lease: Lease, as_of: date | None = None, verified_only: bool = False,
                     ) -> tuple[dict[str, Any], list[tuple[RentStep, date]]]:
    as_of = as_of or date.today()
    vals = {f: getattr(lease, f) for f in OVERRIDABLE_FIELDS | {"rent_commencement_on"}}
    chain = [a for a in await amendments(db, lease.id) if a.verified or not verified_only]
    for a in chain:
        if a.effective_on > as_of:
            continue
        for k, v in (a.overrides or {}).items():
            if k in OVERRIDABLE_FIELDS:
                vals[k] = _coerce_override(k, v)
    steps = _operative_steps(await all_steps(db, lease.id), chain)
    return vals, steps


def _rent_at(steps: list[tuple[RentStep, date]], on: date, fallback: Any = None) -> float | None:
    base = [(s, end) for s, end in steps if s.charge_type == "base_rent"]
    for s, end in base:
        if s.start_on <= on <= end:
            return float(s.annual_rent)
    # No schedule yet -> the abstracted base rent; a schedule that does not cover the date -> no rent.
    return None if base else _num(fallback)


def _step_out(s: RentStep, end: date) -> RentStepOut:
    return RentStepOut.model_validate(s, from_attributes=True).model_copy(update={"end_on": end})


async def operative_terms(db: AsyncSession, lease: Lease, as_of: date | None = None) -> OperativeTerms:
    as_of = as_of or date.today()
    chain = await amendments(db, lease.id)
    fields = {f: OperativeField(original=getattr(lease, f), operative=getattr(lease, f)) for f in sorted(OVERRIDABLE_FIELDS)}
    applied, pending = [], []
    for a in chain:
        if a.effective_on > as_of:
            pending.append(a.id)
            continue
        applied.append(a.id)
        for k, v in (a.overrides or {}).items():
            if k not in OVERRIDABLE_FIELDS:
                continue
            val = _coerce_override(k, v)
            fields[k] = OperativeField(original=fields[k].original, operative=val, changed=val != fields[k].original,
                                       amendment_id=a.id, amendment_title=a.title, effective_on=a.effective_on,
                                       verified=a.verified)
    steps = _operative_steps(await all_steps(db, lease.id), chain)
    return OperativeTerms(as_of=as_of, fields=fields, rent_steps=[_step_out(s, e) for s, e in steps],
                          amendments_applied=applied, pending_amendments=pending)


async def add_amendment(db: AsyncSession, lease: Lease, data: AmendmentIn, actor: CurrentUser) -> LeaseAmendment:
    bad = set(data.overrides) - OVERRIDABLE_FIELDS
    if bad:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Fields cannot be amended: {', '.join(sorted(bad))}")
    if "space_id" in data.overrides and data.overrides["space_id"]:
        await _check_space(db, lease.property_id, uuid.UUID(str(data.overrides["space_id"])))
    seq = int(await db.scalar(select(func.count()).select_from(LeaseAmendment)
                              .where(LeaseAmendment.lease_id == lease.id)) or 0) + 1
    a = LeaseAmendment(**data.model_dump(exclude={"rent_steps", "overrides"}), overrides=audit.to_jsonable(data.overrides),
                       lease_id=lease.id, sequence=seq, verified=False, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(a)
    await db.flush()
    for st in data.rent_steps:
        db.add(_new_step(lease, start_on=st.start_on, end_on=st.end_on, annual=st.annual_rent, sf=lease.rentable_sf,
                         rent_psf=st.rent_psf, source="amendment", amendment_id=a.id, note=st.note, actor=actor,
                         citation={"document_id": st.document_id or a.document_id, "page": st.page or a.page,
                                   "clause_ref": st.clause_ref or a.clause_ref, "quoted_text": st.quoted_text}))
    for k, v in data.overrides.items():
        if k in MATERIAL_FIELDS:
            await provenance.observe(db, entity_type=ENTITY, entity_id=lease.id, field=f"amended.{k}", value=v,
                                     prov=ProvenanceIn(source=f"{a.kind.replace('_', ' ').title()}: {a.title}",
                                                       observed_on=a.effective_on, confidence=0.9),
                                     actor_id=actor.id)
    await _link_document(db, a.document_id, lease.id, actor)
    await audit.record(db, actor=actor, action="lease.amendment_added", entity_type=ENTITY, entity_id=lease.id,
                       summary=f"{a.kind}: {a.title}", changes={"amendment_id": str(a.id), "overrides": a.overrides,
                                                                "rent_steps": len(data.rent_steps)},
                       ip_address=actor.ip_address)
    await events.emit(db, "lease.updated", lease_id=lease.id, property_id=lease.property_id,
                      changed={f"amendment.{k}" for k in data.overrides}, actor=actor)
    await db.commit()
    return a


async def verify_amendment(db: AsyncSession, a: LeaseAmendment, lease: Lease, verified: bool, actor: CurrentUser):
    a.verified = verified
    a.verified_by_id = actor.id if verified else None
    a.verified_at = utcnow() if verified else None
    a.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"lease.amendment_{'verified' if verified else 'unverified'}",
                       entity_type=ENTITY, entity_id=lease.id, summary=a.title, changes={"amendment_id": str(a.id)},
                       ip_address=actor.ip_address)
    if lease.verified:
        await generate_critical_dates(db, lease, actor)
        await _sync_space(db, lease, actor)
    await db.commit()
    return a


# --------------------------------------------------------------------------- public schedule (receivables)

def _iter_months(start: date, end: date):
    cur = date(start.year, start.month, 1)
    while cur <= end:
        yield cur, month_end(cur)
        cur = add_months(cur, 1)


def _prorated(monthly: float, m_start: date, m_end: date, p_start: date, p_end: date) -> float:
    days_in_month = (m_end - m_start).days + 1
    days = (p_end - p_start).days + 1
    return monthly if days == days_in_month else monthly * days / days_in_month


async def rent_schedule(db: AsyncSession, lease_id: uuid.UUID, verified_only: bool = False) -> list[dict]:
    """Monthly expected charges for a lease from its operative rent steps and recovery estimates.

    Returns [{period_start, period_end, amount, charge_type, lease_id, source_ref}]. With verified_only, only
    verified amendments and recoveries are used (what receivables bills from)."""
    lease = await db.get(Lease, lease_id)
    if not lease or lease.deleted_at:
        return []
    vals, steps = await _operative(db, lease, verified_only=verified_only)
    expiration = _as_date(vals.get("expiration_on"))
    rows: list[dict] = []
    for s, end in steps:
        end = min(end, expiration) if expiration else end
        for m_start, m_end in _iter_months(s.start_on, end):
            p_start, p_end = max(m_start, s.start_on), min(m_end, end)
            amount = round(_prorated(float(s.monthly_rent), m_start, m_end, p_start, p_end), 2)
            if amount == 0:
                continue
            rows.append({"period_start": p_start, "period_end": p_end, "amount": amount, "charge_type": s.charge_type,
                         "lease_id": lease.id,
                         "source_ref": {"rent_step_id": str(s.id),
                                        "amendment_id": str(s.amendment_id) if s.amendment_id else None}})
    start = _as_date(vals.get("rent_commencement_on")) or _as_date(vals.get("commencement_on"))
    if start and expiration:
        stmt = select(LeaseRecovery).where(LeaseRecovery.lease_id == lease.id, LeaseRecovery.deleted_at.is_(None))
        if verified_only:
            stmt = stmt.where(LeaseRecovery.verified.is_(True))
        for r in await db.scalars(stmt):
            if r.method == "fixed_cam" and r.fixed_amount_annual:
                monthly, ctype = float(r.fixed_amount_annual) / 12, "fixed_cam"
            elif r.estimated_monthly:
                monthly, ctype = float(r.estimated_monthly), ("recovery" if r.category == "all" else r.category)
            else:
                continue
            for m_start, m_end in _iter_months(start, expiration):
                p_start, p_end = max(m_start, start), min(m_end, expiration)
                rows.append({"period_start": p_start, "period_end": p_end,
                             "amount": round(_prorated(monthly, m_start, m_end, p_start, p_end), 2),
                             "charge_type": ctype, "lease_id": lease.id,
                             "source_ref": {"recovery_id": str(r.id), "method": r.method}})
    rows.sort(key=lambda r: (r["period_start"], r["charge_type"]))
    return rows


# --------------------------------------------------------------------------- critical dates (verified terms only)

async def generate_critical_dates(db: AsyncSession, lease: Lease, actor) -> tuple[int, int, bool]:
    """Upserts critical dates from VERIFIED terms only. Returns (generated, skipped_unverified, engine_available).
    Does not commit."""
    try:
        from app.modules.contracts.service import upsert_critical_date
    except ImportError:
        return 0, 0, False
    if not lease.verified:
        return 0, 1, True
    vals, steps = await _operative(db, lease, verified_only=True)
    tenant = vals.get("tenant_name") or lease.tenant_name
    today = date.today()
    generated, skipped = 0, 0

    async def put(date_type: str, label: str, due_on: date | None, key: str, lead_days: int = 14,
                  blocking: bool = False, cite: Any = None) -> None:
        nonlocal generated
        if not due_on:
            return
        citation = None
        if cite is not None and (cite.document_id or cite.page or cite.clause_ref):
            citation = {"document_id": cite.document_id, "page": cite.page, "clause_ref": cite.clause_ref,
                        "quoted_text": cite.quoted_text}
        await upsert_critical_date(db, related_type="lease", related_id=lease.id, date_type=date_type,
                                   label=label[:200], due_on=due_on, property_id=lease.property_id,
                                   owner_id=lease.manager_id, lead_days=lead_days, is_blocking=blocking,
                                   source="rule", status="confirmed", key=key, actor=actor,
                                   related_label=tenant, citation=citation)
        generated += 1

    await put("lease_expiration", f"{tenant} lease expiration", _as_date(vals.get("expiration_on")), "expiration", 180)
    prev = None
    for s, _end in steps:
        if s.charge_type != "base_rent":
            continue
        if prev is not None and s.start_on >= today and float(s.annual_rent) != prev:
            await put("rent_escalation", f"{tenant} rent step to ${float(s.annual_rent):,.0f}/yr", s.start_on,
                      f"escalation:{s.start_on.isoformat()}", 30)
        prev = float(s.annual_rent)

    for o in await list_children(db, LeaseOption, lease.id):
        if o.status != "open":
            continue
        if not o.verified:
            skipped += 1
            continue
        name = o.option_type.upper() if o.option_type in ("rofr", "rofo") else o.option_type
        await put("option_notice_deadline", f"{tenant} {name} option #{o.sequence} notice deadline", o.notice_end_on,
                  f"option:{o.id}:deadline", 60, blocking=True, cite=o)
        if o.notice_start_on and o.notice_start_on >= today:
            await put("option_notice_window", f"{tenant} {name} option #{o.sequence} notice window opens",
                      o.notice_start_on, f"option:{o.id}:opens", 30, cite=o)

    for c in await list_children(db, LeaseClause, lease.id):
        if c.category not in OBLIGATION_CATEGORIES or not c.due_on:
            continue
        if not c.verified:
            skipped += 1
            continue
        await put(c.category, f"{tenant}: {c.title}", c.due_on, f"clause:{c.id}", max(c.response_days or 14, 7), cite=c)

    for g in await list_children(db, Guaranty, lease.id):
        if g.status != "active":
            continue
        if not g.verified:
            skipped += 1
            continue
        await put("guaranty_expiration", f"{tenant} guaranty ({g.guarantor_name}) expires", g.expires_on,
                  f"guaranty:{g.id}:expires", 60, cite=g)
        if g.financials_required:
            await put("guarantor_financials", f"{g.guarantor_name} financial statements due", g.financials_due_on,
                      f"guaranty:{g.id}:financials", 14)
    return generated, skipped, True


# --------------------------------------------------------------------------- option economics

async def option_economics(db: AsyncSession, lease: Lease, o: LeaseOption, vals: dict,
                           steps: list[tuple[RentStep, date]]) -> OptionEconomics:
    today = date.today()
    sf = _num(o.pricing_params.get("sf") if o.pricing_params else None) or _num(vals.get("rentable_sf"))
    current = _rent_at(steps, today, vals.get("base_rent_annual"))
    cur_psf = _rent_psf(current, sf)
    market = _num(o.market_rent_psf) or _num(lease.market_rent_psf)
    eco = OptionEconomics(current_rent_psf=cur_psf, market_rent_psf=market)

    if o.option_type in ("renewal", "expansion"):
        opt_psf = None
        if o.pricing_method == "fixed_rent":
            opt_psf = _num(o.option_rent_psf)
        elif o.pricing_method == "fixed_increase" and cur_psf is not None:
            opt_psf = cur_psf * (1 + (o.increase_pct or 0) / 100)
        elif o.pricing_method == "fmv":
            opt_psf = market
        elif o.pricing_method == "pct_of_fmv" and market is not None:
            opt_psf = market * (o.fmv_pct or 100) / 100
        eco.option_rent_psf = round(opt_psf, 2) if opt_psf is not None else None
        if opt_psf is not None and market is not None:
            delta = market - opt_psf
            eco.delta_psf = round(delta, 2)
            if sf:
                eco.annual_delta = round(delta * sf, 2)
                eco.term_value = round(delta * sf * (o.term_months or 12) / 12, 2)
            eco.favors = "tenant" if delta > 0.005 else "landlord" if delta < -0.005 else "neutral"
            eco.note = ("Option rent is below market: renewal value accrues to the tenant" if eco.favors == "tenant"
                        else "Option rent is at or above market")
        else:
            eco.note = "Add market rent (PSF) and option pricing to compute economics"
    elif o.option_type == "termination":
        start = o.effective_on or today
        expiration = _as_date(vals.get("expiration_on"))
        remaining = 0.0
        if expiration:
            for s, end in steps:
                if s.charge_type != "base_rent":
                    continue
                a, b = max(s.start_on, start), min(end, expiration)
                if b >= a:
                    remaining += float(s.annual_rent) * ((b - a).days + 1) / 365.25
        eco.remaining_rent = round(remaining, 2)
        eco.fee_amount = _num(o.fee_amount)
        if eco.fee_amount is not None and remaining:
            eco.note = f"Termination fee covers {eco.fee_amount / remaining * 100:.0f}% of remaining base rent"
            eco.favors = "tenant" if eco.fee_amount < remaining else "landlord"
    elif o.option_type == "purchase":
        eco.purchase_price = _num(o.purchase_price)
        try:
            from app.modules.comps.service import latest_value

            v = await latest_value(db, lease.property_id)
            eco.market_value = _num(v.get("value_point")) if v else None
        except ImportError:
            pass
        if eco.purchase_price is not None and eco.market_value:
            eco.favors = "tenant" if eco.purchase_price < eco.market_value else "landlord"
            eco.note = f"Option price is {eco.purchase_price / eco.market_value * 100:.0f}% of the current mark"
    else:
        eco.note = "Right of first refusal / offer: priced at third-party or landlord terms; no fixed economics"
    return eco


# --------------------------------------------------------------------------- rent roll & rollover

async def _property_ids_for(db: AsyncSession, property_id: uuid.UUID | None, asset_id: uuid.UUID | None):
    if property_id:
        return [property_id]
    if asset_id:
        try:
            from app.modules.assets.models import Asset

            a = await db.get(Asset, asset_id)
            if a:
                return [a.property_id]
        except ImportError:
            pass
        ids = list(await db.scalars(select(Lease.property_id).where(Lease.asset_id == asset_id).distinct()))
        return ids or [uuid.uuid4()]
    return None


async def in_place_leases(db: AsyncSession, property_ids: list[uuid.UUID] | None, as_of: date) -> list[tuple]:
    """(lease, operative values, operative steps) for leases in place on `as_of`."""
    stmt = select(Lease).where(Lease.deleted_at.is_(None), Lease.status == "active")
    if property_ids is not None:
        stmt = stmt.where(Lease.property_id.in_(property_ids))
    out = []
    for lease in await db.scalars(stmt):
        vals, steps = await _operative(db, lease, as_of)
        start, end = _as_date(vals.get("commencement_on")), _as_date(vals.get("expiration_on"))
        if vals.get("status") not in (None, "active"):
            continue
        if (start and start > as_of) or (end and end < as_of):
            continue
        out.append((lease, vals, steps))
    return out


async def rent_roll(db: AsyncSession, property_id: uuid.UUID | None, asset_id: uuid.UUID | None,
                    as_of: date | None) -> RentRoll:
    from app.modules.parcels.models import Space
    from app.modules.properties.models import Property

    as_of = as_of or date.today()
    pids = await _property_ids_for(db, property_id, asset_id)
    leases = await in_place_leases(db, pids, as_of)
    prop_ids = list(set(pids or []) | {lease.property_id for lease, _, _ in leases})
    props = {p.id: p for p in await db.scalars(select(Property).where(Property.id.in_(prop_ids)))} if prop_ids else {}
    spaces = list(await db.scalars(select(Space).where(Space.property_id.in_(prop_ids), Space.deleted_at.is_(None)))) \
        if prop_ids else []
    space_by_id = {s.id: s for s in spaces}
    pname = lambda pid: (props[pid].name or props[pid].address_line) if pid in props else None  # noqa: E731

    rows: list[RentRollRow] = []
    used_spaces: set[uuid.UUID] = set()
    leased_sf = annual_total = wale_num = wale_sf_num = 0.0
    for lease, vals, steps in leases:
        sf = _num(vals.get("rentable_sf")) or 0.0
        rent = _rent_at(steps, as_of, vals.get("base_rent_annual")) or 0.0
        end = _as_date(vals.get("expiration_on"))
        remaining = _years_between(as_of, end) if end else None
        space_id = vals.get("space_id")
        if space_id:
            used_spaces.add(space_id)
        s = space_by_id.get(space_id) if space_id else None
        rows.append(RentRollRow(
            id=str(lease.id), lease_id=lease.id, property_id=lease.property_id, property_name=pname(lease.property_id),
            space_id=space_id, suite=s.suite if s else None, tenant_name=vals.get("tenant_name"),
            lease_type=vals.get("lease_type"), status="occupied", sf=sf or None, annual_rent=round(rent, 2),
            monthly_rent=round(rent / 12, 2), rent_psf=_rent_psf(rent, sf), commencement_on=_as_date(vals.get("commencement_on")),
            expiration_on=end, remaining_years=round(remaining, 2) if remaining is not None else None,
            verified=lease.verified,
        ))
        leased_sf += sf
        annual_total += rent
        if remaining is not None:
            wale_num += rent * remaining
            wale_sf_num += sf * remaining
    for s in spaces:
        if s.id in used_spaces:
            continue
        rows.append(RentRollRow(
            id=f"space:{s.id}", lease_id=None, property_id=s.property_id, property_name=pname(s.property_id),
            space_id=s.id, suite=s.suite, tenant_name=None, lease_type=None, status="vacant", sf=_num(s.area_sf),
            annual_rent=None, monthly_rent=None, rent_psf=None, commencement_on=None, expiration_on=None,
            remaining_years=None, verified=None,
        ))
    vacant_space_sf = sum(_num(s.area_sf) or 0 for s in spaces if s.id not in used_spaces)
    if spaces:
        total_sf = leased_sf + vacant_space_sf
    else:
        total_sf = sum(_num(p.building_area_sf) or 0 for p in props.values()) or leased_sf
    total_sf = max(total_sf, leased_sf)
    rows.sort(key=lambda r: (r.property_name or "", r.suite or "~", r.tenant_name or ""))
    wale = (wale_num / annual_total) if annual_total else ((wale_sf_num / leased_sf) if leased_sf else None)
    return RentRoll(
        property_id=property_id, as_of=as_of, rows=rows,
        totals=RentRollTotals(
            leased_sf=round(leased_sf, 2), vacant_sf=round(max(total_sf - leased_sf, 0), 2), total_sf=round(total_sf, 2),
            occupancy_pct=round(leased_sf / total_sf * 100, 2) if total_sf else None,
            annual_rent=round(annual_total, 2), monthly_rent=round(annual_total / 12, 2),
            avg_rent_psf=_rent_psf(annual_total, leased_sf), wale_years=round(wale, 2) if wale is not None else None,
            tenant_count=len(leases),
        ),
    )


async def rollover(db: AsyncSession, property_id: uuid.UUID | None, asset_id: uuid.UUID | None, years: int,
                   as_of: date | None) -> Rollover:
    as_of = as_of or date.today()
    leases = await in_place_leases(db, await _property_ids_for(db, property_id, asset_id), as_of)
    total_rent = 0.0
    buckets: dict[int, dict] = {}
    for lease, vals, steps in leases:
        rent = _rent_at(steps, as_of, vals.get("base_rent_annual")) or 0.0
        total_rent += rent
        end = _as_date(vals.get("expiration_on"))
        if not end or end.year > as_of.year + years - 1:
            continue
        sf = _num(vals.get("rentable_sf")) or 0.0
        p = lease.renewal_probability if lease.renewal_probability is not None else DEFAULT_RENEWAL_PROBABILITY
        downtime = lease.downtime_months if lease.downtime_months is not None else DEFAULT_DOWNTIME_MONTHS
        b = buckets.setdefault(end.year, {"n": 0, "sf": 0.0, "rent": 0.0, "p_rent": 0.0, "down": 0.0, "re": 0.0, "ids": []})
        b["n"] += 1
        b["sf"] += sf
        b["rent"] += rent
        b["p_rent"] += p * rent
        b["down"] += rent * (1 - p) * downtime / 12
        b["re"] += sf * (_num(lease.releasing_cost_psf) or 0) * (1 - p)
        b["ids"].append(lease.id)
    out = []
    for y in range(as_of.year, as_of.year + years):
        b = buckets.get(y)
        if not b:
            out.append(RolloverYear(year=y, lease_count=0, sf=0, rent_at_risk=0, pct_of_rent=0, renewal_probability=None,
                                    expected_downtime_cost=0, expected_releasing_cost=0, lease_ids=[]))
            continue
        out.append(RolloverYear(
            year=y, lease_count=b["n"], sf=round(b["sf"], 2), rent_at_risk=round(b["rent"], 2),
            pct_of_rent=round(b["rent"] / total_rent * 100, 2) if total_rent else 0,
            renewal_probability=round(b["p_rent"] / b["rent"], 3) if b["rent"] else None,
            expected_downtime_cost=round(b["down"], 2), expected_releasing_cost=round(b["re"], 2), lease_ids=b["ids"],
        ))
    return Rollover(property_id=property_id, as_of=as_of, total_rent=round(total_rent, 2), years=out)


async def for_underwriting(db: AsyncSession, property_id: uuid.UUID) -> dict:
    """Compact, verified-aware lease payload for underwriting / valuation / reporting."""
    roll = await rent_roll(db, property_id, None, None)
    tenants = []
    for lease, vals, steps in await in_place_leases(db, [property_id], date.today()):
        rec = await list_children(db, LeaseRecovery, lease.id)
        opts = await list_children(db, LeaseOption, lease.id)
        rent = _rent_at(steps, date.today(), vals.get("base_rent_annual"))
        tenants.append({
            "lease_id": str(lease.id), "tenant_name": vals.get("tenant_name"), "lease_type": vals.get("lease_type"),
            "sf": _num(vals.get("rentable_sf")), "commencement_on": _as_date(vals.get("commencement_on")),
            "expiration_on": _as_date(vals.get("expiration_on")), "current_annual_rent": rent,
            "rent_psf": _rent_psf(rent, _num(vals.get("rentable_sf"))), "verified": lease.verified,
            "steps": [{"start_on": s.start_on, "end_on": e, "annual_rent": float(s.annual_rent)}
                      for s, e in steps if s.charge_type == "base_rent"],
            "escalation": lease.escalation or {},
            "recoveries": [{"method": r.method, "category": r.category, "pro_rata_share": r.pro_rata_share,
                            "base_amount": r.base_amount, "cap_type": r.cap_type, "cap_pct": r.cap_pct,
                            "verified": r.verified} for r in rec],
            "options": [{"type": o.option_type, "term_months": o.term_months, "notice_end_on": o.notice_end_on,
                         "pricing_method": o.pricing_method, "option_rent_psf": o.option_rent_psf,
                         "status": o.status, "verified": o.verified} for o in opts],
            "market_rent_psf": lease.market_rent_psf,
            "renewal_probability": lease.renewal_probability if lease.renewal_probability is not None
            else DEFAULT_RENEWAL_PROBABILITY,
            "downtime_months": lease.downtime_months if lease.downtime_months is not None else DEFAULT_DOWNTIME_MONTHS,
            "releasing_cost_psf": lease.releasing_cost_psf,
        })
    t = roll.totals
    return {
        "property_id": str(property_id), "as_of": roll.as_of, "rentable_sf": t.total_sf, "leased_sf": t.leased_sf,
        "occupancy_pct": t.occupancy_pct, "wale_years": t.wale_years, "in_place_rent": t.annual_rent,
        "avg_rent_psf": t.avg_rent_psf, "all_verified": all(x["verified"] for x in tenants), "tenants": tenants,
    }


# --------------------------------------------------------------------------- recovery reconciliation

def _pool_for(pool: dict[str, float], category: str, exclusions: list[str]) -> tuple[float, dict[str, float]]:
    excluded = {}
    total = 0.0
    for key, amount in pool.items():
        top = key.split(":", 1)[0]
        if category != "all" and top != category:
            continue
        if key in exclusions or top in exclusions:
            excluded[key] = amount
            continue
        total += float(amount or 0)
    return total, excluded


def _tenant_amount(r: LeaseRecovery, pool: float, share: float, sf: float, total_sf: float) -> float:
    if r.method == "fixed_cam":
        return float(r.fixed_amount_annual or 0)
    if r.method in ("base_year", "modified_gross"):
        return max(0.0, pool - float(r.base_amount or 0)) * share / 100
    if r.method == "expense_stop":
        pool_psf = pool / total_sf if total_sf else 0
        return max(0.0, pool_psf - float(r.expense_stop_psf or 0)) * sf
    return pool * share / 100


async def _billed_recoveries(db: AsyncSession, lease_id: uuid.UUID, year: int) -> float | None:
    try:
        from app.modules.receivables.models import Charge
    except ImportError:
        return None
    total = await db.scalar(
        select(func.coalesce(func.sum(Charge.amount), 0)).where(
            Charge.lease_id == lease_id, Charge.deleted_at.is_(None), Charge.status.notin_(["void", "pending_approval"]),
            Charge.charge_type.in_(RECOVERY_CHARGE_TYPES), Charge.period_start >= date(year, 1, 1),
            Charge.period_start <= date(year, 12, 31)))
    return float(total or 0)


async def run_reconciliation(db: AsyncSession, data: ReconRunIn, actor: CurrentUser) -> tuple[list, int, int, int]:
    from app.modules.parcels.models import Space
    from app.modules.properties import service as property_service

    prop = await property_service.get(db, data.property_id)
    y0, y1 = date(data.year, 1, 1), date(data.year, 12, 31)
    total_sf = data.total_sf
    if not total_sf:
        total_sf = float(await db.scalar(select(func.coalesce(func.sum(Space.area_sf), 0)).where(
            Space.property_id == prop.id, Space.deleted_at.is_(None))) or 0) or (_num(prop.building_area_sf) or 0)
    stmt = select(Lease).where(Lease.property_id == prop.id, Lease.deleted_at.is_(None),
                               Lease.status.in_(["active", "expired", "terminated"]),
                               or_(Lease.commencement_on.is_(None), Lease.commencement_on <= y1),
                               or_(Lease.expiration_on.is_(None), Lease.expiration_on >= y0))
    if data.lease_ids:
        stmt = stmt.where(Lease.id.in_(data.lease_ids))
    items, created, updated, locked = [], 0, 0, 0
    for lease in await db.scalars(stmt):
        rec = await db.scalar(select(RecoveryReconciliation).where(
            RecoveryReconciliation.lease_id == lease.id, RecoveryReconciliation.year == data.year,
            RecoveryReconciliation.deleted_at.is_(None)))
        if rec and rec.status != "draft":
            locked += 1
            items.append(rec)
            continue
        vals, _ = await _operative(db, lease, y1)
        sf = _num(vals.get("rentable_sf")) or 0.0
        start = max(_as_date(vals.get("commencement_on")) or y0, y0)
        end = min(_as_date(vals.get("expiration_on")) or y1, y1)
        occupancy_factor = max(0.0, ((end - start).days + 1) / ((y1 - y0).days + 1))
        details, actual_total, budget_total, cap_total = [], 0.0, 0.0, 0.0
        prior = await db.scalar(select(RecoveryReconciliation).where(
            RecoveryReconciliation.lease_id == lease.id, RecoveryReconciliation.year == data.year - 1,
            RecoveryReconciliation.deleted_at.is_(None)))
        prior_caps = {d.get("recovery_id"): d.get("capped_amount") for d in (prior.details if prior else [])}
        share_used = None
        for r in await list_children(db, LeaseRecovery, lease.id):
            if not r.verified:
                details.append({"recovery_id": str(r.id), "method": r.method, "category": r.category,
                                "skipped": "Recovery terms are not verified"})
                continue
            share = r.pro_rata_share or _num(vals.get("pro_rata_share")) or (sf / total_sf * 100 if total_sf else 0)
            share_used = share
            pool, excluded = _pool_for(data.actual, r.category, r.exclusions or [])
            bpool, _ = _pool_for(data.budgeted, r.category, r.exclusions or [])
            gross = _tenant_amount(r, pool, share, sf, total_sf)
            budget = _tenant_amount(r, bpool, share, sf, total_sf)
            admin = (r.admin_fee_pct or 0) / 100
            gross, budget = gross * (1 + admin), budget * (1 + admin)
            allowed, reduction = None, 0.0
            if r.cap_type != "none" and r.cap_pct is not None:
                cap = r.cap_pct / 100
                n = data.year - (r.cap_base_year or data.year)
                if r.cap_type == "non_cumulative" and prior_caps.get(str(r.id)) is not None:
                    # Non-cumulative: capped against last year's (capped) recoverable amount.
                    allowed = float(prior_caps[str(r.id)]) * (1 + cap)
                elif r.cap_base_amount is not None:
                    allowed = float(r.cap_base_amount) * (1 + cap) ** max(n, 0)
                if allowed is not None and gross > allowed:
                    reduction = gross - allowed
                    gross = allowed
                if allowed is not None:
                    budget = min(budget, allowed)
            amount = gross * occupancy_factor
            budget_amt = budget * occupancy_factor
            details.append({
                "recovery_id": str(r.id), "method": r.method, "category": r.category, "pool": round(pool, 2),
                "excluded": excluded, "share_pct": round(share, 4), "admin_fee_pct": r.admin_fee_pct,
                "cap_type": r.cap_type, "cap_pct": r.cap_pct, "cap_allowed": round(allowed, 2) if allowed is not None else None,
                "cap_reduction": round(reduction * occupancy_factor, 2), "capped_amount": round(gross, 2),
                "occupancy_factor": round(occupancy_factor, 4), "tenant_amount": round(amount, 2),
                "budget_amount": round(budget_amt, 2),
            })
            actual_total += amount
            budget_total += budget_amt
            cap_total += reduction * occupancy_factor
        billed = await _billed_recoveries(db, lease.id, data.year)
        if billed is None or billed == 0:
            billed = sum(float(r.estimated_monthly or 0) * 12 * occupancy_factor
                         for r in await list_children(db, LeaseRecovery, lease.id) if r.verified)
        values = dict(budgeted_pool=data.budgeted, actual_pool=data.actual, share_pct=share_used,
                      budgeted_share=round(budget_total, 2), actual_share=round(actual_total, 2),
                      cap_reduction=round(cap_total, 2), estimates_billed=round(billed, 2),
                      true_up_amount=round(actual_total - billed, 2), details=details)
        if rec:
            changes = audit.diff(rec, values)
            for k, v in values.items():
                setattr(rec, k, v)
            rec.updated_by_id = actor.id
            updated += 1
        else:
            rec = RecoveryReconciliation(lease_id=lease.id, property_id=prop.id, year=data.year, status="draft",
                                         created_by_id=actor.id, updated_by_id=actor.id, **values)
            db.add(rec)
            await db.flush()
            changes = {"true_up_amount": {"from": None, "to": rec.true_up_amount}}
            created += 1
        await audit.record(db, actor=actor, action="lease.reconciliation_computed", entity_type=ENTITY,
                           entity_id=lease.id, summary=f"{data.year} true-up {rec.true_up_amount:,.2f}",
                           changes={"reconciliation_id": str(rec.id), **changes}, ip_address=actor.ip_address)
        items.append(rec)
    await db.commit()
    return items, created, updated, locked


async def finalize_reconciliation(db: AsyncSession, rec: RecoveryReconciliation, actor: CurrentUser):
    if rec.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft reconciliations can be finalized")
    rec.status = "final"
    rec.finalized_by_id = actor.id
    rec.finalized_at = utcnow()
    rec.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="lease.reconciliation_finalized", entity_type=ENTITY,
                       entity_id=rec.lease_id, summary=f"{rec.year} true-up {rec.true_up_amount:,.2f}",
                       changes={"reconciliation_id": str(rec.id)}, ip_address=actor.ip_address)
    await events.emit(db, "lease.reconciliation_finalized", reconciliation_id=rec.id, lease_id=rec.lease_id,
                      year=rec.year, true_up_amount=rec.true_up_amount, actor=actor)
    await db.commit()
    return rec


def mark_reconciliation_billed(rec: RecoveryReconciliation, charge_id: uuid.UUID, actor) -> None:
    """Called by receivables when the true-up charge is created. Does not commit."""
    rec.status = "billed"
    rec.billed_charge_id = charge_id
    rec.updated_by_id = getattr(actor, "id", None)


# --------------------------------------------------------------------------- documents / AI extraction

async def document_url(db: AsyncSession, document_id: uuid.UUID, page: int | None, user: CurrentUser) -> str:
    """Short-lived link to the cited page. Access rules (sensitivity) are enforced by the documents module."""
    try:
        from app.modules.documents import service as doc_service
    except ImportError:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Document storage is not available")
    d = await doc_service.get(db, document_id, user)
    url = doc_service.signed_url(d.id, 10, user_id=user.id, inline=doc_service.can_inline(d.mime_type))
    if inspect.isawaitable(url):
        url = await url
    return f"{url}#page={page}" if page else str(url)


_EXTRACTED = table(
    "extracted_values", column("id"), column("document_id"), column("target_entity_type"), column("target_entity_id"),
    column("field"), column("value"), column("page"), column("clause"), column("citation_text"), column("confidence"),
    column("status"), column("deleted_at"),
)


async def import_extractions(db: AsyncSession, lease: Lease, actor: CurrentUser) -> dict:
    """Pull AI-extracted values for this lease from documents. Everything lands unverified with its citation."""
    try:
        async with db.begin_nested():
            rows = (await db.execute(select(_EXTRACTED).where(
                _EXTRACTED.c.target_entity_type == "lease", _EXTRACTED.c.target_entity_id == lease.id,
                _EXTRACTED.c.status.in_(["pending", "confirmed", "edited"]),
                _EXTRACTED.c.deleted_at.is_(None)))).mappings().all()
    except Exception:  # documents module/table not present yet
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Document extraction is not available")
    fields_set, clauses_added = 0, 0
    citations = dict(lease.citations or {})
    existing = {(c.category, (c.quoted_text or "")[:200]) for c in await list_children(db, LeaseClause, lease.id)}
    for r in rows:
        raw = r["value"]
        value = raw.get("value") if isinstance(raw, dict) and "value" in raw else raw
        cite = {"document_id": str(r["document_id"]) if r["document_id"] else None, "page": r["page"],
                "clause_ref": (r["clause"] or None) and str(r["clause"])[:80], "quoted_text": r["citation_text"]}
        field = str(r["field"])
        conf = float(r["confidence"]) if r["confidence"] is not None else 0.5
        if field in MATERIAL_FIELDS and field != "status":
            if field in DATE_FIELDS:
                value = _as_date(value)
            prov = ProvenanceIn(source="AI extraction", confidence=conf, ai_derived=True)
            if await provenance.apply_material(db, lease, entity_type=ENTITY, data={field: value},
                                               material_fields=MATERIAL_FIELDS, prov=prov, actor_id=actor.id):
                fields_set += 1
            citations[field] = cite
        elif field.startswith("clause."):
            category = field.split(".", 1)[1] or "other"
            if (category, (r["citation_text"] or "")[:200]) in existing:
                continue
            db.add(LeaseClause(lease_id=lease.id, category=category[:30], title=category.replace("_", " ").title(),
                               summary=str(value) if value is not None else None, ai_extracted=True, confidence=conf,
                               verified=False, document_id=r["document_id"], page=r["page"], clause_ref=cite["clause_ref"],
                               quoted_text=r["citation_text"], created_by_id=actor.id, updated_by_id=actor.id))
            clauses_added += 1
    if fields_set or clauses_added:
        lease.citations = citations
        lease.ai_extracted = True
        if fields_set:
            lease.verified = False
            lease.verified_by_id = None
            lease.verified_at = None
        lease.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="lease.extractions_imported", entity_type=ENTITY, entity_id=lease.id,
                           summary=f"{fields_set} terms, {clauses_added} clauses (unverified)",
                           ip_address=actor.ip_address)
    await db.commit()
    return {"fields": fields_set, "clauses": clauses_added}


async def space_options(db: AsyncSession, property_id: uuid.UUID) -> list:
    from app.modules.parcels.models import Space

    return list(await db.scalars(select(Space).where(Space.property_id == property_id, Space.deleted_at.is_(None))
                                 .order_by(Space.suite)))


__all__ = ["rent_schedule", "generate_critical_dates", "mark_reconciliation_billed"]
