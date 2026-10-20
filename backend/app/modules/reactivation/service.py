"""Reactivation / dead deal intelligence (spec module 30).

When an opportunity is marked dead its structured reactivation rule becomes an armed trigger (plus a
time backstop by dead reason). Triggers are evaluated on related events and by a periodic scan. A fired
trigger creates a queue item that carries the original context (dead reason, prior price discussion, last
stage, owner) and an explanation of what changed, optionally rescoring the property and creating a task
for the opportunity owner. Users reactivate (via the pipeline stage gates), snooze or dismiss with a reason;
dismissals are counted as noise per trigger type.
"""
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import Select, and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.security import utcnow
from app.modules.reactivation.models import REVISIT_DAYS_BY_REASON, ReactivationItem, ReactivationTrigger

RULE_KEY = "reactivation.trigger_fired"
RULE_DEFAULTS: dict[str, Any] = {"task_due_days": 2, "debt_window_days": 180, "development_radius_miles": 3.0,
                                 "rescore": True, "backstop_by_dead_reason": True}
POSITIVE_DISPOSITIONS = {"connected", "callback", "information_requested", "offer_requested"}
CONVERTED_STAGES = {"offer", "under_contract", "due_diligence", "closing", "closed"}
FIELD_OPERATORS = ["lt", "lte", "gt", "gte", "eq", "neq", "changed"]
FIELD_EXCLUDE = {"id", "location", "created_at", "updated_at", "created_by_id", "updated_by_id", "deleted_at",
                 "normalized_address", "alternate_addresses", "tags", "notes"}
TYPE_LABELS = {
    "time": "Time", "debt": "Debt event", "price": "Price / listing", "ownership": "Ownership / entity",
    "lease": "Lease / tenant", "market": "Market / rate / comps", "development": "Development / infrastructure",
    "relationship": "Relationship / warm path", "manual": "Manual field / threshold",
}
MARKET_TYPES = {"cap_rate": "cap_rate_shift", "interest_rate": "interest_rate_shift", "comp_price_psf": "comp_sale_nearby"}


