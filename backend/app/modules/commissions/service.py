import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import Select, extract, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.database import Base
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.commissions.models import (
    CLOSED_STAGES,
    EARNED_STATUSES,
    LOST_STAGES,
    OPEN_STATUSES,
    AgentPlan,
    Commission,
    CommissionEvent,
    CommissionInvoice,
    CommissionPayment,
    CommissionSplit,
    ForecastSnapshot,
    SplitPlan,
)
from app.modules.commissions.schemas import (
    AgentPlanOut,
    CommissionCreate,
    CommissionListItem,
    CommissionOut,
    CommissionUpdate,
    EarnIn,
    InvoiceCreate,
    InvoiceOut,
    PaymentCreate,
    PaymentOut,
    PlanIn,
    ReleaseIn,
    SplitOut,
    SyncOut,
)

PAYMENT_LAG_DAYS = 30  # default expected payment date = expected close + lag
LOCKED = {"invoiced", "paid", "cancelled"}


def r2(x) -> float:
    return round(float(x or 0) + 0.0, 2) + 0.0


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    return date(d.year + y, m + 1, 1)


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


# =========================================================================== visibility

def restricted(user: CurrentUser | None) -> bool:
    """Agents without commissions:view_sensitive only see commissions they hold a split on — and only their split."""
    return user is not None and not user.can("commissions", "view_sensitive")


def visible(stmt: Select, user: CurrentUser | None) -> Select:
    if not restricted(user):
        return stmt
    mine = select(CommissionSplit.commission_id).where(
        CommissionSplit.agent_id == user.id, CommissionSplit.deleted_at.is_(None))
    return stmt.where(or_(Commission.agent_id == user.id, Commission.id.in_(mine)))


async def get(db: AsyncSession, commission_id: uuid.UUID, user: CurrentUser | None) -> Commission:
    stmt = visible(select(Commission).where(Commission.id == commission_id, Commission.deleted_at.is_(None)), user)
    c = await db.scalar(stmt)
    if not c:
        raise HTTPException(404, "Commission not found")
    return c


# =========================================================================== cross-module (guarded)

def _deals():
    return Base.metadata.tables.get("brokerage_deals")


def norm_prob(p) -> float | None:
    """brokerage_deals.probability may be a fraction (0–1) or a percent; returns percent."""
    if p is None:
        return None
    p = float(p)
    return p * 100.0 if p <= 1 else min(p, 100.0)


async def deal_rows(db: AsyncSession, ids: set | None = None) -> list[dict]:
    t = _deals()
    if t is None:
        return []
    stmt = select(t)
    if ids is not None:
        if not ids:
            return []
        stmt = stmt.where(t.c.id.in_(ids))
    if "deleted_at" in t.c:
        stmt = stmt.where(t.c.deleted_at.is_(None))
    return [dict(r) for r in (await db.execute(stmt)).mappings().all()]


async def deal_labels(db: AsyncSession, deals: list[dict]) -> dict[uuid.UUID, str]:
    from app.modules.properties.models import Property

    pids = {d.get("property_id") for d in deals if d.get("property_id")}
    names = {}
    if pids:
        rows = await db.execute(select(Property.id, Property.name, Property.address_line).where(Property.id.in_(pids)))
        names = {r[0]: r[1] or r[2] for r in rows.all()}
    out = {}
    for d in deals:
        out[d["id"]] = (d.get("name") or d.get("title") or names.get(d.get("property_id"))
                        or f"Deal {str(d['id'])[:8]}")
    return out


async def compliance_check(db: AsyncSession, deal_id: uuid.UUID | None) -> tuple[bool, list[str]]:
    """Release gate: dealroom.service.transaction_file_complete must be true."""
    try:
        from app.modules.dealroom.service import transaction_file_complete
    except ImportError:
        return False, ["compliance module unavailable"]
    if not deal_id:
        return False, ["no brokerage transaction is linked, so the transaction file cannot be verified"]
    ok, reasons = await transaction_file_complete(db, deal_id)
    return bool(ok), list(reasons or [])


async def user_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    from app.modules.tasks.service import user_names as _names

    return await _names(db, ids)


async def _user_team(db: AsyncSession, user_id: uuid.UUID | None) -> uuid.UUID | None:
    if not user_id:
        return None
    from app.modules.auth.models import User

    u = await db.get(User, user_id)
    return u.team_id if u else None


# =========================================================================== split math (pure)

def _pro_rata(total: float, weights: dict[str, float]) -> dict[str, float]:
    total = r2(total)
    s = sum(max(0.0, w) for w in weights.values())
    if not weights:
        return {}
    if s <= 0:
        weights, s = {k: 1.0 for k in weights}, float(len(weights))
    out = {k: r2(total * max(0.0, w) / s) for k, w in weights.items()}
    drift = r2(total - sum(out.values()))
    if drift:
        top = max(weights, key=lambda k: weights[k])
        out[top] = r2(out[top] + drift)
    return out


def graduated_agent_amount(gci: float, ytd_before: float, tiers: list[dict]) -> tuple[float, list[dict]]:
    """Agent share of `gci` under a graduated plan keyed on YTD GCI.

    Bands: tier k covers YTD GCI in [min_k, min_{k+1}) (the first band starts at 0). The deal's GCI
    occupies [ytd_before, ytd_before + gci); each slice earns that band's agent_pct:
        agent = Σ_k overlap_k · agent_pct_k / 100
    """
    if not tiers:
        return r2(gci), [{"from": ytd_before, "to": ytd_before + gci, "gci": r2(gci), "agent_pct": 100.0,
                          "amount": r2(gci)}]
    bands = sorted(tiers, key=lambda t: float(t.get("min_ytd_gci") or 0))
    lo, hi = ytd_before, ytd_before + gci
    total, detail = 0.0, []
    for i, t in enumerate(bands):
        b_lo = 0.0 if i == 0 else float(t.get("min_ytd_gci") or 0)
        b_hi = float(bands[i + 1].get("min_ytd_gci") or 0) if i + 1 < len(bands) else float("inf")
        overlap = max(0.0, min(hi, b_hi) - max(lo, b_lo))
        if overlap > 0:
            pct = float(t.get("agent_pct") or 0)
            amt = overlap * pct / 100.0
            total += amt
            detail.append({"from": max(lo, b_lo), "to": min(hi, b_hi), "gci": r2(overlap), "agent_pct": pct,
                           "amount": r2(amt)})
    return r2(total), detail


