import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.assets.calc import add_days, add_months, month_start, months_between, pct, r2, safe_div
from app.modules.auth.models import User
from app.modules.debt import calc
from app.modules.debt.models import (
    COVENANT_STATE_RANK,
    FREQ_MONTHS,
    MATERIAL_FIELDS,
    Covenant,
    CovenantTest,
    DebtSetting,
    LenderReportingObligation,
    Loan,
    LoanEvent,
    LoanProperty,
    LoanReserve,
    ReserveTransaction,
)
from app.modules.debt.schemas import (
    CollateralIn,
    CollateralOut,
    CovenantIn,
    DebtSettingsIn,
    LoanCreate,
    LoanOut,
    LoanUpdate,
    MarketTerms,
    ObligationIn,
    ReserveIn,
    ReserveTxnIn,
)
from app.modules.properties.models import Property

ENTITY = "loan"
DEFAULT_SETTINGS = DebtSettingsIn().model_dump()
KIND_LABELS = {"dscr": "DSCR", "debt_yield": "Debt yield", "ltv": "LTV", "occupancy": "Occupancy",
               "net_worth": "Guarantor net worth"}
DEFAULT_OPERATOR = {"dscr": "min", "debt_yield": "min", "ltv": "max", "occupancy": "min", "net_worth": "min"}


def _due_dt(d: date) -> datetime:
    return datetime.combine(d, time(17, 0), tzinfo=timezone.utc)


# --------------------------------------------------------------------------- settings / lookups

async def get_settings(db: AsyncSession) -> dict:
    row = await db.scalar(select(DebtSetting).where(DebtSetting.key == "config"))
    merged = {**DEFAULT_SETTINGS, **((row.value if row else None) or {})}
    merged["market"] = {**DEFAULT_SETTINGS["market"], **(merged.get("market") or {})}
    return merged


async def save_settings(db: AsyncSession, data: DebtSettingsIn, actor: CurrentUser) -> dict:
    row = await db.scalar(select(DebtSetting).where(DebtSetting.key == "config"))
    before = await get_settings(db)
    if row is None:
        row = DebtSetting(key="config", value={}, created_by_id=actor.id)
        db.add(row)
    row.value = data.model_dump()
    row.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="debt.settings_updated", entity_type="debt_settings",
                       changes={"from": before, "to": row.value}, ip_address=actor.ip_address)
    await db.commit()
    return await get_settings(db)


def loan_label(l: Loan) -> str:
    return l.name or " · ".join(x for x in [l.lender_name, l.loan_number] if x) or "Loan"


async def get(db: AsyncSession, loan_id: uuid.UUID) -> Loan:
    l = await db.get(Loan, loan_id)
    if not l or l.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Loan not found")
    return l


async def prop_labels(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {p.id: (p.name or p.address_line) for p in await db.scalars(select(Property).where(Property.id.in_(ids)))}


async def user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: u.full_name for u in await db.scalars(select(User).where(User.id.in_(ids)))}


def refi_window(l: Loan, s: dict) -> tuple[date | None, bool, int | None]:
    if not l.maturity_on:
        return None, False, None
    opens = add_months(l.maturity_on, -int(s["refi_window_months"]))
    today = date.today()
    return opens, (l.status == "active" and opens <= today <= l.maturity_on), months_between(today, l.maturity_on)


# --------------------------------------------------------------------------- list

@dataclass
class LoanFilters:
    q: str | None = None
    status: list[str] | None = None
    rate_type: list[str] | None = None
    loan_type: list[str] | None = None
    covenant_state: list[str] | None = None
    lender_name: list[str] | None = None
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    maturity_from: date | None = None
    maturity_to: date | None = None


def build_query(f: LoanFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Loan).where(Loan.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Loan.name, Loan.loan_number, Loan.lender_name])
    for key, col in (("status", Loan.status), ("rate_type", Loan.rate_type), ("loan_type", Loan.loan_type),
                     ("covenant_state", Loan.covenant_state), ("lender_name", Loan.lender_name)):
        if key not in skip:
            stmt = in_filter(stmt, col, getattr(f, key))
    if f.property_id:
        linked = select(LoanProperty.loan_id).where(LoanProperty.property_id == f.property_id)
        stmt = stmt.where((Loan.property_id == f.property_id) | Loan.id.in_(linked))
    if f.asset_id:
        stmt = stmt.where(Loan.asset_id == f.asset_id)
    return range_filter(stmt, Loan.maturity_on, f.maturity_from, f.maturity_to)


async def to_items(db: AsyncSession, loans: list[Loan]) -> list[dict]:
    s = await get_settings(db)
    labels = await prop_labels(db, {l.property_id for l in loans})
    out = []
    for l in loans:
        _, in_win, mtm = refi_window(l, s)
        out.append({
            "id": l.id, "name": l.name, "loan_number": l.loan_number, "label": loan_label(l),
            "property_id": l.property_id, "property_label": labels.get(l.property_id), "asset_id": l.asset_id,
            "lender_name": l.lender_name, "loan_type": l.loan_type, "current_balance": l.current_balance,
            "rate": l.rate, "rate_type": l.rate_type, "maturity_on": l.maturity_on, "months_to_maturity": mtm,
            "in_refi_window": in_win, "cap_expires_on": l.cap_expires_on, "status": l.status,
            "covenant_state": l.covenant_state, "updated_at": l.updated_at,
        })
    return out


async def to_out(db: AsyncSession, l: Loan) -> LoanOut:
    s = await get_settings(db)
    out = LoanOut.model_validate(l)
    out.label = loan_label(l)
    links = list(await db.scalars(select(LoanProperty).where(LoanProperty.loan_id == l.id)))
    labels = await prop_labels(db, {l.property_id} | {x.property_id for x in links})
    out.property_label = labels.get(l.property_id)
    out.lender_label = l.lender_name
    out.owner_name = (await user_names(db, {l.owner_id})).get(l.owner_id)
    out.annual_debt_service = calc.annual_debt_service(l) if l.status == "active" else None
    out.refi_window_opens_on, out.in_refi_window, out.months_to_maturity = refi_window(l, s)
    out.collateral = [CollateralOut(id=x.id, property_id=x.property_id, property_label=labels.get(x.property_id),
                                    allocated_amount=x.allocated_amount, release_price=x.release_price,
                                    is_primary=x.property_id == l.property_id) for x in links]
    reserves = await db.scalars(select(LoanReserve).where(LoanReserve.loan_id == l.id, LoanReserve.deleted_at.is_(None)))
    out.reserve_balance = round(sum(float(r.balance or 0) for r in reserves), 2)
    return out