def _parse_date(v: Any) -> date | None:
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, str) and v:
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def _num(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def property_fields() -> list[dict[str, str]]:
    from app.modules.properties.models import Property

    out = []
    for c in Property.__table__.columns:
        if c.name in FIELD_EXCLUDE:
            continue
        try:
            py = c.type.python_type.__name__
        except NotImplementedError:
            continue
        out.append({"key": c.name, "type": "number" if py in ("int", "float", "Decimal") else
                    "date" if py == "date" else "text"})
    return out


def describe(trigger_type: str, params: dict | None) -> str:
    p = params or {}
    if trigger_type == "time":
        return f"Revisit on {p['on_date']}" if p.get("on_date") else f"Revisit after {p.get('after_days')} days"
    if trigger_type == "debt":
        return f"Debt: {str(p.get('event', 'event')).replace('_', ' ')}" + (f" (expected {p['date']})" if p.get("date") else "")
    if trigger_type == "price":
        parts = []
        if p.get("target_price"):
            parts.append(f"price at or below ${float(p['target_price']):,.0f}")
        if p.get("drop_pct"):
            parts.append(f"price drops {p['drop_pct']}%")
        if p.get("on_listing"):
            parts.append("listed for sale")
        return "Price: " + (", ".join(parts) or "change")
    if trigger_type == "ownership":
        return f"Ownership: {str(p.get('event', 'any_change')).replace('_', ' ')}"
    if trigger_type == "lease":
        return f"Lease: {str(p.get('event', 'event')).replace('_', ' ')}" + (f" (expected {p['date']})" if p.get("date") else "")
    if trigger_type == "market":
        return f"Market: {str(p.get('metric', '')).replace('_', ' ')} {p.get('direction', '')} {p.get('threshold', '')}".strip()
    if trigger_type == "manual" and p.get("field"):
        return f"Field: {p['field']} {p.get('operator', '')} {p.get('value', '')}".strip()
    return f"{TYPE_LABELS.get(trigger_type, trigger_type)}: {p.get('description') or ''}".strip(": ")


# ----------------------------------------------------------------------------- configuration


async def ensure_rule(db: AsyncSession) -> None:
    from app.modules.tasks.models import AutomationRule

    if await db.scalar(select(AutomationRule.id).where(AutomationRule.key == RULE_KEY)) is None:
        db.add(AutomationRule(
            key=RULE_KEY, name="Dead deal reactivation", event="opportunity.dead", enabled=True,
            description="Arms reactivation triggers when an opportunity dies and, when one fires, queues the deal "
                        "with its original context and creates a task for the owner.",
            thresholds=dict(RULE_DEFAULTS), run_count=0, error_count=0,
        ))
        await db.flush()


async def settings(db: AsyncSession) -> tuple[bool, dict[str, Any]]:
    from app.modules.tasks.service import rule_config

    enabled, th = await rule_config(db, RULE_KEY)
    return enabled, {**RULE_DEFAULTS, **(th or {})}


# ----------------------------------------------------------------------------- state snapshots


async def _current_owners(db: AsyncSession, property_id: uuid.UUID | None) -> list[str]:
    if not property_id:
        return []
    try:
        from app.modules.ownership.models import OwnershipInterest
    except ImportError:
        return []
    today = date.today()
    rows = (await db.execute(select(
        OwnershipInterest.owner_kind, OwnershipInterest.owner_person_id, OwnershipInterest.owner_organization_id)
        .where(OwnershipInterest.property_id == property_id, OwnershipInterest.deleted_at.is_(None),
               or_(OwnershipInterest.effective_to.is_(None), OwnershipInterest.effective_to > today)))).all()
    return sorted({f"{k}:{p or o}" for k, p, o in rows if (p or o)})


async def _baseline(db: AsyncSession, opp: Any, trigger_type: str, params: dict) -> dict:
    from app.modules.properties.models import Property

    base: dict[str, Any] = {"owners": await _current_owners(db, opp.property_id)}
    p = await db.get(Property, opp.property_id) if opp.property_id else None
    if p:
        base.update(asking_price=p.asking_price, property_status=p.status)
        field = params.get("field")
        if trigger_type == "manual" and field and hasattr(p, field):
            base["field_value"] = to_jsonable(getattr(p, field))
    if trigger_type == "debt":
        _, th = await settings(db)
        flags = await _loan_flags(db, opp.property_id, params.get("event"), date.today(), th)
        base["debt_flags"] = [c["label"] for c in flags]
    return to_jsonable(base)


def _fire_on(trigger_type: str, params: dict, armed: date, th: dict) -> date | None:
    window = int(th.get("debt_window_days", 180))
    if trigger_type == "time":
        if params.get("on_date"):
            return _parse_date(params["on_date"])
        if _num(params.get("after_days")):
            return armed + timedelta(days=int(float(params["after_days"])))
    if trigger_type in ("debt", "lease") and _parse_date(params.get("date")):
        return _parse_date(params["date"]) - timedelta(days=window)
    if trigger_type == "manual" and _parse_date(params.get("review_on")):
        return _parse_date(params["review_on"])
    return None


def _validate(trigger_type: str, params: dict) -> None:
    from app.modules.pipeline.service import rule_problems

    problems = rule_problems({"type": trigger_type, "params": params})
    if trigger_type == "manual" and params.get("field"):
        keys = {f["key"] for f in property_fields()}
        if params["field"] not in keys:
            problems.append(f"Unknown property field '{params['field']}'")
        if params.get("operator") not in FIELD_OPERATORS:
            problems.append("Choose an operator: " + ", ".join(FIELD_OPERATORS))
        if params.get("operator") != "changed" and params.get("value") in (None, ""):
            problems.append("A threshold value is required")
    if problems:
        raise HTTPException(422, "; ".join(problems))


async def _arm(db: AsyncSession, opp: Any, trigger_type: str, params: dict, *, origin: str, th: dict,
               actor=None) -> ReactivationTrigger:
    now = utcnow()
    t = ReactivationTrigger(
        opportunity_id=opp.id, property_id=opp.property_id, trigger_type=trigger_type, params=to_jsonable(params),
        origin=origin, status="armed", armed_at=now, fire_on=_fire_on(trigger_type, params, now.date(), th),
        baseline=await _baseline(db, opp, trigger_type, params), dead_reason=opp.dead_reason, check_count=0,
        created_by_id=getattr(actor, "id", None), updated_by_id=getattr(actor, "id", None),
    )
    db.add(t)
    await db.flush()
    await audit.record(db, actor=actor, action="opportunity.reactivation_armed", entity_type="opportunity",
                       entity_id=opp.id, summary=describe(trigger_type, params) + f" ({origin.replace('_', ' ')})")
    return t


async def _cancel_armed(db: AsyncSession, opportunity_id: uuid.UUID, reason: str, *, keep: uuid.UUID | None = None):
    rows = list(await db.scalars(select(ReactivationTrigger).where(
        ReactivationTrigger.opportunity_id == opportunity_id, ReactivationTrigger.status == "armed",
        ReactivationTrigger.deleted_at.is_(None))))
    for t in rows:
        if t.id != keep:
            t.status, t.cancelled_reason = "cancelled", reason


async def arm_from_opportunity(db: AsyncSession, opp: Any, actor=None) -> list[ReactivationTrigger]:
    """Arms the opportunity's reactivation rule plus a time backstop by dead reason. Does not commit."""
    await ensure_rule(db)
    enabled, th = await settings(db)
    if not enabled:
        return []
    await _cancel_armed(db, opp.id, "Re-armed at dead disposition")
    rule = opp.reactivation_rule if isinstance(opp.reactivation_rule, dict) else {}
    out = []
    rtype, params = rule.get("type"), rule.get("params") or {}
    if rtype in TYPE_LABELS:
        out.append(await _arm(db, opp, rtype, params, origin="rule", th=th, actor=actor))
    if th.get("backstop_by_dead_reason", True) and rtype != "time":
        days = REVISIT_DAYS_BY_REASON.get(opp.dead_reason or "other", 365)
        out.append(await _arm(db, opp, "time", {"after_days": days}, origin="dead_reason_backstop", th=th, actor=actor))
    return out


# ----------------------------------------------------------------------------- evaluation


async def _new_signals(db: AsyncSession, t: ReactivationTrigger, categories: set[str]) -> list[Any]:
    if not t.property_id:
        return []
    try:
        from app.modules.signals.service import property_signal_rows
    except ImportError:
        return []
    rows = await property_signal_rows(db, t.property_id, live_only=True)
    return [s for s in rows if s.category in categories and s.created_at >= t.armed_at]


def _signal_change(s: Any) -> dict:
    label = (s.title or s.signal_type.replace("_", " ")) if not s.is_sensitive else s.signal_type.replace("_", " ")
    return {"label": f"New {s.category} signal: {label} (severity {s.severity})", "from": None,
            "to": str(s.observed_on), "source": "Internal" if s.is_sensitive else s.source,
            "observed_on": str(s.observed_on), "signal_id": str(s.id)}


def _date_reached(t: ReactivationTrigger, today: date, label: str) -> list[dict]:
    if t.fire_on and today >= t.fire_on:
        return [{"label": label, "from": str(t.armed_at.date()), "to": str(t.fire_on), "source": "Reactivation rule",
                 "observed_on": str(today)}]
    return []


def _compare(actual: Any, op: str, value: Any, baseline: Any = None) -> bool:
    if op == "changed":
        return to_jsonable(actual) != baseline
    if actual is None:
        return False
    a, v = _num(actual), _num(value)
    if a is None or v is None:
        a, v = str(actual).strip().lower(), str(value).strip().lower()
    return {"lt": a < v, "lte": a <= v, "gt": a > v, "gte": a >= v, "eq": a == v, "neq": a != v}.get(op, False)


async def _eval_debt(db: AsyncSession, t: ReactivationTrigger, today: date, th: dict) -> list[dict]:
    p = t.params or {}
    event = p.get("event")
    known = set((t.baseline or {}).get("debt_flags") or [])
    # Only debt conditions that were not already known when the deal died count as "what changed".
    changes = [c for c in await _loan_flags(db, t.property_id, event, today, th) if c["label"] not in known]
    changes += [_signal_change(s) for s in await _new_signals(db, t, {"debt"} | ({"legal"} if event == "lien_or_default" else set()))]
    return changes or _date_reached(t, today, f"Expected {str(event or 'debt').replace('_', ' ')} window reached")


async def _loan_flags(db: AsyncSession, property_id: uuid.UUID | None, event: str | None, today: date,
                      th: dict) -> list[dict]:
    window = int(th.get("debt_window_days", 180))
    horizon = today + timedelta(days=window)
    changes: list[dict] = []
    try:
        from app.modules.debt.models import Loan
    except ImportError:
        Loan = None
    if Loan is not None and property_id:
        conds = [Loan.property_id == property_id]
        if hasattr(Loan, "deleted_at"):
            conds.append(Loan.deleted_at.is_(None))
        for loan in await db.scalars(select(Loan).where(*conds)):
            lender = getattr(loan, "lender_name", None) or "lender"
            maturity = getattr(loan, "maturity_on", None)
            if event in (None, "maturity") and maturity and maturity <= horizon:
                changes.append({"label": f"Loan with {lender} matures {maturity:%b %d, %Y}", "from": None,
                                "to": str(maturity), "source": "Debt module", "observed_on": str(today)})
            cap = getattr(loan, "cap_expires_on", None)
            if event == "rate_reset" and cap and cap <= horizon:
                changes.append({"label": f"Rate cap with {lender} expires {cap:%b %d, %Y}", "from": None,
                                "to": str(cap), "source": "Debt module", "observed_on": str(today)})
            if event in ("lockout_end", "defeasance_window"):
                pp = getattr(loan, "prepayment", None) or {}
                keys = ("lockout_end", "lockout_ends_on", "lockout_until") if event == "lockout_end" else \
                    ("defeasance_open", "defeasance_from", "defeasance_window_start", "open_prepayment_on")
                for k in keys:
                    d = _parse_date(pp.get(k)) if isinstance(pp, dict) else None
                    if d and d <= horizon:
                        changes.append({"label": f"{event.replace('_', ' ').capitalize()} on {d:%b %d, %Y}",
                                        "from": None, "to": str(d), "source": "Debt module", "observed_on": str(today)})
                        break
            loan_status = str(getattr(loan, "status", "") or "").lower()
            if event == "lien_or_default" and loan_status in ("default", "defaulted", "delinquent", "special_servicing"):
                changes.append({"label": f"Loan with {lender} is {loan_status.replace('_', ' ')}", "from": None,
                                "to": loan_status, "source": "Debt module", "observed_on": str(today)})
    return changes


async def evaluate(db: AsyncSession, t: ReactivationTrigger, th: dict, today: date | None = None) -> list[dict]:
    """Returns the list of changes that satisfy the trigger (empty = not fired)."""
    from app.modules.properties.models import Property

    today = today or date.today()
    p = t.params or {}
    prop = await db.get(Property, t.property_id) if t.property_id else None
    base = t.baseline or {}
    kind = t.trigger_type

    if kind == "time":
        reason = (t.dead_reason or "").replace("_", " ")
        label = "Revisit date reached" + (f" (dead reason: {reason})" if reason else "")
        return _date_reached(t, today, label)

    if kind == "debt":
        return await _eval_debt(db, t, today, th)

    if kind == "price":
        changes: list[dict] = []
        asking, before = (prop.asking_price if prop else None), _num(base.get("asking_price"))
        target, drop = _num(p.get("target_price")), _num(p.get("drop_pct"))
        if asking is not None and target is not None and asking <= target:
            changes.append({"label": f"Asking price ${asking:,.0f} is at or below target ${target:,.0f}",
                            "from": before, "to": asking, "source": "Property record", "observed_on": str(today)})
        if asking is not None and before and drop and asking <= before * (1 - drop / 100):
            changes.append({"label": f"Asking price dropped {100 * (before - asking) / before:.1f}% "
                                     f"(${before:,.0f} → ${asking:,.0f})",
                            "from": before, "to": asking, "source": "Property record", "observed_on": str(today)})
        if p.get("on_listing"):
            if prop and prop.status == "listed" and base.get("property_status") != "listed":
                changes.append({"label": "Property is now listed for sale", "from": base.get("property_status"),
                                "to": "listed", "source": "Property record", "observed_on": str(today)})
            changes += [_signal_change(s) for s in await _new_signals(db, t, {"behavioral"})
                        if s.signal_type in ("listed_for_sale", "price_reduction")]
        return changes

    if kind == "ownership":
        event = p.get("event") or "any_change"
        now_owners, was = set(await _current_owners(db, t.property_id)), set(base.get("owners") or [])
        changes = []
        changed = now_owners != was
        sale = bool(was) and bool(now_owners) and not (now_owners & was)
        if (event == "any_change" and changed) or (event == "sale" and sale) or \
                (event == "entity_change" and changed and not sale):
            changes.append({"label": "Ownership changed" + (" (sold to a new owner)" if sale else ""),
                            "from": sorted(was), "to": sorted(now_owners), "source": "Ownership records",
                            "observed_on": str(today)})
        sig = await _new_signals(db, t, {"ownership", "legal"} if event == "estate_or_succession" else {"ownership"})
        if event == "estate_or_succession":
            sig = [s for s in sig if s.signal_type in ("probate_estate", "owner_age_succession") or s.category == "ownership"]
        changes += [_signal_change(s) for s in sig]
        return changes

    if kind == "lease":
        changes = [_signal_change(s) for s in await _new_signals(db, t, {"tenancy"})]
        return changes or _date_reached(t, today, f"Expected lease {str(p.get('event', 'event')).replace('_', ' ')} window reached")

    if kind == "market":
        metric, direction, threshold = p.get("metric"), p.get("direction"), _num(p.get("threshold"))
        changes = []
        for s in await _new_signals(db, t, {"market"}):
            details = s.details or {}
            value = _num(details.get("value"))
            if value is not None and threshold is not None and (details.get("metric") in (None, metric)):
                if (direction == "above" and value > threshold) or (direction == "below" and value < threshold):
                    ch = _signal_change(s)
                    ch["label"] = f"{str(metric).replace('_', ' ').capitalize()} {value:g} is {direction} {threshold:g}"
                    changes.append(ch)
            elif s.signal_type == MARKET_TYPES.get(metric):
                changes.append(_signal_change(s))
        return changes

    if kind == "development":
        changes = [_signal_change(s) for s in await _new_signals(db, t, {"development"})]
        if prop and prop.latitude is not None and prop.longitude is not None:
            try:
                from geoalchemy2 import Geography
                from geoalchemy2.elements import WKTElement
                from sqlalchemy import cast

                from app.modules.territories.models import GrowthRecord

                point = cast(WKTElement(f"POINT({prop.longitude} {prop.latitude})", srid=4326), Geography)
                radius = float(th.get("development_radius_miles", 3.0)) * 1609.344
                for g in await db.scalars(select(GrowthRecord).where(
                        GrowthRecord.deleted_at.is_(None), GrowthRecord.created_at >= t.armed_at,
                        GrowthRecord.location.is_not(None),
                        func.ST_DWithin(cast(GrowthRecord.location, Geography), point, radius)).limit(10)):
                    changes.append({"label": f"New {g.kind} nearby: {g.name}", "from": None,
                                    "to": str(g.event_date) if g.event_date else None, "source": g.source,
                                    "observed_on": str(g.observed_on or today)})
            except ImportError:
                pass
        return changes

    if kind == "relationship":
        return await _eval_relationship(db, t)

    if kind == "manual":
        changes = []
        field, op = p.get("field"), p.get("operator")
        if prop and field and op and hasattr(prop, field):
            actual = getattr(prop, field)
            if _compare(actual, op, p.get("value"), base.get("field_value")):
                label = f"{field.replace('_', ' ').capitalize()} is now {to_jsonable(actual)}"
                label += " (changed)" if op == "changed" else f" ({op} {p.get('value')})"
                changes.append({"label": label, "from": base.get("field_value"), "to": to_jsonable(actual),
                                "source": "Property record", "observed_on": str(today)})
        return changes or _date_reached(t, today, f"Manual review date reached: {p.get('description') or ''}".strip(": "))
    return []


async def _eval_relationship(db: AsyncSession, t: ReactivationTrigger) -> list[dict]:
    try:
        from app.modules.outreach.models import Interaction
        from app.modules.pipeline.models import Opportunity
    except ImportError:
        return []
    opp = await db.get(Opportunity, t.opportunity_id)
    conds = [Interaction.opportunity_id == t.opportunity_id]
    if t.property_id:
        conds.append(Interaction.property_id == t.property_id)
    if opp is not None and opp.primary_person_id:
        conds.append(Interaction.person_id == opp.primary_person_id)
    if opp is not None and opp.primary_organization_id:
        conds.append(Interaction.organization_id == opp.primary_organization_id)
    for owner in (t.baseline or {}).get("owners") or []:
        kind, _, oid = owner.partition(":")
        try:
            ouid = uuid.UUID(oid)
        except ValueError:
            continue
        conds.append(Interaction.person_id == ouid if kind == "person" else Interaction.organization_id == ouid)
    rows = list(await db.scalars(select(Interaction).where(
        Interaction.deleted_at.is_(None), Interaction.occurred_at >= t.armed_at, or_(*conds),
        or_(Interaction.disposition.in_(POSITIVE_DISPOSITIONS),
            and_(Interaction.direction == "inbound", Interaction.is_meaningful.is_(True))))
        .order_by(Interaction.occurred_at.desc()).limit(5)))
    return [{"label": f"{'Inbound' if i.direction == 'inbound' else 'Positive'} {i.channel}"
                      + (f" ({i.disposition.replace('_', ' ')})" if i.disposition else "")
                      + (f": {i.summary[:140]}" if i.summary else ""),
             "from": None, "to": i.disposition, "source": "Outreach log", "observed_on": str(i.occurred_at.date()),
             "interaction_id": str(i.id)} for i in rows]


# ----------------------------------------------------------------------------- firing


async def original_context(db: AsyncSession, opp: Any, t: ReactivationTrigger | None = None) -> dict:
    from app.modules.auth.models import User
    from app.modules.pipeline.models import OpportunityEvent
    from app.modules.properties.models import Property

    last_stage = await db.scalar(select(OpportunityEvent.from_stage).where(
        OpportunityEvent.opportunity_id == opp.id, OpportunityEvent.to_stage == "dead")
        .order_by(OpportunityEvent.at.desc()).limit(1))
    owner_name = await db.scalar(select(User.full_name).where(User.id == opp.owner_id)) if opp.owner_id else None
    p = await db.get(Property, opp.property_id) if opp.property_id else None
    ctx: dict[str, Any] = {
        "title": opp.title, "dead_reason": opp.dead_reason, "dead_notes": opp.dead_notes, "dead_at": opp.dead_at,
        "last_stage": last_stage, "price_gap": opp.price_gap, "price_expectation": opp.price_expectation,
        "offer_price": opp.offer_price, "estimated_value": opp.estimated_value, "owner_id": opp.owner_id,
        "owner_name": owner_name, "property_label": (p.name or p.address_line) if p else None,
        "asking_price_at_dead": (t.baseline or {}).get("asking_price") if t else None,
        "asking_price_now": p.asking_price if p else None,
        "reactivation_rule": opp.reactivation_rule,
    }
    try:
        from app.modules.contacts.models import Organization, Person

        if opp.primary_person_id:
            ctx["primary_person"] = await db.scalar(select(Person.full_name).where(Person.id == opp.primary_person_id))
        if opp.primary_organization_id:
            ctx["primary_organization"] = await db.scalar(
                select(Organization.name).where(Organization.id == opp.primary_organization_id))
    except ImportError:
        pass
    return to_jsonable(ctx)


async def fire(db: AsyncSession, t: ReactivationTrigger, changes: list[dict], th: dict, actor=None) -> ReactivationItem | None:
    from app.modules.pipeline.models import Opportunity
    from app.modules.tasks.service import create_task, record_rule_run

    opp = await db.get(Opportunity, t.opportunity_id)
    if not opp or opp.deleted_at or opp.stage != "dead":
        t.status, t.cancelled_reason = "cancelled", "Opportunity is no longer dead"
        return None
    now = utcnow()
    t.status, t.fired_at = "fired", now
    await _cancel_armed(db, opp.id, f"Superseded by fired {t.trigger_type} trigger", keep=t.id)
    score_before = score_after = None
    try:
        from app.modules.scoring.service import current_score, rescore_property

        if opp.property_id:
            cur = await current_score(db, opp.property_id)
            score_before = cur.score if cur else None
            if th.get("rescore", True):
                row = await rescore_property(db, opp.property_id, actor, trigger="reactivation")
                score_after = row.score if row else None
    except ImportError:
        pass
    what = "; ".join(c["label"] for c in changes)
    item = ReactivationItem(
        opportunity_id=opp.id, property_id=opp.property_id, trigger_id=t.id, trigger_type=t.trigger_type,
        owner_id=opp.owner_id, status="pending", fired_at=now, what_changed=what[:4000], changes=to_jsonable(changes),
        original_context=await original_context(db, opp, t), score_before=score_before, score_after=score_after,
        created_by_id=getattr(actor, "id", None), updated_by_id=getattr(actor, "id", None),
    )
    db.add(item)
    await db.flush()
    reason = (opp.dead_reason or "unspecified").replace("_", " ")
    task = await create_task(
        db, title=f"Review reactivation: {opp.title}",
        description=f"Trigger: {describe(t.trigger_type, t.params)}.\nWhat changed: {what}\n"
                    f"Originally dead: {reason}" + (f" (price gap ${float(opp.price_gap):,.0f})" if opp.price_gap else ""),
        assignee_id=opp.owner_id, due_at=now + timedelta(days=int(th.get("task_due_days", 2))), task_type="follow_up",
        priority="high", related_type="opportunity", related_id=opp.id, related_label=opp.title,
        source="reactivation", idempotency_key=f"reactivation:{item.id}", actor_id=getattr(actor, "id", None),
    )
    item.task_id = task.id
    await audit.record(db, actor=actor, action="opportunity.reactivation_triggered", entity_type="opportunity",
                       entity_id=opp.id, summary=what[:500], changes={"trigger": t.trigger_type, "item_id": str(item.id)})
    await record_rule_run(db, RULE_KEY)
    await events.emit(db, "reactivation.fired", item_id=item.id, opportunity_id=opp.id, property_id=opp.property_id,
                      trigger_type=t.trigger_type, actor=actor)
    return item


async def check_triggers(db: AsyncSession, triggers: list[ReactivationTrigger], actor=None) -> list[ReactivationItem]:
    """Evaluates armed triggers and fires the satisfied ones (first one per opportunity). Does not commit."""
    if not triggers:
        return []
    await ensure_rule(db)
    enabled, th = await settings(db)
    if not enabled:
        return []
    fired: list[ReactivationItem] = []
    done: set[uuid.UUID] = set()
    now = utcnow()
    for t in triggers:
        if t.status != "armed" or t.opportunity_id in done:
            continue
        t.last_checked_at, t.check_count = now, (t.check_count or 0) + 1
        changes = await evaluate(db, t, th)
        if changes:
            item = await fire(db, t, changes, th, actor)
            done.add(t.opportunity_id)
            if item:
                fired.append(item)
    return fired


def _armed_query() -> Select:
    return select(ReactivationTrigger).where(ReactivationTrigger.status == "armed",
                                             ReactivationTrigger.deleted_at.is_(None))


async def check_property(db: AsyncSession, property_id: uuid.UUID | None, *, types: set[str] | None = None,
                         actor=None) -> list[ReactivationItem]:
    if not property_id:
        return []
    stmt = _armed_query().where(ReactivationTrigger.property_id == property_id)
    if types:
        stmt = stmt.where(ReactivationTrigger.trigger_type.in_(types))
    return await check_triggers(db, list(await db.scalars(stmt)), actor)


async def check_opportunities(db: AsyncSession, opportunity_ids: list[uuid.UUID], *, types: set[str] | None = None,
                              actor=None) -> list[ReactivationItem]:
    if not opportunity_ids:
        return []
    stmt = _armed_query().where(ReactivationTrigger.opportunity_id.in_(opportunity_ids))
    if types:
        stmt = stmt.where(ReactivationTrigger.trigger_type.in_(types))
    return await check_triggers(db, list(await db.scalars(stmt)), actor)


async def scan(db: AsyncSession, actor) -> dict:
    """Periodic scan of every armed trigger plus waking snoozed items whose date has arrived."""
    from app.modules.tasks.service import record_rule_run

    today = date.today()
    woken = list(await db.scalars(select(ReactivationItem).where(
        ReactivationItem.status == "snoozed", ReactivationItem.snoozed_until <= today,
        ReactivationItem.deleted_at.is_(None))))
    for item in woken:
        item.status, item.updated_by_id = "pending", actor.id
        await audit.record(db, actor=actor, action="reactivation_item.woken", entity_type="reactivation_item",
                           entity_id=item.id, summary=f"Snooze ended {item.snoozed_until}")
    triggers = list(await db.scalars(_armed_query().order_by(ReactivationTrigger.armed_at).limit(5000)))
    try:
        fired = await check_triggers(db, triggers, actor)
        await audit.record(db, actor=actor, action="reactivation.scanned", entity_type="reactivation",
                           summary=f"{len(triggers)} triggers checked, {len(fired)} fired, {len(woken)} woken",
                           ip_address=actor.ip_address)
        await db.commit()
    except Exception as exc:  # observable failure on the automation registry, then re-raised
        await db.rollback()
        await db.refresh(actor.user)
        await record_rule_run(db, RULE_KEY, error=f"{type(exc).__name__}: {exc}")
        await db.commit()
        raise
    return {"checked": len(triggers), "fired": len(fired), "woken": len(woken), "items": [i.id for i in fired]}


# ----------------------------------------------------------------------------- queue


def effective_status_expr():
    return case((and_(ReactivationItem.status == "snoozed", ReactivationItem.snoozed_until <= func.current_date()),
                 "pending"), else_=ReactivationItem.status)


def item_query(*, q: str | None = None, status_: list[str] | None = None, trigger_type: list[str] | None = None,
               owner_id: list[str] | None = None, opportunity_id: uuid.UUID | None = None,
               property_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
               skip: set[str] = frozenset()) -> Select:
    from app.modules.pipeline.models import Opportunity

    eff = effective_status_expr()
    stmt = (select(ReactivationItem, eff.label("effective_status"))
            .join(Opportunity, Opportunity.id == ReactivationItem.opportunity_id)
            .where(ReactivationItem.deleted_at.is_(None)))
    stmt = apply_search(stmt, q, [Opportunity.title, ReactivationItem.what_changed])
    if "status" not in skip and status_:
        stmt = stmt.where(eff.in_(status_))
    if "trigger_type" not in skip:
        stmt = in_filter(stmt, ReactivationItem.trigger_type, trigger_type)
    if "owner_id" not in skip and owner_id:
        ids = []
        for o in owner_id:
            if o == "me" and actor_id:
                ids.append(actor_id)
            else:
                try:
                    ids.append(uuid.UUID(o))
                except ValueError:
                    continue
        if ids:
            stmt = stmt.where(ReactivationItem.owner_id.in_(ids))
    if opportunity_id:
        stmt = stmt.where(ReactivationItem.opportunity_id == opportunity_id)
    if property_id:
        stmt = stmt.where(ReactivationItem.property_id == property_id)
    return stmt


async def item_outs(db: AsyncSession, rows: list[ReactivationItem]) -> list:
    from app.modules.auth.models import User
    from app.modules.pipeline.models import Opportunity
    from app.modules.reactivation.schemas import ItemOut

    if not rows:
        return []
    opps = {o.id: o for o in await db.scalars(select(Opportunity).where(
        Opportunity.id.in_({r.opportunity_id for r in rows})))}
    trig_ids = {r.trigger_id for r in rows if r.trigger_id}
    trigs = {t.id: t for t in await db.scalars(select(ReactivationTrigger).where(ReactivationTrigger.id.in_(trig_ids)))} \
        if trig_ids else {}
    owner_ids = {r.owner_id for r in rows if r.owner_id}
    names = dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(owner_ids)))).all()) \
        if owner_ids else {}
    today = date.today()
    out = []
    for r in rows:
        o = ItemOut.model_validate(r)
        opp = opps.get(r.opportunity_id)
        if opp:
            o.opportunity_title, o.opportunity_stage = opp.title, opp.stage
        o.property_label = (r.original_context or {}).get("property_label")
        t = trigs.get(r.trigger_id)
        o.trigger_description = describe(t.trigger_type, t.params) if t else None
        o.owner_name = names.get(r.owner_id)
        o.effective_status = "pending" if r.status == "snoozed" and r.snoozed_until and r.snoozed_until <= today \
            else r.status
        out.append(o)
    return out


