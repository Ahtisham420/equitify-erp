import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select

from app.common.query import ListParams, Page, apply_search, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.receivables import service
from app.modules.receivables.models import (
    CHARGE_SOURCES,
    CHARGE_STATUSES,
    CHARGE_TYPES,
    COLLECTION_STATUSES,
    PAYMENT_METHODS,
    PLAN_STATUSES,
    Charge,
    CollectionStatus,
    DelinquencyNotice,
    Payment,
    PaymentPlan,
    SyncBatch,
    SyncConflict,
)
from app.modules.receivables.schemas import (
    ApplyIn,
    BatchDetail,
    BatchOut,
    ChargeFacets,
    ChargeOut,
    CollectionOut,
    ConflictOut,
    Dashboard,
    EvaluateIn,
    EvaluateOut,
    ExportIn,
    GenerateIn,
    GenerateOut,
    ImportIn,
    LedgerOut,
    ManualChargeIn,
    NoticeCreate,
    NoticeOut,
    NoticeSendIn,
    PaymentIn,
    PaymentOut,
    PlanIn,
    PlanOut,
    ReconBillIn,
    ReconBillOut,
    ResolveIn,
    SettingsIn,
    SettingsOut,
    TenantBalance,
    UnapplyIn,
    VoidIn,
)
from app.modules.receivables.service import ChargeFilters

router = APIRouter(prefix="/receivables", tags=["receivables"])

CHARGE_SORTS = {
    "due_on": Charge.due_on, "amount": Charge.amount, "tenant_name": Charge.tenant_name, "status": Charge.status,
    "charge_type": Charge.charge_type, "balance": Charge.amount - Charge.amount_paid, "created_at": Charge.created_at,
}
PAYMENT_SORTS = {
    "received_on": Payment.received_on, "amount": Payment.amount, "tenant_name": Payment.tenant_name,
    "unapplied_amount": Payment.unapplied_amount, "created_at": Payment.created_at,
}


async def _names(db, lease_ids) -> dict[uuid.UUID, str]:
    from app.modules.leases.models import Lease

    ids = {i for i in lease_ids if i}
    if not ids:
        return {}
    return dict((await db.execute(select(Lease.id, Lease.tenant_name).where(Lease.id.in_(ids)))).all())


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("receivables", "view"))):
    return {"charge_types": CHARGE_TYPES, "charge_statuses": CHARGE_STATUSES, "charge_sources": CHARGE_SOURCES,
            "payment_methods": PAYMENT_METHODS, "plan_statuses": PLAN_STATUSES,
            "collection_statuses": COLLECTION_STATUSES}


@router.get("/dashboard", response_model=Dashboard)
async def dashboard(db: DB, property_id: uuid.UUID | None = None, asset_id: uuid.UUID | None = None,
                    as_of: date | None = None, _: CurrentUser = Depends(require("receivables", "view"))):
    return await service.dashboard(db, property_id=property_id, asset_id=asset_id, as_of=as_of)


# --------------------------------------------------------------------------- tenants / ledger

