import calendar
import re
import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.maintenance.models import (
    PM_FREQUENCIES,
    SEVERITIES,
    WO_TRANSITIONS,
    Inspection,
    InspectionFinding,
    InspectionTemplate,
    MaintenanceSettings,
    PMSchedule,
    WorkOrder,
)
from app.modules.maintenance.schemas import (
    AssignIn,
    CostIn,
    FindingIn,
    FindingOut,
    FindingUpdate,
    InspectionCreate,
    InspectionListItem,
    InspectionOut,
    InspectionUpdate,
    PMScheduleIn,
    PMScheduleOut,
    ResponseIn,
    ResponsibilityIn,
    SettingsIn,
    TemplateIn,
    TemplateOut,
    TransitionIn,
    WorkOrderCreate,
    WorkOrderListItem,
    WorkOrderOut,
    WorkOrderUpdate,
)
from app.modules.properties.models import Property
from app.modules.tasks.service import create_task, raise_alert

WO = "work_order"
EVIDENCE_ENTITY = "work_order_evidence"


def _delta(before: dict, after: dict) -> dict:
    return {k: {"from": audit.to_jsonable(before.get(k)), "to": audit.to_jsonable(v)}
            for k, v in after.items() if before.get(k) != v}


def _404(what: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")


def _422(message: str, **extra) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"message": message, **extra} if extra else message)


# ======================================================================= cross-module helpers (guarded)

async def link_documents(db: AsyncSession, ids: list[uuid.UUID] | None, entity_type: str, entity_id: uuid.UUID,
                         actor: CurrentUser) -> None:
    """Link uploaded documents to a record through the documents module when it is installed."""
    if not ids:
        return
    try:
        from app.modules.documents import service as documents
    except ImportError:
        return
    for doc_id in ids:
        await documents.link(db, doc_id, entity_type, entity_id, actor)


async def linked_document_count(db: AsyncSession, entity_type: str, entity_id: uuid.UUID) -> int:
    try:
        from app.modules.documents.models import DocumentLink
    except ImportError:
        return 0
    return int(await db.scalar(
        select(func.count()).select_from(DocumentLink)
        .where(DocumentLink.entity_type == entity_type, DocumentLink.entity_id == entity_id)
    ) or 0)


async def vendor_compliance(db: AsyncSession, vendor_id: uuid.UUID) -> tuple[bool, list[str]]:
    try:
        from app.modules.operations.service import vendor_is_compliant
    except ImportError:
        return True, []
    return await vendor_is_compliant(db, vendor_id)


async def _asset_for_property(db: AsyncSession, property_id: uuid.UUID) -> uuid.UUID | None:
    try:
        from app.modules.assets.models import Asset
    except ImportError:
        return None
    return await db.scalar(select(Asset.id).where(Asset.property_id == property_id).limit(1))


async def _property_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, tuple[str, str | None]]:
    if not ids:
        return {}
    rows = await db.execute(select(Property.id, Property.name, Property.address_line, Property.property_type)
                            .where(Property.id.in_(ids)))
    return {r.id: (r.name or r.address_line, r.property_type) for r in rows.all()}


async def _user_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))
    return {r.id: r.full_name for r in rows.all()}


async def _vendor_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    try:
        from app.modules.operations.models import Vendor
    except ImportError:
        return {}
    rows = await db.execute(select(Vendor.id, Vendor.name).where(Vendor.id.in_(ids)))
    return {r.id: r.name for r in rows.all()}


# ======================================================================= settings

async def get_settings(db: AsyncSession) -> MaintenanceSettings:
    s = await db.scalar(select(MaintenanceSettings).where(MaintenanceSettings.deleted_at.is_(None)).limit(1))
    if s is None:
        s = MaintenanceSettings(approval_threshold=5000, finding_auto_wo_severity="high", pm_default_lead_days=14)
        db.add(s)
        await db.flush()
    return s


