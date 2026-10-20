import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common import audit, provenance
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.leases import service
from app.modules.leases.models import (
    AMENDMENT_KINDS,
    CAP_TYPES,
    CLAUSE_CATEGORIES,
    ESCALATION_METHODS,
    GUARANTY_TYPES,
    LEASE_STATUSES,
    LEASE_TYPES,
    OPTION_STATUSES,
    OPTION_TYPES,
    OVERRIDABLE_FIELDS,
    PRICING_METHODS,
    RECOVERY_CATEGORIES,
    RECOVERY_METHODS,
    Guaranty,
    Lease,
    LeaseAmendment,
    LeaseClause,
    LeaseOption,
    LeaseRecovery,
    RecoveryReconciliation,
    RentStep,
)
from app.modules.leases.schemas import (
    AmendmentIn,
    AmendmentOut,
    ClauseIn,
    ClauseOut,
    CriticalDatesOut,
    EscalationIn,
    GuarantyIn,
    GuarantyOut,
    LeaseCreate,
    LeaseFacets,
    LeaseListItem,
    LeaseOut,
    LeaseUpdate,
    ObservationOut,
    OperativeTerms,
    OptionIn,
    OptionOut,
    ReconciliationOut,
    ReconRunIn,
    ReconRunOut,
    RecoveryIn,
    RecoveryOut,
    RentRoll,
    RentStepIn,
    RentStepOut,
    Rollover,
    ScheduleRow,
    SpaceOption,
    VerifyIn,
)
from app.modules.leases.service import LeaseFilters

router = APIRouter(prefix="/leases", tags=["leases"])

SORTS = {
    "tenant_name": Lease.tenant_name, "status": Lease.status, "lease_type": Lease.lease_type,
    "commencement_on": Lease.commencement_on, "expiration_on": Lease.expiration_on, "rentable_sf": Lease.rentable_sf,
    "updated_at": Lease.updated_at, "created_at": Lease.created_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    lease_type: list[str] | None = Query(None),
    verified: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    tenant_organization_id: uuid.UUID | None = None,
    expiring_within: int | None = Query(None, ge=1, le=3650),
    expires_from: date | None = None,
    expires_to: date | None = None,
    min_sf: float | None = None,
    max_sf: float | None = None,
) -> LeaseFilters:
    return LeaseFilters(**locals())


@router.get("", response_model=Page[LeaseListItem])
async def list_leases(db: DB, params: ListParams = Depends(), f: LeaseFilters = Depends(filters),
                      _: CurrentUser = Depends(require("leases", "view"))):
    sorts = {**SORTS, "current_annual_rent": service.current_rent_expr()}
    stmt = apply_sort(service.list_statement(f), params.sort, sorts, Lease.updated_at.desc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[LeaseListItem](items=service.list_items(rows), total=total, page=params.page,
                               page_size=params.page_size)


@router.get("/facets", response_model=LeaseFacets)
async def facets(db: DB, f: LeaseFilters = Depends(filters), _: CurrentUser = Depends(require("leases", "view"))):
    q = service.build_query
    verified = await facet_counts(db, q(f, skip={"verified"}), Lease.verified)
    return LeaseFacets(
        status=await facet_counts(db, q(f, skip={"status"}), Lease.status),
        lease_type=await facet_counts(db, q(f, skip={"lease_type"}), Lease.lease_type),
        verified={k.lower(): v for k, v in verified.items()},
        expiring=await service.expiring_counts(db, f),
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("leases", "view"))):
    return {
        "statuses": LEASE_STATUSES, "types": LEASE_TYPES, "escalation_methods": ESCALATION_METHODS,
        "recovery_methods": RECOVERY_METHODS, "recovery_categories": RECOVERY_CATEGORIES, "cap_types": CAP_TYPES,
        "option_types": OPTION_TYPES, "option_statuses": OPTION_STATUSES, "pricing_methods": PRICING_METHODS,
        "clause_categories": CLAUSE_CATEGORIES, "amendment_kinds": AMENDMENT_KINDS, "guaranty_types": GUARANTY_TYPES,
        "overridable_fields": sorted(OVERRIDABLE_FIELDS),
    }


@router.get("/rent-roll", response_model=RentRoll)
async def rent_roll(db: DB, property_id: uuid.UUID | None = None, asset_id: uuid.UUID | None = None,
                    as_of: date | None = None, _: CurrentUser = Depends(require("leases", "view"))):
    return await service.rent_roll(db, property_id, asset_id, as_of)


