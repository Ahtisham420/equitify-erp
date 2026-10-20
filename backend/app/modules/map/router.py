import uuid

from fastapi import APIRouter, Depends, Query, Response

from app.common.query import ListParams, Page, apply_sort, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.map import service
from app.modules.map.models import MapFieldObservation
from app.modules.map.schemas import (
    AssemblageMapOut,
    BulkExportIn,
    BulkOpportunitiesIn,
    BulkResult,
    BulkSequenceIn,
    BulkTerritoryIn,
    CardOut,
    ExportOut,
    LayersOut,
    MapConfigOut,
    ObservationIn,
    ObservationOut,
    SaveTerritoryIn,
    SelectIn,
    SelectOut,
)
from app.modules.map.service import MapFilters

router = APIRouter(prefix="/map", tags=["map"])

VIEW = require("map", "view")
DEFAULT_LAYERS = "properties,parcels,opportunities,territories"


def map_filters(
    bbox: str | None = Query(None, max_length=200, description="minLng,minLat,maxLng,maxLat"),
    status: list[str] | None = Query(None),
    property_type: list[str] | None = Query(None),
    stage: list[str] | None = Query(None),
    signal_category: list[str] | None = Query(None),
    near_lat: float | None = Query(None, ge=-90, le=90),
    near_lng: float | None = Query(None, ge=-180, le=180),
    radius_miles: float | None = Query(None, gt=0, le=200),
    polygon: str | None = Query(None, max_length=60_000, description="GeoJSON polygon"),
    corridor_id: uuid.UUID | None = None,
    buffer_ft: float | None = Query(None, gt=0, le=26_400),
    adjacent_to: uuid.UUID | None = Query(None, description="Parcel id: only records on parcels touching it"),
) -> MapFilters:
    return MapFilters(**locals())


@router.get("/config", response_model=MapConfigOut)
async def config(user: CurrentUser = Depends(VIEW)):
    return service.map_config(user)


@router.get("/layers", response_model=LayersOut)
async def layers(db: DB, layers: str = Query(DEFAULT_LAYERS, max_length=300), f: MapFilters = Depends(map_filters),
                 user: CurrentUser = Depends(VIEW)):
    """One GeoJSON FeatureCollection per requested layer (capped). Layers the user cannot view are listed in `hidden`."""
    requested = list(dict.fromkeys(k.strip() for k in layers.split(",") if k.strip()))
    return await service.layers(db, f, requested, user)


@router.post("/select", response_model=SelectOut)
async def select_records(body: SelectIn, db: DB, user: CurrentUser = Depends(require("properties", "view"))):
    service._need(user, "map", "view")
    return await service.select_records(db, body, user)


# --- bulk actions: `apply: false` returns the preview (counts, skips, warnings); `apply: true` executes -----------


@router.post("/bulk/opportunities", response_model=BulkResult)
async def bulk_opportunities(body: BulkOpportunitiesIn, db: DB,
                             user: CurrentUser = Depends(require("pipeline", "create"))):
    service._need(user, "map", "view")
    return await service.bulk_opportunities(db, body, user)


@router.post("/bulk/territory", response_model=BulkResult)
async def bulk_territory(body: BulkTerritoryIn, db: DB, user: CurrentUser = Depends(require("territories", "edit"))):
    service._need(user, "map", "view")
    return await service.bulk_territory(db, body, user)


@router.post("/bulk/sequence", response_model=BulkResult)
async def bulk_sequence(body: BulkSequenceIn, db: DB, user: CurrentUser = Depends(require("outreach", "create"))):
    service._need(user, "map", "view")
    service._need(user, "ownership", "view")
    return await service.bulk_sequence(db, body, user)


@router.post("/bulk/export", response_model=ExportOut)
async def bulk_export(body: BulkExportIn, db: DB, user: CurrentUser = Depends(require("contacts", "export"))):
    service._need(user, "map", "view")
    service._need(user, "ownership", "view")
    return await service.bulk_export(db, body, user)


@router.post("/territories", status_code=201)
async def save_territory(body: SaveTerritoryIn, db: DB, user: CurrentUser = Depends(require("territories", "create"))):
    """Saves a drawn polygon as a boundary territory (a drawn circle becomes a radius territory)."""
    service._need(user, "map", "view")
    t = await service.save_territory(db, body, user)
    return {"id": t.id, "name": t.name, "rule_type": t.rule_type, "member_count": t.member_count}


@router.get("/assemblage", response_model=AssemblageMapOut)
async def assemblage(parcel_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("parcels", "view"))):
    """Contiguous parcels sharing a current owner with the parcel, plus their union for highlighting."""
    service._need(user, "map", "view")
    return await service.assemblage(db, parcel_id, user)


@router.get("/card", response_model=CardOut)
async def record_card(kind: str, id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.card(db, kind, id, user)


# --- field observations ---------------------------------------------------------------------------------------


@router.get("/observations", response_model=Page[ObservationOut])
async def list_observations(
    db: DB, params: ListParams = Depends(), bbox: str | None = Query(None, max_length=200),
    property_id: uuid.UUID | None = None, category: list[str] | None = Query(None), mine: bool = False,
    user: CurrentUser = Depends(VIEW),
):
    stmt = service.observation_query(bbox=bbox, property_id=property_id, category=category, mine=mine, user=user,
                                     q=params.q)
    sorts = {"observed_at": MapFieldObservation.observed_at, "category": MapFieldObservation.category}
    rows, total = await paginate(db, apply_sort(stmt, params.sort, sorts, MapFieldObservation.observed_at.desc()), params)
    return Page[ObservationOut](items=await service.observation_outs(db, rows), total=total, page=params.page,
                                page_size=params.page_size)


@router.post("/observations", response_model=ObservationOut, status_code=201)
async def create_observation(body: ObservationIn, response: Response, db: DB,
                             user: CurrentUser = Depends(require("map", "create"))):
    """Idempotent by `client_uuid` so the offline queue can safely re-send (200 when already stored)."""
    o, created = await service.create_observation(db, body, user)
    if not created:
        response.status_code = 200
    return (await service.observation_outs(db, [o]))[0]


@router.get("/observations/{obs_id}", response_model=ObservationOut)
async def get_observation(obs_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return (await service.observation_outs(db, [await service.get_observation(db, obs_id)]))[0]