# --------------------------------------------------------------------------- history

async def add_event(db: AsyncSession, loan: Loan, event_type: str, actor: Any, *, field: str | None = None,
                    from_value: Any = None, to_value: Any = None, effective_on: date | None = None,
                    note: str | None = None) -> LoanEvent:
    ev = LoanEvent(loan_id=loan.id, event_type=event_type, field=field, from_value=audit.to_jsonable(from_value),
                   to_value=audit.to_jsonable(to_value), effective_on=effective_on or date.today(), note=note,
                   actor_id=getattr(actor, "id", None), actor_name=getattr(actor, "full_name", None))
    db.add(ev)
    return ev


def _event_type(field: str, old: Any, new: Any) -> str:
    if field == "current_balance":
        return "balance_change"
    if field in ("rate", "spread", "index_name", "rate_floor"):
        return "rate_change"
    if field == "status":
        return "payoff" if new in ("paid_off", "defeased", "refinanced") else "status_change"
    if field == "maturity_on" and old and new and str(new) > str(old):
        return "extension"
    return "modification"


# --------------------------------------------------------------------------- mutations

async def _resolve_links(db: AsyncSession, values: dict) -> None:
    """Fill property_id from asset_id (and vice versa) so a loan is always tied to its collateral."""
    from app.modules.assets.models import Asset

    if values.get("asset_id") and not values.get("property_id"):
        a = await db.get(Asset, values["asset_id"])
        if a:
            values["property_id"] = a.property_id
    elif values.get("property_id") and not values.get("asset_id"):
        a = await db.scalar(select(Asset).where(Asset.property_id == values["property_id"], Asset.deleted_at.is_(None)))
        if a:
            values["asset_id"] = a.id


async def create(db: AsyncSession, data: LoanCreate, actor: CurrentUser) -> Loan:
    values = data.model_dump(mode="json")
    values.update(data.model_dump(include={"property_id", "asset_id", "lender_organization_id", "owner_id",
                                           "originated_on", "maturity_on", "cap_expires_on", "swap_expires_on"}))
    if values.get("current_balance") is None:
        values["current_balance"] = values.get("original_balance")
    await _resolve_links(db, values)
    loan = Loan(**values, covenant_state="none", created_by_id=actor.id, updated_by_id=actor.id)
    db.add(loan)
    await db.flush()
    if loan.property_id:
        db.add(LoanProperty(loan_id=loan.id, property_id=loan.property_id, added_by_id=actor.id))
    await add_event(db, loan, "created", actor, to_value={"balance": loan.current_balance, "rate": loan.rate,
                                                          "maturity_on": loan.maturity_on},
                    effective_on=loan.originated_on)
    await audit.record(db, actor=actor, action="loan.created", entity_type=ENTITY, entity_id=loan.id,
                       summary=loan_label(loan), ip_address=actor.ip_address)
    await events.emit(db, "loan.created", loan_id=loan.id, property_id=loan.property_id, actor=actor)
    await db.commit()
    return loan


async def update(db: AsyncSession, loan: Loan, data: LoanUpdate, actor: CurrentUser) -> Loan:
    raw = data.model_dump(exclude_unset=True, exclude={"effective_on", "change_note"})
    values = {}
    for k, v in raw.items():
        if k in ("guarantors", "prepayment", "extension_options"):
            dumped = data.model_dump(mode="json", include={k})[k]
            values[k] = dumped if dumped is not None else ([] if k != "prepayment" else {})
        else:
            values[k] = v
    if "asset_id" in values or "property_id" in values:
        await _resolve_links(db, values)
    changes = audit.diff(loan, values)
    if not changes:
        return loan
    for field, ch in changes.items():
        if field in MATERIAL_FIELDS:
            await add_event(db, loan, _event_type(field, ch["from"], ch["to"]), actor, field=field,
                            from_value=ch["from"], to_value=ch["to"], effective_on=data.effective_on,
                            note=data.change_note)
    for k, v in values.items():
        setattr(loan, k, v)
    if "property_id" in changes and loan.property_id:
        exists = await db.scalar(select(LoanProperty).where(LoanProperty.loan_id == loan.id,
                                                            LoanProperty.property_id == loan.property_id))
        if not exists:
            db.add(LoanProperty(loan_id=loan.id, property_id=loan.property_id, added_by_id=actor.id))
    loan.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="loan.updated", entity_type=ENTITY, entity_id=loan.id, changes=changes,
                       summary=data.change_note, ip_address=actor.ip_address)
    await events.emit(db, "loan.updated", loan_id=loan.id, property_id=loan.property_id, changed=set(changes), actor=actor)
    await db.commit()
    return loan


async def archive(db: AsyncSession, loan: Loan, actor: CurrentUser) -> None:
    loan.deleted_at, loan.updated_by_id = utcnow(), actor.id
    await audit.record(db, actor=actor, action="loan.archived", entity_type=ENTITY, entity_id=loan.id,
                       summary=loan_label(loan), ip_address=actor.ip_address)
    await db.commit()


async def add_collateral(db: AsyncSession, loan: Loan, data: CollateralIn, actor: CurrentUser) -> LoanProperty:
    prop = await db.get(Property, data.property_id)
    if not prop or prop.deleted_at:
        raise HTTPException(404, "Property not found")
    link = await db.scalar(select(LoanProperty).where(LoanProperty.loan_id == loan.id,
                                                      LoanProperty.property_id == data.property_id))
    if link is None:
        link = LoanProperty(loan_id=loan.id, property_id=data.property_id, added_by_id=actor.id)
        db.add(link)
    link.allocated_amount, link.release_price = data.allocated_amount, data.release_price
    await add_event(db, loan, "collateral_change", actor, field="collateral", to_value=data.model_dump(),
                    note=f"Collateral: {prop.name or prop.address_line}")
    await audit.record(db, actor=actor, action="loan.collateral_added", entity_type=ENTITY, entity_id=loan.id,
                       changes=data.model_dump(), ip_address=actor.ip_address)
    await db.commit()
    return link


