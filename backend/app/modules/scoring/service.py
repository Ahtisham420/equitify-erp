"""Opportunity scoring & prioritization (spec module 9).

Only properties whose current Buy Box evaluation is pass / pass_with_exception are scored and ranked.
`score` (0-100) is the weighted value of five value components minus a negative-risk penalty.
`confidence` (0-1) is a separate certainty measure built from completeness, source quality, observation
age and verification state - it never adds value; it sets the band (High/Medium/Low) and ranking happens
within a band. Every score stores each component with its inputs and positive/negative drivers.
"""
import hashlib
import inspect
import json
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException, status
from geoalchemy2 import Geography
from geoalchemy2.elements import WKTElement
from sqlalchemy import Select, case, cast, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.core import events
from app.core.security import utcnow
from app.modules.scoring.models import (
    COMPONENT_LABELS,
    COMPONENTS,
    DEFAULT_BANDS,
    DEFAULT_WEIGHTS,
    OpportunityScore,
    ScoreConfig,
    ScoreOutcome,
)
from app.modules.scoring.schemas import ConfigIn, OutcomeIn

RULE_KEY = "scoring.threshold_crossed"
ELIGIBLE = ("pass", "pass_with_exception")
VALUE_COMPONENTS = [c for c in COMPONENTS if c != "negative_risk"]
KEY_FACTS = ["asking_price", "noi", "occupancy_pct", "building_area_sf"]
STRENGTH_POINTS = {"none": 0, "weak": 35, "moderate": 65, "strong": 90}
DISPOSITION_POINTS = {"offer_requested": 15, "information_requested": 8, "callback": 6, "connected": 4}
MIN_OUTCOMES = {"total": 10, "won": 3, "lost": 3}
PURSUE_STAGES = {"contact", "offer", "under_contract"}


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _money(v: float | None) -> str:
    return f"${v:,.0f}" if v is not None else "—"


def _component(key: str, value: float, inputs: dict, positive: list[str], negative: list[str],
               missing: list[str] | None = None) -> dict[str, Any]:
    return {"key": key, "label": COMPONENT_LABELS[key], "value": round(_clamp(value), 1), "weight": 0.0,
            "contribution": 0.0, "inputs": audit.to_jsonable(inputs), "positive": positive, "negative": negative,
            "missing": missing or []}


# ----------------------------------------------------------------------------- configuration


async def ensure_rule(db: AsyncSession) -> None:
    from app.modules.tasks.models import AutomationRule

    if await db.scalar(select(AutomationRule.id).where(AutomationRule.key == RULE_KEY)) is None:
        db.add(AutomationRule(
            key=RULE_KEY, name="Score threshold crossing", event="score.computed", enabled=True,
            description="Alerts the opportunity owner when a property's score crosses the active configuration's "
                        "alert threshold (upward or downward).",
            thresholds={}, run_count=0, error_count=0,
        ))
        await db.flush()


async def active_config(db: AsyncSession) -> ScoreConfig:
    cfg = await db.scalar(select(ScoreConfig).where(ScoreConfig.status == "active", ScoreConfig.deleted_at.is_(None))
                          .order_by(ScoreConfig.version.desc()).limit(1))
    if cfg is None:
        top = await db.scalar(select(func.max(ScoreConfig.version)))
        cfg = ScoreConfig(version=(top or 0) + 1, name="Default weights", status="active", weights=dict(DEFAULT_WEIGHTS),
                          band_thresholds=dict(DEFAULT_BANDS), alert_threshold=75, high_dollar_threshold=5_000_000,
                          source="default", basis={}, activated_at=utcnow())
        db.add(cfg)
        await db.flush()
    return cfg


def _validate_config(data: ConfigIn) -> None:
    keys = set(data.weights)
    if keys != set(COMPONENTS):
        raise HTTPException(422, f"Weights must define exactly: {', '.join(COMPONENTS)}")
    if any(not 0 <= w <= 1 for w in data.weights.values()):
        raise HTTPException(422, "Each weight must be between 0 and 1")
    if sum(data.weights[k] for k in VALUE_COMPONENTS) <= 0:
        raise HTTPException(422, "At least one value component needs a positive weight")
    hi, med = data.band_thresholds.get("high"), data.band_thresholds.get("medium")
    if hi is None or med is None or not (0 < med < hi <= 1):
        raise HTTPException(422, "Band thresholds need 0 < medium < high ≤ 1")


async def get_config(db: AsyncSession, config_id: uuid.UUID) -> ScoreConfig:
    cfg = await db.get(ScoreConfig, config_id)
    if not cfg or cfg.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Score configuration not found")
    return cfg