@router.get("/tenants", response_model=Page[TenantBalance])
async def tenants(
    db: DB, params: ListParams = Depends(), property_id: uuid.UUID | None = None, asset_id: uuid.UUID | None = None,
    collection_status: list[str] | None = Query(None), delinquent_only: bool = False,
    _: CurrentUser = Depends(require("receivables", "view")),
):
    stmt, sorts, balance = service.tenants_statement(date.today(), property_id=property_id, asset_id=asset_id,
                                                     q=params.q, collection_status=collection_status,
                                                     delinquent_only=delinquent_only)
    stmt = apply_sort(stmt, params.sort, sorts, balance.desc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[TenantBalance](items=await service.tenant_rows(db, rows), total=total, page=params.page,
                               page_size=params.page_size)


@router.get("/tenants/{lease_id}/ledger", response_model=LedgerOut)
async def ledger(lease_id: uuid.UUID, db: DB, as_of: date | None = None,
                 _: CurrentUser = Depends(require("receivables", "view"))):
    return await service.ledger(db, lease_id, as_of)


# --------------------------------------------------------------------------- charges

def charge_filters(
    q: str | None = Query(None, max_length=200),
    lease_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    charge_type: list[str] | None = Query(None),
    status: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    period: str | None = Query(None, pattern=r"^\d{4}-\d{2}$"),
    due_from: date | None = None,
    due_to: date | None = None,
    overdue: bool | None = None,
) -> ChargeFilters:
    return ChargeFilters(**locals())


@router.get("/charges", response_model=Page[ChargeOut])
async def list_charges(db: DB, params: ListParams = Depends(), f: ChargeFilters = Depends(charge_filters),
                       _: CurrentUser = Depends(require("receivables", "view"))):
    stmt = apply_sort(service.build_charge_query(f), params.sort, CHARGE_SORTS, Charge.due_on.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[ChargeOut](items=[service.charge_out(c) for c in rows], total=total, page=params.page,
                           page_size=params.page_size)


@router.get("/charges/facets", response_model=ChargeFacets)
async def charge_facets(db: DB, f: ChargeFilters = Depends(charge_filters),
                        _: CurrentUser = Depends(require("receivables", "view"))):
    q = service.build_charge_query
    return ChargeFacets(
        status=await facet_counts(db, q(f, skip={"status"}), Charge.status),
        charge_type=await facet_counts(db, q(f, skip={"charge_type"}), Charge.charge_type),
        source=await facet_counts(db, q(f, skip={"source"}), Charge.source),
    )


@router.post("/charges/generate", response_model=GenerateOut)
async def generate(body: GenerateIn, db: DB, user: CurrentUser = Depends(require("receivables", "create"))):
    return await service.generate_charges(db, body, user)


@router.post("/charges", response_model=ChargeOut, status_code=201)
async def create_charge(body: ManualChargeIn, db: DB, user: CurrentUser = Depends(require("receivables", "create"))):
    return service.charge_out(await service.create_manual_charge(db, body, user))


@router.post("/charges/{charge_id}/approve", response_model=ChargeOut)
async def approve_charge(charge_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("receivables", "approve"))):
    c = await service.get_row(db, Charge, charge_id, "Charge")
    return service.charge_out(await service.approve_charge(db, c, user))


@router.post("/charges/{charge_id}/void", response_model=ChargeOut)
async def void_charge(charge_id: uuid.UUID, body: VoidIn, db: DB,
                      user: CurrentUser = Depends(require("receivables", "approve"))):
    c = await service.get_row(db, Charge, charge_id, "Charge")
    return service.charge_out(await service.void_charge(db, c, body.reason, user))


@router.post("/late-fees/assess")
async def assess_late_fees(body: EvaluateIn, db: DB, user: CurrentUser = Depends(require("receivables", "create"))):
    return {"created": await service.assess_late_fees(db, body.as_of, body.property_id, user)}


# --------------------------------------------------------------------------- payments

@router.get("/payments", response_model=Page[PaymentOut])
async def list_payments(
    db: DB, params: ListParams = Depends(), lease_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
    status: list[str] | None = Query(None), method: list[str] | None = Query(None),
    received_from: date | None = None, received_to: date | None = None, unapplied_only: bool = False,
    _: CurrentUser = Depends(require("receivables", "view")),
):
    stmt = select(Payment).where(Payment.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [Payment.tenant_name, Payment.reference])
    if lease_id:
        stmt = stmt.where(Payment.lease_id == lease_id)
    if property_id:
        stmt = stmt.where(Payment.property_id == property_id)
    stmt = in_filter(stmt, Payment.status, status)
    stmt = in_filter(stmt, Payment.method, method)
    if received_from:
        stmt = stmt.where(Payment.received_on >= received_from)
    if received_to:
        stmt = stmt.where(Payment.received_on <= received_to)
    if unapplied_only:
        stmt = stmt.where(Payment.unapplied_amount > 0, Payment.status == "received")
    rows, total = await paginate(db, apply_sort(stmt, params.sort, PAYMENT_SORTS, Payment.received_on.desc()), params)
    return Page[PaymentOut](items=[await service.payment_out(db, p) for p in rows], total=total, page=params.page,
                            page_size=params.page_size)


@router.post("/payments", response_model=PaymentOut, status_code=201)
async def record_payment(body: PaymentIn, db: DB, user: CurrentUser = Depends(require("receivables", "create"))):
    return await service.payment_out(db, await service.record_payment(db, body, user))


@router.get("/payments/{payment_id}", response_model=PaymentOut)
async def get_payment(payment_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("receivables", "view"))):
    return await service.payment_out(db, await service.get_row(db, Payment, payment_id, "Payment"))


@router.post("/payments/{payment_id}/apply", response_model=PaymentOut)
async def apply_payment(payment_id: uuid.UUID, body: ApplyIn, db: DB,
                        user: CurrentUser = Depends(require("receivables", "edit"))):
    p = await service.get_row(db, Payment, payment_id, "Payment")
    return await service.payment_out(db, await service.apply_payment(db, p, body, user))


@router.post("/payments/{payment_id}/unapply", response_model=PaymentOut)
async def unapply_payment(payment_id: uuid.UUID, body: UnapplyIn, db: DB,
                          user: CurrentUser = Depends(require("receivables", "edit"))):
    p = await service.get_row(db, Payment, payment_id, "Payment")
    return await service.payment_out(db, await service.unapply(db, p, body, user))