async def trigger_outs(db: AsyncSession, rows: list[ReactivationTrigger]) -> list:
    from app.modules.pipeline.models import Opportunity
    from app.modules.properties.models import Property
    from app.modules.reactivation.schemas import TriggerOut

    if not rows:
        return []
    titles = dict((await db.execute(select(Opportunity.id, Opportunity.title).where(
        Opportunity.id.in_({r.opportunity_id for r in rows})))).all())
    pids = {r.property_id for r in rows if r.property_id}
    props = {i: n or a for i, n, a in (await db.execute(select(Property.id, Property.name, Property.address_line)
                                                         .where(Property.id.in_(pids)))).all()} if pids else {}
    out = []
    for r in rows:
        o = TriggerOut.model_validate(r)
        o.opportunity_title = titles.get(r.opportunity_id)
        o.property_label = props.get(r.property_id)
        o.description = describe(r.trigger_type, r.params)
        out.append(o)
    return out


async def get_item(db: AsyncSession, item_id: uuid.UUID) -> ReactivationItem:
    item = await db.get(ReactivationItem, item_id)
    if not item or item.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reactivation item not found")
    return item


async def get_trigger(db: AsyncSession, trigger_id: uuid.UUID) -> ReactivationTrigger:
    t = await db.get(ReactivationTrigger, trigger_id)
    if not t or t.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trigger not found")
    return t