async def create_config(db: AsyncSession, data: ConfigIn, actor, *, status_: str = "draft", source: str = "manual",
                        basis: dict | None = None, based_on: int | None = None) -> ScoreConfig:
    _validate_config(data)
    top = await db.scalar(select(func.max(ScoreConfig.version)))
    cfg = ScoreConfig(version=(top or 0) + 1, name=data.name, status=status_, weights=data.weights,
                      band_thresholds=data.band_thresholds, alert_threshold=data.alert_threshold,
                      high_dollar_threshold=data.high_dollar_threshold, notes=data.notes, source=source,
                      basis=basis or {}, based_on_version=based_on, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(cfg)
    await db.flush()
    await audit.record(db, actor=actor, action="score_config.created", entity_type="score_config", entity_id=cfg.id,
                       summary=f"v{cfg.version} {cfg.name} ({status_})", ip_address=actor.ip_address)
    await db.commit()
    return cfg


async def update_config(db: AsyncSession, cfg: ScoreConfig, data: ConfigIn, actor) -> ScoreConfig:
    if cfg.status not in ("draft", "proposed"):
        raise HTTPException(409, "Only draft or proposed configurations can be edited; active and retired versions "
                                 "are kept as they were")
    _validate_config(data)
    values = data.model_dump()
    changes = audit.diff(cfg, values)
    if changes:
        for k, v in values.items():
            setattr(cfg, k, v)
        cfg.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="score_config.updated", entity_type="score_config",
                           entity_id=cfg.id, summary=f"v{cfg.version}", changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return cfg


async def activate_config(db: AsyncSession, cfg: ScoreConfig, actor) -> ScoreConfig:
    if cfg.status not in ("draft", "proposed"):
        raise HTTPException(409, f"A {cfg.status} configuration cannot be activated")
    now = utcnow()
    current = await db.scalar(select(ScoreConfig).where(ScoreConfig.status == "active", ScoreConfig.deleted_at.is_(None)))
    if current:
        current.status, current.retired_at, current.updated_by_id = "retired", now, actor.id
    cfg.status, cfg.approved_by_id, cfg.approved_at, cfg.activated_at = "active", actor.id, now, now
    cfg.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="score_config.activated", entity_type="score_config", entity_id=cfg.id,
                       summary=f"v{cfg.version} activated" + (f"; v{current.version} retired" if current else ""),
                       ip_address=actor.ip_address)
    await db.flush()
    await rescore_all(db, actor=actor, trigger="config_activated", alerts=False)
    await db.commit()
    return cfg


async def reject_config(db: AsyncSession, cfg: ScoreConfig, reason: str, actor) -> ScoreConfig:
    if cfg.status not in ("draft", "proposed"):
        raise HTTPException(409, f"A {cfg.status} configuration cannot be rejected")
    cfg.status, cfg.rejected_reason, cfg.updated_by_id = "rejected", reason.strip(), actor.id
    await audit.record(db, actor=actor, action="score_config.rejected", entity_type="score_config", entity_id=cfg.id,
                       summary=reason.strip(), ip_address=actor.ip_address)
    await db.commit()
    return cfg


# ----------------------------------------------------------------------------- inputs


async def eligibility(db: AsyncSession, property_id: uuid.UUID) -> tuple[bool, list[dict]]:
    try:
        from app.modules.buybox.models import BuyBox, BuyboxEvaluation
    except ImportError:
        return False, [{"result": "unavailable", "detail": "Buy box module unavailable"}]
    rows = (await db.execute(
        select(BuyboxEvaluation.buy_box_id, BuyBox.name, BuyboxEvaluation.buy_box_version, BuyboxEvaluation.result)
        .join(BuyBox, BuyBox.id == BuyboxEvaluation.buy_box_id)
        .where(BuyboxEvaluation.property_id == property_id, BuyboxEvaluation.is_current.is_(True))
    )).all()
    details = [{"buy_box_id": str(b), "buy_box_name": n, "version": v, "result": r} for b, n, v, r in rows]
    return any(d["result"] in ELIGIBLE for d in details), details


async def _opportunity(db: AsyncSession, property_id: uuid.UUID):
    try:
        from app.modules.pipeline.models import Opportunity
    except ImportError:
        return None
    return await db.scalar(select(Opportunity).where(Opportunity.property_id == property_id,
                                                     Opportunity.deleted_at.is_(None))
                           .order_by(Opportunity.updated_at.desc()).limit(1))


async def _owner_rows(db: AsyncSession, property_id: uuid.UUID) -> list[Any]:
    try:
        from app.modules.ownership.models import OwnershipInterest
    except ImportError:
        return []
    today = date.today()
    return list(await db.scalars(select(OwnershipInterest).where(
        OwnershipInterest.property_id == property_id, OwnershipInterest.deleted_at.is_(None),
        or_(OwnershipInterest.effective_to.is_(None), OwnershipInterest.effective_to > today))))


async def _economics(db: AsyncSession, p: Any, opp: Any) -> dict:
    inputs: dict[str, Any] = {"asking_price": p.asking_price, "noi": p.noi}
    pos: list[str] = []
    neg: list[str] = []
    missing: list[str] = []
    value_point = None
    try:
        from app.modules.comps.service import latest_value

        lv = latest_value(db, p.id)
        if inspect.isawaitable(lv):
            lv = await lv
        if lv and lv.get("value_point"):
            value_point = float(lv["value_point"])
            inputs.update(valuation=value_point, valuation_method=lv.get("method"), valuation_as_of=lv.get("as_of"))
    except ImportError:
        pass
    if value_point is None and opp is not None and opp.estimated_value:
        value_point = float(opp.estimated_value)
        inputs["estimated_value"] = value_point
    asking = p.asking_price or (opp.price_expectation if opp is not None else None)
    if opp is not None and opp.price_expectation:
        inputs["owner_price_expectation"] = opp.price_expectation
    if asking and value_point:
        gap = (value_point - asking) / value_point
        inputs["pricing_gap_pct"] = round(gap * 100, 1)
        value = 50 + gap * 250
        text = f"Price {_money(asking)} is {abs(gap) * 100:.1f}% {'below' if gap >= 0 else 'above'} value {_money(value_point)}"
        (pos if gap >= 0 else neg).append(text)
    elif asking and p.noi:
        cap = p.noi / asking * 100
        inputs["implied_cap_rate"] = round(cap, 2)
        value = (cap - 3) * 15
        (pos if cap >= 6.5 else neg).append(f"Implied cap rate {cap:.2f}% on {_money(asking)}")
        missing.append("valuation")
    else:
        value = 50
        missing += [m for m, v in (("asking_price", asking), ("noi", p.noi), ("valuation", value_point)) if not v]
        neg.append("Pricing inputs incomplete; neutral economics assumed")
    return _component("economics", value, inputs, pos, neg, missing)


