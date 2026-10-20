import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.contracts import service
from app.modules.contracts.models import (
    CONTRACT_STATUSES,
    CONTRACT_TYPES,
    CRITICAL_DATE_SOURCES,
    CRITICAL_DATE_STATUSES,
    DATE_TYPES,
    DD_STATUSES,
    DECISION_KINDS,
    ESTOPPEL_KINDS,
    ESTOPPEL_STATUSES,
    EXCEPTION_KINDS,
    EXCEPTION_SOURCES,
    EXCEPTION_STATUSES,
    PARTY_ROLES,
    REPORT_STATUSES,
    REPORT_TYPES,
    RISK_CATEGORIES,
    RISK_DECISIONS,
    RISK_STATUSES,
    SEVERITIES,
    Contract,
    ContractDecision,
    CriticalDate,
    DDItem,
    DDTemplate,
    Estoppel,
    HolidayCalendar,
    RiskItem,
    ThirdPartyReport,
    TitleException,
)
from app.modules.contracts.schemas import (
    ActivityOut,
    ApplyTemplateIn,
    BulkDatesIn,
    BusinessDaysOut,
    ConfirmIn,
    ContractCreate,
    ContractFacets,
    ContractListItem,
    ContractOut,
    ContractStatusOut,
    ContractUpdate,
    CriticalDateCreate,
    CriticalDateEventOut,
    CriticalDateFacets,
    CriticalDateOut,
    CriticalDateSummary,
    CriticalDateUpdate,
    DDItemCreate,
    DDItemOut,
    DDItemUpdate,
    DDTemplateCreate,
    DDTemplateOut,
    DDTemplateUpdate,
    DecisionCreate,
    DecisionOut,
    EscalateIn,
    EstoppelCreate,
    EstoppelOut,
    EstoppelUpdate,
    ExecuteIn,
    HolidayCalendarCreate,
    HolidayCalendarOut,
    HolidayIn,
    HolidayOut,
    NoteIn,
    ProposeOut,
    ReportCreate,
    ReportOut,
    ReportUpdate,
    RequiredNoteIn,
    RescheduleIn,
    RiskCreate,
    RiskDecideIn,
    RiskOut,
    RiskUpdate,
    TitleExceptionCreate,
    TitleExceptionOut,
    TitleExceptionUpdate,
)
from app.modules.contracts.service import ContractFilters, DateFilters

router = APIRouter(tags=["contracts"])

VIEW = require("contracts", "view")
CREATE = require("contracts", "create")
EDIT = require("contracts", "edit")
APPROVE = require("contracts", "approve")
DELETE = require("contracts", "delete")


# =========================================================================== contracts

CONTRACT_SORTS = {
    "title": Contract.title, "status": Contract.status, "effective_on": Contract.effective_on,
    "purchase_price": Contract.purchase_price, "updated_at": Contract.updated_at, "created_at": Contract.created_at,
}


def contract_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    contract_type: list[str] | None = Query(None),
    owner_id: list[uuid.UUID] | None = Query(None),
    property_id: uuid.UUID | None = None,
    opportunity_id: uuid.UUID | None = None,
    effective_from: date | None = None,
    effective_to: date | None = None,
) -> ContractFilters:
    return ContractFilters(**locals())