def _open(item: ReactivationItem) -> None:
    if item.status not in ("pending", "snoozed"):
        raise HTTPException(409, f"This item was already {item.status}")


async def reactivate(db: AsyncSession, item: ReactivationItem, to_stage: str, override_reason: str | None,
                     note: str | None, fields: dict, actor) -> ReactivationItem:
    from app.modules.pipeline.models import ACTIVE_STAGES
    from app.modules.pipeline.schemas import MoveIn, OpportunityUpdate
    from app.modules.pipeline.service import get as get_opportunity
    from app.modules.pipeline.service import move

    _open(item)
    if not actor.can("pipeline", "edit"):
        raise HTTPException(403, "Reactivating an opportunity requires pipeline:edit")
    if to_stage not in [*ACTIVE_STAGES, "nurture"]:
        raise HTTPException(422, "Choose an active pipeline stage or nurture")
    opp = await get_opportunity(db, item.opportunity_id)
    if opp.stage != "dead":
        raise HTTPException(409, f"The opportunity is already in {opp.stage.replace('_', ' ')}")
    now = utcnow()
    item.status, item.decided_by_id, item.decided_at = "reactivated", actor.id, now
    item.reactivated_to_stage, item.decision_reason, item.updated_by_id = to_stage, (note or "").strip() or None, actor.id
    await _cancel_armed(db, opp.id, "Opportunity reactivated")
    await audit.record(db, actor=actor, action="reactivation_item.reactivated", entity_type="reactivation_item",
                       entity_id=item.id, summary=f"→ {to_stage.replace('_', ' ')}", ip_address=actor.ip_address,
                       changes={"note": item.decision_reason} if item.decision_reason else None)
    await audit.record(db, actor=actor, action="opportunity.reactivated", entity_type="opportunity", entity_id=opp.id,
                       summary=f"Reactivated to {to_stage.replace('_', ' ')} — {item.what_changed[:300]}",
                       ip_address=actor.ip_address)
    try:
        body = MoveIn(to_stage=to_stage, fields=OpportunityUpdate(**fields), override_reason=override_reason)
    except ValidationError as exc:
        raise HTTPException(422, f"Invalid opportunity fields: {exc.errors()[0].get('msg', 'invalid value')}")
    # Stage gates apply; an override needs a reason and pipeline:approve. move() commits everything above.
    await move(db, opp, body, actor)
    return item