async def update_settings(db: AsyncSession, data: SettingsIn, actor: CurrentUser) -> MaintenanceSettings:
    s = await get_settings(db)
    changes = audit.diff(s, data.model_dump())
    for k, v in data.model_dump().items():
        setattr(s, k, v)
    s.updated_by_id = actor.id
    if changes:
        await audit.record(db, actor=actor, action="maintenance_settings.updated", entity_type="maintenance_settings",
                           entity_id=s.id, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return s


# ======================================================================= work orders: query

@dataclass
class WorkOrderFilters:
    q: str | None = None
    status: list[str] | None = None
    priority: list[str] | None = None
    category: list[str] | None = None
    source: list[str] | None = None
    approval_status: list[str] | None = None
    tenant_responsibility: list[str] | None = None
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    space_id: uuid.UUID | None = None
    vendor_id: uuid.UUID | None = None
    assigned_user_id: uuid.UUID | None = None
    pm_schedule_id: uuid.UUID | None = None
    inspection_id: uuid.UUID | None = None
    due_from: date | None = None
    due_to: date | None = None
    min_cost: float | None = None
    max_cost: float | None = None
    overdue: bool | None = None
    open_only: bool | None = None


def build_query(f: WorkOrderFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(WorkOrder).where(WorkOrder.deleted_at.is_(None))
    if f.q:
        stmt = stmt.outerjoin(Property, Property.id == WorkOrder.property_id)
        stmt = apply_search(stmt, f.q, [WorkOrder.title, WorkOrder.description, WorkOrder.system,
                                        WorkOrder.location_detail, WorkOrder.requested_by_name,
                                        Property.name, Property.address_line])
    for key in ("status", "priority", "category", "source", "approval_status", "tenant_responsibility"):
        if key not in skip:
            stmt = in_filter(stmt, getattr(WorkOrder, key), getattr(f, key))
    for key in ("property_id", "asset_id", "space_id", "vendor_id", "assigned_user_id", "pm_schedule_id", "inspection_id"):
        value = getattr(f, key)
        if value:
            stmt = stmt.where(getattr(WorkOrder, key) == value)
    stmt = range_filter(stmt, WorkOrder.due_on, f.due_from, f.due_to)
    stmt = range_filter(stmt, func.coalesce(WorkOrder.actual_cost, WorkOrder.estimate_amount), f.min_cost, f.max_cost)
    if f.overdue:
        stmt = stmt.where(WorkOrder.due_on < date.today(), WorkOrder.status.in_(["open", "assigned", "in_progress"]))
    if f.open_only:
        stmt = stmt.where(WorkOrder.status.in_(["open", "assigned", "in_progress"]))
    return stmt


async def decorate(db: AsyncSession, rows: list[WorkOrder]) -> list[WorkOrderListItem]:
    props = await _property_names(db, {r.property_id for r in rows})
    users = await _user_names(db, {r.assigned_user_id for r in rows if r.assigned_user_id})
    vendors = await _vendor_names(db, {r.vendor_id for r in rows if r.vendor_id})
    out = []
    for r in rows:
        item = WorkOrderListItem.model_validate(r)
        item.property_name = props.get(r.property_id, (None, None))[0]
        item.assignee_name = users.get(r.assigned_user_id) if r.assigned_user_id else None
        item.vendor_name = vendors.get(r.vendor_id) if r.vendor_id else None
        out.append(item)
    return out


async def get(db: AsyncSession, wo_id: uuid.UUID) -> WorkOrder:
    wo = await db.get(WorkOrder, wo_id)
    if not wo or wo.deleted_at:
        raise _404("Work order")
    return wo


async def evidence_count(db: AsyncSession, wo: WorkOrder) -> int:
    return len(wo.evidence_document_ids or []) + await linked_document_count(db, EVIDENCE_ENTITY, wo.id)


async def to_out(db: AsyncSession, wo: WorkOrder) -> WorkOrderOut:
    base = (await decorate(db, [wo]))[0]
    out = WorkOrderOut.model_validate(wo)
    for k in ("property_name", "assignee_name", "vendor_name"):
        setattr(out, k, getattr(base, k))
    out.evidence_count = await evidence_count(db, wo)
    if wo.vendor_id:
        ok, reasons = await vendor_compliance(db, wo.vendor_id)
        out.vendor_compliance = {"compliant": ok, "reasons": reasons}
    out.allowed_transitions = sorted(WO_TRANSITIONS.get(wo.status, set()))
    return out


# ======================================================================= work orders: mutations

def _history(wo: WorkOrder, to: str, actor: CurrentUser | None, note: str | None = None) -> None:
    entry = {"from": wo.status, "to": to, "at": utcnow().isoformat(),
             "by_id": str(actor.id) if actor else None, "by_name": actor.full_name if actor else "System", "note": note}
    wo.status_history = [*(wo.status_history or []), entry]
    wo.status = to


async def _next_number(db: AsyncSession) -> int:
    return int(await db.scalar(select(func.coalesce(func.max(WorkOrder.number), 0))) or 0) + 1


async def _apply_estimate(db: AsyncSession, wo: WorkOrder, new: float | None, actor: CurrentUser | None) -> None:
    """Configured approval: estimates above the threshold need maintenance:approve before work starts."""
    previous = wo.estimate_amount
    wo.estimate_amount = new
    threshold = float((await get_settings(db)).approval_threshold or 0)
    wo.approval_threshold = threshold
    if new is None or new <= threshold:
        wo.approval_status = "approved" if wo.approval_status == "approved" else "not_required"
        return
    if wo.approval_status == "approved" and previous is not None and new <= previous:
        return  # still within the approved amount
    wo.approval_status = "pending"
    wo.approved_by_id = None
    wo.approved_at = None
    await raise_alert(
        db, title=f"Work order #{wo.number} needs cost approval",
        reason=f"Estimate ${new:,.2f} exceeds the approval threshold of ${threshold:,.2f}.",
        severity="medium", related_type=WO, related_id=wo.id, related_label=wo.title,
        rule_key="maintenance.cost_approval", idempotency_key=f"wo_approval:{wo.id}:{round(new, 2)}",
    )


async def _assign(db: AsyncSession, wo: WorkOrder, data: AssignIn, actor: CurrentUser | None, *, enforce: bool = True) -> list[str]:
    """Returns compliance reasons when a vendor assignment was blocked (enforce=False skips instead of raising)."""
    if data.assignee_type == "vendor":
        if not data.vendor_id:
            raise _422("Select a vendor to assign")
        ok, reasons = await vendor_compliance(db, data.vendor_id)
        if not ok:
            if enforce:
                raise _422("Vendor is not compliant; assignment is blocked", reasons=reasons)
            return reasons
        wo.assignee_type, wo.vendor_id, wo.assigned_user_id = "vendor", data.vendor_id, None
    else:
        if not data.assigned_user_id:
            raise _422("Select a staff member to assign")
        user = await db.get(User, data.assigned_user_id)
        if not user or user.status != "active":
            raise _422("Assignee must be an active user")
        wo.assignee_type, wo.assigned_user_id, wo.vendor_id = "staff", data.assigned_user_id, None
    wo.assigned_at = utcnow()
    if wo.status == "open":
        _history(wo, "assigned", actor, "Assigned")
    return []


async def create(
    db: AsyncSession, data: WorkOrderCreate, actor: CurrentUser | None, *,
    pm_schedule_id: uuid.UUID | None = None, inspection_id: uuid.UUID | None = None,
    finding_id: uuid.UUID | None = None, idempotency_key: str | None = None, commit: bool = True,
) -> WorkOrder:
    if idempotency_key:
        existing = await db.scalar(select(WorkOrder).where(WorkOrder.idempotency_key == idempotency_key))
        if existing:
            return existing
    prop = await db.get(Property, data.property_id)
    if not prop or prop.deleted_at:
        raise _404("Property")
    values = data.model_dump(exclude={"estimate_amount", "reported_at"})
    if not values.get("asset_id"):
        values["asset_id"] = await _asset_for_property(db, data.property_id)
    actor_id = actor.id if actor else None
    wo = WorkOrder(
        **values, number=await _next_number(db), status="open", reported_at=data.reported_at or utcnow(),
        status_history=[{"from": None, "to": "open", "at": utcnow().isoformat(), "by_id": str(actor_id) if actor_id else None,
                         "by_name": actor.full_name if actor else "System", "note": f"Created from {data.source}"}],
        pm_schedule_id=pm_schedule_id, inspection_id=inspection_id, finding_id=finding_id,
        idempotency_key=idempotency_key, created_by_id=actor_id, updated_by_id=actor_id,
        approval_status="not_required", tenant_responsibility="undetermined", chargeback_status="none",
        evidence_document_ids=[],
    )
    db.add(wo)
    await db.flush()
    await _apply_estimate(db, wo, data.estimate_amount, actor)
    if actor:
        await link_documents(db, data.photo_document_ids, WO, wo.id, actor)
    await audit.record(db, actor=actor, action="work_order.created", entity_type=WO, entity_id=wo.id,
                       summary=f"#{wo.number} {wo.title}", changes={"source": data.source, "priority": data.priority},
                       ip_address=actor.ip_address if actor else None)
    await events.emit(db, "work_order.created", work_order_id=wo.id, property_id=wo.property_id, actor=actor)
    if commit:
        await db.commit()
    return wo


async def update(db: AsyncSession, wo: WorkOrder, data: WorkOrderUpdate, actor: CurrentUser) -> WorkOrder:
    if wo.status in ("verified", "cancelled"):
        raise _422(f"A {wo.status} work order cannot be edited")
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(wo, values)
    if not changes:
        return wo
    new_photos = set(values.get("photo_document_ids") or []) - set(wo.photo_document_ids or [])
    for k, v in values.items():
        setattr(wo, k, v if k != "photo_document_ids" else (v or []))
    wo.updated_by_id = actor.id
    await link_documents(db, list(new_photos), WO, wo.id, actor)
    await audit.record(db, actor=actor, action="work_order.updated", entity_type=WO, entity_id=wo.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return wo


async def assign(db: AsyncSession, wo: WorkOrder, data: AssignIn, actor: CurrentUser) -> WorkOrder:
    if wo.status in ("completed", "verified", "cancelled"):
        raise _422(f"Cannot reassign a {wo.status} work order")
    before = {"assignee_type": wo.assignee_type, "vendor_id": wo.vendor_id, "assigned_user_id": wo.assigned_user_id}
    await _assign(db, wo, data, actor)
    wo.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="work_order.assigned", entity_type=WO, entity_id=wo.id,
                       changes=_delta(before, {"assignee_type": wo.assignee_type, "vendor_id": wo.vendor_id,
                                               "assigned_user_id": wo.assigned_user_id}),
                       ip_address=actor.ip_address)
    if wo.assigned_user_id and wo.assigned_user_id != actor.id:
        await create_task(db, title=f"Work order #{wo.number}: {wo.title}", assignee_id=wo.assigned_user_id,
                          task_type="general", priority="high" if wo.priority in ("high", "urgent") else "normal",
                          related_type=WO, related_id=wo.id, related_label=wo.title, source="maintenance",
                          idempotency_key=f"wo_assign:{wo.id}:{wo.assigned_user_id}", actor_id=actor.id)
    await db.commit()
    return wo


async def _advance_pm(db: AsyncSession, wo: WorkOrder, serviced_on: date | None) -> None:
    if not wo.pm_schedule_id:
        return
    s = await db.get(PMSchedule, wo.pm_schedule_id)
    if not s:
        return
    if serviced_on:
        s.last_service_on = serviced_on
    # Cadence is kept from the scheduled date; never move backwards.
    if wo.due_on and s.next_service_on <= wo.due_on:
        s.next_service_on = next_occurrence(wo.due_on, s.frequency, s.interval_days)


async def transition(db: AsyncSession, wo: WorkOrder, data: TransitionIn, actor: CurrentUser) -> WorkOrder:
    to = data.status
    if to == wo.status:
        return wo
    if to not in WO_TRANSITIONS.get(wo.status, set()):
        raise _422(f"Cannot move a work order from {wo.status} to {to}")
    note = data.note

    if to == "assigned" and not (wo.vendor_id or wo.assigned_user_id):
        raise _422("Assign a vendor or staff member first")
    if to == "in_progress":
        if wo.approval_status == "pending":
            raise _422("The estimate exceeds the approval threshold and is awaiting approval")
        if wo.approval_status == "rejected":
            raise _422("The estimate was rejected; revise the estimate before starting work")
        if wo.vendor_id:
            ok, reasons = await vendor_compliance(db, wo.vendor_id)
            if not ok:
                raise _422("Vendor is not compliant; work cannot start", reasons=reasons)
        wo.started_at = wo.started_at or utcnow()
    if to == "completed":
        notes = (data.completion_notes or wo.completion_notes or "").strip()
        if not notes:
            raise _422("Completion notes are required")
        wo.completion_notes = notes
        if data.actual_cost is not None:
            wo.actual_cost = data.actual_cost
        if data.evidence_document_ids:
            wo.evidence_document_ids = list(dict.fromkeys([*(wo.evidence_document_ids or []), *data.evidence_document_ids]))
            await link_documents(db, data.evidence_document_ids, EVIDENCE_ENTITY, wo.id, actor)
        wo.completed_at = utcnow()
        wo.completed_by_id = actor.id
        await _advance_pm(db, wo, date.today())
    if to == "verified":
        if data.evidence_document_ids:
            wo.evidence_document_ids = list(dict.fromkeys([*(wo.evidence_document_ids or []), *data.evidence_document_ids]))
            await link_documents(db, data.evidence_document_ids, EVIDENCE_ENTITY, wo.id, actor)
            await db.flush()
        if await evidence_count(db, wo) == 0:
            raise _422("Completion evidence (photo or document) is required before verifying")
        if wo.actual_cost is None:
            raise _422("Record the actual cost before verifying")
        wo.verified_at = utcnow()
        wo.verified_by_id = actor.id
        if wo.finding_id:
            finding = await db.get(InspectionFinding, wo.finding_id)
            if finding and finding.status != "resolved":
                finding.status = "resolved"
    if to == "cancelled":
        reason = (data.cancelled_reason or note or "").strip()
        if not reason:
            raise _422("A cancellation reason is required")
        wo.cancelled_reason = reason
        note = reason
        await _advance_pm(db, wo, None)
    if to == "open":
        wo.cancelled_reason = None if wo.status == "cancelled" else wo.cancelled_reason
    if to == "in_progress" and wo.status == "completed":
        wo.completed_at = None  # reopened for rework

    previous = wo.status
    _history(wo, to, actor, note)
    wo.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"work_order.{to}", entity_type=WO, entity_id=wo.id,
                       changes={"status": {"from": previous, "to": to}}, summary=note, ip_address=actor.ip_address)
    await events.emit(db, "work_order.status_changed", work_order_id=wo.id, property_id=wo.property_id,
                      from_status=previous, to_status=to, actor=actor)
    await db.commit()
    return wo


async def set_costs(db: AsyncSession, wo: WorkOrder, data: CostIn, actor: CurrentUser) -> WorkOrder:
    if wo.status in ("verified", "cancelled"):
        raise _422(f"Costs of a {wo.status} work order are locked")
    values = data.model_dump(exclude_unset=True, exclude={"note"})
    changes = audit.diff(wo, values)
    if not changes:
        return wo
    if "estimate_amount" in values:
        await _apply_estimate(db, wo, values["estimate_amount"], actor)
    if "actual_cost" in values:
        wo.actual_cost = values["actual_cost"]
    wo.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="work_order.costs_updated", entity_type=WO, entity_id=wo.id,
                       changes={**changes, "approval_status": wo.approval_status}, summary=data.note,
                       ip_address=actor.ip_address)
    await db.commit()
    return wo


