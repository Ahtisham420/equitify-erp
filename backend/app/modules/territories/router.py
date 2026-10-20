import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, literal_column

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.territories import service
from app.modules.territories.models import (
    GROWTH_KINDS,
    ROAD_CLASSES,
    RULE_TYPES,
    TRADE_AREA_MINUTES,
    VISIBILITIES,
    Corridor,
    GrowthRecord,
    Node,
    Territory,
    TradeArea,
    TrafficCount,
)
from app.modules.territories.schemas import (
    CorridorIn,
    CorridorOut,
    CorridorUpdate,
    GrowthFacets,
    GrowthIn,
    GrowthOut,
    GrowthUpdate,
    MemberOut,
    MembersIn,
    NodeIn,
    NodeOut,
    NodeUpdate,
    OverlapOut,
    PropertyRef,
    RecomputeOut,
    TerritoryFacets,
    TerritoryIn,
    TerritoryListItem,
    TerritoryOut,
    TerritoryUpdate,
    TradeAreaIn,
    TradeAreaOut,
    TradeAreaUpdate,
    TrafficCountIn,
    TrafficCountOut,
    TrafficCountUpdate,
    TrafficTrendPoint,
)

# No prefix: serves /corridors, /nodes, /traffic-counts, /trade-areas, /growth-records, /territories, /geography/*
router = APIRouter(tags=["territories"])

VIEW = require("territories", "view")
CREATE = require("territories", "create")
EDIT = require("territories", "edit")
DELETE = require("territories", "delete")


def _clean(values: dict, *required: str) -> dict:
    """PATCH: ignore explicit nulls for required (non-nullable) fields."""
    return {k: v for k, v in values.items() if not (k in required and v is None)}


@router.get("/geography/meta")
async def geography_meta(_: CurrentUser = Depends(VIEW)):
    return {"rule_types": RULE_TYPES, "visibilities": VISIBILITIES, "road_classes": ROAD_CLASSES,
            "growth_kinds": GROWTH_KINDS, "trade_area_minutes": TRADE_AREA_MINUTES}


# ============================================================================= corridors

CORRIDOR_SORTS = {"name": Corridor.name, "road_name": Corridor.road_name, "road_class": Corridor.road_class,
                  "city": Corridor.city, "county": Corridor.county, "frontage_length_ft": Corridor.frontage_length_ft,
                  "updated_at": Corridor.updated_at}


def corridor_filters(
    q: str | None = Query(None, max_length=200), road_class: list[str] | None = Query(None), county: str | None = None,
    city: str | None = None, has_geometry: bool | None = None,
) -> service.CorridorFilters:
    return service.CorridorFilters(**locals())


@router.get("/corridors", response_model=Page[CorridorOut])
async def list_corridors(db: DB, params: ListParams = Depends(), f: service.CorridorFilters = Depends(corridor_filters),
                         _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.corridor_query(f).add_columns(*service.corridor_extras()), params.sort, CORRIDOR_SORTS,
                      Corridor.name.asc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[CorridorOut](items=service.corridor_rows(rows), total=total, page=params.page, page_size=params.page_size)


@router.get("/corridors/facets")
async def corridor_facets(db: DB, f: service.CorridorFilters = Depends(corridor_filters), _: CurrentUser = Depends(VIEW)):
    f.road_class = None
    return {"road_class": await facet_counts(db, service.corridor_query(f), Corridor.road_class)}


@router.get("/corridors/geojson")
async def corridors_geojson(db: DB, f: service.CorridorFilters = Depends(corridor_filters),
                            limit: int = Query(1000, ge=1, le=5000), _: CurrentUser = Depends(VIEW)):
    stmt = (service.corridor_query(f).where(Corridor.has_geometry.is_(True))
            .with_only_columns(Corridor.id, Corridor.name, Corridor.road_class, func.ST_AsGeoJSON(Corridor.geometry, 6))
            .limit(limit))
    rows = (await db.execute(stmt)).all()
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": str(i), "geometry": service.geo.loads(g),
         "properties": {"id": str(i), "name": n, "road_class": rc}} for i, n, rc, g in rows]}


