import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.comps import service
from app.modules.comps.models import (
    ADJUSTMENT_FACTORS,
    LEASE_BASES,
    RECOVERY_TYPES,
    SALE_BASES,
    TENANT_CREDIT,
    VALUATION_METHODS,
    VERIFICATION_METHODS,
    VERIFICATION_STATUSES,
    Bov,
    CompSet,
    LeaseComp,
    SaleComp,
    Valuation,
    ValuationDocument,
)
from app.modules.comps.schemas import (
    AddItemsIn,
    BovCreate,
    BovOut,
    BovUpdate,
    Candidate,
    CompFacets,
    CompSetCreate,
    CompSetFacets,
    CompSetListItem,
    CompSetOut,
    CompSetUpdate,
    FromCompSetIn,
    GridIn,
    ItemUpdate,
    LeaseCompCreate,
    LeaseCompOut,
    LeaseCompUpdate,
    SaleCompCreate,
    SaleCompOut,
    SaleCompUpdate,
    ValuationCreate,
    ValuationDocumentIn,
    ValuationDocumentOut,
    ValuationFacets,
    ValuationOut,
    ValuationPreview,
    VerificationIn,
)
from app.modules.comps.service import CandidateQuery, CompFilters, CompSetFilters, ValuationFilters

router = APIRouter(tags=["comps"])

SALE_SORTS = {
    "name": SaleComp.name, "city": SaleComp.city, "sale_date": SaleComp.sale_date, "sale_price": SaleComp.sale_price,
    "price_psf": SaleComp.price_psf, "cap_rate": SaleComp.cap_rate, "property_type": SaleComp.property_type,
    "verification_status": SaleComp.verification_status, "updated_at": SaleComp.updated_at,
}
LEASE_SORTS = {
    "tenant_name": LeaseComp.tenant_name, "city": LeaseComp.city, "commencement_on": LeaseComp.commencement_on,
    "base_rent_psf": LeaseComp.base_rent_psf, "effective_rent_psf": LeaseComp.effective_rent_psf,
    "term_months": LeaseComp.term_months, "area_sf": LeaseComp.area_sf,
    "verification_status": LeaseComp.verification_status, "updated_at": LeaseComp.updated_at,
}
SET_SORTS = {"name": CompSet.name, "kind": CompSet.kind, "status": CompSet.status, "updated_at": CompSet.updated_at}
VALUATION_SORTS = {"as_of": Valuation.as_of, "method": Valuation.method, "value_point": Valuation.value_point,
                   "created_at": Valuation.created_at}


@router.get("/comps/meta")
async def meta(_: CurrentUser = Depends(require("comps", "view"))):
    return {
        "verification_statuses": VERIFICATION_STATUSES, "verification_methods": VERIFICATION_METHODS,
        "tenant_credit": TENANT_CREDIT, "recovery_types": RECOVERY_TYPES, "valuation_methods": VALUATION_METHODS,
        "adjustment_factors": ADJUSTMENT_FACTORS, "sale_bases": SALE_BASES, "lease_bases": LEASE_BASES,
        "valuation_material": service.VALUATION_MATERIAL,
    }


def candidate_params(
    kind: str = Query("sale", pattern="^(sale|lease)$"),
    subject_property_id: uuid.UUID | None = None,
    near_lat: float | None = Query(None, ge=-90, le=90),
    near_lng: float | None = Query(None, ge=-180, le=180),
    radius_miles: float | None = Query(None, gt=0, le=500),
    property_type: list[str] | None = Query(None),
    county: str | None = None,
    corridor: str | None = None,
    tenant_credit: list[str] | None = Query(None),
    min_term_years: float | None = Query(None, ge=0),
    max_term_years: float | None = Query(None, ge=0),
    date_from: date | None = None,
    date_to: date | None = None,
    verified_only: bool = False,
    exclude_set_id: uuid.UUID | None = None,
    q: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=200),
) -> CandidateQuery:
    return CandidateQuery(**locals())


@router.get("/comps/candidates", response_model=list[Candidate])
async def comp_candidates(db: DB, cq: CandidateQuery = Depends(candidate_params),
                          _: CurrentUser = Depends(require("comps", "view"))):
    return await service.candidates(db, cq)