async def decide_approval(db: AsyncSession, wo: WorkOrder, decision: str, note: str | None, actor: CurrentUser) -> WorkOrder:
    if wo.approval_status != "pending":
        raise _422("This work order is not awaiting approval")
    if decision == "rejected" and not (note or "").strip():
        raise _422("A note is required when rejecting an estimate")
    wo.approval_status = decision
    wo.approved_by_id = actor.id
    wo.approved_at = utcnow()
    wo.approval_note = note
    wo.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"work_order.estimate_{decision}", entity_type=WO, entity_id=wo.id,
                       changes={"approval_status": {"from": "pending", "to": decision},
                                "estimate_amount": wo.estimate_amount},
                       summary=note, ip_address=actor.ip_address)
    await db.commit()
    return wo


async def add_evidence(db: AsyncSession, wo: WorkOrder, ids: list[uuid.UUID], actor: CurrentUser) -> WorkOrder:
    new = [i for i in ids if i not in (wo.evidence_document_ids or [])]
    if not new:
        return wo
    wo.evidence_document_ids = [*(wo.evidence_document_ids or []), *new]
    await link_documents(db, new, EVIDENCE_ENTITY, wo.id, actor)
    await audit.record(db, actor=actor, action="work_order.evidence_added", entity_type=WO, entity_id=wo.id,
                       changes={"evidence_document_ids": new}, ip_address=actor.ip_address)
    await db.commit()
    return wo