async def remove_collateral(db: AsyncSession, loan: Loan, link_id: uuid.UUID, actor: CurrentUser) -> None:
    link = await db.get(LoanProperty, link_id)
    if not link or link.loan_id != loan.id:
        raise HTTPException(404, "Collateral link not found")
    if link.property_id == loan.property_id:
        raise HTTPException(409, "The primary property cannot be removed; change the loan's property instead")
    await add_event(db, loan, "collateral_change", actor, field="collateral",
                    from_value={"property_id": link.property_id, "allocated_amount": link.allocated_amount},
                    note="Collateral released")
    await db.delete(link)
    await audit.record(db, actor=actor, action="loan.collateral_removed", entity_type=ENTITY, entity_id=loan.id,
                       changes={"property_id": link.property_id}, ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- analysis inputs

async def _asset_for(db: AsyncSession, loan: Loan):
    from app.modules.assets.models import Asset

    if loan.asset_id:
        return await db.get(Asset, loan.asset_id)
    if loan.property_id:
        return await db.scalar(select(Asset).where(Asset.property_id == loan.property_id, Asset.deleted_at.is_(None)))
    return None


async def operating_inputs(db: AsyncSession, loan: Loan, *, verified_only: bool, as_of: date | None = None) -> dict:
    """NOI (TTM), trailing trend, value and occupancy for the loan's collateral asset."""
    from app.modules.assets import service as assets

    a = await _asset_for(db, loan)
    out: dict[str, Any] = {"asset_id": a.id if a else None, "noi": None, "noi_prior": None, "period_start": None,
                           "period_end": None, "months_present": 0, "debt_service_actual": None, "value": None,
                           "value_source": None, "occupancy": None, "occupancy_source": None, "leases": None,
                           "building_sf": 0.0, "verified_only": verified_only, "drill": []}
    if not a:
        return out
    since = add_months(month_start(as_of or date.today()), -30)
    monthly = (await assets.monthly_by_category(db, {a.id}, since, verified_only=verified_only)).get(a.id, {})
    if as_of:
        monthly = {p: v for p, v in monthly.items() if p <= as_of}
    noi, end, present = assets.ttm_noi(monthly)
    if end:
        out.update(noi=r2(noi), period_end=end, period_start=add_months(end, -11), months_present=present)
        prior_end = add_months(end, -3)
        prior, _, prior_present = assets.ttm_noi({p: v for p, v in monthly.items() if p <= prior_end}, prior_end)
        out["noi_prior"] = r2(prior) if prior_present >= 9 else None
        ds = assets.window_sum(monthly, end, {"debt_service"})
        out["debt_service_actual"] = r2(ds) if ds > 0 else None
    props = await assets.load_props(db, [a])
    p = props.get(a.property_id)
    v = await assets.latest_valuation(db, a.property_id)
    if v and v.get("value_point"):
        out["value"], out["value_source"] = float(v["value_point"]), f"valuation {v.get('as_of')}"
        out["drill"].append({"label": "Valuations", "href": f"/comps?property_id={a.property_id}"})
    elif a.current_value:
        out["value"], out["value_source"] = float(a.current_value), "asset record"
    leases = await assets.lease_data(db, {a.property_id})
    pl = leases.get(a.property_id) if leases is not None else None
    if p:
        occ, _, src = assets.occupancy_wale(p, pl)
        out.update(occupancy=r2(occ), occupancy_source=src, leases=pl, building_sf=float(p.building_area_sf or 0))
    out["drill"].insert(0, {"label": "Verified financials" if verified_only else "Financials",
                            "href": f"/assets/{a.id}?tab=financials"})
    return out


def _market(s: dict, overrides: dict | None) -> dict:
    m = dict(s["market"])
    for k, v in (overrides or {}).items():
        if v is not None and k in m:
            m[k] = float(v)
    return m


async def refinance(db: AsyncSession, loan: Loan, overrides: dict | None = None) -> dict:
    s = await get_settings(db)
    m = _market(s, overrides)
    inp = await operating_inputs(db, loan, verified_only=False)
    noi, value = inp["noi"], inp["value"]
    value_basis = inp["value_source"]
    if value is None and noi and m["cap_rate"]:
        value, value_basis = noi / (m["cap_rate"] / 100), f"NOI capitalised at {m['cap_rate']}%"
    sizing = calc.size_loan(noi, value, m["rate"], m["amort_years"], m["ltv"], m["dscr"], m["debt_yield"])
    opens, in_win, mtm = refi_window(loan, s)
    payoff_on = max(date.today(), opens) if opens and opens > date.today() else date.today()
    prepay = calc.prepayment_cost(loan, payoff_on, m["treasury_rate"])
    bal = float(loan.current_balance or 0)
    costs = (sizing["max_loan"] or 0) * m["refi_cost_pct"] / 100
    payoff = bal + (prepay["cost"] if prepay["allowed"] else 0)
    net = (sizing["max_loan"] or 0) - payoff - costs if sizing["max_loan"] is not None else None
    current_ds = calc.annual_debt_service(loan)
    return {
        "as_of": date.today(), "payoff_on": payoff_on, "market": m,
        "noi": noi, "noi_period_end": inp["period_end"], "value": r2(value), "value_basis": value_basis,
        "sizing": sizing, "current_balance": r2(bal), "prepayment": prepay, "refi_costs": r2(costs),
        "payoff": r2(payoff), "net_proceeds": r2(net) if net is not None and net >= 0 else (0.0 if net is not None else None),
        "shortfall": r2(-net) if net is not None and net < 0 else 0.0,
        "current_annual_debt_service": current_ds, "new_annual_debt_service": sizing.get("annual_debt_service"),
        "current_dscr": r2(safe_div(noi, current_ds), 3), "new_dscr": r2(safe_div(noi, sizing.get("annual_debt_service")), 3),
        "window": {"opens_on": opens, "in_window": in_win, "months_to_maturity": mtm,
                   "window_months": s["refi_window_months"]},
        "drill": inp["drill"] + [{"label": "Loan terms", "href": f"/loans/{loan.id}"}],
    }


async def hold_refi_sell(db: AsyncSession, loan: Loan, overrides: dict | None = None) -> dict:
    """Side-by-side at current market terms (pre-tax). Dispositions adds tax modelling on top."""
    refi = await refinance(db, loan, overrides)
    m = refi["market"]
    noi = refi["noi"] or 0
    bal = float(loan.current_balance or 0)
    ds = refi["current_annual_debt_service"] or 0
    value = refi["value"] or 0
    sale_costs = value * m["sale_cost_pct"] / 100
    sell_prepay = calc.prepayment_cost(loan, date.today(), m["treasury_rate"])
    sell_net = value - sale_costs - bal - (sell_prepay["cost"] if sell_prepay["allowed"] else 0)
    new_ds = refi["new_annual_debt_service"] or 0
    return {
        "market": m, "noi": refi["noi"], "value": refi["value"], "value_basis": refi["value_basis"],
        "hold": {"annual_cash_flow": r2(noi - ds), "debt_service": r2(ds), "dscr": refi["current_dscr"],
                 "equity": r2(value - bal), "maturity_on": loan.maturity_on,
                 "notes": "Keeps current debt; refinance or sale required by maturity."},
        "refinance": {"new_loan": refi["sizing"]["max_loan"], "binding_constraint": refi["sizing"]["binding"],
                      "cash_out": refi["net_proceeds"], "shortfall": refi["shortfall"],
                      "annual_cash_flow": r2(noi - new_ds) if refi["sizing"]["max_loan"] else None,
                      "debt_service": r2(new_ds), "dscr": refi["new_dscr"], "prepayment_cost": refi["prepayment"]["cost"],
                      "costs": refi["refi_costs"]},
        "sell": {"gross_price": r2(value), "sale_costs": r2(sale_costs), "debt_payoff": r2(bal),
                 "prepayment_cost": sell_prepay["cost"] if sell_prepay["allowed"] else None,
                 "prepayment_allowed": sell_prepay["allowed"], "net_equity": r2(sell_net)},
        "note": "Pre-tax comparison at current market terms. See the disposition module for after-tax modelling.",
    }


# --------------------------------------------------------------------------- covenants

def effective_watch(cov: Covenant, s: dict) -> float:
    if cov.watch_threshold is not None:
        return cov.watch_threshold
    buf = float(s["covenant_watch_buffer_pct"]) / 100
    return cov.threshold * (1 + buf) if cov.operator == "min" else cov.threshold * (1 - buf)


def classify(value: float | None, cov: Covenant, watch: float) -> str:
    if value is None:
        return "insufficient_data"
    if cov.operator == "min":
        return "breach" if value < cov.threshold else "watch" if value < watch else "pass"
    return "breach" if value > cov.threshold else "watch" if value > watch else "pass"


def _measure(kind: str, noi: float | None, ds: float | None, bal: float, value: float | None, occ: float | None) -> float | None:
    if kind == "dscr":
        return r2(safe_div(noi, ds), 3)
    if kind == "debt_yield":
        return pct(noi, bal)
    if kind == "ltv":
        return pct(bal, value)
    if kind == "occupancy":
        return occ
    return None


async def create_covenant(db: AsyncSession, loan: Loan, data: CovenantIn, actor: CurrentUser) -> Covenant:
    values = data.model_dump()
    values["operator"] = values["operator"] or DEFAULT_OPERATOR[data.kind]
    values["label"] = values["label"] or KIND_LABELS[data.kind]
    cov = Covenant(loan_id=loan.id, **values, created_by_id=actor.id, updated_by_id=actor.id)
    if cov.next_test_on is None:
        cov.next_test_on = date.today()
    db.add(cov)
    await db.flush()
    await audit.record(db, actor=actor, action="loan.covenant_created", entity_type=ENTITY, entity_id=loan.id,
                       summary=cov.label, changes=values, ip_address=actor.ip_address)
    await db.commit()
    return cov


async def update_covenant(db: AsyncSession, cov: Covenant, data: CovenantIn, actor: CurrentUser) -> Covenant:
    values = data.model_dump()
    values["operator"] = values["operator"] or DEFAULT_OPERATOR[data.kind]
    values["label"] = values["label"] or KIND_LABELS[data.kind]
    changes = audit.diff(cov, values)
    for k, v in values.items():
        setattr(cov, k, v)
    cov.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="loan.covenant_updated", entity_type=ENTITY, entity_id=cov.loan_id,
                       summary=cov.label, changes=changes, ip_address=actor.ip_address)
    loan = await get(db, cov.loan_id)
    await refresh_covenant_state(db, loan)
    await db.commit()
    return cov