def calculate(gross: float, referral_pct: float | None, referral_amount: float | None, participants: list[dict],
              deductions: list[dict], primary_agent_id: str | None) -> dict:
    """Commission split calculation.

    referral = referral_amount if given, else gross · referral_pct / 100      (paid off the top)
    net      = gross − referral
    gci_i    = net · share_i / Σ share                                           (cent drift → largest share)
    agent_i  = gci_i · override_i / 100 when a per-deal override is set, else the graduated plan amount
    cap      : house_i = gci_i − agent_i is limited to max(0, annual_cap − house_ytd_i); the excess goes to the agent
    net_i    = agent_i − Σ deductions charged to agent i
    house    = Σ (gci_i − agent_i)
    Each participant dict: {agent_id, share_pct, override_agent_pct, plan: {name, tiers, annual_cap} | None,
    ytd_gci, ytd_house}.
    """
    gross = r2(gross)
    referral = r2(referral_amount if referral_amount is not None else gross * float(referral_pct or 0) / 100.0)
    referral = min(referral, gross)
    net = r2(gross - referral)
    shares = {str(p["agent_id"]): float(p.get("share_pct") or 0) for p in participants}
    share_total = sum(shares.values()) or 1.0
    gci = _pro_rata(net, shares)
    ded_by_agent: dict[str, float] = defaultdict(float)
    for d in deductions:
        key = str(d.get("agent_id") or primary_agent_id or (participants[0]["agent_id"] if participants else ""))
        ded_by_agent[key] += float(d.get("amount") or 0)
    lines, house = [], 0.0
    for p in participants:
        key = str(p["agent_id"])
        g = gci.get(key, 0.0)
        plan = p.get("plan") or {}
        if p.get("override_agent_pct") is not None:
            agent_amt = r2(g * float(p["override_agent_pct"]) / 100.0)
            detail = [{"override": True, "agent_pct": float(p["override_agent_pct"]), "gci": g, "amount": agent_amt}]
        else:
            agent_amt, detail = graduated_agent_amount(g, float(p.get("ytd_gci") or 0), plan.get("tiers") or [])
        house_i = r2(g - agent_amt)
        capped = False
        cap = plan.get("annual_cap")
        if cap is not None and p.get("override_agent_pct") is None:
            allowed = max(0.0, float(cap) - float(p.get("ytd_house") or 0))
            if house_i > allowed:
                agent_amt = r2(agent_amt + house_i - allowed)
                house_i = r2(allowed)
                capped = True
        ded = r2(ded_by_agent.get(key, 0.0))
        house += house_i
        lines.append({
            "agent_id": key, "role": "primary" if key == str(primary_agent_id) else "co_agent",
            "share_pct": round(100.0 * shares[key] / share_total, 4), "gci_amount": g,
            "agent_pct": round(100.0 * agent_amt / g, 4) if g else None, "amount": agent_amt, "deductions": ded,
            "net_amount": r2(agent_amt - ded), "ytd_gci_before": r2(p.get("ytd_gci") or 0), "capped": capped,
            "plan": plan.get("name"), "bands": detail, "house_amount": house_i,
        })
    # Σ gci_i = net, so this equals Σ (gci_i − agent_i); with no agent participants the whole net is house.
    house = r2(net - sum(line["amount"] for line in lines))
    return {
        "gross": gross, "referral": referral, "net_gci": net, "house": house,
        "agent_total": r2(sum(line["amount"] for line in lines)),
        "agent_net_total": r2(sum(line["net_amount"] for line in lines)),
        "deductions_total": r2(sum(line["deductions"] for line in lines)),
        "lines": lines, "computed_at": utcnow().isoformat(),
    }


# =========================================================================== plans & YTD

async def plan_for(db: AsyncSession, agent_id: uuid.UUID, explicit_plan_id: uuid.UUID | None) -> SplitPlan | None:
    if explicit_plan_id:
        plan = await db.get(SplitPlan, explicit_plan_id)
        if plan and not plan.deleted_at:
            return plan
    ap = await db.scalar(select(AgentPlan).where(AgentPlan.agent_id == agent_id, AgentPlan.deleted_at.is_(None)))
    if ap:
        plan = await db.get(SplitPlan, ap.plan_id)
        if plan and not plan.deleted_at:
            return plan
    return await db.scalar(select(SplitPlan).where(
        SplitPlan.is_default.is_(True), SplitPlan.is_active.is_(True), SplitPlan.deleted_at.is_(None)).limit(1))


async def ytd(db: AsyncSession, agent_id: uuid.UUID, year: int, exclude_id: uuid.UUID | None = None) -> tuple[float, float]:
    """(YTD GCI, YTD house share) of an agent from earned commissions in calendar `year`."""
    stmt = (
        select(func.coalesce(func.sum(CommissionSplit.gci_amount), 0),
               func.coalesce(func.sum(CommissionSplit.gci_amount - CommissionSplit.amount), 0))
        .join(Commission, Commission.id == CommissionSplit.commission_id)
        .where(CommissionSplit.agent_id == agent_id, CommissionSplit.deleted_at.is_(None),
               CommissionSplit.role.in_(["primary", "co_agent"]), Commission.deleted_at.is_(None),
               Commission.status.in_(EARNED_STATUSES), extract("year", Commission.earned_on) == year)
    )
    if exclude_id:
        stmt = stmt.where(Commission.id != exclude_id)
    row = (await db.execute(stmt)).one()
    return float(row[0] or 0), float(row[1] or 0)


async def _event(db: AsyncSession, c: Commission, action: str, actor, *, from_status=None, to_status=None,
                 note: str | None = None, snapshot: dict | None = None) -> None:
    db.add(CommissionEvent(commission_id=c.id, action=action, from_status=from_status, to_status=to_status,
                           actor_id=getattr(actor, "id", None), actor_name=getattr(actor, "full_name", None),
                           note=note, snapshot=audit.to_jsonable(snapshot or {})))


async def recalc(db: AsyncSession, c: Commission, actor) -> None:
    """Rebuild split lines. Previous lines are soft-deleted and the prior calc is kept in commission_events."""
    if c.status in LOCKED:
        raise HTTPException(409, f"A {c.status} commission is locked; its splits cannot be recalculated")
    participants = list(c.participants or [])
    if not participants and c.agent_id:
        participants = [{"agent_id": str(c.agent_id), "share_pct": 100, "override_agent_pct": None}]
    year = (c.earned_on or c.expected_close_on or date.today()).year
    enriched = []
    for p in participants:
        aid = uuid.UUID(str(p["agent_id"]))
        plan = await plan_for(db, aid, c.split_plan_id)
        g, h = await ytd(db, aid, year, c.id)
        enriched.append({**p, "agent_id": str(aid), "ytd_gci": g, "ytd_house": h,
                         "plan": {"id": str(plan.id), "name": plan.name, "tiers": plan.tiers or [],
                                  "annual_cap": plan.annual_cap} if plan else None})
    calc = calculate(float(c.gross or 0), c.referral_pct, c.referral_amount, enriched, list(c.deductions or []),
                     str(c.agent_id) if c.agent_id else None)
    if c.calc:
        await _event(db, c, "recalculated", actor, note="Split calculation rebuilt", snapshot={"previous": c.calc})
    for s in await db.scalars(select(CommissionSplit).where(CommissionSplit.commission_id == c.id,
                                                            CommissionSplit.deleted_at.is_(None))):
        s.deleted_at = utcnow()
    for line in calc["lines"]:
        db.add(CommissionSplit(
            commission_id=c.id, agent_id=uuid.UUID(line["agent_id"]), role=line["role"], share_pct=line["share_pct"],
            gci_amount=line["gci_amount"], agent_pct=line["agent_pct"], amount=line["amount"],
            deductions=line["deductions"], net_amount=line["net_amount"], ytd_gci_before=line["ytd_gci_before"],
            capped=line["capped"], detail={"plan": line["plan"], "bands": line["bands"]},
            created_by_id=getattr(actor, "id", None),
        ))
    if calc["referral"]:
        db.add(CommissionSplit(commission_id=c.id, role="referral", label=c.referral_party or "Referral",
                               gci_amount=0, amount=calc["referral"], net_amount=calc["referral"],
                               created_by_id=getattr(actor, "id", None)))
    db.add(CommissionSplit(commission_id=c.id, role="house", label="House share", gci_amount=0,
                           amount=calc["house"], net_amount=calc["house"], created_by_id=getattr(actor, "id", None)))
    c.calc = calc
    c.house_amount = calc["house"]
    c.agent_net_total = calc["agent_net_total"]


# =========================================================================== queries

