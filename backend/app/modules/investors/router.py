import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common import provenance
from app.common.provenance import ObservationOut
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.investors import service
from app.modules.investors.models import (
    CALL_ITEM_STATUSES,
    COMM_CHANNELS,
    COMPONENTS,
    DAY_COUNTS,
    ENTRY_TYPES,
    EVENT_STATUSES,
    EVENT_TYPES,
    HURDLE_TYPES,
    PACKAGE_TYPES,
    PARTNER_STATUSES,
    PARTNER_TYPES,
    REPORT_FREQUENCIES,
    TIER_TYPES,
    CapitalAccountEntry,
    CapitalEvent,
    CapitalEventAllocation,
    CapitalEventVersion,
    CapitalPartner,
    ReportPackage,
    ReportSchedule,
    Waterfall,
)
from app.modules.investors.schemas import (
    AllocationOut,
    AssetOption,
    DecisionIn,
    DefaultIn,
    EntryOut,
    EventCreate,
    EventFacets,
    EventListItem,
    EventOut,
    EventPreviewIn,
    EventUpdate,
    EventVersionOut,
    FundIn,
    IncomeAllocationIn,
    InvestmentCreate,
    InvestmentOut,
    InvestmentUpdate,
    PackageCreate,
    PackageListItem,
    PackageOut,
    PartnerCreate,
    PartnerFacets,
    PartnerListItem,
    PartnerOut,
    PartnerUpdate,
    PortalOut,
    PreviewOut,
    ReverseIn,
    ScheduleIn,
    ScheduleOut,
    ScheduleUpdate,
    StatementOut,
    WaterfallIn,
    WaterfallOut,
)
from app.modules.investors.service import EventFilters, PartnerFilters

router = APIRouter(tags=["investors"])

VIEW = require("investors", "view")
CREATE = require("investors", "create")
EDIT = require("investors", "edit")
APPROVE = require("investors", "approve")


def staff(dep):
    """Permission check plus portal exclusion: capital-partner users never reach internal endpoints."""
    async def checker(user: CurrentUser = Depends(dep)) -> CurrentUser:
        service.deny_portal(user)
        return user

    return checker


@router.get("/investors/meta")
async def meta(_: CurrentUser = Depends(VIEW)):
    return {
        "partner_types": PARTNER_TYPES, "partner_statuses": PARTNER_STATUSES, "day_counts": DAY_COUNTS,
        "tier_types": TIER_TYPES, "hurdle_types": HURDLE_TYPES, "event_types": EVENT_TYPES,
        "event_statuses": EVENT_STATUSES, "entry_types": ENTRY_TYPES, "components": COMPONENTS,
        "call_item_statuses": CALL_ITEM_STATUSES, "package_types": PACKAGE_TYPES,
        "report_frequencies": REPORT_FREQUENCIES, "channels": COMM_CHANNELS,
    }


# --------------------------------------------------------------------------- portal