@router.get("/rollover", response_model=Rollover)
async def rollover(db: DB, property_id: uuid.UUID | None = None, asset_id: uuid.UUID | None = None,
                   years: int = Query(10, ge=1, le=30), as_of: date | None = None,
                   _: CurrentUser = Depends(require("leases", "view"))):
    return await service.rollover(db, property_id, asset_id, years, as_of)


@router.get("/for-underwriting")
async def for_underwriting(db: DB, property_id: uuid.UUID, user: CurrentUser = Depends(require("leases", "view"))):
    return await service.for_underwriting(db, property_id)


@router.get("/space-options", response_model=list[SpaceOption])
async def space_options(db: DB, property_id: uuid.UUID, _: CurrentUser = Depends(require("leases", "view"))):
    return [SpaceOption(id=s.id, suite=s.suite, area_sf=s.area_sf, occupancy_status=s.occupancy_status,
                        tenant_name=s.tenant_name) for s in await service.space_options(db, property_id)]


@router.get("/documents/{document_id}/open")
async def open_citation(document_id: uuid.UUID, db: DB, page: int | None = Query(None, ge=1),
                        user: CurrentUser = Depends(require("leases", "view"))):
    if not user.can("documents", "view"):
        raise HTTPException(403, "Missing permission documents:view")
    return {"url": await service.document_url(db, document_id, page, user)}


# --------------------------------------------------------------------------- reconciliations

async def _recon_out(db: DB, rows: list[RecoveryReconciliation]) -> list[ReconciliationOut]:
    ids = {r.lease_id for r in rows}
    names = dict((await db.execute(select(Lease.id, Lease.tenant_name).where(Lease.id.in_(ids)))).all()) if ids else {}
    out = []
    for r in rows:
        o = ReconciliationOut.model_validate(r)
        o.tenant_name = names.get(r.lease_id)
        out.append(o)
    return out


@router.get("/reconciliations", response_model=list[ReconciliationOut])
async def list_reconciliations(
    db: DB, property_id: uuid.UUID | None = None, lease_id: uuid.UUID | None = None, year: int | None = None,
    status: list[str] | None = Query(None), _: CurrentUser = Depends(require("leases", "view")),
):
    stmt = select(RecoveryReconciliation).where(RecoveryReconciliation.deleted_at.is_(None))
    if property_id:
        stmt = stmt.where(RecoveryReconciliation.property_id == property_id)
    if lease_id:
        stmt = stmt.where(RecoveryReconciliation.lease_id == lease_id)
    if year:
        stmt = stmt.where(RecoveryReconciliation.year == year)
    if status:
        stmt = stmt.where(RecoveryReconciliation.status.in_(status))
    rows = list(await db.scalars(stmt.order_by(RecoveryReconciliation.year.desc()).limit(500)))
    return await _recon_out(db, rows)


@router.post("/reconciliations/run", response_model=ReconRunOut)
async def run_reconciliation(body: ReconRunIn, db: DB, user: CurrentUser = Depends(require("leases", "edit"))):
    items, created, updated, locked = await service.run_reconciliation(db, body, user)
    return ReconRunOut(created=created, updated=updated, skipped_locked=locked, items=await _recon_out(db, items))


@router.post("/reconciliations/{rec_id}/finalize", response_model=ReconciliationOut)
async def finalize_reconciliation(rec_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("leases", "approve"))):
    rec = await service._child(db, RecoveryReconciliation, rec_id, "Reconciliation")
    rec = await service.finalize_reconciliation(db, rec, user)
    return (await _recon_out(db, [rec]))[0]


# --------------------------------------------------------------------------- lease record

@router.post("", response_model=LeaseOut, status_code=201)
async def create_lease(body: LeaseCreate, db: DB, user: CurrentUser = Depends(require("leases", "create"))):
    return await service.to_out(db, await service.create(db, body, user))


@router.get("/{lease_id}", response_model=LeaseOut)
async def get_lease(lease_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("leases", "view"))):
    return await service.to_out(db, await service.get(db, lease_id))


@router.patch("/{lease_id}", response_model=LeaseOut)
async def update_lease(lease_id: uuid.UUID, body: LeaseUpdate, db: DB,
                       user: CurrentUser = Depends(require("leases", "edit"))):
    lease = await service.update(db, await service.get(db, lease_id), body, user)
    return await service.to_out(db, lease)