@dataclass
class CommissionFilters:
    q: str | None = None
    status: list[str] | None = None
    side: list[str] | None = None
    property_type: list[str] | None = None
    reconciliation_status: list[str] | None = None
    source: list[str] | None = None
    agent_id: list[uuid.UUID] | None = None
    brokerage_deal_id: uuid.UUID | None = None
    min_gross: float | None = None
    max_gross: float | None = None
    expected_from: date | None = None
    expected_to: date | None = None


def build_query(f: CommissionFilters, user: CurrentUser | None, *, skip: set[str] = frozenset()) -> Select:
    stmt = visible(select(Commission).where(Commission.deleted_at.is_(None)), user)
    stmt = apply_search(stmt, f.q, [Commission.title, Commission.source, Commission.referral_party])
    for key, col in (("status", Commission.status), ("side", Commission.side),
                     ("property_type", Commission.property_type),
                     ("reconciliation_status", Commission.reconciliation_status), ("source", Commission.source)):
        if key not in skip:
            stmt = in_filter(stmt, col, getattr(f, key))
    if f.agent_id:
        stmt = stmt.where(or_(Commission.agent_id.in_(f.agent_id), Commission.id.in_(
            select(CommissionSplit.commission_id).where(CommissionSplit.agent_id.in_(f.agent_id),
                                                        CommissionSplit.deleted_at.is_(None)))))
    if f.brokerage_deal_id:
        stmt = stmt.where(Commission.brokerage_deal_id == f.brokerage_deal_id)
    stmt = range_filter(stmt, Commission.gross, f.min_gross, f.max_gross)
    stmt = range_filter(stmt, Commission.expected_on, f.expected_from, f.expected_to)
    return stmt


async def _splits(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[CommissionSplit]]:
    out: dict[uuid.UUID, list[CommissionSplit]] = defaultdict(list)
    if ids:
        for s in await db.scalars(select(CommissionSplit).where(CommissionSplit.commission_id.in_(ids),
                                                                CommissionSplit.deleted_at.is_(None))):
            out[s.commission_id].append(s)
    return out


async def to_items(db: AsyncSession, rows: list[Commission], user: CurrentUser | None) -> list[CommissionListItem]:
    names = await user_names(db, [c.agent_id for c in rows])
    mine = restricted(user)
    splits = await _splits(db, [c.id for c in rows]) if mine else {}
    out = []
    for c in rows:
        item = CommissionListItem.model_validate(c)
        item.agent_name = names.get(c.agent_id) if c.agent_id else None
        if mine:
            item.my_net = r2(sum(float(s.net_amount or 0) for s in splits.get(c.id, []) if s.agent_id == user.id))
            item.house_amount = None
        else:
            item.house_amount = float(c.house_amount or 0)
        out.append(item)
    return out


async def to_out(db: AsyncSession, c: Commission, user: CurrentUser | None) -> CommissionOut:
    mine = restricted(user)
    splits = (await _splits(db, [c.id])).get(c.id, [])
    if mine:
        splits = [s for s in splits if s.agent_id == user.id]
    names = await user_names(db, [c.agent_id] + [s.agent_id for s in splits])
    out = CommissionOut.model_validate(c)
    out.agent_name = names.get(c.agent_id) if c.agent_id else None
    out.splits = []
    for s in sorted(splits, key=lambda s: ["primary", "co_agent", "referral", "house"].index(s.role)
                    if s.role in ("primary", "co_agent", "referral", "house") else 9):
        so = SplitOut.model_validate(s)
        so.agent_name = names.get(s.agent_id) if s.agent_id else None
        out.splits.append(so)
    invoices = list(await db.scalars(select(CommissionInvoice).where(
        CommissionInvoice.commission_id == c.id, CommissionInvoice.deleted_at.is_(None))
        .order_by(CommissionInvoice.issued_on)))
    out.invoices = [InvoiceOut.model_validate(i) for i in invoices]
    for i in out.invoices:
        i.commission_title = c.title
    out.payments = [PaymentOut.model_validate(p) for p in await db.scalars(select(CommissionPayment).where(
        CommissionPayment.commission_id == c.id, CommissionPayment.deleted_at.is_(None))
        .order_by(CommissionPayment.received_on))]
    if c.brokerage_deal_id:
        rows = await deal_rows(db, {c.brokerage_deal_id})
        if rows:
            d = rows[0]
            out.deal = {"id": str(d["id"]), "label": (await deal_labels(db, rows)).get(d["id"]),
                        "stage": d.get("stage"), "probability": norm_prob(d.get("probability")),
                        "expected_close_on": audit.to_jsonable(d.get("expected_close_on")),
                        "gross_commission_estimate": d.get("gross_commission_estimate")}
    ok, reasons = await compliance_check(db, c.brokerage_deal_id)
    out.compliance = {"complete": ok, "reasons": reasons}
    out.restricted = mine
    if mine:
        own = {str(user.id)}
        out.my_net = r2(sum(float(s.net_amount or 0) for s in splits))
        out.house_amount = None
        out.agent_net_total = None
        out.calc = {}
        out.participants = [p for p in (c.participants or []) if str(p.get("agent_id")) in own]
        out.deductions = [d for d in (c.deductions or []) if str(d.get("agent_id")) in own
                          or (not d.get("agent_id") and c.agent_id == user.id)]
        out.referral_amount = None
    else:
        out.house_amount = float(c.house_amount or 0)
        out.agent_net_total = float(c.agent_net_total or 0)
    return out


# =========================================================================== lifecycle

async def _apply_deal_defaults(db: AsyncSession, values: dict) -> dict:
    deal_id = values.get("brokerage_deal_id")
    if not deal_id:
        return values
    rows = await deal_rows(db, {deal_id})
    if not rows:
        if _deals() is not None:
            raise HTTPException(422, "Brokerage transaction not found")
        return values
    d = rows[0]
    if not values.get("agent_id"):
        values["agent_id"] = d.get("agent_id")
    if not values.get("property_id"):
        values["property_id"] = d.get("property_id")
    if not values.get("side") and d.get("side"):
        values["side"] = d["side"] if d["side"] in ("listing", "buyer", "tenant", "landlord", "dual") else "other"
    if values.get("probability") is None:
        values["probability"] = norm_prob(d.get("probability"))
    if not values.get("expected_close_on"):
        values["expected_close_on"] = d.get("expected_close_on")
    if values.get("deal_volume") is None and d.get("deal_value") is not None:
        values["deal_volume"] = float(d["deal_value"])
    if not values.get("gross") and d.get("gross_commission_estimate"):
        values["gross"] = float(d["gross_commission_estimate"])
    if not values.get("source") and d.get("source"):
        values["source"] = d["source"]
    if not values.get("title"):
        values["title"] = (await deal_labels(db, [d])).get(d["id"])
    return values


async def _property_type(db: AsyncSession, property_id: uuid.UUID | None) -> str | None:
    if not property_id:
        return None
    from app.modules.properties.models import Property

    p = await db.get(Property, property_id)
    return p.property_type if p else None