# --------------------------------------------------------------------------- sale / lease comps


def comp_filters(
    q: str | None = Query(None, max_length=200),
    property_type: list[str] | None = Query(None),
    verification_status: list[str] | None = Query(None),
    tenant_credit: list[str] | None = Query(None),
    state: list[str] | None = Query(None),
    county: str | None = None,
    corridor: str | None = None,
    property_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_price: float | None = None,
    max_price: float | None = None,
    min_cap: float | None = None,
    max_cap: float | None = None,
    min_rent: float | None = None,
    max_rent: float | None = None,
) -> CompFilters:
    return CompFilters(**locals())


async def _facets(db, kind: str, f: CompFilters) -> CompFacets:
    M = service.COMP_MODELS[kind]
    q = service.build_comp_query
    return CompFacets(
        property_type=await facet_counts(db, q(kind, f, skip={"property_type"}), M.property_type),
        verification_status=await facet_counts(db, q(kind, f, skip={"verification_status"}), M.verification_status),
        tenant_credit=await facet_counts(db, q(kind, f, skip={"tenant_credit"}), M.tenant_credit),
        state=await facet_counts(db, q(kind, f, skip={"state"}), M.state),
    )


@router.get("/sale-comps", response_model=Page[SaleCompOut])
async def list_sale_comps(db: DB, params: ListParams = Depends(), f: CompFilters = Depends(comp_filters),
                          _: CurrentUser = Depends(require("comps", "view"))):
    stmt = apply_sort(service.build_comp_query("sale", f), params.sort, SALE_SORTS, SaleComp.sale_date.desc().nulls_last())
    rows, total = await paginate(db, stmt, params)
    return Page[SaleCompOut](items=await service.comp_out(db, "sale", rows), total=total, page=params.page,
                             page_size=params.page_size)


@router.get("/sale-comps/facets", response_model=CompFacets)
async def sale_facets(db: DB, f: CompFilters = Depends(comp_filters), _: CurrentUser = Depends(require("comps", "view"))):
    return await _facets(db, "sale", f)


@router.post("/sale-comps", response_model=SaleCompOut, status_code=201)
async def create_sale_comp(body: SaleCompCreate, db: DB, user: CurrentUser = Depends(require("comps", "create"))):
    c = await service.create_comp(db, "sale", body, user)
    return (await service.comp_out(db, "sale", [c]))[0]


@router.get("/sale-comps/{comp_id}", response_model=SaleCompOut)
async def get_sale_comp(comp_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("comps", "view"))):
    return (await service.comp_out(db, "sale", [await service.get_comp(db, "sale", comp_id)]))[0]


@router.patch("/sale-comps/{comp_id}", response_model=SaleCompOut)
async def update_sale_comp(comp_id: uuid.UUID, body: SaleCompUpdate, db: DB,
                           user: CurrentUser = Depends(require("comps", "edit"))):
    c = await service.update_comp(db, "sale", await service.get_comp(db, "sale", comp_id), body, user)
    return (await service.comp_out(db, "sale", [c]))[0]


@router.post("/sale-comps/{comp_id}/verify", response_model=SaleCompOut)
async def verify_sale_comp(comp_id: uuid.UUID, body: VerificationIn, db: DB,
                           user: CurrentUser = Depends(require("comps", "edit"))):
    c = await service.verify_comp(db, "sale", await service.get_comp(db, "sale", comp_id), body, user)
    return (await service.comp_out(db, "sale", [c]))[0]


@router.delete("/sale-comps/{comp_id}", status_code=204)
async def delete_sale_comp(comp_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("comps", "delete"))):
    await service.archive_comp(db, "sale", await service.get_comp(db, "sale", comp_id), user)


@router.get("/lease-comps", response_model=Page[LeaseCompOut])
async def list_lease_comps(db: DB, params: ListParams = Depends(), f: CompFilters = Depends(comp_filters),
                           _: CurrentUser = Depends(require("comps", "view"))):
    stmt = apply_sort(service.build_comp_query("lease", f), params.sort, LEASE_SORTS,
                      LeaseComp.commencement_on.desc().nulls_last())
    rows, total = await paginate(db, stmt, params)
    return Page[LeaseCompOut](items=await service.comp_out(db, "lease", rows), total=total, page=params.page,
                              page_size=params.page_size)


