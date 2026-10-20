"""Comparables & valuation (spec module 13).

Rules implemented here:
- Verification method, verifying user and date are stored on every comp; editing a material fact of a verified
  comp returns it to `unverified` (the change and the prior verification stay in the audit trail).
- Excluding a comp from a set requires a reason; the reason and every include/exclude decision are retained.
- Indicated values are ranges (low / high / point with the method used), never a bare single number.
- Valuations and portfolio marks are append-only, dated records with method and analyst; nothing overwrites them.
- Material valuation assumptions carry evidence (comp ids, document id or a source); marks with unsourced
  material assumptions are refused.
"""
import math
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any

from fastapi import HTTPException, status
from geoalchemy2 import Geography
from geoalchemy2.elements import WKTElement
from sqlalchemy import Float, Select, cast, func, null, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter, range_filter
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.comps.models import (
    ADJUSTMENT_FACTORS,
    LEASE_BASES,
    SALE_BASES,
    Bov,
    CompSet,
    CompSetItem,
    LeaseComp,
    SaleComp,
    Valuation,
    ValuationDocument,
)
from app.modules.comps.schemas import (
    AddItemsIn,
    BovCreate,
    BovUpdate,
    CompSetCreate,
    CompSetItemOut,
    CompSetListItem,
    CompSetOut,
    CompSetUpdate,
    FromCompSetIn,
    GridIn,
    ItemUpdate,
    LeaseCompCreate,
    LeaseCompUpdate,
    SaleCompCreate,
    SaleCompUpdate,
    ValuationCreate,
    ValuationDocumentIn,
    VerificationIn,
)

MILES = 1609.344
SALE_MATERIAL = {"sale_date", "sale_price", "price_psf", "price_per_acre", "cap_rate", "noi", "building_area_sf",
                 "land_area_acres", "lease_term_remaining_years", "tenant_credit"}
LEASE_MATERIAL = {"commencement_on", "term_months", "area_sf", "base_rent_psf", "escalation_pct", "recoveries_psf",
                  "free_rent_months", "ti_psf", "effective_rent_psf", "recovery_type"}
VALUATION_MATERIAL = {
    "direct_cap": ["noi", "cap_rate"],
    "dcf": ["discount_rate", "noi_year1", "growth_pct", "exit_cap"],
    "land_residual": ["gross_development_value", "development_costs", "soft_costs", "developer_profit_pct"],
    "sales_comparison": [],
    "appraisal": [],
    "bov": [],
}


# --------------------------------------------------------------------------- pure helpers


def haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in miles: 2·R·asin(√(sin²(Δφ/2) + cosφ1·cosφ2·sin²(Δλ/2))), R = 3958.8 mi."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(a))


def effective_rent_psf(base_psf: float | None, term_months: int | None, escalation_pct: float | None,
                       free_months: float | None, ti_psf: float | None) -> float | None:
    """Effective rent ($/SF/yr) = (Σ contract rent over the term − free rent − TI) / term years.

    Contract rent for lease month m (0-based) = base_psf / 12 × (1 + escalation)^⌊m/12⌋; free rent removes the first
    `free_months` months at the starting rate; TI is a landlord cost per SF.
    """
    if not base_psf or not term_months:
        return None
    g = (escalation_pct or 0) / 100
    total = sum(base_psf / 12 * (1 + g) ** (m // 12) for m in range(int(term_months)))
    total -= base_psf / 12 * min(float(free_months or 0), float(term_months))
    total -= ti_psf or 0
    return round(total / (term_months / 12), 2)


def sale_metric(c: SaleComp, basis: str) -> float | None:
    """Base metric of a sale comp for the set's value basis (derived from price/area/NOI when not stored)."""
    if basis == "price_psf":
        return c.price_psf or (c.sale_price / c.building_area_sf if c.sale_price and c.building_area_sf else None)
    if basis == "price_per_acre":
        return c.price_per_acre or (c.sale_price / c.land_area_acres if c.sale_price and c.land_area_acres else None)
    if basis == "cap_rate":
        return c.cap_rate or (c.noi / c.sale_price * 100 if c.noi and c.sale_price else None)
    return c.sale_price


def lease_metric(c: LeaseComp, basis: str) -> float | None:
    if basis == "base_rent_psf":
        return c.base_rent_psf
    return c.effective_rent_psf or effective_rent_psf(c.base_rent_psf, c.term_months, c.escalation_pct,
                                                      c.free_rent_months, c.ti_psf)


def adjust(base: float | None, adjustments: dict[str, float]) -> tuple[float, float | None]:
    """Net adjustment = Σ factor % (location, size, age, condition, lease term, tenant credit, timing);
    adjusted metric = base × (1 + net / 100). Positive = subject superior to the comp."""
    net = sum(float(adjustments.get(f) or 0) for f in ADJUSTMENT_FACTORS)
    return net, (base * (1 + net / 100) if base is not None else None)


def metric_to_value(metric: float | None, basis: str, qty: float | None) -> float | None:
    """Convert an adjusted metric to subject value: cap rate → NOI / cap; price → metric; else metric × quantity."""
    if metric is None:
        return None
    if basis == "cap_rate":
        return qty / (metric / 100) if qty and metric > 0 else None
    if basis == "price":
        return metric
    return metric * qty if qty else None


def indicated_range(rows: list[tuple[float, float]], basis: str, qty: float | None) -> dict[str, Any]:
    """Indicated range from included comps' adjusted metrics with weights w:
    low = min, high = max, point = Σ w·m / Σ w. For cap rates the value range inverts (high cap → low value)."""
    rows = [(m, w) for m, w in rows if m is not None]
    if not rows:
        return {"count": 0, "basis": basis, "subject_quantity": qty, "metric_low": None, "metric_high": None,
                "metric_point": None, "value_low": None, "value_high": None, "value_point": None,
                "method": "No included comps with a usable metric"}
    metrics = [m for m, _ in rows]
    weights = [max(0.0, w or 0.0) for _, w in rows]
    if sum(weights) <= 0:
        weights = [1.0] * len(rows)
    point = sum(m * w for m, w in zip(metrics, weights)) / sum(weights)
    lo, hi = min(metrics), max(metrics)
    v_lo, v_hi, v_pt = metric_to_value(lo, basis, qty), metric_to_value(hi, basis, qty), metric_to_value(point, basis, qty)
    if basis == "cap_rate":
        v_lo, v_hi = v_hi, v_lo
    return {"count": len(rows), "basis": basis, "subject_quantity": qty, "metric_low": lo, "metric_high": hi,
            "metric_point": point, "value_low": v_lo, "value_high": v_hi, "value_point": v_pt,
            "method": "Weighted mean of adjusted comps; range is the min–max adjusted comp"}


def direct_cap(noi: float, cap: float, cap_low: float | None, cap_high: float | None) -> dict[str, Any]:
    """Direct capitalization: value = NOI / cap. Range uses cap_high → low value and cap_low → high value
    (± 25 bps around the point cap when no range is given)."""
    if not noi or not cap or cap <= 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Direct cap needs NOI and a positive cap rate")
    cap_low = cap_low if cap_low and cap_low > 0 else max(0.01, cap - 0.25)
    cap_high = cap_high if cap_high and cap_high > 0 else cap + 0.25
    return {"value_point": noi / (cap / 100), "value_low": noi / (cap_high / 100), "value_high": noi / (cap_low / 100),
            "calculation": {"formula": "NOI / cap rate", "noi": noi, "cap_rate": cap, "cap_low": cap_low, "cap_high": cap_high}}


def dcf_value(cfs: list[float], rate: float, rate_low: float | None, rate_high: float | None) -> dict[str, Any]:
    """DCF: value = Σ_{t=1..n} CF_t / (1 + r)^t, CF_n including net reversion. Range from the discount-rate range
    (± 50 bps when not given): higher rate → lower value."""
    if not cfs or rate is None or rate <= -100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "DCF needs cash flows and a discount rate")

    def pv(r: float) -> float:
        return sum(cf / (1 + r / 100) ** (t + 1) for t, cf in enumerate(cfs))

    rate_low = rate_low if rate_low is not None else rate - 0.5
    rate_high = rate_high if rate_high is not None else rate + 0.5
    if min(rate_low, rate_high) <= -100:  # (1 + r)^t = 0 → division by zero
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Discount rate range must be above -100%")
    return {"value_point": pv(rate), "value_low": pv(rate_high), "value_high": pv(rate_low),
            "calculation": {"formula": "Σ CF_t / (1 + r)^t", "cash_flows": [round(c, 2) for c in cfs],
                            "discount_rate": rate, "rate_low": rate_low, "rate_high": rate_high}}


def simple_dcf_flows(noi1: float, growth_pct: float, hold: int, exit_cap: float, selling_pct: float) -> list[float]:
    """CF_t = NOI₁ × (1 + g)^(t−1) for t = 1..n; reversion at n = NOI₁ × (1 + g)^n / exit cap × (1 − selling %)."""
    g = growth_pct / 100
    cfs = [noi1 * (1 + g) ** (t - 1) for t in range(1, hold + 1)]
    if exit_cap > 0 and cfs:
        cfs[-1] += noi1 * (1 + g) ** hold / (exit_cap / 100) * (1 - selling_pct / 100)
    return cfs


def land_residual(gdv: float, dev: float, soft: float, carry: float, profit_pct: float,
                  gdv_low: float | None, gdv_high: float | None) -> dict[str, Any]:
    """Land residual = GDV − hard costs − soft costs − carry − developer profit (profit % × GDV).
    Range from the GDV range (± 5% when not given)."""
    def residual(g: float) -> float:
        return g - dev - soft - carry - g * profit_pct / 100

    gdv_low = gdv_low if gdv_low else gdv * 0.95
    gdv_high = gdv_high if gdv_high else gdv * 1.05
    return {"value_point": residual(gdv), "value_low": residual(gdv_low), "value_high": residual(gdv_high),
            "calculation": {"formula": "GDV − hard − soft − carry − profit% × GDV", "gdv": gdv, "development_costs": dev,
                            "soft_costs": soft, "carry_costs": carry, "developer_profit_pct": profit_pct,
                            "gdv_low": gdv_low, "gdv_high": gdv_high}}


# --------------------------------------------------------------------------- shared lookups


async def _user_names(db: AsyncSession, ids: set) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))
    return {r[0]: r[1] for r in rows.all()}