async def create(db: AsyncSession, data: CommissionCreate, actor, *, commit: bool = True) -> Commission:
    values = data.model_dump()
    if values.get("brokerage_deal_id"):
        dupe = await db.scalar(select(Commission.id).where(
            Commission.brokerage_deal_id == values["brokerage_deal_id"], Commission.deleted_at.is_(None),
            Commission.status != "cancelled"))
        if dupe:
            raise HTTPException(409, "A commission record already exists for this transaction")
    values = await _apply_deal_defaults(db, values)
    values["agent_id"] = values.get("agent_id") or getattr(actor, "id", None)
    if not values.get("participants") and values["agent_id"]:
        values["participants"] = [{"agent_id": str(values["agent_id"]), "share_pct": 100, "override_agent_pct": None}]
    values["participants"] = audit.to_jsonable(values["participants"])
    values["deductions"] = audit.to_jsonable(values.get("deductions") or [])
    values["property_type"] = values.get("property_type") or await _property_type(db, values.get("property_id"))
    if not values.get("expected_on") and values.get("expected_close_on"):
        values["expected_on"] = values["expected_close_on"] + timedelta(days=PAYMENT_LAG_DAYS)
    values["title"] = (values.get("title") or "Commission")[:255]
    c = Commission(**values, team_id=await _user_team(db, values["agent_id"]), status="forecast",
                   created_by_id=getattr(actor, "id", None), updated_by_id=getattr(actor, "id", None))
    db.add(c)
    await db.flush()
    await recalc(db, c, actor)
    await _event(db, c, "created", actor, to_status="forecast")
    await audit.record(db, actor=actor, action="commission.created", entity_type="commission", entity_id=c.id,
                       summary=f"{c.title} — gross {float(c.gross):,.2f}", ip_address=getattr(actor, "ip_address", None))
    if commit:
        await db.commit()
    return c