async def _location(db: AsyncSession, p: Any) -> dict:
    inputs: dict[str, Any] = {"traffic_count": p.traffic_count, "corridor": p.corridor}
    pos: list[str] = []
    neg: list[str] = []
    missing: list[str] = []
    traffic = p.traffic_count
    growth = None
    if p.latitude is not None and p.longitude is not None:
        point = cast(WKTElement(f"POINT({p.longitude} {p.latitude})", srid=4326), Geography)
        try:
            from app.modules.territories.models import GrowthRecord, TrafficCount

            since = date.today() - timedelta(days=3 * 365)
            growth = int(await db.scalar(select(func.count()).select_from(GrowthRecord).where(
                GrowthRecord.deleted_at.is_(None), GrowthRecord.location.is_not(None),
                or_(GrowthRecord.event_date.is_(None), GrowthRecord.event_date >= since),
                func.ST_DWithin(cast(GrowthRecord.location, Geography), point, 3 * 1609.344))) or 0)
            inputs["growth_records_3mi"] = growth
            if traffic is None:
                traffic = await db.scalar(select(TrafficCount.count).where(
                    TrafficCount.deleted_at.is_(None), TrafficCount.location.is_not(None),
                    func.ST_DWithin(cast(TrafficCount.location, Geography), point, 0.5 * 1609.344))
                    .order_by(TrafficCount.count_year.desc(), TrafficCount.count.desc()).limit(1))
                if traffic is not None:
                    inputs["nearest_traffic_count"] = traffic
        except ImportError:
            pass
    else:
        missing.append("coordinates")
    t_pts = min(50.0, traffic / 40000 * 50) if traffic else None
    g_pts = min(50.0, growth * 10.0) if growth is not None else None
    if t_pts is None and g_pts is None:
        missing.append("traffic / growth context")
        neg.append("No traffic or growth context; neutral location assumed")
        return _component("location", 50, inputs, pos, neg, missing)
    if traffic:
        (pos if traffic >= 20000 else neg).append(f"Traffic {traffic:,.0f} vehicles/day")
    else:
        missing.append("traffic_count")
    if growth is not None:
        (pos if growth >= 2 else neg).append(f"{growth} growth record{'s' if growth != 1 else ''} within 3 miles (3 yrs)")
    return _component("location", (t_pts if t_pts is not None else 25) + (g_pts if g_pts is not None else 25),
                      inputs, pos, neg, missing)


async def _motivation(db: AsyncSession, p: Any) -> tuple[dict, list]:
    try:
        from app.modules.signals.service import motivation_breakdown, property_signal_rows
    except ImportError:
        return _component("motivation", 0, {}, [], ["Signals module unavailable"], ["signals"]), []
    m = await motivation_breakdown(db, p.id)
    rows = await property_signal_rows(db, p.id, live_only=True)
    pos, neg = [], []
    for c in m["contributions"][:3]:
        pos.append(f"{c['signal_type'].replace('_', ' ').capitalize()} (severity {c['severity']}, "
                   f"weight {c['weight']:.2f}) +{c['contribution']}")
    if m["stacked"]:
        pos.insert(0, f"{m['stack_count']} independent signals stacked within {m['window_days']} days "
                      f"(x{m['stack_multiplier']})")
    if not m["active_signals"]:
        neg.append("No active motivation signals")
    inputs = {"motivation_index": m["index"], "active_signals": m["active_signals"], "stacked": m["stacked"]}
    return _component("motivation", m["index"], inputs, pos, neg), rows