async def rate(db: AsyncSession, wo: WorkOrder, rating: int, comment: str | None, actor: CurrentUser) -> WorkOrder:
    if wo.status not in ("completed", "verified"):
        raise _422("Satisfaction can be recorded once the work is completed")
    changes = audit.diff(wo, {"satisfaction_rating": rating, "satisfaction_comment": comment})
    wo.satisfaction_rating = rating
    wo.satisfaction_comment = comment
    await audit.record(db, actor=actor, action="work_order.rated", entity_type=WO, entity_id=wo.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return wo


async def archive(db: AsyncSession, wo: WorkOrder, actor: CurrentUser) -> None:
    wo.deleted_at = utcnow()
    wo.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="work_order.archived", entity_type=WO, entity_id=wo.id,
                       summary=f"#{wo.number} {wo.title}", ip_address=actor.ip_address)
    await db.commit()


async def bulk_update(db: AsyncSession, ids: list[uuid.UUID], priority: str | None, assigned_user_id: uuid.UUID | None,
                      actor: CurrentUser) -> int:
    rows = list(await db.scalars(select(WorkOrder).where(WorkOrder.id.in_(ids), WorkOrder.deleted_at.is_(None))))
    updated = 0
    for wo in rows:
        changes: dict = {}
        if priority and wo.priority != priority:
            changes["priority"] = {"from": wo.priority, "to": priority}
            wo.priority = priority
        if assigned_user_id and wo.status in ("open", "assigned") and wo.assigned_user_id != assigned_user_id:
            await _assign(db, wo, AssignIn(assignee_type="staff", assigned_user_id=assigned_user_id), actor)
            changes["assigned_user_id"] = {"to": str(assigned_user_id)}
        if changes:
            updated += 1
            wo.updated_by_id = actor.id
            await audit.record(db, actor=actor, action="work_order.bulk_updated", entity_type=WO, entity_id=wo.id,
                               changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return updated


# ======================================================================= tenant responsibility

_CATEGORY_TERMS: dict[str, list[str]] = {
    "hvac": ["hvac", "heating", "air condition", "mechanical system", "rooftop unit"],
    "plumbing": ["plumbing", "sewer", "water line", "drain", "fixtures"],
    "electrical": ["electrical", "lighting", "wiring"],
    "roof": ["roof"],
    "structural": ["structural", "foundation", "exterior wall", "load-bearing", "slab"],
    "parking_lot": ["parking", "paving", "asphalt", "common area"],
    "landscaping": ["landscap", "common area", "grounds"],
    "life_safety": ["fire", "sprinkler", "life safety", "alarm"],
    "janitorial": ["janitorial", "cleaning", "trash"],
    "pest_control": ["pest"],
    "doors_locks": ["door", "lock", "storefront", "glass"],
    "signage": ["sign"],
    "elevator": ["elevator"],
}
_TENANT = re.compile(r"\btenant(?:'s)?\s+(?:shall|will|must|is\s+responsible|agrees|at\s+its\s+(?:sole\s+)?(?:cost|expense))|"
                     r"at\s+tenant'?s\s+(?:sole\s+)?(?:cost|expense)|tenant\s+responsib", re.I)
_LANDLORD = re.compile(r"\blandlord(?:'s)?\s+(?:shall|will|must|is\s+responsible|agrees|at\s+its\s+(?:sole\s+)?(?:cost|expense))|"
                       r"at\s+landlord'?s\s+(?:sole\s+)?(?:cost|expense)|landlord\s+responsib", re.I)
_RELEVANT_TYPES = {"maintenance", "repair", "repairs", "replacement", "maintenance_repair", "capital_repairs"}
_NET_TYPES = {"nnn", "triple_net", "absolute_net", "net", "bondable", "stnl"}
_CAPITAL_CATEGORIES = {"roof", "structural"}


def _clause_text(c) -> str:
    raw = getattr(c, "text", None) or getattr(c, "summary", None) or getattr(c, "body", None) or ""
    return str(raw).replace("’", "'")


def _clause_type(c) -> str:
    return str(getattr(c, "clause_type", None) or getattr(c, "category", None) or getattr(c, "kind", None) or "").lower()


async def _applicable_lease(db: AsyncSession, wo: WorkOrder):
    try:
        from app.modules.leases.models import Lease
    except ImportError:
        return None, "Lease module is not available"
    if wo.lease_id:
        lease = await db.get(Lease, wo.lease_id)
        if lease:
            return lease, None
    base = select(Lease).where(Lease.property_id == wo.property_id, Lease.status == "active", Lease.deleted_at.is_(None))
    if wo.space_id:
        lease = await db.scalar(base.where(Lease.space_id == wo.space_id).limit(1))
        if lease:
            return lease, None
    if wo.tenant_organization_id:
        lease = await db.scalar(base.where(Lease.tenant_organization_id == wo.tenant_organization_id).limit(1))
        if lease:
            return lease, None
    rows = list(await db.scalars(base.limit(2)))
    if len(rows) == 1:
        return rows[0], None
    if not rows:
        return None, "No active lease covers this property"
    return None, "Several active leases cover this property; link the work order to a space or lease"


async def _lease_clauses(db: AsyncSession, lease_id: uuid.UUID) -> list:
    try:
        from app.modules.leases.models import LeaseClause
    except ImportError:
        return []
    stmt = select(LeaseClause).where(LeaseClause.lease_id == lease_id)
    if hasattr(LeaseClause, "deleted_at"):
        stmt = stmt.where(LeaseClause.deleted_at.is_(None))
    return list(await db.scalars(stmt))


def determine_from_clauses(category: str, lease_type: str | None, clauses: list) -> tuple[str, float | None, str, list[dict]]:
    """Pure rule set: category-specific clauses outrank general maintenance clauses, which outrank lease type."""
    terms = _CATEGORY_TERMS.get(category, [])
    specific: list[tuple[str, dict]] = []
    general: list[tuple[str, dict]] = []
    for c in clauses:
        text = _clause_text(c)
        ctype = _clause_type(c)
        low = text.lower()
        if ctype not in _RELEVANT_TYPES and not any(w in low for w in ("repair", "maint", "replace")):
            continue
        t, l = bool(_TENANT.search(text)), bool(_LANDLORD.search(text))
        if not (t or l):
            continue
        party = "shared" if t and l else ("tenant" if t else "landlord")
        basis = {
            "clause_id": str(getattr(c, "id", "")) or None, "clause_type": ctype or None,
            "document_id": str(c.document_id) if getattr(c, "document_id", None) else None,
            "page": getattr(c, "page", None), "clause_ref": getattr(c, "clause_ref", None),
            "excerpt": text[:400], "party": party,
        }
        (specific if any(term in low for term in terms) else general).append((party, basis))

    for level, found in (("category-specific", specific), ("general maintenance", general)):
        if not found:
            continue
        tenant = sum(1 for p, _ in found if p == "tenant")
        landlord = sum(1 for p, _ in found if p == "landlord")
        shared = sum(1 for p, _ in found if p == "shared")
        basis = [b for _, b in found]
        if tenant and not landlord and not shared:
            return "tenant", 100.0, f"Lease {level} clause(s) assign this work to the tenant.", basis
        if landlord and not tenant and not shared:
            return "landlord", 0.0, f"Lease {level} clause(s) assign this work to the landlord.", basis
        return "shared", 50.0, f"Lease {level} clauses allocate obligations to both parties; review the split.", basis

    lt = (lease_type or "").lower().replace("-", "_").replace(" ", "_")
    if lt in _NET_TYPES:
        if category in _CAPITAL_CATEGORIES and lt != "absolute_net":
            return "landlord", 0.0, f"No maintenance clause found; {lease_type} lease keeps roof/structure with the landlord.", []
        return "tenant", 100.0, f"No maintenance clause found; {lease_type} lease places repairs on the tenant.", []
    if lt:
        return "landlord", 0.0, f"No maintenance clause found; {lease_type} lease keeps repairs with the landlord.", []
    return "undetermined", None, "No maintenance clause or lease type available to determine responsibility.", []


async def determine_responsibility(db: AsyncSession, wo: WorkOrder, data: ResponsibilityIn, actor: CurrentUser) -> WorkOrder:
    before = {"tenant_responsibility": wo.tenant_responsibility, "tenant_share_pct": wo.tenant_share_pct}
    if data.responsibility:
        if not (data.reason or "").strip():
            raise _422("A reason is required for a manual determination")
        result, pct, reason, basis, method = data.responsibility, data.tenant_share_pct, data.reason, [], "manual"
        if pct is None:
            pct = {"tenant": 100.0, "landlord": 0.0, "shared": 50.0}.get(result)
    else:
        lease, problem = await _applicable_lease(db, wo)
        if lease is None:
            result, pct, reason, basis = "undetermined", None, problem or "No applicable lease", []
        else:
            clauses = await _lease_clauses(db, lease.id)
            result, pct, reason, basis = determine_from_clauses(wo.category, getattr(lease, "lease_type", None), clauses)
            wo.lease_id = lease.id
            tenant = getattr(lease, "tenant_name", None)
            if tenant:
                reason = f"{reason} (lease: {tenant})"
        method = "lease_rules"
    wo.tenant_responsibility = result
    wo.tenant_share_pct = pct
    wo.responsibility_reason = reason
    wo.responsibility_basis = basis
    wo.responsibility_method = method
    wo.responsibility_determined_at = utcnow()
    wo.responsibility_determined_by_id = actor.id
    wo.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="work_order.responsibility_determined", entity_type=WO, entity_id=wo.id,
                       changes={**_delta(before, {"tenant_responsibility": result, "tenant_share_pct": pct}),
                                "method": method},
                       summary=reason, ip_address=actor.ip_address)
    await db.commit()
    return wo