async def update(db: AsyncSession, c: Commission, data: CommissionUpdate, actor: CurrentUser) -> Commission:
    if c.status in LOCKED:
        raise HTTPException(409, f"A {c.status} commission cannot be edited")
    values = data.model_dump(exclude_unset=True)
    for k in ("participants", "deductions"):
        if k in values and values[k] is not None:
            values[k] = audit.to_jsonable(values[k])
    changes = audit.diff(c, values)
    if not changes:
        return c
    for k, v in values.items():
        setattr(c, k, v)
    if "agent_id" in changes:
        c.team_id = await _user_team(db, c.agent_id)
    if "property_id" in changes and "property_type" not in values:
        c.property_type = await _property_type(db, c.property_id)
    if c.approved_at:
        changes["approved_at"] = {"from": audit.to_jsonable(c.approved_at), "to": None}
        c.approved_at, c.approved_by_id = None, None
    c.updated_by_id = actor.id
    await recalc(db, c, actor)
    await _event(db, c, "updated", actor, note=", ".join(sorted(changes)), snapshot={"changes": changes})
    await audit.record(db, actor=actor, action="commission.updated", entity_type="commission", entity_id=c.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return c


async def _deal_closed(db: AsyncSession, c: Commission) -> bool | None:
    """True/False when the brokerage transaction is known, None when it cannot be determined."""
    if not c.brokerage_deal_id or _deals() is None:
        return None
    rows = await deal_rows(db, {c.brokerage_deal_id})
    if not rows:
        return None
    return str(rows[0].get("stage") or "").lower() in CLOSED_STAGES


async def earn(db: AsyncSession, c: Commission, data: EarnIn, actor, *, commit: bool = True) -> Commission:
    if c.status != "forecast":
        raise HTTPException(409, "Only forecast commissions can be marked earned")
    closed = await _deal_closed(db, c)
    if closed is not True and actor is not None and not actor.can("commissions", "approve"):
        raise HTTPException(409, "The transaction has not closed; marking it earned requires approval permission")
    prev = c.status
    c.status = "earned"
    c.earned_on = data.earned_on or date.today()
    c.probability = 100
    c.updated_by_id = getattr(actor, "id", None)
    await db.flush()
    await recalc(db, c, actor)  # YTD-based tiers are re-evaluated at the moment the commission is earned
    await _event(db, c, "earned", actor, from_status=prev, to_status="earned", note=data.note)
    await audit.record(db, actor=actor, action="commission.earned", entity_type="commission", entity_id=c.id,
                       summary=f"Earned {c.earned_on}", ip_address=getattr(actor, "ip_address", None))
    await events.emit(db, "commission.earned", commission_id=c.id, brokerage_deal_id=c.brokerage_deal_id, actor=actor)
    if commit:
        await db.commit()
    return c


async def approve(db: AsyncSession, c: Commission, note: str | None, actor: CurrentUser) -> Commission:
    if c.status not in ("earned", "invoiced"):
        raise HTTPException(409, "Only earned or invoiced commissions can be approved")
    c.approved_at, c.approved_by_id, c.updated_by_id = utcnow(), actor.id, actor.id
    await _event(db, c, "approved", actor, note=note, snapshot={"calc": c.calc})
    await audit.record(db, actor=actor, action="commission.approved", entity_type="commission", entity_id=c.id,
                       summary=note, ip_address=actor.ip_address)
    await db.commit()
    return c


async def cancel(db: AsyncSession, c: Commission, reason: str, actor: CurrentUser) -> Commission:
    if c.status in ("invoiced", "paid", "cancelled"):
        raise HTTPException(409, "Invoiced or paid commissions cannot be cancelled; void the invoice first")
    if c.status == "earned" and not actor.can("commissions", "approve"):
        raise HTTPException(403, "Cancelling an earned commission requires approval permission")
    prev = c.status
    c.status, c.updated_by_id = "cancelled", actor.id
    await _event(db, c, "cancelled", actor, from_status=prev, to_status="cancelled", note=reason)
    await audit.record(db, actor=actor, action="commission.cancelled", entity_type="commission", entity_id=c.id,
                       summary=reason, ip_address=actor.ip_address)
    await db.commit()
    return c


def render_invoice(c: Commission, number: str, bill_to: str, issued: date, due: date, amount: float,
                   memo: str | None, deal_label: str | None) -> str:
    lines = [
        "COMMISSION INVOICE",
        "",
        f"Invoice number: {number}",
        f"Issued: {issued:%B %d, %Y}",
        f"Due: {due:%B %d, %Y}",
        "",
        "Bill to:",
        bill_to,
        "",
        f"Transaction: {deal_label or c.title}",
    ]
    if c.deal_volume:
        lines.append(f"Transaction value: ${float(c.deal_volume):,.2f}")
    if c.side:
        lines.append(f"Representation: {c.side.replace('_', ' ')}")
    lines += ["", f"Brokerage commission due: ${amount:,.2f}"]
    if memo:
        lines += ["", memo]
    lines += ["", "Please reference the invoice number with your payment."]
    return "\n".join(lines)


async def create_invoice(db: AsyncSession, c: Commission, data: InvoiceCreate, actor: CurrentUser) -> CommissionInvoice:
    if c.status != "earned":
        raise HTTPException(409, "Only earned commissions can be invoiced")
    issued = data.issued_on or date.today()
    due = data.due_on or c.expected_on or issued + timedelta(days=PAYMENT_LAG_DAYS)
    if due < issued:
        raise HTTPException(422, "Due date must be on or after the issue date")
    amount = r2(data.amount if data.amount is not None else c.gross)
    count = await db.scalar(select(func.count()).select_from(CommissionInvoice).where(
        CommissionInvoice.invoice_number.like(f"INV-{issued.year}-%")))
    number = f"INV-{issued.year}-{int(count or 0) + 1:05d}"
    label = None
    if c.brokerage_deal_id:
        rows = await deal_rows(db, {c.brokerage_deal_id})
        label = (await deal_labels(db, rows)).get(c.brokerage_deal_id) if rows else None
    inv = CommissionInvoice(
        commission_id=c.id, invoice_number=number, bill_to=data.bill_to, issued_on=issued, due_on=due, amount=amount,
        status="issued", rendered_text=render_invoice(c, number, data.bill_to, issued, due, amount, data.memo, label),
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(inv)
    prev = c.status
    c.status, c.expected_on, c.updated_by_id = "invoiced", due, actor.id
    await db.flush()
    await _event(db, c, "invoiced", actor, from_status=prev, to_status="invoiced", note=number)
    await audit.record(db, actor=actor, action="commission.invoiced", entity_type="commission", entity_id=c.id,
                       summary=f"{number} — {amount:,.2f} due {due}", ip_address=actor.ip_address)
    await db.commit()
    return inv


async def void_invoice(db: AsyncSession, inv: CommissionInvoice, reason: str, actor: CurrentUser) -> CommissionInvoice:
    if inv.status != "issued":
        raise HTTPException(409, "Only open invoices can be voided")
    paid = await db.scalar(select(func.count()).select_from(CommissionPayment).where(
        CommissionPayment.invoice_id == inv.id, CommissionPayment.deleted_at.is_(None)))
    if paid:
        raise HTTPException(409, "Payments are recorded against this invoice")
    inv.status, inv.void_reason, inv.updated_by_id = "void", reason, actor.id
    c = await db.get(Commission, inv.commission_id)
    if c and c.status == "invoiced":
        others = await db.scalar(select(func.count()).select_from(CommissionInvoice).where(
            CommissionInvoice.commission_id == c.id, CommissionInvoice.id != inv.id,
            CommissionInvoice.status == "issued", CommissionInvoice.deleted_at.is_(None)))
        if not others:
            c.status = "earned"
            await _event(db, c, "invoice_voided", actor, from_status="invoiced", to_status="earned",
                         note=f"{inv.invoice_number}: {reason}")
    await audit.record(db, actor=actor, action="commission_invoice.voided", entity_type="commission",
                       entity_id=inv.commission_id, summary=f"{inv.invoice_number}: {reason}",
                       ip_address=actor.ip_address)
    await db.commit()
    return inv


def _reconcile(c: Commission, paid_total: float) -> None:
    """discrepancy = paid − gross; matched within one cent, otherwise short/over."""
    c.paid_total = r2(paid_total)
    c.discrepancy = r2(paid_total - float(c.gross or 0))
    if paid_total <= 0:
        c.reconciliation_status = "unpaid"
    elif abs(c.discrepancy) < 0.01:
        c.reconciliation_status = "matched"
    else:
        c.reconciliation_status = "short" if c.discrepancy < 0 else "over"


async def record_payment(db: AsyncSession, c: Commission, data: PaymentCreate, actor: CurrentUser) -> CommissionPayment:
    if c.status != "invoiced":
        raise HTTPException(409, "Payments can only be recorded against an invoiced commission")
    invoice_id = data.invoice_id
    if invoice_id:
        inv = await db.get(CommissionInvoice, invoice_id)
        if not inv or inv.commission_id != c.id or inv.status == "void":
            raise HTTPException(422, "Invoice not found on this commission")
    else:
        inv = await db.scalar(select(CommissionInvoice).where(
            CommissionInvoice.commission_id == c.id, CommissionInvoice.status == "issued",
            CommissionInvoice.deleted_at.is_(None)).order_by(CommissionInvoice.issued_on.desc()).limit(1))
        invoice_id = inv.id if inv else None
    pay = CommissionPayment(commission_id=c.id, invoice_id=invoice_id, amount=data.amount, received_on=data.received_on,
                            reference=data.reference, method=data.method, note=data.note,
                            created_by_id=actor.id, updated_by_id=actor.id)
    db.add(pay)
    await db.flush()
    total = await db.scalar(select(func.coalesce(func.sum(CommissionPayment.amount), 0)).where(
        CommissionPayment.commission_id == c.id, CommissionPayment.deleted_at.is_(None)))
    before = c.reconciliation_status
    _reconcile(c, float(total or 0))
    if inv is not None:
        inv_paid = await db.scalar(select(func.coalesce(func.sum(CommissionPayment.amount), 0)).where(
            CommissionPayment.invoice_id == inv.id, CommissionPayment.deleted_at.is_(None)))
        if float(inv_paid or 0) >= float(inv.amount) - 0.005:
            inv.status = "paid"
    await _event(db, c, "payment_recorded", actor, note=f"{data.amount:,.2f} received {data.received_on}",
                 snapshot={"reconciliation": {"from": before, "to": c.reconciliation_status,
                                              "paid_total": c.paid_total, "discrepancy": c.discrepancy}})
    await audit.record(db, actor=actor, action="commission.payment_recorded", entity_type="commission", entity_id=c.id,
                       summary=f"{data.amount:,.2f} received {data.received_on}", ip_address=actor.ip_address)
    await db.commit()
    return pay


async def release(db: AsyncSession, c: Commission, data: ReleaseIn, actor: CurrentUser) -> Commission:
    """Mark paid / release to agents. Gates: earned → invoiced → paid, approval, payment received,
    reconciliation (or explicit acceptance of a discrepancy) and transaction-file compliance."""
    if c.status != "invoiced":
        raise HTTPException(409, "Only invoiced commissions can be released; a commission must be earned and "
                                 "invoiced before it can be marked paid")
    if not c.approved_at:
        raise HTTPException(409, "Commission must be approved before release")
    if float(c.paid_total or 0) <= 0:
        raise HTTPException(409, "No payment has been recorded for this commission")
    ok, reasons = await compliance_check(db, c.brokerage_deal_id)
    if not ok:
        raise HTTPException(409, {"message": "Release blocked: transaction file is not complete — "
                                             + "; ".join(reasons), "reasons": reasons})
    if c.reconciliation_status != "matched":
        if not data.accept_discrepancy or not data.note:
            raise HTTPException(409, f"Paid amount differs from the expected gross by {float(c.discrepancy):,.2f}; "
                                     "accept the discrepancy with a note to release")
        from app.modules.tasks.service import raise_alert

        await raise_alert(db, title=f"Commission discrepancy released: {c.title}",
                          reason=f"Paid {float(c.paid_total):,.2f} vs expected {float(c.gross):,.2f}. {data.note}",
                          severity="medium", owner_id=c.approved_by_id or actor.id, related_type="commission",
                          related_id=c.id, related_label=c.title, rule_key="commission_discrepancy",
                          idempotency_key=f"commission_discrepancy:{c.id}")
    last = await db.scalar(select(func.max(CommissionPayment.received_on)).where(
        CommissionPayment.commission_id == c.id, CommissionPayment.deleted_at.is_(None)))
    prev = c.status
    c.status, c.paid_on = "paid", last or date.today()
    c.released_by_id, c.released_at, c.release_note, c.updated_by_id = actor.id, utcnow(), data.note, actor.id
    await _event(db, c, "released", actor, from_status=prev, to_status="paid", note=data.note,
                 snapshot={"paid_total": c.paid_total, "discrepancy": c.discrepancy, "compliance": reasons})
    await audit.record(db, actor=actor, action="commission.released", entity_type="commission", entity_id=c.id,
                       summary=f"Paid {float(c.paid_total):,.2f}", ip_address=actor.ip_address)
    await events.emit(db, "commission.paid", commission_id=c.id, brokerage_deal_id=c.brokerage_deal_id, actor=actor)
    await db.commit()
    return c


# =========================================================================== brokerage sync

async def upsert_from_deal(db: AsyncSession, d: dict, actor) -> str | None:
    """Create/update the commission for one brokerage deal. Does not commit. Returns the action taken."""
    stage = str(d.get("stage") or "").lower()
    c = await db.scalar(select(Commission).where(
        Commission.brokerage_deal_id == d["id"], Commission.deleted_at.is_(None), Commission.status != "cancelled"))
    if c is None:
        if stage in LOST_STAGES:
            return None
        c = await create(db, CommissionCreate(brokerage_deal_id=d["id"], gross=0), actor, commit=False)
        if stage in CLOSED_STAGES:
            await earn(db, c, EarnIn(earned_on=d.get("closed_on") or d.get("expected_close_on") or date.today(),
                                     note="Transaction closed (brokerage sync)"), None, commit=False)
            return "earned"
        return "created"
    if c.status != "forecast":
        return None
    if stage in LOST_STAGES:
        c.status = "cancelled"
        await _event(db, c, "cancelled", actor, from_status="forecast", to_status="cancelled",
                     note=f"Transaction stage '{stage}' (brokerage sync)")
        return "cancelled"
    values = {"probability": norm_prob(d.get("probability")), "expected_close_on": d.get("expected_close_on")}
    if d.get("gross_commission_estimate") is not None:
        values["gross"] = float(d["gross_commission_estimate"])
    if d.get("deal_value") is not None:
        values["deal_volume"] = float(d["deal_value"])
    if d.get("agent_id"):
        values["agent_id"] = d["agent_id"]
    changes = audit.diff(c, values)
    if changes:
        for k, v in values.items():
            setattr(c, k, v)
        if "expected_close_on" in changes and c.expected_close_on:
            c.expected_on = c.expected_close_on + timedelta(days=PAYMENT_LAG_DAYS)
        if "agent_id" in changes:
            c.team_id = await _user_team(db, c.agent_id)
            c.participants = [{"agent_id": str(c.agent_id), "share_pct": 100, "override_agent_pct": None}]
        await recalc(db, c, actor)
        await _event(db, c, "synced", actor, note="Updated from brokerage transaction", snapshot={"changes": changes})
    if stage in CLOSED_STAGES:
        await earn(db, c, EarnIn(earned_on=d.get("closed_on") or d.get("expected_close_on") or date.today(),
                                 note="Transaction closed (brokerage sync)"), None, commit=False)
        return "earned"
    return "updated" if changes else None


async def sync_from_deals(db: AsyncSession, actor: CurrentUser) -> SyncOut:
    if _deals() is None:
        return SyncOut(available=False, message="Brokerage module unavailable")
    counts = defaultdict(int)
    for d in await deal_rows(db):
        action = await upsert_from_deal(db, d, actor)
        if action:
            counts[action] += 1
    await audit.record(db, actor=actor, action="commission.synced", entity_type="commission",
                       summary=", ".join(f"{k} {v}" for k, v in counts.items()) or "no changes",
                       ip_address=actor.ip_address)
    await db.commit()
    return SyncOut(available=True, created=counts["created"], updated=counts["updated"], earned=counts["earned"],
                   cancelled=counts["cancelled"])


# =========================================================================== forecast

async def forecast(db: AsyncSession, user: CurrentUser | None, months: int = 12,
                   agent_id: uuid.UUID | None = None) -> dict:
    """Weighted forecast by expected payment month.

    weighted = open amount × weight, where weight = probability / 100 for forecast commissions and 1 for
    earned/invoiced (open amount = gross − paid). Pipeline deals with no commission record contribute
    gross_commission_estimate × probability at their expected close month. Restricted agents see their own
    split net amounts instead of gross.
    """
    start = date.today().replace(day=1)
    keys = [month_key(add_months(start, i)) for i in range(months)]
    buckets = {k: {"month": k, "weighted": 0.0, "unweighted": 0.0, "count": 0} for k in keys}
    past_due = {"weighted": 0.0, "unweighted": 0.0, "count": 0}
    unscheduled = {"weighted": 0.0, "unweighted": 0.0, "count": 0}
    by_agent: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    items: list[dict] = []
    mine = restricted(user)

    stmt = visible(select(Commission).where(Commission.deleted_at.is_(None), Commission.status.in_(OPEN_STATUSES)), user)
    if agent_id:
        stmt = stmt.where(or_(Commission.agent_id == agent_id, Commission.id.in_(
            select(CommissionSplit.commission_id).where(CommissionSplit.agent_id == agent_id,
                                                        CommissionSplit.deleted_at.is_(None)))))
    rows = list(await db.scalars(stmt))
    splits = await _splits(db, [c.id for c in rows]) if mine else {}

    def add(target: dict, amount: float, weight: float) -> None:
        target["weighted"] += amount * weight
        target["unweighted"] += amount
        target["count"] += 1

    def place(amount: float, weight: float, when: date | None, agent: str | None) -> str:
        if when is None:
            add(unscheduled, amount, weight)
            return "unscheduled"
        if when < start:
            add(past_due, amount, weight)
            return "past_due"
        key = month_key(when)
        if key in buckets:
            add(buckets[key], amount, weight)
            if agent:
                by_agent[agent][key] += amount * weight
            return key
        return "beyond"

    for c in rows:
        if mine:
            amount = sum(float(s.net_amount or 0) for s in splits.get(c.id, []) if s.agent_id == user.id)
        else:
            amount = max(0.0, float(c.gross or 0) - float(c.paid_total or 0))
        weight = 1.0 if c.status in ("earned", "invoiced") else float(c.probability or 0) / 100.0
        when = c.expected_on or c.expected_close_on
        bucket = place(amount, weight, when, str(c.agent_id) if c.agent_id else None)
        items.append({"id": str(c.id), "kind": "commission", "title": c.title, "status": c.status,
                      "agent_id": str(c.agent_id) if c.agent_id else None, "amount": r2(amount),
                      "probability": c.probability, "weight": weight, "weighted": r2(amount * weight),
                      "expected_on": audit.to_jsonable(when), "bucket": bucket})

    pipeline_included = False
    if _deals() is not None:
        # Pipeline deals not yet carrying a commission record (agents only see their own deals).
        linked = set(await db.scalars(select(Commission.brokerage_deal_id).where(
            Commission.brokerage_deal_id.isnot(None), Commission.deleted_at.is_(None))))
        deals = [d for d in await deal_rows(db) if d["id"] not in linked
                 and str(d.get("stage") or "").lower() not in CLOSED_STAGES | LOST_STAGES]
        if mine:
            deals = [d for d in deals if d.get("agent_id") == user.id]
        if agent_id:
            deals = [d for d in deals if d.get("agent_id") == agent_id]
        labels = await deal_labels(db, deals)
        for d in deals:
            amount = float(d.get("gross_commission_estimate") or 0)
            if amount <= 0:
                continue
            weight = (norm_prob(d.get("probability")) or 0) / 100.0
            when = d.get("expected_close_on")
            bucket = place(amount, weight, when, str(d["agent_id"]) if d.get("agent_id") else None)
            items.append({"id": str(d["id"]), "kind": "deal", "title": labels.get(d["id"]), "status": d.get("stage"),
                          "agent_id": str(d["agent_id"]) if d.get("agent_id") else None, "amount": r2(amount),
                          "probability": norm_prob(d.get("probability")), "weight": weight,
                          "weighted": r2(amount * weight), "expected_on": audit.to_jsonable(when), "bucket": bucket})
        pipeline_included = True

    for b in [*buckets.values(), past_due, unscheduled]:
        b["weighted"], b["unweighted"] = r2(b["weighted"]), r2(b["unweighted"])
    in_horizon = list(buckets.values())
    items.sort(key=lambda i: (i["expected_on"] or "9999", -i["weighted"]))
    return {
        "start": start.isoformat(), "months": in_horizon, "past_due": past_due, "unscheduled": unscheduled,
        "total_weighted": r2(sum(b["weighted"] for b in in_horizon) + past_due["weighted"]),
        "total_unweighted": r2(sum(b["unweighted"] for b in in_horizon) + past_due["unweighted"]),
        "items": items[:300], "pipeline_included": pipeline_included, "restricted": mine,
        "by_agent": {k: {m: r2(v) for m, v in vals.items()} for k, vals in by_agent.items()},
    }


async def ensure_snapshot(db: AsyncSession, actor: CurrentUser | None) -> ForecastSnapshot:
    """Freeze this month's company-wide forecast once (idempotent per month)."""
    month = date.today().replace(day=1)
    snap = await db.scalar(select(ForecastSnapshot).where(ForecastSnapshot.snapshot_month == month))
    if snap:
        return snap
    f = await forecast(db, None, months=12)
    snap = ForecastSnapshot(
        snapshot_month=month, taken_by_id=getattr(actor, "id", None),
        buckets={b["month"]: {"weighted": b["weighted"], "unweighted": b["unweighted"], "count": b["count"]}
                 for b in f["months"]},
        by_agent=f["by_agent"], total_weighted=f["total_weighted"],
    )
    db.add(snap)
    await db.commit()
    return snap


async def accuracy(db: AsyncSession, months: int = 12) -> dict:
    """Forecast accuracy per past month M.

    forecast_0 = weighted bucket M in the snapshot taken at the start of M
    forecast_3 = weighted bucket M in the snapshot taken three months earlier
    actual     = commission payments received during M
    accuracy % = max(0, 1 − |actual − forecast_0| / forecast_0) × 100
    """
    snaps = {s.snapshot_month: s for s in await db.scalars(select(ForecastSnapshot))}
    start = date.today().replace(day=1)
    rows = []
    for i in range(months, 0, -1):
        m = add_months(start, -i)
        key = month_key(m)
        s0, s3 = snaps.get(m), snaps.get(add_months(m, -3))
        f0 = (s0.buckets or {}).get(key, {}).get("weighted") if s0 else None
        f3 = (s3.buckets or {}).get(key, {}).get("weighted") if s3 else None
        actual = await db.scalar(select(func.coalesce(func.sum(CommissionPayment.amount), 0)).where(
            CommissionPayment.deleted_at.is_(None), CommissionPayment.received_on >= m,
            CommissionPayment.received_on < add_months(m, 1)))
        actual = r2(actual)
        variance = r2(actual - f0) if f0 is not None else None
        acc = round(max(0.0, 1 - abs(actual - f0) / f0) * 100, 1) if f0 else None
        rows.append({"month": key, "forecast": f0, "forecast_3m": f3, "actual": actual, "variance": variance,
                     "accuracy_pct": acc})
    scored = [r["accuracy_pct"] for r in rows if r["accuracy_pct"] is not None]
    return {"months": rows, "average_accuracy_pct": round(sum(scored) / len(scored), 1) if scored else None,
            "snapshots": len(snaps)}


# =========================================================================== production

GROUPS = ["agent", "team", "property_type", "source", "month", "quarter", "year"]


def _period_key(d: date, group_by: str) -> str:
    if group_by == "month":
        return month_key(d)
    if group_by == "quarter":
        return f"{d.year}-Q{(d.month - 1) // 3 + 1}"
    return str(d.year)


async def production(db: AsyncSession, user: CurrentUser, group_by: str = "agent", start: date | None = None,
                     end: date | None = None, agent_id: uuid.UUID | None = None, team_id: uuid.UUID | None = None,
                     property_type: str | None = None, source: str | None = None) -> dict:
    """Production by agent/team/property type/source/period.

    count = closed transactions (agent rows credit share_pct / 100 per co-brokered deal)
    volume = Σ deal_volume (× share for agents); GCI = Σ gross (agents: their GCI share)
    avg deal size = volume / count; cycle time = mean days from deal creation to earned date
    stage conversion = brokerage deals created in the period that reached a closed stage / all created.
    """
    if group_by not in GROUPS:
        raise HTTPException(422, f"group_by must be one of {', '.join(GROUPS)}")
    end = end or date.today()
    start = start or date(end.year, 1, 1)
    if restricted(user):
        agent_id = user.id
    stmt = select(Commission).where(Commission.deleted_at.is_(None), Commission.status.in_(EARNED_STATUSES),
                                    Commission.earned_on >= start, Commission.earned_on <= end)
    if team_id:
        stmt = stmt.where(Commission.team_id == team_id)
    if property_type:
        stmt = stmt.where(Commission.property_type == property_type)
    if source:
        stmt = stmt.where(Commission.source == source)
    if agent_id:
        stmt = stmt.where(or_(Commission.agent_id == agent_id, Commission.id.in_(
            select(CommissionSplit.commission_id).where(CommissionSplit.agent_id == agent_id,
                                                        CommissionSplit.deleted_at.is_(None)))))
    rows = list(await db.scalars(stmt))
    splits = await _splits(db, [c.id for c in rows])
    deal_ids = {c.brokerage_deal_id for c in rows if c.brokerage_deal_id}
    deals_by_id = {d["id"]: d for d in await deal_rows(db, deal_ids)} if deal_ids else {}

    groups: dict[str, dict] = defaultdict(lambda: {"count": 0.0, "volume": 0.0, "gci": 0.0, "cycle": []})

    def credit(key: str | None, share: float, volume: float, gci: float, cycle: int | None) -> None:
        g = groups[key or "unassigned"]
        g["count"] += share
        g["volume"] += volume * share
        g["gci"] += gci
        if cycle is not None:
            g["cycle"].append(cycle)

    for c in rows:
        d = deals_by_id.get(c.brokerage_deal_id) if c.brokerage_deal_id else None
        began = d.get("created_at") if d else None
        began_on = began.date() if began is not None and hasattr(began, "date") else (c.created_at.date() if c.created_at else None)
        cycle = (c.earned_on - began_on).days if (c.earned_on and began_on) else None
        vol = float(c.deal_volume or 0)
        if group_by == "agent":
            for s in splits.get(c.id, []):
                if s.role not in ("primary", "co_agent") or (agent_id and s.agent_id != agent_id):
                    continue
                credit(str(s.agent_id), float(s.share_pct or 100) / 100.0, vol, float(s.gci_amount or 0), cycle)
        else:
            key = {"team": str(c.team_id) if c.team_id else None, "property_type": c.property_type,
                   "source": c.source}.get(group_by) if group_by in ("team", "property_type", "source") \
                else _period_key(c.earned_on, group_by)
            credit(key, 1.0, vol, float(c.gross or 0), cycle)

    # stage conversion from the brokerage pipeline (guarded)
    conversion: dict[str, dict] = defaultdict(lambda: {"total": 0, "closed": 0, "lost": 0, "stages": defaultdict(int)})
    pipeline_available = _deals() is not None
    if pipeline_available:
        all_deals = await deal_rows(db)
        team_of: dict = {}
        ptype_of: dict = {}
        if group_by == "team":
            from app.modules.auth.models import User

            team_of = dict((await db.execute(select(User.id, User.team_id))).all())
        if group_by == "property_type" or property_type:
            from app.modules.properties.models import Property

            pids = {d.get("property_id") for d in all_deals if d.get("property_id")}
            if pids:
                ptype_of = dict((await db.execute(select(Property.id, Property.property_type)
                                                  .where(Property.id.in_(pids)))).all())
        for d in all_deals:
            created = d.get("created_at")
            created_on = created.date() if created is not None and hasattr(created, "date") else None
            if created_on is None or created_on < start or created_on > end:
                continue
            if agent_id and d.get("agent_id") != agent_id:
                continue
            if property_type and ptype_of.get(d.get("property_id")) != property_type:
                continue
            if source and d.get("source") != source:
                continue
            if team_id and team_of and team_of.get(d.get("agent_id")) != team_id:
                continue
            key = {"agent": str(d["agent_id"]) if d.get("agent_id") else None,
                   "team": str(team_of.get(d.get("agent_id"))) if team_of.get(d.get("agent_id")) else None,
                   "property_type": ptype_of.get(d.get("property_id")),
                   "source": d.get("source")}.get(group_by) if group_by in ("agent", "team", "property_type", "source") \
                else _period_key(created_on, group_by)
            stage = str(d.get("stage") or "unknown").lower()
            row = conversion[key or "unassigned"]
            row["total"] += 1
            row["stages"][stage] += 1
            if stage in CLOSED_STAGES:
                row["closed"] += 1
            elif stage in LOST_STAGES:
                row["lost"] += 1

    labels: dict[str, str] = {}
    keys = set(groups) | set(conversion)
    if group_by == "agent":
        ids = [uuid.UUID(k) for k in keys if k != "unassigned"]
        labels = {str(k): v for k, v in (await user_names(db, ids)).items()}
    elif group_by == "team":
        from app.modules.auth.models import Team

        ids = [uuid.UUID(k) for k in keys if k != "unassigned"]
        if ids:
            labels = {str(i): n for i, n in (await db.execute(select(Team.id, Team.name).where(Team.id.in_(ids)))).all()}

    out_rows = []
    for k in keys:
        g = groups.get(k, {"count": 0.0, "volume": 0.0, "gci": 0.0, "cycle": []})
        conv = conversion.get(k)
        count = g["count"]
        out_rows.append({
            "key": k, "label": labels.get(k) or ("Unassigned" if k == "unassigned" else k),
            "count": round(count, 2), "volume": r2(g["volume"]), "gci": r2(g["gci"]),
            "avg_deal_size": r2(g["volume"] / count) if count else None,
            "avg_gci": r2(g["gci"] / count) if count else None,
            "cycle_time_days": round(sum(g["cycle"]) / len(g["cycle"]), 1) if g["cycle"] else None,
            "deals_total": conv["total"] if conv else 0, "deals_closed": conv["closed"] if conv else 0,
            "deals_lost": conv["lost"] if conv else 0,
            "conversion_pct": round(100.0 * conv["closed"] / conv["total"], 1) if conv and conv["total"] else None,
            "stage_counts": dict(conv["stages"]) if conv else {},
        })
    out_rows.sort(key=lambda r: (-r["gci"], r["label"]))
    total_count = sum(r["count"] for r in out_rows)
    total_volume = sum(r["volume"] for r in out_rows)
    total_gci = sum(r["gci"] for r in out_rows)
    cycles = [x for g in groups.values() for x in g["cycle"]]
    return {
        "group_by": group_by, "start": start.isoformat(), "end": end.isoformat(), "rows": out_rows,
        "totals": {"count": round(total_count, 2), "volume": r2(total_volume), "gci": r2(total_gci),
                   "avg_deal_size": r2(total_volume / total_count) if total_count else None,
                   "cycle_time_days": round(sum(cycles) / len(cycles), 1) if cycles else None,
                   "deals_total": sum(r["deals_total"] for r in out_rows),
                   "deals_closed": sum(r["deals_closed"] for r in out_rows)},
        "pipeline_available": pipeline_available, "restricted": restricted(user),
    }


# =========================================================================== plans

async def save_plan(db: AsyncSession, plan: SplitPlan | None, data: PlanIn, actor: CurrentUser) -> SplitPlan:
    values = data.model_dump()
    values["tiers"] = sorted(values["tiers"], key=lambda t: t["min_ytd_gci"])
    if values["tiers"][0]["min_ytd_gci"] != 0:
        raise HTTPException(422, "The first tier must start at $0 YTD GCI")
    mins = [t["min_ytd_gci"] for t in values["tiers"]]
    if len(set(mins)) != len(mins):
        raise HTTPException(422, "Tier thresholds must be unique")
    if values["is_default"]:
        for other in await db.scalars(select(SplitPlan).where(SplitPlan.is_default.is_(True), SplitPlan.deleted_at.is_(None))):
            if plan is None or other.id != plan.id:
                other.is_default = False
    if plan is None:
        plan = SplitPlan(**values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(plan)
        await db.flush()
        changes = None
        action = "split_plan.created"
    else:
        changes = audit.diff(plan, values)
        if not changes:
            return plan
        for k, v in values.items():
            setattr(plan, k, v)
        plan.updated_by_id = actor.id
        action = "split_plan.updated"
    await audit.record(db, actor=actor, action=action, entity_type="split_plan", entity_id=plan.id, summary=plan.name,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return plan


async def agent_plans(db: AsyncSession) -> list[AgentPlanOut]:
    from app.modules.auth.models import User

    assigned = {a.agent_id: a for a in await db.scalars(select(AgentPlan).where(AgentPlan.deleted_at.is_(None)))}
    agents = set(assigned) | set(await db.scalars(select(Commission.agent_id).where(
        Commission.agent_id.isnot(None), Commission.deleted_at.is_(None)).distinct()))
    if not agents:
        return []
    users = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(agents)))}
    plans = {p.id: p for p in await db.scalars(select(SplitPlan).where(SplitPlan.deleted_at.is_(None)))}
    default = next((p for p in plans.values() if p.is_default and p.is_active), None)
    year = date.today().year
    out = []
    for aid in agents:
        a = assigned.get(aid)
        plan = plans.get(a.plan_id) if a else default
        g, h = await ytd(db, aid, year)
        u = users.get(aid)
        out.append(AgentPlanOut(agent_id=aid, agent_name=u.full_name if u else None, team_id=u.team_id if u else None,
                                plan_id=plan.id if plan else None,
                                plan_name=(plan.name + ("" if a else " (default)")) if plan else None,
                                effective_from=a.effective_from if a else None, ytd_gci=r2(g), ytd_house=r2(h)))
    out.sort(key=lambda r: (r.agent_name or ""))
    return out


async def assign_plan(db: AsyncSession, agent_id: uuid.UUID, plan_id: uuid.UUID | None, effective_from: date | None,
                      actor: CurrentUser) -> None:
    a = await db.scalar(select(AgentPlan).where(AgentPlan.agent_id == agent_id))
    before = str(a.plan_id) if a and not a.deleted_at else None
    if plan_id is None:
        if a and not a.deleted_at:
            a.deleted_at, a.updated_by_id = utcnow(), actor.id
    else:
        plan = await db.get(SplitPlan, plan_id)
        if not plan or plan.deleted_at:
            raise HTTPException(422, "Plan not found")
        if a is None:
            db.add(AgentPlan(agent_id=agent_id, plan_id=plan_id, effective_from=effective_from,
                             created_by_id=actor.id, updated_by_id=actor.id))
        else:
            a.plan_id, a.effective_from, a.deleted_at, a.updated_by_id = plan_id, effective_from, None, actor.id
    await audit.record(db, actor=actor, action="split_plan.assigned", entity_type="user", entity_id=agent_id,
                       changes={"plan_id": {"from": before, "to": str(plan_id) if plan_id else None}},
                       ip_address=actor.ip_address)
    await db.commit()