async def _transaction_probability(db: AsyncSession, p: Any, opp: Any, owners: list) -> dict:
    value = 40.0
    inputs: dict[str, Any] = {"property_status": p.status}
    pos: list[str] = []
    neg: list[str] = []
    if opp is not None:
        from app.modules.pipeline.models import ACTIVE_STAGES

        inputs["opportunity_stage"] = opp.stage
        if opp.stage in ACTIVE_STAGES:
            idx = ACTIVE_STAGES.index(opp.stage)
            value += idx * 4
            if idx:
                pos.append(f"Active opportunity in {opp.stage.replace('_', ' ')}")
        elif opp.stage == "dead":
            value -= 15
            neg.append(f"Previously dead ({(opp.dead_reason or 'no reason').replace('_', ' ')})")
        elif opp.stage == "nurture":
            value -= 5
            neg.append("Opportunity in nurture")
    if p.status == "listed":
        value += 20
        pos.append("Listed for sale")
    try:
        from app.modules.outreach.models import Interaction

        since = utcnow() - timedelta(days=180)
        conds = [Interaction.property_id == p.id]
        if opp is not None:
            conds.append(Interaction.opportunity_id == opp.id)
        disp = dict((await db.execute(
            select(Interaction.disposition, func.count()).where(
                Interaction.deleted_at.is_(None), Interaction.occurred_at >= since, or_(*conds),
                Interaction.disposition.is_not(None)).group_by(Interaction.disposition))).all())
        inputs["dispositions_180d"] = disp
        bonus = min(25, sum(DISPOSITION_POINTS.get(k, 0) * int(n) for k, n in disp.items()))
        if bonus:
            value += bonus
            pos.append(f"Positive owner responses in the last 180 days (+{bonus})")
        if disp.get("not_interested"):
            value -= 20
            neg.append("Owner said not interested in the last 180 days")
    except ImportError:
        pass
    starts = [o.effective_from for o in owners if o.effective_from]
    if starts:
        years = (date.today() - min(starts)).days / 365.25
        inputs["hold_years"] = round(years, 1)
        if years >= 7:
            value += 10
            pos.append(f"Held {years:.0f} years")
    return _component("transaction_probability", value, inputs, pos, neg)


async def _relationship(db: AsyncSession, p: Any, opp: Any, owners: list) -> dict:
    people = {o.owner_person_id for o in owners if o.owner_person_id}
    orgs = {o.owner_organization_id for o in owners if o.owner_organization_id}
    if opp is not None:
        if opp.primary_person_id:
            people.add(opp.primary_person_id)
        if opp.primary_organization_id:
            orgs.add(opp.primary_organization_id)
    if not people and not orgs:
        return _component("relationship", 0, {}, [], ["No known owner or contact"], ["owner contact"])
    try:
        from app.modules.contacts.models import Organization, Person
    except ImportError:
        return _component("relationship", 0, {}, [], ["Contacts module unavailable"], ["contacts"])
    rows = []
    if people:
        rows += [(n, s, t) for n, s, t in (await db.execute(select(
            Person.full_name, Person.relationship_strength, Person.last_touch_at).where(Person.id.in_(people)))).all()]
    if orgs:
        rows += [(n, s, t) for n, s, t in (await db.execute(select(
            Organization.name, Organization.relationship_strength, Organization.last_touch_at)
            .where(Organization.id.in_(orgs)))).all()]
    if not rows:
        return _component("relationship", 0, {}, [], ["No known owner or contact"], ["owner contact"])
    best = max(rows, key=lambda r: STRENGTH_POINTS.get(r[1] or "none", 0))
    value = float(STRENGTH_POINTS.get(best[1] or "none", 0))
    pos, neg = [], []
    if value >= 65:
        pos.append(f"{(best[1] or 'none').capitalize()} relationship with {best[0]}")
    else:
        neg.append(f"Best relationship is {(best[1] or 'none')} ({best[0]})")
    recent = [t for _, _, t in rows if t and t >= utcnow() - timedelta(days=90)]
    if recent:
        value += 10
        pos.append("Touched within the last 90 days")
    inputs = {"contacts": [{"name": n, "strength": s, "last_touch_at": t} for n, s, t in rows][:10]}
    return _component("relationship", value, inputs, pos, neg)


async def _negative_risk(p: Any, signals: list, eligibility_rows: list[dict]) -> dict:
    risk = 0.0
    pos: list[str] = []
    neg: list[str] = []
    inputs: dict[str, Any] = {"flood_zone": p.flood_zone, "occupancy_pct": p.occupancy_pct, "year_built": p.year_built}
    if p.flood_zone and p.flood_zone.strip().upper()[:1] in ("A", "V"):
        risk += 30
        neg.append(f"Flood zone {p.flood_zone}")
    if p.occupancy_pct is not None and p.occupancy_pct < 70 and p.property_type != "land":
        risk += 15
        neg.append(f"Occupancy {p.occupancy_pct:.0f}%")
    if p.year_built and p.year_built < 1970:
        risk += 10
        neg.append(f"Built {p.year_built}")
    results = {e["result"] for e in eligibility_rows}
    if "pass" not in results and "pass_with_exception" in results:
        risk += 10
        neg.append("Eligible only by an approved buy box exception")
    severe = [s for s in signals if s.category in ("legal", "physical") and s.severity >= 4]
    if severe:
        risk += min(30, 15 * len(severe))
        neg.append(f"{len(severe)} severe legal/physical signal{'s' if len(severe) != 1 else ''}")
    if risk == 0:
        pos.append("No material risk flags")
    return _component("negative_risk", risk, inputs, pos, neg)


def _freshness(age_days: int) -> float:
    if age_days <= 180:
        return 1.0
    if age_days >= 1095:
        return 0.3
    return round(1.0 - 0.7 * (age_days - 180) / (1095 - 180), 3)


