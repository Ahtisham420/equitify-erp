"""Motivation, distress & market signals (spec module 10).

Signals are sourced, dated records linked to a property and/or an owner. Each type has a configurable
half-life; a signal's current weight decays as 0.5 ** (age / half_life). Independent signals (different
type and different source) observed within the configured window "stack" and escalate priority.
Sensitive signals stay internal: they are redacted for users without `signals:view_sensitive` and are
never included in exports or outbound payloads (see `outbound_signals`).
"""
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, case, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.provenance import ProvenanceIn
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.security import utcnow
from app.modules.signals.models import CATEGORIES, DEFAULT_TYPES, Signal, SignalSubscription, SignalType
from app.modules.signals.schemas import (
    SignalCreate,
    SignalOut,
    SignalTypeIn,
    SignalTypeUpdate,
    SignalUpdate,
    SubscriptionIn,
)

ENTITY = "signal"
RULE_KEY = "signals.stacked"
RULE_DEFAULTS: dict[str, Any] = {"window_days": 90, "min_independent": 2, "stack_bonus": 0.25, "alert_min_severity": 4}
MATERIAL = {"observed_on", "severity", "source", "confidence", "expires_on"}
# How strongly each category speaks to owner motivation (market/development mostly affect attractiveness).
MOTIVATION_WEIGHTS = {
    "debt": 1.0, "legal": 1.0, "tax": 0.9, "ownership": 0.8, "tenancy": 0.8, "behavioral": 0.9,
    "physical": 0.6, "market": 0.4, "development": 0.4,
}
ALERT_SEVERITY = {1: "low", 2: "low", 3: "medium", 4: "high", 5: "critical"}
_SEV_SCALE = ["low", "medium", "high", "critical"]


# ----------------------------------------------------------------------------- pure helpers


def decay_weight(half_life_days: int | None, observed_on: date, today: date | None = None) -> float:
    today = today or date.today()
    if not half_life_days:
        return 1.0
    age = max(0, (today - observed_on).days)
    return round(0.5 ** (age / half_life_days), 4)


def effective_status(s: Signal, today: date | None = None) -> str:
    today = today or date.today()
    if s.status == "active" and s.expires_on and s.expires_on < today:
        return "expired"
    return s.status


def is_live(s: Signal, today: date | None = None) -> bool:
    return not s.deleted_at and effective_status(s, today) == "active"


def stack_group(signals: list[Signal], window_days: int, today: date | None = None) -> list[Signal]:
    """Largest set of independent (distinct type AND distinct source) live signals inside the window."""
    today = today or date.today()
    start = today - timedelta(days=window_days)
    live = [s for s in signals if is_live(s, today) and s.observed_on >= start]
    live.sort(key=lambda s: (-s.severity, -s.observed_on.toordinal()))
    chosen: list[Signal] = []
    types: set[str] = set()
    sources: set[str] = set()
    for s in live:
        src = (s.source or "").strip().lower()
        if s.signal_type in types or src in sources:
            continue
        chosen.append(s)
        types.add(s.signal_type)
        sources.add(src)
    return chosen


def signal_priority(severity: int, stacked: bool) -> str:
    if severity >= 5 or (stacked and severity >= 4):
        return "urgent"
    if severity >= 4 or stacked:
        return "high"
    return "normal" if severity == 3 else "low"


def _bump(sev: str) -> str:
    return _SEV_SCALE[min(len(_SEV_SCALE) - 1, _SEV_SCALE.index(sev) + 1)]


def _status_case():
    return case(
        (and_(Signal.status == "active", Signal.expires_on.is_not(None), Signal.expires_on < func.current_date()),
         "expired"),
        else_=Signal.status,
    )


def status_expr():
    """Labelled effective status (active signals past their expiration read as expired)."""
    return _status_case().label("effective_status")


# ----------------------------------------------------------------------------- configuration


