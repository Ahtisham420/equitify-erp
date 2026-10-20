import uuid

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import provenance
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.parcels import service
from app.modules.parcels.models import OCCUPANCY_STATES, PARCEL_RELATIONSHIPS, SPACE_USE_TYPES, Parcel
from app.modules.parcels.schemas import (
    AdjacencyOut,
    AssemblageOut,
    BuildingIn,
    BuildingOut,
    BuildingUpdate,
    BulkAssociateIn,
    BulkAssociateOut,
    LinkedProperty,
    ObservationOut,
    ParcelCreate,
    ParcelFacets,
    ParcelListItem,
    ParcelMergeIn,
    ParcelOut,
    ParcelUpdate,
    ParcelVersionOut,
    PropertyParcelIn,
    PropertyParcelOut,
    PropertyParcelUpdate,
    SpaceIn,
    SpaceOut,
    SpaceUpdate,
)
from app.modules.parcels.service import ParcelFilters
from app.modules.properties import service as property_service

# No prefix: this router serves /parcels/* and the property hierarchy under /properties/{id}/...
router = APIRouter(tags=["parcels"])

SORTS = {
    "apn": Parcel.apn, "county": Parcel.county, "state": Parcel.state, "acreage": Parcel.acreage,
    "observed_on": Parcel.observed_on, "updated_at": Parcel.updated_at, "created_at": Parcel.created_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    county: list[str] | None = Query(None),
    state: list[str] | None = Query(None),
    min_acres: float | None = None,
    max_acres: float | None = None,
    has_geometry: bool | None = None,
    property_id: uuid.UUID | None = None,
    linked: bool | None = None,
    bbox: str | None = Query(None, max_length=120),
    near_lat: float | None = Query(None, ge=-90, le=90),
    near_lng: float | None = Query(None, ge=-180, le=180),
    radius_miles: float | None = Query(None, gt=0, le=200),
    territory_id: uuid.UUID | None = None,
    ids: list[uuid.UUID] | None = Query(None),
) -> ParcelFilters:
    return ParcelFilters(**locals())


async def _territory_guard(db: DB, f: ParcelFilters, user: CurrentUser) -> None:
    """Spatial filtering by territory only for territories the user may see."""
    if f.territory_id:
        from app.modules.territories import service as territory_service

        await territory_service.get_visible(db, f.territory_id, user)


# ----------------------------------------------------------------------------- parcels

@router.get("/parcels", response_model=Page[ParcelListItem])
async def list_parcels(
    db: DB,
    params: ListParams = Depends(),
    f: ParcelFilters = Depends(filters),
    user: CurrentUser = Depends(require("parcels", "view")),
):
    await _territory_guard(db, f, user)
    stmt = apply_sort(service.list_stmt(f), params.sort, SORTS, Parcel.updated_at.desc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[ParcelListItem](items=service.list_items(rows), total=total, page=params.page, page_size=params.page_size)


@router.get("/parcels/facets", response_model=ParcelFacets)
async def parcel_facets(db: DB, f: ParcelFilters = Depends(filters), user: CurrentUser = Depends(require("parcels", "view"))):
    await _territory_guard(db, f, user)
    return ParcelFacets(
        county=await facet_counts(db, service.build_query(f, skip={"county"}), Parcel.county),
        state=await facet_counts(db, service.build_query(f, skip={"state"}), Parcel.state),
    )


@router.get("/parcels/meta")
async def parcel_meta(_: CurrentUser = Depends(require("parcels", "view"))):
    return {"relationships": PARCEL_RELATIONSHIPS, "occupancy_states": OCCUPANCY_STATES, "space_use_types": SPACE_USE_TYPES}


@router.get("/parcels/geojson")
async def parcels_geojson(
    db: DB,
    f: ParcelFilters = Depends(filters),
    limit: int = Query(2000, ge=1, le=10_000),
    user: CurrentUser = Depends(require("parcels", "view")),
):
    """FeatureCollection for map layers. Use `bbox=minLng,minLat,maxLng,maxLat` plus any list filter."""
    await _territory_guard(db, f, user)
    return await service.feature_collection(db, f, limit)


@router.post("/parcels/bulk-associate", response_model=BulkAssociateOut)
async def bulk_associate(body: BulkAssociateIn, db: DB, user: CurrentUser = Depends(require("parcels", "edit"))):
    """Preview (default) or apply: link many parcels to an existing property or a new one."""
    if body.new_property and not body.preview and not user.can("properties", "create"):
        raise HTTPException(403, "Missing permission properties:create")
    return await service.bulk_associate(db, body, user)


@router.post("/parcels", response_model=ParcelOut, status_code=201)
async def create_parcel(body: ParcelCreate, db: DB, force: bool = False,
                        user: CurrentUser = Depends(require("parcels", "create"))):
    if force and not user.can("parcels", "approve"):
        raise HTTPException(403, "Creating a possible duplicate parcel requires approval permission")
    return await service.to_out(db, await service.create(db, body, user, force=force))


@router.get("/parcels/{parcel_id}", response_model=ParcelOut)
async def get_parcel(parcel_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("parcels", "view"))):
    return await service.to_out(db, await service.get(db, parcel_id))