async def refresh_covenant_state(db: AsyncSession, loan: Loan) -> str:
    covs = list(await db.scalars(select(Covenant).where(Covenant.loan_id == loan.id, Covenant.deleted_at.is_(None),
                                                        Covenant.is_active.is_(True))))
    states = []
    for c in covs:
        if c.last_state:
            states.append(c.last_state)
        if c.last_projected_state == "breach" and c.last_state != "breach":
            states.append("projected_breach")
    loan.covenant_state = max(states, key=lambda x: COVENANT_STATE_RANK.get(x, 0)) if states else "none"
    return loan.covenant_state


async def run_test(db: AsyncSession, cov: Covenant, actor: Any, *, test_date: date | None = None,
                   manual_value: float | None = None, notes: str | None = None, scheduled: bool = False) -> CovenantTest:
    """Computes the covenant from ACTUAL VERIFIED results and projects it forward. Does not commit."""
    from app.modules.tasks.service import create_task, raise_alert

    s = await get_settings(db)
    loan = await get(db, cov.loan_id)
    test_date = test_date or date.today()
    inp = await operating_inputs(db, loan, verified_only=True, as_of=test_date)
    bal = float(loan.current_balance or 0)
    ds = inp["debt_service_actual"] if inp["months_present"] >= 12 and inp["debt_service_actual"] else calc.annual_debt_service(loan, test_date)
    watch = effective_watch(cov, s)
    is_manual = manual_value is not None
    value = manual_value if is_manual else _measure(cov.kind, inp["noi"], ds, bal, inp["value"], inp["occupancy"])
    if not is_manual and inp["months_present"] < 12 and cov.kind in ("dscr", "debt_yield"):
        value = None  # an incomplete trailing year is not a valid test basis
    state = classify(value, cov, watch)

    # Projection: trailing quarterly NOI trend carried forward; occupancy rolls off expiring leases.
    q = int(s["projection_quarters"])
    projected_on = add_months(test_date, 3 * q)
    proj_value = None
    trend = None
    if not is_manual and inp["noi"] is not None and inp["noi_prior"] is not None:
        trend = inp["noi"] - inp["noi_prior"]
        proj_noi = inp["noi"] + trend * q
        proj_bal = calc.balance_after(loan, 3 * q, test_date)
        proj_ds = calc.annual_debt_service({**_loan_dict(loan), "current_balance": proj_bal}, projected_on)
        implied_cap = safe_div(inp["noi"], inp["value"])
        proj_val = proj_noi / implied_cap if implied_cap else inp["value"]
        proj_value = _measure(cov.kind, proj_noi, proj_ds, proj_bal, proj_val, None)
    if cov.kind == "occupancy" and not is_manual and inp["leases"] and inp["building_sf"]:
        remaining = sum(l["rentable_sf"] for l in inp["leases"] if not l["expiration_on"] or l["expiration_on"] > projected_on)
        proj_value = r2(min(100.0, remaining / inp["building_sf"] * 100))
    proj_state = classify(proj_value, cov, watch) if proj_value is not None else None

    test = CovenantTest(
        covenant_id=cov.id, loan_id=loan.id, test_date=test_date, period_start=inp["period_start"],
        period_end=inp["period_end"], measured_value=value, threshold=cov.threshold, state=state,
        projected_value=proj_value, projected_state=proj_state, projected_on=projected_on if proj_value is not None else None,
        inputs=audit.to_jsonable({"noi_ttm": inp["noi"], "noi_prior_quarter_ttm": inp["noi_prior"], "quarterly_trend": trend,
                                  "debt_service": ds, "balance": bal, "value": inp["value"], "value_source": inp["value_source"],
                                  "occupancy": inp["occupancy"], "occupancy_source": inp["occupancy_source"],
                                  "months_verified": inp["months_present"], "watch_threshold": watch,
                                  "manual_value": manual_value, "drill": inp["drill"]}),
        basis="manual" if is_manual else "actual_verified", is_manual=is_manual, notes=notes,
        created_by_id=getattr(actor, "id", None),
    )
    db.add(test)
    cov.last_state, cov.last_projected_state = state, proj_state
    if scheduled or cov.next_test_on is None or cov.next_test_on <= test_date:
        cov.next_test_on = add_months(test_date, FREQ_MONTHS.get(cov.frequency, 3))
    await db.flush()
    await refresh_covenant_state(db, loan)

    labels = await prop_labels(db, {loan.property_id})
    rel_label = f"{loan_label(loan)} · {labels.get(loan.property_id, '')}".strip(" ·")
    owner = loan.owner_id
    if owner is None:
        a = await _asset_for(db, loan)
        owner = a.manager_id if a else None
    shown = f"{value:.2f}" if value is not None else "n/a"
    if state == "breach":
        await raise_alert(db, title=f"Covenant breach: {cov.label}", severity="critical", owner_id=owner,
                          reason=f"{cov.label} measured {shown} vs {cov.operator} {cov.threshold} on verified actuals.",
                          related_type="loan", related_id=loan.id, related_label=rel_label, rule_key="debt.covenant_breach",
                          idempotency_key=f"covenant:{cov.id}:breach:{inp['period_end'] or test_date}")
    elif proj_state == "breach":
        # Projected breach escalates before any actual breach.
        await raise_alert(db, title=f"Projected covenant breach: {cov.label}", severity="high", owner_id=owner,
                          reason=f"{cov.label} is {shown} today and projected at {proj_value:.2f} by {projected_on.isoformat()} "
                                 f"(threshold {cov.operator} {cov.threshold}).",
                          related_type="loan", related_id=loan.id, related_label=rel_label,
                          rule_key="debt.covenant_projected_breach",
                          idempotency_key=f"covenant:{cov.id}:projected:{test_date:%Y-%m}")
        await create_task(db, title=f"Covenant cure plan: {cov.label} projected breach", assignee_id=owner,
                          due_at=utcnow() + timedelta(days=7), task_type="review", priority="high",
                          related_type="loan", related_id=loan.id, related_label=rel_label, source="debt.covenants",
                          idempotency_key=f"covenant:{cov.id}:cure:{test_date:%Y-%m}", actor_id=getattr(actor, "id", None))
    elif state == "watch":
        await raise_alert(db, title=f"Covenant on watch: {cov.label}", severity="medium", owner_id=owner,
                          reason=f"{cov.label} measured {shown}, within the watch band ({watch:.2f}) of {cov.threshold}.",
                          related_type="loan", related_id=loan.id, related_label=rel_label, rule_key="debt.covenant_watch",
                          idempotency_key=f"covenant:{cov.id}:watch:{inp['period_end'] or test_date}")
    await audit.record(db, actor=actor, action="loan.covenant_tested", entity_type=ENTITY, entity_id=loan.id,
                       summary=f"{cov.label}: {state}" + (f" (projected {proj_state})" if proj_state else ""),
                       changes={"value": value, "state": state, "projected_value": proj_value, "projected_state": proj_state})
    return test