async def snooze(db: AsyncSession, item: ReactivationItem, until: date, reason: str | None, actor) -> ReactivationItem:
    _open(item)
    if until <= date.today():
        raise HTTPException(422, "Snooze until a future date")
    before = item.snoozed_until
    item.status, item.snoozed_until, item.updated_by_id = "snoozed", until, actor.id
    item.decision_reason = (reason or "").strip() or item.decision_reason
    await audit.record(db, actor=actor, action="reactivation_item.snoozed", entity_type="reactivation_item",
                       entity_id=item.id, summary=f"Until {until:%b %d, %Y}" + (f": {reason}" if reason else ""),
                       changes={"snoozed_until": {"from": to_jsonable(before), "to": str(until)}},
                       ip_address=actor.ip_address)
    await db.commit()
    return item


async def dismiss(db: AsyncSession, item: ReactivationItem, reason: str, rearm: bool, actor) -> ReactivationItem:
    from app.modules.pipeline.models import Opportunity

    _open(item)
    now = utcnow()
    item.status, item.decided_by_id, item.decided_at = "dismissed", actor.id, now
    item.decision_reason, item.updated_by_id = reason.strip(), actor.id
    await audit.record(db, actor=actor, action="reactivation_item.dismissed", entity_type="reactivation_item",
                       entity_id=item.id, summary=reason.strip(), ip_address=actor.ip_address)
    opp = await db.get(Opportunity, item.opportunity_id)
    trig = await db.get(ReactivationTrigger, item.trigger_id) if item.trigger_id else None
    if rearm and opp and opp.stage == "dead" and trig:
        params = await _rearm_params(db, trig, opp)
        if params is not None:
            _, th = await settings(db)
            await _arm(db, opp, trig.trigger_type, params, origin="rearm", th=th, actor=actor)
    await db.commit()
    return item


