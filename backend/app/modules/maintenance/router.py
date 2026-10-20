import csv
import io
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.common import audit
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.maintenance import service
from app.modules.maintenance.models import (
    FINDING_STATUSES,
    INSPECTION_STATUSES,
    PM_FREQUENCIES,
    SEVERITIES,
    WO_CATEGORIES,
    WO_PRIORITIES,
    WO_SOURCES,
    WO_STATUSES,
    Inspection,
    InspectionTemplate,
    PMSchedule,
    WorkOrder,
)
from app.modules.maintenance.schemas import (
    ApprovalIn,
    AssignIn,
    BulkWorkOrderIn,
    CostIn,
    EvidenceIn,
    FindingCreated,
    FindingIn,
    FindingOut,
    FindingUpdate,
    InspectionCreate,
    InspectionFacets,
    InspectionListItem,
    InspectionOut,
    InspectionStatusIn,
    InspectionUpdate,
    PMScanOut,
    PMScheduleIn,
    PMScheduleOut,
    ResponsesIn,
    ResponsibilityIn,
    SatisfactionIn,
    ServiceHistoryOut,
    SettingsIn,
    SettingsOut,
    TemplateIn,
    TemplateOut,
    TransitionIn,
    WorkOrderCreate,
    WorkOrderFacets,
    WorkOrderListItem,
    WorkOrderOut,
    WorkOrderUpdate,
)
from app.modules.maintenance.service import InspectionFilters, WorkOrderFilters

router = APIRouter(tags=["maintenance"])

VIEW = require("maintenance", "view")
CREATE = require("maintenance", "create")
EDIT = require("maintenance", "edit")
APPROVE = require("maintenance", "approve")
DELETE = require("maintenance", "delete")

WO_SORTS = {
    "number": WorkOrder.number, "title": WorkOrder.title, "priority": WorkOrder.priority, "status": WorkOrder.status,
    "category": WorkOrder.category, "due_on": WorkOrder.due_on, "estimate_amount": WorkOrder.estimate_amount,
    "actual_cost": WorkOrder.actual_cost, "created_at": WorkOrder.created_at, "updated_at": WorkOrder.updated_at,
    "completed_at": WorkOrder.completed_at,
}


def wo_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    priority: list[str] | None = Query(None),
    category: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    approval_status: list[str] | None = Query(None),
    tenant_responsibility: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    space_id: uuid.UUID | None = None,
    vendor_id: uuid.UUID | None = None,
    assigned_user_id: uuid.UUID | None = None,
    pm_schedule_id: uuid.UUID | None = None,
    inspection_id: uuid.UUID | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    min_cost: float | None = None,
    max_cost: float | None = None,
    overdue: bool | None = None,
    open_only: bool | None = None,
) -> WorkOrderFilters:
    return WorkOrderFilters(**locals())


# ======================================================================= work orders

