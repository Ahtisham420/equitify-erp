import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import Select, false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.database import Base
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.investors import waterfall as wf
from app.modules.investors.models import (
    INVESTMENT_MATERIAL,
    CapitalAccountEntry,
    CapitalEvent,
    CapitalEventAllocation,
    CapitalEventVersion,
    CapitalPartner,
    Investment,
    ReportPackage,
    ReportSchedule,
    Waterfall,
    WaterfallTier,
)
from app.modules.investors.schemas import (
    AccountSummary,
    AllocationOut,
    EntryOut,
    EventCreate,
    EventOut,
    EventPreviewIn,
    EventUpdate,
    FundIn,
    IncomeAllocationIn,
    InvestmentCreate,
    InvestmentOut,
    InvestmentUpdate,
    PackageCreate,
    PackageListItem,
    PartnerCreate,
    PartnerListItem,
    PartnerOut,
    PartnerUpdate,
    PortalOut,
    ScheduleIn,
    ScheduleUpdate,
    StatementOut,
    TierOut,
    WaterfallIn,
    WaterfallOut,
)

PORTAL_ROLE = "capital_partner"
PROFIT_COMPONENTS = {"preferred_return", "catch_up", "profit", "residual"}
# asset_financials sources that are plans/estimates rather than recorded actuals; never reported to partners.
UNVERIFIED_SOURCES = {"forecast", "estimate", "budget", "projection", "ai", "pro_forma", "proforma"}
DEFAULT_GRACE_DAYS = 10


# =========================================================================== access scoping

def is_portal(user: CurrentUser) -> bool:
    role = getattr(user.user, "role", None)
    return getattr(role, "key", None) == PORTAL_ROLE


async def scope_ids(db: AsyncSession, user: CurrentUser) -> list[uuid.UUID] | None:
    """Partner ids a portal user may see (portal_user_id = user.id); None means unrestricted staff access."""
    if not is_portal(user):
        return None
    rows = await db.scalars(
        select(CapitalPartner.id).where(CapitalPartner.portal_user_id == user.id, CapitalPartner.deleted_at.is_(None))
    )
    return list(rows)


