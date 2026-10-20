import csv
import io
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.common import audit, provenance
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.properties import service
from app.modules.properties.models import PROPERTY_STATUSES, PROPERTY_TYPES, Property
from app.modules.properties.schemas import (
    BulkIn,
    ObservationOut,
    PropertyCreate,
    PropertyFacets,
    PropertyListItem,
    PropertyOut,
    PropertyUpdate,
    VerifyIn,
)
from app.modules.properties.service import PropertyFilters

router = APIRouter(prefix="/properties", tags=["properties"])

SORTS = {
    "name": Property.name, "address_line": Property.address_line, "city": Property.city,
    "property_type": Property.property_type, "status": Property.status,
    "building_area_sf": Property.building_area_sf, "land_area_acres": Property.land_area_acres,
    "asking_price": Property.asking_price, "year_built": Property.year_built,
    "completeness_score": Property.completeness_score, "updated_at": Property.updated_at,
    "created_at": Property.created_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    property_type: list[str] | None = Query(None),
    state: list[str] | None = Query(None),
    county: str | None = None,
    city: str | None = None,
    tag: list[str] | None = Query(None),
    min_area: float | None = None,
    max_area: float | None = None,
    min_acres: float | None = None,
    max_acres: float | None = None,
    min_price: float | None = None,
    max_price: float | None = None,
    min_year: int | None = None,
    max_year: int | None = None,
    min_completeness: float | None = None,
    near_lat: float | None = None,
    near_lng: float | None = None,
    radius_miles: float | None = Query(None, gt=0, le=200),
    ids: list[uuid.UUID] | None = Query(None),
) -> PropertyFilters:
    return PropertyFilters(**locals())


@router.get("", response_model=Page[PropertyListItem])
async def list_properties(
    db: DB,
    params: ListParams = Depends(),
    f: PropertyFilters = Depends(filters),
    _: CurrentUser = Depends(require("properties", "view")),
):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Property.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[PropertyListItem](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/facets", response_model=PropertyFacets)
async def facets(db: DB, f: PropertyFilters = Depends(filters), _: CurrentUser = Depends(require("properties", "view"))):
    return PropertyFacets(
        status=await facet_counts(db, service.build_query(f, skip={"status"}), Property.status),
        property_type=await facet_counts(db, service.build_query(f, skip={"property_type"}), Property.property_type),
        state=await facet_counts(db, service.build_query(f, skip={"state"}), Property.state),
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("properties", "view"))):
    return {"statuses": PROPERTY_STATUSES, "types": PROPERTY_TYPES}


@router.get("/export")
async def export_csv(
    db: DB,
    params: ListParams = Depends(),
    f: PropertyFilters = Depends(filters),
    user: CurrentUser = Depends(require("properties", "export")),
):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Property.updated_at.desc()).limit(50_000)
    rows = list(await db.scalars(stmt))
    cols = ["id", "name", "address_line", "city", "state", "postal_code", "county", "property_type", "status",
            "building_area_sf", "land_area_acres", "year_built", "asking_price", "occupancy_pct", "noi",
            "zoning", "completeness_score"]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(cols)
    for r in rows:
        writer.writerow([getattr(r, c) for c in cols])
    await audit.record(db, actor=user, action="property.exported", entity_type="property",
                       summary=f"{len(rows)} rows", changes={"filters": {k: v for k, v in vars(f).items() if v}},
                       ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=properties.csv"},
    )


@router.post("", response_model=PropertyOut, status_code=201)
async def create_property(
    body: PropertyCreate, db: DB, force: bool = False, user: CurrentUser = Depends(require("properties", "create"))
):
    if force and not user.can("properties", "approve"):
        raise HTTPException(403, "Creating a possible duplicate requires approval permission")
    p = await service.create(db, body, user, force=force)
    return await service.to_out(db, p)


@router.post("/bulk")
async def bulk_update(body: BulkIn, db: DB, user: CurrentUser = Depends(require("properties", "edit"))):
    return {"updated": await service.bulk_update(db, body, user)}


@router.get("/{property_id}", response_model=PropertyOut)
async def get_property(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("properties", "view"))):
    return await service.to_out(db, await service.get(db, property_id))


@router.patch("/{property_id}", response_model=PropertyOut)
async def update_property(
    property_id: uuid.UUID, body: PropertyUpdate, db: DB, user: CurrentUser = Depends(require("properties", "edit"))
):
    p = await service.update(db, await service.get(db, property_id), body, user)
    return await service.to_out(db, p)


@router.delete("/{property_id}", status_code=204)
async def archive_property(property_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("properties", "delete"))):
    await service.archive(db, await service.get(db, property_id), user)


@router.get("/{property_id}/history", response_model=list[ObservationOut])
async def field_history(
    property_id: uuid.UUID, db: DB, field: str | None = None,
    _: CurrentUser = Depends(require("properties", "view")),
):
    return await provenance.history(db, service.ENTITY, property_id, field)


@router.post("/observations/{obs_id}/verify", response_model=ObservationOut)
async def verify_observation(obs_id: uuid.UUID, body: VerifyIn, db: DB,
                             user: CurrentUser = Depends(require("properties", "edit"))):
    return await service.verify_observation(db, obs_id, body.state, user)