@router.get("/lease-comps/facets", response_model=CompFacets)
async def lease_facets(db: DB, f: CompFilters = Depends(comp_filters), _: CurrentUser = Depends(require("comps", "view"))):
    return await _facets(db, "lease", f)


@router.post("/lease-comps", response_model=LeaseCompOut, status_code=201)
async def create_lease_comp(body: LeaseCompCreate, db: DB, user: CurrentUser = Depends(require("comps", "create"))):
    c = await service.create_comp(db, "lease", body, user)
    return (await service.comp_out(db, "lease", [c]))[0]


@router.get("/lease-comps/{comp_id}", response_model=LeaseCompOut)
async def get_lease_comp(comp_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("comps", "view"))):
    return (await service.comp_out(db, "lease", [await service.get_comp(db, "lease", comp_id)]))[0]


@router.patch("/lease-comps/{comp_id}", response_model=LeaseCompOut)
async def update_lease_comp(comp_id: uuid.UUID, body: LeaseCompUpdate, db: DB,
                            user: CurrentUser = Depends(require("comps", "edit"))):
    c = await service.update_comp(db, "lease", await service.get_comp(db, "lease", comp_id), body, user)
    return (await service.comp_out(db, "lease", [c]))[0]


@router.post("/lease-comps/{comp_id}/verify", response_model=LeaseCompOut)
async def verify_lease_comp(comp_id: uuid.UUID, body: VerificationIn, db: DB,
                            user: CurrentUser = Depends(require("comps", "edit"))):
    c = await service.verify_comp(db, "lease", await service.get_comp(db, "lease", comp_id), body, user)
    return (await service.comp_out(db, "lease", [c]))[0]


@router.delete("/lease-comps/{comp_id}", status_code=204)
async def delete_lease_comp(comp_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("comps", "delete"))):
    await service.archive_comp(db, "lease", await service.get_comp(db, "lease", comp_id), user)


# --------------------------------------------------------------------------- comp sets


def set_filters(
    q: str | None = Query(None, max_length=200),
    kind: list[str] | None = Query(None),
    status: list[str] | None = Query(None),
    purpose: list[str] | None = Query(None),
    subject_property_id: uuid.UUID | None = None,
) -> CompSetFilters:
    return CompSetFilters(**locals())


@router.get("/comp-sets", response_model=Page[CompSetListItem])
async def list_sets(db: DB, params: ListParams = Depends(), f: CompSetFilters = Depends(set_filters),
                    _: CurrentUser = Depends(require("comps", "view"))):
    stmt = apply_sort(service.build_set_query(f), params.sort, SET_SORTS, CompSet.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[CompSetListItem](items=await service.sets_out(db, rows), total=total, page=params.page,
                                 page_size=params.page_size)


@router.get("/comp-sets/facets", response_model=CompSetFacets)
async def set_facets(db: DB, f: CompSetFilters = Depends(set_filters), _: CurrentUser = Depends(require("comps", "view"))):
    q = service.build_set_query
    return CompSetFacets(
        kind=await facet_counts(db, q(f, skip={"kind"}), CompSet.kind),
        status=await facet_counts(db, q(f, skip={"status"}), CompSet.status),
        purpose=await facet_counts(db, q(f, skip={"purpose"}), CompSet.purpose),
    )


@router.post("/comp-sets", response_model=CompSetOut, status_code=201)
async def create_set(body: CompSetCreate, db: DB, user: CurrentUser = Depends(require("comps", "create"))):
    return await service.set_out(db, await service.create_set(db, body, user))


@router.get("/comp-sets/{set_id}", response_model=CompSetOut)
async def get_set(set_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("comps", "view"))):
    return await service.set_out(db, await service.get_set(db, set_id))


@router.patch("/comp-sets/{set_id}", response_model=CompSetOut)
async def update_set(set_id: uuid.UUID, body: CompSetUpdate, db: DB, user: CurrentUser = Depends(require("comps", "edit"))):
    return await service.set_out(db, await service.update_set(db, await service.get_set(db, set_id), body, user))


