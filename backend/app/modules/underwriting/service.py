"""Underwriting & financial modeling (spec module 12).

Versioned, source-linked models. Drafts are edited in place; editing any submitted/approved/rejected/superseded
version creates a new draft version (prior versions are never changed). Approval checks the approver's
underwriting limit against the purchase price and locks the approved version; earlier approved versions of the same
model become `superseded`. Calculations live in `engine.py` (pure functions).
"""
import asyncio
import copy
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.database import Base
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.underwriting import engine
from app.modules.underwriting.models import UwModel, UwModelEvent
from app.modules.underwriting.schemas import (
    AssumptionsIn,
    DecisionIn,
    ModelCreate,
    ModelListItem,
    ModelOut,
    ModelUpdate,
    ScenariosIn,
    SimulateIn,
)
from app.modules.underwriting.templates import TEMPLATES, lease_row, seed, sv

ENTITY = "uw_model"
EDITABLE = {"draft"}


# --------------------------------------------------------------------------- lookups


async def get(db: AsyncSession, model_id: uuid.UUID) -> UwModel:
    m = await db.get(UwModel, model_id)
    if not m or m.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Underwriting model not found")
    return m


async def get_approved(db: AsyncSession, model_id: uuid.UUID) -> UwModel:
    """Public contract: the approved (locked) model version, or 422 when the version is not approved."""
    m = await get(db, model_id)
    if m.status != "approved":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Underwriting model version is not approved")
    return m


async def _user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))
    return {r[0]: r[1] for r in rows.all()}


async def _property_labels(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    from app.modules.properties.models import Property

    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(Property.id, Property.name, Property.address_line).where(Property.id.in_(ids)))
    return {r[0]: r[1] or r[2] for r in rows.all()}


async def _opportunity_label(db: AsyncSession, opp_id: uuid.UUID | None) -> str | None:
    if not opp_id:
        return None
    try:
        from app.modules.pipeline.models import Opportunity
    except ImportError:
        return None
    return await db.scalar(select(Opportunity.title).where(Opportunity.id == opp_id))


# --------------------------------------------------------------------------- list


@dataclass
class ModelFilters:
    q: str | None = None
    status: list[str] | None = None
    template: list[str] | None = None
    property_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    root_id: uuid.UUID | None = None
    latest_only: bool = True
    locked: bool | None = None


