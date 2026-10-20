import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException, status
from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.assets.calc import add_months, month_range, month_start, norm_key, pct, r2, safe_div
from app.modules.assets.models import (
    MATERIAL_FIELDS,
    Asset,
    AssetFinancial,
    AssetMilestone,
    AssetSetting,
    ConcentrationLimit,
    TenantProfile,
    VarianceExplanation,
    WatchlistEntry,
)
from app.modules.assets.schemas import (
    AssetCreate,
    AssetOut,
    AssetUpdate,
    ExplainIn,
    FinancialIn,
    MilestoneIn,
    MilestoneUpdate,
    Metric,
    SettingsIn,
)
from app.modules.auth.models import User
from app.modules.properties.models import Property

ENTITY = "asset"
INCOME_CATS = {"income"}
EXPENSE_CATS = {"expense"}

DEFAULT_SETTINGS: dict[str, Any] = {
    "variance_pct": 10.0,
    "variance_amount": 5000.0,
    "watch_min_dscr": 1.25,
    "watch_min_occupancy": 85.0,
    "maturity_months": 12,
    "persistent_variance_months": 3,
    "maintenance_backlog": 10,
    "maintenance_overdue_days": 30,
}


# --------------------------------------------------------------------------- settings / lookups

async def get_settings(db: AsyncSession) -> dict:
    row = await db.scalar(select(AssetSetting).where(AssetSetting.key == "thresholds"))
    return {**DEFAULT_SETTINGS, **((row.value if row else None) or {})}


async def save_settings(db: AsyncSession, data: SettingsIn, actor: CurrentUser) -> dict:
    row = await db.scalar(select(AssetSetting).where(AssetSetting.key == "thresholds"))
    before = await get_settings(db)
    if row is None:
        row = AssetSetting(key="thresholds", value={}, created_by_id=actor.id)
        db.add(row)
    row.value = data.model_dump()
    row.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="asset.settings_updated", entity_type="asset_settings",
                       changes={"from": before, "to": row.value}, ip_address=actor.ip_address)
    await db.commit()
    return {**DEFAULT_SETTINGS, **row.value}


def prop_label(p: Property | None) -> str:
    if p is None:
        return "Unknown property"
    return p.name or p.address_line


async def user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: u.full_name for u in await db.scalars(select(User).where(User.id.in_(ids)))}


async def get(db: AsyncSession, asset_id: uuid.UUID) -> Asset:
    a = await db.get(Asset, asset_id)
    if not a or a.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")
    return a


async def by_property(db: AsyncSession, property_id: uuid.UUID) -> Asset | None:
    return await db.scalar(select(Asset).where(Asset.property_id == property_id, Asset.deleted_at.is_(None)))


async def load_props(db: AsyncSession, assets: list[Asset]) -> dict[uuid.UUID, Property]:
    pids = {a.property_id for a in assets}
    if not pids:
        return {}
    return {p.id: p for p in await db.scalars(select(Property).where(Property.id.in_(pids)))}


# --------------------------------------------------------------------------- list / filters

@dataclass
class AssetFilters:
    q: str | None = None
    status: list[str] | None = None
    property_type: list[str] | None = None
    state: list[str] | None = None
    manager_id: list[uuid.UUID] | None = None
    ids: list[uuid.UUID] | None = None
    property_id: uuid.UUID | None = None
    watchlist: bool | None = None


def build_query(f: AssetFilters, *, skip: set[str] = frozenset(), cols: list | None = None) -> Select:
    stmt = (
        select(*(cols or [Asset]))
        .select_from(Asset)
        .join(Property, Property.id == Asset.property_id)
        .where(Asset.deleted_at.is_(None))
    )
    stmt = apply_search(stmt, f.q, [Property.name, Property.address_line, Property.city, Property.county,
                                     Property.corridor])
    if "status" not in skip:
        stmt = in_filter(stmt, Asset.status, f.status)
    if "property_type" not in skip:
        stmt = in_filter(stmt, Property.property_type, f.property_type)
    if "state" not in skip:
        stmt = in_filter(stmt, Property.state, f.state)
    stmt = in_filter(stmt, Asset.manager_id, f.manager_id)
    stmt = in_filter(stmt, Asset.id, f.ids)
    if f.property_id:
        stmt = stmt.where(Asset.property_id == f.property_id)
    if f.watchlist:
        open_ids = select(WatchlistEntry.asset_id).where(WatchlistEntry.status == "open",
                                                         WatchlistEntry.deleted_at.is_(None))
        stmt = stmt.where(Asset.id.in_(open_ids))
    return stmt


# --------------------------------------------------------------------------- cross-module reads (guarded)

async def lease_data(db: AsyncSession, property_ids: set[uuid.UUID]) -> dict[uuid.UUID, list[dict]] | None:
    """Active leases with current annual rent per property; None when the leases module is unavailable."""
    try:
        from app.modules.leases.models import Lease, RentStep
    except ImportError:
        return None
    if not property_ids:
        return {}
    today = date.today()
    conds = [Lease.property_id.in_(property_ids), Lease.status == "active"]
    if hasattr(Lease, "deleted_at"):
        conds.append(Lease.deleted_at.is_(None))
    leases = list(await db.scalars(select(Lease).where(*conds)))
    rent: dict[uuid.UUID, float] = {}
    if leases:
        steps = await db.scalars(select(RentStep).where(RentStep.lease_id.in_([l.id for l in leases])))
        for s in steps:
            if s.start_on and s.start_on > today:
                continue
            if s.end_on and s.end_on < today:
                continue
            annual = s.annual_rent if s.annual_rent is not None else (s.monthly_rent or 0) * 12
            rent[s.lease_id] = float(annual or 0)
    guarantors: dict[uuid.UUID, str] = {}
    try:
        from app.modules.leases.models import Guaranty

        for g in await db.scalars(select(Guaranty).where(Guaranty.lease_id.in_([l.id for l in leases]))):
            name = getattr(g, "guarantor_name", None) or getattr(g, "name", None)
            if name:
                guarantors[g.lease_id] = name
    except (ImportError, AttributeError):
        pass
    out: dict[uuid.UUID, list[dict]] = defaultdict(list)
    for l in leases:
        out[l.property_id].append({
            "id": l.id, "tenant_name": l.tenant_name or "Unnamed tenant",
            "tenant_organization_id": l.tenant_organization_id,
            "rentable_sf": float(l.rentable_sf or 0), "expiration_on": l.expiration_on,
            "commencement_on": l.commencement_on, "annual_rent": rent.get(l.id, 0.0),
            "guarantor": guarantors.get(l.id),
        })
    return out


async def latest_valuation(db: AsyncSession, property_id: uuid.UUID) -> dict | None:
    try:
        from app.modules.comps.service import latest_value
    except ImportError:
        return None
    try:
        return await latest_value(db, property_id)
    except Exception:  # comps module still being built must not break asset views
        return None


async def active_loans(db: AsyncSession, assets: list[Asset]) -> dict[uuid.UUID, list[dict]]:
    """Active loans per asset with the balance allocated to that asset (cross-collateral aware)."""
    from app.modules.debt.calc import annual_debt_service
    from app.modules.debt.models import Loan, LoanProperty

    if not assets:
        return {}
    by_prop = {a.property_id: a.id for a in assets}
    asset_ids = {a.id for a in assets}
    prop_ids = list(by_prop)
    links = list(await db.scalars(select(LoanProperty).where(LoanProperty.property_id.in_(prop_ids))))
    linked_loan_ids = {l.loan_id for l in links}
    conds = [Loan.asset_id.in_(asset_ids), Loan.property_id.in_(prop_ids)]
    if linked_loan_ids:
        conds.append(Loan.id.in_(linked_loan_ids))
    loans = list(await db.scalars(
        select(Loan).where(Loan.deleted_at.is_(None), Loan.status == "active", or_(*conds))
    ))
    all_links: dict[uuid.UUID, list[LoanProperty]] = defaultdict(list)
    if loans:
        for l in await db.scalars(select(LoanProperty).where(LoanProperty.loan_id.in_([x.id for x in loans]))):
            all_links[l.loan_id].append(l)
    out: dict[uuid.UUID, list[dict]] = defaultdict(list)
    for loan in loans:
        bal = float(loan.current_balance or 0)
        ds = annual_debt_service(loan)
        shares: dict[uuid.UUID, float] = {}
        lk = all_links.get(loan.id, [])
        alloc_total = sum(float(x.allocated_amount or 0) for x in lk)
        if lk and alloc_total > 0:
            for x in lk:
                if x.property_id in by_prop:
                    shares[by_prop[x.property_id]] = float(x.allocated_amount or 0) / alloc_total
        else:
            target = loan.asset_id if loan.asset_id in asset_ids else by_prop.get(loan.property_id)
            if target:
                shares[target] = 1.0
            elif lk:
                for x in lk:
                    if x.property_id in by_prop:
                        shares[by_prop[x.property_id]] = 1.0 / len(lk)
        for aid, share in shares.items():
            out[aid].append({
                "id": loan.id, "lender_name": loan.lender_name or "Unknown lender", "balance": bal * share,
                "annual_debt_service": ds * share, "rate": loan.rate, "rate_type": loan.rate_type,
                "maturity_on": loan.maturity_on, "covenant_state": loan.covenant_state, "share": share,
                "cap_expires_on": loan.cap_expires_on,
            })
    return out