@router.get("/work-orders", response_model=Page[WorkOrderListItem])
async def list_work_orders(db: DB, params: ListParams = Depends(), f: WorkOrderFilters = Depends(wo_filters),
                           _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.build_query(f), params.sort, WO_SORTS, WorkOrder.created_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[WorkOrderListItem](items=await service.decorate(db, rows), total=total, page=params.page,
                                   page_size=params.page_size)


@router.get("/work-orders/facets", response_model=WorkOrderFacets)
async def work_order_facets(db: DB, f: WorkOrderFilters = Depends(wo_filters), _: CurrentUser = Depends(VIEW)):
    out = {}
    for key in ("status", "priority", "category", "source", "approval_status"):
        out[key] = await facet_counts(db, service.build_query(f, skip={key}), getattr(WorkOrder, key))
    return WorkOrderFacets(**out)


@router.get("/work-orders/meta")
async def work_order_meta(_: CurrentUser = Depends(VIEW)):
    return {"statuses": WO_STATUSES, "priorities": WO_PRIORITIES, "categories": WO_CATEGORIES, "sources": WO_SOURCES,
            "frequencies": [*PM_FREQUENCIES, "custom"], "severities": SEVERITIES,
            "inspection_statuses": INSPECTION_STATUSES, "finding_statuses": FINDING_STATUSES}


@router.get("/work-orders/export")
async def export_work_orders(db: DB, params: ListParams = Depends(), f: WorkOrderFilters = Depends(wo_filters),
                             user: CurrentUser = Depends(require("maintenance", "export"))):
    stmt = apply_sort(service.build_query(f), params.sort, WO_SORTS, WorkOrder.created_at.desc()).limit(50_000)
    items = await service.decorate(db, list(await db.scalars(stmt)))
    cols = ["number", "title", "property_name", "source", "category", "priority", "status", "vendor_name",
            "assignee_name", "estimate_amount", "actual_cost", "approval_status", "tenant_responsibility", "due_on",
            "satisfaction_rating", "created_at", "completed_at", "verified_at"]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(cols)
    for r in items:
        writer.writerow([getattr(r, c) for c in cols])
    await audit.record(db, actor=user, action="work_order.exported", entity_type="work_order",
                       summary=f"{len(items)} rows", ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=work-orders.csv"})


@router.get("/work-orders/settings", response_model=SettingsOut)
async def get_settings(db: DB, _: CurrentUser = Depends(VIEW)):
    s = await service.get_settings(db)
    await db.commit()
    return s


@router.put("/work-orders/settings", response_model=SettingsOut)
async def put_settings(body: SettingsIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.update_settings(db, body, user)


@router.get("/work-orders/service-history", response_model=ServiceHistoryOut)
async def service_history(db: DB, asset_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
                          system: str | None = None, _: CurrentUser = Depends(VIEW)):
    return await service.service_history(db, asset_id=asset_id, property_id=property_id, system=system)


@router.post("/work-orders", response_model=WorkOrderOut, status_code=201)
async def create_work_order(body: WorkOrderCreate, db: DB, user: CurrentUser = Depends(CREATE)):
    return await service.to_out(db, await service.create(db, body, user))


@router.post("/work-orders/bulk")
async def bulk_work_orders(body: BulkWorkOrderIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return {"updated": await service.bulk_update(db, body.ids, body.priority, body.assigned_user_id, user)}


@router.get("/work-orders/{wo_id}", response_model=WorkOrderOut)
async def get_work_order(wo_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.to_out(db, await service.get(db, wo_id))


@router.patch("/work-orders/{wo_id}", response_model=WorkOrderOut)
async def update_work_order(wo_id: uuid.UUID, body: WorkOrderUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.to_out(db, await service.update(db, await service.get(db, wo_id), body, user))


@router.delete("/work-orders/{wo_id}", status_code=204)
async def archive_work_order(wo_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive(db, await service.get(db, wo_id), user)


@router.post("/work-orders/{wo_id}/assign", response_model=WorkOrderOut)
async def assign_work_order(wo_id: uuid.UUID, body: AssignIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.to_out(db, await service.assign(db, await service.get(db, wo_id), body, user))


@router.post("/work-orders/{wo_id}/transition", response_model=WorkOrderOut)
async def transition_work_order(wo_id: uuid.UUID, body: TransitionIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.to_out(db, await service.transition(db, await service.get(db, wo_id), body, user))


@router.post("/work-orders/{wo_id}/costs", response_model=WorkOrderOut)
async def set_costs(wo_id: uuid.UUID, body: CostIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.to_out(db, await service.set_costs(db, await service.get(db, wo_id), body, user))


@router.post("/work-orders/{wo_id}/approval", response_model=WorkOrderOut)
async def decide_approval(wo_id: uuid.UUID, body: ApprovalIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    wo = await service.decide_approval(db, await service.get(db, wo_id), body.decision, body.note, user)
    return await service.to_out(db, wo)


@router.post("/work-orders/{wo_id}/responsibility", response_model=WorkOrderOut)
async def determine_responsibility(wo_id: uuid.UUID, body: ResponsibilityIn, db: DB, user: CurrentUser = Depends(EDIT)):
    wo = await service.determine_responsibility(db, await service.get(db, wo_id), body, user)
    return await service.to_out(db, wo)


@router.post("/work-orders/{wo_id}/chargeback", response_model=WorkOrderOut)
async def create_chargeback(wo_id: uuid.UUID, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.to_out(db, await service.create_chargeback(db, await service.get(db, wo_id), user))


@router.post("/work-orders/{wo_id}/satisfaction", response_model=WorkOrderOut)
async def rate_work_order(wo_id: uuid.UUID, body: SatisfactionIn, db: DB, user: CurrentUser = Depends(EDIT)):
    wo = await service.rate(db, await service.get(db, wo_id), body.rating, body.comment, user)
    return await service.to_out(db, wo)


@router.post("/work-orders/{wo_id}/evidence", response_model=WorkOrderOut)
async def add_evidence(wo_id: uuid.UUID, body: EvidenceIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.to_out(db, await service.add_evidence(db, await service.get(db, wo_id), body.document_ids, user))


# ======================================================================= preventive maintenance

PM_SORTS = {"next_service_on": PMSchedule.next_service_on, "last_service_on": PMSchedule.last_service_on,
            "title": PMSchedule.title, "system": PMSchedule.system, "frequency": PMSchedule.frequency,
            "updated_at": PMSchedule.updated_at}


@router.get("/pm-schedules", response_model=Page[PMScheduleOut])
async def list_pm(db: DB, params: ListParams = Depends(), property_id: uuid.UUID | None = None,
                  asset_id: uuid.UUID | None = None, active: bool | None = None,
                  frequency: list[str] | None = Query(None), due_within_days: int | None = Query(None, ge=0),
                  _: CurrentUser = Depends(VIEW)):
    stmt = service.pm_query(params.q, property_id, asset_id, active, frequency, due_within_days)
    rows, total = await paginate(db, apply_sort(stmt, params.sort, PM_SORTS, PMSchedule.next_service_on.asc()), params)
    return Page[PMScheduleOut](items=await service.pm_out(db, rows), total=total, page=params.page,
                               page_size=params.page_size)


@router.post("/pm-schedules/scan", response_model=PMScanOut)
async def scan_pm(db: DB, property_id: uuid.UUID | None = None, user: CurrentUser = Depends(CREATE)):
    return await service.generate_pm_work_orders(db, user, property_id=property_id)


@router.post("/pm-schedules", response_model=PMScheduleOut, status_code=201)
async def create_pm(body: PMScheduleIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.pm_out(db, [await service.save_pm(db, body, user)]))[0]


@router.get("/pm-schedules/{pm_id}", response_model=PMScheduleOut)
async def get_pm(pm_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return (await service.pm_out(db, [await service.get_pm(db, pm_id)]))[0]


@router.put("/pm-schedules/{pm_id}", response_model=PMScheduleOut)
async def update_pm(pm_id: uuid.UUID, body: PMScheduleIn, db: DB, user: CurrentUser = Depends(EDIT)):
    s = await service.save_pm(db, body, user, await service.get_pm(db, pm_id))
    return (await service.pm_out(db, [s]))[0]


@router.delete("/pm-schedules/{pm_id}", status_code=204)
async def archive_pm(pm_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_pm(db, await service.get_pm(db, pm_id), user)


# ======================================================================= inspection templates

@router.get("/inspection-templates", response_model=list[TemplateOut])
async def list_templates(db: DB, q: str | None = None, property_type: str | None = None, active: bool | None = None,
                         _: CurrentUser = Depends(VIEW)):
    stmt = select(InspectionTemplate).where(InspectionTemplate.deleted_at.is_(None))
    if q:
        stmt = stmt.where(InspectionTemplate.name.ilike(f"%{q}%"))
    if property_type:
        stmt = stmt.where((InspectionTemplate.property_type == property_type) | InspectionTemplate.property_type.is_(None))
    if active is not None:
        stmt = stmt.where(InspectionTemplate.is_active.is_(active))
    rows = list(await db.scalars(stmt.order_by(InspectionTemplate.name)))
    return [service.template_out(t) for t in rows]


@router.post("/inspection-templates", response_model=TemplateOut, status_code=201)
async def create_template(body: TemplateIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return service.template_out(await service.save_template(db, body, user))


@router.get("/inspection-templates/{template_id}", response_model=TemplateOut)
async def get_template(template_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return service.template_out(await service.get_template(db, template_id))


@router.put("/inspection-templates/{template_id}", response_model=TemplateOut)
async def update_template(template_id: uuid.UUID, body: TemplateIn, db: DB, user: CurrentUser = Depends(EDIT)):
    t = await service.save_template(db, body, user, await service.get_template(db, template_id))
    return service.template_out(t)


@router.delete("/inspection-templates/{template_id}", status_code=204)
async def archive_template(template_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_template(db, await service.get_template(db, template_id), user)


# ======================================================================= inspections

INSP_SORTS = {"scheduled_on": Inspection.scheduled_on, "status": Inspection.status, "score": Inspection.score,
              "completed_at": Inspection.completed_at, "updated_at": Inspection.updated_at}


def insp_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    inspector_id: uuid.UUID | None = None,
    template_id: uuid.UUID | None = None,
    scheduled_from: date | None = None,
    scheduled_to: date | None = None,
) -> InspectionFilters:
    return InspectionFilters(**locals())


@router.get("/inspections", response_model=Page[InspectionListItem])
async def list_inspections(db: DB, params: ListParams = Depends(), f: InspectionFilters = Depends(insp_filters),
                           _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.inspection_query(f), params.sort, INSP_SORTS, Inspection.scheduled_on.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[InspectionListItem](items=await service.inspection_items(db, rows), total=total, page=params.page,
                                    page_size=params.page_size)


@router.get("/inspections/facets", response_model=InspectionFacets)
async def inspection_facets(db: DB, f: InspectionFilters = Depends(insp_filters), _: CurrentUser = Depends(VIEW)):
    return InspectionFacets(status=await facet_counts(db, service.inspection_query(f, skip={"status"}), Inspection.status))


@router.post("/inspections", response_model=InspectionOut, status_code=201)
async def create_inspection(body: InspectionCreate, db: DB, user: CurrentUser = Depends(CREATE)):
    return await service.inspection_out(db, await service.create_inspection(db, body, user))


@router.get("/inspections/{inspection_id}", response_model=InspectionOut)
async def get_inspection(inspection_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.inspection_out(db, await service.get_inspection(db, inspection_id))


@router.patch("/inspections/{inspection_id}", response_model=InspectionOut)
async def update_inspection(inspection_id: uuid.UUID, body: InspectionUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    insp = await service.update_inspection(db, await service.get_inspection(db, inspection_id), body, user)
    return await service.inspection_out(db, insp)


@router.delete("/inspections/{inspection_id}", status_code=204)
async def archive_inspection(inspection_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_inspection(db, await service.get_inspection(db, inspection_id), user)


@router.post("/inspections/{inspection_id}/responses", response_model=InspectionOut)
async def record_responses(inspection_id: uuid.UUID, body: ResponsesIn, db: DB, user: CurrentUser = Depends(EDIT)):
    insp = await service.record_responses(db, await service.get_inspection(db, inspection_id), body.responses, user)
    return await service.inspection_out(db, insp)


@router.post("/inspections/{inspection_id}/status", response_model=InspectionOut)
async def set_inspection_status(inspection_id: uuid.UUID, body: InspectionStatusIn, db: DB,
                                user: CurrentUser = Depends(EDIT)):
    insp = await service.set_inspection_status(db, await service.get_inspection(db, inspection_id), body.status,
                                               body.summary, user)
    return await service.inspection_out(db, insp)


@router.post("/inspections/{inspection_id}/findings", response_model=FindingCreated, status_code=201)
async def add_finding(inspection_id: uuid.UUID, body: FindingIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.add_finding(db, await service.get_inspection(db, inspection_id), body, user)


@router.patch("/inspection-findings/{finding_id}", response_model=FindingOut)
async def update_finding(finding_id: uuid.UUID, body: FindingUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.update_finding(db, await service.get_finding(db, finding_id), body, user)


@router.post("/inspection-findings/{finding_id}/work-order", response_model=WorkOrderOut, status_code=201)
async def finding_work_order(finding_id: uuid.UUID, db: DB, user: CurrentUser = Depends(CREATE)):
    wo = await service.finding_to_work_order(db, await service.get_finding(db, finding_id), user)
    return await service.to_out(db, wo)