@router.get("/investors/portal/me", response_model=PortalOut)
async def portal_me(db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.portal(db, user)


# --------------------------------------------------------------------------- partners

PARTNER_SORTS = {"name": CapitalPartner.name, "type": CapitalPartner.type, "status": CapitalPartner.status,
                 "updated_at": CapitalPartner.updated_at, "created_at": CapitalPartner.created_at}


def partner_filters(
    q: str | None = Query(None, max_length=200),
    type: list[str] | None = Query(None),
    status: list[str] | None = Query(None),
    owner_id: list[uuid.UUID] | None = Query(None),
    asset_id: uuid.UUID | None = None,
    in_default: bool | None = None,
) -> PartnerFilters:
    return PartnerFilters(q=q, type=type, status=status, owner_id=owner_id, asset_id=asset_id, in_default=in_default)


@router.get("/investors/partners", response_model=Page[PartnerListItem])
async def list_partners(db: DB, params: ListParams = Depends(), f: PartnerFilters = Depends(partner_filters),
                        user: CurrentUser = Depends(VIEW)):
    ids = await service.scope_ids(db, user)
    stmt = apply_sort(service.build_partner_query(f, ids), params.sort, PARTNER_SORTS, CapitalPartner.name.asc())
    rows, total = await paginate(db, stmt, params)
    return Page[PartnerListItem](items=await service.partner_items(db, rows), total=total, page=params.page,
                                 page_size=params.page_size)


@router.get("/investors/partners/facets", response_model=PartnerFacets)
async def partner_facets(db: DB, f: PartnerFilters = Depends(partner_filters), user: CurrentUser = Depends(VIEW)):
    ids = await service.scope_ids(db, user)
    q = service.build_partner_query
    return PartnerFacets(
        type=await facet_counts(db, q(f, ids, skip={"type"}), CapitalPartner.type),
        status=await facet_counts(db, q(f, ids, skip={"status"}), CapitalPartner.status),
    )


@router.post("/investors/partners", response_model=PartnerOut, status_code=201)
async def create_partner(body: PartnerCreate, db: DB, user: CurrentUser = Depends(staff(CREATE))):
    return await service.partner_out(db, await service.create_partner(db, body, user))


@router.get("/investors/partners/{partner_id}", response_model=PartnerOut)
async def get_partner(partner_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    out = await service.partner_out(db, await service.get_partner(db, partner_id, user))
    if service.is_portal(user):
        out.notes = None  # internal relationship notes are not shown in the portal
    return out


@router.patch("/investors/partners/{partner_id}", response_model=PartnerOut)
async def update_partner(partner_id: uuid.UUID, body: PartnerUpdate, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    p = await service.update_partner(db, await service.get_partner(db, partner_id, user), body, user)
    return await service.partner_out(db, p)


@router.delete("/investors/partners/{partner_id}", status_code=204)
async def archive_partner(partner_id: uuid.UUID, db: DB,
                          user: CurrentUser = Depends(staff(require("investors", "delete")))):
    await service.archive_partner(db, await service.get_partner(db, partner_id, user), user)


@router.get("/investors/partners/{partner_id}/statement", response_model=StatementOut)
async def partner_statement(partner_id: uuid.UUID, db: DB, as_of: date | None = None, user: CurrentUser = Depends(VIEW)):
    return await service.statement(db, await service.get_partner(db, partner_id, user), as_of or date.today())


# --------------------------------------------------------------------------- investments

@router.get("/investors/investments", response_model=list[InvestmentOut])
async def list_investments(db: DB, partner_id: uuid.UUID | None = None, asset_id: uuid.UUID | None = None,
                           user: CurrentUser = Depends(VIEW)):
    return await service.investment_outs(db, await service.list_investments(db, user, partner_id, asset_id))


@router.post("/investors/investments", response_model=InvestmentOut, status_code=201)
async def create_investment(body: InvestmentCreate, db: DB, user: CurrentUser = Depends(staff(CREATE))):
    return (await service.investment_outs(db, [await service.create_investment(db, body, user)]))[0]


@router.get("/investors/investments/{investment_id}", response_model=InvestmentOut)
async def get_investment(investment_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    return (await service.investment_outs(db, [await service.get_investment(db, investment_id, user)]))[0]


@router.patch("/investors/investments/{investment_id}", response_model=InvestmentOut)
async def update_investment(investment_id: uuid.UUID, body: InvestmentUpdate, db: DB,
                            user: CurrentUser = Depends(staff(EDIT))):
    inv = await service.update_investment(db, await service.get_investment(db, investment_id, user), body, user)
    return (await service.investment_outs(db, [inv]))[0]


@router.get("/investors/investments/{investment_id}/history", response_model=list[ObservationOut])
async def investment_history(investment_id: uuid.UUID, db: DB, user: CurrentUser = Depends(staff(VIEW))):
    await service.get_investment(db, investment_id, user)
    return await provenance.history(db, "investment", investment_id)


@router.get("/investors/asset-options", response_model=list[AssetOption])
async def asset_options(db: DB, q: str | None = Query(None, max_length=200), _: CurrentUser = Depends(staff(VIEW))):
    return await service.asset_options(db, q)


@router.post("/investors/assets/{asset_id}/allocate-income")
async def allocate_income(asset_id: uuid.UUID, body: IncomeAllocationIn, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    return {"entries": await service.allocate_income(db, asset_id, body, user)}


# --------------------------------------------------------------------------- ledger

@router.get("/investors/entries", response_model=list[EntryOut])
async def list_entries(db: DB, partner_id: uuid.UUID | None = None, investment_id: uuid.UUID | None = None,
                       event_id: uuid.UUID | None = None, user: CurrentUser = Depends(VIEW)):
    stmt = service.scoped(select(CapitalAccountEntry), CapitalAccountEntry.partner_id, await service.scope_ids(db, user))
    if partner_id:
        stmt = stmt.where(CapitalAccountEntry.partner_id == partner_id)
    if investment_id:
        stmt = stmt.where(CapitalAccountEntry.investment_id == investment_id)
    if event_id:
        stmt = stmt.where(CapitalAccountEntry.event_id == event_id)
    rows = list(await db.scalars(stmt.order_by(CapitalAccountEntry.effective_on.desc(),
                                               CapitalAccountEntry.created_at.desc()).limit(2000)))
    return await service.entry_outs(db, rows)


@router.post("/investors/entries/{entry_id}/reverse", response_model=EntryOut)
async def reverse_entry(entry_id: uuid.UUID, body: ReverseIn, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    return (await service.entry_outs(db, [await service.reverse_entry(db, entry_id, body.reason, user)]))[0]


# --------------------------------------------------------------------------- waterfalls

@router.get("/investors/waterfalls", response_model=list[WaterfallOut])
async def list_waterfalls(db: DB, asset_id: uuid.UUID | None = None, _: CurrentUser = Depends(staff(VIEW))):
    stmt = select(Waterfall).where(Waterfall.deleted_at.is_(None))
    if asset_id:
        stmt = stmt.where((Waterfall.asset_id == asset_id) | Waterfall.asset_id.is_(None))
    return [await service.waterfall_out(db, w) for w in await db.scalars(stmt.order_by(Waterfall.name))]


@router.post("/investors/waterfalls", response_model=WaterfallOut, status_code=201)
async def create_waterfall(body: WaterfallIn, db: DB, user: CurrentUser = Depends(staff(require("investors", "approve")))):
    return await service.waterfall_out(db, await service.save_waterfall(db, None, body, user))


@router.get("/investors/waterfalls/{waterfall_id}", response_model=WaterfallOut)
async def get_waterfall(waterfall_id: uuid.UUID, db: DB, _: CurrentUser = Depends(staff(VIEW))):
    return await service.waterfall_out(db, await service.get_waterfall(db, waterfall_id))


@router.put("/investors/waterfalls/{waterfall_id}", response_model=WaterfallOut)
async def update_waterfall(waterfall_id: uuid.UUID, body: WaterfallIn, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    w = await service.save_waterfall(db, await service.get_waterfall(db, waterfall_id), body, user)
    return await service.waterfall_out(db, w)


# --------------------------------------------------------------------------- capital events

EVENT_SORTS = {"event_date": CapitalEvent.event_date, "amount": CapitalEvent.amount, "status": CapitalEvent.status,
               "event_type": CapitalEvent.event_type, "name": CapitalEvent.name, "updated_at": CapitalEvent.updated_at}


def event_filters(
    q: str | None = Query(None, max_length=200),
    event_type: list[str] | None = Query(None),
    status: list[str] | None = Query(None),
    asset_id: uuid.UUID | None = None,
) -> EventFilters:
    return EventFilters(q=q, event_type=event_type, status=status, asset_id=asset_id)


@router.get("/investors/capital-events", response_model=Page[EventListItem])
async def list_events(db: DB, params: ListParams = Depends(), f: EventFilters = Depends(event_filters),
                      _: CurrentUser = Depends(staff(VIEW))):
    stmt = apply_sort(service.build_event_query(f), params.sort, EVENT_SORTS, CapitalEvent.event_date.desc())
    rows, total = await paginate(db, stmt, params)
    labels = await service.asset_labels(db, [(e.asset_id, e.property_id) for e in rows])
    items = []
    for e in rows:
        item = EventListItem.model_validate(e)
        item.asset_label = labels.get(e.asset_id)
        items.append(item)
    return Page[EventListItem](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/investors/capital-events/facets", response_model=EventFacets)
async def event_facets(db: DB, f: EventFilters = Depends(event_filters), _: CurrentUser = Depends(staff(VIEW))):
    return EventFacets(
        event_type=await facet_counts(db, service.build_event_query(f, skip={"event_type"}), CapitalEvent.event_type),
        status=await facet_counts(db, service.build_event_query(f, skip={"status"}), CapitalEvent.status),
    )


@router.post("/investors/capital-events/preview", response_model=PreviewOut)
async def preview_event(body: EventPreviewIn, db: DB, _: CurrentUser = Depends(staff(CREATE))):
    amount, calc, _w = await service.compute(db, body)
    return PreviewOut(event_type=body.event_type, amount=amount, calc=calc)


@router.post("/investors/capital-events", response_model=EventOut, status_code=201)
async def create_event(body: EventCreate, db: DB, user: CurrentUser = Depends(staff(CREATE))):
    return await service.event_out(db, await service.create_event(db, body, user), user)


@router.get("/investors/capital-events/{event_id}", response_model=EventOut)
async def get_event(event_id: uuid.UUID, db: DB, user: CurrentUser = Depends(staff(VIEW))):
    return await service.event_out(db, await service.get_event(db, event_id), user)


@router.patch("/investors/capital-events/{event_id}", response_model=EventOut)
async def update_event(event_id: uuid.UUID, body: EventUpdate, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    e = await service.recalculate(db, await service.get_event(db, event_id), body, user)
    return await service.event_out(db, e, user)


@router.post("/investors/capital-events/{event_id}/recalculate", response_model=EventOut)
async def recalculate_event(event_id: uuid.UUID, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    e = await service.recalculate(db, await service.get_event(db, event_id), None, user)
    return await service.event_out(db, e, user)


@router.get("/investors/capital-events/{event_id}/versions", response_model=list[EventVersionOut])
async def event_versions(event_id: uuid.UUID, db: DB, _: CurrentUser = Depends(staff(VIEW))):
    await service.get_event(db, event_id)
    return list(await db.scalars(select(CapitalEventVersion).where(CapitalEventVersion.event_id == event_id)
                                 .order_by(CapitalEventVersion.version.desc())))


@router.post("/investors/capital-events/{event_id}/submit", response_model=EventOut)
async def submit_event(event_id: uuid.UUID, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    return await service.event_out(db, await service.submit_event(db, await service.get_event(db, event_id), user), user)


@router.post("/investors/capital-events/{event_id}/approve", response_model=EventOut)
async def approve_event(event_id: uuid.UUID, body: DecisionIn, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    e = await service.decide_event(db, await service.get_event(db, event_id), True, body.note, user)
    return await service.event_out(db, e, user)


@router.post("/investors/capital-events/{event_id}/reject", response_model=EventOut)
async def reject_event(event_id: uuid.UUID, body: DecisionIn, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    e = await service.decide_event(db, await service.get_event(db, event_id), False, body.note, user)
    return await service.event_out(db, e, user)


@router.post("/investors/capital-events/{event_id}/post", response_model=EventOut)
async def post_event(event_id: uuid.UUID, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    return await service.event_out(db, await service.post_event(db, await service.get_event(db, event_id), user), user)


@router.post("/investors/capital-events/{event_id}/reverse", response_model=EventOut)
async def reverse_event(event_id: uuid.UUID, body: ReverseIn, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    e = await service.reverse_event(db, await service.get_event(db, event_id), body.reason, user)
    return await service.event_out(db, e, user)


@router.delete("/investors/capital-events/{event_id}", status_code=204)
async def delete_event(event_id: uuid.UUID, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    from app.common import audit
    from app.core.security import utcnow

    e = await service.get_event(db, event_id)
    if e.status not in ("draft", "rejected"):
        raise HTTPException(409, "Only draft or rejected events can be discarded; posted events are reversed")
    e.deleted_at, e.updated_by_id = utcnow(), user.id
    await audit.record(db, actor=user, action="capital_event.discarded", entity_type="capital_event", entity_id=e.id,
                       summary=e.name, ip_address=user.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- allocations: calls & distributions

@router.get("/investors/allocations", response_model=list[AllocationOut])
async def list_allocations(
    db: DB,
    event_id: uuid.UUID | None = None,
    partner_id: uuid.UUID | None = None,
    event_type: list[str] | None = Query(None),
    status: list[str] | None = Query(None),
    user: CurrentUser = Depends(VIEW),
):
    stmt = select(CapitalEventAllocation).where(CapitalEventAllocation.deleted_at.is_(None))
    stmt = service.scoped(stmt, CapitalEventAllocation.partner_id, await service.scope_ids(db, user))
    if event_id:
        stmt = stmt.where(CapitalEventAllocation.event_id == event_id)
    if partner_id:
        stmt = stmt.where(CapitalEventAllocation.partner_id == partner_id)
    if event_type:
        stmt = stmt.where(CapitalEventAllocation.event_type.in_(event_type))
    if status:
        stmt = stmt.where(CapitalEventAllocation.status.in_(status))
    rows = list(await db.scalars(stmt.order_by(CapitalEventAllocation.created_at.desc()).limit(1000)))
    return await service.allocation_outs(db, rows)


@router.post("/investors/allocations/run-defaults")
async def run_defaults(db: DB, as_of: date | None = None, _: CurrentUser = Depends(staff(EDIT))):
    return await service.run_defaults(db, as_of or date.today())


@router.get("/investors/allocations/{alloc_id}", response_model=AllocationOut)
async def get_allocation(alloc_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    return (await service.allocation_outs(db, [await service.get_allocation(db, alloc_id, user)]))[0]


@router.post("/investors/allocations/{alloc_id}/fund", response_model=AllocationOut)
async def fund_allocation(alloc_id: uuid.UUID, body: FundIn, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    a = await service.fund_call(db, await service.get_allocation(db, alloc_id, user), body, user)
    return (await service.allocation_outs(db, [a]))[0]


@router.post("/investors/allocations/{alloc_id}/default", response_model=AllocationOut)
async def default_allocation(alloc_id: uuid.UUID, body: DefaultIn, db: DB, user: CurrentUser = Depends(staff(APPROVE))):
    a = await service.mark_default(db, await service.get_allocation(db, alloc_id, user), body.default_flag,
                                   body.penalty_flag, body.note, user)
    return (await service.allocation_outs(db, [a]))[0]


# --------------------------------------------------------------------------- reporting packages

@router.get("/investors/report-packages", response_model=Page[PackageListItem])
async def list_packages(
    db: DB, params: ListParams = Depends(), partner_id: uuid.UUID | None = None,
    status: list[str] | None = Query(None), user: CurrentUser = Depends(VIEW),
):
    ids = await service.scope_ids(db, user)
    stmt = select(ReportPackage).where(ReportPackage.deleted_at.is_(None))
    stmt = service.scoped(stmt, ReportPackage.partner_id, ids)
    if ids is not None:
        stmt = stmt.where(ReportPackage.status == "issued")
    if partner_id:
        stmt = stmt.where(ReportPackage.partner_id == partner_id)
    if status:
        stmt = stmt.where(ReportPackage.status.in_(status))
    if params.q:
        stmt = stmt.where(ReportPackage.title.ilike(f"%{params.q}%"))
    stmt = apply_sort(stmt, params.sort, {"period_end": ReportPackage.period_end, "generated_at": ReportPackage.generated_at,
                                          "title": ReportPackage.title}, ReportPackage.generated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[PackageListItem](items=await service.package_items(db, rows), total=total, page=params.page,
                                 page_size=params.page_size)


@router.post("/investors/report-packages", response_model=list[PackageListItem], status_code=201)
async def generate_packages(body: PackageCreate, db: DB, user: CurrentUser = Depends(staff(CREATE))):
    return await service.package_items(db, await service.generate_packages(db, body, user))


@router.get("/investors/report-packages/{package_id}", response_model=PackageOut)
async def get_package(package_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    pkg = await db.get(ReportPackage, package_id)
    ids = await service.scope_ids(db, user)
    if not pkg or pkg.deleted_at or (ids is not None and (pkg.partner_id not in ids or pkg.status != "issued")):
        raise HTTPException(404, "Report package not found")
    item = (await service.package_items(db, [pkg]))[0]
    return PackageOut(**item.model_dump(), snapshot=pkg.snapshot or {}, excluded=pkg.excluded or [])


@router.post("/investors/report-packages/{package_id}/issue", response_model=PackageListItem)
async def issue_package(package_id: uuid.UUID, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    pkg = await db.get(ReportPackage, package_id)
    if not pkg or pkg.deleted_at:
        raise HTTPException(404, "Report package not found")
    return (await service.package_items(db, [await service.issue_package(db, pkg, user)]))[0]


@router.get("/investors/report-schedules", response_model=list[ScheduleOut])
async def list_schedules(db: DB, _: CurrentUser = Depends(staff(VIEW))):
    rows = list(await db.scalars(select(ReportSchedule).where(ReportSchedule.deleted_at.is_(None))
                                 .order_by(ReportSchedule.next_run_on)))
    names = dict((await db.execute(select(CapitalPartner.id, CapitalPartner.name).where(
        CapitalPartner.id.in_({r.partner_id for r in rows if r.partner_id})))).all()) if rows else {}
    out = []
    for r in rows:
        o = ScheduleOut.model_validate(r)
        o.partner_name = names.get(r.partner_id) if r.partner_id else None
        out.append(o)
    return out


@router.post("/investors/report-schedules", response_model=ScheduleOut, status_code=201)
async def create_schedule(body: ScheduleIn, db: DB, user: CurrentUser = Depends(staff(CREATE))):
    return await service.save_schedule(db, None, body, user)


@router.post("/investors/report-schedules/run-due")
async def run_due(db: DB, as_of: date | None = None, user: CurrentUser = Depends(staff(EDIT))):
    return await service.run_due_schedules(db, as_of or date.today(), user)


@router.patch("/investors/report-schedules/{schedule_id}", response_model=ScheduleOut)
async def update_schedule(schedule_id: uuid.UUID, body: ScheduleUpdate, db: DB, user: CurrentUser = Depends(staff(EDIT))):
    s = await db.get(ReportSchedule, schedule_id)
    if not s or s.deleted_at:
        raise HTTPException(404, "Schedule not found")
    return await service.save_schedule(db, s, body, user)