async def partner_stakes(db: AsyncSession, asset_ids: set[uuid.UUID]) -> dict[uuid.UUID, list[dict]] | None:
    try:
        from app.modules.investors.models import CapitalPartner, Investment
    except ImportError:
        return None
    if not asset_ids:
        return {}
    rows = await db.execute(
        select(Investment, CapitalPartner)
        .join(CapitalPartner, CapitalPartner.id == Investment.partner_id)
        .where(Investment.asset_id.in_(asset_ids))
    )
    out: dict[uuid.UUID, list[dict]] = defaultdict(list)
    for inv, partner in rows.all():
        if getattr(inv, "deleted_at", None) or getattr(partner, "deleted_at", None):
            continue
        out[inv.asset_id].append({
            "partner_id": partner.id, "name": partner.name, "ownership_pct": float(inv.ownership_pct or 0),
            "commitment": float(inv.commitment or 0), "funded": float(inv.funded or 0),
        })
    return out


# --------------------------------------------------------------------------- financial aggregation

async def monthly_by_category(
    db: AsyncSession, asset_ids: set[uuid.UUID], since: date, *, verified_only: bool = False
) -> dict[uuid.UUID, dict[date, dict[str, float]]]:
    if not asset_ids:
        return {}
    stmt = (
        select(AssetFinancial.asset_id, AssetFinancial.period, AssetFinancial.category, func.sum(AssetFinancial.amount))
        .where(AssetFinancial.asset_id.in_(asset_ids), AssetFinancial.is_current.is_(True),
               AssetFinancial.deleted_at.is_(None), AssetFinancial.period >= since)
        .group_by(AssetFinancial.asset_id, AssetFinancial.period, AssetFinancial.category)
    )
    if verified_only:
        stmt = stmt.where(AssetFinancial.verified.is_(True))
    out: dict[uuid.UUID, dict[date, dict[str, float]]] = defaultdict(lambda: defaultdict(dict))
    for aid, period, cat, amt in (await db.execute(stmt)).all():
        out[aid][period][cat] = float(amt or 0)
    return out


def window_sum(monthly: dict[date, dict[str, float]], end: date, cats: set[str], months: int = 12) -> float:
    start = add_months(end, -(months - 1))
    return sum(v for p, row in monthly.items() if start <= p <= end for c, v in row.items() if c in cats)


def ttm_noi(monthly: dict[date, dict[str, float]], end: date | None = None) -> tuple[float | None, date | None, int]:
    """NOI for the 12 months ending `end` (default: latest period with data). Returns (noi, end, months_present)."""
    if not monthly:
        return None, None, 0
    end = end or max(monthly)
    start = add_months(end, -11)
    present = sum(1 for p in monthly if start <= p <= end)
    if present == 0:
        return None, end, 0
    return window_sum(monthly, end, INCOME_CATS) - window_sum(monthly, end, EXPENSE_CATS), end, present


async def capex_totals(db: AsyncSession, asset_ids: set[uuid.UUID]) -> dict[uuid.UUID, float]:
    if not asset_ids:
        return {}
    rows = await db.execute(
        select(AssetFinancial.asset_id, func.sum(AssetFinancial.amount))
        .where(AssetFinancial.asset_id.in_(asset_ids), AssetFinancial.category == "capex",
               AssetFinancial.is_current.is_(True), AssetFinancial.deleted_at.is_(None))
        .group_by(AssetFinancial.asset_id)
    )
    return {aid: float(v or 0) for aid, v in rows.all()}


# --------------------------------------------------------------------------- KPIs

def occupancy_wale(prop: Property, leases: list[dict] | None) -> tuple[float | None, float | None, str]:
    today = date.today()
    if leases:
        area = float(prop.building_area_sf or 0)
        leased = sum(l["rentable_sf"] for l in leases if not l["commencement_on"] or l["commencement_on"] <= today)
        occ = min(100.0, leased / area * 100) if area else None
        weights = [(l["annual_rent"] or l["rentable_sf"],
                    max(0.0, (l["expiration_on"] - today).days / 365.25) if l["expiration_on"] else None)
                   for l in leases]
        weights = [(w, y) for w, y in weights if y is not None and w]
        wale = sum(w * y for w, y in weights) / sum(w for w, _ in weights) if weights else None
        if occ is None:
            occ = float(prop.occupancy_pct) if prop.occupancy_pct is not None else None
        return occ, wale, "leases"
    return (float(prop.occupancy_pct) if prop.occupancy_pct is not None else None,
            float(prop.wale_years) if prop.wale_years is not None else None, "property")


async def compute_kpis(db: AsyncSession, assets: list[Asset], props: dict[uuid.UUID, Property],
                       *, with_value: bool = True) -> dict[uuid.UUID, dict]:
    ids = {a.id for a in assets}
    monthly = await monthly_by_category(db, ids, add_months(month_start(date.today()), -36))
    capex = await capex_totals(db, ids)
    loans = await active_loans(db, assets)
    leases = await lease_data(db, {a.property_id for a in assets})
    out: dict[uuid.UUID, dict] = {}
    for a in assets:
        p = props.get(a.property_id)
        m = monthly.get(a.id, {})
        noi, end, present = ttm_noi(m)
        ds_actual = window_sum(m, end, {"debt_service"}) if end else 0.0
        ds_est = sum(l["annual_debt_service"] for l in loans.get(a.id, []))
        ds = ds_actual if ds_actual > 0 else ds_est
        debt = sum(l["balance"] for l in loans.get(a.id, []))
        prop_leases = leases.get(a.property_id) if leases is not None else None
        occ, wale, occ_src = occupancy_wale(p, prop_leases) if p else (None, None, "property")
        if noi is None and p is not None and p.noi is not None:
            noi, noi_src = float(p.noi), "property"
        else:
            noi_src = "financials"
        value, value_src = None, None
        if with_value:
            v = await latest_valuation(db, a.property_id)
            if v and v.get("value_point"):
                value, value_src = float(v["value_point"]), f"valuation ({v.get('method') or 'mark'}, {v.get('as_of')})"
        if value is None and a.current_value:
            value, value_src = float(a.current_value), "asset record"
        if value is None and a.basis:
            value, value_src = float(a.basis), "basis"
        cost = (float(a.basis or 0) + capex.get(a.id, 0.0)) or None
        out[a.id] = {
            "noi_ttm": r2(noi), "noi_source": noi_src, "ttm_end": end, "months_present": present,
            "income_ttm": r2(window_sum(m, end, INCOME_CATS)) if end else None,
            "expense_ttm": r2(window_sum(m, end, EXPENSE_CATS)) if end else None,
            "capex_total": r2(capex.get(a.id, 0.0)), "debt_service": r2(ds) if ds else None,
            "debt_service_source": "financials" if ds_actual > 0 else ("loan terms" if ds_est else None),
            "debt": r2(debt), "value": r2(value), "value_source": value_src,
            "occupancy": r2(occ), "occupancy_source": occ_src, "wale": r2(wale), "cost": r2(cost),
            "yield_on_cost": pct(noi, cost), "leverage": pct(debt, value) if debt else (0.0 if value else None),
            "coverage": r2(safe_div(noi, ds), 3) if ds else None,
            "loans": loans.get(a.id, []), "leases": prop_leases, "building_sf": float(p.building_area_sf or 0) if p else 0,
        }
    return out


def kpi_metrics(a: Asset, k: dict) -> dict[str, Metric]:
    aid, pid = a.id, a.property_id
    fin = {"label": "Monthly financials", "href": f"/assets/{aid}?tab=financials"}
    loans = [{"label": f"Loan · {l['lender_name']}", "href": f"/loans/{l['id']}"} for l in k["loans"]]
    lease_drill = ([{"label": "Leases", "href": f"/leases?property_id={pid}"}] if k["occupancy_source"] == "leases"
                   else [{"label": "Property record", "href": f"/properties/{pid}"}])
    value_drill = ([{"label": "Valuations", "href": f"/comps?property_id={pid}"}]
                   if (k["value_source"] or "").startswith("valuation") else [{"label": "Asset record", "href": f"/assets/{aid}"}])
    noi_drill = [fin] if k["noi_source"] == "financials" else [{"label": "Property record", "href": f"/properties/{pid}"}]
    return {
        "occupancy": Metric(value=k["occupancy"], label="Occupancy", source=k["occupancy_source"], drill=lease_drill),
        "wale": Metric(value=k["wale"], label="WALE (years)", source=k["occupancy_source"], drill=lease_drill),
        "noi": Metric(value=k["noi_ttm"], label="NOI (TTM)", source=k["noi_source"], drill=noi_drill),
        "yield_on_cost": Metric(value=k["yield_on_cost"], label="Yield on cost", source="NOI / (basis + capex)",
                                drill=noi_drill + [{"label": "Asset basis", "href": f"/assets/{aid}"}]),
        "leverage": Metric(value=k["leverage"], label="Leverage (LTV)", source="debt / value",
                           drill=loans + value_drill),
        "coverage": Metric(value=k["coverage"], label="Coverage (DSCR)", source=k["debt_service_source"],
                           drill=noi_drill + loans),
        "value": Metric(value=k["value"], label="Value", source=k["value_source"], drill=value_drill),
        "debt": Metric(value=k["debt"], label="Debt balance", source="loans", drill=loans),
    }