async def _rearm_params(db: AsyncSession, trig: ReactivationTrigger, opp: Any) -> dict | None:
    """Same watch again from now; dates already passed are dropped so the trigger does not fire immediately."""
    params = dict(trig.params or {})
    today = date.today()
    if trig.trigger_type == "time":
        days = _num(params.get("after_days")) or REVISIT_DAYS_BY_REASON.get(opp.dead_reason or "other", 365)
        return {"after_days": int(days)}
    _, th = await settings(db)
    d = _parse_date(params.get("date"))
    if d and d - timedelta(days=int(th.get("debt_window_days", 180))) <= today:
        params.pop("date")
    d = _parse_date(params.get("review_on"))
    if d and d <= today:
        params.pop("review_on")
    if trig.trigger_type == "manual" and not params.get("field") and not params.get("review_on"):
        return None
    return params


async def update_trigger(db: AsyncSession, t: ReactivationTrigger, params: dict, actor) -> ReactivationTrigger:
    from app.modules.pipeline.models import Opportunity

    if t.status != "armed":
        raise HTTPException(409, "Only armed triggers can be edited")
    _validate(t.trigger_type, params)
    _, th = await settings(db)
    before = t.params
    t.params = to_jsonable(params)
    t.fire_on = _fire_on(t.trigger_type, params, t.armed_at.date(), th)
    opp = await db.get(Opportunity, t.opportunity_id)
    if opp is not None and t.trigger_type == "manual":
        t.baseline = await _baseline(db, opp, t.trigger_type, params)
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="reactivation_trigger.updated", entity_type="opportunity",
                       entity_id=t.opportunity_id, summary=describe(t.trigger_type, params),
                       changes={"params": {"from": before, "to": t.params}}, ip_address=actor.ip_address)
    await db.commit()
    return t