def _loan_dict(l: Loan) -> dict:
    return {k: getattr(l, k) for k in ("current_balance", "rate", "amortization_months", "io_months", "originated_on",
                                       "maturity_on", "prepayment")}


async def covenant_items(db: AsyncSession, covs: list[Covenant]) -> list[dict]:
    s = await get_settings(db)
    loans = {l.id: l for l in await db.scalars(select(Loan).where(Loan.id.in_({c.loan_id for c in covs})))} if covs else {}
    labels = await prop_labels(db, {l.property_id for l in loans.values()})
    latest: dict[uuid.UUID, CovenantTest] = {}
    if covs:
        for t in await db.scalars(select(CovenantTest).where(CovenantTest.covenant_id.in_([c.id for c in covs]),
                                                             CovenantTest.deleted_at.is_(None))
                                  .order_by(CovenantTest.test_date.desc(), CovenantTest.created_at.desc())):
            latest.setdefault(t.covenant_id, t)
    out = []
    for c in covs:
        l, t = loans.get(c.loan_id), latest.get(c.id)
        out.append({
            **{k: getattr(c, k) for k in ("id", "loan_id", "kind", "label", "operator", "threshold", "watch_threshold",
                                          "frequency", "next_test_on", "cure_period_days", "is_active", "last_state",
                                          "last_projected_state", "notes")},
            "loan_label": loan_label(l) if l else None, "property_id": l.property_id if l else None,
            "property_label": labels.get(l.property_id) if l else None, "effective_watch": r2(effective_watch(c, s), 3),
            "last_value": t.measured_value if t else None, "last_projected_value": t.projected_value if t else None,
            "last_tested_on": t.test_date if t else None,
        })
    return out