async def _property_labels(db: AsyncSession, ids: set) -> dict[uuid.UUID, str]:
    from app.modules.properties.models import Property

    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(Property.id, Property.name, Property.address_line).where(Property.id.in_(ids)))
    return {r[0]: r[1] or r[2] for r in rows.all()}


async def _get_property(db: AsyncSession, property_id: uuid.UUID):
    from app.modules.properties.models import Property

    p = await db.get(Property, property_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    return p


def _set_location(c: SaleComp | LeaseComp) -> None:
    c.location = WKTElement(f"POINT({c.longitude} {c.latitude})", srid=4326) if c.latitude is not None and c.longitude is not None else None


async def _link_document(db: AsyncSession, document_id: uuid.UUID | None, entity_type: str, entity_id: uuid.UUID,
                         actor: CurrentUser) -> None:
    """Link a document via the documents module when it is installed (built concurrently; optional)."""
    if not document_id:
        return
    try:
        from app.modules.documents import service as documents_service
    except ImportError:
        return
    link = getattr(documents_service, "link", None)
    if link is not None:
        await link(db, document_id, entity_type, entity_id, actor)


# --------------------------------------------------------------------------- comps CRUD

COMP_MODELS: dict[str, Any] = {"sale": SaleComp, "lease": LeaseComp}


@dataclass
class CompFilters:
    q: str | None = None
    property_type: list[str] | None = None
    verification_status: list[str] | None = None
    tenant_credit: list[str] | None = None
    state: list[str] | None = None
    county: str | None = None
    corridor: str | None = None
    property_id: uuid.UUID | None = None
    date_from: date | None = None
    date_to: date | None = None
    min_price: float | None = None
    max_price: float | None = None
    min_cap: float | None = None
    max_cap: float | None = None
    min_rent: float | None = None
    max_rent: float | None = None


def build_comp_query(kind: str, f: CompFilters, *, skip: set[str] = frozenset()) -> Select:
    M = COMP_MODELS[kind]
    stmt = select(M).where(M.deleted_at.is_(None))
    cols = [M.name, M.address_line, M.city, M.county, M.corridor, M.tenant_name, M.source]
    if kind == "sale":
        cols += [SaleComp.buyer_name, SaleComp.seller_name]
    stmt = apply_search(stmt, f.q, cols)
    for key in ("property_type", "verification_status", "tenant_credit", "state"):
        if key not in skip:
            stmt = in_filter(stmt, getattr(M, key), getattr(f, key))
    if f.county:
        stmt = stmt.where(M.county.ilike(f"%{f.county}%"))
    if f.corridor:
        stmt = stmt.where(M.corridor.ilike(f"%{f.corridor}%"))
    if f.property_id:
        stmt = stmt.where(M.property_id == f.property_id)
    if kind == "sale":
        stmt = range_filter(stmt, SaleComp.sale_date, f.date_from, f.date_to)
        stmt = range_filter(stmt, SaleComp.sale_price, f.min_price, f.max_price)
        stmt = range_filter(stmt, SaleComp.cap_rate, f.min_cap, f.max_cap)
    else:
        stmt = range_filter(stmt, LeaseComp.commencement_on, f.date_from, f.date_to)
        stmt = range_filter(stmt, LeaseComp.base_rent_psf, f.min_rent, f.max_rent)
    return stmt


async def get_comp(db: AsyncSession, kind: str, comp_id: uuid.UUID):
    c = await db.get(COMP_MODELS[kind], comp_id)
    if not c or c.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comp not found")
    return c


async def comp_out(db: AsyncSession, kind: str, rows: list) -> list[dict]:
    from app.modules.comps.schemas import LeaseCompOut, SaleCompOut

    names = await _user_names(db, {r.verified_by_id for r in rows})
    labels = await _property_labels(db, {r.property_id for r in rows})
    schema = SaleCompOut if kind == "sale" else LeaseCompOut
    out = []
    for r in rows:
        o = schema.model_validate(r)
        o.verified_by_name = names.get(r.verified_by_id) if r.verified_by_id else None
        o.property_label = labels.get(r.property_id) if r.property_id else None
        out.append(o)
    return out


async def _fill_from_property(db: AsyncSession, c: SaleComp | LeaseComp) -> None:
    """Comps linked to a known property inherit its location and physical facts when not given."""
    if not c.property_id:
        return
    p = await _get_property(db, c.property_id)
    for field in ("address_line", "city", "state", "county", "corridor", "latitude", "longitude", "property_type",
                  "building_area_sf", "land_area_acres", "year_built"):
        if getattr(c, field) in (None, "") and getattr(p, field, None) not in (None, ""):
            setattr(c, field, getattr(p, field))
    if not c.name:
        c.name = p.name


def _derive(kind: str, c: SaleComp | LeaseComp) -> None:
    if kind == "sale":
        if c.sale_price and c.building_area_sf and not c.price_psf:
            c.price_psf = round(c.sale_price / c.building_area_sf, 2)
        if c.sale_price and c.land_area_acres and not c.price_per_acre:
            c.price_per_acre = round(c.sale_price / c.land_area_acres, 2)
        if c.sale_price and c.noi and not c.cap_rate:
            c.cap_rate = round(c.noi / c.sale_price * 100, 3)
    else:
        if c.effective_rent_psf is None:
            c.effective_rent_psf = effective_rent_psf(c.base_rent_psf, c.term_months, c.escalation_pct,
                                                      c.free_rent_months, c.ti_psf)


def _apply_verification(c: SaleComp | LeaseComp, v: VerificationIn, actor: CurrentUser) -> None:
    if v.status == "verified" and not v.method:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Verification method is required")
    c.verification_status = v.status
    c.verification_method = v.method if v.status != "unverified" else None
    c.verification_notes = v.notes
    c.verified_by_id = actor.id if v.status != "unverified" else None
    c.verified_at = utcnow() if v.status != "unverified" else None


async def create_comp(db: AsyncSession, kind: str, data: SaleCompCreate | LeaseCompCreate, actor: CurrentUser):
    M = COMP_MODELS[kind]
    c = M(**data.model_dump(exclude={"verification"}), created_by_id=actor.id, updated_by_id=actor.id)
    c.tags = c.tags or []
    await _fill_from_property(db, c)
    _derive(kind, c)
    _set_location(c)
    if data.verification:
        _apply_verification(c, data.verification, actor)
    db.add(c)
    await db.flush()
    await _link_document(db, c.document_id, f"{kind}_comp", c.id, actor)
    await audit.record(db, actor=actor, action=f"{kind}_comp.created", entity_type=f"{kind}_comp", entity_id=c.id,
                       summary=c.name or c.address_line or c.tenant_name, ip_address=actor.ip_address)
    await db.commit()
    return c


async def update_comp(db: AsyncSession, kind: str, c, data: SaleCompUpdate | LeaseCompUpdate, actor: CurrentUser):
    values = data.model_dump(exclude_unset=True)
    if "tags" in values and values["tags"] is None:
        values.pop("tags")
    changes = audit.diff(c, values)
    if not changes:
        return c
    for k, v in values.items():
        setattr(c, k, v)
    material =SALE_MATERIAL if kind == "sale" else LEASE_MATERIAL
    if kind == "lease" and (changes.keys() & {"base_rent_psf", "term_months", "escalation_pct", "free_rent_months", "ti_psf"}) \
            and "effective_rent_psf" not in values:
        c.effective_rent_psf = None
    await _fill_from_property(db, c)
    _derive(kind, c)
    if {"latitude", "longitude"} & changes.keys() or "property_id" in changes:
        _set_location(c)
    if c.verification_status == "verified" and material & changes.keys():
        changes["verification_status"] = {"from": "verified", "to": "unverified"}
        c.verification_status, c.verified_by_id, c.verified_at = "unverified", None, None
    c.updated_by_id = actor.id
    if "document_id" in changes:
        await _link_document(db, c.document_id, f"{kind}_comp", c.id, actor)
    await audit.record(db, actor=actor, action=f"{kind}_comp.updated", entity_type=f"{kind}_comp", entity_id=c.id,
                       changes=changes, ip_address=actor.ip_address)
    await _recompute_sets_using(db, kind, c.id)
    await db.commit()
    return c


async def verify_comp(db: AsyncSession, kind: str, c, data: VerificationIn, actor: CurrentUser):
    before = {"status": c.verification_status, "method": c.verification_method}
    _apply_verification(c, data, actor)
    c.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{kind}_comp.verification", entity_type=f"{kind}_comp", entity_id=c.id,
                       changes={"verification": {"from": before, "to": {"status": data.status, "method": data.method}}},
                       summary=data.notes, ip_address=actor.ip_address)
    await db.commit()
    return c