async def open_watch_counts(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    rows = await db.execute(
        select(WatchlistEntry.asset_id, func.count()).where(
            WatchlistEntry.asset_id.in_(ids), WatchlistEntry.status == "open", WatchlistEntry.deleted_at.is_(None)
        ).group_by(WatchlistEntry.asset_id)
    )
    return {k: int(v) for k, v in rows.all()}


async def to_items(db: AsyncSession, assets: list[Asset]) -> list[dict]:
    props = await load_props(db, assets)
    kp = await compute_kpis(db, assets, props, with_value=True)
    names = await user_names(db, {a.manager_id for a in assets})
    watch = await open_watch_counts(db, {a.id for a in assets})
    items = []
    for a in assets:
        p, k = props.get(a.property_id), kp[a.id]
        items.append({
            "id": a.id, "property_id": a.property_id, "property_label": prop_label(p),
            "city": p.city if p else None, "state": p.state if p else None,
            "property_type": p.property_type if p else None, "status": a.status, "acquired_on": a.acquired_on,
            "basis": a.basis, "current_value": k["value"], "manager_id": a.manager_id,
            "manager_name": names.get(a.manager_id), "noi_ttm": k["noi_ttm"], "occupancy": k["occupancy"],
            "leverage": k["leverage"], "coverage": k["coverage"], "yield_on_cost": k["yield_on_cost"],
            "open_watch": watch.get(a.id, 0), "updated_at": a.updated_at,
        })
    return items


async def uw_benchmark(db: AsyncSession, a: Asset) -> dict | None:
    if not a.uw_model_id:
        return None
    try:
        from app.modules.underwriting.service import get_approved
    except ImportError:
        return None
    try:
        m = await get_approved(db, a.uw_model_id)
    except HTTPException:
        return {"model_id": a.uw_model_id, "available": False, "note": "Linked underwriting model is not approved."}
    except Exception:
        return None
    outputs = m.outputs or {}
    keys = ["purchase_price", "noi_year1", "going_in_cap", "stabilized_cap", "loan_amount", "dscr", "debt_yield",
            "cash_on_cash", "irr", "equity_multiple", "exit_value", "breakeven_occupancy"]
    return {
        "model_id": m.id, "available": True, "name": getattr(m, "name", None), "version": getattr(m, "version", None),
        "approved_at": getattr(m, "approved_at", None), "outputs": {k: outputs.get(k) for k in keys if k in outputs},
        "href": f"/underwriting/{m.id}",
    }


async def to_out(db: AsyncSession, a: Asset) -> AssetOut:
    props = await load_props(db, [a])
    p = props.get(a.property_id)
    k = (await compute_kpis(db, [a], props))[a.id]
    out = AssetOut.model_validate(a)
    out.property_label = prop_label(p)
    if p:
        out.address_line, out.city, out.state, out.county = p.address_line, p.city, p.state, p.county
        out.property_type, out.corridor = p.property_type, p.corridor
    out.manager_name = (await user_names(db, {a.manager_id})).get(a.manager_id)
    out.kpis = kpi_metrics(a, k)
    stakes = await partner_stakes(db, {a.id})
    out.capital_structure = {
        "debt_total": k["debt"], "value": k["value"], "equity_invested": a.equity_invested,
        "ltv": k["leverage"],
        "loans": [{**l, "href": f"/loans/{l['id']}"} for l in k["loans"]],
        "partners": ([{**s, "href": f"/investors/{s['partner_id']}"} for s in stakes.get(a.id, [])]
                     if stakes is not None else None),
    }
    out.benchmark = await uw_benchmark(db, a)
    return out


# --------------------------------------------------------------------------- mutations

async def create(db: AsyncSession, data: AssetCreate, actor: CurrentUser) -> Asset:
    prop = await db.get(Property, data.property_id)
    if not prop or prop.deleted_at:
        raise HTTPException(404, "Property not found")
    if await by_property(db, data.property_id):
        raise HTTPException(409, "This property already has an asset record")
    a = Asset(**data.model_dump(exclude={"provenance"}), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(a)
    await db.flush()
    for field in MATERIAL_FIELDS:
        v = getattr(a, field)
        if v is not None:
            await provenance.observe(db, entity_type=ENTITY, entity_id=a.id, field=field, value=v,
                                     prov=data.provenance, actor_id=actor.id)
    await _mark_property_owned(db, prop, actor)
    await audit.record(db, actor=actor, action="asset.created", entity_type=ENTITY, entity_id=a.id,
                       summary=prop_label(prop), ip_address=actor.ip_address)
    await events.emit(db, "asset.created", asset_id=a.id, property_id=a.property_id, actor=actor)
    await db.commit()
    return a


async def _mark_property_owned(db: AsyncSession, prop: Property, actor: Any) -> None:
    if prop.status not in ("owned", "managed"):
        old = prop.status
        prop.status = "owned"
        prop.updated_by_id = getattr(actor, "id", None)
        await audit.record(db, actor=actor, action="property.updated", entity_type="property", entity_id=prop.id,
                           changes={"status": {"from": old, "to": "owned"}}, summary="Acquired — asset record created")
        await events.emit(db, "property.updated", property_id=prop.id, changed={"status"}, actor=actor)


async def create_asset_from_closing(
    db: AsyncSession,
    *,
    property_id: uuid.UUID,
    opportunity_id: uuid.UUID | None = None,
    closing_id: uuid.UUID | None = None,
    acquired_on: date,
    basis: float | None,
    uw_model_id: uuid.UUID | None = None,
    manager_id: uuid.UUID | None = None,
    hold_thesis: str | None = None,
    actor: Any,
) -> Asset:
    """Idempotent per property. Sets property.status='owned'. Does not commit."""
    existing = await by_property(db, property_id)
    if existing:
        changed = {}
        for field, value in (("closing_id", closing_id), ("opportunity_id", opportunity_id), ("uw_model_id", uw_model_id)):
            if value and getattr(existing, field) is None:
                setattr(existing, field, value)
                changed[field] = {"from": None, "to": value}
        if changed:
            await audit.record(db, actor=actor, action="asset.linked", entity_type=ENTITY, entity_id=existing.id,
                               changes=changed, summary="Linked closing records")
        return existing
    prop = await db.get(Property, property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    actor_id = getattr(actor, "id", None)
    a = Asset(property_id=property_id, status="active", acquired_on=acquired_on, basis=basis,
              opportunity_id=opportunity_id, closing_id=closing_id, uw_model_id=uw_model_id,
              manager_id=manager_id, hold_thesis=hold_thesis, exit_assumptions={},
              created_by_id=actor_id, updated_by_id=actor_id)
    db.add(a)
    await db.flush()
    prov = provenance.ProvenanceIn(source="Closing", observed_on=acquired_on, confidence=1.0, verified=True)
    for field in ("basis", "acquired_on"):
        if getattr(a, field) is not None:
            await provenance.observe(db, entity_type=ENTITY, entity_id=a.id, field=field, value=getattr(a, field),
                                     prov=prov, actor_id=actor_id)
    await _mark_property_owned(db, prop, actor)
    await audit.record(db, actor=actor, action="asset.created", entity_type=ENTITY, entity_id=a.id,
                       summary=f"Created from closing · {prop_label(prop)}",
                       changes={"closing_id": closing_id, "opportunity_id": opportunity_id, "basis": basis})
    await events.emit(db, "asset.created", asset_id=a.id, property_id=property_id, actor=actor)
    return a


async def update(db: AsyncSession, a: Asset, data: AssetUpdate, actor: CurrentUser) -> Asset:
    values = data.model_dump(exclude_unset=True, exclude={"provenance"})
    if "exit_assumptions" in values and values["exit_assumptions"] is None:
        values["exit_assumptions"] = {}
    changes = await provenance.apply_material(db, a, entity_type=ENTITY, data=values, material_fields=MATERIAL_FIELDS,
                                              prov=data.provenance, actor_id=actor.id)
    if not changes:
        return a
    if "status" in changes and a.status == "disposed" and not a.disposed_on:
        a.disposed_on = date.today()
    a.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="asset.updated", entity_type=ENTITY, entity_id=a.id, changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return a


async def archive(db: AsyncSession, a: Asset, actor: CurrentUser) -> None:
    a.deleted_at = utcnow()
    a.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="asset.archived", entity_type=ENTITY, entity_id=a.id,
                       ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- financials

async def _add_financial(db: AsyncSession, a: Asset, row: FinancialIn, source: str,
                         actor: CurrentUser) -> tuple[AssetFinancial, str, dict | None]:
    """Returns (row, outcome, change) where outcome is created | superseded | unchanged."""
    period = month_start(row.period)
    account = row.account.strip()
    prior = await db.scalar(select(AssetFinancial).where(
        AssetFinancial.asset_id == a.id, AssetFinancial.period == period, AssetFinancial.account == account,
        AssetFinancial.is_current.is_(True), AssetFinancial.deleted_at.is_(None),
    ))
    change = None
    if prior:
        if float(prior.amount) == float(row.amount) and prior.category == row.category:
            return prior, "unchanged", None
        if prior.verified and not actor.can("assets", "approve"):
            raise HTTPException(403, f"{account} {period:%Y-%m} is a verified actual; replacing it requires approval permission")
        # Superseded, kept for history. deleted_at is also set so consumers that only filter on deleted_at
        # never double count; history views read rows regardless of deleted_at.
        prior.is_current, prior.deleted_at = False, utcnow()
        prior.updated_by_id = actor.id
        change = {"from": float(prior.amount), "to": row.amount}
    f = AssetFinancial(asset_id=a.id, period=period, account=account, category=row.category,
                       amount=row.amount, source=source, notes=row.notes, verified=False, is_current=True,
                       created_by_id=actor.id, updated_by_id=actor.id)
    db.add(f)
    await db.flush()
    return f, ("superseded" if prior else "created"), change


async def add_financial(db: AsyncSession, a: Asset, row: FinancialIn, actor: CurrentUser) -> AssetFinancial:
    f, outcome, change = await _add_financial(db, a, row, "manual", actor)
    if outcome != "unchanged":
        await audit.record(db, actor=actor, action="asset.financial_entered", entity_type=ENTITY, entity_id=a.id,
                           summary=f"{f.account} {f.period:%Y-%m}", changes={"amount": change or {"to": row.amount}},
                           ip_address=actor.ip_address)
        await db.commit()
    return f


async def bulk_financials(db: AsyncSession, a: Asset, rows: list[FinancialIn], source: str, actor: CurrentUser) -> dict:
    counts = {"created": 0, "superseded": 0, "unchanged": 0}
    for row in rows:
        _, outcome, _ = await _add_financial(db, a, row, source, actor)
        counts[outcome] += 1
    await audit.record(db, actor=actor, action="asset.financials_imported", entity_type=ENTITY, entity_id=a.id,
                       summary=f"{len(rows)} rows ({counts['superseded']} superseded)",
                       changes={"rows": len(rows), **counts}, ip_address=actor.ip_address)
    await db.commit()
    return {"rows": len(rows), **counts}


async def verify_financials(db: AsyncSession, a: Asset, start: date, end: date, actor: CurrentUser) -> int:
    rows = list(await db.scalars(select(AssetFinancial).where(
        AssetFinancial.asset_id == a.id, AssetFinancial.is_current.is_(True), AssetFinancial.deleted_at.is_(None),
        AssetFinancial.verified.is_(False), AssetFinancial.period >= month_start(start),
        AssetFinancial.period <= month_start(end),
    )))
    now = utcnow()
    for r in rows:
        r.verified, r.verified_by_id, r.verified_at = True, actor.id, now
    await audit.record(db, actor=actor, action="asset.financials_verified", entity_type=ENTITY, entity_id=a.id,
                       summary=f"{len(rows)} rows {start:%Y-%m} to {end:%Y-%m}", ip_address=actor.ip_address)
    await db.commit()
    return len(rows)


async def delete_financial(db: AsyncSession, f: AssetFinancial, actor: CurrentUser) -> None:
    f.deleted_at, f.is_current = utcnow(), False
    f.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="asset.financial_deleted", entity_type=ENTITY, entity_id=f.asset_id,
                       summary=f"{f.account} {f.period:%Y-%m}", changes={"amount": {"from": f.amount, "to": None}},
                       ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- actual vs budget vs underwriting

async def _budget_lines(db: AsyncSession, asset_id: uuid.UUID, years: set[int]) -> tuple[dict[tuple[str, date], float], dict[str, str], list[uuid.UUID]]:
    try:
        from app.modules.operations.models import Budget, BudgetLine
    except ImportError:
        return {}, {}, []
    values: dict[tuple[str, date], float] = defaultdict(float)
    cats: dict[str, str] = {}
    used: list[uuid.UUID] = []
    for fy in years:
        conds = [Budget.asset_id == asset_id, Budget.fiscal_year == fy, Budget.status == "approved"]
        if hasattr(Budget, "deleted_at"):
            conds.append(Budget.deleted_at.is_(None))
        budget = await db.scalar(select(Budget).where(*conds).order_by(Budget.version.desc()).limit(1))
        if not budget:
            continue
        used.append(budget.id)
        for line in await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == budget.id)):
            if getattr(line, "deleted_at", None):
                continue
            values[(line.account, date(fy, int(line.month), 1))] += float(line.amount or 0)
            cats.setdefault(line.account, line.category)
    return values, cats, used


def _uw_lines(outputs_full: dict | None) -> tuple[dict[str, float], dict[str, str], dict[str, float]]:
    """Annual UW amounts by account (if the model exposes line items) and summary totals."""
    lines: dict[str, float] = {}
    cats: dict[str, str] = {}
    totals: dict[str, float] = {}
    o = outputs_full or {}
    items = o.get("line_items")
    if isinstance(items, dict):
        for acct, amt in items.items():
            if isinstance(amt, (int, float)):
                lines[acct] = float(amt)
    elif isinstance(items, list):
        for it in items:
            if isinstance(it, dict) and it.get("account") and isinstance(it.get("amount"), (int, float)):
                lines[it["account"]] = float(it["amount"])
                if it.get("category"):
                    cats[it["account"]] = it["category"]
    for key, names in (("income", ("egi", "effective_gross_income", "revenue_year1", "total_income")),
                       ("expense", ("opex", "operating_expenses", "expenses_year1", "total_expenses")),
                       ("noi", ("noi_year1",))):
        for n in names:
            if isinstance(o.get(n), (int, float)):
                totals[key] = float(o[n])
                break
    return lines, cats, totals


async def _uw_outputs(db: AsyncSession, a: Asset) -> dict | None:
    if not a.uw_model_id:
        return None
    try:
        from app.modules.underwriting.service import get_approved
    except ImportError:
        return None
    try:
        return (await get_approved(db, a.uw_model_id)).outputs or {}
    except Exception:
        return None


def _var(actual: float | None, bench: float | None, category: str, s: dict) -> dict:
    if bench is None or actual is None:
        return {"variance": None, "variance_pct": None, "favorable": None, "flag": False}
    v = actual - bench
    vp = pct(v, abs(bench)) if bench else None
    favorable = v >= 0 if category in ("income", "noi") else v <= 0
    big_amt = abs(v) >= float(s["variance_amount"])
    big_pct = vp is None or abs(vp) >= float(s["variance_pct"])
    return {"variance": r2(v), "variance_pct": vp, "favorable": favorable, "flag": bool(big_amt and big_pct and v != 0)}


async def performance(db: AsyncSession, a: Asset, year: int, month: int | None = None) -> dict:
    s = await get_settings(db)
    rows = list(await db.execute(
        select(AssetFinancial.account, AssetFinancial.category, AssetFinancial.period, func.sum(AssetFinancial.amount))
        .where(AssetFinancial.asset_id == a.id, AssetFinancial.is_current.is_(True), AssetFinancial.deleted_at.is_(None),
               AssetFinancial.period >= date(year - 1, 1, 1), AssetFinancial.period <= date(year, 12, 1))
        .group_by(AssetFinancial.account, AssetFinancial.category, AssetFinancial.period)
    ))
    actual: dict[tuple[str, date], float] = defaultdict(float)
    cats: dict[str, str] = {}
    for acct, cat, period, amt in rows:
        actual[(acct, period)] += float(amt or 0)
        cats.setdefault(acct, cat)
    if month is None:
        in_year = [p for (_, p) in actual if p.year == year]
        month = max(in_year).month if in_year else (date.today().month if year == date.today().year else 12)
    end = date(year, month, 1)
    ttm_start = add_months(end, -11)
    budget, bcats, budget_ids = await _budget_lines(db, a.id, {year, year - 1} if ttm_start.year < year else {year})
    for k, v in bcats.items():
        cats.setdefault(k, v)
    outputs = await _uw_outputs(db, a)
    uw_annual, ucats, uw_totals = _uw_lines(outputs)
    for k, v in ucats.items():
        cats.setdefault(k, v)
    months = [date(year, m, 1) for m in range(1, 13)]
    ttm_months = month_range(ttm_start, end)
    order = {"income": 0, "expense": 1, "capex": 2, "reserve": 3, "debt_service": 4, "distribution": 5}
    accounts = sorted({k for k, _ in actual} | {k for k, _ in budget} | set(uw_annual),
                      key=lambda x: (order.get(cats.get(x, "expense"), 9), x))
    have_budget = bool(budget_ids)
    have_uw = outputs is not None

    existing = {}
    for v in await db.scalars(select(VarianceExplanation).where(
            VarianceExplanation.asset_id == a.id, VarianceExplanation.deleted_at.is_(None),
            VarianceExplanation.period == end)):
        existing[(v.account, v.window, v.basis)] = {"id": v.id, "status": v.status}

    def window_vals(get_a, get_b, get_u, ms: list[date]) -> tuple[float, float | None, float | None]:
        act = sum(get_a(m) for m in ms)
        bud = sum(get_b(m) for m in ms) if have_budget else None
        uw = sum(get_u(m) for m in ms) if get_u(ms[0]) is not None else None
        return act, bud, uw

    def build(name: str, cat: str, get_a, get_b, get_u, summary: bool = False) -> dict:
        monthly = [{"period": m, "actual": r2(get_a(m)), "budget": r2(get_b(m)) if have_budget else None,
                    "uw": r2(get_u(m))} for m in months]
        out = {"account": name, "category": cat, "is_summary": summary, "monthly": monthly,
               "drill": f"/assets/{a.id}?tab=financials&account={quote(name)}" if not summary else f"/assets/{a.id}?tab=financials",
               "explanations": {} if summary else {f"{w}:{b}": existing.get((name, w, b)) for w in ("month", "ttm")
                                                   for b in ("budget", "underwriting") if existing.get((name, w, b))}}
        for key, ms in (("month", [end]), ("ttm", ttm_months)):
            act, bud, uw = window_vals(get_a, get_b, get_u, ms)
            vb, vu = _var(act, bud, cat, s), _var(act, uw, cat, s)
            out[key] = {"actual": r2(act), "budget": r2(bud), "uw": r2(uw),
                        "var_budget": vb["variance"], "var_budget_pct": vb["variance_pct"], "fav_budget": vb["favorable"],
                        "flag_budget": vb["flag"] and not summary,
                        "var_uw": vu["variance"], "var_uw_pct": vu["variance_pct"], "fav_uw": vu["favorable"],
                        "flag_uw": vu["flag"] and not summary}
        return out

    lines = []
    for acct in accounts:
        cat = cats.get(acct, "expense")
        uw_m = uw_annual.get(acct)
        lines.append(build(acct, cat,
                           lambda m, acct=acct: actual.get((acct, m), 0.0),
                           lambda m, acct=acct: budget.get((acct, m), 0.0),
                           lambda m, uw_m=uw_m: (uw_m / 12) if uw_m is not None else None))

    def cat_sum(src: dict, cset: set[str], m: date) -> float:
        return sum(v for (acct, p), v in src.items() if p == m and cats.get(acct, "expense") in cset)

    def uw_cat(key: str, cset: set[str]):
        if key in uw_totals:
            return lambda m: uw_totals[key] / 12
        vals = [v for acct, v in uw_annual.items() if cats.get(acct, "expense") in cset]
        return (lambda m: sum(vals) / 12) if vals else (lambda m: None)

    uw_noi = (lambda m: uw_totals["noi"] / 12) if "noi" in uw_totals else (
        (lambda m: (uw_cat("income", INCOME_CATS)(m) or 0) - (uw_cat("expense", EXPENSE_CATS)(m) or 0))
        if uw_cat("income", INCOME_CATS)(end) is not None else (lambda m: None))
    summary = [
        build("Total income", "income", lambda m: cat_sum(actual, INCOME_CATS, m), lambda m: cat_sum(budget, INCOME_CATS, m),
              uw_cat("income", INCOME_CATS), True),
        build("Total operating expenses", "expense", lambda m: cat_sum(actual, EXPENSE_CATS, m),
              lambda m: cat_sum(budget, EXPENSE_CATS, m), uw_cat("expense", EXPENSE_CATS), True),
        build("Net operating income", "noi", lambda m: cat_sum(actual, INCOME_CATS, m) - cat_sum(actual, EXPENSE_CATS, m),
              lambda m: cat_sum(budget, INCOME_CATS, m) - cat_sum(budget, EXPENSE_CATS, m), uw_noi, True),
    ]
    return {
        "asset_id": a.id, "year": year, "month": month, "period": end, "ttm_start": ttm_start, "ttm_end": end,
        "months": months, "budget_available": have_budget, "budget_ids": budget_ids,
        "uw_available": have_uw, "uw_model_id": a.uw_model_id,
        "uw_note": ("Underwriting benchmark is the approved acquisition model (year-1 run rate)." if have_uw
                    else "No approved underwriting model is linked to this asset."),
        "thresholds": {"pct": s["variance_pct"], "amount": s["variance_amount"]},
        "lines": lines, "summary": summary,
    }


async def _variance_task(db: AsyncSession, a: Asset, v: VarianceExplanation, label: str, actor_id: uuid.UUID | None):
    from app.modules.tasks.service import create_task

    task = await create_task(
        db, title=f"Explain {v.basis} variance: {v.account} ({v.window}, {v.period:%b %Y})",
        assignee_id=v.owner_id, due_at=utcnow() + timedelta(days=7), task_type="review", priority="normal",
        description=f"Actual {v.actual} vs {v.basis} {v.benchmark} (variance {v.variance}, {v.variance_pct}%).",
        related_type="asset", related_id=a.id, related_label=label, source="assets.variance",
        idempotency_key=f"variance:{a.id}:{v.period}:{v.window}:{v.basis}:{v.account}"[:200], actor_id=actor_id,
    )
    v.task_id = task.id


async def detect_variances(db: AsyncSession, a: Asset, year: int, month: int | None, actor: Any) -> int:
    """Creates 'required' explanation records for every flagged line without one. Does not commit."""
    perf = await performance(db, a, year, month)
    prop = await db.get(Property, a.property_id)
    created = 0
    for line in perf["lines"]:
        for window in ("month", "ttm"):
            w = line[window]
            for basis, flag, bench, var, vp in (
                ("budget", w["flag_budget"], w["budget"], w["var_budget"], w["var_budget_pct"]),
                ("underwriting", w["flag_uw"], w["uw"], w["var_uw"], w["var_uw_pct"]),
            ):
                if not flag or line["explanations"].get(f"{window}:{basis}"):
                    continue
                v = VarianceExplanation(asset_id=a.id, period=perf["period"], window=window, basis=basis,
                                        account=line["account"], actual=w["actual"], benchmark=bench, variance=var,
                                        variance_pct=vp, owner_id=a.manager_id, status="required",
                                        created_by_id=getattr(actor, "id", None))
                db.add(v)
                await db.flush()
                await _variance_task(db, a, v, prop_label(prop), getattr(actor, "id", None))
                line["explanations"][f"{window}:{basis}"] = {"id": v.id, "status": v.status}
                created += 1
    return created


async def explain(db: AsyncSession, a: Asset, data: ExplainIn, actor: CurrentUser) -> VarianceExplanation:
    period = month_start(data.period)
    v = await db.scalar(select(VarianceExplanation).where(
        VarianceExplanation.asset_id == a.id, VarianceExplanation.period == period,
        VarianceExplanation.window == data.window, VarianceExplanation.basis == data.basis,
        VarianceExplanation.account == data.account, VarianceExplanation.deleted_at.is_(None)))
    if v is None:
        var = (data.actual - data.benchmark) if data.actual is not None and data.benchmark is not None else None
        v = VarianceExplanation(asset_id=a.id, period=period, window=data.window, basis=data.basis,
                                account=data.account, actual=data.actual, benchmark=data.benchmark, variance=var,
                                variance_pct=pct(var, abs(data.benchmark)) if var is not None and data.benchmark else None,
                                created_by_id=actor.id)
        db.add(v)
    await _submit(db, v, data.explanation, data.owner_id or actor.id, actor)
    await db.commit()
    return v


async def _submit(db: AsyncSession, v: VarianceExplanation, text: str, owner_id: uuid.UUID | None, actor: CurrentUser):
    old = v.explanation
    v.explanation = text
    v.owner_id = v.owner_id or owner_id
    v.status = "submitted"
    v.submitted_at = utcnow()
    v.updated_by_id = actor.id
    await db.flush()
    if v.task_id:
        from app.modules.tasks.models import Task

        task = await db.get(Task, v.task_id)
        if task and task.status not in ("done", "cancelled"):
            task.status, task.completed_at, task.completed_by_id = "done", utcnow(), actor.id
    await audit.record(db, actor=actor, action="asset.variance_explained", entity_type=ENTITY, entity_id=v.asset_id,
                       summary=f"{v.account} {v.window} vs {v.basis} ({v.period:%Y-%m})",
                       changes={"explanation": {"from": old, "to": text}}, ip_address=actor.ip_address)


async def submit_explanation(db: AsyncSession, v: VarianceExplanation, text: str, actor: CurrentUser) -> VarianceExplanation:
    await _submit(db, v, text, actor.id, actor)
    await db.commit()
    return v


async def review_explanation(db: AsyncSession, v: VarianceExplanation, decision: str, note: str | None,
                             actor: CurrentUser) -> VarianceExplanation:
    if v.status != "submitted":
        raise HTTPException(409, "Only submitted explanations can be reviewed")
    v.status, v.review_note, v.reviewed_by_id, v.reviewed_at = decision, note, actor.id, utcnow()
    v.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"asset.variance_{decision}", entity_type=ENTITY, entity_id=v.asset_id,
                       summary=f"{v.account} {v.window} vs {v.basis}", changes={"note": note},
                       ip_address=actor.ip_address)
    await db.commit()
    return v