# --------------------------------------------------------------------------- reserves

async def create_reserve(db: AsyncSession, loan: Loan, data: ReserveIn, actor: CurrentUser) -> LoanReserve:
    r = LoanReserve(loan_id=loan.id, **data.model_dump(), balance=0, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(r)
    await db.flush()
    await audit.record(db, actor=actor, action="loan.reserve_created", entity_type=ENTITY, entity_id=loan.id,
                       summary=r.label or r.reserve_type, changes=data.model_dump(), ip_address=actor.ip_address)
    await db.commit()
    return r


async def update_reserve(db: AsyncSession, r: LoanReserve, data: ReserveIn, actor: CurrentUser) -> LoanReserve:
    values = data.model_dump()
    changes = audit.diff(r, values)
    for k, v in values.items():
        setattr(r, k, v)
    r.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="loan.reserve_updated", entity_type=ENTITY, entity_id=r.loan_id,
                       summary=r.label or r.reserve_type, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return r


async def post_reserve_txn(db: AsyncSession, r: LoanReserve, data: ReserveTxnIn, actor: CurrentUser) -> ReserveTransaction:
    amt = float(data.amount)
    if data.kind in ("deposit", "release") and amt <= 0:
        raise HTTPException(422, "Deposits and releases must be positive amounts")
    delta = amt if data.kind == "deposit" else -amt if data.kind == "release" else amt
    new_bal = float(r.balance or 0) + delta
    if new_bal < -0.005:
        raise HTTPException(409, "A release cannot exceed the reserve balance")
    txn = ReserveTransaction(reserve_id=r.id, loan_id=r.loan_id, kind=data.kind, amount=amt, occurred_on=data.occurred_on,
                             balance_after=round(new_bal, 2), document_id=data.document_id, memo=data.memo,
                             created_by_id=actor.id, updated_by_id=actor.id)
    db.add(txn)
    old = r.balance
    r.balance, r.updated_by_id = round(new_bal, 2), actor.id
    await db.flush()
    if data.document_id:
        try:
            from app.modules.documents.service import link

            await link(db, data.document_id, "reserve_transaction", txn.id, actor)
            await link(db, data.document_id, "loan", r.loan_id, actor)
        except ImportError:
            pass
    await audit.record(db, actor=actor, action=f"loan.reserve_{data.kind}", entity_type=ENTITY, entity_id=r.loan_id,
                       summary=f"{r.label or r.reserve_type}: {data.kind} {amt:,.2f}",
                       changes={"balance": {"from": old, "to": r.balance}, "document_id": data.document_id},
                       ip_address=actor.ip_address)
    await db.commit()
    return txn


# --------------------------------------------------------------------------- lender reporting obligations

def _period_end_after(d: date, step: int) -> date:
    """Last day of the calendar-aligned period (1/3/6/12 months) that follows the period ending on/before d."""
    return add_days(add_months(add_days(d, 1), step), -1)


def next_report_due(frequency: str, days_after: int, on_or_after: date) -> date:
    step = FREQ_MONTHS.get(frequency, 3)
    start_month = ((on_or_after.month - 1) // step) * step + 1
    prev_end = add_days(date(on_or_after.year, start_month, 1), -1)
    due = add_days(prev_end, days_after)
    while due < on_or_after:
        prev_end = _period_end_after(prev_end, step)
        due = add_days(prev_end, days_after)
    return due


async def _schedule_obligation(db: AsyncSession, loan: Loan, o: LenderReportingObligation, actor: Any) -> None:
    """Upsert the recurring critical date + owned task for the obligation's next due date. Does not commit."""
    from app.modules.tasks.service import create_task

    if not o.is_active or not o.next_due_on:
        return
    label = f"{o.label or o.report_type.replace('_', ' ').capitalize()} due to {loan.lender_name or 'lender'}"
    key = f"lender_report:{o.id}:{o.next_due_on.isoformat()}"
    try:
        from app.modules.contracts.service import upsert_critical_date

        cd = await upsert_critical_date(db, related_type="loan", related_id=loan.id, date_type="lender_reporting",
                                        label=label, due_on=o.next_due_on, property_id=loan.property_id,
                                        owner_id=o.owner_id, lead_days=14, is_blocking=False, source="rule",
                                        status="confirmed", key=key, actor=actor, related_label=loan_label(loan))
        o.critical_date_id = cd.id
    except ImportError:
        pass
    task = await create_task(db, title=label, assignee_id=o.owner_id or loan.owner_id, due_at=_due_dt(o.next_due_on),
                             task_type="general", priority="normal", related_type="loan", related_id=loan.id,
                             related_label=loan_label(loan), source="debt.lender_reporting",
                             idempotency_key=key[:200], actor_id=getattr(actor, "id", None))
    o.task_id = task.id


async def create_obligation(db: AsyncSession, loan: Loan, data: ObligationIn, actor: CurrentUser) -> LenderReportingObligation:
    o = LenderReportingObligation(loan_id=loan.id, **data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    if o.next_due_on is None:
        o.next_due_on = next_report_due(o.frequency, o.days_after_period, date.today())
    db.add(o)
    await db.flush()
    await _schedule_obligation(db, loan, o, actor)
    await audit.record(db, actor=actor, action="loan.obligation_created", entity_type=ENTITY, entity_id=loan.id,
                       summary=o.label or o.report_type, changes=data.model_dump(), ip_address=actor.ip_address)
    await db.commit()
    return o


async def update_obligation(db: AsyncSession, o: LenderReportingObligation, data: ObligationIn, actor: CurrentUser):
    values = data.model_dump()
    if values["next_due_on"] is None:
        values["next_due_on"] = o.next_due_on
    changes = audit.diff(o, values)
    for k, v in values.items():
        setattr(o, k, v)
    o.updated_by_id = actor.id
    if {"next_due_on", "owner_id", "is_active", "label"} & changes.keys():
        await _schedule_obligation(db, await get(db, o.loan_id), o, actor)
    await audit.record(db, actor=actor, action="loan.obligation_updated", entity_type=ENTITY, entity_id=o.loan_id,
                       summary=o.label or o.report_type, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return o


async def submit_obligation(db: AsyncSession, o: LenderReportingObligation, submitted_on: date | None,
                            document_id: uuid.UUID | None, note: str | None, actor: CurrentUser):
    from app.modules.tasks.models import Task

    loan = await get(db, o.loan_id)
    submitted_on = submitted_on or date.today()
    if o.critical_date_id:
        try:
            from app.modules.contracts import service as contracts
            from app.modules.contracts.models import CriticalDate

            cd = await db.get(CriticalDate, o.critical_date_id)
            if cd is not None and cd.status in ("confirmed", "missed"):
                # completes with an event + audit entry; does not commit
                await contracts._complete(db, cd, f"Lender report submitted {submitted_on.isoformat()}", actor)
        except (ImportError, AttributeError):
            pass
    if o.task_id:
        task = await db.get(Task, o.task_id)
        if task and task.status not in ("done", "cancelled"):
            task.status, task.completed_at, task.completed_by_id = "done", utcnow(), actor.id
    if document_id:
        try:
            from app.modules.documents.service import link

            await link(db, document_id, "loan", loan.id, actor)
        except ImportError:
            pass
    previous_due = o.next_due_on
    o.last_submitted_on = submitted_on
    if previous_due:
        period_end = add_days(previous_due, -o.days_after_period)
        o.next_due_on = add_days(_period_end_after(period_end, FREQ_MONTHS.get(o.frequency, 3)), o.days_after_period)
    else:
        o.next_due_on = next_report_due(o.frequency, o.days_after_period, submitted_on)
    o.updated_by_id = actor.id
    o.critical_date_id = None
    o.task_id = None
    await db.flush()
    await _schedule_obligation(db, loan, o, actor)
    await audit.record(db, actor=actor, action="loan.obligation_submitted", entity_type=ENTITY, entity_id=loan.id,
                       summary=f"{o.label or o.report_type} for due {previous_due}",
                       changes={"submitted_on": submitted_on, "next_due_on": o.next_due_on, "document_id": document_id,
                                "note": note}, ip_address=actor.ip_address)
    await db.commit()
    return o


async def obligation_items(db: AsyncSession, rows: list[LenderReportingObligation]) -> list[dict]:
    names = await user_names(db, {r.owner_id for r in rows})
    today = date.today()
    return [{
        **{k: getattr(r, k) for k in ("id", "loan_id", "report_type", "label", "frequency", "days_after_period",
                                      "next_due_on", "owner_id", "is_active", "notes", "last_submitted_on",
                                      "critical_date_id", "task_id", "updated_at")},
        "owner_name": names.get(r.owner_id), "overdue": bool(r.is_active and r.next_due_on and r.next_due_on < today),
    } for r in rows]


# --------------------------------------------------------------------------- portfolio views

async def ladder(db: AsyncSession, bucket: str, f: LoanFilters) -> dict:
    if not f.status:
        f.status = ["active"]
    loans = list(await db.scalars(build_query(f)))
    labels = await prop_labels(db, {l.property_id for l in loans})
    buckets: dict[str, dict] = {}
    undated = []
    for l in loans:
        if not l.maturity_on:
            undated.append(l)
            continue
        d = l.maturity_on
        key = (str(d.year) if bucket == "year" else f"{d.year}-Q{(d.month - 1) // 3 + 1}" if bucket == "quarter"
               else f"{d.year}-{d.month:02d}")
        b = buckets.setdefault(key, {"key": key, "balance": 0.0, "fixed_balance": 0.0, "floating_balance": 0.0,
                                     "count": 0, "loans": []})
        bal = float(l.current_balance or 0)
        b["balance"] += bal
        b["floating_balance" if l.rate_type == "floating" else "fixed_balance"] += bal
        b["count"] += 1
        b["loans"].append({"id": l.id, "label": loan_label(l), "property_label": labels.get(l.property_id),
                           "balance": bal, "maturity_on": d, "rate": l.rate, "href": f"/loans/{l.id}"})
    total = sum(b["balance"] for b in buckets.values())
    rows = []
    for k in sorted(buckets):
        b = buckets[k]
        rows.append({**b, "balance": r2(b["balance"]), "fixed_balance": r2(b["fixed_balance"]),
                     "floating_balance": r2(b["floating_balance"]), "share_pct": pct(b["balance"], total),
                     "drill": f"/loans?maturity_from={min(x['maturity_on'] for x in b['loans'])}&maturity_to={max(x['maturity_on'] for x in b['loans'])}"})
    return {"bucket": bucket, "total": r2(total), "buckets": rows,
            "undated": [{"id": l.id, "label": loan_label(l), "balance": l.current_balance} for l in undated]}


async def exposure(db: AsyncSession) -> dict:
    s = await get_settings(db)
    loans = list(await db.scalars(select(Loan).where(Loan.deleted_at.is_(None), Loan.status == "active")))
    today = date.today()
    total = sum(float(l.current_balance or 0) for l in loans)
    floating = [l for l in loans if l.rate_type == "floating"]
    hedged = [l for l in floating if (l.cap_expires_on and l.cap_expires_on >= today) or (l.swap_expires_on and l.swap_expires_on >= today)]
    unhedged_bal = sum(float(l.current_balance or 0) for l in floating if l not in hedged)
    lead = max(s["cap_lead_days"]) if s["cap_lead_days"] else 90
    expiring = [l for l in floating if l.cap_expires_on and today <= l.cap_expires_on <= add_days(today, lead)]
    w_rate = safe_div(sum(float(l.current_balance or 0) * (l.rate or 0) for l in loans), total)
    labels = await prop_labels(db, {l.property_id for l in expiring})
    return {
        "total_balance": r2(total), "floating_balance": r2(sum(float(l.current_balance or 0) for l in floating)),
        "floating_pct": pct(sum(float(l.current_balance or 0) for l in floating), total),
        "hedged_floating_balance": r2(sum(float(l.current_balance or 0) for l in hedged)),
        "unhedged_floating_balance": r2(unhedged_bal), "weighted_rate": r2(w_rate, 3),
        "annual_cost_per_100bp_unhedged": r2(unhedged_bal * 0.01),
        "caps_expiring": [{"id": l.id, "label": loan_label(l), "property_label": labels.get(l.property_id),
                           "cap_expires_on": l.cap_expires_on, "cap_strike": l.cap_strike,
                           "balance": l.current_balance, "href": f"/loans/{l.id}"} for l in expiring],
        "drill": "/loans?rate_type=floating",
    }


# --------------------------------------------------------------------------- automation scan

async def scan(db: AsyncSession, actor: Any) -> dict:
    """Maturity windows, refi windows, cap expirations, due covenant tests and overdue lender reports. Does not commit."""
    from app.modules.tasks.models import Alert
    from app.modules.tasks.service import create_task, raise_alert

    s = await get_settings(db)
    today = date.today()
    loans = list(await db.scalars(select(Loan).where(Loan.deleted_at.is_(None), Loan.status == "active")))
    labels = await prop_labels(db, {l.property_id for l in loans})
    counts = defaultdict(int)
    for l in loans:
        label = f"{loan_label(l)} · {labels.get(l.property_id, '')}".strip(" ·")
        a = await _asset_for(db, l)
        owner = l.owner_id or (a.manager_id if a else None)
        if l.maturity_on:
            mtm = months_between(today, l.maturity_on)
            for lead in sorted(s["maturity_lead_months"]):
                if mtm <= lead:
                    key = f"loan:{l.id}:maturity:{lead}:{l.maturity_on.isoformat()}"
                    if not await db.scalar(select(Alert.id).where(Alert.idempotency_key == key)):
                        await raise_alert(db, title=f"Loan matures in {max(mtm, 0)} months: {loan_label(l)}",
                                          reason=f"Maturity {l.maturity_on.isoformat()} is within the {lead}-month lead time. "
                                                 f"Balance {float(l.current_balance or 0):,.0f}.",
                                          severity="critical" if mtm <= 3 else "high" if mtm <= 6 else "medium",
                                          owner_id=owner, related_type="loan", related_id=l.id, related_label=label,
                                          rule_key="debt.maturity_window", idempotency_key=key, due_at=_due_dt(l.maturity_on))
                        await events.emit(db, "loan.maturity_window", loan_id=l.id, property_id=l.property_id,
                                          months_to_maturity=mtm, actor=actor)
                        counts["maturity_alerts"] += 1
                    break
            opens, in_win, _ = refi_window(l, s)
            if in_win:
                key = f"loan:{l.id}:refi_window:{l.maturity_on.isoformat()}"
                await create_task(db, title=f"Refinance analysis: {loan_label(l)}", assignee_id=owner,
                                  due_at=_due_dt(add_days(today, 14)), task_type="review", priority="high",
                                  description=f"Refinance window opened {opens.isoformat()} ahead of maturity {l.maturity_on.isoformat()}.",
                                  related_type="loan", related_id=l.id, related_label=label, source="debt.refi_window",
                                  idempotency_key=key, actor_id=getattr(actor, "id", None))
                counts["refi_windows"] += 1
        if l.rate_type == "floating" and l.cap_expires_on:
            days = (l.cap_expires_on - today).days
            for lead in sorted(s["cap_lead_days"]):
                if 0 <= days <= lead:
                    await raise_alert(db, title=f"Rate cap expires in {days} days: {loan_label(l)}",
                                      reason=f"Interest rate cap ({l.cap_strike or '—'}% strike) expires {l.cap_expires_on.isoformat()}; "
                                             "floating exposure becomes unhedged.",
                                      severity="high" if days <= 30 else "medium", owner_id=owner, related_type="loan",
                                      related_id=l.id, related_label=label, rule_key="debt.cap_expiration",
                                      idempotency_key=f"loan:{l.id}:cap:{lead}:{l.cap_expires_on.isoformat()}")
                    counts["cap_alerts"] += 1
                    break
    due_covs = list(await db.scalars(select(Covenant).join(Loan, Loan.id == Covenant.loan_id).where(
        Covenant.deleted_at.is_(None), Covenant.is_active.is_(True), Loan.status == "active", Loan.deleted_at.is_(None),
        (Covenant.next_test_on.is_(None)) | (Covenant.next_test_on <= today))))
    for c in due_covs:
        if c.kind == "net_worth":
            continue  # requires guarantor statements entered manually
        await run_test(db, c, actor, scheduled=True)
        counts["covenant_tests"] += 1
    overdue = list(await db.scalars(select(LenderReportingObligation).where(
        LenderReportingObligation.deleted_at.is_(None), LenderReportingObligation.is_active.is_(True),
        LenderReportingObligation.next_due_on < today)))
    loan_map = {l.id: l for l in loans}
    for o in overdue:
        l = loan_map.get(o.loan_id)
        if not l:
            continue
        await raise_alert(db, title=f"Lender report overdue: {o.label or o.report_type}",
                          reason=f"Due {o.next_due_on.isoformat()} to {l.lender_name or 'lender'}.", severity="high",
                          owner_id=o.owner_id or l.owner_id, related_type="loan", related_id=l.id,
                          related_label=loan_label(l), rule_key="debt.lender_report_overdue",
                          idempotency_key=f"lender_report_overdue:{o.id}:{o.next_due_on.isoformat()}")
        counts["overdue_reports"] += 1
    await audit.record(db, actor=actor, action="loan.scan", entity_type=ENTITY, summary=f"{len(loans)} active loans",
                       changes=dict(counts))
    return {"loans": len(loans), **counts}
