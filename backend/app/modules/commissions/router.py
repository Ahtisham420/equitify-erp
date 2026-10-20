import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.commissions import service
from app.modules.commissions.models import (
    COMMISSION_STATUSES,
    INVOICE_STATUSES,
    RECONCILIATION_STATES,
    SIDES,
    Commission,
    CommissionEvent,
    CommissionInvoice,
    SplitPlan,
)
from app.modules.commissions.schemas import (
    AgentPlanIn,
    AgentPlanOut,
    CancelIn,
    CommissionCreate,
    CommissionFacets,
    CommissionListItem,
    CommissionOut,
    CommissionUpdate,
    DealOption,
    EarnIn,
    EventOut,
    InvoiceCreate,
    InvoiceOut,
    NoteIn,
    PaymentCreate,
    PaymentOut,
    PlanIn,
    PlanOut,
    ReleaseIn,
    SyncOut,
    VoidIn,
)
from app.modules.commissions.service import CommissionFilters

router = APIRouter(prefix="/commissions", tags=["commissions"])

VIEW = require("commissions", "view")
CREATE = require("commissions", "create")
EDIT = require("commissions", "edit")
APPROVE = require("commissions", "approve")
SENSITIVE = require("commissions", "view_sensitive")

SORTS = {
    "title": Commission.title, "gross": Commission.gross, "status": Commission.status,
    "expected_on": Commission.expected_on, "expected_close_on": Commission.expected_close_on,
    "earned_on": Commission.earned_on, "paid_on": Commission.paid_on, "probability": Commission.probability,
    "deal_volume": Commission.deal_volume, "updated_at": Commission.updated_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    side: list[str] | None = Query(None),
    property_type: list[str] | None = Query(None),
    reconciliation_status: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None),
    brokerage_deal_id: uuid.UUID | None = None,
    min_gross: float | None = None,
    max_gross: float | None = None,
    expected_from: date | None = None,
    expected_to: date | None = None,
) -> CommissionFilters:
    return CommissionFilters(**locals())