async def _confidence(db: AsyncSession, p: Any) -> tuple[float, list[dict]]:
    obs = await provenance.current_observations(db, "property", p.id)
    completeness = float(p.completeness_score or 0) / 100
    today = date.today()
    if obs:
        source_quality = sum(float(o.confidence or 0) for o in obs.values()) / len(obs)
        ages = [(today - o.observed_on).days for o in obs.values() if o.observed_on]
        freshness = sum(_freshness(a) for a in ages) / len(ages) if ages else 0.5
        verified = sum(1 for o in obs.values() if o.verification == "verified") / len(obs)
    else:
        source_quality, freshness, verified = 0.4, 0.4, 0.0
    unverified_key = [f for f in KEY_FACTS if f in obs and obs[f].verification != "verified"]
    penalty = 0.05 * len(unverified_key)
    factors = [
        {"key": "completeness", "label": "Data completeness", "value": round(completeness, 3), "weight": 0.35,
         "detail": f"{p.completeness_score:.0f}% of required fields present"},
        {"key": "source_quality", "label": "Source quality", "value": round(source_quality, 3), "weight": 0.25,
         "detail": f"Average confidence of {len(obs)} sourced facts" if obs else "No sourced observations"},
        {"key": "observation_age", "label": "Observation age", "value": round(freshness, 3), "weight": 0.2,
         "detail": "Recency of observed dates (full credit within 6 months)"},
        {"key": "verification", "label": "Verification state", "value": round(verified, 3), "weight": 0.2,
         "detail": f"{round(verified * 100)}% of facts verified by a named person"},
    ]
    if unverified_key:
        factors.append({"key": "unverified_material", "label": "Unverified material facts", "value": -round(penalty, 3),
                        "weight": 1.0, "detail": "Unverified: " + ", ".join(unverified_key)})
    conf = 0.35 * completeness + 0.25 * source_quality + 0.2 * freshness + 0.2 * verified - penalty
    return round(_clamp(conf, 0.05, 1.0), 3), factors


def band_for(confidence: float, thresholds: dict) -> str:
    if confidence >= float(thresholds.get("high", DEFAULT_BANDS["high"])):
        return "high"
    if confidence >= float(thresholds.get("medium", DEFAULT_BANDS["medium"])):
        return "medium"
    return "low"


def combine(components: dict[str, dict], weights: dict[str, float]) -> float:
    """Weighted average of value components minus the negative-risk penalty; fills each contribution."""
    wsum = sum(float(weights.get(k, 0)) for k in VALUE_COMPONENTS) or 1.0
    total = 0.0
    for k in VALUE_COMPONENTS:
        c = components[k]
        c["weight"] = round(float(weights.get(k, 0)), 4)
        c["contribution"] = round(c["value"] * float(weights.get(k, 0)) / wsum, 2)
        total += c["contribution"]
    risk = components["negative_risk"]
    risk["weight"] = round(float(weights.get("negative_risk", 0)), 4)
    risk["contribution"] = -round(risk["value"] * float(weights.get("negative_risk", 0)), 2)
    return round(_clamp(total + risk["contribution"]), 1)


# ----------------------------------------------------------------------------- scoring


async def current_score(db: AsyncSession, property_id: uuid.UUID) -> OpportunityScore | None:
    return await db.scalar(select(OpportunityScore).where(OpportunityScore.property_id == property_id,
                                                          OpportunityScore.is_current.is_(True))
                           .order_by(OpportunityScore.computed_at.desc()).limit(1))


async def compute(db: AsyncSession, p: Any, cfg: ScoreConfig, elig_rows: list[dict]) -> dict[str, Any]:
    opp = await _opportunity(db, p.id)
    owners = await _owner_rows(db, p.id)
    motivation, signals = await _motivation(db, p)
    comps = {
        "economics": await _economics(db, p, opp),
        "location": await _location(db, p),
        "motivation": motivation,
        "transaction_probability": await _transaction_probability(db, p, opp, owners),
        "relationship": await _relationship(db, p, opp, owners),
        "negative_risk": await _negative_risk(p, signals, elig_rows),
    }
    score = combine(comps, cfg.weights or DEFAULT_WEIGHTS)
    confidence, factors = await _confidence(db, p)
    band = band_for(confidence, cfg.band_thresholds or DEFAULT_BANDS)
    ordered = [comps[k] for k in COMPONENTS]
    positives = sorted(((c["contribution"], d) for c in ordered if c["key"] != "negative_risk" for d in c["positive"]),
                       key=lambda x: -x[0])
    negatives = [d for c in sorted(ordered, key=lambda c: c["contribution"]) for d in c["negative"]]
    value_basis = p.asking_price or (opp.price_expectation if opp is not None else None) or \
        (opp.estimated_value if opp is not None else None)
    needs_research = score >= 60 and band == "low"
    drivers = {"positive": [d for _, d in positives][:6], "negative": negatives[:6]}
    if needs_research:
        drivers["note"] = "High value score on weak evidence: surface for research before treating as verified."
    return {
        "score": score, "confidence": confidence, "adjusted_score": round(score * confidence, 1), "band": band,
        "components": ordered, "confidence_factors": factors, "drivers": drivers, "needs_research": needs_research,
        "value_basis": value_basis,
        # High-dollar automation can never act on a score alone; unknown value is treated as high-dollar.
        "requires_human_approval": value_basis is None or float(value_basis) >= float(cfg.high_dollar_threshold or 0),
    }


def _signature(cfg_version: int, result: dict) -> str:
    key = {"v": cfg_version, "s": result["score"], "c": result["confidence"],
           "k": [(c["key"], c["value"]) for c in result["components"]]}
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()