async def variance_items(db: AsyncSession, rows: list[VarianceExplanation]) -> list[dict]:
    assets = {a.id: a for a in await db.scalars(select(Asset).where(Asset.id.in_({r.asset_id for r in rows})))} if rows else {}
    props = await load_props(db, list(assets.values()))
    names = await user_names(db, {r.owner_id for r in rows})
    out = []
    for r in rows:
        a = assets.get(r.asset_id)
        d = {c: getattr(r, c) for c in ("id", "asset_id", "period", "window", "basis", "account", "actual", "benchmark",
                                        "variance", "variance_pct", "owner_id", "explanation", "status", "submitted_at",
                                        "reviewed_at", "review_note", "created_at")}
        d["asset_label"] = prop_label(props.get(a.property_id)) if a else None
        d["owner_name"] = names.get(r.owner_id)
        out.append(d)
    return out


# --------------------------------------------------------------------------- cash flow

async def cash_flow(db: AsyncSession, assets: list[Asset], months: int = 12, end: date | None = None) -> dict:
    ids = {a.id for a in assets}
    end = month_start(end or date.today())
    start = add_months(end, -(months - 1))
    monthly = await monthly_by_category(db, ids, start)
    loans = await active_loans(db, assets)
    est_ds = {aid: sum(l["annual_debt_service"] for l in ls) / 12 for aid, ls in loans.items()}
    rows, cum = [], 0.0
    totals: dict[str, float] = defaultdict(float)
    for m in month_range(start, end):
        r: dict[str, Any] = {"period": m, "income": 0.0, "expense": 0.0, "capex": 0.0, "reserves": 0.0,
                             "debt_service": 0.0, "distributions": 0.0, "debt_service_estimated": False}
        for aid in ids:
            row = monthly.get(aid, {}).get(m, {})
            r["income"] += row.get("income", 0.0)
            r["expense"] += row.get("expense", 0.0)
            r["capex"] += row.get("capex", 0.0)
            r["reserves"] += row.get("reserve", 0.0)
            r["distributions"] += row.get("distribution", 0.0)
            if "debt_service" in row:
                r["debt_service"] += row["debt_service"]
            elif est_ds.get(aid):
                r["debt_service"] += est_ds[aid]
                r["debt_service_estimated"] = True
        r["noi"] = r["income"] - r["expense"]
        r["cash_flow_before_debt"] = r["noi"] - r["capex"] - r["reserves"]
        r["cash_flow_after_debt"] = r["cash_flow_before_debt"] - r["debt_service"]
        r["net_cash_flow"] = r["cash_flow_after_debt"] - r["distributions"]
        cum += r["net_cash_flow"]
        r["cumulative"] = cum
        for k in ("income", "expense", "noi", "capex", "reserves", "debt_service", "cash_flow_before_debt",
                  "cash_flow_after_debt", "distributions", "net_cash_flow"):
            totals[k] += r[k]
            r[k] = round(r[k], 2)
        r["cumulative"] = round(cum, 2)
        rows.append(r)
    drill = ([{"label": "Monthly financials", "href": f"/assets/{assets[0].id}?tab=financials"}] if len(assets) == 1
             else [{"label": "Assets", "href": "/assets"}])
    drill += [{"label": f"Loan · {l['lender_name']}", "href": f"/loans/{l['id']}"} for ls in loans.values() for l in ls][:20]
    return {"start": start, "end": end, "rows": rows, "totals": {k: round(v, 2) for k, v in totals.items()},
            "asset_count": len(assets), "drill": drill,
            "note": "Debt service falls back to scheduled payments from loan terms where no actual was entered."}