@router.patch("/parcels/{parcel_id}", response_model=ParcelOut)
async def update_parcel(parcel_id: uuid.UUID, body: ParcelUpdate, db: DB,
                        user: CurrentUser = Depends(require("parcels", "edit"))):
    p = await service.update(db, await service.get(db, parcel_id), body, user)
    return await service.to_out(db, p)


@router.delete("/parcels/{parcel_id}", status_code=204)
async def archive_parcel(parcel_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("parcels", "delete"))):
    await service.archive(db, await service.get(db, parcel_id), user)


@router.post("/parcels/{parcel_id}/merge", response_model=ParcelOut)
async def merge_parcel(parcel_id: uuid.UUID, body: ParcelMergeIn, db: DB,
                       user: CurrentUser = Depends(require("parcels", "approve"))):
    """Merge a reviewed duplicate (`parcel_id`) into `into_id`. Never automatic."""
    source = await service.get(db, parcel_id)
    target = await service.get(db, body.into_id)
    return await service.to_out(db, await service.merge(db, source, target, user))


@router.get("/parcels/{parcel_id}/geojson")
async def parcel_geojson(parcel_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("parcels", "view"))):
    return await service.feature(db, await service.get(db, parcel_id))


@router.get("/parcels/{parcel_id}/adjacent", response_model=AdjacencyOut)
async def adjacent_parcels(
    parcel_id: uuid.UUID, db: DB, tolerance_m: float = Query(service.ADJACENCY_TOLERANCE_M, ge=0, le=100),
    user: CurrentUser = Depends(require("parcels", "view")),
):
    return await service.adjacent(db, await service.get(db, parcel_id), user, tolerance_m)


@router.get("/parcels/{parcel_id}/assemblage", response_model=AssemblageOut)
async def parcel_assemblage(
    parcel_id: uuid.UUID, db: DB, tolerance_m: float = Query(service.ADJACENCY_TOLERANCE_M, ge=0, le=100),
    user: CurrentUser = Depends(require("parcels", "view")),
):
    return await service.assemblage(db, await service.get(db, parcel_id), user, tolerance_m)


@router.get("/parcels/{parcel_id}/properties", response_model=list[LinkedProperty])
async def parcel_properties(parcel_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("parcels", "view"))):
    await service.get(db, parcel_id)
    return await service.parcel_properties(db, parcel_id)


@router.get("/parcels/{parcel_id}/versions", response_model=list[ParcelVersionOut])
async def parcel_versions(parcel_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("parcels", "view"))):
    await service.get(db, parcel_id)
    return await service.versions(db, parcel_id)


@router.get("/parcels/{parcel_id}/history", response_model=list[ObservationOut])
async def parcel_field_history(parcel_id: uuid.UUID, db: DB, field: str | None = None,
                               _: CurrentUser = Depends(require("parcels", "view"))):
    return await provenance.history(db, service.ENTITY, parcel_id, field)


# ----------------------------------------------------------------------------- property hierarchy

@router.get("/properties/{property_id}/parcels", response_model=list[PropertyParcelOut])
async def list_property_parcels(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("parcels", "view"))):
    await property_service.get(db, property_id)
    return await service.property_parcels(db, property_id)