@router.delete("/{lease_id}", status_code=204)
async def archive_lease(lease_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("leases", "delete"))):
    await service.archive(db, await service.get(db, lease_id), user)


@router.post("/{lease_id}/verify", response_model=LeaseOut)
async def verify_lease(lease_id: uuid.UUID, body: VerifyIn, db: DB,
                       user: CurrentUser = Depends(require("leases", "edit"))):
    lease = await service.verify(db, await service.get(db, lease_id), body.verified, user)
    return await service.to_out(db, lease)


@router.get("/{lease_id}/history", response_model=list[ObservationOut])
async def lease_history(lease_id: uuid.UUID, db: DB, field: str | None = None,
                        _: CurrentUser = Depends(require("leases", "view"))):
    return await provenance.history(db, service.ENTITY, lease_id, field)


@router.post("/observations/{obs_id}/verify", response_model=ObservationOut)
async def verify_observation(obs_id: uuid.UUID, body: VerifyIn, db: DB,
                             user: CurrentUser = Depends(require("leases", "edit"))):
    obs = await provenance.set_verification(db, obs_id, "verified" if body.verified else "rejected", user.id)
    if not obs or obs.entity_type != service.ENTITY:
        raise HTTPException(404, "Observation not found")
    await audit.record(db, actor=user, action=f"lease.field_{obs.verification}", entity_type=service.ENTITY,
                       entity_id=obs.entity_id, summary=obs.field, ip_address=user.ip_address)
    await db.commit()
    return obs


@router.get("/{lease_id}/operative-terms", response_model=OperativeTerms)
async def operative_terms(lease_id: uuid.UUID, db: DB, as_of: date | None = None,
                          _: CurrentUser = Depends(require("leases", "view"))):
    return await service.operative_terms(db, await service.get(db, lease_id), as_of)


@router.get("/{lease_id}/schedule", response_model=list[ScheduleRow])
async def schedule(lease_id: uuid.UUID, db: DB, verified_only: bool = False,
                   _: CurrentUser = Depends(require("leases", "view"))):
    await service.get(db, lease_id)
    return await service.rent_schedule(db, lease_id, verified_only=verified_only)


@router.post("/{lease_id}/critical-dates/generate", response_model=CriticalDatesOut)
async def generate_critical_dates(lease_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("leases", "edit"))):
    lease = await service.get(db, lease_id)
    generated, skipped, available = await service.generate_critical_dates(db, lease, user)
    if not available:
        return CriticalDatesOut(generated=0, skipped_unverified=0, available=False)
    if not lease.verified:
        raise HTTPException(409, "Verify the lease abstract before generating critical dates")
    await audit.record(db, actor=user, action="lease.critical_dates_generated", entity_type=service.ENTITY,
                       entity_id=lease.id, summary=f"{generated} dates, {skipped} unverified terms skipped",
                       ip_address=user.ip_address)
    await db.commit()
    return CriticalDatesOut(generated=generated, skipped_unverified=skipped, available=True)


@router.post("/{lease_id}/import-extractions")
async def import_extractions(lease_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("leases", "edit"))):
    return await service.import_extractions(db, await service.get(db, lease_id), user)


# --------------------------------------------------------------------------- rent steps

@router.get("/{lease_id}/rent-steps", response_model=list[RentStepOut])
async def list_steps(lease_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("leases", "view"))):
    await service.get(db, lease_id)
    return await service.all_steps(db, lease_id)


@router.post("/{lease_id}/rent-steps", response_model=RentStepOut, status_code=201)
async def add_step(lease_id: uuid.UUID, body: RentStepIn, db: DB, user: CurrentUser = Depends(require("leases", "edit"))):
    return await service.add_step(db, await service.get(db, lease_id), body, user)


@router.post("/{lease_id}/rent-steps/generate", response_model=list[RentStepOut])
async def generate_steps(lease_id: uuid.UUID, body: EscalationIn, db: DB,
                         user: CurrentUser = Depends(require("leases", "edit"))):
    await service.generate_steps(db, await service.get(db, lease_id), body, user)
    return await service.all_steps(db, lease_id)


@router.delete("/{lease_id}/rent-steps/{step_id}", status_code=204)
async def remove_step(lease_id: uuid.UUID, step_id: uuid.UUID, db: DB,
                      user: CurrentUser = Depends(require("leases", "edit"))):
    lease = await service.get(db, lease_id)
    step = await service._child(db, RentStep, step_id, "Rent step")
    if step.lease_id != lease.id:
        raise HTTPException(404, "Rent step not found")
    await service.remove_child(db, step, lease, user)