async def ensure_rule(db: AsyncSession):
    """Registers the stacking automation in the shared automation registry so it can be tuned/disabled."""
    from app.modules.tasks.models import AutomationRule

    rule = await db.scalar(select(AutomationRule).where(AutomationRule.key == RULE_KEY))
    if rule is None:
        rule = AutomationRule(
            key=RULE_KEY, name="Signal stacking and severe-signal alerts", event="signal.created", enabled=True,
            description="Alerts when independent signals stack on a property inside the configured window, or a "
                        "single signal reaches the alert severity. Stacking also escalates motivation.",
            thresholds=dict(RULE_DEFAULTS), run_count=0, error_count=0,
        )
        db.add(rule)
        await db.flush()
    return rule


async def settings(db: AsyncSession) -> tuple[bool, dict[str, Any]]:
    from app.modules.tasks.service import rule_config

    enabled, th = await rule_config(db, RULE_KEY)
    return enabled, {**RULE_DEFAULTS, **(th or {})}


async def save_settings(db: AsyncSession, data: dict[str, Any], actor) -> tuple[bool, dict[str, Any]]:
    rule = await ensure_rule(db)
    enabled = data.pop("enabled", None)
    th = {**RULE_DEFAULTS, **(rule.thresholds or {}), **{k: v for k, v in data.items() if v is not None}}
    changes = audit.diff(rule, {"thresholds": th, **({"enabled": enabled} if enabled is not None else {})})
    if changes:
        rule.thresholds = th
        if enabled is not None:
            rule.enabled = enabled
        rule.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="automation_rule.updated", entity_type="automation_rule",
                           entity_id=rule.id, summary=RULE_KEY, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return await settings(db)


async def ensure_types(db: AsyncSession) -> None:
    have = set(await db.scalars(select(SignalType.key)))
    added = False
    for key, label, cat, sev, half, expiry, sensitive in DEFAULT_TYPES:
        if key not in have:
            db.add(SignalType(key=key, label=label, category=cat, default_severity=sev, half_life_days=half,
                              default_expiry_days=expiry, is_sensitive=sensitive, is_active=True))
            added = True
    if added:
        await db.flush()


async def type_map(db: AsyncSession) -> dict[str, SignalType]:
    return {t.key: t for t in await db.scalars(select(SignalType).where(SignalType.deleted_at.is_(None)))}


async def list_types(db: AsyncSession) -> list[dict]:
    await ensure_types(db)
    await db.commit()
    counts = dict((await db.execute(
        select(Signal.signal_type, func.count()).where(Signal.deleted_at.is_(None)).group_by(Signal.signal_type)
    )).all())
    rows = list(await db.scalars(select(SignalType).where(SignalType.deleted_at.is_(None))
                                 .order_by(SignalType.category, SignalType.label)))
    from app.modules.signals.schemas import SignalTypeOut

    out = []
    for t in rows:
        o = SignalTypeOut.model_validate(t)
        o.signal_count = int(counts.get(t.key, 0))
        out.append(o)
    return out