async def create_chargeback(db: AsyncSession, wo: WorkOrder, actor: CurrentUser) -> WorkOrder:
    if wo.tenant_responsibility not in ("tenant", "shared"):
        raise _422("Chargeback requires a tenant or shared responsibility determination")
    if wo.status not in ("completed", "verified"):
        raise _422("Chargeback is available once the work is completed")
    if not wo.actual_cost:
        raise _422("Record the actual cost first")
    if wo.chargeback_status == "created":
        raise HTTPException(status.HTTP_409_CONFLICT, "A chargeback was already created")
    share = wo.tenant_share_pct if wo.tenant_share_pct is not None else (100.0 if wo.tenant_responsibility == "tenant" else 50.0)
    amount = round(float(wo.actual_cost) * share / 100, 2)
    charge_id = None
    fn = None
    try:
        from app.modules.receivables import service as receivables
        fn = getattr(receivables, "create_charge", None)
    except ImportError:
        fn = None
    if fn is not None and wo.lease_id:
        try:
            charge = await fn(db, lease_id=wo.lease_id, amount=amount, charge_type="maintenance_chargeback",
                              description=f"Work order #{wo.number}: {wo.title}", due_on=date.today(),
                              source_type=WO, source_id=wo.id, actor=actor)
            charge_id = getattr(charge, "id", None)
        except TypeError:
            charge_id = None
    wo.chargeback_amount = amount
    wo.chargeback_charge_id = charge_id
    wo.chargeback_status = "created" if charge_id else "pending_manual"
    if not charge_id:
        await create_task(db, title=f"Bill tenant ${amount:,.2f} for work order #{wo.number}", task_type="general",
                          priority="normal", related_type=WO, related_id=wo.id, related_label=wo.title,
                          description=wo.responsibility_reason, source="maintenance.chargeback",
                          idempotency_key=f"wo_chargeback:{wo.id}", actor_id=actor.id)
    await audit.record(db, actor=actor, action="work_order.chargeback_created", entity_type=WO, entity_id=wo.id,
                       changes={"chargeback_amount": amount, "chargeback_status": wo.chargeback_status,
                                "charge_id": charge_id}, ip_address=actor.ip_address)
    await db.commit()
    return wo


# ======================================================================= service history

async def service_history(db: AsyncSession, *, asset_id: uuid.UUID | None, property_id: uuid.UUID | None,
                          system: str | None) -> dict:
    if not asset_id and not property_id:
        raise _422("asset_id or property_id is required")
    stmt = select(WorkOrder).where(WorkOrder.deleted_at.is_(None))
    pm = select(PMSchedule).where(PMSchedule.deleted_at.is_(None))
    if asset_id:
        stmt, pm = stmt.where(WorkOrder.asset_id == asset_id), pm.where(PMSchedule.asset_id == asset_id)
    if property_id:
        stmt, pm = stmt.where(WorkOrder.property_id == property_id), pm.where(PMSchedule.property_id == property_id)
    if system:
        stmt = stmt.where(WorkOrder.system.ilike(f"%{system}%"))
        pm = pm.where(PMSchedule.system.ilike(f"%{system}%"))
    rows = list(await db.scalars(stmt.order_by(WorkOrder.created_at.desc()).limit(500)))
    schedules = list(await db.scalars(pm.order_by(PMSchedule.next_service_on)))
    return {
        "work_orders": await decorate(db, rows),
        "pm_schedules": await pm_out(db, schedules),
        "total_cost": round(sum(float(r.actual_cost or 0) for r in rows if r.status in ("completed", "verified")), 2),
        "completed_count": sum(1 for r in rows if r.status in ("completed", "verified")),
        "open_count": sum(1 for r in rows if r.status in ("open", "assigned", "in_progress")),
    }


# ======================================================================= preventive maintenance

