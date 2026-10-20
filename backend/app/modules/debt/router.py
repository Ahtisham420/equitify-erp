import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.debt import calc, service
from app.modules.debt.models import (
    COVENANT_KINDS,
    FREQUENCIES,
    LOAN_STATUSES,
    LOAN_TYPES,
    PREPAYMENT_TYPES,
    RATE_TYPES,
    RECOURSE_TYPES,
    REPORT_TYPES,
    RESERVE_TYPES,
    Covenant,
    CovenantTest,
    LenderReportingObligation,
    Loan,
    LoanEvent,
    LoanReserve,
    ReserveTransaction,
)
from app.modules.debt.schemas import (
    CollateralIn,
    CovenantIn,
    CovenantOut,
    CovenantTestIn,
    CovenantTestOut,
    DebtSettingsIn,
    LoanCreate,
    LoanEventOut,
    LoanFacets,
    LoanListItem,
    LoanOut,
    LoanUpdate,
    ObligationIn,
    ObligationOut,
    ReserveIn,
    ReserveOut,
    ReserveTxnIn,
    ReserveTxnOut,
    SubmitIn,
)
from app.modules.debt.service import LoanFilters

router = APIRouter(prefix="/loans", tags=["debt"])

SORTS = {
    "label": Loan.name, "lender_name": Loan.lender_name, "current_balance": Loan.current_balance, "rate": Loan.rate,
    "maturity_on": Loan.maturity_on, "status": Loan.status, "covenant_state": Loan.covenant_state,
    "loan_type": Loan.loan_type, "updated_at": Loan.updated_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    rate_type: list[str] | None = Query(None),
    loan_type: list[str] | None = Query(None),
    covenant_state: list[str] | None = Query(None),
    lender_name: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    maturity_from: date | None = None,
    maturity_to: date | None = None,
) -> LoanFilters:
    return LoanFilters(**locals())


def market_overrides(
    rate: float | None = None, ltv: float | None = None, dscr: float | None = None, debt_yield: float | None = None,
    amort_years: float | None = None, cap_rate: float | None = None, treasury_rate: float | None = None,
    sale_cost_pct: float | None = None, refi_cost_pct: float | None = None,
) -> dict:
    return {k: v for k, v in locals().items() if v is not None}


@router.get("", response_model=Page[LoanListItem])
async def list_loans(db: DB, params: ListParams = Depends(), f: LoanFilters = Depends(filters),
                     _: CurrentUser = Depends(require("debt", "view"))):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Loan.maturity_on.asc().nulls_last())
    items, total = await paginate(db, stmt, params)
    return Page[LoanListItem](items=await service.to_items(db, items), total=total, page=params.page,
                              page_size=params.page_size)


@router.get("/facets", response_model=LoanFacets)
async def facets(db: DB, f: LoanFilters = Depends(filters), _: CurrentUser = Depends(require("debt", "view"))):
    q = service.build_query
    return LoanFacets(
        status=await facet_counts(db, q(f, skip={"status"}), Loan.status),
        rate_type=await facet_counts(db, q(f, skip={"rate_type"}), Loan.rate_type),
        loan_type=await facet_counts(db, q(f, skip={"loan_type"}), Loan.loan_type),
        covenant_state=await facet_counts(db, q(f, skip={"covenant_state"}), Loan.covenant_state),
        lender_name=await facet_counts(db, q(f, skip={"lender_name"}), Loan.lender_name),
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("debt", "view"))):
    return {"statuses": LOAN_STATUSES, "loan_types": LOAN_TYPES, "rate_types": RATE_TYPES, "recourse": RECOURSE_TYPES,
            "prepayment_types": PREPAYMENT_TYPES, "covenant_kinds": COVENANT_KINDS, "frequencies": FREQUENCIES,
            "reserve_types": RESERVE_TYPES, "report_types": REPORT_TYPES}


@router.get("/ladder")
async def maturity_ladder(db: DB, bucket: str = Query("year", pattern="^(year|quarter|month)$"),
                          f: LoanFilters = Depends(filters), _: CurrentUser = Depends(require("debt", "view"))):
    return await service.ladder(db, bucket, f)