async def archive_comp(db: AsyncSession, kind: str, c, actor: CurrentUser) -> None:
    c.deleted_at = utcnow()
    c.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{kind}_comp.archived", entity_type=f"{kind}_comp", entity_id=c.id,
                       ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- candidate search


@dataclass
class CandidateQuery:
    kind: str = "sale"
    subject_property_id: uuid.UUID | None = None
    near_lat: float | None = None
    near_lng: float | None = None
    radius_miles: float | None = None
    property_type: list[str] | None = None
    county: str | None = None
    corridor: str | None = None
    tenant_credit: list[str] | None = None
    min_term_years: float | None = None
    max_term_years: float | None = None
    date_from: date | None = None
    date_to: date | None = None
    verified_only: bool = False
    exclude_set_id: uuid.UUID | None = None
    q: str | None = None
    limit: int = 50


async def candidates(db: AsyncSession, cq: CandidateQuery) -> list[dict]:
    """Automated comp candidates by type, geography (radius / county / corridor), credit, lease term and date window."""
    kind = cq.kind if cq.kind in COMP_MODELS else "sale"
    M = COMP_MODELS[kind]
    lat, lng = cq.near_lat, cq.near_lng
    if cq.subject_property_id and (lat is None or lng is None):
        p = await _get_property(db, cq.subject_property_id)
        lat, lng = p.latitude, p.longitude
    stmt = select(M).where(M.deleted_at.is_(None))
    distance = None
    if lat is not None and lng is not None:
        point = WKTElement(f"POINT({lng} {lat})", srid=4326)
        distance = (func.ST_Distance(cast(M.location, Geography), cast(point, Geography)) / MILES).label("distance")
        stmt = select(M, distance).where(M.deleted_at.is_(None))
        if cq.radius_miles:
            stmt = stmt.where(func.ST_DWithin(cast(M.location, Geography), cast(point, Geography), cq.radius_miles * MILES))
    else:
        stmt = select(M, cast(null(), Float).label("distance")).where(M.deleted_at.is_(None))
    stmt = apply_search(stmt, cq.q, [M.name, M.address_line, M.city, M.tenant_name])
    stmt = in_filter(stmt, M.property_type, cq.property_type)
    stmt = in_filter(stmt, M.tenant_credit, cq.tenant_credit)
    if cq.county:
        stmt = stmt.where(M.county.ilike(f"%{cq.county}%"))
    if cq.corridor:
        stmt = stmt.where(M.corridor.ilike(f"%{cq.corridor}%"))
    if cq.verified_only:
        stmt = stmt.where(M.verification_status == "verified")
    if kind == "sale":
        stmt = range_filter(stmt, SaleComp.lease_term_remaining_years, cq.min_term_years, cq.max_term_years)
        stmt = range_filter(stmt, SaleComp.sale_date, cq.date_from, cq.date_to)
        order = SaleComp.sale_date.desc().nulls_last()
    else:
        if cq.min_term_years is not None:
            stmt = stmt.where(LeaseComp.term_months >= cq.min_term_years * 12)
        if cq.max_term_years is not None:
            stmt = stmt.where(LeaseComp.term_months <= cq.max_term_years * 12)
        stmt = range_filter(stmt, LeaseComp.commencement_on, cq.date_from, cq.date_to)
        order = LeaseComp.commencement_on.desc().nulls_last()
    if cq.subject_property_id:
        stmt = stmt.where(or_(M.property_id.is_(None), M.property_id != cq.subject_property_id))
    if cq.exclude_set_id:
        col = CompSetItem.sale_comp_id if kind == "sale" else CompSetItem.lease_comp_id
        used = select(col).where(CompSetItem.comp_set_id == cq.exclude_set_id, CompSetItem.deleted_at.is_(None), col.is_not(None))
        stmt = stmt.where(M.id.not_in(used))
    stmt = stmt.order_by(distance.asc().nulls_last() if distance is not None else order, order).limit(min(cq.limit, 200))
    out = []
    for c, dist in (await db.execute(stmt)).all():
        out.append(candidate_dict(kind, c, dist))
    return out