def _add_months(d: date, months: int) -> date:
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def next_occurrence(d: date, frequency: str, interval_days: int | None) -> date:
    months = {"monthly": 1, "quarterly": 3, "semiannual": 6, "annual": 12}.get(frequency)
    if months:
        return _add_months(d, months)
    if frequency == "custom":
        return d + timedelta(days=max(1, interval_days or 30))
    return d + timedelta(days=PM_FREQUENCIES.get(frequency, 30))


async def pm_out(db: AsyncSession, rows: list[PMSchedule]) -> list[PMScheduleOut]:
    props = await _property_names(db, {r.property_id for r in rows})
    vendors = await _vendor_names(db, {r.default_vendor_id for r in rows if r.default_vendor_id})
    today = date.today()
    out = []
    for r in rows:
        o = PMScheduleOut.model_validate(r)
        o.property_name = props.get(r.property_id, (None, None))[0]
        o.vendor_name = vendors.get(r.default_vendor_id) if r.default_vendor_id else None
        o.is_due = r.is_active and r.next_service_on - timedelta(days=r.lead_days or 0) <= today
        out.append(o)
    return out


def pm_query(q: str | None, property_id: uuid.UUID | None, asset_id: uuid.UUID | None, active: bool | None,
             frequency: list[str] | None, due_within_days: int | None) -> Select:
    stmt = select(PMSchedule).where(PMSchedule.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [PMSchedule.title, PMSchedule.system, PMSchedule.description])
    if property_id:
        stmt = stmt.where(PMSchedule.property_id == property_id)
    if asset_id:
        stmt = stmt.where(PMSchedule.asset_id == asset_id)
    if active is not None:
        stmt = stmt.where(PMSchedule.is_active.is_(active))
    stmt = in_filter(stmt, PMSchedule.frequency, frequency)
    if due_within_days is not None:
        stmt = stmt.where(PMSchedule.next_service_on <= date.today() + timedelta(days=due_within_days))
    return stmt


async def get_pm(db: AsyncSession, pm_id: uuid.UUID) -> PMSchedule:
    s = await db.get(PMSchedule, pm_id)
    if not s or s.deleted_at:
        raise _404("Schedule")
    return s