def build_query(f: ModelFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(UwModel).where(UwModel.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [UwModel.name])
    if "status" not in skip:
        stmt = in_filter(stmt, UwModel.status, f.status)
    if "template" not in skip:
        stmt = in_filter(stmt, UwModel.template, f.template)
    if f.property_id:
        stmt = stmt.where(UwModel.property_id == f.property_id)
    if f.opportunity_id:
        stmt = stmt.where(UwModel.opportunity_id == f.opportunity_id)
    if f.root_id:
        stmt = stmt.where(UwModel.root_id == f.root_id)
    if f.latest_only and not f.root_id:
        stmt = stmt.where(UwModel.is_latest.is_(True))
    if f.locked is not None:
        stmt = stmt.where(UwModel.is_locked.is_(f.locked))
    return stmt


async def to_items(db: AsyncSession, rows: list[UwModel]) -> list[ModelListItem]:
    labels = await _property_labels(db, {r.property_id for r in rows})
    items = []
    for r in rows:
        item = ModelListItem.model_validate(r)
        o = r.outputs or {}
        item.property_label = labels.get(r.property_id) if r.property_id else None
        item.purchase_price = o.get("purchase_price")
        item.irr = o.get("irr")
        item.going_in_cap = o.get("going_in_cap")
        item.equity_multiple = o.get("equity_multiple")
        item.unsourced_count = len(r.unsourced or [])
        items.append(item)
    return items


async def to_out(db: AsyncSession, m: UwModel, actor: CurrentUser | None = None) -> ModelOut:
    out = ModelOut.model_validate(m)
    names = await _user_names(db, {m.submitted_by_id, m.approved_by_id, m.created_by_id})
    out.submitted_by_name = names.get(m.submitted_by_id) if m.submitted_by_id else None
    out.approved_by_name = names.get(m.approved_by_id) if m.approved_by_id else None
    out.created_by_name = names.get(m.created_by_id) if m.created_by_id else None
    if m.property_id:
        out.property_label = (await _property_labels(db, {m.property_id})).get(m.property_id)
    out.opportunity_label = await _opportunity_label(db, m.opportunity_id)
    if actor:
        out.can_approve_amount = actor.can("underwriting", "approve") and actor.can_approve(
            "underwriting", (m.outputs or {}).get("purchase_price"))
    return out


# --------------------------------------------------------------------------- calculation


def _calculate(assumptions: dict, scenarios: list[dict]) -> tuple[dict, list[dict]]:
    try:
        result = engine.run(assumptions)
        scen_out = []
        for s in scenarios:
            outputs = result["outputs"] if not s.get("overrides") else engine.run(
                engine.apply_overrides(assumptions, s.get("overrides")))["outputs"]
            scen_out.append({**s, "outputs": {k: v for k, v in outputs.items() if not isinstance(v, list)}})
    except (ValueError, TypeError, ZeroDivisionError, OverflowError, KeyError, AttributeError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Calculation failed: {e}")
    return result, scen_out


async def recalc(m: UwModel) -> None:
    """Re-run the engine for the base case and every scenario and store outputs on the version."""
    a = m.assumptions or {}
    result, scenarios = await asyncio.to_thread(_calculate, a, list(m.scenarios or []))
    m.outputs = result["outputs"]
    m.annual = result["annual"]
    m.warnings = result["warnings"]
    m.scenarios = scenarios
    m.unsourced = engine.unsourced(a)
    m.calculated_at = utcnow()


async def _event(db: AsyncSession, m: UwModel, action: str, actor: CurrentUser | None, note: str | None = None,
                 **details: Any) -> None:
    db.add(UwModelEvent(model_id=m.id, root_id=m.root_id, action=action, actor_id=getattr(actor, "id", None),
                        actor_name=getattr(actor, "full_name", None), note=note, details=audit.to_jsonable(details)))


# --------------------------------------------------------------------------- seeding


def _table(name: str):
    return Base.metadata.tables.get(name)


async def _tenant_rows(db: AsyncSession, template: str, property_id: uuid.UUID | None, mode: str, start: date) -> list[dict]:
    """Seed lease rows from the leases module when installed (lazy, via table metadata), else from spaces."""
    rows: list[dict] = []
    if template == "land":
        return rows
    if property_id and mode in ("auto", "leases"):
        leases_t, steps_t = _table("leases"), _table("rent_steps")
        if leases_t is not None:
            stmt = select(leases_t).where(leases_t.c.property_id == property_id, leases_t.c.status.in_(["active", "draft"]))
            if "deleted_at" in leases_t.c:
                stmt = stmt.where(leases_t.c.deleted_at.is_(None))
            for lease in (await db.execute(stmt)).mappings().all():
                steps: list[dict] = []
                if steps_t is not None:
                    steps = [dict(s) for s in (await db.execute(
                        select(steps_t).where(steps_t.c.lease_id == lease["id"]).order_by(steps_t.c.start_on))).mappings().all()]
                current = None
                for s in steps:
                    if s.get("start_on") and s["start_on"] <= start:
                        current = s
                current = current or (steps[0] if steps else None)
                verified = " (verified)" if lease.get("verified") else ""
                rows.append(lease_row(
                    template, tenant=lease.get("tenant_name"),
                    space_id=str(lease["space_id"]) if lease.get("space_id") else None, lease_id=str(lease["id"]),
                    area_sf=float(lease["rentable_sf"]) if lease.get("rentable_sf") is not None else None,
                    base_rent_annual=float(current["annual_rent"]) if current and current.get("annual_rent") is not None else None,
                    rent_source=f"Lease abstract{verified}" if current else None,
                    commencement_on=lease["commencement_on"].isoformat() if lease.get("commencement_on") else None,
                    expiration_on=lease["expiration_on"].isoformat() if lease.get("expiration_on") else None,
                    rent_steps=[{"start_on": s["start_on"].isoformat(), "annual_rent": float(s["annual_rent"])}
                                for s in steps if s.get("start_on") and s["start_on"] > start and s.get("annual_rent") is not None],
                    source="lease",
                ))
            if rows or mode == "leases":
                return rows
    if property_id and mode in ("auto", "spaces"):
        from app.modules.parcels.models import Space

        spaces = list(await db.scalars(select(Space).where(Space.property_id == property_id, Space.deleted_at.is_(None))
                                       .order_by(Space.suite)))
        for s in spaces:
            rows.append(lease_row(template, tenant=s.tenant_name, suite=s.suite, space_id=str(s.id), area_sf=s.area_sf,
                                  vacant=s.occupancy_status == "vacant", source="space"))
    if not rows and mode != "none":
        rows.append(lease_row(template, source="manual"))
    return rows


async def _apply_comp_set(db: AsyncSession, a: dict, comp_set_id: uuid.UUID) -> None:
    """Seed exit cap (sale comp set on cap-rate basis) or market rent (lease comp set) with comp evidence."""
    from app.modules.comps import service as comps_service

    summary = await comps_service.comp_set_summary(db, comp_set_id)
    if not summary or summary.get("metric_point") is None:
        return
    evidence = {"comp_set_id": str(comp_set_id), "comp_ids": summary["comp_ids"],
                "comp_id": summary["comp_ids"][0] if summary["comp_ids"] else None}
    source = f"Comp set: {summary['name']}"
    if summary["kind"] == "sale" and summary["value_basis"] == "cap_rate" and "exit" in a:
        a["exit"]["exit_cap"] = sv(round(summary["metric_point"], 3), source, **evidence)
    elif summary["kind"] == "lease":
        for lease in a.get("leases") or []:
            if not engine.has_val(lease.get("market_rent_psf")):
                lease["market_rent_psf"] = sv(round(summary["metric_point"], 2), source, **evidence)


# --------------------------------------------------------------------------- create / edit / versions


async def create(db: AsyncSession, data: ModelCreate, actor: CurrentUser) -> UwModel:
    from app.modules.properties.models import Property

    prop = None
    if data.property_id:
        prop = await db.get(Property, data.property_id)
        if not prop or prop.deleted_at:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    start = data.analysis_start or date.today()
    assumptions = seed(
        data.template, start=start,
        purchase_price=prop.asking_price if prop else None,
        price_source="Property record: asking price" if prop and prop.asking_price else None,
        total_area_sf=prop.building_area_sf if prop else None,
        area_source="Property record" if prop and prop.building_area_sf else None,
        gross_acres=prop.land_area_acres if prop else None,
        acres_source="Property record" if prop and prop.land_area_acres else None,
    )
    scenarios = assumptions.pop("scenarios_seed", [])
    if TEMPLATES[data.template]["model_type"] == "income":
        assumptions["leases"] = await _tenant_rows(db, data.template, data.property_id, data.seed_tenants, start)
    if data.comp_set_id:
        await _apply_comp_set(db, assumptions, data.comp_set_id)

    m = UwModel(
        name=data.name, template=data.template, property_id=data.property_id, opportunity_id=data.opportunity_id,
        comp_set_id=data.comp_set_id, version=1, is_latest=True, status="draft", is_locked=False,
        assumptions=assumptions, scenarios=copy.deepcopy(scenarios), created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(m)
    await db.flush()
    m.root_id = m.id
    await recalc(m)
    await _event(db, m, "created", actor, template=data.template)
    await audit.record(db, actor=actor, action="uw_model.created", entity_type=ENTITY, entity_id=m.id,
                       summary=f"{m.name} v1 ({TEMPLATES[data.template]['label']})", ip_address=actor.ip_address)
    await db.commit()
    return m


async def _next_version(db: AsyncSession, root_id: uuid.UUID) -> int:
    return int(await db.scalar(select(func.max(UwModel.version)).where(UwModel.root_id == root_id)) or 0) + 1


async def new_version(db: AsyncSession, src: UwModel, actor: CurrentUser, *, note: str | None,
                      assumptions: dict | None = None, scenarios: list[dict] | None = None, commit: bool = True) -> UwModel:
    """Copy a version into a new draft version; the source version is left untouched."""
    root = src.root_id or src.id
    version = await _next_version(db, root)
    await db.execute(update(UwModel).where(UwModel.root_id == root).values(is_latest=False))
    m = UwModel(
        root_id=root, parent_id=src.id, property_id=src.property_id, opportunity_id=src.opportunity_id,
        comp_set_id=src.comp_set_id, version=version, is_latest=True, name=src.name, template=src.template,
        status="draft", is_locked=False, change_note=note,
        assumptions=copy.deepcopy(assumptions if assumptions is not None else src.assumptions),
        scenarios=copy.deepcopy(scenarios if scenarios is not None else src.scenarios),
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(m)
    await db.flush()
    await recalc(m)
    await _event(db, m, "versioned", actor, note, from_version=src.version, from_id=str(src.id))
    await audit.record(db, actor=actor, action="uw_model.versioned", entity_type=ENTITY, entity_id=m.id,
                       summary=f"{m.name} v{version} from v{src.version}", changes={"note": note},
                       ip_address=actor.ip_address)
    if commit:
        await db.commit()
    return m


def _normalize(m: UwModel, a: dict) -> dict:
    a = copy.deepcopy(a)
    a["template"] = m.template
    a["model_type"] = TEMPLATES.get(m.template, {}).get("model_type", "income")
    return a


async def save_assumptions(db: AsyncSession, m: UwModel, data: AssumptionsIn, actor: CurrentUser) -> UwModel:
    assumptions = _normalize(m, data.assumptions)
    if m.status not in EDITABLE:
        return await new_version(db, m, actor, note=data.change_note or f"Edited from v{m.version}", assumptions=assumptions)
    changes = engine.diff_assumptions(m.assumptions or {}, assumptions)
    if not changes:
        return m
    m.assumptions = assumptions
    if data.change_note:
        m.change_note = data.change_note
    m.updated_by_id = actor.id
    await recalc(m)
    await audit.record(db, actor=actor, action="uw_model.assumptions_updated", entity_type=ENTITY, entity_id=m.id,
                       changes={"assumptions": changes[:200]}, summary=f"{len(changes)} assumption changes",
                       ip_address=actor.ip_address)
    await db.commit()
    return m


def _clean_scenarios(data: ScenariosIn) -> list[dict]:
    out, seen = [], set()
    for s in data.scenarios:
        key = (s.key or s.name).strip().lower().replace(" ", "_")[:60] or uuid.uuid4().hex[:8]
        while key in seen:
            key = f"{key}_{uuid.uuid4().hex[:4]}"
        seen.add(key)
        out.append({"key": key, "name": s.name, "kind": s.kind, "overrides": s.overrides if s.kind != "base" else {}})
    if not any(s["kind"] == "base" for s in out):
        out.insert(0, {"key": "base", "name": "Base", "kind": "base", "overrides": {}})
    return out


async def save_scenarios(db: AsyncSession, m: UwModel, data: ScenariosIn, actor: CurrentUser) -> UwModel:
    scenarios = _clean_scenarios(data)
    if m.status not in EDITABLE:
        return await new_version(db, m, actor, note=data.change_note or f"Scenarios edited from v{m.version}",
                                 scenarios=scenarios)
    before = [{k: s.get(k) for k in ("key", "name", "kind", "overrides")} for s in (m.scenarios or [])]
    m.scenarios = scenarios
    m.updated_by_id = actor.id
    await recalc(m)
    await audit.record(db, actor=actor, action="uw_model.scenarios_updated", entity_type=ENTITY, entity_id=m.id,
                       changes={"scenarios": {"from": before, "to": scenarios}}, ip_address=actor.ip_address)
    await db.commit()
    return m


async def update_meta(db: AsyncSession, m: UwModel, data: ModelUpdate, actor: CurrentUser) -> UwModel:
    if m.is_locked:
        raise HTTPException(status.HTTP_409_CONFLICT, "Approved versions are locked")
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(m, values)
    if not changes:
        return m
    for k, v in values.items():
        setattr(m, k, v)
    m.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="uw_model.updated", entity_type=ENTITY, entity_id=m.id, changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return m


async def recalculate(db: AsyncSession, m: UwModel, actor: CurrentUser) -> UwModel:
    if m.status not in EDITABLE:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft versions are recalculated; create a new version")
    await recalc(m)
    m.updated_by_id = actor.id
    await db.commit()
    return m


async def archive(db: AsyncSession, m: UwModel, actor: CurrentUser) -> None:
    if m.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft versions can be deleted; others are retained as history")
    m.deleted_at = utcnow()
    m.updated_by_id = actor.id
    if m.is_latest and m.root_id:
        prev = await db.scalar(select(UwModel).where(UwModel.root_id == m.root_id, UwModel.id != m.id,
                                                      UwModel.deleted_at.is_(None)).order_by(UwModel.version.desc()))
        m.is_latest = False
        if prev:
            prev.is_latest = True
    await audit.record(db, actor=actor, action="uw_model.deleted", entity_type=ENTITY, entity_id=m.id,
                       summary=f"{m.name} v{m.version}", ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- approval workflow


async def submit(db: AsyncSession, m: UwModel, data: DecisionIn, actor: CurrentUser) -> UwModel:
    if m.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, f"A {m.status} version cannot be submitted")
    await recalc(m)
    if not (m.outputs or {}).get("purchase_price"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Purchase price is required before submitting")
    m.status = "submitted"
    m.submitted_by_id, m.submitted_at = actor.id, utcnow()
    m.decision_note = None
    m.updated_by_id = actor.id
    await _event(db, m, "submitted", actor, data.note, unsourced=len(m.unsourced or []),
                 purchase_price=m.outputs.get("purchase_price"))
    await audit.record(db, actor=actor, action="uw_model.submitted", entity_type=ENTITY, entity_id=m.id,
                       summary=f"{m.name} v{m.version}", changes={"unsourced": m.unsourced}, ip_address=actor.ip_address)
    await db.commit()
    return m


async def approve(db: AsyncSession, m: UwModel, data: DecisionIn, actor: CurrentUser) -> UwModel:
    if m.status != "submitted":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only submitted versions can be approved")
    amount = (m.outputs or {}).get("purchase_price")
    if not actor.can_approve("underwriting", amount):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Purchase price exceeds your underwriting approval limit")
    if m.unsourced and not data.acknowledge_unsourced:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {
            "message": f"{len(m.unsourced)} material assumptions are unsourced; acknowledge to approve",
            "unsourced": m.unsourced,
        })
    root = m.root_id or m.id
    superseded = list(await db.scalars(select(UwModel).where(UwModel.root_id == root, UwModel.status == "approved",
                                                              UwModel.id != m.id)))
    for prev in superseded:
        prev.status = "superseded"
        await _event(db, prev, "superseded", actor, f"Superseded by v{m.version}")
    m.status = "approved"
    m.is_locked = True
    m.approved_by_id, m.approved_at = actor.id, utcnow()
    m.decision_note = data.note
    m.updated_by_id = actor.id
    await _event(db, m, "approved", actor, data.note, purchase_price=amount, unsourced=len(m.unsourced or []),
                 acknowledged_unsourced=data.acknowledge_unsourced)
    await audit.record(db, actor=actor, action="uw_model.approved", entity_type=ENTITY, entity_id=m.id,
                       summary=f"{m.name} v{m.version}", changes={"purchase_price": amount, "note": data.note,
                                                                  "superseded": [str(p.id) for p in superseded]},
                       ip_address=actor.ip_address)
    await events.emit(db, "uw_model.approved", model_id=m.id, property_id=m.property_id,
                      opportunity_id=m.opportunity_id, actor=actor)
    await db.commit()
    return m


async def reject(db: AsyncSession, m: UwModel, data: DecisionIn, actor: CurrentUser) -> UwModel:
    if m.status != "submitted":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only submitted versions can be rejected")
    if not (data.note or "").strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A rejection reason is required")
    m.status = "rejected"
    m.rejected_by_id, m.rejected_at = actor.id, utcnow()
    m.decision_note = data.note
    m.updated_by_id = actor.id
    await _event(db, m, "rejected", actor, data.note)
    await audit.record(db, actor=actor, action="uw_model.rejected", entity_type=ENTITY, entity_id=m.id,
                       summary=f"{m.name} v{m.version}", changes={"note": data.note}, ip_address=actor.ip_address)
    await db.commit()
    return m


# --------------------------------------------------------------------------- versions / diff


async def versions(db: AsyncSession, m: UwModel) -> list[dict]:
    rows = list(await db.scalars(select(UwModel).where(UwModel.root_id == (m.root_id or m.id), UwModel.deleted_at.is_(None))
                                 .order_by(UwModel.version.desc())))
    names = await _user_names(db, {r.created_by_id for r in rows})
    return [{
        "id": r.id, "version": r.version, "status": r.status, "is_locked": r.is_locked, "is_latest": r.is_latest,
        "change_note": r.change_note, "created_by_name": names.get(r.created_by_id) if r.created_by_id else None,
        "created_at": r.created_at, "approved_at": r.approved_at,
        "purchase_price": (r.outputs or {}).get("purchase_price"), "irr": (r.outputs or {}).get("irr"),
    } for r in rows]


DIFF_OUTPUTS = ["purchase_price", "noi_year1", "going_in_cap", "stabilized_cap", "loan_amount", "dscr", "debt_yield",
                "cash_on_cash", "unlevered_irr", "irr", "equity_multiple", "exit_value", "peak_equity",
                "breakeven_occupancy", "profit"]


async def diff(db: AsyncSession, m: UwModel, other_id: uuid.UUID | None) -> dict:
    if other_id:
        other = await get(db, other_id)
        if (other.root_id or other.id) != (m.root_id or m.id):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Versions belong to different models")
    elif m.parent_id:
        other = await get(db, m.parent_id)
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "No earlier version to compare against")
    outs = []
    for k in DIFF_OUTPUTS:
        a, b = (other.outputs or {}).get(k), (m.outputs or {}).get(k)
        if a != b:
            outs.append({"key": k, "from": a, "to": b,
                         "delta": (b - a) if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None})
    return {"base_id": other.id, "other_id": m.id, "base_version": other.version, "other_version": m.version,
            "assumptions": engine.diff_assumptions(other.assumptions or {}, m.assumptions or {}), "outputs": outs}


async def events_for(db: AsyncSession, m: UwModel) -> list[UwModelEvent]:
    return list(await db.scalars(select(UwModelEvent).where(UwModelEvent.root_id == (m.root_id or m.id))
                                 .order_by(UwModelEvent.at.desc())))


# --------------------------------------------------------------------------- analysis


def _scenario_assumptions(m: UwModel, scenario_key: str | None) -> dict:
    a = m.assumptions or {}
    if scenario_key:
        s = next((s for s in (m.scenarios or []) if s.get("key") == scenario_key), None)
        if s is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Scenario not found")
        a = engine.apply_overrides(a, s.get("overrides"))
    return a


async def sensitivity(m: UwModel, metric: str, scenario_key: str | None, steps: dict[str, float]) -> dict:
    a = _scenario_assumptions(m, scenario_key)
    try:
        return await asyncio.to_thread(engine.sensitivity, a, metric, steps)
    except (ValueError, TypeError, ZeroDivisionError, OverflowError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Sensitivity failed: {e}")


async def simulate(db: AsyncSession, m: UwModel, data: SimulateIn, actor: CurrentUser) -> dict:
    a = _scenario_assumptions(m, data.scenario_key)
    try:
        result = await asyncio.to_thread(
            engine.simulate, a, [r.model_dump() for r in data.ranges], data.iterations, data.seed,
            ("irr", "equity_multiple", "exit_value", "noi_year1", "profit"), data.target_irr,
        )
    except (ValueError, TypeError, ZeroDivisionError, OverflowError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Simulation failed: {e}")
    result["run_at"] = utcnow().isoformat()
    result["run_by"] = actor.full_name
    result["stored"] = not m.is_locked and actor.can("underwriting", "edit")
    if result["stored"]:
        m.simulation = result
        m.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="uw_model.simulated", entity_type=ENTITY, entity_id=m.id,
                       summary=f"{result['iterations']} iterations, seed {data.seed}", ip_address=actor.ip_address)
    await db.commit()
    return result


async def variance(db: AsyncSession, m: UwModel) -> dict:
    """Actual (asset_financials) vs approved underwriting by analysis year. Reads the assets module lazily."""
    if m.status not in ("approved", "superseded"):
        approved = await db.scalar(select(UwModel).where(UwModel.root_id == (m.root_id or m.id),
                                                          UwModel.status == "approved", UwModel.deleted_at.is_(None)))
        if not approved:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Variance is measured against an approved version")
        m = approved
    base = {"model_id": str(m.id), "version": m.version, "available": False, "rows": [], "asset_id": None}
    assets_t, fin_t = _table("assets"), _table("asset_financials")
    if assets_t is None or fin_t is None:
        return {**base, "reason": "Asset management is not available yet; actuals will appear after closing."}
    stmt = select(assets_t.c.id).where(assets_t.c.uw_model_id == m.id)
    asset_id = await db.scalar(stmt)
    if not asset_id and m.property_id:
        asset_id = await db.scalar(select(assets_t.c.id).where(assets_t.c.property_id == m.property_id))
    if not asset_id:
        return {**base, "reason": "No owned asset is linked to this model or its property."}

    start = engine.parse_date((m.assumptions or {}).get("acquisition", {}).get("analysis_start")) or date.today()
    rows = (await db.execute(
        select(fin_t.c.period, fin_t.c.category, func.sum(fin_t.c.amount)).where(fin_t.c.asset_id == asset_id)
        .group_by(fin_t.c.period, fin_t.c.category)
    )).all()
    actual: dict[int, dict[str, float]] = {}
    months: dict[int, set] = {}
    for period, category, amount in rows:
        if not period:
            continue
        idx = engine.month_index(start.replace(day=1), period)
        if idx < 0:
            continue
        year = idx // 12 + 1
        bucket = actual.setdefault(year, {})
        bucket[category] = bucket.get(category, 0.0) + float(amount or 0)
        months.setdefault(year, set()).add((period.year, period.month))

    def var(uw: float | None, act: float | None) -> dict:
        d = (act - uw) if uw is not None and act is not None else None
        return {"uw": uw, "actual": act, "variance": d, "variance_pct": (d / abs(uw) * 100) if d is not None and uw else None}

    out_rows = []
    for row in m.annual or []:
        y = row.get("year")
        if y not in actual:
            continue
        frac = len(months.get(y, set())) / 12
        a = actual[y]
        income, expense = a.get("income", 0.0), a.get("expense", 0.0)
        uw_income = row.get("egr", row.get("revenue"))
        uw_opex = row.get("opex", (row.get("development", 0) or 0) + (row.get("carry", 0) or 0))
        uw_capex = sum(row.get(k, 0) or 0 for k in ("ti", "lc", "reserves", "capex"))
        scale = (lambda v: v * frac if v is not None else None)
        out_rows.append({
            "year": y, "months_actual": len(months.get(y, set())),
            "income": var(scale(uw_income), income), "expense": var(scale(uw_opex), expense),
            "noi": var(scale(row.get("noi")), income - expense if ("income" in a or "expense" in a) else None),
            "capex": var(scale(uw_capex), a.get("capex")),
            "debt_service": var(scale(row.get("debt_service")), a.get("debt_service")),
        })
    return {**base, "available": True, "asset_id": str(asset_id), "rows": out_rows,
            "reason": None if out_rows else "No actuals recorded yet for the modeled years."}