@router.delete("/comp-sets/{set_id}", status_code=204)
async def delete_set(set_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("comps", "delete"))):
    await service.archive_set(db, await service.get_set(db, set_id), user)


@router.get("/comp-sets/{set_id}/candidates", response_model=list[Candidate])
async def set_candidates(set_id: uuid.UUID, db: DB, cq: CandidateQuery = Depends(candidate_params),
                         _: CurrentUser = Depends(require("comps", "view"))):
    cs = await service.get_set(db, set_id)
    cq.kind = cs.kind
    cq.subject_property_id = cq.subject_property_id or cs.subject_property_id
    cq.exclude_set_id = cs.id
    return await service.candidates(db, cq)


@router.post("/comp-sets/{set_id}/items", response_model=CompSetOut)
async def add_items(set_id: uuid.UUID, body: AddItemsIn, db: DB, user: CurrentUser = Depends(require("comps", "edit"))):
    return await service.set_out(db, await service.add_items(db, await service.get_set(db, set_id), body, user))


@router.patch("/comp-sets/{set_id}/items/{item_id}", response_model=CompSetOut)
async def update_item(set_id: uuid.UUID, item_id: uuid.UUID, body: ItemUpdate, db: DB,
                      user: CurrentUser = Depends(require("comps", "edit"))):
    cs = await service.update_item(db, await service.get_set(db, set_id), item_id, body, user)
    return await service.set_out(db, cs)


@router.put("/comp-sets/{set_id}/grid", response_model=CompSetOut)
async def save_grid(set_id: uuid.UUID, body: GridIn, db: DB, user: CurrentUser = Depends(require("comps", "edit"))):
    return await service.set_out(db, await service.save_grid(db, await service.get_set(db, set_id), body, user))


@router.post("/comp-sets/{set_id}/valuation", response_model=ValuationOut, status_code=201)
async def valuation_from_set(set_id: uuid.UUID, body: FromCompSetIn, db: DB,
                             user: CurrentUser = Depends(require("comps", "create"))):
    v = await service.valuation_from_set(db, await service.get_set(db, set_id), body, user)
    return (await service.valuations_out(db, [v]))[0]


@router.post("/comp-sets/{set_id}/bov", response_model=BovOut, status_code=201)
async def generate_bov(set_id: uuid.UUID, body: BovCreate, db: DB, user: CurrentUser = Depends(require("comps", "create"))):
    b = await service.create_bov(db, await service.get_set(db, set_id), body, user)
    return (await service.bovs_out(db, [b]))[0]


# --------------------------------------------------------------------------- valuations & marks


def valuation_filters(
    property_id: uuid.UUID | None = None,
    method: list[str] | None = Query(None),
    is_mark: bool | None = None,
    latest_only: bool = False,
    as_of_from: date | None = None,
    as_of_to: date | None = None,
    comp_set_id: uuid.UUID | None = None,
) -> ValuationFilters:
    return ValuationFilters(**locals())


@router.get("/valuations", response_model=Page[ValuationOut])
async def list_valuations(db: DB, params: ListParams = Depends(), f: ValuationFilters = Depends(valuation_filters),
                          _: CurrentUser = Depends(require("comps", "view"))):
    stmt = apply_sort(service.build_valuation_query(f), params.sort, VALUATION_SORTS,
                      Valuation.as_of.desc())
    if params.q:
        from app.modules.properties.models import Property

        sub = select(Property.id).where(Property.name.ilike(f"%{params.q}%") | Property.address_line.ilike(f"%{params.q}%"))
        stmt = stmt.where(Valuation.property_id.in_(sub))
    rows, total = await paginate(db, stmt, params)
    return Page[ValuationOut](items=await service.valuations_out(db, rows), total=total, page=params.page,
                              page_size=params.page_size)


@router.get("/valuations/facets", response_model=ValuationFacets)
async def valuation_facets(db: DB, f: ValuationFilters = Depends(valuation_filters),
                           _: CurrentUser = Depends(require("comps", "view"))):
    q = service.build_valuation_query
    return ValuationFacets(
        method=await facet_counts(db, q(f, skip={"method"}), Valuation.method),
        is_mark=await facet_counts(db, q(f, skip={"is_mark"}), Valuation.is_mark),
    )