async def create_type(db: AsyncSession, data: SignalTypeIn, actor) -> SignalType:
    await ensure_types(db)
    if await db.scalar(select(SignalType.id).where(SignalType.key == data.key)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Signal type '{data.key}' already exists")
    t = SignalType(**data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(t)
    await db.flush()
    await audit.record(db, actor=actor, action="signal_type.created", entity_type="signal_type", entity_id=t.id,
                       summary=t.label, ip_address=actor.ip_address)
    await db.commit()
    return t


async def update_type(db: AsyncSession, t: SignalType, data: SignalTypeUpdate, actor) -> SignalType:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(t, values)
    if not changes:
        return t
    for k, v in values.items():
        setattr(t, k, v)
    t.updated_by_id = actor.id
    if "half_life_days" in changes:
        # Decay is configured by type: keep every signal of this type on the configured half-life.
        await db.execute(update(Signal).where(Signal.signal_type == t.key).values(half_life_days=t.half_life_days))
    await audit.record(db, actor=actor, action="signal_type.updated", entity_type="signal_type", entity_id=t.id,
                       summary=t.label, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return t


# ----------------------------------------------------------------------------- owner / property linkage


async def current_owners(db: AsyncSession, property_id: uuid.UUID) -> list[tuple[str, uuid.UUID]]:
    try:
        from app.modules.ownership.models import OwnershipInterest
    except ImportError:
        return []
    today = date.today()
    rows = (await db.execute(
        select(OwnershipInterest.owner_kind, OwnershipInterest.owner_person_id, OwnershipInterest.owner_organization_id)
        .where(OwnershipInterest.property_id == property_id, OwnershipInterest.deleted_at.is_(None),
               or_(OwnershipInterest.effective_to.is_(None), OwnershipInterest.effective_to > today))
    )).all()
    out = []
    for kind, pid, oid in rows:
        if kind == "person" and pid:
            out.append(("person", pid))
        elif kind == "organization" and oid:
            out.append(("organization", oid))
    return out


async def owned_properties(db: AsyncSession, owner_kind: str, owner_id: uuid.UUID) -> list[uuid.UUID]:
    try:
        from app.modules.ownership.models import OwnershipInterest
    except ImportError:
        return []
    col = OwnershipInterest.owner_person_id if owner_kind == "person" else OwnershipInterest.owner_organization_id
    today = date.today()
    return list(await db.scalars(
        select(OwnershipInterest.property_id).where(
            col == owner_id, OwnershipInterest.deleted_at.is_(None),
            or_(OwnershipInterest.effective_to.is_(None), OwnershipInterest.effective_to > today)).distinct()
    ))


def _owner_condition(owners: list[tuple[str, uuid.UUID]]):
    people = [i for k, i in owners if k == "person"]
    orgs = [i for k, i in owners if k == "organization"]
    conds = []
    if people:
        conds.append(and_(Signal.owner_kind == "person", Signal.owner_id.in_(people)))
    if orgs:
        conds.append(and_(Signal.owner_kind == "organization", Signal.owner_id.in_(orgs)))
    return conds


async def property_signal_rows(db: AsyncSession, property_id: uuid.UUID, *, live_only: bool = False) -> list[Signal]:
    """Signals on the property plus signals on its current owners."""
    conds = [Signal.property_id == property_id, *_owner_condition(await current_owners(db, property_id))]
    stmt = select(Signal).where(Signal.deleted_at.is_(None), or_(*conds))
    if live_only:
        stmt = stmt.where(Signal.status == "active",
                          or_(Signal.expires_on.is_(None), Signal.expires_on >= date.today()))
    return list(await db.scalars(stmt.order_by(Signal.observed_on.desc())))


async def motivation_breakdown(db: AsyncSession, property_id: uuid.UUID) -> dict[str, Any]:
    _, th = await settings(db)
    window = int(th["window_days"])
    today = date.today()
    rows = await property_signal_rows(db, property_id, live_only=True)
    group = stack_group(rows, window, today)
    stacked = len(group) >= int(th["min_independent"])
    stacked_ids = {s.id for s in group} if stacked else set()
    remaining = 1.0
    contributions = []
    for s in rows:
        w = decay_weight(s.half_life_days, s.observed_on, today)
        c = (s.severity / 5) * float(s.confidence or 0) * w * MOTIVATION_WEIGHTS.get(s.category, 0.5)
        remaining *= 1 - 0.6 * c
        contributions.append({
            "signal_id": s.id, "signal_type": s.signal_type, "category": s.category, "severity": s.severity,
            "confidence": float(s.confidence or 0), "weight": w, "contribution": round(100 * 0.6 * c, 1),
            "observed_on": s.observed_on, "source": s.source if not s.is_sensitive else "Internal",
            "stacked": s.id in stacked_ids,
        })
    base = 1 - remaining
    mult = 1 + float(th["stack_bonus"]) * (len(group) - 1) if stacked else 1.0
    return {
        "property_id": property_id, "index": round(min(100.0, 100 * base * mult), 1), "base": round(100 * base, 1),
        "stack_multiplier": round(mult, 2), "stacked": stacked, "stack_count": len(group) if stacked else 0,
        "window_days": window, "active_signals": len(rows),
        "contributions": sorted(contributions, key=lambda c: -c["contribution"]),
    }


async def motivation_index(db: AsyncSession, property_id: uuid.UUID) -> float:
    """0–100 owner-motivation index from decayed, confidence-weighted and stacked live signals."""
    return float((await motivation_breakdown(db, property_id))["index"])


async def outbound_signals(db: AsyncSession, property_id: uuid.UUID) -> list[Signal]:
    """The only signals that may be used in outbound templates/exports: live and not sensitive."""
    return [s for s in await property_signal_rows(db, property_id, live_only=True) if not s.is_sensitive]


# ----------------------------------------------------------------------------- queries


@dataclass
class SignalFilters:
    q: str | None = None
    category: list[str] | None = None
    severity: list[int] | None = None
    status: list[str] | None = None
    signal_type: list[str] | None = None
    verification: list[str] | None = None
    property_id: uuid.UUID | None = None
    owner_kind: str | None = None
    owner_id: uuid.UUID | None = None
    sensitive: bool | None = None
    min_confidence: float | None = None
    observed_from: date | None = None
    observed_to: date | None = None


def build_query(f: SignalFilters, *, skip: set[str] = frozenset()) -> Select:
    from app.modules.properties.models import Property

    eff = _status_case()
    stmt = (select(Signal, eff.label("effective_status")).outerjoin(Property, Property.id == Signal.property_id)
            .where(Signal.deleted_at.is_(None)))
    stmt = apply_search(stmt, f.q, [Signal.title, Signal.source, Signal.signal_type, Property.name,
                                     Property.address_line, Property.city])
    if "category" not in skip:
        stmt = in_filter(stmt, Signal.category, f.category)
    if "severity" not in skip:
        stmt = in_filter(stmt, Signal.severity, f.severity)
    if "signal_type" not in skip:
        stmt = in_filter(stmt, Signal.signal_type, f.signal_type)
    if "status" not in skip and f.status:
        stmt = stmt.where(eff.in_(f.status))
    stmt = in_filter(stmt, Signal.verification, f.verification)
    if f.property_id:
        stmt = stmt.where(Signal.property_id == f.property_id)
    if f.owner_kind and f.owner_id:
        stmt = stmt.where(Signal.owner_kind == f.owner_kind, Signal.owner_id == f.owner_id)
    if f.sensitive is not None:
        stmt = stmt.where(Signal.is_sensitive.is_(f.sensitive))
    stmt = range_filter(stmt, Signal.confidence, f.min_confidence, None)
    return range_filter(stmt, Signal.observed_on, f.observed_from, f.observed_to)


async def get(db: AsyncSession, signal_id: uuid.UUID) -> Signal:
    s = await db.get(Signal, signal_id)
    if not s or s.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Signal not found")
    return s


async def _labels(db: AsyncSession, rows: list[Signal]) -> tuple[dict, dict]:
    from app.modules.properties.models import Property

    pids = {s.property_id for s in rows if s.property_id}
    props = {}
    if pids:
        props = {r[0]: r[1] or r[2] for r in (await db.execute(
            select(Property.id, Property.name, Property.address_line).where(Property.id.in_(pids)))).all()}
    owners: dict[uuid.UUID, str] = {}
    try:
        from app.modules.contacts.models import Organization, Person

        people = {s.owner_id for s in rows if s.owner_kind == "person" and s.owner_id}
        orgs = {s.owner_id for s in rows if s.owner_kind == "organization" and s.owner_id}
        if people:
            owners.update(dict((await db.execute(select(Person.id, Person.full_name).where(Person.id.in_(people)))).all()))
        if orgs:
            owners.update(dict((await db.execute(
                select(Organization.id, Organization.name).where(Organization.id.in_(orgs)))).all()))
    except ImportError:
        pass
    return props, owners


async def to_outs(db: AsyncSession, rows: list[Signal], actor) -> list[SignalOut]:
    if not rows:
        return []
    today = date.today()
    _, th = await settings(db)
    props, owners = await _labels(db, rows)
    types = await type_map(db)
    stacked_ids: set[uuid.UUID] = set()
    for pid in {s.property_id for s in rows if s.property_id}:
        group = stack_group(await property_signal_rows(db, pid, live_only=True), int(th["window_days"]), today)
        if len(group) >= int(th["min_independent"]):
            stacked_ids.update(s.id for s in group)
    can_sensitive = actor is not None and actor.can("signals", "view_sensitive")
    out = []
    for s in rows:
        o = SignalOut.model_validate(s)
        o.property_label = props.get(s.property_id)
        o.owner_label = owners.get(s.owner_id)
        o.type_label = types[s.signal_type].label if s.signal_type in types else None
        o.effective_status = effective_status(s, today)
        o.current_weight = decay_weight(s.half_life_days, s.observed_on, today) if o.effective_status == "active" else 0.0
        o.age_days = max(0, (today - s.observed_on).days)
        o.stacked = s.id in stacked_ids
        o.priority = signal_priority(s.severity, o.stacked)
        if s.is_sensitive and not can_sensitive:
            o.redacted = True
            o.title = o.type_label or s.signal_type
            o.description = None
            o.source_reference = None
            o.details = {}
        out.append(o)
    return out


# ----------------------------------------------------------------------------- automations


async def _active_opportunity_owner(db: AsyncSession, property_id: uuid.UUID) -> uuid.UUID | None:
    try:
        from app.modules.pipeline.models import Opportunity
    except ImportError:
        return None
    return await db.scalar(select(Opportunity.owner_id).where(
        Opportunity.property_id == property_id, Opportunity.deleted_at.is_(None),
        Opportunity.stage.notin_(["closed", "dead"])).order_by(Opportunity.updated_at.desc()).limit(1))


async def _property_label(db: AsyncSession, property_id: uuid.UUID) -> str:
    from app.modules.properties.models import Property

    row = (await db.execute(select(Property.name, Property.address_line).where(Property.id == property_id))).first()
    return (row[0] or row[1]) if row else "Property"


async def _subscription_matches(db: AsyncSession, sub: SignalSubscription, s: Signal, pids: list[uuid.UUID],
                                stacked_pids: set[uuid.UUID]) -> bool:
    from app.core.database import Base
    from app.modules.properties.models import Property

    if sub.categories and s.category not in sub.categories:
        return False
    if sub.signal_types and s.signal_type not in sub.signal_types:
        return False
    if s.severity < (sub.min_severity or 1):
        return False
    if sub.owner_id and not (s.owner_id == sub.owner_id and s.owner_kind == sub.owner_kind):
        return False
    candidates = list(pids)
    if sub.property_id:
        candidates = [p for p in candidates if p == sub.property_id]
        if not candidates:
            return False
    if sub.stacked_only:
        candidates = [p for p in candidates if p in stacked_pids]
        if not candidates:
            return False
    if sub.property_types:
        if not candidates:
            return False
        types = set(await db.scalars(select(Property.property_type).where(Property.id.in_(candidates))))
        if not types & set(sub.property_types):
            return False
    if sub.territory_id:
        members = Base.metadata.tables.get("territory_members")
        if members is None or not candidates or not await db.scalar(
                select(func.count()).select_from(members).where(
                    members.c.territory_id == sub.territory_id, members.c.property_id.in_(candidates))):
            return False
    return True


async def _run_automations(db: AsyncSession, s: Signal, actor) -> None:
    from app.modules.tasks.service import raise_alert, record_rule_run

    await ensure_rule(db)
    enabled, th = await settings(db)
    types = await type_map(db)
    type_label = types[s.signal_type].label if s.signal_type in types else s.signal_type.replace("_", " ")
    pids = [s.property_id] if s.property_id else []
    if s.owner_kind and s.owner_id:
        pids += [p for p in await owned_properties(db, s.owner_kind, s.owner_id) if p not in pids]
    pids = pids[:25]
    stacked_pids: set[uuid.UUID] = set()

    if enabled:
        for pid in pids:
            m = await motivation_breakdown(db, pid)
            label = await _property_label(db, pid)
            in_stack = any(c["signal_id"] == s.id and c["stacked"] for c in m["contributions"])
            if m["stacked"]:
                stacked_pids.add(pid)
            if m["stacked"] and in_stack:
                top = max([c["severity"] for c in m["contributions"] if c["stacked"]] or [s.severity])
                kinds = ", ".join(sorted({c["signal_type"].replace("_", " ") for c in m["contributions"] if c["stacked"]}))
                await raise_alert(
                    db, title=f"Stacked signals: {label}",
                    reason=f"{m['stack_count']} independent signals within {m['window_days']} days ({kinds}). "
                           f"Motivation index {m['index']}.",
                    severity=_bump(ALERT_SEVERITY.get(top, "medium")), owner_id=await _active_opportunity_owner(db, pid),
                    related_type="property", related_id=pid, related_label=label, rule_key=RULE_KEY,
                    idempotency_key=f"signals.stacked:{pid}:{s.id}",
                )
            elif s.severity >= int(th["alert_min_severity"]):
                await raise_alert(
                    db, title=f"{type_label}: {label}",
                    reason=f"Severity {s.severity} signal observed {s.observed_on:%b %d, %Y} (source: "
                           f"{'internal' if s.is_sensitive else s.source}). Motivation index {m['index']}.",
                    severity=ALERT_SEVERITY.get(s.severity, "medium"), owner_id=await _active_opportunity_owner(db, pid),
                    related_type="property", related_id=pid, related_label=label, rule_key="signals.severe",
                    idempotency_key=f"signals.severe:{pid}:{s.id}",
                )

    subs = list(await db.scalars(select(SignalSubscription).where(
        SignalSubscription.is_active.is_(True), SignalSubscription.deleted_at.is_(None))))
    for sub in subs:
        if actor is not None and sub.subscriber_id == getattr(actor, "id", None):
            continue
        if not await _subscription_matches(db, sub, s, pids, stacked_pids):
            continue
        pid = pids[0] if pids else None
        where = ""
        if pid:
            plabel = await _property_label(db, pid)
            where = f" · {plabel}"
        await raise_alert(
            db, title=f"New signal: {type_label}{where}",
            reason=f"Matches your subscription “{sub.name}”. Severity {s.severity}, observed {s.observed_on:%b %d, %Y}.",
            severity=ALERT_SEVERITY.get(s.severity, "medium"), owner_id=sub.subscriber_id,
            related_type="property" if pid else s.owner_kind, related_id=pid or s.owner_id,
            related_label=type_label, rule_key="signals.subscription",
            idempotency_key=f"signals.sub:{s.id}:{sub.id}",
        )
    await record_rule_run(db, RULE_KEY)


# ----------------------------------------------------------------------------- mutations


async def _ensure_owner(db: AsyncSession, kind: str, owner_id: uuid.UUID) -> None:
    try:
        from app.modules.contacts.models import Organization, Person
    except ImportError:
        return
    model = Person if kind == "person" else Organization
    row = await db.get(model, owner_id)
    if not row or row.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{kind.title()} not found")


async def create(db: AsyncSession, data: SignalCreate, actor) -> Signal:
    from app.modules.properties.models import Property

    if not data.property_id and not (data.owner_kind and data.owner_id):
        raise HTTPException(422, "Link the signal to a property and/or an owner")
    if bool(data.owner_kind) != bool(data.owner_id):
        raise HTTPException(422, "Owner kind and owner are both required to link an owner")
    if data.property_id:
        p = await db.get(Property, data.property_id)
        if not p or p.deleted_at:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    if data.owner_kind and data.owner_id:
        await _ensure_owner(db, data.owner_kind, data.owner_id)
    await ensure_types(db)
    t = (await type_map(db)).get(data.signal_type)
    if not t or not t.is_active:
        raise HTTPException(422, f"Unknown or inactive signal type '{data.signal_type}'")
    if data.observed_on > date.today():
        raise HTTPException(422, "Observed date cannot be in the future")
    expires = data.expires_on or (data.observed_on + timedelta(days=t.default_expiry_days)
                                  if t.default_expiry_days else None)
    if expires and expires < data.observed_on:
        raise HTTPException(422, "Expiration must be on or after the observed date")
    verified = data.verified
    s = Signal(
        property_id=data.property_id, owner_kind=data.owner_kind, owner_id=data.owner_id, category=t.category,
        signal_type=t.key, title=(data.title or "").strip() or t.label, description=data.description,
        observed_on=data.observed_on, severity=data.severity or t.default_severity, source=data.source.strip(),
        source_reference=data.source_reference, confidence=data.confidence, expires_on=expires,
        half_life_days=t.half_life_days, is_sensitive=t.is_sensitive if data.is_sensitive is None else data.is_sensitive,
        status="active", details=data.details or {}, verification="verified" if verified else "unverified",
        verified_by_id=actor.id if verified else None, verified_at=utcnow() if verified else None,
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(s)
    await db.flush()
    summary = f"{t.label} · severity {s.severity} · {s.source}"
    await audit.record(db, actor=actor, action="signal.created", entity_type=ENTITY, entity_id=s.id, summary=summary,
                       ip_address=actor.ip_address)
    if s.property_id:
        await audit.record(db, actor=actor, action="property.signal_added", entity_type="property",
                           entity_id=s.property_id, summary=t.label if s.is_sensitive else summary,
                           ip_address=actor.ip_address)
    if s.owner_kind and s.owner_id:
        await audit.record(db, actor=actor, action=f"{s.owner_kind}.signal_added", entity_type=s.owner_kind,
                           entity_id=s.owner_id, summary=t.label if s.is_sensitive else summary,
                           ip_address=actor.ip_address)
    # Subscribers: scoring rescoring and reactivation evaluation run in their handlers (same transaction).
    await events.emit(db, "signal.created", signal_id=s.id, property_id=s.property_id, owner_kind=s.owner_kind,
                      owner_id=s.owner_id, category=s.category, signal_type=s.signal_type, actor=actor)
    await _run_automations(db, s, actor)
    await db.commit()
    return s


async def _changed(db: AsyncSession, s: Signal, actor) -> None:
    await db.flush()  # autoflush=False: handlers query signals in SQL and must see this change
    await events.emit(db, "signal.updated", signal_id=s.id, property_id=s.property_id, owner_kind=s.owner_kind,
                      owner_id=s.owner_id, category=s.category, actor=actor)


async def update_signal(db: AsyncSession, s: Signal, data: SignalUpdate, actor) -> Signal:
    values = data.model_dump(exclude_unset=True)
    for k in ("source", "observed_on", "severity", "confidence"):
        if k in values and values[k] is None:
            values.pop(k)
    obs = values.get("observed_on", s.observed_on)
    if obs > date.today():
        raise HTTPException(422, "Observed date cannot be in the future")
    if values.get("expires_on") and values["expires_on"] < obs:
        raise HTTPException(422, "Expiration must be on or after the observed date")
    prov = ProvenanceIn(source=values.get("source", s.source), observed_on=obs,
                        confidence=values.get("confidence", s.confidence))
    changes = await provenance.apply_material(db, s, entity_type=ENTITY, data=values, material_fields=MATERIAL,
                                              prov=prov, actor_id=actor.id)
    if not changes:
        return s
    if MATERIAL & changes.keys() and s.verification == "verified":
        s.verification, s.verified_by_id, s.verified_at = "unverified", None, None
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="signal.updated", entity_type=ENTITY, entity_id=s.id, changes=changes,
                       ip_address=actor.ip_address)
    await _changed(db, s, actor)
    await db.commit()
    return s


async def dismiss(db: AsyncSession, s: Signal, reason: str, actor) -> Signal:
    if s.status == "dismissed":
        raise HTTPException(409, "Signal is already dismissed")
    s.status, s.dismissed_reason, s.dismissed_by_id, s.dismissed_at = "dismissed", reason.strip(), actor.id, utcnow()
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="signal.dismissed", entity_type=ENTITY, entity_id=s.id,
                       summary=reason.strip(), ip_address=actor.ip_address)
    await _changed(db, s, actor)
    await db.commit()
    return s


async def restore(db: AsyncSession, s: Signal, actor) -> Signal:
    if s.status != "dismissed":
        raise HTTPException(409, "Only dismissed signals can be restored")
    s.status, s.dismissed_reason, s.dismissed_by_id, s.dismissed_at = "active", None, None, None
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="signal.restored", entity_type=ENTITY, entity_id=s.id,
                       ip_address=actor.ip_address)
    await _changed(db, s, actor)
    await db.commit()
    return s


async def verify(db: AsyncSession, s: Signal, state: str, actor) -> Signal:
    before = s.verification
    s.verification = state
    s.verified_by_id = actor.id if state != "unverified" else None
    s.verified_at = utcnow() if state != "unverified" else None
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"signal.{state}", entity_type=ENTITY, entity_id=s.id,
                       changes={"verification": {"from": before, "to": state}}, ip_address=actor.ip_address)
    await _changed(db, s, actor)
    await db.commit()
    return s