def candidate_dict(kind: str, c, dist: float | None = None) -> dict:
    base = {
        "id": c.id, "kind": kind, "label": c.name or c.address_line or c.tenant_name or "Unnamed comp",
        "city": c.city, "state": c.state, "county": c.county, "corridor": c.corridor, "property_type": c.property_type,
        "tenant_name": c.tenant_name, "tenant_credit": c.tenant_credit, "verification_status": c.verification_status,
        "distance_miles": round(dist, 2) if dist is not None else None,
    }
    if kind == "sale":
        return {**base, "date": c.sale_date, "price": c.sale_price, "price_psf": sale_metric(c, "price_psf"),
                "cap_rate": sale_metric(c, "cap_rate"), "term_years": c.lease_term_remaining_years,
                "area_sf": c.building_area_sf}
    return {**base, "date": c.commencement_on, "rent_psf": c.base_rent_psf,
            "term_years": round(c.term_months / 12, 2) if c.term_months else None, "area_sf": c.area_sf}


# --------------------------------------------------------------------------- comp sets


@dataclass
class CompSetFilters:
    q: str | None = None
    kind: list[str] | None = None
    status: list[str] | None = None
    purpose: list[str] | None = None
    subject_property_id: uuid.UUID | None = None


def build_set_query(f: CompSetFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(CompSet).where(CompSet.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [CompSet.name, CompSet.notes])
    for key in ("kind", "status", "purpose"):
        if key not in skip:
            stmt = in_filter(stmt, getattr(CompSet, key), getattr(f, key))
    if f.subject_property_id:
        stmt = stmt.where(CompSet.subject_property_id == f.subject_property_id)
    return stmt


async def get_set(db: AsyncSession, set_id: uuid.UUID) -> CompSet:
    cs = await db.get(CompSet, set_id)
    if not cs or cs.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comp set not found")
    return cs


def _default_basis(kind: str, prop) -> str:
    if kind == "lease":
        return "effective_rent_psf"
    if prop is not None and prop.property_type == "land":
        return "price_per_acre"
    if prop is not None and prop.noi:
        return "cap_rate"
    return "price_psf"


def _subject_qty(basis: str, prop) -> tuple[float | None, str | None]:
    if prop is None:
        return None, None
    if basis in ("price_psf", "effective_rent_psf", "base_rent_psf"):
        return prop.building_area_sf, "Property record: building area"
    if basis == "price_per_acre":
        return prop.land_area_acres, "Property record: land area"
    if basis == "cap_rate":
        return prop.noi, "Property record: NOI"
    return 1.0, None


def _check_basis(kind: str, basis: str) -> None:
    allowed = SALE_BASES if kind == "sale" else LEASE_BASES
    if basis not in allowed:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Value basis must be one of {', '.join(allowed)}")


async def _items(db: AsyncSession, set_id: uuid.UUID) -> list[CompSetItem]:
    return list(await db.scalars(select(CompSetItem).where(CompSetItem.comp_set_id == set_id, CompSetItem.deleted_at.is_(None))
                                 .order_by(CompSetItem.sort_order, CompSetItem.created_at)))


async def _comps_for(db: AsyncSession, cs: CompSet, items: list[CompSetItem]) -> dict[uuid.UUID, Any]:
    M = COMP_MODELS[cs.kind]
    ids = [i.sale_comp_id if cs.kind == "sale" else i.lease_comp_id for i in items]
    ids = [i for i in ids if i]
    if not ids:
        return {}
    return {c.id: c for c in await db.scalars(select(M).where(M.id.in_(ids)))}


async def recompute(db: AsyncSession, cs: CompSet) -> None:
    """Recalculate each item's base/adjusted metric and value, then the set's indicated range."""
    items = await _items(db, cs.id)
    comps = await _comps_for(db, cs, items)
    rows = []
    for it in items:
        c = comps.get(it.sale_comp_id if cs.kind == "sale" else it.lease_comp_id)
        base = (sale_metric(c, cs.value_basis) if cs.kind == "sale" else lease_metric(c, cs.value_basis)) if c else None
        net, adjusted = adjust(base, it.adjustments or {})
        it.base_metric, it.net_adjustment_pct, it.adjusted_metric = base, net, adjusted
        it.adjusted_value = metric_to_value(adjusted, cs.value_basis, cs.subject_quantity)
        if it.included and c is not None and c.deleted_at is None:
            rows.append((adjusted, it.weight if it.weight is not None else 1.0))
    ind = indicated_range(rows, cs.value_basis, cs.subject_quantity)
    ind["comp_ids"] = [str(it.sale_comp_id or it.lease_comp_id) for it in items if it.included]
    ind["computed_at"] = utcnow().isoformat()
    cs.indicated = ind


async def _recompute_sets_using(db: AsyncSession, kind: str, comp_id: uuid.UUID) -> None:
    col = CompSetItem.sale_comp_id if kind == "sale" else CompSetItem.lease_comp_id
    set_ids = set(await db.scalars(select(CompSetItem.comp_set_id).where(col == comp_id, CompSetItem.deleted_at.is_(None))))
    for sid in set_ids:
        cs = await db.get(CompSet, sid)
        if cs and not cs.deleted_at:
            await recompute(db, cs)


def _comp_summary(kind: str, c) -> dict:
    if c is None:
        return {}
    d = candidate_dict(kind, c)
    d.update({
        "address_line": c.address_line, "year_built": c.year_built, "condition": c.condition,
        "building_area_sf": c.building_area_sf, "land_area_acres": c.land_area_acres,
        "verification_method": c.verification_method, "verified_at": c.verified_at, "property_id": c.property_id,
        "latitude": c.latitude, "longitude": c.longitude, "source": c.source, "document_id": c.document_id,
        "archived": c.deleted_at is not None,
    })
    if kind == "sale":
        d.update({"sale_price": c.sale_price, "noi": c.noi, "buyer_name": c.buyer_name, "seller_name": c.seller_name,
                  "financing": c.financing, "price_per_acre": sale_metric(c, "price_per_acre")})
    else:
        d.update({"base_rent_psf": c.base_rent_psf, "effective_rent_psf": lease_metric(c, "effective_rent_psf"),
                  "escalation_pct": c.escalation_pct, "recovery_type": c.recovery_type, "ti_psf": c.ti_psf,
                  "free_rent_months": c.free_rent_months, "term_months": c.term_months, "suite": c.suite})
    return d


async def set_items_out(db: AsyncSession, cs: CompSet) -> list[CompSetItemOut]:
    items = await _items(db, cs.id)
    comps = await _comps_for(db, cs, items)
    out = []
    for it in items:
        o = CompSetItemOut.model_validate(it)
        o.comp = _comp_summary(cs.kind, comps.get(it.sale_comp_id if cs.kind == "sale" else it.lease_comp_id))
        out.append(o)
    return out


async def sets_out(db: AsyncSession, rows: list[CompSet]) -> list[CompSetListItem]:
    labels = await _property_labels(db, {r.subject_property_id for r in rows})
    counts: dict[uuid.UUID, dict[bool, int]] = {}
    if rows:
        res = await db.execute(select(CompSetItem.comp_set_id, CompSetItem.included, func.count())
                               .where(CompSetItem.comp_set_id.in_([r.id for r in rows]), CompSetItem.deleted_at.is_(None))
                               .group_by(CompSetItem.comp_set_id, CompSetItem.included))
        for sid, inc, n in res.all():
            counts.setdefault(sid, {})[bool(inc)] = int(n)
    out = []
    for r in rows:
        o = CompSetListItem.model_validate(r)
        o.subject_label = labels.get(r.subject_property_id) if r.subject_property_id else None
        o.included_count = counts.get(r.id, {}).get(True, 0)
        o.excluded_count = counts.get(r.id, {}).get(False, 0)
        out.append(o)
    return out


async def set_out(db: AsyncSession, cs: CompSet) -> CompSetOut:
    base = (await sets_out(db, [cs]))[0]
    out = CompSetOut(**base.model_dump(), subject_quantity=cs.subject_quantity,
                     subject_quantity_source=cs.subject_quantity_source, criteria=cs.criteria or {}, notes=cs.notes,
                     owner_id=cs.owner_id)
    if cs.subject_property_id:
        from app.modules.properties.models import Property

        p = await db.get(Property, cs.subject_property_id)
        if p:
            out.subject = {
                "id": p.id, "name": p.name, "address_line": p.address_line, "city": p.city, "state": p.state,
                "county": p.county, "corridor": p.corridor, "property_type": p.property_type,
                "building_area_sf": p.building_area_sf, "land_area_acres": p.land_area_acres, "year_built": p.year_built,
                "noi": p.noi, "occupancy_pct": p.occupancy_pct, "latitude": p.latitude, "longitude": p.longitude,
                "asking_price": p.asking_price,
            }
    out.items = await set_items_out(db, cs)
    return out


def _assert_editable(cs: CompSet) -> None:
    if cs.status == "final":
        raise HTTPException(status.HTTP_409_CONFLICT, "This comp set is final; reopen it as draft to change it")


async def _add_items(db: AsyncSession, cs: CompSet, comp_ids: list[uuid.UUID], actor: CurrentUser) -> int:
    M = COMP_MODELS[cs.kind]
    col = CompSetItem.sale_comp_id if cs.kind == "sale" else CompSetItem.lease_comp_id
    existing = set(await db.scalars(select(col).where(CompSetItem.comp_set_id == cs.id, CompSetItem.deleted_at.is_(None))))
    comps = list(await db.scalars(select(M).where(M.id.in_(comp_ids), M.deleted_at.is_(None))))
    prop = None
    if cs.subject_property_id:
        from app.modules.properties.models import Property

        prop = await db.get(Property, cs.subject_property_id)
    order = int(await db.scalar(select(func.count()).select_from(CompSetItem).where(CompSetItem.comp_set_id == cs.id)) or 0)
    added = 0
    for c in comps:
        if c.id in existing:
            continue
        dist = None
        if prop is not None and prop.latitude is not None and prop.longitude is not None and c.latitude is not None and c.longitude is not None:
            dist = round(haversine_miles(prop.latitude, prop.longitude, c.latitude, c.longitude), 2)
        order += 1
        db.add(CompSetItem(
            comp_set_id=cs.id, sale_comp_id=c.id if cs.kind == "sale" else None,
            lease_comp_id=c.id if cs.kind == "lease" else None, included=True, adjustments={}, adjustment_notes={},
            weight=1.0, distance_miles=dist, sort_order=order,
            decision_history=[{"included": True, "reason": "Added to set", "by": str(actor.id), "by_name": actor.full_name,
                               "at": utcnow().isoformat()}],
            created_by_id=actor.id, updated_by_id=actor.id,
        ))
        added += 1
    await db.flush()
    return added


async def create_set(db: AsyncSession, data: CompSetCreate, actor: CurrentUser) -> CompSet:
    prop = await _get_property(db, data.subject_property_id)
    basis = data.value_basis or _default_basis(data.kind, prop)
    _check_basis(data.kind, basis)
    qty, qty_source = (data.subject_quantity, data.subject_quantity_source) if data.subject_quantity is not None else _subject_qty(basis, prop)
    cs = CompSet(subject_property_id=prop.id, name=data.name, kind=data.kind, purpose=data.purpose, status="draft",
                 value_basis=basis, subject_quantity=qty, subject_quantity_source=qty_source, criteria=data.criteria,
                 notes=data.notes, indicated={}, owner_id=actor.id, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(cs)
    await db.flush()
    if data.comp_ids:
        await _add_items(db, cs, data.comp_ids, actor)
    await recompute(db, cs)
    await audit.record(db, actor=actor, action="comp_set.created", entity_type="comp_set", entity_id=cs.id,
                       summary=cs.name, ip_address=actor.ip_address)
    await db.commit()
    return cs


async def update_set(db: AsyncSession, cs: CompSet, data: CompSetUpdate, actor: CurrentUser) -> CompSet:
    values = data.model_dump(exclude_unset=True)
    if cs.status == "final" and values.get("status") != "draft" and set(values) - {"status", "notes", "name"}:
        _assert_editable(cs)
    if "value_basis" in values and values["value_basis"]:
        _check_basis(cs.kind, values["value_basis"])
    changes = audit.diff(cs, values)
    if not changes:
        return cs
    for k, v in values.items():
        setattr(cs, k, v)
    if "value_basis" in changes and "subject_quantity" not in values and cs.subject_property_id:
        from app.modules.properties.models import Property

        cs.subject_quantity, cs.subject_quantity_source = _subject_qty(cs.value_basis, await db.get(Property, cs.subject_property_id))
    cs.updated_by_id = actor.id
    await recompute(db, cs)
    await audit.record(db, actor=actor, action="comp_set.updated", entity_type="comp_set", entity_id=cs.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return cs


async def archive_set(db: AsyncSession, cs: CompSet, actor: CurrentUser) -> None:
    cs.deleted_at = utcnow()
    cs.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="comp_set.archived", entity_type="comp_set", entity_id=cs.id,
                       summary=cs.name, ip_address=actor.ip_address)
    await db.commit()


async def add_items(db: AsyncSession, cs: CompSet, data: AddItemsIn, actor: CurrentUser) -> CompSet:
    _assert_editable(cs)
    added = await _add_items(db, cs, data.comp_ids, actor)
    await recompute(db, cs)
    cs.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="comp_set.items_added", entity_type="comp_set", entity_id=cs.id,
                       changes={"comp_ids": [str(i) for i in data.comp_ids]}, summary=f"{added} comps added",
                       ip_address=actor.ip_address)
    await db.commit()
    return cs


async def update_item(db: AsyncSession, cs: CompSet, item_id: uuid.UUID, data: ItemUpdate, actor: CurrentUser) -> CompSet:
    _assert_editable(cs)
    it = await db.get(CompSetItem, item_id)
    if not it or it.comp_set_id != cs.id or it.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comp set item not found")
    values = data.model_dump(exclude_unset=True)
    changes: dict[str, Any] = {}
    if "included" in values and values["included"] is not None and values["included"] != it.included:
        reason = (values.get("exclusion_reason") or "").strip()
        if not values["included"] and len(reason) < 3:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A reason is required to exclude a comp")
        it.decision_history = [*(it.decision_history or []), {
            "included": values["included"], "reason": reason or "Re-included", "by": str(actor.id),
            "by_name": actor.full_name, "at": utcnow().isoformat()}]
        changes["included"] = {"from": it.included, "to": values["included"], "reason": reason or None}
        it.included = values["included"]
        if not it.included:
            it.exclusion_reason = reason
    elif values.get("exclusion_reason") and not it.included:
        changes["exclusion_reason"] = {"from": it.exclusion_reason, "to": values["exclusion_reason"]}
        it.exclusion_reason = values["exclusion_reason"]
        it.decision_history = [*(it.decision_history or []), {
            "included": False, "reason": values["exclusion_reason"], "by": str(actor.id), "by_name": actor.full_name,
            "at": utcnow().isoformat()}]
    if values.get("adjustments") is not None:
        adj = {k: float(v) for k, v in values["adjustments"].items() if k in ADJUSTMENT_FACTORS}
        if adj != (it.adjustments or {}):
            changes["adjustments"] = {"from": it.adjustments, "to": adj}
            it.adjustments = adj
    if values.get("adjustment_notes") is not None:
        it.adjustment_notes = {k: v for k, v in values["adjustment_notes"].items() if k in ADJUSTMENT_FACTORS}
    if values.get("weight") is not None and values["weight"] != it.weight:
        changes["weight"] = {"from": it.weight, "to": values["weight"]}
        it.weight = values["weight"]
    it.updated_by_id = actor.id
    await recompute(db, cs)
    if changes:
        await audit.record(db, actor=actor, action="comp_set.item_updated", entity_type="comp_set", entity_id=cs.id,
                           changes={"item": str(it.id), **changes}, ip_address=actor.ip_address)
    await db.commit()
    return cs


async def save_grid(db: AsyncSession, cs: CompSet, data: GridIn, actor: CurrentUser) -> CompSet:
    _assert_editable(cs)
    changes: dict[str, Any] = {}
    if data.value_basis and data.value_basis != cs.value_basis:
        _check_basis(cs.kind, data.value_basis)
        changes["value_basis"] = {"from": cs.value_basis, "to": data.value_basis}
        cs.value_basis = data.value_basis
    if data.subject_quantity is not None and data.subject_quantity != cs.subject_quantity:
        changes["subject_quantity"] = {"from": cs.subject_quantity, "to": data.subject_quantity}
        cs.subject_quantity = data.subject_quantity
        cs.subject_quantity_source = data.subject_quantity_source or cs.subject_quantity_source
    items = {i.id: i for i in await _items(db, cs.id)}
    item_changes = {}
    for row in data.items:
        it = items.get(row.id)
        if not it:
            continue
        adj = {k: float(v) for k, v in row.adjustments.items() if k in ADJUSTMENT_FACTORS and v is not None}
        if adj != (it.adjustments or {}) or row.weight != it.weight:
            item_changes[str(it.id)] = {"adjustments": {"from": it.adjustments, "to": adj},
                                        "weight": {"from": it.weight, "to": row.weight}}
        it.adjustments = adj
        it.adjustment_notes = {k: v for k, v in row.adjustment_notes.items() if k in ADJUSTMENT_FACTORS and v}
        it.weight = row.weight
        it.updated_by_id = actor.id
    cs.updated_by_id = actor.id
    await recompute(db, cs)
    if changes or item_changes:
        await audit.record(db, actor=actor, action="comp_set.grid_saved", entity_type="comp_set", entity_id=cs.id,
                           changes={**changes, "items": item_changes}, ip_address=actor.ip_address)
    await db.commit()
    return cs


async def comp_set_summary(db: AsyncSession, set_id: uuid.UUID) -> dict | None:
    """Used by underwriting to seed assumptions from a comp set (kind, basis, indicated point, included comp ids)."""
    cs = await db.get(CompSet, set_id)
    if not cs or cs.deleted_at:
        return None
    ind = cs.indicated or {}
    return {"id": str(cs.id), "name": cs.name, "kind": cs.kind, "value_basis": cs.value_basis,
            "metric_point": ind.get("metric_point"), "metric_low": ind.get("metric_low"),
            "metric_high": ind.get("metric_high"), "comp_ids": ind.get("comp_ids") or []}


# --------------------------------------------------------------------------- valuations


@dataclass
class ValuationFilters:
    property_id: uuid.UUID | None = None
    method: list[str] | None = None
    is_mark: bool | None = None
    latest_only: bool = False
    as_of_from: date | None = None
    as_of_to: date | None = None
    comp_set_id: uuid.UUID | None = None


def build_valuation_query(f: ValuationFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Valuation).where(Valuation.deleted_at.is_(None))
    if f.property_id:
        stmt = stmt.where(Valuation.property_id == f.property_id)
    if "method" not in skip:
        stmt = in_filter(stmt, Valuation.method, f.method)
    if f.is_mark is not None and "is_mark" not in skip:
        stmt = stmt.where(Valuation.is_mark.is_(f.is_mark))
    if f.comp_set_id:
        stmt = stmt.where(Valuation.comp_set_id == f.comp_set_id)
    stmt = range_filter(stmt, Valuation.as_of, f.as_of_from, f.as_of_to)
    if f.latest_only:
        rn = func.row_number().over(partition_by=Valuation.property_id,
                                    order_by=(Valuation.as_of.desc(), Valuation.created_at.desc())).label("rn")
        sub = select(Valuation.id, rn).where(Valuation.deleted_at.is_(None))
        if f.is_mark is not None:
            sub = sub.where(Valuation.is_mark.is_(f.is_mark))
        sub = sub.subquery()
        stmt = stmt.where(Valuation.id.in_(select(sub.c.id).where(sub.c.rn == 1)))
    return stmt


async def valuations_out(db: AsyncSession, rows: list[Valuation]) -> list[dict]:
    from app.modules.comps.schemas import ValuationOut

    names = await _user_names(db, {r.analyst_id for r in rows})
    labels = await _property_labels(db, {r.property_id for r in rows})
    out = []
    for r in rows:
        o = ValuationOut.model_validate(r)
        o.analyst_name = names.get(r.analyst_id) if r.analyst_id else None
        o.property_label = labels.get(r.property_id)
        if r.is_mark:
            prior = await db.scalar(select(Valuation.value_point).where(
                Valuation.property_id == r.property_id, Valuation.is_mark.is_(True), Valuation.deleted_at.is_(None),
                or_(Valuation.as_of < r.as_of, (Valuation.as_of == r.as_of) & (Valuation.created_at < r.created_at)),
            ).order_by(Valuation.as_of.desc(), Valuation.created_at.desc()).limit(1))
            o.prior_value_point = prior
            if prior and r.value_point is not None:
                o.change_pct = (r.value_point - prior) / prior * 100
        out.append(o)
    return out


def _sv(assumptions: dict[str, Any], key: str) -> float | None:
    x = assumptions.get(key)
    return x.get("value") if isinstance(x, dict) else x


def _is_sourced(x: Any) -> bool:
    return isinstance(x, dict) and bool(x.get("source") or x.get("comp_ids") or x.get("document_id"))


async def compute_valuation(db: AsyncSession, data: ValuationCreate) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    """Returns (result {value_low, value_high, value_point, calculation}, evidence-bearing assumptions, unsourced keys)."""
    a = {k: v.model_dump(mode="json") for k, v in data.assumptions.items()}
    m = data.method
    if m == "direct_cap":
        result = direct_cap(_sv(a, "noi") or 0, _sv(a, "cap_rate") or 0, _sv(a, "cap_rate_low"), _sv(a, "cap_rate_high"))
    elif m == "dcf":
        rate = _sv(a, "discount_rate")
        if rate is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "DCF needs a discount rate")
        if data.uw_model_id:
            from app.modules.underwriting.models import UwModel

            model = await db.get(UwModel, data.uw_model_id)
            if not model or model.deleted_at:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Underwriting model not found")
            cfs = list((model.outputs or {}).get("cash_flows_unlevered") or [])[1:]
            a["cash_flows"] = {"value": None, "source": f"Underwriting model {model.name} v{model.version} ({model.status})",
                               "comp_ids": [], "document_id": None, "uw_model_id": str(model.id)}
        else:
            cfs = simple_dcf_flows(_sv(a, "noi_year1") or 0, _sv(a, "growth_pct") or 0, int(_sv(a, "hold_years") or 10),
                                   _sv(a, "exit_cap") or 0, _sv(a, "selling_cost_pct") or 0)
        result = dcf_value(cfs, rate, _sv(a, "discount_rate_low"), _sv(a, "discount_rate_high"))
    elif m == "sales_comparison":
        if not data.comp_set_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Sales comparison needs a comp set")
        cs = await get_set(db, data.comp_set_id)
        if cs.kind != "sale":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Sales comparison needs a sale comp set")
        await recompute(db, cs)
        ind = cs.indicated or {}
        if ind.get("value_point") is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "The comp set has no indicated value (check included comps and subject quantity)")
        a["indicated_metric"] = {"value": ind.get("metric_point"), "source": f"Comp set: {cs.name}",
                                 "comp_ids": ind.get("comp_ids") or [], "document_id": None}
        result = {"value_low": ind.get("value_low"), "value_high": ind.get("value_high"), "value_point": ind.get("value_point"),
                  "calculation": {"formula": ind.get("method"), "basis": cs.value_basis, "indicated": ind}}
    elif m == "land_residual":
        result = land_residual(_sv(a, "gross_development_value") or 0, _sv(a, "development_costs") or 0,
                               _sv(a, "soft_costs") or 0, _sv(a, "carry_costs") or 0, _sv(a, "developer_profit_pct") or 0,
                               _sv(a, "gdv_low"), _sv(a, "gdv_high"))
    else:  # appraisal / bov: third-party conclusion entered from the linked document
        if data.value_point is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Enter the value conclusion")
        if m == "appraisal" and not data.document_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Link the appraisal document")
        result = {"value_point": data.value_point, "value_low": data.value_low if data.value_low is not None else data.value_point,
                  "value_high": data.value_high if data.value_high is not None else data.value_point,
                  "calculation": {"formula": f"Third-party {m} conclusion", "third_party": data.third_party}}
    unsourced = [k for k in VALUATION_MATERIAL.get(m, []) if _sv(a, k) is not None and not _is_sourced(a.get(k))]
    for k in ("value_low", "value_high", "value_point"):
        if result.get(k) is not None:
            result[k] = round(float(result[k]), 2)
    return result, a, unsourced