@router.post("/properties/{property_id}/parcels", status_code=201)
async def link_property_parcel(property_id: uuid.UUID, body: PropertyParcelIn, db: DB,
                               user: CurrentUser = Depends(require("parcels", "edit"))):
    await property_service.get(db, property_id)
    link = await service.link_parcel(db, property_id, body, user)
    return {"link_id": link.id}


@router.patch("/properties/{property_id}/parcels/{link_id}")
async def update_property_parcel(property_id: uuid.UUID, link_id: uuid.UUID, body: PropertyParcelUpdate, db: DB,
                                 user: CurrentUser = Depends(require("parcels", "edit"))):
    link = await service.update_link(db, await service.get_link(db, property_id, link_id), body, user)
    return {"link_id": link.id, "relationship": link.relationship}


@router.delete("/properties/{property_id}/parcels/{link_id}", status_code=204)
async def unlink_property_parcel(property_id: uuid.UUID, link_id: uuid.UUID, db: DB,
                                 user: CurrentUser = Depends(require("parcels", "edit"))):
    await service.unlink(db, await service.get_link(db, property_id, link_id), user)


@router.get("/properties/{property_id}/buildings", response_model=list[BuildingOut])
async def list_buildings(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("parcels", "view"))):
    await property_service.get(db, property_id)
    return await service.list_buildings(db, property_id)


@router.post("/properties/{property_id}/buildings", response_model=BuildingOut, status_code=201)
async def create_building(property_id: uuid.UUID, body: BuildingIn, db: DB,
                          user: CurrentUser = Depends(require("parcels", "create"))):
    await property_service.get(db, property_id)
    return await service.create_building(db, property_id, body, user)


@router.patch("/properties/{property_id}/buildings/{building_id}", response_model=BuildingOut)
async def update_building(property_id: uuid.UUID, building_id: uuid.UUID, body: BuildingUpdate, db: DB,
                          user: CurrentUser = Depends(require("parcels", "edit"))):
    b = await service.get_building(db, property_id, building_id)
    return await service.update_building(db, b, body, user)


@router.delete("/properties/{property_id}/buildings/{building_id}", status_code=204)
async def archive_building(property_id: uuid.UUID, building_id: uuid.UUID, db: DB,
                           user: CurrentUser = Depends(require("parcels", "delete"))):
    await service.archive_building(db, await service.get_building(db, property_id, building_id), user)


@router.get("/properties/{property_id}/spaces", response_model=list[SpaceOut])
async def list_spaces(
    property_id: uuid.UUID, db: DB, q: str | None = Query(None, max_length=200), building_id: uuid.UUID | None = None,
    occupancy_status: list[str] | None = Query(None), _: CurrentUser = Depends(require("parcels", "view")),
):
    await property_service.get(db, property_id)
    return await service.list_spaces(db, property_id, q=q, building_id=building_id, occupancy_status=occupancy_status)


@router.post("/properties/{property_id}/spaces", response_model=SpaceOut, status_code=201)
async def create_space(property_id: uuid.UUID, body: SpaceIn, db: DB,
                       user: CurrentUser = Depends(require("parcels", "create"))):
    await property_service.get(db, property_id)
    return await service.create_space(db, property_id, body, user)


@router.patch("/properties/{property_id}/spaces/{space_id}", response_model=SpaceOut)
async def update_space(property_id: uuid.UUID, space_id: uuid.UUID, body: SpaceUpdate, db: DB,
                       user: CurrentUser = Depends(require("parcels", "edit"))):
    return await service.update_space(db, await service.get_space(db, property_id, space_id), body, user)


@router.delete("/properties/{property_id}/spaces/{space_id}", status_code=204)
async def archive_space(property_id: uuid.UUID, space_id: uuid.UUID, db: DB,
                        user: CurrentUser = Depends(require("parcels", "delete"))):
    await service.archive_space(db, await service.get_space(db, property_id, space_id), user)


@router.get("/spaces/{space_id}/history", response_model=list[ObservationOut])
async def space_history(space_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("parcels", "view"))):
    return await provenance.history(db, "space", space_id)