@router.post("/payments/{payment_id}/reverse", response_model=PaymentOut)
async def reverse_payment(payment_id: uuid.UUID, body: VoidIn, db: DB,
                          user: CurrentUser = Depends(require("receivables", "approve"))):
    p = await service.get_row(db, Payment, payment_id, "Payment")
    return await service.payment_out(db, await service.reverse_payment(db, p, body.reason, user))


# --------------------------------------------------------------------------- settings & delinquency

@router.get("/settings", response_model=SettingsOut)
async def get_settings(db: DB, _: CurrentUser = Depends(require("receivables", "view"))):
    return await service.get_settings(db)


@router.put("/settings", response_model=SettingsOut)
async def put_settings(body: SettingsIn, db: DB, user: CurrentUser = Depends(require("receivables", "approve"))):
    return await service.save_settings(db, body, user)


@router.post("/delinquency/evaluate", response_model=EvaluateOut)
async def evaluate(body: EvaluateIn, db: DB, user: CurrentUser = Depends(require("receivables", "edit"))):
    return await service.evaluate(db, body, user)


@router.get("/delinquency", response_model=list[CollectionOut])
async def delinquency(db: DB, property_id: uuid.UUID | None = None, status: list[str] | None = Query(None),
                      _: CurrentUser = Depends(require("receivables", "view"))):
    from app.modules.leases.models import Lease
    from app.modules.properties.models import Property

    stmt = (select(CollectionStatus, Lease.tenant_name, func.coalesce(Property.name, Property.address_line))
            .join(Lease, Lease.id == CollectionStatus.lease_id).join(Property, Property.id == Lease.property_id)
            .where(Lease.deleted_at.is_(None)))
    if property_id:
        stmt = stmt.where(Lease.property_id == property_id)
    stmt = stmt.where(CollectionStatus.status.in_(status)) if status else stmt.where(CollectionStatus.status != "current")
    labels = {s.key: s.label for s in (await service.get_settings(db)).ladder}
    out = []
    for cs, tenant, prop in (await db.execute(stmt.order_by(CollectionStatus.days_past_due.desc()).limit(500))).all():
        o = CollectionOut.model_validate(cs)
        o.tenant_name, o.property_name, o.step_label = tenant, prop, labels.get(cs.step_key or "")
        out.append(o)
    return out


@router.get("/notices", response_model=Page[NoticeOut])
async def list_notices(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None), lease_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None, step_key: list[str] | None = Query(None),
    _: CurrentUser = Depends(require("receivables", "view")),
):
    stmt = select(DelinquencyNotice).where(DelinquencyNotice.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [DelinquencyNotice.subject, DelinquencyNotice.label])
    stmt = in_filter(stmt, DelinquencyNotice.status, status)
    stmt = in_filter(stmt, DelinquencyNotice.step_key, step_key)
    if lease_id:
        stmt = stmt.where(DelinquencyNotice.lease_id == lease_id)
    if property_id:
        stmt = stmt.where(DelinquencyNotice.property_id == property_id)
    sorts = {"created_at": DelinquencyNotice.created_at, "balance": DelinquencyNotice.balance,
             "days_past_due": DelinquencyNotice.days_past_due}
    rows, total = await paginate(db, apply_sort(stmt, params.sort, sorts, DelinquencyNotice.created_at.desc()), params)
    names = await _names(db, [n.lease_id for n in rows])
    items = []
    for n in rows:
        o = NoticeOut.model_validate(n)
        o.tenant_name = names.get(n.lease_id)
        items.append(o)
    return Page[NoticeOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("/notices", response_model=NoticeOut, status_code=201)
async def create_notice(body: NoticeCreate, db: DB, user: CurrentUser = Depends(require("receivables", "create"))):
    return await service.create_notice(db, body.lease_id, body.step_key, user)


@router.post("/notices/{notice_id}/send", response_model=NoticeOut)
async def send_notice(notice_id: uuid.UUID, body: NoticeSendIn, db: DB,
                      user: CurrentUser = Depends(require("receivables", "edit"))):
    n = await service.get_row(db, DelinquencyNotice, notice_id, "Notice")
    return await service.send_notice(db, n, body.delivery_method, user)


@router.post("/notices/{notice_id}/cancel", response_model=NoticeOut)
async def cancel_notice(notice_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("receivables", "edit"))):
    n = await service.get_row(db, DelinquencyNotice, notice_id, "Notice")
    return await service.cancel_notice(db, n, user)


# --------------------------------------------------------------------------- payment plans