# --------------------------------------------------------------------------- recoveries / options / clauses / guaranties

def _child_routes(path: str, model, schema_in, schema_out, label: str, *, with_list: bool = True) -> None:
    async def load(db, lease_id: uuid.UUID, child_id: uuid.UUID):
        lease = await service.get(db, lease_id)
        row = await service._child(db, model, child_id, label)
        if row.lease_id != lease.id:
            raise HTTPException(404, f"{label} not found")
        return lease, row

    if with_list:
        @router.get(f"/{{lease_id}}/{path}", response_model=list[schema_out], name=f"list_{path}")
        async def list_rows(lease_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("leases", "view"))):
            await service.get(db, lease_id)
            return await service.list_children(db, model, lease_id)

    @router.post(f"/{{lease_id}}/{path}", response_model=schema_out, status_code=201, name=f"add_{path}")
    async def add_row(lease_id: uuid.UUID, body: schema_in, db: DB,
                      user: CurrentUser = Depends(require("leases", "edit"))):
        return await service.add_child(db, model, await service.get(db, lease_id), body, user)

    @router.patch(f"/{{lease_id}}/{path}/{{child_id}}", response_model=schema_out, name=f"update_{path}")
    async def update_row(lease_id: uuid.UUID, child_id: uuid.UUID, body: schema_in, db: DB,
                         user: CurrentUser = Depends(require("leases", "edit"))):
        lease, row = await load(db, lease_id, child_id)
        return await service.update_child(db, row, lease, body, user)

    @router.post(f"/{{lease_id}}/{path}/{{child_id}}/verify", response_model=schema_out, name=f"verify_{path}")
    async def verify_row(lease_id: uuid.UUID, child_id: uuid.UUID, body: VerifyIn, db: DB,
                         user: CurrentUser = Depends(require("leases", "edit"))):
        lease, row = await load(db, lease_id, child_id)
        return await service.verify_child(db, row, lease, body.verified, user)

    @router.delete(f"/{{lease_id}}/{path}/{{child_id}}", status_code=204, name=f"remove_{path}")
    async def remove_row(lease_id: uuid.UUID, child_id: uuid.UUID, db: DB,
                         user: CurrentUser = Depends(require("leases", "edit"))):
        lease, row = await load(db, lease_id, child_id)
        await service.remove_child(db, row, lease, user)


@router.get("/{lease_id}/options", response_model=list[OptionOut])
async def list_options(lease_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("leases", "view"))):
    lease = await service.get(db, lease_id)
    vals, steps = await service._operative(db, lease)
    out = []
    for o in await service.list_children(db, LeaseOption, lease_id):
        item = OptionOut.model_validate(o)
        item.economics = await service.option_economics(db, lease, o, vals, steps)
        out.append(item)
    return out


_child_routes("recoveries", LeaseRecovery, RecoveryIn, RecoveryOut, "Recovery")
_child_routes("options", LeaseOption, OptionIn, OptionOut, "Option", with_list=False)
_child_routes("clauses", LeaseClause, ClauseIn, ClauseOut, "Clause")
_child_routes("guaranties", Guaranty, GuarantyIn, GuarantyOut, "Guaranty")


# --------------------------------------------------------------------------- amendment chain

@router.get("/{lease_id}/amendments", response_model=list[AmendmentOut])
async def list_amendments(lease_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("leases", "view"))):
    await service.get(db, lease_id)
    return await service.amendments(db, lease_id)


@router.post("/{lease_id}/amendments", response_model=AmendmentOut, status_code=201)
async def add_amendment(lease_id: uuid.UUID, body: AmendmentIn, db: DB,
                        user: CurrentUser = Depends(require("leases", "edit"))):
    return await service.add_amendment(db, await service.get(db, lease_id), body, user)


@router.post("/{lease_id}/amendments/{amendment_id}/verify", response_model=AmendmentOut)
async def verify_amendment(lease_id: uuid.UUID, amendment_id: uuid.UUID, body: VerifyIn, db: DB,
                           user: CurrentUser = Depends(require("leases", "edit"))):
    lease = await service.get(db, lease_id)
    a = await service._child(db, LeaseAmendment, amendment_id, "Amendment")
    if a.lease_id != lease.id:
        raise HTTPException(404, "Amendment not found")
    return await service.verify_amendment(db, a, lease, body.verified, user)