async def create_valuation(db: AsyncSession, data: ValuationCreate, actor: CurrentUser) -> Valuation:
    await _get_property(db, data.property_id)
    result, assumptions, unsourced = await compute_valuation(db, data)
    if data.is_mark and unsourced:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {
            "message": "Portfolio marks require evidence for every material assumption",
            "unsourced": unsourced})
    v = Valuation(
        property_id=data.property_id, method=data.method, value_low=result["value_low"], value_high=result["value_high"],
        value_point=result["value_point"], as_of=data.as_of, analyst_id=data.analyst_id or actor.id,
        comp_set_id=data.comp_set_id, uw_model_id=data.uw_model_id, is_mark=data.is_mark,
        inputs={k: _sv(assumptions, k) for k in assumptions}, assumptions=assumptions, unsourced=unsourced,
        calculation=result["calculation"], document_id=data.document_id, third_party=data.third_party, notes=data.notes,
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(v)
    await db.flush()
    if data.document_id:
        db.add(ValuationDocument(property_id=data.property_id, valuation_id=v.id, document_id=data.document_id,
                                 kind="bov" if data.method == "bov" else "appraisal", label=data.third_party,
                                 prepared_by=data.third_party, effective_date=data.as_of, value_conclusion=v.value_point,
                                 created_by_id=actor.id, updated_by_id=actor.id))
        await _link_document(db, data.document_id, "valuation", v.id, actor)
    await audit.record(db, actor=actor, action="valuation.marked" if v.is_mark else "valuation.created",
                       entity_type="valuation", entity_id=v.id,
                       summary=f"{data.method} {v.value_low:,.0f}–{v.value_high:,.0f} as of {data.as_of}"
                       if v.value_low is not None and v.value_high is not None else data.method,
                       changes={"property_id": str(data.property_id), "value_point": v.value_point}, ip_address=actor.ip_address)
    await db.commit()
    return v


async def valuation_from_set(db: AsyncSession, cs: CompSet, data: FromCompSetIn, actor: CurrentUser) -> Valuation:
    if cs.kind != "sale" or not cs.subject_property_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Only sale comp sets produce a sales-comparison value")
    return await create_valuation(db, ValuationCreate(
        property_id=cs.subject_property_id, method="sales_comparison", as_of=data.as_of, is_mark=data.is_mark,
        comp_set_id=cs.id, notes=data.notes), actor)


async def get_valuation(db: AsyncSession, valuation_id: uuid.UUID) -> Valuation:
    v = await db.get(Valuation, valuation_id)
    if not v or v.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Valuation not found")
    return v


async def archive_valuation(db: AsyncSession, v: Valuation, actor: CurrentUser) -> None:
    if v.is_mark:
        raise HTTPException(status.HTTP_409_CONFLICT, "Portfolio marks are historical and cannot be deleted")
    v.deleted_at = utcnow()
    v.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="valuation.archived", entity_type="valuation", entity_id=v.id,
                       ip_address=actor.ip_address)
    await db.commit()