async def save_pm(db: AsyncSession, data: PMScheduleIn, actor: CurrentUser, s: PMSchedule | None = None) -> PMSchedule:
    if data.frequency == "custom" and not data.interval_days:
        raise _422("Custom frequency requires an interval in days")
    values = data.model_dump()
    if not values.get("asset_id"):
        values["asset_id"] = await _asset_for_property(db, data.property_id)
    if s is None:
        s = PMSchedule(**values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(s)
        await db.flush()
        await audit.record(db, actor=actor, action="pm_schedule.created", entity_type="pm_schedule", entity_id=s.id,
                           summary=f"{s.system}: {s.title}", ip_address=actor.ip_address)
    else:
        changes = audit.diff(s, values)
        for k, v in values.items():
            setattr(s, k, v)
        s.updated_by_id = actor.id
        if changes:
            await audit.record(db, actor=actor, action="pm_schedule.updated", entity_type="pm_schedule",
                               entity_id=s.id, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return s


async def archive_pm(db: AsyncSession, s: PMSchedule, actor: CurrentUser) -> None:
    s.deleted_at = utcnow()
    s.is_active = False
    await audit.record(db, actor=actor, action="pm_schedule.archived", entity_type="pm_schedule", entity_id=s.id,
                       summary=s.title, ip_address=actor.ip_address)
    await db.commit()


async def generate_pm_work_orders(db: AsyncSession, actor: CurrentUser | None, *, property_id: uuid.UUID | None = None) -> dict:
    """Idempotent: one work order per schedule per scheduled date (key pm:<schedule>:<date>).
    The schedule advances to its next occurrence when that work order is completed or cancelled."""
    today = date.today()
    stmt = select(PMSchedule).where(PMSchedule.deleted_at.is_(None), PMSchedule.is_active.is_(True))
    if property_id:
        stmt = stmt.where(PMSchedule.property_id == property_id)
    schedules = list(await db.scalars(stmt))
    generated: list[uuid.UUID] = []
    for s in schedules:
        if s.next_service_on - timedelta(days=s.lead_days or 0) > today:
            continue
        key = f"pm:{s.id}:{s.next_service_on.isoformat()}"
        if await db.scalar(select(WorkOrder.id).where(WorkOrder.idempotency_key == key)):
            continue
        wo = await create(
            db,
            WorkOrderCreate(
                title=s.title, description=s.description, source="preventive", category=s.category,
                priority=s.priority, property_id=s.property_id, asset_id=s.asset_id, system=s.system,
                due_on=s.next_service_on, estimate_amount=s.estimate_amount,
            ),
            actor, pm_schedule_id=s.id, idempotency_key=key, commit=False,
        )
        if s.default_vendor_id:
            blocked = await _assign(db, wo, AssignIn(assignee_type="vendor", vendor_id=s.default_vendor_id), actor, enforce=False)
            if blocked:
                await raise_alert(
                    db, title=f"PM work order #{wo.number} left unassigned", severity="medium",
                    reason="Default vendor is not compliant: " + "; ".join(blocked),
                    related_type=WO, related_id=wo.id, related_label=wo.title, rule_key="maintenance.vendor_compliance",
                    idempotency_key=f"pm_vendor_blocked:{wo.id}",
                )
        elif s.default_assignee_id:
            await _assign(db, wo, AssignIn(assignee_type="staff", assigned_user_id=s.default_assignee_id), actor, enforce=False)
        s.last_generated_on = today
        s.last_work_order_id = wo.id
        generated.append(wo.id)
    if actor and generated:
        await audit.record(db, actor=actor, action="pm_schedule.scan", entity_type="pm_schedule",
                           summary=f"{len(generated)} work orders generated", ip_address=actor.ip_address)
    await db.commit()
    return {"scanned": len(schedules), "generated": len(generated), "work_order_ids": generated}


# ======================================================================= inspection templates

def template_out(t: InspectionTemplate) -> TemplateOut:
    out = TemplateOut.model_validate(t)
    out.item_count = sum(len(s.get("items", [])) for s in (t.sections or []))
    return out


def _validate_sections(sections: list[dict]) -> None:
    keys: set[str] = set()
    for s in sections:
        for i in s.get("items", []):
            if i["key"] in keys:
                raise _422(f"Duplicate checklist item key: {i['key']}")
            keys.add(i["key"])


async def get_template(db: AsyncSession, template_id: uuid.UUID) -> InspectionTemplate:
    t = await db.get(InspectionTemplate, template_id)
    if not t or t.deleted_at:
        raise _404("Template")
    return t


async def save_template(db: AsyncSession, data: TemplateIn, actor: CurrentUser, t: InspectionTemplate | None = None) -> InspectionTemplate:
    values = data.model_dump()
    _validate_sections(values["sections"])
    if t is None:
        t = InspectionTemplate(**values, version=1, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(t)
        await db.flush()
        await audit.record(db, actor=actor, action="inspection_template.created", entity_type="inspection_template",
                           entity_id=t.id, summary=t.name, ip_address=actor.ip_address)
    else:
        changes = audit.diff(t, values)
        if "sections" in changes:
            t.version = (t.version or 1) + 1  # inspections keep their own snapshot
        for k, v in values.items():
            setattr(t, k, v)
        t.updated_by_id = actor.id
        if changes:
            await audit.record(db, actor=actor, action="inspection_template.updated", entity_type="inspection_template",
                               entity_id=t.id, changes={k: v for k, v in changes.items() if k != "sections"} | (
                                   {"sections": "revised", "version": t.version} if "sections" in changes else {}),
                               ip_address=actor.ip_address)
    await db.commit()
    return t


async def archive_template(db: AsyncSession, t: InspectionTemplate, actor: CurrentUser) -> None:
    t.deleted_at = utcnow()
    t.is_active = False
    await audit.record(db, actor=actor, action="inspection_template.archived", entity_type="inspection_template",
                       entity_id=t.id, summary=t.name, ip_address=actor.ip_address)
    await db.commit()


# ======================================================================= inspections

def _items(sections: list) -> dict[str, tuple[dict, dict]]:
    return {i["key"]: (s, i) for s in (sections or []) for i in s.get("items", [])}


def _progress(insp: Inspection) -> dict:
    items = _items(insp.sections)
    answered = {k: v for k, v in (insp.responses or {}).items() if k in items and v.get("result")}
    counts = {r: sum(1 for v in answered.values() if v["result"] == r) for r in ("pass", "fail", "na")}
    return {"total": len(items), "answered": len(answered), **counts}


def _score(insp: Inspection) -> float | None:
    p = _progress(insp)
    graded = p["pass"] + p["fail"]
    return round(100 * p["pass"] / graded, 1) if graded else None


@dataclass
class InspectionFilters:
    q: str | None = None
    status: list[str] | None = None
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    inspector_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None
    scheduled_from: date | None = None
    scheduled_to: date | None = None


def inspection_query(f: InspectionFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Inspection).where(Inspection.deleted_at.is_(None))
    if f.q:
        stmt = stmt.outerjoin(Property, Property.id == Inspection.property_id)
        stmt = apply_search(stmt, f.q, [Inspection.template_name, Inspection.summary, Property.name, Property.address_line])
    if "status" not in skip:
        stmt = in_filter(stmt, Inspection.status, f.status)
    for key in ("property_id", "asset_id", "inspector_id", "template_id"):
        if getattr(f, key):
            stmt = stmt.where(getattr(Inspection, key) == getattr(f, key))
    return range_filter(stmt, Inspection.scheduled_on, f.scheduled_from, f.scheduled_to)


async def inspection_items(db: AsyncSession, rows: list[Inspection]) -> list[InspectionListItem]:
    props = await _property_names(db, {r.property_id for r in rows})
    users = await _user_names(db, {r.inspector_id for r in rows if r.inspector_id})
    counts: dict[uuid.UUID, tuple[int, int]] = {}
    if rows:
        res = await db.execute(
            select(InspectionFinding.inspection_id, func.count(),
                   func.count().filter(InspectionFinding.status == "open"))
            .where(InspectionFinding.inspection_id.in_([r.id for r in rows]), InspectionFinding.deleted_at.is_(None))
            .group_by(InspectionFinding.inspection_id)
        )
        counts = {r[0]: (int(r[1]), int(r[2])) for r in res.all()}
    out = []
    for r in rows:
        item = InspectionListItem.model_validate(r)
        name, ptype = props.get(r.property_id, (None, None))
        item.property_name, item.property_type = name, ptype
        item.inspector_name = users.get(r.inspector_id) if r.inspector_id else None
        item.finding_count, item.open_finding_count = counts.get(r.id, (0, 0))
        out.append(item)
    return out


async def get_inspection(db: AsyncSession, inspection_id: uuid.UUID) -> Inspection:
    i = await db.get(Inspection, inspection_id)
    if not i or i.deleted_at:
        raise _404("Inspection")
    return i


async def inspection_out(db: AsyncSession, insp: Inspection) -> InspectionOut:
    base = (await inspection_items(db, [insp]))[0]
    out = InspectionOut.model_validate(insp)
    for k in ("property_name", "property_type", "inspector_name", "finding_count", "open_finding_count"):
        setattr(out, k, getattr(base, k))
    findings = list(await db.scalars(
        select(InspectionFinding).where(InspectionFinding.inspection_id == insp.id, InspectionFinding.deleted_at.is_(None))
        .order_by(InspectionFinding.created_at)
    ))
    out.findings = [FindingOut.model_validate(f) for f in findings]
    out.progress = _progress(insp)
    return out


async def create_inspection(db: AsyncSession, data: InspectionCreate, actor: CurrentUser) -> Inspection:
    t = await get_template(db, data.template_id)
    prop = await db.get(Property, data.property_id)
    if not prop or prop.deleted_at:
        raise _404("Property")
    if t.property_type and t.property_type != prop.property_type:
        raise _422(f"Template is for {t.property_type} properties; this property is {prop.property_type}")
    insp = Inspection(
        template_id=t.id, template_name=t.name, template_version=t.version, sections=t.sections, responses={},
        property_id=prop.id, asset_id=data.asset_id or await _asset_for_property(db, prop.id),
        inspector_id=data.inspector_id or actor.id, scheduled_on=data.scheduled_on or date.today(),
        status="scheduled", created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(insp)
    await db.flush()
    await audit.record(db, actor=actor, action="inspection.created", entity_type="inspection", entity_id=insp.id,
                       summary=f"{t.name} v{t.version}", ip_address=actor.ip_address)
    await db.commit()
    return insp


async def update_inspection(db: AsyncSession, insp: Inspection, data: InspectionUpdate, actor: CurrentUser) -> Inspection:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(insp, values)
    if not changes:
        return insp
    for k, v in values.items():
        setattr(insp, k, v)
    insp.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="inspection.updated", entity_type="inspection", entity_id=insp.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return insp


async def record_responses(db: AsyncSession, insp: Inspection, responses: list[ResponseIn], actor: CurrentUser) -> Inspection:
    if insp.status in ("completed", "cancelled"):
        raise _422(f"This inspection is {insp.status}")
    items = _items(insp.sections)
    current = dict(insp.responses or {})
    for r in responses:
        if r.item_key not in items:
            raise _422(f"Unknown checklist item: {r.item_key}")
        current[r.item_key] = {"result": r.result, "note": r.note, "answered_at": utcnow().isoformat(),
                               "by_id": str(actor.id)}
    insp.responses = current
    if insp.status == "scheduled":
        insp.status = "in_progress"
        insp.started_at = utcnow()
    insp.score = _score(insp)
    insp.updated_by_id = actor.id
    await db.commit()
    return insp


async def _finding_work_order(db: AsyncSession, insp: Inspection, f: InspectionFinding, actor: CurrentUser | None) -> WorkOrder:
    priority = {"critical": "urgent", "high": "high", "medium": "normal", "low": "low"}.get(f.severity, "normal")
    loc = f"{f.section_title} · {f.item_label}" if f.section_title and f.item_label else (f.item_label or None)
    wo = await create(
        db,
        WorkOrderCreate(
            title=f.title, description=f.description, source="inspection", category=f.category, priority=priority,
            property_id=insp.property_id, asset_id=insp.asset_id, location_detail=loc,
            photo_document_ids=list(f.photo_document_ids or []),
        ),
        actor, inspection_id=insp.id, finding_id=f.id, idempotency_key=f"finding:{f.id}", commit=False,
    )
    f.work_order_id = wo.id
    f.status = "work_order_created"
    return wo


async def add_finding(db: AsyncSession, insp: Inspection, data: FindingIn, actor: CurrentUser) -> dict:
    if insp.status == "cancelled":
        raise _422("This inspection is cancelled")
    section = item = None
    if data.item_key:
        found = _items(insp.sections).get(data.item_key)
        if not found:
            raise _422(f"Unknown checklist item: {data.item_key}")
        section, item = found
    f = InspectionFinding(
        inspection_id=insp.id, property_id=insp.property_id, item_key=data.item_key,
        item_label=item["label"] if item else None, section_title=section["title"] if section else None,
        title=data.title, description=data.description,
        category=(item or {}).get("category") or data.category if data.category == "general" else data.category,
        severity=data.severity, status="open", latitude=data.latitude, longitude=data.longitude,
        location_accuracy_m=data.location_accuracy_m, captured_at=data.captured_at or utcnow(),
        photo_document_ids=data.photo_document_ids, created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(f)
    await db.flush()
    await link_documents(db, data.photo_document_ids, "inspection_finding", f.id, actor)
    if data.item_key:
        responses = dict(insp.responses or {})
        prev = responses.get(data.item_key) or {}
        if prev.get("result") != "fail":
            responses[data.item_key] = {**prev, "result": "fail", "answered_at": utcnow().isoformat(), "by_id": str(actor.id)}
            insp.responses = responses
            insp.score = _score(insp)
    threshold = (await get_settings(db)).finding_auto_wo_severity
    wo = None
    if SEVERITIES.index(f.severity) >= SEVERITIES.index(threshold if threshold in SEVERITIES else "high"):
        wo = await _finding_work_order(db, insp, f, actor)
    await audit.record(db, actor=actor, action="inspection.finding_added", entity_type="inspection", entity_id=insp.id,
                       summary=f"{f.severity}: {f.title}",
                       changes={"work_order_id": wo.id if wo else None, "lat": f.latitude, "lng": f.longitude},
                       ip_address=actor.ip_address)
    await db.commit()
    return {"finding": FindingOut.model_validate(f), "work_order_id": wo.id if wo else None, "auto_created": wo is not None}


async def get_finding(db: AsyncSession, finding_id: uuid.UUID) -> InspectionFinding:
    f = await db.get(InspectionFinding, finding_id)
    if not f or f.deleted_at:
        raise _404("Finding")
    return f


async def update_finding(db: AsyncSession, f: InspectionFinding, data: FindingUpdate, actor: CurrentUser) -> InspectionFinding:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(f, values)
    if not changes:
        return f
    new_photos = set(values.get("photo_document_ids") or []) - set(f.photo_document_ids or [])
    for k, v in values.items():
        setattr(f, k, v if k != "photo_document_ids" else (v or []))
    f.updated_by_id = actor.id
    await link_documents(db, list(new_photos), "inspection_finding", f.id, actor)
    await audit.record(db, actor=actor, action="inspection.finding_updated", entity_type="inspection",
                       entity_id=f.inspection_id, summary=f.title, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return f


async def finding_to_work_order(db: AsyncSession, f: InspectionFinding, actor: CurrentUser) -> WorkOrder:
    if f.work_order_id:
        existing = await db.get(WorkOrder, f.work_order_id)
        if existing and not existing.deleted_at:
            return existing
    insp = await get_inspection(db, f.inspection_id)
    wo = await _finding_work_order(db, insp, f, actor)
    await audit.record(db, actor=actor, action="inspection.work_order_created", entity_type="inspection",
                       entity_id=insp.id, summary=f"#{wo.number} from finding {f.title}", ip_address=actor.ip_address)
    await db.commit()
    return wo


async def set_inspection_status(db: AsyncSession, insp: Inspection, to: str, summary: str | None, actor: CurrentUser) -> Inspection:
    if insp.status in ("completed", "cancelled"):
        raise _422(f"This inspection is already {insp.status}")
    created: list[uuid.UUID] = []
    if to == "in_progress":
        insp.started_at = insp.started_at or utcnow()
    if to == "completed":
        p = _progress(insp)
        if p["answered"] < p["total"]:
            raise _422(f"{p['total'] - p['answered']} checklist items are unanswered")
        # Every failed item must be captured as a deficiency so nothing is lost.
        existing = set(await db.scalars(select(InspectionFinding.item_key).where(
            InspectionFinding.inspection_id == insp.id, InspectionFinding.deleted_at.is_(None))))
        items = _items(insp.sections)
        for key, resp in (insp.responses or {}).items():
            if resp.get("result") == "fail" and key not in existing and key in items:
                section, item = items[key]
                db.add(InspectionFinding(
                    inspection_id=insp.id, property_id=insp.property_id, item_key=key, item_label=item["label"],
                    section_title=section["title"], title=f"Failed: {item['label']}", description=resp.get("note"),
                    category=item.get("category") or "general", severity="medium", status="open",
                    latitude=insp.latitude, longitude=insp.longitude, captured_at=utcnow(), photo_document_ids=[],
                    created_by_id=actor.id, updated_by_id=actor.id,
                ))
        await db.flush()
        threshold = (await get_settings(db)).finding_auto_wo_severity
        floor = SEVERITIES.index(threshold if threshold in SEVERITIES else "high")
        pending = list(await db.scalars(select(InspectionFinding).where(
            InspectionFinding.inspection_id == insp.id, InspectionFinding.deleted_at.is_(None),
            InspectionFinding.work_order_id.is_(None), InspectionFinding.status == "open")))
        for f in pending:
            if SEVERITIES.index(f.severity) >= floor:
                created.append((await _finding_work_order(db, insp, f, actor)).id)
        insp.completed_at = utcnow()
        insp.score = _score(insp)
    if summary is not None:
        insp.summary = summary
    previous = insp.status
    insp.status = to
    insp.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"inspection.{to}", entity_type="inspection", entity_id=insp.id,
                       changes={"status": {"from": previous, "to": to}, "work_orders_created": created},
                       ip_address=actor.ip_address)
    await db.commit()
    return insp


async def archive_inspection(db: AsyncSession, insp: Inspection, actor: CurrentUser) -> None:
    insp.deleted_at = utcnow()
    await audit.record(db, actor=actor, action="inspection.archived", entity_type="inspection", entity_id=insp.id,
                       summary=insp.template_name, ip_address=actor.ip_address)
    await db.commit()