async def archive(db: AsyncSession, s: Signal, actor) -> None:
    s.deleted_at = utcnow()
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="signal.archived", entity_type=ENTITY, entity_id=s.id,
                       summary=s.title, ip_address=actor.ip_address)
    await _changed(db, s, actor)
    await db.commit()


# ----------------------------------------------------------------------------- subscriptions


async def get_subscription(db: AsyncSession, sub_id: uuid.UUID, actor) -> SignalSubscription:
    sub = await db.get(SignalSubscription, sub_id)
    if not sub or sub.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subscription not found")
    if sub.subscriber_id != actor.id and not actor.can("signals", "approve"):
        raise HTTPException(403, "You can only manage your own subscriptions")
    return sub


def _check_sub(data: SubscriptionIn) -> None:
    if bool(data.owner_kind) != bool(data.owner_id):
        raise HTTPException(422, "Owner kind and owner are both required to subscribe to an owner")
    bad = [c for c in data.categories if c not in CATEGORIES]
    if bad:
        raise HTTPException(422, f"Unknown categories: {', '.join(bad)}")


async def create_subscription(db: AsyncSession, data: SubscriptionIn, actor) -> SignalSubscription:
    _check_sub(data)
    sub = SignalSubscription(**data.model_dump(), subscriber_id=actor.id, created_by_id=actor.id,
                             updated_by_id=actor.id)
    db.add(sub)
    await db.flush()
    await audit.record(db, actor=actor, action="signal_subscription.created", entity_type="signal_subscription",
                       entity_id=sub.id, summary=sub.name, ip_address=actor.ip_address)
    await db.commit()
    return sub


async def update_subscription(db: AsyncSession, sub: SignalSubscription, data: SubscriptionIn, actor):
    _check_sub(data)
    values = data.model_dump()
    changes = audit.diff(sub, values)
    if changes:
        for k, v in values.items():
            setattr(sub, k, v)
        sub.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="signal_subscription.updated", entity_type="signal_subscription",
                           entity_id=sub.id, summary=sub.name, changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return sub


async def delete_subscription(db: AsyncSession, sub: SignalSubscription, actor) -> None:
    sub.deleted_at = utcnow()
    sub.is_active = False
    sub.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="signal_subscription.deleted", entity_type="signal_subscription",
                       entity_id=sub.id, summary=sub.name, ip_address=actor.ip_address)
    await db.commit()