@router.post("/corridors", response_model=CorridorOut, status_code=201)
async def create_corridor(body: CorridorIn, db: DB, user: CurrentUser = Depends(CREATE)):
    c = await service.create_record(db, Corridor, body.model_dump(exclude={"geometry"}), user, "corridor",
                                    geometry=body.geometry, kind="line")
    return await service.corridor_out(db, c)


@router.get("/corridors/{corridor_id}", response_model=CorridorOut)
async def get_corridor(corridor_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.corridor_out(db, await service.get_obj(db, Corridor, corridor_id, "Corridor"))


@router.patch("/corridors/{corridor_id}", response_model=CorridorOut)
async def update_corridor(corridor_id: uuid.UUID, body: CorridorUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.get_obj(db, Corridor, corridor_id, "Corridor")
    values = _clean(body.model_dump(exclude_unset=True, exclude={"geometry", "clear_geometry"}), "name", "road_class")
    c = await service.update_record(db, c, values, user, "corridor", geometry=body.geometry, clear_geometry=body.clear_geometry,
                                    kind="line")
    return await service.corridor_out(db, c)


@router.delete("/corridors/{corridor_id}", status_code=204)
async def archive_corridor(corridor_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_record(db, await service.get_obj(db, Corridor, corridor_id, "Corridor"), user, "corridor")


# ============================================================================= nodes

NODE_SORTS = {"name": Node.name, "city": Node.city, "county": Node.county, "updated_at": Node.updated_at}


def node_filters(
    q: str | None = Query(None, max_length=200), corridor_id: uuid.UUID | None = None, county: str | None = None,
    city: str | None = None, signalized: bool | None = None,
) -> service.NodeFilters:
    return service.NodeFilters(**locals())


def _node_out(n: Node, corridor_name: str | None) -> NodeOut:
    return NodeOut.model_validate(n).model_copy(update={"corridor_name": corridor_name})


@router.get("/nodes", response_model=Page[NodeOut])
async def list_nodes(db: DB, params: ListParams = Depends(), f: service.NodeFilters = Depends(node_filters),
                     _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.node_query(f), params.sort, NODE_SORTS, Node.name.asc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[NodeOut](items=[_node_out(n, c) for n, c in rows], total=total, page=params.page, page_size=params.page_size)


async def _node_detail(db: DB, node_id: uuid.UUID) -> NodeOut:
    row = (await db.execute(service.node_query(service.NodeFilters()).where(Node.id == node_id))).first()
    if not row:
        raise HTTPException(404, "Node not found")
    return _node_out(*row)


@router.post("/nodes", response_model=NodeOut, status_code=201)
async def create_node(body: NodeIn, db: DB, user: CurrentUser = Depends(CREATE)):
    if body.corridor_id:
        await service.get_obj(db, Corridor, body.corridor_id, "Corridor")
    n = await service.create_record(db, Node, body.model_dump(), user, "node")
    return await _node_detail(db, n.id)


@router.get("/nodes/{node_id}", response_model=NodeOut)
async def get_node(node_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await _node_detail(db, node_id)


@router.patch("/nodes/{node_id}", response_model=NodeOut)
async def update_node(node_id: uuid.UUID, body: NodeUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    n = await service.get_obj(db, Node, node_id, "Node")
    if body.corridor_id:
        await service.get_obj(db, Corridor, body.corridor_id, "Corridor")
    values = _clean(body.model_dump(exclude_unset=True), "name", "approach_traffic", "quadrants")
    await service.update_record(db, n, values, user, "node")
    return await _node_detail(db, node_id)


@router.delete("/nodes/{node_id}", status_code=204)
async def archive_node(node_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_record(db, await service.get_obj(db, Node, node_id, "Node"), user, "node")


# ============================================================================= traffic counts

TRAFFIC_SORTS = {"count": TrafficCount.count, "count_year": TrafficCount.count_year, "segment": TrafficCount.segment,
                 "source": TrafficCount.source, "observed_on": TrafficCount.observed_on,
                 "updated_at": TrafficCount.updated_at}


def traffic_filters(
    q: str | None = Query(None, max_length=200), corridor_id: uuid.UUID | None = None, node_id: uuid.UUID | None = None,
    min_year: int | None = None, max_year: int | None = None, min_count: int | None = None,
    max_count: int | None = None, source: str | None = None,
) -> service.TrafficFilters:
    return service.TrafficFilters(**locals())


@router.get("/traffic-counts", response_model=Page[TrafficCountOut])
async def list_traffic(db: DB, params: ListParams = Depends(), f: service.TrafficFilters = Depends(traffic_filters),
                       _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.traffic_query(f), params.sort, TRAFFIC_SORTS, TrafficCount.count_year.desc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[TrafficCountOut](items=[service.traffic_row(*r) for r in rows], total=total, page=params.page, page_size=params.page_size)


@router.get("/traffic-counts/trend", response_model=list[TrafficTrendPoint])
async def traffic_trend(db: DB, corridor_id: uuid.UUID | None = None, node_id: uuid.UUID | None = None,
                        segment: str | None = None, approach: str | None = None, _: CurrentUser = Depends(VIEW)):
    rows = await service.traffic_trend(db, corridor_id=corridor_id, node_id=node_id, segment=segment, approach=approach)
    return [TrafficTrendPoint(count_year=r.count_year, count=r.count, source=r.source, segment=r.segment,
                              approach=r.approach) for r in rows]


async def _traffic_detail(db: DB, tid: uuid.UUID) -> TrafficCountOut:
    row = (await db.execute(service.traffic_query(service.TrafficFilters()).where(TrafficCount.id == tid))).first()
    if not row:
        raise HTTPException(404, "Traffic count not found")
    return service.traffic_row(*row)


async def _check_traffic_links(db: DB, corridor_id: uuid.UUID | None, node_id: uuid.UUID | None) -> None:
    if corridor_id:
        await service.get_obj(db, Corridor, corridor_id, "Corridor")
    if node_id:
        await service.get_obj(db, Node, node_id, "Node")


@router.post("/traffic-counts", response_model=TrafficCountOut, status_code=201)
async def create_traffic(body: TrafficCountIn, db: DB, user: CurrentUser = Depends(CREATE)):
    await _check_traffic_links(db, body.corridor_id, body.node_id)
    t = await service.create_record(db, TrafficCount, body.model_dump(), user, "traffic_count",
                                    summary=f"{body.count:,} ({body.count_year}) — {body.segment or body.approach or ''}")
    return await _traffic_detail(db, t.id)


@router.get("/traffic-counts/{count_id}", response_model=TrafficCountOut)
async def get_traffic(count_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await _traffic_detail(db, count_id)


@router.patch("/traffic-counts/{count_id}", response_model=TrafficCountOut)
async def update_traffic(count_id: uuid.UUID, body: TrafficCountUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    t = await service.get_obj(db, TrafficCount, count_id, "Traffic count")
    await _check_traffic_links(db, body.corridor_id, body.node_id)
    values = _clean(body.model_dump(exclude_unset=True), "count", "count_year", "count_type", "source")
    await service.update_record(db, t, values, user, "traffic_count")
    return await _traffic_detail(db, count_id)


@router.delete("/traffic-counts/{count_id}", status_code=204)
async def archive_traffic(count_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_record(db, await service.get_obj(db, TrafficCount, count_id, "Traffic count"), user,
                                 "traffic_count")


# ============================================================================= trade areas

def _trade_out(t: TradeArea, node_name: str | None, property_label: str | None) -> TradeAreaOut:
    return TradeAreaOut.model_validate(t).model_copy(update={"node_name": node_name, "property_label": property_label})


async def _trade_detail(db: DB, tid: uuid.UUID) -> TradeAreaOut:
    row = (await db.execute(service.trade_area_query(None, None, None, None).where(TradeArea.id == tid))).first()
    if not row:
        raise HTTPException(404, "Trade area not found")
    out = _trade_out(*row)
    out.geojson = await service.geojson_of(db, TradeArea.geometry, TradeArea.id, tid)
    return out


async def _check_trade_links(db: DB, node_id: uuid.UUID | None, property_id: uuid.UUID | None) -> None:
    if node_id:
        await service.get_obj(db, Node, node_id, "Node")
    if property_id:
        from app.modules.properties import service as property_service

        await property_service.get(db, property_id)


@router.get("/trade-areas", response_model=Page[TradeAreaOut])
async def list_trade_areas(db: DB, params: ListParams = Depends(), node_id: uuid.UUID | None = None,
                           property_id: uuid.UUID | None = None, minutes: list[int] | None = Query(None),
                           _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.trade_area_query(node_id, property_id, minutes, params.q), params.sort,
                      {"minutes": TradeArea.minutes, "observed_on": TradeArea.observed_on,
                       "updated_at": TradeArea.updated_at}, TradeArea.updated_at.desc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[TradeAreaOut](items=[_trade_out(*r) for r in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/trade-areas", response_model=TradeAreaOut, status_code=201)
async def create_trade_area(body: TradeAreaIn, db: DB, user: CurrentUser = Depends(CREATE)):
    if not body.node_id and not body.property_id:
        raise HTTPException(422, "Link the trade area to a node or a property")
    await _check_trade_links(db, body.node_id, body.property_id)
    t = await service.create_record(db, TradeArea, body.model_dump(exclude={"geometry"}), user, "trade_area",
                                    geometry=body.geometry, kind="polygon",
                                    summary=body.name or f"{body.minutes}-minute drive time")
    return await _trade_detail(db, t.id)


@router.get("/trade-areas/{trade_area_id}", response_model=TradeAreaOut)
async def get_trade_area(trade_area_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await _trade_detail(db, trade_area_id)


@router.patch("/trade-areas/{trade_area_id}", response_model=TradeAreaOut)
async def update_trade_area(trade_area_id: uuid.UUID, body: TradeAreaUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    t = await service.get_obj(db, TradeArea, trade_area_id, "Trade area")
    await _check_trade_links(db, body.node_id, body.property_id)
    values = _clean(body.model_dump(exclude_unset=True, exclude={"geometry"}), "minutes", "source", "demographics",
                    "competitors", "anchors")
    await service.update_record(db, t, values, user, "trade_area",
                                geometry=body.geometry, kind="polygon")
    return await _trade_detail(db, trade_area_id)


@router.delete("/trade-areas/{trade_area_id}", status_code=204)
async def archive_trade_area(trade_area_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_record(db, await service.get_obj(db, TradeArea, trade_area_id, "Trade area"), user,
                                 "trade_area")


# ============================================================================= growth context

GROWTH_SORTS = {"name": GrowthRecord.name, "kind": GrowthRecord.kind, "event_date": GrowthRecord.event_date,
                "units": GrowthRecord.units, "value": GrowthRecord.value, "observed_on": GrowthRecord.observed_on,
                "updated_at": GrowthRecord.updated_at}


def growth_filters(
    q: str | None = Query(None, max_length=200), kind: list[str] | None = Query(None), county: str | None = None,
    city: str | None = None, from_date: date | None = None, to_date: date | None = None,
    near_lat: float | None = Query(None, ge=-90, le=90), near_lng: float | None = Query(None, ge=-180, le=180),
    property_id: uuid.UUID | None = None, node_id: uuid.UUID | None = None,
    radius_miles: float | None = Query(None, gt=0, le=100),
) -> service.GrowthFilters:
    return service.GrowthFilters(**locals())


def _growth_out(g: GrowthRecord, distance: float | None) -> GrowthOut:
    return GrowthOut.model_validate(g).model_copy(
        update={"distance_miles": round(float(distance), 2) if distance is not None else None})


@router.get("/growth-records", response_model=Page[GrowthOut])
async def list_growth(db: DB, params: ListParams = Depends(), f: service.GrowthFilters = Depends(growth_filters),
                      _: CurrentUser = Depends(VIEW)):
    sorts = dict(GROWTH_SORTS)
    stmt = await service.growth_query(db, f)
    if params.sort and params.sort.lstrip("-") == "distance_miles":
        sorts["distance_miles"] = literal_column("distance_miles")
    stmt = apply_sort(stmt, params.sort, sorts, GrowthRecord.event_date.desc().nulls_last())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[GrowthOut](items=[_growth_out(*r) for r in rows], total=total, page=params.page, page_size=params.page_size)


@router.get("/growth-records/facets", response_model=GrowthFacets)
async def growth_facets(db: DB, f: service.GrowthFilters = Depends(growth_filters), _: CurrentUser = Depends(VIEW)):
    stmt = (await service.growth_query(db, f, skip={"kind"})).with_only_columns(GrowthRecord.kind)
    return GrowthFacets(kind=await facet_counts(db, stmt, GrowthRecord.kind))


@router.post("/growth-records", response_model=GrowthOut, status_code=201)
async def create_growth(body: GrowthIn, db: DB, user: CurrentUser = Depends(CREATE)):
    g = await service.create_record(db, GrowthRecord, body.model_dump(), user, "growth_record")
    return _growth_out(g, None)


@router.get("/growth-records/{record_id}", response_model=GrowthOut)
async def get_growth(record_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return _growth_out(await service.get_obj(db, GrowthRecord, record_id, "Growth record"), None)


@router.patch("/growth-records/{record_id}", response_model=GrowthOut)
async def update_growth(record_id: uuid.UUID, body: GrowthUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    g = await service.get_obj(db, GrowthRecord, record_id, "Growth record")
    g = await service.update_record(db, g, _clean(body.model_dump(exclude_unset=True), "kind", "name", "latitude", "longitude", "source"),
                                    user, "growth_record")
    return _growth_out(g, None)


@router.delete("/growth-records/{record_id}", status_code=204)
async def archive_growth(record_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_record(db, await service.get_obj(db, GrowthRecord, record_id, "Growth record"), user,
                                 "growth_record")


# ============================================================================= geography-driven property search

def geo_property_filters(
    q: str | None = Query(None, max_length=200), corridor_id: uuid.UUID | None = None,
    buffer_ft: float | None = Query(None, gt=0, le=26_400), node_id: uuid.UUID | None = None,
    radius_miles: float | None = Query(None, gt=0, le=100), min_traffic: int | None = Query(None, ge=0),
    traffic_radius_miles: float | None = Query(None, gt=0, le=10), growth_kind: list[str] | None = Query(None),
    growth_radius_miles: float | None = Query(None, gt=0, le=50), territory_id: uuid.UUID | None = None,
) -> service.GeoPropertyFilters:
    return service.GeoPropertyFilters(**locals())


@router.get("/geography/properties", response_model=Page[PropertyRef])
async def geography_properties(db: DB, params: ListParams = Depends(),
                               f: service.GeoPropertyFilters = Depends(geo_property_filters),
                               user: CurrentUser = Depends(VIEW)):
    """Query properties by corridor buffer, node radius, traffic and growth conditions."""
    if not user.can("properties", "view"):
        raise HTTPException(403, "Missing permission properties:view")
    if f.territory_id:
        await service.get_visible(db, f.territory_id, user)
    stmt = await service.geo_property_query(db, f)
    stmt = apply_sort(stmt, params.sort, {"distance_miles": literal_column("distance_miles")},
                      literal_column("distance_miles").asc().nulls_last())
    rows, total = await paginate(db, stmt, params, scalars=False)
    items = [PropertyRef(**{**r._mapping, "distance_miles": round(float(r.distance_miles), 2)
                            if r.distance_miles is not None else None}) for r in rows]
    return Page[PropertyRef](items=items, total=total, page=params.page, page_size=params.page_size)


# ============================================================================= territories

TERRITORY_SORTS = {"name": Territory.name, "rule_type": Territory.rule_type, "visibility": Territory.visibility,
                   "member_count": Territory.member_count, "updated_at": Territory.updated_at,
                   "last_computed_at": Territory.last_computed_at}


def territory_filters(
    q: str | None = Query(None, max_length=200), rule_type: list[str] | None = Query(None),
    visibility: list[str] | None = Query(None), parent_id: uuid.UUID | None = None, top_level: bool | None = None,
    mine: bool | None = None,
) -> service.TerritoryFilters:
    return service.TerritoryFilters(**locals())


@router.get("/territories", response_model=Page[TerritoryListItem])
async def list_territories(db: DB, params: ListParams = Depends(), f: service.TerritoryFilters = Depends(territory_filters),
                           user: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.territory_query(f, user), params.sort, TERRITORY_SORTS, Territory.name.asc())
    items, total = await paginate(db, stmt, params)
    return Page[TerritoryListItem](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/territories/facets", response_model=TerritoryFacets)
async def territory_facets(db: DB, f: service.TerritoryFilters = Depends(territory_filters),
                           user: CurrentUser = Depends(VIEW)):
    return TerritoryFacets(
        rule_type=await facet_counts(db, service.territory_query(f, user, skip={"rule_type"}), Territory.rule_type),
        visibility=await facet_counts(db, service.territory_query(f, user, skip={"visibility"}), Territory.visibility),
    )


@router.get("/territories/options", response_model=list[TerritoryListItem])
async def territory_options(db: DB, user: CurrentUser = Depends(VIEW)):
    return list(await db.scalars(service.territory_query(service.TerritoryFilters(), user).order_by(Territory.name)
                                 .limit(500)))


@router.get("/territories/for-property/{property_id}", response_model=list[TerritoryListItem])
async def territories_for_property(property_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.for_property(db, property_id, user)


@router.post("/territories", response_model=TerritoryOut, status_code=201)
async def create_territory(body: TerritoryIn, db: DB, user: CurrentUser = Depends(CREATE)):
    t = await service.create_territory(db, body, user)
    return await service.territory_out(db, t, user)


@router.get("/territories/{territory_id}", response_model=TerritoryOut)
async def get_territory(territory_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.territory_out(db, await service.get_visible(db, territory_id, user), user)


@router.patch("/territories/{territory_id}", response_model=TerritoryOut)
async def update_territory(territory_id: uuid.UUID, body: TerritoryUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    t = await service.get_visible(db, territory_id, user)
    service.require_edit(t, user)
    t = await service.update_territory(db, t, body, user)
    return await service.territory_out(db, t, user)


@router.delete("/territories/{territory_id}", status_code=204)
async def archive_territory(territory_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    t = await service.get_visible(db, territory_id, user)
    service.require_edit(t, user)
    await service.archive_territory(db, t, user)


@router.post("/territories/{territory_id}/recompute", response_model=RecomputeOut)
async def recompute_territory(territory_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    t = await service.get_visible(db, territory_id, user)
    return await service.recompute_and_commit(db, t, user)


@router.get("/territories/{territory_id}/geojson")
async def territory_geojson(territory_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    t = await service.get_visible(db, territory_id, user)
    return {"type": "Feature", "id": str(t.id),
            "geometry": await service.geojson_of(db, Territory.geometry, Territory.id, t.id),
            "properties": {"id": str(t.id), "name": t.name, "rule_type": t.rule_type, "member_count": t.member_count}}


@router.get("/territories/{territory_id}/members", response_model=Page[MemberOut])
async def territory_members(territory_id: uuid.UUID, db: DB, params: ListParams = Depends(),
                            source: list[str] | None = Query(None), user: CurrentUser = Depends(VIEW)):
    await service.get_visible(db, territory_id, user)
    from app.modules.properties.models import Property
    from app.modules.territories.models import TerritoryMember

    stmt = apply_sort(service.members_query(territory_id, params.q, source), params.sort,
                      {"address_line": Property.address_line, "city": Property.city, "status": Property.status,
                       "added_at": TerritoryMember.added_at, "source": TerritoryMember.source},
                      Property.address_line.asc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return Page[MemberOut](items=[MemberOut(**r._mapping) for r in rows], total=total, page=params.page, page_size=params.page_size)


@router.post("/territories/{territory_id}/members")
async def add_territory_members(territory_id: uuid.UUID, body: MembersIn, db: DB, user: CurrentUser = Depends(EDIT)):
    t = await service.get_visible(db, territory_id, user)
    service.require_edit(t, user)
    return {"added": await service.add_members(db, t, body, user)}


@router.delete("/territories/{territory_id}/members/{property_id}", status_code=204)
async def remove_territory_member(territory_id: uuid.UUID, property_id: uuid.UUID, db: DB,
                                  user: CurrentUser = Depends(EDIT)):
    t = await service.get_visible(db, territory_id, user)
    service.require_edit(t, user)
    await service.remove_member(db, t, property_id, user)


@router.get("/territories/{territory_id}/overlaps", response_model=list[OverlapOut])
async def territory_overlaps(territory_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.overlaps(db, await service.get_visible(db, territory_id, user), user)