async def cancel_trigger(db: AsyncSession, t: ReactivationTrigger, reason: str, actor) -> ReactivationTrigger:
    if t.status != "armed":
        raise HTTPException(409, "Only armed triggers can be cancelled")
    t.status, t.cancelled_reason, t.updated_by_id = "cancelled", reason.strip(), actor.id
    await audit.record(db, actor=actor, action="reactivation_trigger.cancelled", entity_type="opportunity",
                       entity_id=t.opportunity_id, summary=f"{describe(t.trigger_type, t.params)}: {reason.strip()}",
                       ip_address=actor.ip_address)
    await db.commit()
    return t


async def arm_manual(db: AsyncSession, opportunity_id: uuid.UUID, trigger_type: str | None, params: dict | None,
                     actor) -> list[ReactivationTrigger]:
    from app.modules.pipeline.service import get as get_opportunity

    opp = await get_opportunity(db, opportunity_id)
    if opp.stage != "dead":
        raise HTTPException(409, "Only dead opportunities can be armed for reactivation")
    if trigger_type:
        _validate(trigger_type, params or {})
        _, th = await settings(db)
        rows = [await _arm(db, opp, trigger_type, params or {}, origin="manual", th=th, actor=actor)]
    else:
        rows = await arm_from_opportunity(db, opp, actor)
    await db.commit()
    return rows