# --------------------------------------------------------------------------- portfolio views

def _aggregate(ids: list[uuid.UUID], kp: dict[uuid.UUID, dict], assets: dict[uuid.UUID, Asset]) -> dict:
    ks = [kp[i] for i in ids]
    value = sum(k["value"] or 0 for k in ks)
    noi = sum(k["noi_ttm"] or 0 for k in ks)
    debt = sum(k["debt"] or 0 for k in ks)
    ds = sum(k["debt_service"] or 0 for k in ks)
    cost = sum(k["cost"] or 0 for k in ks)
    occ_w = [(k["building_sf"] or 1, k["occupancy"]) for k in ks if k["occupancy"] is not None]
    wale_w = [(k["value"] or 1, k["wale"]) for k in ks if k["wale"] is not None]
    return {
        "asset_count": len(ids), "value": r2(value), "basis": r2(sum(float(assets[i].basis or 0) for i in ids)),
        "noi_ttm": r2(noi), "debt": r2(debt), "debt_service": r2(ds),
        "occupancy": r2(sum(w * o for w, o in occ_w) / sum(w for w, _ in occ_w)) if occ_w else None,
        "wale": r2(sum(w * y for w, y in wale_w) / sum(w for w, _ in wale_w)) if wale_w else None,
        "yield_on_cost": pct(noi, cost), "leverage": pct(debt, value), "coverage": r2(safe_div(noi, ds), 3),
    }