@router.get("", response_model=Page[CommissionListItem])
async def list_commissions(db: DB, params: ListParams = Depends(), f: CommissionFilters = Depends(filters),
                           user: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.build_query(f, user), params.sort, SORTS, Commission.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[CommissionListItem](items=await service.to_items(db, rows, user), total=total, page=params.page,
                                    page_size=params.page_size)


@router.get("/facets", response_model=CommissionFacets)
async def facets(db: DB, f: CommissionFilters = Depends(filters), user: CurrentUser = Depends(VIEW)):
    q = service.build_query
    return CommissionFacets(
        status=await facet_counts(db, q(f, user, skip={"status"}), Commission.status),
        side=await facet_counts(db, q(f, user, skip={"side"}), Commission.side),
        property_type=await facet_counts(db, q(f, user, skip={"property_type"}), Commission.property_type),
        reconciliation_status=await facet_counts(db, q(f, user, skip={"reconciliation_status"}),
                                                 Commission.reconciliation_status),
    )


@router.get("/meta")
async def meta(user: CurrentUser = Depends(VIEW)):
    return {"statuses": COMMISSION_STATUSES, "sides": SIDES, "invoice_statuses": INVOICE_STATUSES,
            "reconciliation_states": RECONCILIATION_STATES, "production_groups": service.GROUPS,
            "restricted": service.restricted(user)}


@router.post("", response_model=CommissionOut, status_code=201)
async def create_commission(body: CommissionCreate, db: DB, user: CurrentUser = Depends(CREATE)):
    return await service.to_out(db, await service.create(db, body, user), user)


@router.post("/sync", response_model=SyncOut)
async def sync(db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.sync_from_deals(db, user)


@router.get("/deal-options", response_model=list[DealOption])
async def deal_options(db: DB, q: str | None = Query(None, max_length=200), user: CurrentUser = Depends(CREATE)):
    deals = await service.deal_rows(db)
    if service.restricted(user):
        deals = [d for d in deals if d.get("agent_id") == user.id]
    labels = await service.deal_labels(db, deals)
    linked = set(await db.scalars(select(Commission.brokerage_deal_id).where(
        Commission.brokerage_deal_id.isnot(None), Commission.deleted_at.is_(None), Commission.status != "cancelled")))
    out = []
    for d in deals:
        label = labels.get(d["id"]) or ""
        if q and q.lower() not in label.lower():
            continue
        out.append(DealOption(id=d["id"], label=label, stage=d.get("stage"), agent_id=d.get("agent_id"),
                              expected_close_on=d.get("expected_close_on"),
                              probability=service.norm_prob(d.get("probability")),
                              gross_commission_estimate=d.get("gross_commission_estimate"),
                              has_commission=d["id"] in linked))
    return sorted(out, key=lambda o: o.label)[:200]


# --------------------------------------------------------------------------- forecast & production

@router.get("/forecast")
async def forecast(db: DB, months: int = Query(12, ge=1, le=36), agent_id: uuid.UUID | None = None,
                   user: CurrentUser = Depends(VIEW)):
    await service.ensure_snapshot(db, user)  # monthly forecast snapshot for accuracy tracking (idempotent)
    return await service.forecast(db, user, months, agent_id)


@router.post("/forecast/snapshot")
async def snapshot(db: DB, user: CurrentUser = Depends(EDIT)):
    s = await service.ensure_snapshot(db, user)
    return {"snapshot_month": s.snapshot_month, "total_weighted": s.total_weighted, "taken_at": s.taken_at}


@router.get("/forecast/accuracy")
async def forecast_accuracy(db: DB, months: int = Query(12, ge=1, le=36), _: CurrentUser = Depends(SENSITIVE)):
    return await service.accuracy(db, months)


@router.get("/production")
async def production(
    db: DB,
    group_by: str = "agent",
    start: date | None = None,
    end: date | None = None,
    agent_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    property_type: str | None = None,
    source: str | None = None,
    user: CurrentUser = Depends(VIEW),
):
    return await service.production(db, user, group_by, start, end, agent_id, team_id, property_type, source)


# --------------------------------------------------------------------------- invoices

@router.get("/invoices", response_model=Page[InvoiceOut])
async def list_invoices(db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
                        overdue: bool | None = None, user: CurrentUser = Depends(VIEW)):
    stmt = (select(CommissionInvoice).join(Commission, Commission.id == CommissionInvoice.commission_id)
            .where(CommissionInvoice.deleted_at.is_(None), Commission.deleted_at.is_(None)))
    stmt = service.visible(stmt, user)
    if status:
        stmt = stmt.where(CommissionInvoice.status.in_(status))
    if overdue:
        stmt = stmt.where(CommissionInvoice.status == "issued", CommissionInvoice.due_on < date.today())
    if params.q:
        for term in params.q.split():
            stmt = stmt.where(or_(CommissionInvoice.invoice_number.ilike(f"%{term}%"),
                                  CommissionInvoice.bill_to.ilike(f"%{term}%"), Commission.title.ilike(f"%{term}%")))
    stmt = apply_sort(stmt, params.sort, {"invoice_number": CommissionInvoice.invoice_number,
                                          "issued_on": CommissionInvoice.issued_on, "due_on": CommissionInvoice.due_on,
                                          "amount": CommissionInvoice.amount, "status": CommissionInvoice.status},
                      CommissionInvoice.issued_on.desc())
    rows, total = await paginate(db, stmt, params)
    titles = dict((await db.execute(select(Commission.id, Commission.title).where(
        Commission.id.in_({r.commission_id for r in rows})))).all()) if rows else {}
    items = []
    for r in rows:
        o = InvoiceOut.model_validate(r)
        o.commission_title = titles.get(r.commission_id)
        items.append(o)
    return Page[InvoiceOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("/invoices/{invoice_id}/void", response_model=InvoiceOut)
async def void_invoice(invoice_id: uuid.UUID, body: VoidIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    inv = await db.get(CommissionInvoice, invoice_id)
    if not inv or inv.deleted_at:
        raise HTTPException(404, "Invoice not found")
    await service.get(db, inv.commission_id, user)
    return await service.void_invoice(db, inv, body.reason, user)


# --------------------------------------------------------------------------- split plans

@router.get("/split-plans", response_model=list[PlanOut])
async def list_plans(db: DB, _: CurrentUser = Depends(SENSITIVE)):
    from sqlalchemy import func

    from app.modules.commissions.models import AgentPlan

    counts = dict((await db.execute(select(AgentPlan.plan_id, func.count()).where(AgentPlan.deleted_at.is_(None))
                                    .group_by(AgentPlan.plan_id))).all())
    out = []
    for p in await db.scalars(select(SplitPlan).where(SplitPlan.deleted_at.is_(None)).order_by(SplitPlan.name)):
        o = PlanOut.model_validate(p)
        o.agent_count = int(counts.get(p.id, 0))
        out.append(o)
    return out


@router.post("/split-plans", response_model=PlanOut, status_code=201)
async def create_plan(body: PlanIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.save_plan(db, None, body, user)


@router.put("/split-plans/{plan_id}", response_model=PlanOut)
async def update_plan(plan_id: uuid.UUID, body: PlanIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    plan = await db.get(SplitPlan, plan_id)
    if not plan or plan.deleted_at:
        raise HTTPException(404, "Plan not found")
    return await service.save_plan(db, plan, body, user)


@router.get("/agent-plans", response_model=list[AgentPlanOut])
async def list_agent_plans(db: DB, _: CurrentUser = Depends(SENSITIVE)):
    return await service.agent_plans(db)


@router.put("/agent-plans/{agent_id}", status_code=204)
async def assign_plan(agent_id: uuid.UUID, body: AgentPlanIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    await service.assign_plan(db, agent_id, body.plan_id, body.effective_from, user)


# --------------------------------------------------------------------------- single commission

@router.get("/{commission_id}", response_model=CommissionOut)
async def get_commission(commission_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.to_out(db, await service.get(db, commission_id, user), user)


@router.patch("/{commission_id}", response_model=CommissionOut)
async def update_commission(commission_id: uuid.UUID, body: CommissionUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.update(db, await service.get(db, commission_id, user), body, user)
    return await service.to_out(db, c, user)


@router.delete("/{commission_id}", status_code=204)
async def delete_commission(commission_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("commissions", "delete"))):
    from app.common import audit
    from app.core.security import utcnow

    c = await service.get(db, commission_id, user)
    if c.status != "forecast":
        raise HTTPException(409, "Only forecast commissions can be deleted; earned commissions are retained")
    c.deleted_at, c.updated_by_id = utcnow(), user.id
    await audit.record(db, actor=user, action="commission.deleted", entity_type="commission", entity_id=c.id,
                       summary=c.title, ip_address=user.ip_address)
    await db.commit()


@router.get("/{commission_id}/events", response_model=list[EventOut])
async def commission_events(commission_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    await service.get(db, commission_id, user)
    return list(await db.scalars(select(CommissionEvent).where(CommissionEvent.commission_id == commission_id)
                                 .order_by(CommissionEvent.at.desc())))


@router.get("/{commission_id}/compliance")
async def commission_compliance(commission_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    c = await service.get(db, commission_id, user)
    ok, reasons = await service.compliance_check(db, c.brokerage_deal_id)
    return {"complete": ok, "reasons": reasons}


@router.post("/{commission_id}/earn", response_model=CommissionOut)
async def earn(commission_id: uuid.UUID, body: EarnIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.earn(db, await service.get(db, commission_id, user), body, user)
    return await service.to_out(db, c, user)


@router.post("/{commission_id}/approve", response_model=CommissionOut)
async def approve(commission_id: uuid.UUID, body: NoteIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    c = await service.approve(db, await service.get(db, commission_id, user), body.note, user)
    return await service.to_out(db, c, user)


@router.post("/{commission_id}/cancel", response_model=CommissionOut)
async def cancel(commission_id: uuid.UUID, body: CancelIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.cancel(db, await service.get(db, commission_id, user), body.reason, user)
    return await service.to_out(db, c, user)


@router.post("/{commission_id}/invoices", response_model=InvoiceOut, status_code=201)
async def create_invoice(commission_id: uuid.UUID, body: InvoiceCreate, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.get(db, commission_id, user)
    inv = await service.create_invoice(db, c, body, user)
    out = InvoiceOut.model_validate(inv)
    out.commission_title = c.title
    return out


@router.post("/{commission_id}/payments", response_model=PaymentOut, status_code=201)
async def record_payment(commission_id: uuid.UUID, body: PaymentCreate, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.record_payment(db, await service.get(db, commission_id, user), body, user)


@router.post("/{commission_id}/release", response_model=CommissionOut)
async def release(commission_id: uuid.UUID, body: ReleaseIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    c = await service.release(db, await service.get(db, commission_id, user), body, user)
    return await service.to_out(db, c, user)