def deny_portal(user: CurrentUser) -> None:
    if is_portal(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not available in the investor portal")


def scoped(stmt: Select, column, ids: list[uuid.UUID] | None) -> Select:
    """Applies the portal partner scope to any statement. An empty scope matches nothing."""
    if ids is None:
        return stmt
    return stmt.where(column.in_(ids)) if ids else stmt.where(false())


def check_capital_limit(user: CurrentUser, amount: float) -> None:
    if user.is_admin:
        return
    if "capital" in (user.approval_limits or {}) and not user.can_approve("capital", amount):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Amount exceeds your capital approval limit")


# =========================================================================== cross-module lookups (guarded)

def _table(name: str):
    return Base.metadata.tables.get(name)


async def user_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    from app.modules.tasks.service import user_names as _names

    return await _names(db, ids)


async def asset_labels(db: AsyncSession, pairs: list[tuple[uuid.UUID | None, uuid.UUID | None]]) -> dict[uuid.UUID, str]:
    """Label per asset id: the asset's property name/address, falling back to a property id hint."""
    from app.modules.properties.models import Property

    prop = Property.__table__
    out: dict[uuid.UUID, str] = {}
    asset_ids = {a for a, _ in pairs if a}
    assets = _table("assets")
    if asset_ids and assets is not None and "property_id" in assets.c:
        rows = await db.execute(
            select(assets.c.id, prop.c.name, prop.c.address_line, prop.c.city)
            .select_from(assets.outerjoin(prop, prop.c.id == assets.c.property_id))
            .where(assets.c.id.in_(asset_ids))
        )
        for aid, name, addr, city in rows.all():
            out[aid] = name or ", ".join(x for x in [addr, city] if x) or f"Asset {str(aid)[:8]}"
    missing = {p: a for a, p in pairs if a and a not in out and p}
    if missing:
        rows = await db.execute(select(prop.c.id, prop.c.name, prop.c.address_line).where(prop.c.id.in_(set(missing))))
        for pid, name, addr in rows.all():
            out[missing[pid]] = name or addr
    for a in asset_ids:
        out.setdefault(a, f"Asset {str(a)[:8]}")
    return out


async def asset_row(db: AsyncSession, asset_id: uuid.UUID) -> dict | None:
    assets = _table("assets")
    if assets is None:
        return None
    row = (await db.execute(select(assets).where(assets.c.id == asset_id))).mappings().first()
    return dict(row) if row else None


async def asset_options(db: AsyncSession, q: str | None) -> list[dict]:
    from app.modules.properties.models import Property

    assets = _table("assets")
    if assets is None:
        return []
    prop = Property.__table__
    stmt = (
        select(assets.c.id, assets.c.property_id, prop.c.name, prop.c.address_line, prop.c.city,
               assets.c.status if "status" in assets.c else prop.c.status)
        .select_from(assets.outerjoin(prop, prop.c.id == assets.c.property_id))
    )
    if "deleted_at" in assets.c:
        stmt = stmt.where(assets.c.deleted_at.is_(None))
    if q:
        for term in q.split():
            stmt = stmt.where(or_(prop.c.name.ilike(f"%{term}%"), prop.c.address_line.ilike(f"%{term}%"),
                                  prop.c.city.ilike(f"%{term}%")))
    rows = await db.execute(stmt.limit(100))
    return [
        {"id": r[0], "property_id": r[1], "label": r[2] or ", ".join(x for x in [r[3], r[4]] if x) or str(r[0])[:8],
         "status": r[5]}
        for r in rows.all()
    ]


# =========================================================================== partners

@dataclass
class PartnerFilters:
    q: str | None = None
    type: list[str] | None = None
    status: list[str] | None = None
    owner_id: list[uuid.UUID] | None = None
    asset_id: uuid.UUID | None = None
    in_default: bool | None = None


def build_partner_query(f: PartnerFilters, ids: list[uuid.UUID] | None, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(CapitalPartner).where(CapitalPartner.deleted_at.is_(None))
    stmt = scoped(stmt, CapitalPartner.id, ids)
    stmt = apply_search(stmt, f.q, [CapitalPartner.name, CapitalPartner.email])
    if "type" not in skip:
        stmt = in_filter(stmt, CapitalPartner.type, f.type)
    if "status" not in skip:
        stmt = in_filter(stmt, CapitalPartner.status, f.status)
    stmt = in_filter(stmt, CapitalPartner.owner_id, f.owner_id)
    if f.asset_id:
        stmt = stmt.where(CapitalPartner.id.in_(
            select(Investment.partner_id).where(Investment.asset_id == f.asset_id, Investment.deleted_at.is_(None))
        ))
    if f.in_default is not None:
        defaulted = select(CapitalEventAllocation.partner_id).where(
            CapitalEventAllocation.default_flag.is_(True), CapitalEventAllocation.status == "default",
            CapitalEventAllocation.deleted_at.is_(None),
        )
        stmt = stmt.where(CapitalPartner.id.in_(defaulted) if f.in_default else CapitalPartner.id.not_in(defaulted))
    return stmt


async def get_partner(db: AsyncSession, partner_id: uuid.UUID, user: CurrentUser) -> CapitalPartner:
    p = await db.get(CapitalPartner, partner_id)
    ids = await scope_ids(db, user)
    if not p or p.deleted_at or (ids is not None and p.id not in ids):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Partner not found")
    return p


async def partner_rollups(db: AsyncSession, partner_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    if not partner_ids:
        return {}
    rows = await db.execute(
        select(Investment.partner_id, func.coalesce(func.sum(Investment.commitment), 0),
               func.coalesce(func.sum(Investment.funded), 0), func.count())
        .where(Investment.partner_id.in_(partner_ids), Investment.deleted_at.is_(None))
        .group_by(Investment.partner_id)
    )
    out = {pid: {"commitment": float(c), "funded": float(fu), "investment_count": int(n)} for pid, c, fu, n in rows.all()}
    defaulted = set(await db.scalars(
        select(CapitalEventAllocation.partner_id).where(
            CapitalEventAllocation.partner_id.in_(partner_ids), CapitalEventAllocation.status == "default",
            CapitalEventAllocation.deleted_at.is_(None),
        )
    ))
    for pid in partner_ids:
        r = out.setdefault(pid, {"commitment": 0.0, "funded": 0.0, "investment_count": 0})
        r["unfunded"] = round(max(0.0, r["commitment"] - r["funded"]), 2)
        r["in_default"] = pid in defaulted
    return out


async def partner_items(db: AsyncSession, rows: list[CapitalPartner]) -> list[PartnerListItem]:
    roll = await partner_rollups(db, [p.id for p in rows])
    out = []
    for p in rows:
        item = PartnerListItem.model_validate(p)
        for k, v in roll.get(p.id, {}).items():
            setattr(item, k, v)
        out.append(item)
    return out


async def partner_out(db: AsyncSession, p: CapitalPartner) -> PartnerOut:
    from app.modules.contacts.models import Organization, Person

    out = PartnerOut.model_validate(p)
    if p.organization_id:
        org = await db.get(Organization, p.organization_id)
        out.organization_name = org.name if org else None
    if p.person_id:
        person = await db.get(Person, p.person_id)
        out.person_name = person.full_name if person else None
    names = await user_names(db, [p.portal_user_id, p.owner_id])
    out.portal_user_name = names.get(p.portal_user_id) if p.portal_user_id else None
    out.owner_name = names.get(p.owner_id) if p.owner_id else None
    r = (await partner_rollups(db, [p.id])).get(p.id, {})
    out.commitment, out.funded = r.get("commitment", 0), r.get("funded", 0)
    out.unfunded, out.in_default = r.get("unfunded", 0), r.get("in_default", False)
    return out


async def _check_portal_user(db: AsyncSession, user_id: uuid.UUID | None) -> None:
    if not user_id:
        return
    from app.modules.auth.models import User

    u = await db.get(User, user_id)
    if not u or u.deleted_at:
        raise HTTPException(422, "Portal user not found")
    if getattr(u.role, "key", None) != PORTAL_ROLE:
        raise HTTPException(422, "The portal user must have the Capital Partner role")


async def create_partner(db: AsyncSession, data: PartnerCreate, actor: CurrentUser) -> CapitalPartner:
    await _check_portal_user(db, data.portal_user_id)
    values = data.model_dump(exclude={"owner_id"})
    p = CapitalPartner(**values, owner_id=data.owner_id or actor.id, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(p)
    await db.flush()
    await audit.record(db, actor=actor, action="capital_partner.created", entity_type="capital_partner", entity_id=p.id,
                       summary=p.name, ip_address=actor.ip_address)
    await db.commit()
    return p


async def update_partner(db: AsyncSession, p: CapitalPartner, data: PartnerUpdate, actor: CurrentUser) -> CapitalPartner:
    values = data.model_dump(exclude_unset=True)
    if "portal_user_id" in values:
        await _check_portal_user(db, values["portal_user_id"])
    changes = audit.diff(p, values)
    if not changes:
        return p
    for k, v in values.items():
        setattr(p, k, v)
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="capital_partner.updated", entity_type="capital_partner", entity_id=p.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return p


async def archive_partner(db: AsyncSession, p: CapitalPartner, actor: CurrentUser) -> None:
    active = await db.scalar(select(func.count()).select_from(Investment).where(
        Investment.partner_id == p.id, Investment.deleted_at.is_(None), Investment.status == "active"))
    if active:
        raise HTTPException(409, "Partner has active investments; exit them before archiving")
    p.deleted_at = utcnow()
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="capital_partner.archived", entity_type="capital_partner", entity_id=p.id,
                       summary=p.name, ip_address=actor.ip_address)
    await db.commit()


# =========================================================================== investments

async def get_investment(db: AsyncSession, investment_id: uuid.UUID, user: CurrentUser) -> Investment:
    inv = await db.get(Investment, investment_id)
    ids = await scope_ids(db, user)
    if not inv or inv.deleted_at or (ids is not None and inv.partner_id not in ids):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Investment not found")
    return inv


async def investment_outs(db: AsyncSession, rows: list[Investment]) -> list[InvestmentOut]:
    labels = await asset_labels(db, [(i.asset_id, i.property_id) for i in rows])
    pnames = dict((await db.execute(select(CapitalPartner.id, CapitalPartner.name).where(
        CapitalPartner.id.in_({i.partner_id for i in rows})))).all()) if rows else {}
    wnames = dict((await db.execute(select(Waterfall.id, Waterfall.name).where(
        Waterfall.id.in_({i.waterfall_id for i in rows if i.waterfall_id})))).all()) if rows else {}
    out = []
    for i in rows:
        o = InvestmentOut.model_validate(i)
        o.partner_name = pnames.get(i.partner_id)
        o.asset_label = labels.get(i.asset_id)
        o.waterfall_name = wnames.get(i.waterfall_id) if i.waterfall_id else None
        o.unfunded = round(max(0.0, float(i.commitment or 0) - float(i.funded or 0)), 2)
        out.append(o)
    return out


async def list_investments(db: AsyncSession, user: CurrentUser, partner_id: uuid.UUID | None = None,
                           asset_id: uuid.UUID | None = None) -> list[Investment]:
    stmt = select(Investment).where(Investment.deleted_at.is_(None))
    stmt = scoped(stmt, Investment.partner_id, await scope_ids(db, user))
    if partner_id:
        stmt = stmt.where(Investment.partner_id == partner_id)
    if asset_id:
        stmt = stmt.where(Investment.asset_id == asset_id)
    return list(await db.scalars(stmt.order_by(Investment.created_at)))


async def create_investment(db: AsyncSession, data: InvestmentCreate, actor: CurrentUser) -> Investment:
    await get_partner(db, data.partner_id, actor)
    row = await asset_row(db, data.asset_id)
    if _table("assets") is not None and row is None:
        raise HTTPException(422, "Asset not found")
    dupe = await db.scalar(select(Investment.id).where(
        Investment.partner_id == data.partner_id, Investment.asset_id == data.asset_id, Investment.deleted_at.is_(None)))
    if dupe:
        raise HTTPException(409, "This partner already has an investment in this asset")
    values = data.model_dump(exclude={"provenance", "property_id"})
    property_id = data.property_id or (row or {}).get("property_id")
    inv = Investment(**values, property_id=property_id, funded=0, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(inv)
    await db.flush()
    for field in INVESTMENT_MATERIAL:
        value = getattr(inv, field)
        if value is not None:
            await provenance.observe(db, entity_type="investment", entity_id=inv.id, field=field, value=value,
                                     prov=data.provenance, actor_id=actor.id)
    await audit.record(db, actor=actor, action="investment.created", entity_type="investment", entity_id=inv.id,
                       summary=f"Commitment {inv.commitment:,.2f} · {inv.ownership_pct}%",
                       changes={"partner_id": {"from": None, "to": str(inv.partner_id)}}, ip_address=actor.ip_address)
    await db.commit()
    return inv


async def update_investment(db: AsyncSession, inv: Investment, data: InvestmentUpdate, actor: CurrentUser) -> Investment:
    values = data.model_dump(exclude_unset=True, exclude={"provenance"})
    changes = await provenance.apply_material(db, inv, entity_type="investment", data=values,
                                              material_fields=INVESTMENT_MATERIAL, prov=data.provenance,
                                              actor_id=actor.id)
    if not changes:
        return inv
    inv.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="investment.updated", entity_type="investment", entity_id=inv.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return inv


async def refresh_funded(db: AsyncSession, investment_ids: set[uuid.UUID]) -> None:
    """Investment.funded mirrors the posted contribution ledger (never edited directly)."""
    for inv_id in investment_ids:
        total = await db.scalar(select(func.coalesce(func.sum(CapitalAccountEntry.amount), 0)).where(
            CapitalAccountEntry.investment_id == inv_id, CapitalAccountEntry.entry_type == "contribution"))
        inv = await db.get(Investment, inv_id)
        if inv:
            inv.funded = round(float(total or 0), 2)


# =========================================================================== capital accounts

async def entries_for(db: AsyncSession, investment_ids: list[uuid.UUID], as_of: date | None = None) -> list[CapitalAccountEntry]:
    if not investment_ids:
        return []
    stmt = select(CapitalAccountEntry).where(CapitalAccountEntry.investment_id.in_(investment_ids))
    if as_of:
        stmt = stmt.where(CapitalAccountEntry.effective_on <= as_of)
    return list(await db.scalars(stmt.order_by(CapitalAccountEntry.effective_on, CapitalAccountEntry.created_at)))


def summarize_account(inv: Investment, entries: list[CapitalAccountEntry], as_of: date) -> dict:
    """Capital account roll-forward for one investment from immutable ledger entries.

    ending_balance = contributions + allocated income − allocated loss − distributions
    unreturned capital / accrued pref come from waterfall.pref_accrual (day-count accrual).
    """
    contributions = distributions = roc = pref_paid = profit = income = loss = 0.0
    flows: list[wf.Flow] = []
    for e in entries:
        if e.effective_on > as_of:
            continue
        a = float(e.amount or 0)
        if e.entry_type == "contribution":
            contributions += a
            flows.append(wf.Flow(e.effective_on, "contribution", a))
        elif e.entry_type == "distribution":
            distributions += a
            if e.component == "return_of_capital":
                roc += a
                flows.append(wf.Flow(e.effective_on, "return_of_capital", a))
            elif e.component == "preferred_return":
                pref_paid += a
                flows.append(wf.Flow(e.effective_on, "pref_paid", a))
            else:
                profit += a
        elif e.entry_type == "income_allocation":
            income += a
        elif e.entry_type == "loss_allocation":
            loss += a
    acc = wf.pref_accrual(flows, float(inv.pref_rate or 0) / 100.0, as_of, inv.day_count or "act_365",
                          inv.pref_compounding or "simple")
    commitment = float(inv.commitment or 0)
    r = wf.round2
    return {
        "investment_id": inv.id, "partner_id": inv.partner_id, "asset_id": inv.asset_id,
        "position": inv.waterfall_position, "ownership_pct": float(inv.ownership_pct or 0),
        "commitment": r(commitment), "contributions": r(contributions), "distributions": r(distributions),
        "return_of_capital": r(roc), "preferred_paid": r(pref_paid), "profit_distributions": r(profit),
        "income_allocated": r(income), "loss_allocated": r(loss),
        "unreturned_capital": r(acc["unreturned_capital"]), "accrued_pref": r(acc["unpaid"]),
        "pref_accrued_total": r(acc["accrued_total"]), "unfunded": r(max(0.0, commitment - contributions)),
        "ending_balance": r(contributions + income - loss - distributions),
    }


TOTAL_KEYS = ["commitment", "contributions", "distributions", "return_of_capital", "preferred_paid",
              "profit_distributions", "income_allocated", "loss_allocated", "unreturned_capital", "accrued_pref",
              "unfunded", "ending_balance"]


async def account_summaries(db: AsyncSession, invs: list[Investment], as_of: date) -> tuple[list[AccountSummary], dict]:
    entries = await entries_for(db, [i.id for i in invs], as_of)
    grouped: dict[uuid.UUID, list[CapitalAccountEntry]] = defaultdict(list)
    for e in entries:
        grouped[e.investment_id].append(e)
    labels = await asset_labels(db, [(i.asset_id, i.property_id) for i in invs])
    accounts = []
    for inv in invs:
        s = summarize_account(inv, grouped.get(inv.id, []), as_of)
        accounts.append(AccountSummary(**s, asset_label=labels.get(inv.asset_id)))
    totals = {k: wf.round2(sum(getattr(a, k) for a in accounts)) for k in TOTAL_KEYS}
    return accounts, totals


async def entry_outs(db: AsyncSession, entries: list[CapitalAccountEntry]) -> list[EntryOut]:
    ids = [e.id for e in entries]
    reversed_ids = set(await db.scalars(select(CapitalAccountEntry.reverses_entry_id).where(
        CapitalAccountEntry.reverses_entry_id.in_(ids)))) if ids else set()
    out = []
    for e in entries:
        o = EntryOut.model_validate(e)
        o.reversed = e.id in reversed_ids
        out.append(o)
    return out


async def statement(db: AsyncSession, p: CapitalPartner, as_of: date) -> StatementOut:
    invs = list(await db.scalars(select(Investment).where(Investment.partner_id == p.id, Investment.deleted_at.is_(None))))
    accounts, totals = await account_summaries(db, invs, as_of)
    entries = await entries_for(db, [i.id for i in invs], as_of)
    return StatementOut(partner_id=p.id, as_of=as_of, accounts=accounts, totals=totals,
                        entries=await entry_outs(db, entries))


async def reverse_entry(db: AsyncSession, entry_id: uuid.UUID, reason: str, actor: CurrentUser) -> CapitalAccountEntry:
    e = await db.get(CapitalAccountEntry, entry_id)
    if not e:
        raise HTTPException(404, "Entry not found")
    if e.reverses_entry_id:
        raise HTTPException(409, "A reversing entry cannot itself be reversed; post a new entry instead")
    if await db.scalar(select(CapitalAccountEntry.id).where(CapitalAccountEntry.reverses_entry_id == e.id)):
        raise HTTPException(409, "Entry has already been reversed")
    rev = _reversal(e, reason, actor)
    db.add(rev)
    if e.entry_type == "contribution" and e.allocation_id:
        alloc = await db.get(CapitalEventAllocation, e.allocation_id)
        if alloc:
            alloc.funded_amount = wf.round2(float(alloc.funded_amount or 0) - float(e.amount or 0))
            alloc.status = _call_status(alloc)
    await db.flush()
    await refresh_funded(db, {e.investment_id})
    await audit.record(db, actor=actor, action="capital_entry.reversed", entity_type="capital_partner",
                       entity_id=e.partner_id, summary=f"Reversed {e.entry_type} {float(e.amount):,.2f}: {reason}",
                       changes={"entry_id": {"from": None, "to": str(e.id)}}, ip_address=actor.ip_address)
    await db.commit()
    return rev


def _reversal(e: CapitalAccountEntry, reason: str, actor: CurrentUser) -> CapitalAccountEntry:
    return CapitalAccountEntry(
        partner_id=e.partner_id, investment_id=e.investment_id, asset_id=e.asset_id, event_id=e.event_id,
        allocation_id=e.allocation_id, entry_type=e.entry_type, component=e.component,
        amount=-float(e.amount or 0), effective_on=max(e.effective_on, date.today()),
        memo=f"Reversal: {reason}", reverses_entry_id=e.id, created_by_id=actor.id,
    )


async def allocate_income(db: AsyncSession, asset_id: uuid.UUID, data: IncomeAllocationIn, actor: CurrentUser) -> int:
    """Allocates period net income (or loss when negative) pro rata to ownership across active investments."""
    invs = list(await db.scalars(select(Investment).where(
        Investment.asset_id == asset_id, Investment.deleted_at.is_(None), Investment.status == "active")))
    if not invs:
        raise HTTPException(422, "No active investments on this asset")
    if not data.amount:
        raise HTTPException(422, "Amount must not be zero")
    kind = "income_allocation" if data.amount > 0 else "loss_allocation"
    shares = wf.split_pro_rata(abs(data.amount), {str(i.id): float(i.ownership_pct or 0) for i in invs})
    for inv in invs:
        db.add(CapitalAccountEntry(
            partner_id=inv.partner_id, investment_id=inv.id, asset_id=asset_id, entry_type=kind,
            amount=shares[str(inv.id)], effective_on=data.effective_on, memo=data.memo, created_by_id=actor.id,
        ))
    await audit.record(db, actor=actor, action=f"capital_account.{kind}", entity_type="asset", entity_id=asset_id,
                       summary=f"{kind.replace('_', ' ').title()} {abs(data.amount):,.2f} as of {data.effective_on}",
                       ip_address=actor.ip_address)
    await db.commit()
    return len(invs)


# =========================================================================== waterfalls

async def get_waterfall(db: AsyncSession, waterfall_id: uuid.UUID) -> Waterfall:
    w = await db.get(Waterfall, waterfall_id)
    if not w or w.deleted_at:
        raise HTTPException(404, "Waterfall not found")
    return w


async def tiers_of(db: AsyncSession, waterfall_id: uuid.UUID) -> list[WaterfallTier]:
    return list(await db.scalars(select(WaterfallTier).where(WaterfallTier.waterfall_id == waterfall_id)
                                 .order_by(WaterfallTier.position)))


async def waterfall_out(db: AsyncSession, w: Waterfall) -> WaterfallOut:
    out = WaterfallOut.model_validate(w)
    out.tiers = [TierOut.model_validate(t) for t in await tiers_of(db, w.id)]
    if w.asset_id:
        out.asset_label = (await asset_labels(db, [(w.asset_id, None)])).get(w.asset_id)
    return out


def _validate_tiers(data: WaterfallIn) -> None:
    positions = [t.position for t in data.tiers]
    if len(set(positions)) != len(positions):
        raise HTTPException(422, "Tier positions must be unique")
    for t in data.tiers:
        if t.tier_type == "split" and abs(t.lp_share + t.gp_share - 1.0) > 1e-6:
            raise HTTPException(422, f"Tier {t.position}: LP and GP shares must sum to 100%")
        if t.tier_type == "split" and t.hurdle_type != "none" and t.hurdle_value is None:
            raise HTTPException(422, f"Tier {t.position}: hurdle value is required")
        if t.tier_type == "catch_up" and t.catch_up_rate <= t.catch_up_target:
            raise HTTPException(422, f"Tier {t.position}: catch-up rate must exceed the GP target share")


def _tier_dict(t) -> dict:
    return {k: getattr(t, k) for k in ["position", "name", "tier_type", "hurdle_type", "hurdle_value", "lp_share",
                                       "gp_share", "catch_up_rate", "catch_up_target"]}


async def save_waterfall(db: AsyncSession, w: Waterfall | None, data: WaterfallIn, actor: CurrentUser) -> Waterfall:
    _validate_tiers(data)
    header = data.model_dump(exclude={"tiers"})
    new_tiers = [t.model_dump() for t in sorted(data.tiers, key=lambda t: t.position)]
    if w is None:
        w = Waterfall(**header, version=1, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(w)
        await db.flush()
        changes = {"tiers": {"from": None, "to": new_tiers}}
        action = "waterfall.created"
    else:
        old_tiers = [_tier_dict(t) for t in await tiers_of(db, w.id)]
        changes = audit.diff(w, header)
        for k, v in header.items():
            setattr(w, k, v)
        if old_tiers != new_tiers:
            changes["tiers"] = {"from": old_tiers, "to": new_tiers}
            changes["version"] = {"from": w.version, "to": w.version + 1}
            w.version += 1
            for t in await tiers_of(db, w.id):
                await db.delete(t)
        if not changes:
            return w
        w.updated_by_id = actor.id
        action = "waterfall.updated"
    if "tiers" in changes:
        for t in new_tiers:
            db.add(WaterfallTier(waterfall_id=w.id, **t))
    await audit.record(db, actor=actor, action=action, entity_type="waterfall", entity_id=w.id, summary=w.name,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return w


# =========================================================================== capital events: calculation

async def positions_for(db: AsyncSession, asset_id: uuid.UUID, as_of: date) -> tuple[list[Investment], list[wf.PartnerPosition]]:
    invs = list(await db.scalars(select(Investment).where(
        Investment.asset_id == asset_id, Investment.deleted_at.is_(None), Investment.status == "active")
        .order_by(Investment.created_at)))
    if not invs:
        return [], []
    names = dict((await db.execute(select(CapitalPartner.id, CapitalPartner.name).where(
        CapitalPartner.id.in_({i.partner_id for i in invs})))).all())
    grouped: dict[uuid.UUID, list[CapitalAccountEntry]] = defaultdict(list)
    for e in await entries_for(db, [i.id for i in invs], as_of):
        grouped[e.investment_id].append(e)
    positions = []
    for inv in invs:
        es = grouped.get(inv.id, [])
        s = summarize_account(inv, es, as_of)
        flows = [(e.effective_on, -float(e.amount) if e.entry_type == "contribution" else float(e.amount))
                 for e in es if e.entry_type in ("contribution", "distribution")]
        positions.append(wf.PartnerPosition(
            investment_id=str(inv.id), partner_id=str(inv.partner_id), name=names.get(inv.partner_id, "Partner"),
            position=inv.waterfall_position or "lp", ownership_pct=float(inv.ownership_pct or 0),
            commitment=s["commitment"], contributed=s["contributions"], unfunded=s["unfunded"],
            unreturned_capital=s["unreturned_capital"], pref_unpaid=s["accrued_pref"],
            distributed_to_date=s["distributions"], profit_to_date=s["preferred_paid"] + s["profit_distributions"],
            cash_flows=flows,
        ))
    return invs, positions


async def resolve_waterfall(db: AsyncSession, asset_id: uuid.UUID, waterfall_id: uuid.UUID | None,
                            invs: list[Investment]) -> Waterfall | None:
    if waterfall_id:
        return await get_waterfall(db, waterfall_id)
    linked = Counter(i.waterfall_id for i in invs if i.waterfall_id)
    if linked:
        return await get_waterfall(db, linked.most_common(1)[0][0])
    return await db.scalar(select(Waterfall).where(
        Waterfall.asset_id == asset_id, Waterfall.is_active.is_(True), Waterfall.deleted_at.is_(None))
        .order_by(Waterfall.updated_at.desc()).limit(1))


def event_amount(event_type: str, amount: float | None, inputs: dict) -> float:
    """Liquidation: net proceeds = gross − debt payoff − closing costs − reserves (when gross is given)."""
    if event_type == "liquidation" and inputs.get("gross_proceeds") is not None:
        net = float(inputs["gross_proceeds"]) - sum(float(inputs.get(k) or 0) for k in
                                                    ("debt_payoff", "closing_costs", "reserves"))
        if net < 0:
            raise HTTPException(422, "Net liquidation proceeds are negative")
        return wf.round2(net)
    if amount is None or amount <= 0:
        raise HTTPException(422, "Amount is required")
    return wf.round2(amount)


async def compute(db: AsyncSession, data: EventPreviewIn) -> tuple[float, dict, Waterfall | None]:
    inputs = data.inputs.model_dump(exclude_none=True)
    amount = event_amount(data.event_type, data.amount, inputs)
    invs, positions = await positions_for(db, data.asset_id, data.event_date)
    if not positions:
        raise HTTPException(422, "No active investments on this asset")
    w = None
    tiers_cfg: list[dict] = []
    if data.event_type == "call":
        result = wf.allocate_call(amount, positions)
    else:
        w = await resolve_waterfall(db, data.asset_id, data.waterfall_id, invs)
        if not w:
            raise HTTPException(422, "No waterfall is configured for this asset")
        tiers_cfg = [_tier_dict(t) for t in await tiers_of(db, w.id)]
        tiers = [wf.Tier(
            position=t["position"], tier_type=t["tier_type"], name=t["name"] or "", hurdle_type=t["hurdle_type"],
            # IRR hurdles are stored in percent; multiples as x.
            hurdle_value=(t["hurdle_value"] / 100.0 if t["hurdle_type"] == "irr" and t["hurdle_value"] is not None
                          else t["hurdle_value"]),
            lp_share=t["lp_share"], gp_share=t["gp_share"], catch_up_rate=t["catch_up_rate"],
            catch_up_target=t["catch_up_target"],
        ) for t in tiers_cfg]
        result = wf.run_waterfall(amount, data.event_date, positions, tiers)
    calc = {
        **result,
        "engine": "investors.waterfall/1",
        "event_type": data.event_type,
        "event_date": data.event_date.isoformat(),
        "inputs": inputs,
        "waterfall": {"id": str(w.id), "name": w.name, "version": w.version, "tiers": tiers_cfg} if w else None,
        "positions": [{
            "investment_id": p.investment_id, "partner_id": p.partner_id, "name": p.name, "position": p.position,
            "ownership_pct": p.ownership_pct, "commitment": p.commitment, "contributed": p.contributed,
            "unfunded": p.unfunded, "unreturned_capital": p.unreturned_capital, "pref_unpaid": p.pref_unpaid,
            "distributed_to_date": p.distributed_to_date,
        } for p in positions],
        "computed_at": utcnow().isoformat(),
    }
    return amount, audit.to_jsonable(calc), w


def _fingerprint(calc: dict) -> list:
    return sorted((a["investment_id"], a["amount"]) for a in calc.get("allocations", []))


# =========================================================================== capital events: lifecycle

@dataclass
class EventFilters:
    q: str | None = None
    event_type: list[str] | None = None
    status: list[str] | None = None
    asset_id: uuid.UUID | None = None


def build_event_query(f: EventFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(CapitalEvent).where(CapitalEvent.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [CapitalEvent.name])
    if "event_type" not in skip:
        stmt = in_filter(stmt, CapitalEvent.event_type, f.event_type)
    if "status" not in skip:
        stmt = in_filter(stmt, CapitalEvent.status, f.status)
    if f.asset_id:
        stmt = stmt.where(CapitalEvent.asset_id == f.asset_id)
    return stmt


async def get_event(db: AsyncSession, event_id: uuid.UUID) -> CapitalEvent:
    e = await db.get(CapitalEvent, event_id)
    if not e or e.deleted_at:
        raise HTTPException(404, "Capital event not found")
    return e


async def event_out(db: AsyncSession, e: CapitalEvent, user: CurrentUser) -> EventOut:
    out = EventOut.model_validate(e)
    out.asset_label = (await asset_labels(db, [(e.asset_id, e.property_id)])).get(e.asset_id)
    names = await user_names(db, [e.created_by_id, e.submitted_by_id, e.approved_by_id, e.posted_by_id, e.reversed_by_id])
    out.actor_names = {str(k): v for k, v in names.items()}
    out.can_approve = user.can("investors", "approve") and (
        user.is_admin or e.submitted_by_id != user.id) and e.status == "pending_approval"
    return out


async def _save_version(db: AsyncSession, e: CapitalEvent, actor: CurrentUser) -> None:
    db.add(CapitalEventVersion(event_id=e.id, version=e.version, amount=e.amount, inputs=e.inputs, calc=e.calc,
                               created_by_id=actor.id))


async def create_event(db: AsyncSession, data: EventCreate, actor: CurrentUser) -> CapitalEvent:
    amount, calc, w = await compute(db, data)
    labels = await asset_labels(db, [(data.asset_id, None)])
    name = data.name or f"{data.event_type.title()} · {labels.get(data.asset_id)} · {data.event_date.isoformat()}"
    row = await asset_row(db, data.asset_id)
    e = CapitalEvent(
        event_type=data.event_type, name=name[:200], asset_id=data.asset_id,
        property_id=(row or {}).get("property_id"), waterfall_id=w.id if w else None,
        waterfall_version=w.version if w else None, event_date=data.event_date,
        due_on=data.due_on or (data.event_date + timedelta(days=10) if data.event_type == "call" else None),
        amount=amount, inputs=data.inputs.model_dump(exclude_none=True), status="draft", version=1, calc=calc,
        notes=data.notes, created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(e)
    await db.flush()
    await _save_version(db, e, actor)
    await audit.record(db, actor=actor, action="capital_event.created", entity_type="capital_event", entity_id=e.id,
                       summary=f"{e.name} — {amount:,.2f} (calc v1)", ip_address=actor.ip_address)
    await db.commit()
    return e


async def recalculate(db: AsyncSession, e: CapitalEvent, data: EventUpdate | None, actor: CurrentUser) -> CapitalEvent:
    if e.status not in ("draft", "rejected"):
        raise HTTPException(409, "Only draft or rejected events can be changed; approved calculations are locked")
    values = data.model_dump(exclude_unset=True) if data else {}
    inputs = values.get("inputs") if values.get("inputs") is not None else e.inputs
    preview = EventPreviewIn(
        event_type=e.event_type, asset_id=e.asset_id, amount=values.get("amount", e.amount),
        event_date=values.get("event_date", e.event_date), due_on=values.get("due_on", e.due_on),
        waterfall_id=values.get("waterfall_id", e.waterfall_id), inputs=inputs or {},
    )
    amount, calc, w = await compute(db, preview)
    before = {"amount": e.amount, "version": e.version, "event_date": e.event_date, "due_on": e.due_on}
    e.amount, e.calc = amount, calc
    e.event_date, e.due_on = preview.event_date, preview.due_on
    e.inputs = preview.inputs.model_dump(exclude_none=True)
    e.waterfall_id, e.waterfall_version = (w.id, w.version) if w else (None, None)
    if "name" in values and values["name"]:
        e.name = values["name"]
    if "notes" in values:
        e.notes = values["notes"]
    e.version += 1
    e.status = "draft"
    e.updated_by_id = actor.id
    await _save_version(db, e, actor)
    after = {"amount": e.amount, "version": e.version, "event_date": e.event_date, "due_on": e.due_on}
    await audit.record(db, actor=actor, action="capital_event.recalculated", entity_type="capital_event",
                       entity_id=e.id, summary=f"Calculation v{e.version}",
                       changes={k: {"from": audit.to_jsonable(before[k]), "to": audit.to_jsonable(after[k])}
                                for k in before if before[k] != after[k]}, ip_address=actor.ip_address)
    await db.commit()
    return e


async def _assert_current(db: AsyncSession, e: CapitalEvent) -> None:
    """The stored calc must still match the ledger + config; otherwise it must be recalculated and re-approved."""
    preview = EventPreviewIn(event_type=e.event_type, asset_id=e.asset_id, amount=e.amount, event_date=e.event_date,
                             due_on=e.due_on, waterfall_id=e.waterfall_id, inputs=e.inputs or {})
    _, calc, w = await compute(db, preview)
    if _fingerprint(calc) != _fingerprint(e.calc or {}) or (w and w.version != e.waterfall_version):
        raise HTTPException(409, "Capital accounts or the waterfall changed since this calculation. "
                                 "Return it to draft, recalculate and route it for approval again.")


async def submit_event(db: AsyncSession, e: CapitalEvent, actor: CurrentUser) -> CapitalEvent:
    if e.status not in ("draft", "rejected"):
        raise HTTPException(409, "Only draft events can be submitted")
    e.status, e.submitted_by_id, e.submitted_at, e.updated_by_id = "pending_approval", actor.id, utcnow(), actor.id
    await audit.record(db, actor=actor, action="capital_event.submitted", entity_type="capital_event", entity_id=e.id,
                       summary=f"Submitted calc v{e.version} for approval", ip_address=actor.ip_address)
    await db.commit()
    return e


async def decide_event(db: AsyncSession, e: CapitalEvent, approve: bool, note: str | None, actor: CurrentUser) -> CapitalEvent:
    if e.status != "pending_approval":
        raise HTTPException(409, "Event is not awaiting approval")
    if approve:
        if e.submitted_by_id == actor.id and not actor.is_admin:
            raise HTTPException(403, "A different person must approve a capital event they submitted")
        check_capital_limit(actor, float(e.amount))
        await _assert_current(db, e)
        e.status, e.approved_by_id, e.approved_at, e.approved_version = "approved", actor.id, utcnow(), e.version
    else:
        e.status = "rejected"
    e.decision_note = note
    e.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"capital_event.{'approved' if approve else 'rejected'}",
                       entity_type="capital_event", entity_id=e.id,
                       summary=f"Calc v{e.version}{': ' + note if note else ''}", ip_address=actor.ip_address)
    await db.commit()
    return e


def render_call_notice(e: CapitalEvent, a: dict, asset_label: str) -> str:
    inp = e.inputs or {}
    lines = [
        "CAPITAL CALL NOTICE",
        "",
        f"Notice date: {e.event_date:%B %d, %Y}",
        f"To: {a['name']}",
        f"Investment: {asset_label}",
        "",
        "Pursuant to the governing agreement, a capital contribution is requested as follows:",
        f"  Total capital call:                 ${float(e.amount):,.2f}",
        f"  Your capital commitment:            ${float(a.get('commitment') or 0):,.2f}",
        f"  Your ownership:                     {float(a.get('ownership_pct') or 0):.4g}%",
        f"  Unfunded commitment before call:    ${float(a.get('unfunded_before') or 0):,.2f}",
        f"  Amount due from you:                ${float(a['amount']):,.2f}",
        f"  Due date:                           {e.due_on:%B %d, %Y}" if e.due_on else "",
    ]
    if inp.get("purpose"):
        lines += ["", f"Purpose: {inp['purpose']}"]
    if inp.get("wire_instructions"):
        lines += ["", "Wire instructions:", str(inp["wire_instructions"])]
    rate, grace, penalty = inp.get("default_rate"), inp.get("grace_days", DEFAULT_GRACE_DAYS), inp.get("penalty_pct")
    terms = []
    if rate:
        terms.append(f"amounts not received by the due date accrue interest at {rate}% per annum")
    terms.append(f"amounts outstanding more than {grace} days after the due date may be treated as a default "
                 "under the default provisions of the agreement")
    if penalty:
        terms.append(f"a defaulting partner may be subject to a penalty of {penalty}% of the unfunded amount")
    lines += ["", "Late payment: " + "; ".join(terms) + ".", "", f"Reference: {e.name}"]
    return "\n".join(x for x in lines if x is not None)


async def post_event(db: AsyncSession, e: CapitalEvent, actor: CurrentUser) -> CapitalEvent:
    if e.status != "approved":
        raise HTTPException(409, "Only approved events can be posted")
    if e.approved_version != e.version:
        raise HTTPException(409, "The approved calculation version is not the current version")
    await _assert_current(db, e)
    label = (await asset_labels(db, [(e.asset_id, e.property_id)])).get(e.asset_id) or ""
    touched: set[uuid.UUID] = set()
    for a in (e.calc or {}).get("allocations", []):
        amount = float(a["amount"])
        if amount <= 0:
            continue
        inv_id, partner_id = uuid.UUID(a["investment_id"]), uuid.UUID(a["partner_id"])
        alloc = CapitalEventAllocation(
            event_id=e.id, partner_id=partner_id, investment_id=inv_id, event_type=e.event_type, amount=amount,
            tiers=a.get("tiers", []), due_on=e.due_on, created_by_id=actor.id, updated_by_id=actor.id,
            status="pending" if e.event_type == "call" else "paid",
            paid_on=None if e.event_type == "call" else e.event_date,
        )
        if e.event_type == "call":
            alloc.notice_text = render_call_notice(e, a, label)
        db.add(alloc)
        await db.flush()
        if e.event_type != "call":
            for t in a.get("tiers", []):
                if float(t["amount"]) == 0:
                    continue
                db.add(CapitalAccountEntry(
                    partner_id=partner_id, investment_id=inv_id, asset_id=e.asset_id, event_id=e.id,
                    allocation_id=alloc.id, entry_type="distribution", component=t.get("component"),
                    amount=float(t["amount"]), effective_on=e.event_date,
                    memo=f"{e.name} — {t.get('name')}", created_by_id=actor.id,
                ))
        touched.add(inv_id)
    if e.event_type == "liquidation":
        exit_prov = provenance.ProvenanceIn(source=f"Liquidation {e.name}", observed_on=e.event_date, confidence=1,
                                            verified=True)
        for inv_id in touched:
            inv = await db.get(Investment, inv_id)
            if inv and inv.status != "exited":
                await provenance.apply_material(db, inv, entity_type="investment", data={"status": "exited"},
                                                material_fields=INVESTMENT_MATERIAL, prov=exit_prov, actor_id=actor.id)
    if e.event_type == "call" and e.due_on:
        from app.modules.tasks.service import create_task

        await create_task(db, title=f"Confirm funding: {e.name}", assignee_id=e.created_by_id or actor.id,
                          due_at=datetime.combine(e.due_on, time(17, 0), tzinfo=timezone.utc), task_type="follow_up", description="Confirm receipt of each partner's capital call.",
                          related_type="capital_event", related_id=e.id, related_label=e.name, source="automation",
                          idempotency_key=f"capital_call_funding:{e.id}", actor_id=actor.id)
    e.status, e.posted_by_id, e.posted_at, e.updated_by_id = "posted", actor.id, utcnow(), actor.id
    await audit.record(db, actor=actor, action="capital_event.posted", entity_type="capital_event", entity_id=e.id,
                       summary=f"Posted calc v{e.version} — {float(e.amount):,.2f}", ip_address=actor.ip_address)
    await events.emit(db, "capital_event.posted", capital_event_id=e.id, asset_id=e.asset_id,
                      event_type=e.event_type, actor=actor)
    await db.commit()
    return e


async def reverse_event(db: AsyncSession, e: CapitalEvent, reason: str, actor: CurrentUser) -> CapitalEvent:
    if e.status != "posted":
        raise HTTPException(409, "Only posted events can be reversed")
    entries = list(await db.scalars(select(CapitalAccountEntry).where(
        CapitalAccountEntry.event_id == e.id, CapitalAccountEntry.reverses_entry_id.is_(None))))
    already = set(await db.scalars(select(CapitalAccountEntry.reverses_entry_id).where(
        CapitalAccountEntry.reverses_entry_id.in_([x.id for x in entries])))) if entries else set()
    touched = set()
    for x in entries:
        if x.id not in already:
            db.add(_reversal(x, reason, actor))
            touched.add(x.investment_id)
    for alloc in await db.scalars(select(CapitalEventAllocation).where(CapitalEventAllocation.event_id == e.id)):
        alloc.status = "reversed"
        alloc.updated_by_id = actor.id
    await db.flush()
    await refresh_funded(db, touched)
    e.status, e.reversed_by_id, e.reversed_at, e.reversal_reason = "reversed", actor.id, utcnow(), reason
    e.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="capital_event.reversed", entity_type="capital_event", entity_id=e.id,
                       summary=reason, ip_address=actor.ip_address)
    await db.commit()
    return e


# =========================================================================== calls: funding & defaults

def _call_status(a: CapitalEventAllocation, as_of: date | None = None, grace: int = DEFAULT_GRACE_DAYS) -> str:
    funded, amount = float(a.funded_amount or 0), float(a.amount or 0)
    if funded >= amount - 0.005:
        return "funded"
    as_of = as_of or date.today()
    if a.due_on and as_of > a.due_on:
        return "default" if (as_of - a.due_on).days > grace or a.default_flag else "late"
    return "partial" if funded > 0 else "pending"


async def allocation_outs(db: AsyncSession, rows: list[CapitalEventAllocation], as_of: date | None = None) -> list[AllocationOut]:
    as_of = as_of or date.today()
    ev_ids = {r.event_id for r in rows}
    evs = {e.id: e for e in await db.scalars(select(CapitalEvent).where(CapitalEvent.id.in_(ev_ids)))} if rows else {}
    pnames = dict((await db.execute(select(CapitalPartner.id, CapitalPartner.name).where(
        CapitalPartner.id.in_({r.partner_id for r in rows})))).all()) if rows else {}
    labels = await asset_labels(db, [(e.asset_id, e.property_id) for e in evs.values()])
    out = []
    for r in rows:
        o = AllocationOut.model_validate(r)
        ev = evs.get(r.event_id)
        o.partner_name = pnames.get(r.partner_id)
        if ev:
            o.event_name, o.event_date, o.asset_label = ev.name, ev.event_date, labels.get(ev.asset_id)
        if r.event_type == "call" and r.status in ("pending", "partial", "late", "default") and r.due_on and as_of > r.due_on:
            rate = float((ev.inputs or {}).get("default_rate") or 0) / 100.0 if ev else 0.0
            o.days_late = (as_of - r.due_on).days
            o.accrued_late_interest = wf.late_interest(float(r.amount) - float(r.funded_amount or 0), rate, r.due_on, as_of)
        out.append(o)
    return out


async def get_allocation(db: AsyncSession, alloc_id: uuid.UUID, user: CurrentUser) -> CapitalEventAllocation:
    a = await db.get(CapitalEventAllocation, alloc_id)
    ids = await scope_ids(db, user)
    if not a or a.deleted_at or (ids is not None and a.partner_id not in ids):
        raise HTTPException(404, "Allocation not found")
    return a


async def fund_call(db: AsyncSession, a: CapitalEventAllocation, data: FundIn, actor: CurrentUser) -> CapitalEventAllocation:
    if a.event_type != "call" or a.status == "reversed":
        raise HTTPException(409, "Only open capital call items can be funded")
    outstanding = wf.round2(float(a.amount) - float(a.funded_amount or 0))
    if data.amount > outstanding + 0.005:
        raise HTTPException(422, f"Amount exceeds the outstanding call balance of {outstanding:,.2f}")
    e = await get_event(db, a.event_id)
    db.add(CapitalAccountEntry(
        partner_id=a.partner_id, investment_id=a.investment_id, asset_id=e.asset_id, event_id=e.id, allocation_id=a.id,
        entry_type="contribution", amount=data.amount, effective_on=data.funded_on,
        memo=f"{e.name}{' — ref ' + data.reference if data.reference else ''}", created_by_id=actor.id,
    ))
    before = {"funded_amount": a.funded_amount, "status": a.status}
    a.funded_amount = wf.round2(float(a.funded_amount or 0) + data.amount)
    a.funded_on = data.funded_on
    if data.reference:
        a.payment_reference = data.reference
    grace = int((e.inputs or {}).get("grace_days", DEFAULT_GRACE_DAYS))
    if a.due_on and data.funded_on > a.due_on:
        rate = float((e.inputs or {}).get("default_rate") or 0) / 100.0
        a.late_interest = wf.round2(float(a.late_interest or 0) + wf.late_interest(data.amount, rate, a.due_on, data.funded_on))
        if (data.funded_on - a.due_on).days > grace and (e.inputs or {}).get("penalty_pct"):
            a.penalty_flag = True
    a.status = _call_status(a, data.funded_on, grace)
    a.updated_by_id = actor.id
    await db.flush()
    await refresh_funded(db, {a.investment_id})
    await audit.record(db, actor=actor, action="capital_call.funded", entity_type="capital_event", entity_id=e.id,
                       summary=f"Funding {data.amount:,.2f} received on {data.funded_on}",
                       changes={k: {"from": audit.to_jsonable(v), "to": audit.to_jsonable(getattr(a, k))} for k, v in before.items()},
                       ip_address=actor.ip_address)
    await db.commit()
    return a


async def mark_default(db: AsyncSession, a: CapitalEventAllocation, default_flag: bool, penalty_flag: bool | None,
                       note: str | None, actor: CurrentUser) -> CapitalEventAllocation:
    if a.event_type != "call" or a.status in ("funded", "reversed"):
        raise HTTPException(409, "Only unfunded capital call items can be placed in or out of default")
    before = {"default_flag": a.default_flag, "penalty_flag": a.penalty_flag, "status": a.status}
    a.default_flag = default_flag
    if penalty_flag is not None:
        a.penalty_flag = penalty_flag
    a.status = "default" if default_flag else _call_status(a, grace=10_000)
    a.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="capital_call.default_updated", entity_type="capital_event",
                       entity_id=a.event_id, summary=note,
                       changes={k: {"from": v, "to": getattr(a, k)} for k, v in before.items() if v != getattr(a, k)},
                       ip_address=actor.ip_address)
    await db.commit()
    return a


async def run_defaults(db: AsyncSession, as_of: date) -> dict:
    """Default provisions sweep: accrues late interest and flags late/default call items; raises alerts."""
    from app.modules.tasks.service import raise_alert

    rows = list(await db.scalars(select(CapitalEventAllocation).where(
        CapitalEventAllocation.event_type == "call", CapitalEventAllocation.deleted_at.is_(None),
        CapitalEventAllocation.status.in_(["pending", "partial", "late"]), CapitalEventAllocation.due_on < as_of)))
    late = defaulted = 0
    for a in rows:
        e = await db.get(CapitalEvent, a.event_id)
        if not e or e.status != "posted":
            continue
        inputs = e.inputs or {}
        grace = int(inputs.get("grace_days", DEFAULT_GRACE_DAYS))
        shortfall = float(a.amount) - float(a.funded_amount or 0)
        a.late_interest = wf.late_interest(shortfall, float(inputs.get("default_rate") or 0) / 100.0, a.due_on, as_of)
        new_status = _call_status(a, as_of, grace)
        if new_status == "default":
            a.default_flag = True
            a.penalty_flag = bool(inputs.get("penalty_pct"))
            defaulted += 1
        elif new_status == "late":
            late += 1
        if new_status != a.status:
            a.status = new_status
            partner = await db.get(CapitalPartner, a.partner_id)
            await raise_alert(
                db, title=f"Capital call {new_status}: {partner.name if partner else 'partner'}",
                reason=f"{shortfall:,.2f} outstanding on {e.name}, due {a.due_on}.",
                severity="high" if new_status == "default" else "medium",
                owner_id=(partner.owner_id if partner else None) or e.created_by_id,
                related_type="capital_event", related_id=e.id, related_label=e.name, rule_key="capital_call_default",
                idempotency_key=f"capital_call:{a.id}:{new_status}",
            )
    await db.commit()
    return {"checked": len(rows), "late": late, "default": defaulted}


# =========================================================================== reporting packages

def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    for day in (d.day, 30, 29, 28):
        try:
            return date(year, month, day)
        except ValueError:
            continue
    return date(year, month, 28)


FREQ_MONTHS = {"monthly": 1, "quarterly": 3, "annual": 12}


async def _verified_property_facts(db: AsyncSession, property_id: uuid.UUID | None, excluded: list) -> dict:
    if not property_id:
        return {}
    facts = {}
    for field, obs in (await provenance.current_observations(db, "property", property_id)).items():
        if field not in {"occupancy_pct", "building_area_sf", "noi", "wale_years", "land_area_acres"}:
            continue
        if obs.verification == "verified":
            facts[field] = {"value": obs.value, "source": obs.source, "observed_on": audit.to_jsonable(obs.observed_on)}
        else:
            excluded.append({"section": "property_performance", "item": field, "property_id": str(property_id),
                             "reason": f"{obs.verification} fact omitted"})
    return facts


async def _performance(db: AsyncSession, invs: list[Investment], start: date, end: date, labels: dict, excluded: list) -> list[dict]:
    fin = _table("asset_financials")
    out = []
    for inv in invs:
        entry = {"asset_id": str(inv.asset_id), "asset": labels.get(inv.asset_id),
                 "facts": await _verified_property_facts(db, inv.property_id, excluded)}
        if fin is None:
            excluded.append({"section": "property_performance", "item": "asset_financials",
                             "reason": "asset financials unavailable"})
        else:
            verified_col = fin.c.verified if "verified" in fin.c else None
            stmt = select(fin.c.category, fin.c.source, fin.c.amount,
                          verified_col if verified_col is not None else fin.c.source).where(
                fin.c.asset_id == inv.asset_id, fin.c.period >= start, fin.c.period <= end)
            if "is_current" in fin.c:
                stmt = stmt.where(fin.c.is_current.is_(True))
            if "deleted_at" in fin.c:
                stmt = stmt.where(fin.c.deleted_at.is_(None))
            totals: dict[str, float] = defaultdict(float)
            skipped = 0
            for cat, src, amt, ver in (await db.execute(stmt)).all():
                # Only verified actuals: unverified rows and plan/estimate sources are left out.
                if (verified_col is not None and ver is not True) or (src and str(src).lower() in UNVERIFIED_SOURCES):
                    skipped += 1
                    continue
                totals[str(cat)] += float(amt or 0)
            if skipped:
                excluded.append({"section": "property_performance", "item": "asset_financials",
                                 "asset_id": str(inv.asset_id), "reason": f"{skipped} unverified or non-actual rows omitted"})
            income, expense = totals.get("income", 0.0), totals.get("expense", 0.0)
            entry["financials"] = {**{k: wf.round2(v) for k, v in totals.items()}, "noi": wf.round2(income - expense)}
        out.append(entry)
    return out


async def _valuations(db: AsyncSession, invs: list[Investment], labels: dict, excluded: list) -> list[dict]:
    try:
        from app.modules.comps.service import latest_value
    except ImportError:
        excluded.append({"section": "valuation", "item": "all", "reason": "valuation module unavailable"})
        return []
    out = []
    for inv in invs:
        v = await latest_value(db, inv.property_id) if inv.property_id else None
        if not v or v.get("value_point") is None:
            excluded.append({"section": "valuation", "item": labels.get(inv.asset_id), "asset_id": str(inv.asset_id),
                             "reason": "no approved valuation on record"})
            continue
        out.append({"asset_id": str(inv.asset_id), "asset": labels.get(inv.asset_id), **audit.to_jsonable(v),
                    "ownership_pct": inv.ownership_pct,
                    "gross_value_share": wf.round2(float(v["value_point"]) * float(inv.ownership_pct or 0) / 100.0)})
    return out


async def build_package(db: AsyncSession, partner: CapitalPartner, asset_id: uuid.UUID | None, start: date, end: date,
                        types: list[str], title: str | None, actor: CurrentUser | None,
                        schedule_id: uuid.UUID | None = None) -> ReportPackage | None:
    stmt = select(Investment).where(Investment.partner_id == partner.id, Investment.deleted_at.is_(None))
    if asset_id:
        stmt = stmt.where(Investment.asset_id == asset_id)
    invs = list(await db.scalars(stmt))
    if not invs:
        return None
    labels = await asset_labels(db, [(i.asset_id, i.property_id) for i in invs])
    excluded: list[dict] = []
    sections: dict = {}
    if "capital_accounts" in types:
        accounts, totals = await account_summaries(db, invs, end)
        sections["capital_accounts"] = {"as_of": end.isoformat(), "accounts": [audit.to_jsonable(a.model_dump()) for a in accounts],
                                        "totals": totals}
    if "distributions" in types:
        rows = list(await db.scalars(
            select(CapitalEventAllocation).join(CapitalEvent, CapitalEvent.id == CapitalEventAllocation.event_id)
            .where(CapitalEventAllocation.partner_id == partner.id,
                   CapitalEventAllocation.investment_id.in_([i.id for i in invs]),
                   CapitalEventAllocation.event_type.in_(["distribution", "liquidation"]),
                   CapitalEventAllocation.status == "paid", CapitalEvent.status == "posted",
                   CapitalEvent.event_date >= start, CapitalEvent.event_date <= end)))
        outs = await allocation_outs(db, rows)
        sections["distributions"] = {
            "items": [{"event": o.event_name, "date": audit.to_jsonable(o.event_date), "asset": o.asset_label,
                       "type": o.event_type, "amount": o.amount, "tiers": o.tiers} for o in outs],
            "total": wf.round2(sum(o.amount for o in outs)),
        }
    if "portfolio" in types:
        items = []
        for o in await investment_outs(db, invs):
            row = await asset_row(db, o.asset_id)
            items.append({"asset": o.asset_label, "asset_status": (row or {}).get("status"), "commitment": o.commitment,
                          "funded": o.funded, "unfunded": o.unfunded, "ownership_pct": o.ownership_pct,
                          "position": o.waterfall_position, "status": o.status})
        sections["portfolio"] = {"investments": items,
                                 "totals": {k: wf.round2(sum(float(i[k] or 0) for i in items))
                                            for k in ("commitment", "funded", "unfunded")}}
    if "valuation" in types:
        sections["valuation"] = {"items": await _valuations(db, invs, labels, excluded)}
    if "property_performance" in types:
        sections["property_performance"] = {"assets": await _performance(db, invs, start, end, labels, excluded)}
    pkg = ReportPackage(
        partner_id=partner.id, asset_id=asset_id, schedule_id=schedule_id,
        title=(title or f"{partner.name} — {start:%b %d, %Y} to {end:%b %d, %Y}")[:200],
        package_types=types, period_start=start, period_end=end, status="generated",
        snapshot={"partner": {"id": str(partner.id), "name": partner.name},
                  "period": {"start": start.isoformat(), "end": end.isoformat()},
                  "generated_at": utcnow().isoformat(),
                  "data_policy": "Posted capital-account entries, approved valuations, verified property facts and "
                                 "recorded financial actuals only.",
                  "sections": audit.to_jsonable(sections)},
        excluded=excluded, generated_at=utcnow(),
        created_by_id=actor.id if actor else None, updated_by_id=actor.id if actor else None,
    )
    db.add(pkg)
    await db.flush()
    await audit.record(db, actor=actor, action="report_package.generated", entity_type="capital_partner",
                       entity_id=partner.id, summary=pkg.title, ip_address=actor.ip_address if actor else None)
    return pkg


async def generate_packages(db: AsyncSession, data: PackageCreate, actor: CurrentUser) -> list[ReportPackage]:
    if data.period_end < data.period_start:
        raise HTTPException(422, "Period end must be on or after period start")
    if data.partner_id:
        partners = [await get_partner(db, data.partner_id, actor)]
    else:
        stmt = select(CapitalPartner).where(CapitalPartner.deleted_at.is_(None), CapitalPartner.status == "active")
        if data.asset_id:
            stmt = stmt.where(CapitalPartner.id.in_(select(Investment.partner_id).where(
                Investment.asset_id == data.asset_id, Investment.deleted_at.is_(None))))
        partners = list(await db.scalars(stmt))
    out = []
    for p in partners:
        pkg = await build_package(db, p, data.asset_id, data.period_start, data.period_end, list(data.package_types),
                                  data.title, actor)
        if pkg:
            out.append(pkg)
    if not out:
        raise HTTPException(422, "No partner investments match this request")
    await db.commit()
    return out


async def issue_package(db: AsyncSession, pkg: ReportPackage, actor: CurrentUser) -> ReportPackage:
    if pkg.status == "issued":
        return pkg
    pkg.status, pkg.issued_at, pkg.issued_by_id, pkg.updated_by_id = "issued", utcnow(), actor.id, actor.id
    await audit.record(db, actor=actor, action="report_package.issued", entity_type="capital_partner",
                       entity_id=pkg.partner_id, summary=pkg.title, ip_address=actor.ip_address)
    await db.commit()
    return pkg


async def package_items(db: AsyncSession, rows: list[ReportPackage]) -> list[PackageListItem]:
    names = dict((await db.execute(select(CapitalPartner.id, CapitalPartner.name).where(
        CapitalPartner.id.in_({r.partner_id for r in rows})))).all()) if rows else {}
    out = []
    for r in rows:
        o = PackageListItem.model_validate(r)
        o.partner_name = names.get(r.partner_id)
        out.append(o)
    return out


async def save_schedule(db: AsyncSession, s: ReportSchedule | None, data: ScheduleIn | ScheduleUpdate,
                        actor: CurrentUser) -> ReportSchedule:
    values = data.model_dump(exclude_unset=s is not None)
    if s is None:
        s = ReportSchedule(**values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(s)
        await db.flush()
        changes = None
    else:
        changes = audit.diff(s, values)
        if not changes:
            return s
        for k, v in values.items():
            setattr(s, k, v)
        s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="report_schedule.saved", entity_type="report_schedule", entity_id=s.id,
                       summary=s.name, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return s


async def run_due_schedules(db: AsyncSession, as_of: date, actor: CurrentUser) -> dict:
    schedules = list(await db.scalars(select(ReportSchedule).where(
        ReportSchedule.is_active.is_(True), ReportSchedule.deleted_at.is_(None), ReportSchedule.next_run_on <= as_of)))
    generated = 0
    for s in schedules:
        months = FREQ_MONTHS.get(s.frequency, 3)
        for _ in range(12):  # catch up missed periods, bounded
            if s.next_run_on > as_of:
                break
            end = s.next_run_on - timedelta(days=1)
            start = add_months(s.next_run_on, -months)
            if s.partner_id:
                partners = [p for p in [await db.get(CapitalPartner, s.partner_id)] if p and not p.deleted_at]
            else:
                stmt = select(CapitalPartner).where(CapitalPartner.deleted_at.is_(None), CapitalPartner.status == "active")
                if s.asset_id:
                    stmt = stmt.where(CapitalPartner.id.in_(select(Investment.partner_id).where(
                        Investment.asset_id == s.asset_id, Investment.deleted_at.is_(None))))
                partners = list(await db.scalars(stmt))
            for p in partners:
                pkg = await build_package(db, p, s.asset_id, start, end, list(s.package_types), None, actor, s.id)
                if pkg:
                    generated += 1
                    if s.auto_issue:
                        pkg.status, pkg.issued_at, pkg.issued_by_id = "issued", utcnow(), actor.id
            s.next_run_on = add_months(s.next_run_on, months)
        s.last_run_at = utcnow()
    await db.commit()
    return {"schedules": len(schedules), "packages": generated}


# =========================================================================== portal

async def portal(db: AsyncSession, user: CurrentUser) -> PortalOut:
    """Everything a capital partner may see — strictly limited to partners where portal_user_id = user.id."""
    ids = await scope_ids(db, user)
    if ids is None:
        ids = list(await db.scalars(select(CapitalPartner.id).where(
            CapitalPartner.portal_user_id == user.id, CapitalPartner.deleted_at.is_(None))))
    partners = list(await db.scalars(select(CapitalPartner).where(CapitalPartner.id.in_(ids)))) if ids else []
    invs = list(await db.scalars(select(Investment).where(
        Investment.partner_id.in_(ids), Investment.deleted_at.is_(None)))) if ids else []
    accounts, totals = await account_summaries(db, invs, date.today())
    allocs = list(await db.scalars(
        select(CapitalEventAllocation).join(CapitalEvent, CapitalEvent.id == CapitalEventAllocation.event_id)
        .where(CapitalEventAllocation.partner_id.in_(ids), CapitalEventAllocation.deleted_at.is_(None),
               CapitalEvent.status == "posted")
        .order_by(CapitalEvent.event_date.desc()))) if ids else []
    outs = await allocation_outs(db, allocs)
    packages = list(await db.scalars(select(ReportPackage).where(
        ReportPackage.partner_id.in_(ids), ReportPackage.status == "issued", ReportPackage.deleted_at.is_(None))
        .order_by(ReportPackage.period_end.desc()))) if ids else []
    docs: list[dict] = []
    try:
        from app.modules.documents.models import Document, DocumentLink

        targets = ([("capital_partner", i) for i in ids] + [("investment", i.id) for i in invs]
                   + [("report_package", p.id) for p in packages] + [("capital_event_allocation", a.id) for a in allocs])
        if targets:
            conds = [(DocumentLink.entity_type == t) & (DocumentLink.entity_id == i) for t, i in targets]
            rows = await db.execute(
                select(Document.id, Document.title, Document.doc_class, Document.filename, Document.created_at,
                       DocumentLink.entity_type, DocumentLink.entity_id)
                .join(DocumentLink, DocumentLink.document_id == Document.id)
                .where(or_(*conds), Document.deleted_at.is_(None))
                .order_by(Document.created_at.desc()).limit(200))
            seen = set()
            for r in rows.all():
                if r[0] in seen:
                    continue
                seen.add(r[0])
                docs.append({"id": str(r[0]), "title": r[1], "doc_class": r[2], "filename": r[3],
                             "created_at": audit.to_jsonable(r[4]), "entity_type": r[5], "entity_id": str(r[6])})
    except ImportError:
        pass
    partner_outs = [await partner_out(db, p) for p in partners]
    for o in partner_outs:
        o.notes = None  # internal relationship notes stay internal
    return PortalOut(
        partners=partner_outs,
        investments=await investment_outs(db, invs),
        capital_accounts=accounts,
        totals=totals,
        distributions=[o for o in outs if o.event_type in ("distribution", "liquidation")],
        capital_calls=[o for o in outs if o.event_type == "call"],
        documents=docs,
        reports=await package_items(db, packages),
    )