async def portfolio(db: AsyncSession, f: AssetFilters, group_by: str) -> dict:
    if not f.status:
        f.status = ["active", "held_for_sale"]
    assets = list(await db.scalars(build_query(f)))
    props = await load_props(db, assets)
    kp = await compute_kpis(db, assets, props)
    amap = {a.id: a for a in assets}
    ids = [a.id for a in assets]
    totals = _aggregate(ids, kp, amap)
    loan_drill = [{"label": "Loans", "href": "/loans"}]
    total_metrics = {
        "occupancy": Metric(value=totals["occupancy"], label="Occupancy", drill=[{"label": "Assets by occupancy", "href": "/assets?sort=occupancy"}]),
        "wale": Metric(value=totals["wale"], label="WALE (years)", drill=[{"label": "Leases", "href": "/leases"}]),
        "noi": Metric(value=totals["noi_ttm"], label="NOI (TTM)", drill=[{"label": "Assets", "href": "/assets"}]),
        "yield_on_cost": Metric(value=totals["yield_on_cost"], label="Yield on cost", drill=[{"label": "Assets", "href": "/assets"}]),
        "leverage": Metric(value=totals["leverage"], label="Leverage", drill=loan_drill),
        "coverage": Metric(value=totals["coverage"], label="Coverage", drill=loan_drill),
        "value": Metric(value=totals["value"], label="Value", drill=[{"label": "Assets", "href": "/assets"}]),
    }

    groups: dict[str, dict] = {}

    def add(key: str, label: str, aid: uuid.UUID, measure: float) -> None:
        g = groups.setdefault(key, {"key": key, "label": label, "ids": [], "measure": 0.0})
        if aid not in g["ids"]:
            g["ids"].append(aid)
        g["measure"] += measure

    measure_label = "Value"
    unavailable = None
    for a in assets:
        p, k = props.get(a.property_id), kp[a.id]
        value = k["value"] or 0
        if group_by == "property_type":
            add(p.property_type if p else "other", (p.property_type if p else "other"), a.id, value)
        elif group_by == "geography":
            st, co = (p.state or "Unknown") if p else "Unknown", (p.county or "Unknown county") if p else "Unknown county"
            add(f"{st}|{co}", f"{st} · {co}", a.id, value)
        elif group_by == "corridor":
            c = (p.corridor if p else None) or "No corridor"
            add(c, c, a.id, value)
        elif group_by == "vintage":
            y = str(a.acquired_on.year) if a.acquired_on else "Unknown"
            add(y, y, a.id, value)
        elif group_by == "lender":
            measure_label = "Debt balance"
            if not k["loans"]:
                add("unlevered", "Unlevered", a.id, 0.0)
            for l in k["loans"]:
                add(l["lender_name"], l["lender_name"], a.id, l["balance"])
        elif group_by == "tenant":
            measure_label = "Annual base rent"
            if k["leases"] is None:
                unavailable = "Lease data is not available."
            for l in k["leases"] or []:
                add(norm_key(l["tenant_name"]), l["tenant_name"], a.id, l["annual_rent"])
        elif group_by == "capital_partner":
            measure_label = "Value attributable"
    if group_by == "capital_partner":
        stakes = await partner_stakes(db, set(ids))
        if stakes is None:
            unavailable = "Investor data is not available."
        else:
            for a in assets:
                for s in stakes.get(a.id, []):
                    add(str(s["partner_id"]), s["name"], a.id, (kp[a.id]["value"] or 0) * s["ownership_pct"] / 100)
    if group_by == "territory":
        from app.modules.territories.models import Territory, TerritoryMember

        rows = await db.execute(
            select(TerritoryMember.property_id, Territory.id, Territory.name)
            .join(Territory, Territory.id == TerritoryMember.territory_id)
            .where(TerritoryMember.property_id.in_({a.property_id for a in assets}), Territory.deleted_at.is_(None))
        )
        by_prop = {a.property_id: a for a in assets}
        for pid, tid, name in rows.all():
            a = by_prop[pid]
            add(str(tid), name, a.id, kp[a.id]["value"] or 0)

    total_measure = sum(g["measure"] for g in groups.values())
    out_groups = []
    for g in sorted(groups.values(), key=lambda x: -x["measure"]):
        agg = _aggregate(g["ids"], kp, amap)
        if group_by == "property_type":
            href = f"/assets?property_type={g['key']}"
        elif group_by == "geography":
            href = f"/assets?state={g['key'].split('|')[0]}"
        elif group_by == "territory":
            href = f"/territories/{g['key']}"
        else:
            href = "/assets?" + "&".join(f"ids={i}" for i in g["ids"][:60])
        out_groups.append({"key": g["key"], "label": g["label"], "measure": r2(g["measure"]),
                           "share_pct": pct(g["measure"], total_measure), "asset_ids": g["ids"], **agg,
                           "drill": href})
    return {"group_by": group_by, "measure_label": measure_label, "unavailable": unavailable, "totals": totals,
            "metrics": total_metrics, "groups": out_groups}