@router.get("/exposure")
async def rate_exposure(db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    return await service.exposure(db)


@router.get("/covenants", response_model=list[CovenantOut])
async def covenant_status(db: DB, state: list[str] | None = Query(None), kind: list[str] | None = Query(None),
                          loan_id: uuid.UUID | None = None, _: CurrentUser = Depends(require("debt", "view"))):
    stmt = (select(Covenant).join(Loan, Loan.id == Covenant.loan_id)
            .where(Covenant.deleted_at.is_(None), Loan.deleted_at.is_(None)))
    if state:
        stmt = stmt.where(Covenant.last_state.in_(state))
    if kind:
        stmt = stmt.where(Covenant.kind.in_(kind))
    if loan_id:
        stmt = stmt.where(Covenant.loan_id == loan_id)
    return await service.covenant_items(db, list(await db.scalars(stmt.order_by(Covenant.next_test_on.asc().nulls_first()))))


@router.get("/settings")
async def get_settings(db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    return await service.get_settings(db)


@router.put("/settings")
async def put_settings(body: DebtSettingsIn, db: DB, user: CurrentUser = Depends(require("debt", "approve"))):
    return await service.save_settings(db, body, user)


@router.post("/scan")
async def scan(db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    result = await service.scan(db, user)
    await db.commit()
    return result


@router.get("/by-property/{property_id}", response_model=list[LoanListItem])
async def loans_by_property(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    rows = list(await db.scalars(service.build_query(LoanFilters(property_id=property_id))
                                 .order_by(Loan.status, Loan.maturity_on.asc().nulls_last())))
    return await service.to_items(db, rows)


# ---------------------------------------------------------------- by-id sub-resources (declared before /{loan_id})

async def _cov(db, covenant_id: uuid.UUID) -> Covenant:
    c = await db.get(Covenant, covenant_id)
    if not c or c.deleted_at:
        raise HTTPException(404, "Covenant not found")
    return c


@router.patch("/covenants/{covenant_id}", response_model=CovenantOut)
async def update_covenant(covenant_id: uuid.UUID, body: CovenantIn, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    c = await service.update_covenant(db, await _cov(db, covenant_id), body, user)
    return (await service.covenant_items(db, [c]))[0]


@router.post("/covenants/{covenant_id}/test", response_model=CovenantTestOut)
async def test_covenant(covenant_id: uuid.UUID, body: CovenantTestIn, db: DB,
                        user: CurrentUser = Depends(require("debt", "edit"))):
    c = await _cov(db, covenant_id)
    if body.manual_value is not None and c.kind != "net_worth" and not user.can("debt", "approve"):
        raise HTTPException(403, "Overriding a computed covenant value requires approval permission")
    t = await service.run_test(db, c, user, test_date=body.test_date, manual_value=body.manual_value, notes=body.notes)
    await db.commit()
    return t


async def _reserve(db, reserve_id: uuid.UUID) -> LoanReserve:
    r = await db.get(LoanReserve, reserve_id)
    if not r or r.deleted_at:
        raise HTTPException(404, "Reserve not found")
    return r


def _reserve_out(r: LoanReserve) -> dict:
    out = ReserveOut.model_validate(r).model_dump()
    out["funded_pct"] = round(float(r.balance or 0) / float(r.required_amount) * 100, 1) if r.required_amount else None
    return out


@router.patch("/reserves/{reserve_id}", response_model=ReserveOut)
async def update_reserve(reserve_id: uuid.UUID, body: ReserveIn, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    return _reserve_out(await service.update_reserve(db, await _reserve(db, reserve_id), body, user))


@router.post("/reserves/{reserve_id}/transactions", response_model=ReserveTxnOut, status_code=201)
async def reserve_transaction(reserve_id: uuid.UUID, body: ReserveTxnIn, db: DB,
                              user: CurrentUser = Depends(require("debt", "edit"))):
    r = await _reserve(db, reserve_id)
    if body.kind in ("release", "adjustment") and not user.can("debt", "approve"):
        raise HTTPException(403, "Reserve releases and adjustments require approval permission")
    return await service.post_reserve_txn(db, r, body, user)


async def _obligation(db, obligation_id: uuid.UUID) -> LenderReportingObligation:
    o = await db.get(LenderReportingObligation, obligation_id)
    if not o or o.deleted_at:
        raise HTTPException(404, "Reporting obligation not found")
    return o


@router.patch("/obligations/{obligation_id}", response_model=ObligationOut)
async def update_obligation(obligation_id: uuid.UUID, body: ObligationIn, db: DB,
                            user: CurrentUser = Depends(require("debt", "edit"))):
    o = await service.update_obligation(db, await _obligation(db, obligation_id), body, user)
    return (await service.obligation_items(db, [o]))[0]


@router.post("/obligations/{obligation_id}/submit", response_model=ObligationOut)
async def submit_obligation(obligation_id: uuid.UUID, body: SubmitIn, db: DB,
                            user: CurrentUser = Depends(require("debt", "edit"))):
    o = await service.submit_obligation(db, await _obligation(db, obligation_id), body.submitted_on, body.document_id,
                                        body.note, user)
    return (await service.obligation_items(db, [o]))[0]


# ---------------------------------------------------------------- loan record

@router.post("", response_model=LoanOut, status_code=201)
async def create_loan(body: LoanCreate, db: DB, user: CurrentUser = Depends(require("debt", "create"))):
    return await service.to_out(db, await service.create(db, body, user))


@router.get("/{loan_id}", response_model=LoanOut)
async def get_loan(loan_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    return await service.to_out(db, await service.get(db, loan_id))


@router.patch("/{loan_id}", response_model=LoanOut)
async def update_loan(loan_id: uuid.UUID, body: LoanUpdate, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    return await service.to_out(db, await service.update(db, await service.get(db, loan_id), body, user))


@router.delete("/{loan_id}", status_code=204)
async def archive_loan(loan_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("debt", "delete"))):
    await service.archive(db, await service.get(db, loan_id), user)


@router.get("/{loan_id}/events", response_model=list[LoanEventOut])
async def loan_events(loan_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    await service.get(db, loan_id)
    return list(await db.scalars(select(LoanEvent).where(LoanEvent.loan_id == loan_id).order_by(LoanEvent.at.desc())))


@router.post("/{loan_id}/collateral", response_model=LoanOut, status_code=201)
async def add_collateral(loan_id: uuid.UUID, body: CollateralIn, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    loan = await service.get(db, loan_id)
    await service.add_collateral(db, loan, body, user)
    return await service.to_out(db, loan)


@router.delete("/{loan_id}/collateral/{link_id}", status_code=204)
async def remove_collateral(loan_id: uuid.UUID, link_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    await service.remove_collateral(db, await service.get(db, loan_id), link_id, user)


@router.get("/{loan_id}/prepayment")
async def prepayment_estimate(loan_id: uuid.UUID, db: DB, payoff_on: date | None = None,
                              treasury_rate: float | None = Query(None, ge=0, le=100),
                              _: CurrentUser = Depends(require("debt", "view"))):
    loan = await service.get(db, loan_id)
    s = await service.get_settings(db)
    tsy = treasury_rate if treasury_rate is not None else (loan.prepayment or {}).get("treasury_rate") or s["market"]["treasury_rate"]
    return calc.prepayment_cost(loan, payoff_on or date.today(), float(tsy))


@router.get("/{loan_id}/refinance")
async def refinance(loan_id: uuid.UUID, db: DB, m: dict = Depends(market_overrides),
                    _: CurrentUser = Depends(require("debt", "view"))):
    return await service.refinance(db, await service.get(db, loan_id), m)


@router.get("/{loan_id}/hold-refi-sell")
async def hold_refi_sell(loan_id: uuid.UUID, db: DB, m: dict = Depends(market_overrides),
                         _: CurrentUser = Depends(require("debt", "view"))):
    return await service.hold_refi_sell(db, await service.get(db, loan_id), m)


@router.get("/{loan_id}/covenants", response_model=list[CovenantOut])
async def list_covenants(loan_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    rows = list(await db.scalars(select(Covenant).where(Covenant.loan_id == loan_id, Covenant.deleted_at.is_(None))
                                 .order_by(Covenant.kind)))
    return await service.covenant_items(db, rows)


@router.post("/{loan_id}/covenants", response_model=CovenantOut, status_code=201)
async def create_covenant(loan_id: uuid.UUID, body: CovenantIn, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    c = await service.create_covenant(db, await service.get(db, loan_id), body, user)
    return (await service.covenant_items(db, [c]))[0]


@router.post("/{loan_id}/covenants/test", response_model=list[CovenantTestOut])
async def test_all_covenants(loan_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    await service.get(db, loan_id)
    covs = list(await db.scalars(select(Covenant).where(Covenant.loan_id == loan_id, Covenant.deleted_at.is_(None),
                                                        Covenant.is_active.is_(True), Covenant.kind != "net_worth")))
    tests = [await service.run_test(db, c, user) for c in covs]
    await db.commit()
    return tests


@router.get("/{loan_id}/covenant-tests", response_model=list[CovenantTestOut])
async def covenant_tests(loan_id: uuid.UUID, db: DB, covenant_id: uuid.UUID | None = None,
                         _: CurrentUser = Depends(require("debt", "view"))):
    stmt = select(CovenantTest).where(CovenantTest.loan_id == loan_id, CovenantTest.deleted_at.is_(None))
    if covenant_id:
        stmt = stmt.where(CovenantTest.covenant_id == covenant_id)
    return list(await db.scalars(stmt.order_by(CovenantTest.test_date.desc(), CovenantTest.created_at.desc()).limit(500)))


@router.get("/{loan_id}/reserves", response_model=list[ReserveOut])
async def list_reserves(loan_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    rows = await db.scalars(select(LoanReserve).where(LoanReserve.loan_id == loan_id, LoanReserve.deleted_at.is_(None))
                            .order_by(LoanReserve.reserve_type))
    return [_reserve_out(r) for r in rows]


@router.post("/{loan_id}/reserves", response_model=ReserveOut, status_code=201)
async def create_reserve(loan_id: uuid.UUID, body: ReserveIn, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    return _reserve_out(await service.create_reserve(db, await service.get(db, loan_id), body, user))


@router.get("/{loan_id}/reserve-transactions", response_model=list[ReserveTxnOut])
async def reserve_transactions(loan_id: uuid.UUID, db: DB, reserve_id: uuid.UUID | None = None,
                               _: CurrentUser = Depends(require("debt", "view"))):
    stmt = select(ReserveTransaction).where(ReserveTransaction.loan_id == loan_id, ReserveTransaction.deleted_at.is_(None))
    if reserve_id:
        stmt = stmt.where(ReserveTransaction.reserve_id == reserve_id)
    return list(await db.scalars(stmt.order_by(ReserveTransaction.occurred_on.desc(), ReserveTransaction.created_at.desc())))


@router.get("/{loan_id}/obligations", response_model=list[ObligationOut])
async def list_obligations(loan_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("debt", "view"))):
    rows = list(await db.scalars(select(LenderReportingObligation).where(
        LenderReportingObligation.loan_id == loan_id, LenderReportingObligation.deleted_at.is_(None))
        .order_by(LenderReportingObligation.next_due_on.asc().nulls_last())))
    return await service.obligation_items(db, rows)


@router.post("/{loan_id}/obligations", response_model=ObligationOut, status_code=201)
async def create_obligation(loan_id: uuid.UUID, body: ObligationIn, db: DB, user: CurrentUser = Depends(require("debt", "edit"))):
    o = await service.create_obligation(db, await service.get(db, loan_id), body, user)
    return (await service.obligation_items(db, [o]))[0]