async def latest_value(db: AsyncSession, property_id: uuid.UUID) -> dict | None:
    """Public contract: most recent valuation (mark or not) for a property."""
    v = await db.scalar(select(Valuation).where(Valuation.property_id == property_id, Valuation.deleted_at.is_(None))
                        .order_by(Valuation.as_of.desc(), Valuation.created_at.desc()).limit(1))
    if not v:
        return None
    return {"value_point": v.value_point, "value_low": v.value_low, "value_high": v.value_high, "as_of": v.as_of,
            "method": v.method, "is_mark": v.is_mark, "valuation_id": v.id}


async def add_document(db: AsyncSession, data: ValuationDocumentIn, actor: CurrentUser) -> ValuationDocument:
    await _get_property(db, data.property_id)
    if data.valuation_id:
        await get_valuation(db, data.valuation_id)
    d = ValuationDocument(**data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(d)
    await db.flush()
    await _link_document(db, data.document_id, "property", data.property_id, actor)
    await audit.record(db, actor=actor, action="valuation_document.linked", entity_type="property",
                       entity_id=data.property_id, summary=f"{data.kind}: {data.label or data.document_id}",
                       changes={"document_id": str(data.document_id)}, ip_address=actor.ip_address)
    await db.commit()
    return d


async def remove_document(db: AsyncSession, doc_id: uuid.UUID, actor: CurrentUser) -> None:
    d = await db.get(ValuationDocument, doc_id)
    if not d or d.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document link not found")
    d.deleted_at = utcnow()
    d.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="valuation_document.unlinked", entity_type="property",
                       entity_id=d.property_id, changes={"document_id": str(d.document_id)}, ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- BOV


async def _bov_payload(db: AsyncSession, cs: CompSet, bov: Bov, actor_name: str | None) -> dict:
    await recompute(db, cs)
    full = await set_out(db, cs)
    valuation = None
    if bov.valuation_id:
        v = await db.get(Valuation, bov.valuation_id)
        if v and not v.deleted_at:
            valuation = {"id": str(v.id), "method": v.method, "value_low": v.value_low, "value_high": v.value_high,
                         "value_point": v.value_point, "as_of": v.as_of.isoformat()}
    docs = list(await db.scalars(select(ValuationDocument).where(ValuationDocument.property_id == cs.subject_property_id,
                                                                  ValuationDocument.deleted_at.is_(None))))
    included = [i for i in full.items if i.included]
    return audit.to_jsonable({
        "generated_at": utcnow(),
        "title": bov.title,
        "prepared_for": bov.prepared_for,
        "prepared_by": actor_name,
        "subject": full.subject,
        "comp_set": {"id": cs.id, "name": cs.name, "kind": cs.kind, "value_basis": cs.value_basis,
                     "subject_quantity": cs.subject_quantity, "subject_quantity_source": cs.subject_quantity_source},
        "adjustment_factors": ADJUSTMENT_FACTORS,
        "comps": [{
            "id": i.sale_comp_id or i.lease_comp_id, "comp": i.comp, "adjustments": i.adjustments,
            "adjustment_notes": i.adjustment_notes, "base_metric": i.base_metric, "net_adjustment_pct": i.net_adjustment_pct,
            "adjusted_metric": i.adjusted_metric, "adjusted_value": i.adjusted_value, "weight": i.weight,
            "distance_miles": i.distance_miles,
        } for i in included],
        "excluded": [{"id": i.sale_comp_id or i.lease_comp_id, "label": i.comp.get("label"), "reason": i.exclusion_reason}
                     for i in full.items if not i.included],
        "indicated": cs.indicated,
        "valuation": valuation,
        "recommended_list_price": bov.recommended_list_price,
        "narrative": bov.narrative,
        "evidence": {"comp_ids": [str(i.sale_comp_id or i.lease_comp_id) for i in included],
                     "document_ids": [str(d.document_id) for d in docs]},
    })


async def create_bov(db: AsyncSession, cs: CompSet, data: BovCreate, actor: CurrentUser) -> Bov:
    if not cs.subject_property_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The comp set has no subject property")
    await recompute(db, cs)
    ind = cs.indicated or {}
    if ind.get("value_point") is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "The comp set has no indicated value yet; include comps and set the subject quantity")
    bov = Bov(property_id=cs.subject_property_id, comp_set_id=cs.id, valuation_id=data.valuation_id, title=data.title,
              prepared_for=data.prepared_for, prepared_by_id=actor.id, status="draft",
              value_low=ind.get("value_low"), value_high=ind.get("value_high"), value_point=ind.get("value_point"),
              recommended_list_price=data.recommended_list_price, narrative=data.narrative,
              created_by_id=actor.id, updated_by_id=actor.id)
    db.add(bov)
    await db.flush()
    bov.payload = await _bov_payload(db, cs, bov, actor.full_name)
    bov.generated_at = utcnow()
    await audit.record(db, actor=actor, action="bov.generated", entity_type="bov", entity_id=bov.id, summary=bov.title,
                       changes={"comp_set_id": str(cs.id), "value_point": bov.value_point}, ip_address=actor.ip_address)
    await db.commit()
    return bov