# --------------------------------------------------------------------------- concentration

async def tenant_profiles(db: AsyncSession) -> dict[str, TenantProfile]:
    return {t.tenant_key: t for t in await db.scalars(select(TenantProfile).where(TenantProfile.deleted_at.is_(None)))}


async def concentration(db: AsyncSession) -> dict:
    assets = list(await db.scalars(select(Asset).where(Asset.deleted_at.is_(None), Asset.status.in_(["active", "held_for_sale"]))))
    props = await load_props(db, assets)
    kp = await compute_kpis(db, assets, props)
    profiles = await tenant_profiles(db)
    limits = list(await db.scalars(select(ConcentrationLimit).where(ConcentrationLimit.deleted_at.is_(None),
                                                                     ConcentrationLimit.is_active.is_(True))))
    buckets: dict[str, dict[str, dict]] = {d: {} for d in ("tenant", "brand", "industry", "guarantor", "lender", "geography")}

    def add(dim: str, key: str, label: str, amount: float, aid: uuid.UUID) -> None:
        b = buckets[dim].setdefault(key, {"key": key, "label": label, "amount": 0.0, "asset_ids": []})
        b["amount"] += amount
        if aid not in b["asset_ids"]:
            b["asset_ids"].append(aid)

    leases_available = True
    for a in assets:
        k, p = kp[a.id], props.get(a.property_id)
        if k["leases"] is None:
            leases_available = False
        for l in k["leases"] or []:
            tk = norm_key(l["tenant_name"])
            prof = profiles.get(tk)
            add("tenant", tk, l["tenant_name"], l["annual_rent"], a.id)
            brand = (prof.brand if prof else None) or l["tenant_name"]
            add("brand", norm_key(brand), brand, l["annual_rent"], a.id)
            ind = (prof.industry if prof else None) or "Unclassified"
            add("industry", norm_key(ind), ind, l["annual_rent"], a.id)
            g = l.get("guarantor") or "No guarantor"
            add("guarantor", norm_key(g), g, l["annual_rent"], a.id)
        for l in k["loans"]:
            add("lender", norm_key(l["lender_name"]), l["lender_name"], l["balance"], a.id)
        st = (p.state if p else None) or "Unknown"
        add("geography", st.lower(), st, k["value"] or 0, a.id)

    measures = {"tenant": "Annual base rent", "brand": "Annual base rent", "industry": "Annual base rent",
                "guarantor": "Annual base rent", "lender": "Debt balance", "geography": "Value"}
    result: dict[str, Any] = {}
    breaches = []
    for dim, items in buckets.items():
        total = sum(i["amount"] for i in items.values())
        rows = []
        for i in sorted(items.values(), key=lambda x: -x["amount"]):
            share = pct(i["amount"], total) or 0.0
            matching = [lim for lim in limits if lim.dimension == dim and (lim.key is None or norm_key(lim.key) == i["key"])]
            lim = min(matching, key=lambda x: x.max_pct) if matching else None
            breached = bool(lim and share > lim.max_pct)
            row = {**i, "amount": r2(i["amount"]), "pct": share, "limit_pct": lim.max_pct if lim else None,
                   "limit_id": lim.id if lim else None, "severity": lim.severity if lim else None, "breached": breached,
                   "drill": "/assets?" + "&".join(f"ids={x}" for x in i["asset_ids"][:60])}
            rows.append(row)
            if breached:
                breaches.append({"dimension": dim, **row})
        result[dim] = {"measure": measures[dim], "total": r2(total), "items": rows,
                       "unavailable": None if (leases_available or dim in ("lender", "geography")) else "Lease data is not available."}
    return {"dimensions": result, "breaches": breaches}


async def check_concentration(db: AsyncSession) -> list[dict]:
    """Raises one alert per breached limit per month. Does not commit."""
    from app.modules.tasks.service import raise_alert

    data = await concentration(db)
    stamp = date.today().strftime("%Y-%m")
    for b in data["breaches"]:
        await raise_alert(
            db, title=f"Concentration limit exceeded: {b['dimension']} · {b['label']}",
            reason=f"{b['label']} is {b['pct']}% of portfolio {b['dimension']} exposure (limit {b['limit_pct']}%).",
            severity=b["severity"] or "medium", related_type="concentration_limit", related_id=b["limit_id"],
            related_label=f"{b['dimension']}: {b['label']}", rule_key="assets.concentration",
            idempotency_key=f"concentration:{b['dimension']}:{b['key']}:{stamp}"[:200],
        )
    return data["breaches"]


# --------------------------------------------------------------------------- watchlist

async def _maintenance_backlog(db: AsyncSession, property_id: uuid.UUID, overdue_days: int) -> tuple[int, int] | None:
    try:
        from app.modules.maintenance.models import WorkOrder
    except ImportError:
        return None
    try:
        rows = list(await db.scalars(select(WorkOrder).where(WorkOrder.property_id == property_id,
                                                             WorkOrder.deleted_at.is_(None))))
    except AttributeError:
        return None
    closed = {"completed", "closed", "cancelled", "done", "resolved"}
    open_rows = [w for w in rows if (getattr(w, "status", None) or "open") not in closed]
    cutoff = date.today() - timedelta(days=overdue_days)
    overdue = 0
    for w in open_rows:
        due = getattr(w, "due_on", None) or getattr(w, "due_at", None)
        if due is not None and hasattr(due, "date"):
            due = due.date()
        if due is not None and due < cutoff:
            overdue += 1
    return len(open_rows), overdue


async def _persistent_variance(db: AsyncSession, a: Asset, s: dict) -> list[str]:
    n = int(s["persistent_variance_months"])
    end = month_start(date.today())
    latest = await db.scalar(select(func.max(AssetFinancial.period)).where(
        AssetFinancial.asset_id == a.id, AssetFinancial.is_current.is_(True), AssetFinancial.deleted_at.is_(None)))
    if not latest:
        return []
    end = min(end, latest)
    months = month_range(add_months(end, -(n - 1)), end)
    budget, bcats, used = await _budget_lines(db, a.id, {m.year for m in months})
    if not used:
        return []
    rows = await db.execute(
        select(AssetFinancial.account, AssetFinancial.category, AssetFinancial.period, func.sum(AssetFinancial.amount))
        .where(AssetFinancial.asset_id == a.id, AssetFinancial.is_current.is_(True), AssetFinancial.deleted_at.is_(None),
               AssetFinancial.period.in_(months))
        .group_by(AssetFinancial.account, AssetFinancial.category, AssetFinancial.period)
    )
    actual: dict[tuple[str, date], float] = defaultdict(float)
    cats = dict(bcats)
    for acct, cat, period, amt in rows.all():
        actual[(acct, period)] += float(amt or 0)
        cats.setdefault(acct, cat)
    persistent = []
    for acct in {k for k, _ in actual} | {k for k, _ in budget}:
        flags = [_var(actual.get((acct, m), 0.0), budget.get((acct, m), 0.0), cats.get(acct, "expense"), s)["flag"]
                 for m in months]
        if all(flags):
            persistent.append(acct)
    return sorted(persistent)