@router.get("/payment-plans", response_model=list[PlanOut])
async def list_plans(db: DB, status: list[str] | None = Query(None), lease_id: uuid.UUID | None = None,
                     property_id: uuid.UUID | None = None, _: CurrentUser = Depends(require("receivables", "view"))):
    stmt = select(PaymentPlan).where(PaymentPlan.deleted_at.is_(None))
    stmt = in_filter(stmt, PaymentPlan.status, status)
    if lease_id:
        stmt = stmt.where(PaymentPlan.lease_id == lease_id)
    if property_id:
        stmt = stmt.where(PaymentPlan.property_id == property_id)
    return [await service.plan_out(db, p) for p in await db.scalars(stmt.order_by(PaymentPlan.created_at.desc()).limit(200))]


@router.post("/payment-plans", response_model=PlanOut, status_code=201)
async def create_plan(body: PlanIn, db: DB, user: CurrentUser = Depends(require("receivables", "approve"))):
    return await service.plan_out(db, await service.create_plan(db, body, user))


@router.post("/payment-plans/{plan_id}/cancel", response_model=PlanOut)
async def cancel_plan(plan_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("receivables", "approve"))):
    plan = await service.get_row(db, PaymentPlan, plan_id, "Payment plan")
    return await service.plan_out(db, await service.cancel_plan(db, plan, user))


# --------------------------------------------------------------------------- reconciliation billing

@router.get("/reconciliation-billing")
async def billable_reconciliations(db: DB, property_id: uuid.UUID | None = None, year: int | None = None,
                                   status: list[str] | None = Query(None),
                                   _: CurrentUser = Depends(require("receivables", "view"))):
    from app.modules.leases.models import Lease, RecoveryReconciliation
    from app.modules.leases.schemas import ReconciliationOut

    stmt = (select(RecoveryReconciliation, Lease.tenant_name).join(Lease, Lease.id == RecoveryReconciliation.lease_id)
            .where(RecoveryReconciliation.deleted_at.is_(None),
                   RecoveryReconciliation.status.in_(status or ["final", "billed"])))
    if property_id:
        stmt = stmt.where(RecoveryReconciliation.property_id == property_id)
    if year:
        stmt = stmt.where(RecoveryReconciliation.year == year)
    out = []
    for rec, tenant in (await db.execute(stmt.order_by(RecoveryReconciliation.year.desc()).limit(500))).all():
        o = ReconciliationOut.model_validate(rec)
        o.tenant_name = tenant
        out.append(o)
    return out


@router.post("/reconciliation-billing", response_model=ReconBillOut)
async def bill_reconciliations(body: ReconBillIn, db: DB, user: CurrentUser = Depends(require("receivables", "create"))):
    return await service.bill_reconciliations(db, body, user)


# --------------------------------------------------------------------------- accounting / banking sync

@router.get("/sync/batches", response_model=list[BatchOut])
async def list_batches(db: DB, direction: str | None = None, _: CurrentUser = Depends(require("receivables", "view"))):
    stmt = select(SyncBatch).where(SyncBatch.deleted_at.is_(None))
    if direction:
        stmt = stmt.where(SyncBatch.direction == direction)
    return list(await db.scalars(stmt.order_by(SyncBatch.created_at.desc()).limit(200)))


@router.get("/sync/batches/{batch_id}", response_model=BatchDetail)
async def get_batch(batch_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("receivables", "view"))):
    return await service.get_row(db, SyncBatch, batch_id, "Batch")


@router.post("/sync/export", response_model=BatchDetail, status_code=201)
async def export_ledger(body: ExportIn, db: DB, user: CurrentUser = Depends(require("receivables", "export"))):
    return await service.export_batch(db, body, user)


@router.post("/sync/import", response_model=BatchOut, status_code=201)
async def import_ledger(body: ImportIn, db: DB, user: CurrentUser = Depends(require("receivables", "edit"))):
    return await service.import_batch(db, body, user)


@router.get("/sync/conflicts", response_model=Page[ConflictOut])
async def list_conflicts(db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
                         batch_id: uuid.UUID | None = None, _: CurrentUser = Depends(require("receivables", "view"))):
    stmt = select(SyncConflict)
    stmt = in_filter(stmt, SyncConflict.status, status)
    if batch_id:
        stmt = stmt.where(SyncConflict.batch_id == batch_id)
    rows, total = await paginate(db, stmt.order_by(SyncConflict.created_at.desc()), params)
    return Page[ConflictOut](items=rows, total=total, page=params.page, page_size=params.page_size)


@router.post("/sync/conflicts/{conflict_id}/resolve", response_model=ConflictOut)
async def resolve_conflict(conflict_id: uuid.UUID, body: ResolveIn, db: DB,
                           user: CurrentUser = Depends(require("receivables", "approve"))):
    cf = await db.get(SyncConflict, conflict_id)
    if not cf:
        raise HTTPException(404, "Conflict not found")
    return await service.resolve_conflict(db, cf, body, user)