@router.post("/valuations/preview", response_model=ValuationPreview)
async def preview_valuation(body: ValuationCreate, db: DB, _: CurrentUser = Depends(require("comps", "view"))):
    result, _a, unsourced = await service.compute_valuation(db, body)
    await db.rollback()  # preview never persists (sales comparison may have refreshed a comp set's cached range)
    return ValuationPreview(value_low=result["value_low"], value_high=result["value_high"],
                            value_point=result["value_point"], calculation=result["calculation"], unsourced=unsourced)


@router.post("/valuations", response_model=ValuationOut, status_code=201)
async def create_valuation(body: ValuationCreate, db: DB, user: CurrentUser = Depends(require("comps", "create"))):
    v = await service.create_valuation(db, body, user)
    return (await service.valuations_out(db, [v]))[0]


@router.get("/valuations/documents", response_model=list[ValuationDocumentOut])
async def list_documents(db: DB, property_id: uuid.UUID, _: CurrentUser = Depends(require("comps", "view"))):
    return list(await db.scalars(select(ValuationDocument).where(
        ValuationDocument.property_id == property_id, ValuationDocument.deleted_at.is_(None))
        .order_by(ValuationDocument.created_at.desc())))


@router.post("/valuations/documents", response_model=ValuationDocumentOut, status_code=201)
async def link_document(body: ValuationDocumentIn, db: DB, user: CurrentUser = Depends(require("comps", "edit"))):
    return await service.add_document(db, body, user)


@router.delete("/valuations/documents/{link_id}", status_code=204)
async def unlink_document(link_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("comps", "edit"))):
    await service.remove_document(db, link_id, user)


@router.get("/valuations/{valuation_id}", response_model=ValuationOut)
async def get_valuation(valuation_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("comps", "view"))):
    return (await service.valuations_out(db, [await service.get_valuation(db, valuation_id)]))[0]


@router.delete("/valuations/{valuation_id}", status_code=204)
async def delete_valuation(valuation_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("comps", "delete"))):
    await service.archive_valuation(db, await service.get_valuation(db, valuation_id), user)


# --------------------------------------------------------------------------- BOVs


@router.get("/bovs", response_model=Page[BovOut])
async def list_bovs(db: DB, params: ListParams = Depends(), property_id: uuid.UUID | None = None,
                    comp_set_id: uuid.UUID | None = None, status: list[str] | None = Query(None),
                    _: CurrentUser = Depends(require("comps", "view"))):
    stmt = select(Bov).where(Bov.deleted_at.is_(None))
    if property_id:
        stmt = stmt.where(Bov.property_id == property_id)
    if comp_set_id:
        stmt = stmt.where(Bov.comp_set_id == comp_set_id)
    if status:
        stmt = stmt.where(Bov.status.in_(status))
    if params.q:
        stmt = stmt.where(Bov.title.ilike(f"%{params.q}%"))
    stmt = apply_sort(stmt, params.sort, {"title": Bov.title, "created_at": Bov.created_at, "status": Bov.status},
                      Bov.created_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[BovOut](items=await service.bovs_out(db, rows), total=total, page=params.page, page_size=params.page_size)


@router.get("/bovs/{bov_id}", response_model=BovOut)
async def get_bov(bov_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("comps", "view"))):
    return (await service.bovs_out(db, [await service.get_bov(db, bov_id)]))[0]


@router.patch("/bovs/{bov_id}", response_model=BovOut)
async def update_bov(bov_id: uuid.UUID, body: BovUpdate, db: DB, user: CurrentUser = Depends(require("comps", "edit"))):
    b = await service.update_bov(db, await service.get_bov(db, bov_id), body, user)
    return (await service.bovs_out(db, [b]))[0]


@router.post("/bovs/{bov_id}/regenerate", response_model=BovOut)
async def regenerate_bov(bov_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("comps", "edit"))):
    b = await service.regenerate_bov(db, await service.get_bov(db, bov_id), user)
    return (await service.bovs_out(db, [b]))[0]