async def rescore_property(db: AsyncSession, property_id: uuid.UUID | None, actor=None, *, trigger: str = "manual",
                           alerts: bool = True) -> OpportunityScore | None:
    """Recompute the score for one property (does not commit). Ineligible properties lose their current score."""
    from app.modules.properties.models import Property

    if property_id is None:
        return None
    p = await db.get(Property, property_id)
    if not p or p.deleted_at:
        return None
    cfg = await active_config(db)
    eligible, elig_rows = await eligibility(db, property_id)
    prev = await current_score(db, property_id)
    if not eligible:
        if prev:
            prev.is_current = False  # history kept; the property simply leaves the rankings
            await db.flush()
        return None
    result = await compute(db, p, cfg, elig_rows)
    sig = _signature(cfg.version, result)
    if prev and prev.signature == sig:
        prev.computed_at = utcnow()
        return prev
    if prev:
        prev.is_current = False
    row = OpportunityScore(property_id=property_id, config_id=cfg.id, config_version=cfg.version, eligibility=elig_rows,
                           signature=sig, trigger=trigger[:40], computed_at=utcnow(),
                           computed_by_id=getattr(actor, "id", None), is_current=True, **result)
    db.add(row)
    await db.flush()
    if alerts:
        await _threshold_check(db, p, prev, row, cfg, actor)
    return row


async def _threshold_check(db: AsyncSession, p: Any, prev: OpportunityScore | None, row: OpportunityScore,
                           cfg: ScoreConfig, actor) -> None:
    from app.modules.tasks.service import raise_alert, record_rule_run, rule_config

    t = float(cfg.alert_threshold)
    before = prev.score if prev else None
    up = row.score >= t and (before is None or before < t)
    down = before is not None and before >= t and row.score < t
    if not (up or down):
        return
    await ensure_rule(db)
    enabled, _ = await rule_config(db, RULE_KEY)
    if not enabled:
        return
    opp = await _opportunity(db, p.id)
    label = p.name or p.address_line
    direction = "up" if up else "down"
    reason = (f"Score {before if before is not None else '—'} → {row.score} (threshold {t:g}); confidence "
              f"{row.confidence:.2f}, {row.band} band.")
    if row.needs_research:
        reason += " High score on weak evidence: research before acting."
    if row.requires_human_approval:
        reason += " High-dollar: automated action requires human approval."
    await raise_alert(
        db, title=f"Score {'crossed above' if up else 'fell below'} {t:g}: {label}", reason=reason,
        severity=("high" if row.band == "high" else "medium") if up else "low",
        owner_id=opp.owner_id if opp is not None and opp.stage not in ("closed", "dead") else None,
        related_type="property", related_id=p.id, related_label=label, rule_key=RULE_KEY,
        idempotency_key=f"scoring.threshold:{p.id}:{row.id}",
    )
    await record_rule_run(db, RULE_KEY)
    await events.emit(db, "score.threshold_crossed", property_id=p.id, score=row.score, actor=actor,
                      direction=direction, threshold=t, score_id=row.id)


async def rescore_all(db: AsyncSession, *, actor=None, trigger: str = "bulk", alerts: bool = False,
                      limit: int = 2000) -> int:
    """Rescores every property with a current eligible buy box result (bounded). Does not commit."""
    try:
        from app.modules.buybox.models import BuyboxEvaluation
    except ImportError:
        return 0
    ids = list(await db.scalars(select(BuyboxEvaluation.property_id).where(
        BuyboxEvaluation.is_current.is_(True), BuyboxEvaluation.result.in_(ELIGIBLE)).distinct().limit(limit)))
    ids += [i for i in await db.scalars(select(OpportunityScore.property_id).where(
        OpportunityScore.is_current.is_(True)).limit(limit)) if i not in ids]
    for pid in ids:
        await rescore_property(db, pid, actor, trigger=trigger, alerts=alerts)
    return len(ids)


def automation_allowed(score: OpportunityScore | None, *, human_approved: bool = False) -> bool:
    """Guard for any automation acting on a score: high-dollar actions need a recorded human approval."""
    if score is None:
        return False
    return human_approved or not score.requires_human_approval


# ----------------------------------------------------------------------------- rankings


@dataclass
class RankingFilters:
    q: str | None = None
    band: list[str] | None = None
    property_type: list[str] | None = None
    min_score: float | None = None
    max_score: float | None = None
    min_confidence: float | None = None
    territory_id: uuid.UUID | None = None
    needs_research: bool | None = None


BAND_ORDER = case({"high": 0, "medium": 1, "low": 2}, value=OpportunityScore.band, else_=3)