# ----------------------------------------------------------------------------- analytics


async def analytics(db: AsyncSession, since_days: int | None = None) -> dict:
    conds = [ReactivationItem.deleted_at.is_(None)]
    if since_days:
        conds.append(ReactivationItem.fired_at >= utcnow() - timedelta(days=since_days))
    item_rows = (await db.execute(select(
        ReactivationItem.trigger_type, ReactivationItem.status, ReactivationItem.converted, func.count())
        .where(*conds).group_by(ReactivationItem.trigger_type, ReactivationItem.status, ReactivationItem.converted))).all()
    armed = dict((await db.execute(select(ReactivationTrigger.trigger_type, func.count()).where(
        ReactivationTrigger.status == "armed", ReactivationTrigger.deleted_at.is_(None))
        .group_by(ReactivationTrigger.trigger_type))).all())
    lag = dict((await db.execute(select(
        ReactivationItem.trigger_type,
        func.avg(func.extract("epoch", ReactivationItem.fired_at - ReactivationTrigger.armed_at) / 86400))
        .join(ReactivationTrigger, ReactivationTrigger.id == ReactivationItem.trigger_id)
        .where(*conds).group_by(ReactivationItem.trigger_type))).all())
    agg: dict[str, dict[str, int]] = {}
    for ttype, st, conv, n in item_rows:
        a = agg.setdefault(ttype, {"fired": 0, "pending": 0, "snoozed": 0, "reactivated": 0, "converted": 0,
                                   "dismissed": 0})
        a["fired"] += n
        if st in a:
            a[st] += n
        if conv:
            a["converted"] += n
    by_type = []
    for ttype in TYPE_LABELS:
        a = agg.get(ttype, {"fired": 0, "pending": 0, "snoozed": 0, "reactivated": 0, "converted": 0, "dismissed": 0})
        decided = a["reactivated"] + a["dismissed"]
        by_type.append({
            "trigger_type": ttype, "label": TYPE_LABELS[ttype], "armed": int(armed.get(ttype, 0)), **a,
            "noise_rate": round(a["dismissed"] / decided, 3) if decided else None,
            "reactivation_rate": round(a["reactivated"] / decided, 3) if decided else None,
            "conversion_rate": round(a["converted"] / a["reactivated"], 3) if a["reactivated"] else None,
            "avg_days_dead_to_fire": round(float(lag[ttype]), 1) if lag.get(ttype) is not None else None,
        })
    reasons = (await db.execute(select(ReactivationItem.trigger_type, ReactivationItem.decision_reason, func.count())
                                .where(*conds, ReactivationItem.status == "dismissed")
                                .group_by(ReactivationItem.trigger_type, ReactivationItem.decision_reason)
                                .order_by(func.count().desc()).limit(10))).all()
    totals = {k: sum(t[k] for t in by_type) for k in ("armed", "fired", "pending", "snoozed", "reactivated",
                                                      "converted", "dismissed")}
    return {"totals": totals, "by_type": by_type,
            "top_dismiss_reasons": [{"trigger_type": t, "reason": r, "count": int(n)} for t, r, n in reasons]}


async def mark_converted(db: AsyncSession, opportunity_id: uuid.UUID) -> None:
    now = utcnow()
    for item in await db.scalars(select(ReactivationItem).where(
            ReactivationItem.opportunity_id == opportunity_id, ReactivationItem.status == "reactivated",
            ReactivationItem.converted.is_(False))):
        item.converted, item.converted_at = True, now


async def on_left_dead(db: AsyncSession, opportunity_id: uuid.UUID, to_stage: str, actor=None) -> None:
    """Opportunity moved out of dead outside the queue: close open items and disarm triggers."""
    now = utcnow()
    await _cancel_armed(db, opportunity_id, f"Opportunity moved to {to_stage.replace('_', ' ')}")
    for item in await db.scalars(select(ReactivationItem).where(
            ReactivationItem.opportunity_id == opportunity_id, ReactivationItem.status.in_(["pending", "snoozed"]))):
        item.status, item.decided_at, item.decided_by_id = "reactivated", now, getattr(actor, "id", None)
        item.reactivated_to_stage = to_stage
        item.decision_reason = item.decision_reason or "Moved out of dead in the pipeline"