async def scan_watchlist(db: AsyncSession, actor: Any, asset_ids: list[uuid.UUID] | None = None) -> dict:
    """Evaluates every watchlist trigger, opens/refreshes entries (+ alerts) and clears resolved ones. Does not commit."""
    from app.modules.tasks.service import raise_alert

    s = await get_settings(db)
    stmt = select(Asset).where(Asset.deleted_at.is_(None), Asset.status.in_(["active", "held_for_sale"]))
    if asset_ids:
        stmt = stmt.where(Asset.id.in_(asset_ids))
    assets = list(await db.scalars(stmt))
    props = await load_props(db, assets)
    kp = await compute_kpis(db, assets, props, with_value=False)
    profiles = await tenant_profiles(db)
    today = date.today()
    now = utcnow()
    opened = refreshed = cleared = 0
    for a in assets:
        k, p = kp[a.id], props.get(a.property_id)
        label = prop_label(p)
        fired: dict[str, dict] = {}
        if k["coverage"] is not None and k["coverage"] < s["watch_min_dscr"]:
            fired["coverage"] = {"severity": "high" if k["coverage"] < 1.0 else "medium", "metric": k["coverage"],
                                 "threshold": s["watch_min_dscr"], "href": f"/assets/{a.id}?tab=cash-flow",
                                 "detail": f"Coverage {k['coverage']:.2f}x below {s['watch_min_dscr']}x"}
        if k["occupancy"] is not None and k["occupancy"] < s["watch_min_occupancy"]:
            fired["occupancy"] = {"severity": "medium", "metric": k["occupancy"], "threshold": s["watch_min_occupancy"],
                                  "href": f"/leases?property_id={a.property_id}" if k["occupancy_source"] == "leases" else f"/properties/{a.property_id}",
                                  "detail": f"Occupancy {k['occupancy']:.1f}% below {s['watch_min_occupancy']}%"}
        watch_tenants = sorted({l["tenant_name"] for l in (k["leases"] or [])
                                if (pr := profiles.get(norm_key(l["tenant_name"]))) and pr.credit_watch})
        if watch_tenants:
            fired["tenant_credit"] = {"severity": "high", "metric": float(len(watch_tenants)), "threshold": None,
                                      "href": f"/leases?property_id={a.property_id}",
                                      "detail": "Tenant credit watch: " + ", ".join(watch_tenants)}
        mb = await _maintenance_backlog(db, a.property_id, int(s["maintenance_overdue_days"]))
        if mb and (mb[0] >= int(s["maintenance_backlog"]) or mb[1] > 0):
            fired["maintenance"] = {"severity": "medium", "metric": float(mb[0]), "threshold": float(s["maintenance_backlog"]),
                                    "href": f"/work-orders?property_id={a.property_id}",
                                    "detail": f"{mb[0]} open work orders, {mb[1]} overdue more than {s['maintenance_overdue_days']} days"}
        bad = [l for l in k["loans"] if l["covenant_state"] in ("watch", "breach", "projected_breach")]
        if bad:
            worst = "breach" if any(l["covenant_state"] == "breach" for l in bad) else (
                "projected_breach" if any(l["covenant_state"] == "projected_breach" for l in bad) else "watch")
            fired["covenant"] = {"severity": {"breach": "critical", "projected_breach": "high"}.get(worst, "medium"),
                                 "metric": None, "threshold": None, "href": f"/loans/{bad[0]['id']}?tab=covenants",
                                 "detail": f"Covenant status {worst.replace('_', ' ')} on {len(bad)} loan(s)"}
        horizon = add_months(today, int(s["maturity_months"]))
        maturing = [l for l in k["loans"] if l["maturity_on"] and l["maturity_on"] <= horizon]
        if maturing:
            first = min(maturing, key=lambda l: l["maturity_on"])
            fired["maturity"] = {"severity": "high" if first["maturity_on"] <= add_months(today, 6) else "medium",
                                 "metric": float((first["maturity_on"] - today).days), "threshold": float(s["maturity_months"]),
                                 "href": f"/loans/{first['id']}",
                                 "detail": f"Loan with {first['lender_name']} matures {first['maturity_on'].isoformat()}"}
        persistent = await _persistent_variance(db, a, s)
        if persistent:
            fired["variance"] = {"severity": "medium", "metric": float(len(persistent)),
                                 "threshold": float(s["persistent_variance_months"]),
                                 "href": f"/assets/{a.id}?tab=financials",
                                 "detail": f"Budget variance above threshold for {s['persistent_variance_months']}+ consecutive months: "
                                           + ", ".join(persistent[:6])}

        open_entries = {e.trigger: e for e in await db.scalars(select(WatchlistEntry).where(
            WatchlistEntry.asset_id == a.id, WatchlistEntry.status == "open", WatchlistEntry.deleted_at.is_(None)))}
        for trig, info in fired.items():
            e = open_entries.get(trig)
            if e:
                e.last_detected_at, e.detail, e.metric_value, e.severity = now, info["detail"], info["metric"], info["severity"]
                refreshed += 1
                continue
            e = WatchlistEntry(asset_id=a.id, trigger=trig, severity=info["severity"], status="open",
                               detail=info["detail"], metric_value=info["metric"], threshold=info["threshold"],
                               source_href=info["href"], first_detected_at=now, last_detected_at=now,
                               created_by_id=getattr(actor, "id", None))
            db.add(e)
            await db.flush()
            alert = await raise_alert(
                db, title=f"Watchlist: {trig.replace('_', ' ')} · {label}", reason=info["detail"],
                severity=info["severity"], owner_id=a.manager_id, related_type="asset", related_id=a.id,
                related_label=label, rule_key=f"assets.watchlist.{trig}", idempotency_key=f"watchlist:{e.id}",
            )
            e.alert_id = alert.id
            opened += 1
        for trig, e in open_entries.items():
            if trig not in fired:
                e.status, e.resolved_at, e.resolution_note = "resolved", now, "Condition cleared on automated scan"
                cleared += 1
    breaches = await check_concentration(db)
    await audit.record(db, actor=actor, action="asset.watchlist_scanned", entity_type=ENTITY,
                       summary=f"{len(assets)} assets: {opened} opened, {refreshed} refreshed, {cleared} cleared",
                       changes={"opened": opened, "refreshed": refreshed, "cleared": cleared,
                                "concentration_breaches": len(breaches)})
    return {"assets": len(assets), "opened": opened, "refreshed": refreshed, "cleared": cleared,
            "concentration_breaches": len(breaches)}


async def watch_items(db: AsyncSession, rows: list[WatchlistEntry]) -> list[dict]:
    assets = {a.id: a for a in await db.scalars(select(Asset).where(Asset.id.in_({r.asset_id for r in rows})))} if rows else {}
    props = await load_props(db, list(assets.values()))
    out = []
    for r in rows:
        a = assets.get(r.asset_id)
        d = {c: getattr(r, c) for c in ("id", "asset_id", "trigger", "severity", "status", "detail", "metric_value",
                                        "threshold", "source_href", "first_detected_at", "last_detected_at",
                                        "resolved_at", "resolution_note", "alert_id")}
        d["asset_label"] = prop_label(props.get(a.property_id)) if a else None
        out.append(d)
    return out


async def resolve_watch(db: AsyncSession, e: WatchlistEntry, new_status: str, note: str, actor: CurrentUser) -> WatchlistEntry:
    if e.status != "open":
        raise HTTPException(409, "Entry is not open")
    e.status, e.resolution_note, e.resolved_at, e.resolved_by_id = new_status, note, utcnow(), actor.id
    e.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"asset.watchlist_{new_status}", entity_type=ENTITY, entity_id=e.asset_id,
                       summary=f"{e.trigger}: {note}", ip_address=actor.ip_address)
    await db.commit()
    return e


# --------------------------------------------------------------------------- milestones

async def milestone_items(db: AsyncSession, rows: list[AssetMilestone]) -> list[dict]:
    names = await user_names(db, {r.owner_id for r in rows})
    today = date.today()
    return [{
        **{c: getattr(r, c) for c in ("id", "asset_id", "title", "description", "owner_id", "due_on", "status",
                                      "completed_on", "task_id", "updated_at")},
        "owner_name": names.get(r.owner_id),
        "overdue": bool(r.due_on and r.due_on < today and r.status in ("planned", "in_progress")),
    } for r in rows]


async def _milestone_task(db: AsyncSession, a: Asset, m: AssetMilestone, actor: CurrentUser) -> None:
    if not m.owner_id or m.status not in ("planned", "in_progress"):
        return
    from datetime import datetime, time, timezone

    from app.modules.tasks.service import create_task

    prop = await db.get(Property, a.property_id)
    due = datetime.combine(m.due_on, time(17, 0), tzinfo=timezone.utc) if m.due_on else None
    task = await create_task(db, title=f"Milestone: {m.title}", assignee_id=m.owner_id, due_at=due, task_type="general",
                             description=m.description, related_type="asset", related_id=a.id,
                             related_label=prop_label(prop), source="assets.milestone",
                             idempotency_key=f"milestone:{m.id}:{m.owner_id}", actor_id=actor.id)
    m.task_id = task.id


async def create_milestone(db: AsyncSession, a: Asset, data: MilestoneIn, actor: CurrentUser) -> AssetMilestone:
    m = AssetMilestone(asset_id=a.id, **data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    if m.status == "done":
        m.completed_on = date.today()
    db.add(m)
    await db.flush()
    await _milestone_task(db, a, m, actor)
    await audit.record(db, actor=actor, action="asset.milestone_created", entity_type=ENTITY, entity_id=a.id,
                       summary=m.title, ip_address=actor.ip_address)
    await db.commit()
    return m


async def update_milestone(db: AsyncSession, m: AssetMilestone, data: MilestoneUpdate, actor: CurrentUser) -> AssetMilestone:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(m, values)
    if not changes:
        return m
    for k, v in values.items():
        setattr(m, k, v)
    if "status" in changes:
        m.completed_on = date.today() if m.status == "done" else None
        if m.task_id and m.status in ("done", "cancelled"):
            from app.modules.tasks.models import Task

            task = await db.get(Task, m.task_id)
            if task and task.status not in ("done", "cancelled"):
                task.status = "done" if m.status == "done" else "cancelled"
                task.completed_at, task.completed_by_id = utcnow(), actor.id
    m.updated_by_id = actor.id
    if "owner_id" in changes:
        await _milestone_task(db, await get(db, m.asset_id), m, actor)
    await audit.record(db, actor=actor, action="asset.milestone_updated", entity_type=ENTITY, entity_id=m.asset_id,
                       summary=m.title, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return m