def rankings_query(f: RankingFilters, *, skip: set[str] = frozenset()) -> Select:
    from app.common.query import apply_search, in_filter, range_filter
    from app.core.database import Base
    from app.modules.buybox.models import BuyboxEvaluation
    from app.modules.properties.models import Property

    eligible = exists().where(BuyboxEvaluation.property_id == OpportunityScore.property_id,
                              BuyboxEvaluation.is_current.is_(True), BuyboxEvaluation.result.in_(ELIGIBLE))
    stmt = (select(OpportunityScore, Property.property_type)
            .join(Property, Property.id == OpportunityScore.property_id)
            .where(OpportunityScore.is_current.is_(True), Property.deleted_at.is_(None), eligible))
    stmt = apply_search(stmt, f.q, [Property.name, Property.address_line, Property.city, Property.county])
    if "band" not in skip:
        stmt = in_filter(stmt, OpportunityScore.band, f.band)
    if "property_type" not in skip:
        stmt = in_filter(stmt, Property.property_type, f.property_type)
    stmt = range_filter(stmt, OpportunityScore.score, f.min_score, f.max_score)
    stmt = range_filter(stmt, OpportunityScore.confidence, f.min_confidence, None)
    if f.needs_research is not None:
        stmt = stmt.where(OpportunityScore.needs_research.is_(f.needs_research))
    if f.territory_id:
        members = Base.metadata.tables.get("territory_members")
        if members is not None:
            stmt = stmt.where(OpportunityScore.property_id.in_(
                select(members.c.property_id).where(members.c.territory_id == f.territory_id)))
    return stmt


async def ranking_items(db: AsyncSession, rows: list[OpportunityScore], offset: int) -> list[dict]:
    from app.modules.properties.models import Property
    from app.modules.scoring.schemas import RankingItem

    if not rows:
        return []
    pids = {r.property_id for r in rows}
    props = {r.id: r for r in (await db.execute(select(
        Property.id, Property.name, Property.address_line, Property.city, Property.state, Property.property_type,
        Property.asking_price).where(Property.id.in_(pids)))).all()}
    # Previous score per property = latest non-current row.
    prev: dict[uuid.UUID, float] = {}
    sub = (select(OpportunityScore.property_id, OpportunityScore.score,
                  func.row_number().over(partition_by=OpportunityScore.property_id,
                                         order_by=OpportunityScore.computed_at.desc()).label("rn"))
           .where(OpportunityScore.property_id.in_(pids), OpportunityScore.is_current.is_(False)).subquery())
    for pid, score in (await db.execute(select(sub.c.property_id, sub.c.score).where(sub.c.rn == 1))).all():
        prev[pid] = score
    out = []
    for i, r in enumerate(rows):
        item = RankingItem.model_validate(r)
        p = props.get(r.property_id)
        if p:
            item.property_label = p.name or p.address_line
            item.property_city, item.property_state = p.city, p.state
            item.property_type, item.asking_price = p.property_type, p.asking_price
        item.position = offset + i + 1
        item.component_values = {c["key"]: c["value"] for c in (r.components or [])}
        item.top_positive = ((r.drivers or {}).get("positive") or [None])[0]
        item.top_negative = ((r.drivers or {}).get("negative") or [None])[0]
        item.previous_score = prev.get(r.property_id)
        out.append(item)
    return out


async def property_history(db: AsyncSession, property_id: uuid.UUID, limit: int = 100) -> list[OpportunityScore]:
    rows = list(await db.scalars(select(OpportunityScore).where(OpportunityScore.property_id == property_id)
                                 .order_by(OpportunityScore.computed_at.desc()).limit(limit)))
    return list(reversed(rows))


# ----------------------------------------------------------------------------- outcomes


async def log_outcome(db: AsyncSession, *, property_id: uuid.UUID, opportunity_id: uuid.UUID | None,
                      disposition: str, result: str = "open", actor=None, notes: str | None = None,
                      source: str = "event") -> ScoreOutcome:
    """Records a decision with the score at that moment; a final result closes earlier open outcomes. No commit."""
    now = utcnow()
    opp = None
    if opportunity_id:
        try:
            from app.modules.pipeline.models import Opportunity

            opp = await db.get(Opportunity, opportunity_id)
        except ImportError:
            opp = None
    if source == "event" and opportunity_id:
        stmt = select(ScoreOutcome).where(ScoreOutcome.opportunity_id == opportunity_id,
                                          ScoreOutcome.disposition == disposition, ScoreOutcome.deleted_at.is_(None))
        if result != "won":
            stmt = stmt.where(ScoreOutcome.decided_at >= now - timedelta(minutes=2))
        existing = await db.scalar(stmt.limit(1))
        if existing:
            return existing
    cur = await current_score(db, property_id)
    row = ScoreOutcome(
        property_id=property_id, opportunity_id=opportunity_id, disposition=disposition[:40], decided_at=now,
        score_at_decision=cur.score if cur else None, confidence_at_decision=cur.confidence if cur else None,
        band_at_decision=cur.band if cur else None, config_version=cur.config_version if cur else None,
        components_at_decision={c["key"]: c["value"] for c in (cur.components or [])} if cur else {},
        result=result, result_at=now if result != "open" else None,
        elapsed_days=round((now - opp.created_at).total_seconds() / 86400, 1) if opp is not None else None,
        source=source, notes=notes, created_by_id=getattr(actor, "id", None), updated_by_id=getattr(actor, "id", None),
    )
    db.add(row)
    await db.flush()
    if result in ("won", "lost") and opportunity_id:
        await db.execute(update(ScoreOutcome).where(
            ScoreOutcome.opportunity_id == opportunity_id, ScoreOutcome.result == "open", ScoreOutcome.id != row.id)
            .values(result=result, result_at=now))
    await audit.record(db, actor=actor, action="score_outcome.logged", entity_type="property", entity_id=property_id,
                       summary=f"{disposition.replace('_', ' ')} · {result}"
                               + (f" · score {cur.score}" if cur else " · unscored"))
    return row