@router.get("/contracts", response_model=Page[ContractListItem])
async def list_contracts(db: DB, params: ListParams = Depends(), f: ContractFilters = Depends(contract_filters),
                         _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.build_contract_query(f), params.sort, CONTRACT_SORTS, Contract.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[ContractListItem](items=await service.contract_items(db, rows), total=total, page=params.page,
                                  page_size=params.page_size)


@router.get("/contracts/facets", response_model=ContractFacets)
async def contract_facets(db: DB, f: ContractFilters = Depends(contract_filters), _: CurrentUser = Depends(VIEW)):
    q = service.build_contract_query
    return ContractFacets(
        status=await facet_counts(db, q(f, skip={"status"}), Contract.status),
        contract_type=await facet_counts(db, q(f, skip={"contract_type"}), Contract.contract_type),
        owner_id=await facet_counts(db, q(f, skip={"owner_id"}), Contract.owner_id),
    )


@router.get("/contracts/meta")
async def contract_meta(_: CurrentUser = Depends(VIEW)):
    return {
        "statuses": CONTRACT_STATUSES, "types": CONTRACT_TYPES, "party_roles": PARTY_ROLES,
        "term_keys": service.TERM_KEYS, "term_defaults": service.TERM_DEFAULTS, "rule_anchors": service.RULE_ANCHORS,
        "date_types": DATE_TYPES, "date_statuses": CRITICAL_DATE_STATUSES, "date_sources": CRITICAL_DATE_SOURCES,
        "dd_statuses": DD_STATUSES, "severities": SEVERITIES, "report_types": REPORT_TYPES,
        "report_statuses": REPORT_STATUSES, "exception_kinds": EXCEPTION_KINDS, "exception_sources": EXCEPTION_SOURCES,
        "exception_statuses": EXCEPTION_STATUSES, "estoppel_kinds": ESTOPPEL_KINDS, "estoppel_statuses": ESTOPPEL_STATUSES,
        "risk_categories": RISK_CATEGORIES, "risk_statuses": RISK_STATUSES, "risk_decisions": RISK_DECISIONS,
        "decision_kinds": DECISION_KINDS,
    }


@router.post("/contracts", response_model=ContractOut, status_code=201)
async def create_contract(body: ContractCreate, db: DB, user: CurrentUser = Depends(CREATE)):
    return await service.contract_out(db, await service.create_contract(db, body, user))


@router.get("/contracts/{contract_id}", response_model=ContractOut)
async def get_contract(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.contract_out(db, await service.get_contract(db, contract_id))


@router.patch("/contracts/{contract_id}", response_model=ContractOut)
async def update_contract(contract_id: uuid.UUID, body: ContractUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.update_contract(db, await service.get_contract(db, contract_id), body, user)
    return await service.contract_out(db, c)


@router.delete("/contracts/{contract_id}", status_code=204)
async def delete_contract(contract_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_contract(db, await service.get_contract(db, contract_id), user)


@router.post("/contracts/{contract_id}/execute", response_model=ContractOut)
async def execute_contract(contract_id: uuid.UUID, body: ExecuteIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.execute_contract(db, await service.get_contract(db, contract_id), body, user)
    return await service.contract_out(db, c)


@router.get("/contracts/{contract_id}/status", response_model=ContractStatusOut)
async def contract_status(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.contract_status(db, await service.get_contract(db, contract_id))


@router.get("/contracts/{contract_id}/rules")
async def contract_rules(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return service.contract_rules(await service.get_contract(db, contract_id))


@router.get("/contracts/{contract_id}/critical-dates", response_model=list[CriticalDateOut])
async def contract_dates(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    await service.get_contract(db, contract_id)
    return await service.date_outs(db, await service._contract_dates(db, contract_id))


@router.post("/contracts/{contract_id}/generate-dates", response_model=list[CriticalDateOut])
async def generate_dates(contract_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    rows = await service.regenerate_dates(db, await service.get_contract(db, contract_id), user)
    return await service.date_outs(db, rows)


@router.post("/contracts/{contract_id}/propose-from-extracted", response_model=ProposeOut)
async def propose_from_extracted(contract_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.propose_from_extracted(db, await service.get_contract(db, contract_id), user)


@router.get("/contracts/{contract_id}/activity", response_model=list[ActivityOut])
async def contract_activity(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW),
                            limit: int = Query(200, ge=1, le=500)):
    return await service.contract_activity(db, await service.get_contract(db, contract_id), limit)


# --------------------------------------------------------------------------- DD items

@router.post("/contracts/{contract_id}/apply-template", response_model=list[DDItemOut])
async def apply_template(contract_id: uuid.UUID, body: ApplyTemplateIn, db: DB, user: CurrentUser = Depends(EDIT)):
    items = await service.apply_template_commit(db, await service.get_contract(db, contract_id), body.template_id, user)
    return await service.dd_outs(db, items)


@router.get("/contracts/{contract_id}/dd-items", response_model=list[DDItemOut])
async def list_dd_items(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    rows = list(await db.scalars(select(DDItem).where(DDItem.contract_id == contract_id, DDItem.deleted_at.is_(None))
                                 .order_by(DDItem.category, DDItem.sort_order, DDItem.created_at)))
    return await service.dd_outs(db, rows)


@router.post("/contracts/{contract_id}/dd-items", response_model=DDItemOut, status_code=201)
async def create_dd_item(contract_id: uuid.UUID, body: DDItemCreate, db: DB, user: CurrentUser = Depends(EDIT)):
    i = await service.create_dd_item(db, await service.get_contract(db, contract_id), body, user)
    return (await service.dd_outs(db, [i]))[0]


@router.patch("/dd-items/{item_id}", response_model=DDItemOut)
async def update_dd_item(item_id: uuid.UUID, body: DDItemUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    i = await service.update_dd_item(db, await service.get_dd_item(db, item_id), body, user)
    return (await service.dd_outs(db, [i]))[0]


@router.post("/dd-items/{item_id}/escalate", response_model=DDItemOut)
async def escalate_dd_item(item_id: uuid.UUID, body: EscalateIn, db: DB, user: CurrentUser = Depends(EDIT)):
    i = await service.escalate_dd_item(db, await service.get_dd_item(db, item_id), body.note, user)
    return (await service.dd_outs(db, [i]))[0]


@router.delete("/dd-items/{item_id}", status_code=204)
async def delete_dd_item(item_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    await service.delete_dd_item(db, await service.get_dd_item(db, item_id), user)


# --------------------------------------------------------------------------- third-party reports

@router.get("/contracts/{contract_id}/reports", response_model=list[ReportOut])
async def list_reports(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    rows = list(await db.scalars(select(ThirdPartyReport).where(
        ThirdPartyReport.contract_id == contract_id, ThirdPartyReport.deleted_at.is_(None)
    ).order_by(ThirdPartyReport.expected_on.asc().nulls_last(), ThirdPartyReport.created_at)))
    return await service.report_outs(db, rows)


@router.post("/contracts/{contract_id}/reports", response_model=ReportOut, status_code=201)
async def create_report(contract_id: uuid.UUID, body: ReportCreate, db: DB, user: CurrentUser = Depends(EDIT)):
    r = await service.create_report(db, await service.get_contract(db, contract_id), body, user)
    return (await service.report_outs(db, [r]))[0]


@router.patch("/third-party-reports/{report_id}", response_model=ReportOut)
async def update_report(report_id: uuid.UUID, body: ReportUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    r = await service._child(db, ThirdPartyReport, report_id, "Report")
    return (await service.report_outs(db, [await service.update_report(db, r, body, user)]))[0]


@router.delete("/third-party-reports/{report_id}", status_code=204)
async def delete_report(report_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    r = await service._child(db, ThirdPartyReport, report_id, "Report")
    await service._soft_delete(db, r, "third_party_report", r.report_type, user)


# --------------------------------------------------------------------------- title & survey

@router.get("/contracts/{contract_id}/title-exceptions", response_model=list[TitleExceptionOut])
async def list_exceptions(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    rows = list(await db.scalars(select(TitleException).where(
        TitleException.contract_id == contract_id, TitleException.deleted_at.is_(None)
    ).order_by(TitleException.source, TitleException.schedule_ref, TitleException.created_at)))
    return await service.exception_outs(db, rows)


@router.post("/contracts/{contract_id}/title-exceptions", response_model=TitleExceptionOut, status_code=201)
async def create_exception(contract_id: uuid.UUID, body: TitleExceptionCreate, db: DB, user: CurrentUser = Depends(EDIT)):
    x = await service.create_exception(db, await service.get_contract(db, contract_id), body, user)
    return (await service.exception_outs(db, [x]))[0]


@router.patch("/title-exceptions/{exception_id}", response_model=TitleExceptionOut)
async def update_exception(exception_id: uuid.UUID, body: TitleExceptionUpdate, db: DB,
                           user: CurrentUser = Depends(EDIT)):
    x = await service._child(db, TitleException, exception_id, "Title exception")
    return (await service.exception_outs(db, [await service.update_exception(db, x, body, user)]))[0]


@router.delete("/title-exceptions/{exception_id}", status_code=204)
async def delete_exception(exception_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    x = await service._child(db, TitleException, exception_id, "Title exception")
    await service._soft_delete(db, x, "title_exception", x.description[:200], user)


# --------------------------------------------------------------------------- estoppels / SNDA

@router.get("/contracts/{contract_id}/estoppels", response_model=list[EstoppelOut])
async def list_estoppels(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return list(await db.scalars(select(Estoppel).where(
        Estoppel.contract_id == contract_id, Estoppel.deleted_at.is_(None)
    ).order_by(Estoppel.tenant_name, Estoppel.kind)))


@router.post("/contracts/{contract_id}/estoppels", response_model=EstoppelOut, status_code=201)
async def create_estoppel(contract_id: uuid.UUID, body: EstoppelCreate, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.create_estoppel(db, await service.get_contract(db, contract_id), body, user)


@router.patch("/estoppels/{estoppel_id}", response_model=EstoppelOut)
async def update_estoppel(estoppel_id: uuid.UUID, body: EstoppelUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    e = await service._child(db, Estoppel, estoppel_id, "Estoppel")
    return await service.update_estoppel(db, e, body, user)


@router.post("/estoppels/{estoppel_id}/resolve", response_model=EstoppelOut)
async def resolve_estoppel(estoppel_id: uuid.UUID, body: RequiredNoteIn, db: DB, user: CurrentUser = Depends(EDIT)):
    e = await service._child(db, Estoppel, estoppel_id, "Estoppel")
    return await service.resolve_estoppel(db, e, body.note, user)


@router.delete("/estoppels/{estoppel_id}", status_code=204)
async def delete_estoppel(estoppel_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    e = await service._child(db, Estoppel, estoppel_id, "Estoppel")
    await service._soft_delete(db, e, "estoppel", e.tenant_name, user)


# --------------------------------------------------------------------------- risks & decisions

@router.get("/contracts/{contract_id}/risks", response_model=list[RiskOut])
async def list_risks(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    rows = list(await db.scalars(select(RiskItem).where(RiskItem.contract_id == contract_id, RiskItem.deleted_at.is_(None))
                                 .order_by(RiskItem.created_at)))
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    rows.sort(key=lambda r: (r.status == "closed", order.get(r.severity, 4)))
    return await service.risk_outs(db, rows)


@router.post("/contracts/{contract_id}/risks", response_model=RiskOut, status_code=201)
async def create_risk(contract_id: uuid.UUID, body: RiskCreate, db: DB, user: CurrentUser = Depends(EDIT)):
    r = await service.create_risk(db, await service.get_contract(db, contract_id), body, user)
    return (await service.risk_outs(db, [r]))[0]


@router.patch("/risks/{risk_id}", response_model=RiskOut)
async def update_risk(risk_id: uuid.UUID, body: RiskUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    r = await service._child(db, RiskItem, risk_id, "Risk")
    return (await service.risk_outs(db, [await service.update_risk(db, r, body, user)]))[0]


@router.post("/risks/{risk_id}/decide", response_model=RiskOut)
async def decide_risk(risk_id: uuid.UUID, body: RiskDecideIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    r = await service._child(db, RiskItem, risk_id, "Risk")
    return (await service.risk_outs(db, [await service.decide_risk(db, r, body, user)]))[0]


@router.delete("/risks/{risk_id}", status_code=204)
async def delete_risk(risk_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    r = await service._child(db, RiskItem, risk_id, "Risk")
    if r.decision:
        raise HTTPException(409, "Decided risks are retained; close the risk instead")
    await service._soft_delete(db, r, "risk_item", r.title, user)


@router.get("/contracts/{contract_id}/decisions", response_model=list[DecisionOut])
async def list_decisions(contract_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return list(await db.scalars(select(ContractDecision).where(ContractDecision.contract_id == contract_id)
                                 .order_by(ContractDecision.decided_at.desc())))


@router.post("/contracts/{contract_id}/decisions", response_model=DecisionOut, status_code=201)
async def record_decision(contract_id: uuid.UUID, body: DecisionCreate, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.record_decision(db, await service.get_contract(db, contract_id), body, user)


# =========================================================================== DD templates

@router.get("/dd-templates", response_model=list[DDTemplateOut])
async def list_templates(db: DB, _: CurrentUser = Depends(VIEW)):
    rows = await service.ensure_templates(db)
    await db.commit()
    return rows


@router.post("/dd-templates", response_model=DDTemplateOut, status_code=201)
async def create_template(body: DDTemplateCreate, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.save_template(db, None, body, user)


@router.get("/dd-templates/{template_id}", response_model=DDTemplateOut)
async def get_template(template_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.get_template(db, template_id)


@router.patch("/dd-templates/{template_id}", response_model=DDTemplateOut)
async def update_template(template_id: uuid.UUID, body: DDTemplateUpdate, db: DB, user: CurrentUser = Depends(APPROVE)):
    t: DDTemplate = await service.get_template(db, template_id)
    return await service.save_template(db, t, body, user)


# =========================================================================== critical dates (global)

DATE_SORTS = {
    "due_on": CriticalDate.due_on, "label": CriticalDate.label, "status": CriticalDate.status,
    "date_type": CriticalDate.date_type, "related_type": CriticalDate.related_type, "updated_at": CriticalDate.updated_at,
}


def date_filters(
    q: str | None = Query(None, max_length=200),
    related_type: list[str] | None = Query(None),
    related_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    owner_id: list[uuid.UUID] | None = Query(None),
    status: list[str] | None = Query(None),
    date_type: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    window: str | None = Query(None, pattern="^(overdue|7|30|90)$"),
    blocking: bool | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    mine: bool | None = None,
) -> DateFilters:
    return DateFilters(**locals())


@router.get("/critical-dates", response_model=Page[CriticalDateOut])
async def list_dates(db: DB, params: ListParams = Depends(), f: DateFilters = Depends(date_filters),
                     user: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.build_date_query(f, user_id=user.id), params.sort, DATE_SORTS,
                      CriticalDate.due_on.asc())
    rows, total = await paginate(db, stmt, params)
    return Page[CriticalDateOut](items=await service.date_outs(db, rows), total=total, page=params.page,
                                 page_size=params.page_size)


@router.get("/critical-dates/facets", response_model=CriticalDateFacets)
async def date_facets(db: DB, f: DateFilters = Depends(date_filters), user: CurrentUser = Depends(VIEW)):
    def q(skip: str):
        return service.build_date_query(f, skip={skip}, user_id=user.id)

    return CriticalDateFacets(
        status=await facet_counts(db, q("status"), CriticalDate.status),
        related_type=await facet_counts(db, q("related_type"), CriticalDate.related_type),
        date_type=await facet_counts(db, q("date_type"), CriticalDate.date_type),
        owner_id=await facet_counts(db, q("owner_id"), CriticalDate.owner_id),
    )


@router.get("/critical-dates/summary", response_model=CriticalDateSummary)
async def date_summary(db: DB, f: DateFilters = Depends(date_filters), user: CurrentUser = Depends(VIEW)):
    return CriticalDateSummary(**await service.date_summary(db, f, user.id))


@router.get("/critical-dates/calendar", response_model=list[CriticalDateOut])
async def date_calendar(db: DB, start: date, end: date, f: DateFilters = Depends(date_filters),
                        user: CurrentUser = Depends(VIEW)):
    if (end - start).days > 62 or end < start:
        raise HTTPException(422, "Calendar range must be between 0 and 62 days")
    f.due_from, f.due_to = start, end
    rows = list(await db.scalars(service.build_date_query(f, user_id=user.id).order_by(CriticalDate.due_on).limit(2000)))
    return await service.date_outs(db, rows)


@router.get("/critical-dates/meta")
async def date_meta(_: CurrentUser = Depends(VIEW)):
    return {"statuses": CRITICAL_DATE_STATUSES, "sources": CRITICAL_DATE_SOURCES, "date_types": DATE_TYPES}


@router.post("/critical-dates", response_model=CriticalDateOut, status_code=201)
async def create_date(body: CriticalDateCreate, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.date_outs(db, [await service.create_manual_date(db, body, user)]))[0]


@router.post("/critical-dates/scan")
async def scan_dates(db: DB, user: CurrentUser = Depends(EDIT)):
    result = await service.scan_critical_dates(db, actor=user)
    await db.commit()
    return result


@router.post("/critical-dates/bulk")
async def bulk_dates(body: BulkDatesIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.bulk_dates(db, body.ids, body.action, body.note, user)


@router.get("/critical-dates/{date_id}", response_model=CriticalDateOut)
async def get_date(date_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return (await service.date_outs(db, [await service.get_date(db, date_id)]))[0]


@router.patch("/critical-dates/{date_id}", response_model=CriticalDateOut)
async def update_date(date_id: uuid.UUID, body: CriticalDateUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    cd = await service.update_date(db, await service.get_date(db, date_id), body, user)
    return (await service.date_outs(db, [cd]))[0]


@router.post("/critical-dates/{date_id}/confirm", response_model=CriticalDateOut)
async def confirm_date(date_id: uuid.UUID, body: ConfirmIn, db: DB, user: CurrentUser = Depends(EDIT)):
    cd = await service.confirm_date(db, await service.get_date(db, date_id), body, user)
    return (await service.date_outs(db, [cd]))[0]


@router.post("/critical-dates/{date_id}/complete", response_model=CriticalDateOut)
async def complete_date(date_id: uuid.UUID, body: NoteIn, db: DB, user: CurrentUser = Depends(EDIT)):
    cd = await service.complete_date(db, await service.get_date(db, date_id), body.note, user)
    return (await service.date_outs(db, [cd]))[0]


@router.post("/critical-dates/{date_id}/waive", response_model=CriticalDateOut)
async def waive_date(date_id: uuid.UUID, body: RequiredNoteIn, db: DB, user: CurrentUser = Depends(EDIT)):
    cd = await service.waive_date(db, await service.get_date(db, date_id), body.note, user)
    return (await service.date_outs(db, [cd]))[0]


@router.post("/critical-dates/{date_id}/reschedule", response_model=CriticalDateOut)
async def reschedule_date(date_id: uuid.UUID, body: RescheduleIn, db: DB, user: CurrentUser = Depends(EDIT)):
    cd = await service.reschedule_date(db, await service.get_date(db, date_id), body.due_on, body.reason, user)
    return (await service.date_outs(db, [cd]))[0]


@router.get("/critical-dates/{date_id}/events", response_model=list[CriticalDateEventOut])
async def date_events(date_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    await service.get_date(db, date_id)
    return await service.date_events(db, date_id)


# =========================================================================== holiday calendars

@router.get("/holiday-calendars", response_model=list[HolidayCalendarOut])
async def list_calendars(db: DB, _: CurrentUser = Depends(VIEW)):
    await service.ensure_default_calendar(db)
    await db.commit()
    return list(await db.scalars(select(HolidayCalendar).where(HolidayCalendar.deleted_at.is_(None))
                                 .order_by(HolidayCalendar.is_default.desc(), HolidayCalendar.name)))


@router.post("/holiday-calendars", response_model=HolidayCalendarOut, status_code=201)
async def create_calendar(body: HolidayCalendarCreate, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.create_calendar(db, body, user)


@router.get("/holiday-calendars/{calendar_id}/holidays", response_model=list[HolidayOut])
async def list_holidays(calendar_id: uuid.UUID, db: DB, year: int = Query(..., ge=1990, le=2100),
                        _: CurrentUser = Depends(VIEW)):
    cal = await db.get(HolidayCalendar, calendar_id)
    if not cal or cal.deleted_at:
        raise HTTPException(404, "Calendar not found")
    return await service.list_holidays(db, cal, year)


@router.post("/holiday-calendars/{calendar_id}/holidays", response_model=HolidayOut, status_code=201)
async def add_holiday(calendar_id: uuid.UUID, body: HolidayIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    cal = await db.get(HolidayCalendar, calendar_id)
    if not cal or cal.deleted_at:
        raise HTTPException(404, "Calendar not found")
    return await service.add_holiday(db, cal, body.holiday_on, body.name, user)


@router.delete("/holiday-calendars/{calendar_id}/holidays/{holiday_id}", status_code=204)
async def delete_holiday(calendar_id: uuid.UUID, holiday_id: uuid.UUID, db: DB, user: CurrentUser = Depends(APPROVE)):
    cal = await db.get(HolidayCalendar, calendar_id)
    if not cal or cal.deleted_at:
        raise HTTPException(404, "Calendar not found")
    await service.delete_holiday(db, cal, holiday_id, user)


@router.get("/business-days", response_model=BusinessDaysOut)
async def business_days(db: DB, start: date, days: int = Query(..., ge=-3650, le=3650), business: bool = True,
                        calendar_id: uuid.UUID | None = None, _: CurrentUser = Depends(VIEW)):
    """Preview of the date engine: `start` + `days` business (or calendar) days."""
    cal = await service.get_calendar(db, calendar_id)
    if business:
        result = await service.add_business_days(db, start, days, cal.id)
    else:
        from datetime import timedelta

        result = start + timedelta(days=days)
    await db.commit()
    return BusinessDaysOut(start=start, days=days, business_days=business, result=result, calendar_id=cal.id)