async def get_bov(db: AsyncSession, bov_id: uuid.UUID) -> Bov:
    b = await db.get(Bov, bov_id)
    if not b or b.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "BOV not found")
    return b


async def update_bov(db: AsyncSession, b: Bov, data: BovUpdate, actor: CurrentUser) -> Bov:
    values = data.model_dump(exclude_unset=True)
    if b.status != "draft" and set(values) - {"status", "document_id"}:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft BOVs can be edited")
    changes = audit.diff(b, values)
    if not changes:
        return b
    for k, v in values.items():
        setattr(b, k, v)
    if {"narrative", "recommended_list_price", "title", "prepared_for"} & changes.keys():
        b.payload = {**(b.payload or {}), "narrative": b.narrative, "recommended_list_price": b.recommended_list_price,
                     "title": b.title, "prepared_for": b.prepared_for}
    if "document_id" in changes and b.document_id:
        db.add(ValuationDocument(property_id=b.property_id, valuation_id=b.valuation_id, document_id=b.document_id,
                                 kind="bov", label=b.title, effective_date=b.generated_at.date() if b.generated_at else None,
                                 value_conclusion=b.value_point, created_by_id=actor.id, updated_by_id=actor.id))
        await _link_document(db, b.document_id, "bov", b.id, actor)
    b.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="bov.updated", entity_type="bov", entity_id=b.id, changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return b


async def regenerate_bov(db: AsyncSession, b: Bov, actor: CurrentUser) -> Bov:
    if b.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft BOVs can be regenerated")
    cs = await get_set(db, b.comp_set_id)
    await recompute(db, cs)
    ind = cs.indicated or {}
    b.value_low, b.value_high, b.value_point = ind.get("value_low"), ind.get("value_high"), ind.get("value_point")
    b.payload = await _bov_payload(db, cs, b, actor.full_name)
    b.generated_at = utcnow()
    b.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="bov.regenerated", entity_type="bov", entity_id=b.id,
                       changes={"value_point": b.value_point}, ip_address=actor.ip_address)
    await db.commit()
    return b


async def bovs_out(db: AsyncSession, rows: list[Bov]) -> list[dict]:
    from app.modules.comps.schemas import BovOut

    names = await _user_names(db, {r.prepared_by_id for r in rows})
    labels = await _property_labels(db, {r.property_id for r in rows})
    out = []
    for r in rows:
        o = BovOut.model_validate(r)
        o.prepared_by_name = names.get(r.prepared_by_id) if r.prepared_by_id else None
        o.property_label = labels.get(r.property_id)
        out.append(o)
    return out