async def outcome_summary(db: AsyncSession) -> dict:
    rows = (await db.execute(select(ScoreOutcome.result, ScoreOutcome.band_at_decision, ScoreOutcome.score_at_decision)
                             .where(ScoreOutcome.deleted_at.is_(None)))).all()
    counts = {"won": 0, "lost": 0, "open": 0}
    by_band: dict[str, dict[str, int]] = {}
    scores: dict[str, list[float]] = {"won": [], "lost": []}
    for result, band, score in rows:
        counts[result] = counts.get(result, 0) + 1
        b = by_band.setdefault(band or "unscored", {"won": 0, "lost": 0, "open": 0})
        b[result] = b.get(result, 0) + 1
        if score is not None and result in scores:
            scores[result].append(score)
    decided = await _decided(db)
    won = sum(1 for o in decided if o.result == "won")
    lost = len(decided) - won
    return {
        "total": len(rows), "won": counts["won"], "lost": counts["lost"], "open": counts["open"],
        "avg_score_won": round(sum(scores["won"]) / len(scores["won"]), 1) if scores["won"] else None,
        "avg_score_lost": round(sum(scores["lost"]) / len(scores["lost"]), 1) if scores["lost"] else None,
        "by_band": by_band,
        "recalibration_ready": len(decided) >= MIN_OUTCOMES["total"] and won >= MIN_OUTCOMES["won"]
                               and lost >= MIN_OUTCOMES["lost"],
        "min_required": MIN_OUTCOMES,
    }


async def _decided(db: AsyncSession) -> list[ScoreOutcome]:
    """Latest decided outcome per opportunity (or per manual row) with recorded component values."""
    rows = list(await db.scalars(select(ScoreOutcome).where(
        ScoreOutcome.deleted_at.is_(None), ScoreOutcome.result.in_(["won", "lost"]))
        .order_by(ScoreOutcome.decided_at.desc())))
    seen: set = set()
    out = []
    for r in rows:
        if not r.components_at_decision:
            continue
        key = r.opportunity_id or r.id
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


async def propose_recalibration(db: AsyncSession, actor) -> ScoreConfig:
    """Explainable recalibration: shift each weight by how well the component separated won from lost deals."""
    decided = await _decided(db)
    won = [o for o in decided if o.result == "won"]
    lost = [o for o in decided if o.result == "lost"]
    if len(decided) < MIN_OUTCOMES["total"] or len(won) < MIN_OUTCOMES["won"] or len(lost) < MIN_OUTCOMES["lost"]:
        raise HTTPException(422, f"Recalibration needs at least {MIN_OUTCOMES['total']} decided outcomes with "
                                 f"{MIN_OUTCOMES['won']} won and {MIN_OUTCOMES['lost']} lost; have {len(decided)} "
                                 f"({len(won)} won, {len(lost)} lost)")
    base = await active_config(db)
    old = {k: float((base.weights or DEFAULT_WEIGHTS).get(k, DEFAULT_WEIGHTS[k])) for k in COMPONENTS}

    def mean(rows: list[ScoreOutcome], key: str) -> float:
        vals = [float(r.components_at_decision.get(key)) for r in rows if r.components_at_decision.get(key) is not None]
        return sum(vals) / len(vals) if vals else 0.0

    basis: dict[str, Any] = {"samples": len(decided), "won": len(won), "lost": len(lost), "components": {}}
    new: dict[str, float] = {}
    for k in COMPONENTS:
        mw, ml = mean(won, k), mean(lost, k)
        separation = (ml - mw) if k == "negative_risk" else (mw - ml)
        factor = 1 + _clamp(separation / 50, -0.5, 0.5)
        new[k] = old[k] * factor
        basis["components"][k] = {"won_mean": round(mw, 1), "lost_mean": round(ml, 1),
                                  "separation": round(separation, 1), "factor": round(factor, 3),
                                  "old_weight": round(old[k], 4)}
    old_sum = sum(old[k] for k in VALUE_COMPONENTS) or 1.0
    new_sum = sum(new[k] for k in VALUE_COMPONENTS) or 1.0
    for k in VALUE_COMPONENTS:
        new[k] = round(new[k] * old_sum / new_sum, 4)
    new["negative_risk"] = round(_clamp(new["negative_risk"], 0, 0.5), 4)
    for k in COMPONENTS:
        basis["components"][k]["new_weight"] = new[k]
    data = ConfigIn(name=f"Recalibration of v{base.version}", weights=new, band_thresholds=base.band_thresholds,
                    alert_threshold=base.alert_threshold, high_dollar_threshold=base.high_dollar_threshold,
                    notes="Proposed from won vs lost component averages. Requires approval to activate.")
    return await create_config(db, data, actor, status_="proposed", source="recalibration", basis=basis,
                               based_on=base.version)


async def create_manual_outcome(db: AsyncSession, data: OutcomeIn, actor) -> ScoreOutcome:
    from app.modules.properties.models import Property

    p = await db.get(Property, data.property_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    row = await log_outcome(db, property_id=p.id, opportunity_id=data.opportunity_id, disposition=data.disposition,
                            result=data.result, actor=actor, notes=data.notes, source="manual")
    await db.commit()
    return row
