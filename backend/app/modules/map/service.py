"""Map workspace (spec module 7): layered GeoJSON over existing records, spatial filters, map selection with
previewed bulk actions, drawn territories, record cards and offline field observations.

PostGIS is authoritative for geometry; every spatial predicate runs in the database. Other modules' tables are
read with lazy imports, and each layer is only returned when the user may view that module.
"""
import csv
import io
import json
import os
import string
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException, status
from geoalchemy2 import Geography
from sqlalchemy import Select, cast, false, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.common import audit
from app.common.query import facet_counts, in_filter
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.map.models import OBSERVATION_CATEGORIES, MapFieldObservation
from app.modules.map.schemas import (
    BulkExportIn,
    BulkOpportunitiesIn,
    BulkResult,
    BulkSequenceIn,
    BulkTarget,
    BulkTerritoryIn,
    CardOut,
    CardOwner,
    CardSignal,
    ExportOut,
    LayersOut,
    ObservationIn,
    ObservationOut,
    SaveTerritoryIn,
    SelectedParcel,
    SelectedProperty,
    SelectIn,
    SelectOut,
    SkipItem,
)
from app.modules.parcels import geo

# layer key -> (permission module, label)
LAYERS: dict[str, tuple[str, str]] = {
    "properties": ("properties", "Properties"),
    "parcels": ("parcels", "Parcels"),
    "opportunities": ("pipeline", "Opportunities"),
    "assets": ("assets", "Assets"),
    "listings": ("brokerage", "Listings"),
    "comps": ("comps", "Sale comps"),
    "territories": ("territories", "Territories"),
    "signals": ("signals", "Signals"),
    "observations": ("map", "Field observations"),
}
LAYER_LIMIT = 1500
SELECT_LIMIT = 2000
ADJACENCY_TOLERANCE_M = 1.0
NEAREST_PROPERTY_M = 75.0
DEFAULT_BUFFER_FT = 500.0
OPEN_EXCLUDED_STAGES = ("closed", "dead")

# Third-party viewers are convenience links only (never a geometry source). Override with MAP_PARCEL_VIEWERS,
# a JSON list of {"label", "url_template"}; placeholders: {lat} {lng} {apn} {county} {state} {address}.
DEFAULT_VIEWERS = [
    {"label": "Google Maps", "url_template": "https://www.google.com/maps/search/?api=1&query={lat},{lng}"},
    {"label": "Street View", "url_template": "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lng}"},
]


def _422(msg: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, msg)


def _need(user: CurrentUser, module: str, action: str) -> None:
    if not user.can(module, action):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing permission {module}:{action}")


def _detail(detail: Any) -> str:
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    return str(detail)


def _label(name: str | None, address: str | None) -> str:
    return name or address or "Untitled"


# ============================================================================= config


def viewer_templates() -> list[dict[str, str]]:
    raw = os.environ.get("MAP_PARCEL_VIEWERS")
    if raw:
        try:
            items = json.loads(raw)
            out = [{"label": str(i["label"]), "url_template": str(i["url_template"])} for i in items
                   if isinstance(i, dict) and i.get("label") and str(i.get("url_template", "")).startswith("https://")]
            if out:
                return out
        except (ValueError, KeyError, TypeError):
            pass
    return DEFAULT_VIEWERS


def viewer_links(values: dict[str, Any]) -> list[dict[str, str]]:
    links = []
    for t in viewer_templates():
        names = {f for _, f, _, _ in string.Formatter().parse(t["url_template"]) if f}
        if any(values.get(n) in (None, "") for n in names):
            continue
        try:
            url = t["url_template"].format(**{n: quote(str(values[n]), safe="") for n in names})
        except (KeyError, IndexError, ValueError):
            continue
        links.append({"label": t["label"], "url": url})
    return links


def map_config(user: CurrentUser) -> dict:
    return {
        "layers": [{"key": k, "label": label, "module": mod, "allowed": user.can(mod, "view")}
                   for k, (mod, label) in LAYERS.items()],
        "viewers": viewer_templates(),
        "observation_categories": OBSERVATION_CATEGORIES,
    }


# ============================================================================= spatial filters


@dataclass
class MapFilters:
    bbox: str | None = None
    status: list[str] | None = None
    property_type: list[str] | None = None
    stage: list[str] | None = None
    signal_category: list[str] | None = None
    near_lat: float | None = None
    near_lng: float | None = None
    radius_miles: float | None = None
    polygon: str | None = None
    corridor_id: uuid.UUID | None = None
    buffer_ft: float | None = None
    adjacent_to: uuid.UUID | None = None


@dataclass
class Spatial:
    envelope: Any = None
    polygon: Any = None
    center: Any = None
    radius_m: float = 0.0
    corridor: Any = None
    buffer_m: float = 0.0
    adjacent: list[uuid.UUID] | None = None  # parcel ids touching the target parcel

    @property
    def has_region(self) -> bool:
        return self.polygon is not None or self.center is not None or self.corridor is not None


async def polygon_element(db: AsyncSession, raw: Any):
    """Validated (ST_MakeValid) drawn polygon as a SQL geometry expression."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raise _422("Polygon must be GeoJSON")
    poly = await geo.polygon_from_geojson(db, raw)
    return func.ST_GeomFromText(poly.wkt, 4326)


async def adjacent_parcel_ids(db: AsyncSession, parcel_id: uuid.UUID) -> list[uuid.UUID]:
    """Parcels that touch the target (ST_Touches, with a 1 m tolerance for digitising gaps)."""
    from app.modules.parcels.models import Parcel

    me = aliased(Parcel)
    stmt = (
        select(Parcel.id).select_from(Parcel).join(me, me.id == parcel_id)
        .where(Parcel.id != me.id, Parcel.deleted_at.is_(None), Parcel.has_geometry.is_(True),
               or_(func.ST_Touches(Parcel.geometry, me.geometry),
                   func.ST_DWithin(Parcel.geometry, me.geometry, ADJACENCY_TOLERANCE_M / geo.M_PER_DEGREE)))
        .limit(500)
    )
    return list(await db.scalars(stmt))


async def resolve_spatial(db: AsyncSession, f: MapFilters) -> Spatial:
    sp = Spatial()
    if f.bbox:
        sp.envelope = geo.envelope(f.bbox)
    if f.polygon:
        sp.polygon = await polygon_element(db, f.polygon)
    if f.near_lat is not None and f.near_lng is not None and f.radius_miles:
        sp.center, sp.radius_m = geo.point(f.near_lat, f.near_lng), f.radius_miles * geo.M_PER_MILE
    if f.corridor_id:
        from app.modules.territories.models import Corridor

        c = await db.get(Corridor, f.corridor_id)
        if not c or c.deleted_at:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Corridor not found")
        if not c.has_geometry:
            raise _422("This corridor has no line geometry yet")
        sp.corridor = select(Corridor.geometry).where(Corridor.id == f.corridor_id).scalar_subquery()
        sp.buffer_m = (f.buffer_ft or DEFAULT_BUFFER_FT) * geo.M_PER_FT
    if f.adjacent_to:
        sp.adjacent = await adjacent_parcel_ids(db, f.adjacent_to)
    return sp


def conditions(sp: Spatial, geom: Any, *, inside: Any = None, property_col: Any = None, parcel_col: Any = None,
               envelope: bool = True) -> list:
    """Spatial predicates for one layer. `inside` is the geometry tested against a drawn polygon
    (points themselves; parcel centroids), `property_col` / `parcel_col` drive adjacency."""
    out: list = []
    if envelope and sp.envelope is not None:
        out.append(func.ST_Intersects(geom, sp.envelope))
    if sp.polygon is not None:
        out.append(func.ST_Contains(sp.polygon, inside if inside is not None else geom))
    if sp.center is not None:
        out.append(func.ST_DWithin(cast(geom, Geography), cast(sp.center, Geography), sp.radius_m))
    if sp.corridor is not None:
        # Equivalent to ST_Intersects(geom, ST_Buffer(corridor::geography, m)) but index-friendly.
        out.append(func.ST_DWithin(cast(geom, Geography), cast(sp.corridor, Geography), sp.buffer_m))
    if sp.adjacent is not None:
        from app.modules.parcels.models import PropertyParcel

        if parcel_col is not None:
            out.append(parcel_col.in_(sp.adjacent))
        elif property_col is not None:
            out.append(property_col.in_(
                select(PropertyParcel.property_id).where(PropertyParcel.parcel_id.in_(sp.adjacent))))
        else:
            out.append(false())
    return out


# ============================================================================= layers


def _point(fid: Any, lng: Any, lat: Any, props: dict) -> dict:
    return {
        "type": "Feature", "id": str(fid),
        "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
        "properties": audit.to_jsonable({"id": fid, **props}),
    }


def _shape(fid: Any, gj: str | None, props: dict) -> dict:
    return {"type": "Feature", "id": str(fid), "geometry": geo.loads(gj),
            "properties": audit.to_jsonable({"id": fid, **props})}


def _collection(features: list[dict]) -> dict:
    truncated = len(features) > LAYER_LIMIT
    features = features[:LAYER_LIMIT]
    return {"type": "FeatureCollection", "features": features, "truncated": truncated, "count": len(features)}


async def _properties_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.properties.models import Property as P

    stmt = (
        select(P.id, P.name, P.address_line, P.city, P.state, P.status, P.property_type, P.asking_price,
               func.ST_X(P.location), func.ST_Y(P.location))
        .where(P.deleted_at.is_(None), P.location.isnot(None), *conditions(sp, P.location, property_col=P.id))
    )
    stmt = in_filter(in_filter(stmt, P.status, f.status), P.property_type, f.property_type)
    rows = (await db.execute(stmt.limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _point(pid, x, y, {"kind": "property", "property_id": pid, "label": _label(name, addr), "address": addr,
                           "city": city, "state": st, "status": s, "property_type": pt, "asking_price": price})
        for pid, name, addr, city, st, s, pt, price, x, y in rows
    ])


async def _parcels_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.parcels.models import Parcel, PropertyParcel

    linked = select(func.count(PropertyParcel.id)).where(PropertyParcel.parcel_id == Parcel.id).correlate(Parcel).scalar_subquery()
    stmt = (
        select(Parcel.id, Parcel.apn, Parcel.county, Parcel.acreage, Parcel.situs_address, linked,
               func.ST_AsGeoJSON(Parcel.geometry, 6))
        .where(Parcel.deleted_at.is_(None), Parcel.has_geometry.is_(True),
               *conditions(sp, Parcel.geometry, inside=Parcel.centroid, parcel_col=Parcel.id))
    )
    rows = (await db.execute(stmt.limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _shape(pid, gj, {"kind": "parcel", "parcel_id": pid, "label": f"APN {apn}", "apn": apn, "county": county,
                         "acreage": acres, "address": situs, "status": "linked" if n else "unlinked"})
        for pid, apn, county, acres, situs, n, gj in rows
    ])


async def _opportunities_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.pipeline.models import Opportunity as O
    from app.modules.properties.models import Property as P

    stmt = (
        select(O.id, O.title, O.stage, O.priority, O.property_id, func.ST_X(P.location), func.ST_Y(P.location))
        .join(P, P.id == O.property_id)
        .where(O.deleted_at.is_(None), P.deleted_at.is_(None), P.location.isnot(None),
               *conditions(sp, P.location, property_col=P.id))
    )
    stmt = in_filter(in_filter(stmt, O.stage, f.stage), P.property_type, f.property_type)
    rows = (await db.execute(stmt.limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _point(oid, x, y, {"kind": "opportunity", "property_id": pid, "label": title, "status": stage,
                           "priority": prio})
        for oid, title, stage, prio, pid, x, y in rows
    ])


async def _assets_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.assets.models import Asset as A
    from app.modules.properties.models import Property as P

    stmt = (
        select(A.id, A.status, A.current_value, A.property_id, P.name, P.address_line,
               func.ST_X(P.location), func.ST_Y(P.location))
        .join(P, P.id == A.property_id)
        .where(A.deleted_at.is_(None), P.deleted_at.is_(None), P.location.isnot(None),
               *conditions(sp, P.location, property_col=P.id))
    )
    stmt = in_filter(stmt, P.property_type, f.property_type)
    rows = (await db.execute(stmt.limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _point(aid, x, y, {"kind": "asset", "property_id": pid, "label": _label(name, addr), "status": s,
                           "current_value": value})
        for aid, s, value, pid, name, addr, x, y in rows
    ])


async def _listings_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.brokerage.models import Listing as L
    from app.modules.properties.models import Property as P

    stmt = (
        select(L.id, L.status, L.listing_type, L.asking_price, L.property_id, L.headline, P.name, P.address_line,
               func.ST_X(P.location), func.ST_Y(P.location))
        .join(P, P.id == L.property_id)
        .where(L.deleted_at.is_(None), P.deleted_at.is_(None), P.location.isnot(None),
               *conditions(sp, P.location, property_col=P.id))
    )
    stmt = in_filter(stmt, P.property_type, f.property_type)
    rows = (await db.execute(stmt.limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _point(lid, x, y, {"kind": "listing", "property_id": pid, "label": headline or _label(name, addr),
                           "status": s, "listing_type": lt, "asking_price": price})
        for lid, s, lt, price, pid, headline, name, addr, x, y in rows
    ])


async def _comps_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.comps.models import SaleComp as C

    stmt = (
        select(C.id, C.name, C.address_line, C.verification_status, C.sale_price, C.sale_date, C.property_type,
               C.property_id, func.ST_X(C.location), func.ST_Y(C.location))
        .where(C.deleted_at.is_(None), C.location.isnot(None), *conditions(sp, C.location, property_col=C.property_id))
    )
    stmt = in_filter(stmt, C.property_type, f.property_type)
    rows = (await db.execute(stmt.limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _point(cid, x, y, {"kind": "comp", "property_id": pid, "label": _label(name, addr), "status": vs,
                           "sale_price": price, "sale_date": sold, "property_type": pt})
        for cid, name, addr, vs, price, sold, pt, pid, x, y in rows
    ])


async def _territories_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.territories.models import Territory as T
    from app.modules.territories.service import visible_clause

    stmt = (
        select(T.id, T.name, T.rule_type, T.visibility, T.member_count, func.ST_AsGeoJSON(T.geometry, 6))
        .where(T.deleted_at.is_(None), T.has_geometry.is_(True), visible_clause(user))
    )
    if sp.envelope is not None:
        stmt = stmt.where(func.ST_Intersects(T.geometry, sp.envelope))
    rows = (await db.execute(stmt.limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _shape(tid, gj, {"kind": "territory", "label": name, "status": rt, "visibility": vis, "member_count": n})
        for tid, name, rt, vis, n, gj in rows
    ])


async def _signals_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    from app.modules.properties.models import Property as P
    from app.modules.signals.models import Signal as S

    stmt = (
        select(S.id, S.category, S.signal_type, S.title, S.severity, S.observed_on, S.property_id,
               func.ST_X(P.location), func.ST_Y(P.location))
        .join(P, P.id == S.property_id)
        .where(S.deleted_at.is_(None), S.status == "active", P.deleted_at.is_(None), P.location.isnot(None),
               *conditions(sp, P.location, property_col=P.id))
    )
    if not user.can("signals", "view_sensitive"):
        stmt = stmt.where(S.is_sensitive.is_(False))
    stmt = in_filter(in_filter(stmt, S.category, f.signal_category), P.property_type, f.property_type)
    rows = (await db.execute(stmt.order_by(S.severity.desc()).limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _point(sid, x, y, {"kind": "signal", "property_id": pid, "label": title or signal_type.replace("_", " "),
                           "status": cat, "category": cat, "signal_type": signal_type, "severity": sev,
                           "observed_on": seen})
        for sid, cat, signal_type, title, sev, seen, pid, x, y in rows
    ])


async def _observations_layer(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict:
    M = MapFieldObservation
    stmt = (
        select(M.id, M.category, M.note, M.observed_at, M.property_id, M.longitude, M.latitude)
        .where(M.deleted_at.is_(None), M.location.isnot(None), *conditions(sp, M.location, property_col=M.property_id))
    )
    rows = (await db.execute(stmt.order_by(M.observed_at.desc()).limit(LAYER_LIMIT + 1))).all()
    return _collection([
        _point(oid, x, y, {"kind": "observation", "property_id": pid, "label": (note or cat)[:80], "status": cat,
                           "observed_at": at})
        for oid, cat, note, at, pid, x, y in rows
    ])


LAYER_BUILDERS = {
    "properties": _properties_layer, "parcels": _parcels_layer, "opportunities": _opportunities_layer,
    "assets": _assets_layer, "listings": _listings_layer, "comps": _comps_layer,
    "territories": _territories_layer, "signals": _signals_layer, "observations": _observations_layer,
}


async def _facets(db: AsyncSession, f: MapFilters, sp: Spatial, user: CurrentUser) -> dict[str, dict[str, int]]:
    from app.modules.properties.models import Property as P

    out: dict[str, dict[str, int]] = {}
    if user.can("properties", "view"):
        base = select(P.id, P.status, P.property_type).where(
            P.deleted_at.is_(None), P.location.isnot(None), *conditions(sp, P.location, property_col=P.id))
        out["status"] = await facet_counts(db, in_filter(base, P.property_type, f.property_type), P.status)
        out["property_type"] = await facet_counts(db, in_filter(base, P.status, f.status), P.property_type)
    if user.can("pipeline", "view"):
        try:
            from app.modules.pipeline.models import Opportunity as O
        except ImportError:
            return out
        base = (select(O.id, O.stage).join(P, P.id == O.property_id)
                .where(O.deleted_at.is_(None), P.deleted_at.is_(None), P.location.isnot(None),
                       *conditions(sp, P.location, property_col=P.id)))
        out["stage"] = await facet_counts(db, in_filter(base, P.property_type, f.property_type), O.stage)
    return out


async def layers(db: AsyncSession, f: MapFilters, requested: list[str], user: CurrentUser) -> LayersOut:
    if not f.bbox and not f.polygon and f.near_lat is None and not f.corridor_id and not f.adjacent_to:
        raise _422("Provide a bbox or a spatial filter")
    sp = await resolve_spatial(db, f)
    out: dict[str, dict] = {}
    hidden: list[str] = []
    for key in requested:
        if key not in LAYERS:
            continue
        module, _ = LAYERS[key]
        if not user.can(module, "view"):
            hidden.append(key)
            continue
        try:
            out[key] = await LAYER_BUILDERS[key](db, f, sp, user)
        except ImportError:
            hidden.append(key)
    return LayersOut(layers=out, hidden=hidden, facets=await _facets(db, f, sp, user))


# ============================================================================= selection


async def _parcel_links(db: AsyncSession, parcel_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[uuid.UUID]]:
    from app.modules.parcels.models import PropertyParcel

    if not parcel_ids:
        return {}
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    rows = await db.execute(select(PropertyParcel.parcel_id, PropertyParcel.property_id).where(
        PropertyParcel.parcel_id.in_(parcel_ids), PropertyParcel.deleted_at.is_(None)))
    for parcel_id, property_id in rows.all():
        out.setdefault(parcel_id, []).append(property_id)
    return out


async def _open_stages(db: AsyncSession, property_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    try:
        from app.modules.pipeline.models import Opportunity as O
    except ImportError:
        return {}
    if not property_ids:
        return {}
    rows = await db.execute(select(O.property_id, O.stage).where(
        O.property_id.in_(property_ids), O.deleted_at.is_(None), O.stage.notin_(OPEN_EXCLUDED_STAGES)))
    return {pid: stage for pid, stage in rows.all()}


async def select_records(db: AsyncSession, data: SelectIn, user: CurrentUser) -> SelectOut:
    from app.modules.parcels.models import Parcel
    from app.modules.properties.models import Property as P

    sp = Spatial()
    if data.polygon:
        sp.polygon = await polygon_element(db, data.polygon)
    if data.circle:
        sp.center, sp.radius_m = geo.point(data.circle.lat, data.circle.lng), data.circle.radius_m
    if not sp.has_region and not data.property_ids and not data.parcel_ids:
        raise _422("Draw a shape or pick records to select")

    property_ids: set[uuid.UUID] = set(data.property_ids)
    truncated = False
    if sp.has_region:
        found = list(await db.scalars(select(P.id).where(
            P.deleted_at.is_(None), P.location.isnot(None), *conditions(sp, P.location)).limit(SELECT_LIMIT + 1)))
        truncated = len(found) > SELECT_LIMIT
        property_ids |= set(found[:SELECT_LIMIT])

    parcels: list[SelectedParcel] = []
    parcels_hidden = not user.can("parcels", "view")
    if not parcels_hidden:
        parcel_ids: set[uuid.UUID] = set(data.parcel_ids)
        if sp.has_region:
            found = list(await db.scalars(select(Parcel.id).where(
                Parcel.deleted_at.is_(None), Parcel.has_geometry.is_(True),
                *conditions(sp, Parcel.geometry, inside=Parcel.centroid)).limit(SELECT_LIMIT + 1)))
            truncated = truncated or len(found) > SELECT_LIMIT
            parcel_ids |= set(found[:SELECT_LIMIT])
        links = await _parcel_links(db, list(parcel_ids))
        if parcel_ids:
            rows = await db.execute(select(Parcel.id, Parcel.apn, Parcel.county, Parcel.acreage, Parcel.situs_address)
                                    .where(Parcel.id.in_(parcel_ids), Parcel.deleted_at.is_(None)).order_by(Parcel.apn))
            parcels = [SelectedParcel(id=i, apn=apn, county=county, acreage=acres, situs_address=situs,
                                      property_ids=links.get(i, []))
                       for i, apn, county, acres, situs in rows.all()]
        for ids in links.values():
            property_ids |= set(ids)

    props: list[SelectedProperty] = []
    if property_ids:
        rows = await db.execute(
            select(P.id, P.name, P.address_line, P.city, P.state, P.status, P.property_type)
            .where(P.id.in_(list(property_ids)[: SELECT_LIMIT * 2]), P.deleted_at.is_(None))
            .order_by(P.address_line)
        )
        all_rows = rows.all()
        stages = await _open_stages(db, [r[0] for r in all_rows]) if user.can("pipeline", "view") else {}
        props = [SelectedProperty(id=i, label=_label(name, addr), address_line=addr, city=city, state=st, status=s,
                                  property_type=pt, opportunity_stage=stages.get(i))
                 for i, name, addr, city, st, s, pt in all_rows]
    return SelectOut(properties=props, parcels=parcels, truncated=truncated, parcels_hidden=parcels_hidden)


async def resolve_properties(db: AsyncSession, target: BulkTarget, user: CurrentUser) -> dict[uuid.UUID, str]:
    """Properties in scope for a bulk action: explicit ids plus properties linked to the selected parcels."""
    from app.modules.properties.models import Property as P

    ids = set(target.property_ids)
    if target.parcel_ids:
        _need(user, "parcels", "view")
        for linked in (await _parcel_links(db, target.parcel_ids)).values():
            ids |= set(linked)
    if not ids:
        raise _422("The selection has no properties (parcels may not be linked to properties yet)")
    rows = await db.execute(select(P.id, P.name, P.address_line).where(P.id.in_(ids), P.deleted_at.is_(None))
                            .order_by(P.address_line).limit(SELECT_LIMIT))
    return {i: _label(name, addr) for i, name, addr in rows.all()}


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


# ============================================================================= bulk: opportunities


async def bulk_opportunities(db: AsyncSession, data: BulkOpportunitiesIn, user: CurrentUser) -> BulkResult:
    from app.modules.pipeline import service as pipeline
    from app.modules.pipeline.models import Opportunity as O
    from app.modules.pipeline.schemas import OpportunityCreate

    props = await resolve_properties(db, data, user)
    existing = set(await db.scalars(select(O.property_id).where(
        O.property_id.in_(list(props)), O.deleted_at.is_(None), O.stage != "closed")))
    skipped = [SkipItem(id=str(i), label=props[i], reason="Already has an open opportunity") for i in props if i in existing]
    eligible = [i for i in props if i not in existing]
    warnings = []
    if data.override_reason and not user.can("pipeline", "approve"):
        warnings.append("Overriding stage requirements requires pipeline approval permission")
    result = BulkResult(action="create_opportunities", applied=data.apply, properties=len(props),
                        eligible=len(eligible), skipped=skipped, warnings=warnings,
                        details={"gate": "Each opportunity must meet the sourced-stage requirements"})
    if not data.apply:
        return result
    if warnings:
        raise HTTPException(status.HTTP_403_FORBIDDEN, warnings[0])

    created: list[str] = []
    for pid in eligible:
        body = OpportunityCreate(property_id=pid, owner_id=data.owner_id, priority=data.priority, source=data.source,
                                 override_reason=data.override_reason)
        try:
            o = await pipeline.create(db, body, user)
            created.append(str(o.id))
        except HTTPException as e:
            await db.rollback()
            await db.refresh(user.user)
            result.skipped.append(SkipItem(id=str(pid), label=props[pid], reason=_detail(e.detail)))
    result.done = len(created)
    await audit.record(db, actor=user, action="map.bulk_opportunities", entity_type="map_selection",
                       summary=f"{len(created)} opportunities created from map selection, {len(result.skipped)} skipped",
                       changes={"opportunity_ids": created, "property_ids": [str(i) for i in props]},
                       ip_address=user.ip_address)
    await db.commit()
    return result


# ============================================================================= bulk: territory assignment


async def bulk_territory(db: AsyncSession, data: BulkTerritoryIn, user: CurrentUser) -> BulkResult:
    from app.modules.territories import service as territories
    from app.modules.territories.models import TerritoryMember
    from app.modules.territories.schemas import MembersIn

    t = await territories.get_visible(db, data.territory_id, user)
    props = await resolve_properties(db, data, user)
    already = set(await db.scalars(select(TerritoryMember.property_id).where(
        TerritoryMember.territory_id == t.id, TerritoryMember.property_id.in_(list(props)))))
    can = territories.can_edit(t, user)
    result = BulkResult(
        action="assign_territory", applied=data.apply, properties=len(props), eligible=len(props) - len(already),
        skipped=[SkipItem(id=str(i), label=props[i], reason="Already a member") for i in props if i in already],
        blocked=not can, warnings=[] if can else ["Only the territory owner or an approver can change it"],
        details={"territory_id": str(t.id), "territory_name": t.name},
    )
    if not data.apply:
        return result
    territories.require_edit(t, user)
    new = [i for i in props if i not in already]
    for chunk in _chunks(new, 1000):
        result.done += await territories.add_members(db, t, MembersIn(property_ids=chunk), user)
    return result


# ============================================================================= owners of selected properties


async def current_interests(db: AsyncSession, property_ids: list[uuid.UUID]) -> list:
    from app.modules.ownership.models import OwnershipInterest as OI

    if not property_ids:
        return []
    return list(await db.scalars(select(OI).where(
        OI.property_id.in_(property_ids), OI.deleted_at.is_(None), OI.verification != "rejected",
        or_(OI.effective_to.is_(None), OI.effective_to >= func.current_date()))))


async def _people(db: AsyncSession, ids: set[uuid.UUID]) -> dict:
    from app.modules.contacts.models import Person

    if not ids:
        return {}
    return {p.id: p for p in await db.scalars(select(Person).where(Person.id.in_(ids), Person.deleted_at.is_(None)))}


async def _orgs(db: AsyncSession, ids: set[uuid.UUID]) -> dict:
    from app.modules.contacts.models import Organization

    if not ids:
        return {}
    return {o.id: o for o in await db.scalars(select(Organization).where(
        Organization.id.in_(ids), Organization.deleted_at.is_(None)))}


async def _suppression(db: AsyncSession, person_id: uuid.UUID) -> list[str]:
    try:
        from app.modules.compliance.service import person_suppression_reasons
    except ImportError:
        return []
    return await person_suppression_reasons(db, person_id)


# ============================================================================= bulk: sequence enrollment


async def bulk_sequence(db: AsyncSession, data: BulkSequenceIn, user: CurrentUser) -> BulkResult:
    from app.modules.contacts.models import Affiliation
    from app.modules.outreach import service as outreach
    from app.modules.outreach.models import SequenceEnrollment

    s = await outreach.get_sequence(db, data.sequence_id)
    props = await resolve_properties(db, data, user)
    interests = await current_interests(db, list(props))
    person_ids = {i.owner_person_id for i in interests if i.owner_kind == "person" and i.owner_person_id}
    org_ids = {i.owner_organization_id for i in interests if i.owner_kind == "organization" and i.owner_organization_id}
    if org_ids:
        person_ids |= set(await db.scalars(select(Affiliation.person_id).where(
            Affiliation.organization_id.in_(org_ids), Affiliation.is_current.is_(True), Affiliation.deleted_at.is_(None))))
    people = await _people(db, person_ids)
    already = set(await db.scalars(select(SequenceEnrollment.person_id).where(
        SequenceEnrollment.sequence_id == s.id, SequenceEnrollment.person_id.in_(list(people) or [uuid.uuid4()]),
        SequenceEnrollment.status.in_(["active", "paused"]), SequenceEnrollment.deleted_at.is_(None))))

    skipped: list[SkipItem] = []
    eligible: list[uuid.UUID] = []
    for pid, p in people.items():
        if pid in already:
            skipped.append(SkipItem(id=str(pid), label=p.full_name, reason="Already enrolled"))
            continue
        reasons = await _suppression(db, pid)
        if reasons:
            skipped.append(SkipItem(id=str(pid), label=p.full_name, reason="; ".join(reasons[:2])))
            continue
        eligible.append(pid)

    owned = {i.property_id for i in interests}
    warnings = []
    if s.status != "active":
        warnings.append("Only active sequences accept enrollments")
    if not s.steps:
        warnings.append("The sequence has no steps yet")
    if len(owned) < len(props):
        warnings.append(f"{len(props) - len(owned)} selected properties have no current owner on record")
    result = BulkResult(
        action="enroll_sequence", applied=data.apply, properties=len(props), eligible=len(eligible), skipped=skipped,
        warnings=warnings, blocked=s.status != "active" or not s.steps,
        details={"sequence_id": str(s.id), "sequence_name": s.name, "people": len(people),
                 "organizations": len(org_ids)},
    )
    if not data.apply:
        return result
    if not eligible:
        raise _422("No eligible people to enroll")
    res = await outreach.enroll(db, s, eligible, data.owner_id, user)
    result.done = int(res.get("enrolled", 0))
    names = {str(k): v.full_name for k, v in people.items()}
    result.skipped += [SkipItem(id=str(x.get("person_id")), label=names.get(str(x.get("person_id"))),
                                reason=str(x.get("reason"))) for x in res.get("skipped", [])]
    return result


# ============================================================================= bulk: mailing export


MAIL_COLUMNS = ["property", "property_address", "property_city", "property_state", "owner_kind", "owner_name",
                "owner_role", "mailing_address", "mailing_city", "mailing_state", "mailing_postal_code"]


async def bulk_export(db: AsyncSession, data: BulkExportIn, user: CurrentUser) -> ExportOut:
    from app.modules.properties.models import Property as P

    props = await resolve_properties(db, data, user)
    prop_rows = {r[0]: r for r in (await db.execute(select(P.id, P.address_line, P.city, P.state).where(
        P.id.in_(list(props))))).all()}
    interests = await current_interests(db, list(props))
    people = await _people(db, {i.owner_person_id for i in interests if i.owner_person_id})
    orgs = await _orgs(db, {i.owner_organization_id for i in interests if i.owner_organization_id})
    masked = not user.can("contacts", "view_sensitive")

    rows: list[list[Any]] = []
    skipped: list[SkipItem] = []
    providers: set[str] = set()
    seen: set[tuple] = set()
    for i in sorted(interests, key=lambda x: props.get(x.property_id, "")):
        owner = people.get(i.owner_person_id) if i.owner_kind == "person" else orgs.get(i.owner_organization_id)
        if owner is None:
            continue
        key = (i.property_id, i.owner_kind, owner.id)
        if key in seen:
            continue
        seen.add(key)
        name = owner.full_name if i.owner_kind == "person" else owner.name
        if i.owner_kind == "person":
            reasons = await _suppression(db, owner.id)
            if reasons:
                skipped.append(SkipItem(id=str(owner.id), label=name, reason="Opted out or suppressed"))
                continue
        if not (owner.mailing_address or owner.city):
            skipped.append(SkipItem(id=str(owner.id), label=name, reason="No mailing address on record"))
            continue
        providers |= {x for x in (i.source, owner.source) if x}
        _, addr, city, st = prop_rows.get(i.property_id, (None, None, None, None))
        rows.append([props.get(i.property_id), addr, city, st, i.owner_kind, name, i.role,
                     "Restricted" if masked else owner.mailing_address, owner.city, owner.state, owner.postal_code])

    blocked, warnings = False, []
    try:
        from app.modules.compliance.service import export_warnings

        blocked, warnings = await export_warnings(db, providers=sorted(providers))
    except ImportError:
        pass
    if masked:
        warnings.append("Street addresses are restricted without contacts sensitive-data permission")
    no_owner = len(set(props) - {i.property_id for i in interests})
    if no_owner:
        warnings.append(f"{no_owner} selected properties have no current owner on record")
    result = ExportOut(action="export_mailing", applied=data.apply, properties=len(props), eligible=len(rows),
                       skipped=skipped, warnings=warnings, blocked=blocked, masked=masked)
    if not data.apply:
        return result
    if blocked:
        raise HTTPException(status.HTTP_409_CONFLICT, {"message": "Export blocked by a data provider restriction",
                                                       "warnings": warnings})
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(MAIL_COLUMNS)
    writer.writerows(rows)
    await audit.record(db, actor=user, action="map.mailing_exported", entity_type="map_selection",
                       summary=f"{len(rows)} mailing rows for {len(props)} properties",
                       changes={"property_ids": [str(i) for i in props], "masked": masked, "warnings": warnings,
                                "skipped": len(skipped)},
                       ip_address=user.ip_address)
    await db.commit()
    result.done = len(rows)
    result.csv = buf.getvalue()
    result.filename = f"mailing-{utcnow():%Y%m%d-%H%M}.csv"
    return result


# ============================================================================= drawn territories


async def save_territory(db: AsyncSession, data: SaveTerritoryIn, user: CurrentUser):
    from app.modules.territories import service as territories
    from app.modules.territories.schemas import TerritoryIn

    if data.circle:
        body = TerritoryIn(name=data.name, description=data.description, visibility=data.visibility, rule_type="radius",
                           rule={"lat": data.circle.lat, "lng": data.circle.lng,
                                 "radius_miles": round(max(data.circle.radius_m / geo.M_PER_MILE, 0.01), 4)})
    elif data.polygon:
        body = TerritoryIn(name=data.name, description=data.description, visibility=data.visibility,
                           rule_type="boundary", geometry=data.polygon)
    else:
        raise _422("Draw a polygon or circle to save as a territory")
    return await territories.create_territory(db, body, user)


# ============================================================================= assemblage


async def assemblage(db: AsyncSession, parcel_id: uuid.UUID, user: CurrentUser) -> dict:
    from app.modules.parcels import service as parcels
    from app.modules.parcels.models import Parcel

    p = await parcels.get(db, parcel_id)
    out = await parcels.assemblage(db, p, user)
    ids = {x.id for g in out.groups for x in g.parcels}
    gj = None
    if ids:
        gj = await db.scalar(select(func.ST_AsGeoJSON(func.ST_Union(Parcel.geometry), 6)).where(
            Parcel.id.in_(ids), Parcel.has_geometry.is_(True)))
    return {"result": out.model_dump(mode="json"), "geometry": geo.loads(gj)}


# ============================================================================= record cards


async def _property_id_for(db: AsyncSession, kind: str, record_id: uuid.UUID, user: CurrentUser) -> uuid.UUID:
    model = None
    if kind == "opportunity":
        _need(user, "pipeline", "view")
        from app.modules.pipeline.models import Opportunity as model  # noqa: N813
    elif kind == "asset":
        _need(user, "assets", "view")
        from app.modules.assets.models import Asset as model  # noqa: N813
    elif kind == "listing":
        _need(user, "brokerage", "view")
        from app.modules.brokerage.models import Listing as model  # noqa: N813
    elif kind == "signal":
        _need(user, "signals", "view")
        from app.modules.signals.models import Signal as model  # noqa: N813
    obj = await db.get(model, record_id) if model is not None else None
    if not obj or obj.deleted_at or not getattr(obj, "property_id", None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Record not found")
    if kind == "signal" and obj.is_sensitive and not user.can("signals", "view_sensitive"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Record not found")
    return obj.property_id


async def _owners(db: AsyncSession, property_id: uuid.UUID) -> list[CardOwner]:
    interests = await current_interests(db, [property_id])
    people = await _people(db, {i.owner_person_id for i in interests if i.owner_person_id})
    orgs = await _orgs(db, {i.owner_organization_id for i in interests if i.owner_organization_id})
    out = []
    for i in interests:
        if i.owner_kind == "person" and i.owner_person_id:
            p = people.get(i.owner_person_id)
            out.append(CardOwner(kind="person", id=i.owner_person_id, name=p.full_name if p else None, role=i.role,
                                 interest_pct=i.interest_pct))
        elif i.owner_organization_id:
            o = orgs.get(i.owner_organization_id)
            out.append(CardOwner(kind="organization", id=i.owner_organization_id, name=o.name if o else None,
                                 role=i.role, interest_pct=i.interest_pct))
    return out


async def _property_card(db: AsyncSession, property_id: uuid.UUID, user: CurrentUser, kind: str) -> CardOut:
    from app.modules.parcels.models import Parcel, PropertyParcel
    from app.modules.properties.models import Property as P

    _need(user, "properties", "view")
    p = await db.get(P, property_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    card = CardOut(kind=kind, property=audit.to_jsonable({
        "id": p.id, "label": _label(p.name, p.address_line), "address_line": p.address_line, "city": p.city,
        "state": p.state, "county": p.county, "status": p.status, "property_type": p.property_type,
        "building_area_sf": p.building_area_sf, "land_area_acres": p.land_area_acres, "asking_price": p.asking_price,
        "year_built": p.year_built, "occupancy_pct": p.occupancy_pct, "latitude": p.latitude, "longitude": p.longitude,
    }))
    apns: list[str] = []
    if user.can("parcels", "view"):
        rows = await db.execute(select(Parcel.id, Parcel.apn, Parcel.county, Parcel.acreage)
                                .join(PropertyParcel, PropertyParcel.parcel_id == Parcel.id)
                                .where(PropertyParcel.property_id == p.id, Parcel.deleted_at.is_(None)))
        for pid, apn, county, acres in rows.all():
            card.parcels.append(audit.to_jsonable({"id": pid, "apn": apn, "county": county, "acreage": acres}))
            apns.append(apn)
    if user.can("ownership", "view"):
        try:
            card.owners = await _owners(db, p.id)
        except ImportError:
            card.owners = None
    if user.can("pipeline", "view"):
        try:
            from app.modules.pipeline.models import Opportunity as O

            o = await db.scalar(select(O).where(O.property_id == p.id, O.deleted_at.is_(None))
                                .order_by(O.stage.in_(OPEN_EXCLUDED_STAGES), O.updated_at.desc()).limit(1))
            if o:
                card.opportunity = audit.to_jsonable({
                    "id": o.id, "title": o.title, "stage": o.stage, "priority": o.priority,
                    "next_action": o.next_action, "next_action_at": o.next_action_at, "owner_id": o.owner_id})
        except ImportError:
            pass
    if user.can("signals", "view"):
        try:
            from app.modules.signals.models import Signal as S
            from app.modules.signals.service import motivation_index

            stmt = select(S).where(S.property_id == p.id, S.deleted_at.is_(None), S.status == "active")
            if not user.can("signals", "view_sensitive"):
                stmt = stmt.where(S.is_sensitive.is_(False))
            sigs = list(await db.scalars(stmt.order_by(S.severity.desc(), S.observed_on.desc()).limit(5)))
            card.signals = [CardSignal(id=s.id, category=s.category, signal_type=s.signal_type, title=s.title,
                                       severity=s.severity, observed_on=s.observed_on) for s in sigs]
            card.motivation_index = round(float(await motivation_index(db, p.id)), 1)
        except ImportError:
            card.signals = None
    card.viewer_links = viewer_links({"lat": p.latitude, "lng": p.longitude, "apn": apns[0] if apns else None,
                                      "county": p.county, "state": p.state, "address": p.address_line})
    return card


async def card(db: AsyncSession, kind: str, record_id: uuid.UUID, user: CurrentUser) -> CardOut:
    if kind == "property":
        return await _property_card(db, record_id, user, kind)
    if kind in ("opportunity", "asset", "listing", "signal"):
        return await _property_card(db, await _property_id_for(db, kind, record_id, user), user, kind)
    if kind == "parcel":
        from app.modules.parcels import service as parcels

        _need(user, "parcels", "view")
        p = await parcels.get(db, record_id)
        links = await _parcel_links(db, [p.id])
        prop_ids = links.get(p.id, [])
        out = CardOut(kind=kind, parcel=audit.to_jsonable({
            "id": p.id, "apn": p.apn, "county": p.county, "state": p.state, "acreage": p.acreage,
            "situs_address": p.situs_address, "property_ids": prop_ids, "source": p.source}))
        if prop_ids and user.can("properties", "view"):
            prop_card = await _property_card(db, prop_ids[0], user, kind)
            prop_card.parcel = out.parcel
            return prop_card
        out.viewer_links = viewer_links({"lat": p.centroid_lat, "lng": p.centroid_lng, "apn": p.apn,
                                         "county": p.county, "state": p.state, "address": p.situs_address})
        return out
    if kind == "comp":
        from app.modules.comps.models import SaleComp as C

        _need(user, "comps", "view")
        c = await db.get(C, record_id)
        if not c or c.deleted_at:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Comp not found")
        return CardOut(kind=kind, comp=audit.to_jsonable({
            "id": c.id, "label": _label(c.name, c.address_line), "address_line": c.address_line, "city": c.city,
            "state": c.state, "property_type": c.property_type, "sale_date": c.sale_date, "sale_price": c.sale_price,
            "price_psf": c.price_psf, "cap_rate": c.cap_rate, "verification_status": c.verification_status,
            "source": c.source, "property_id": c.property_id}),
            viewer_links=viewer_links({"lat": c.latitude, "lng": c.longitude, "address": c.address_line}))
    if kind == "observation":
        o = await get_observation(db, record_id)
        out = CardOut(kind=kind, observation=(await observation_outs(db, [o]))[0].model_dump(mode="json"))
        if o.property_id and user.can("properties", "view"):
            prop_card = await _property_card(db, o.property_id, user, kind)
            prop_card.observation = out.observation
            return prop_card
        return out
    raise _422("Unknown record kind")


# ============================================================================= field observations


async def get_observation(db: AsyncSession, obs_id: uuid.UUID) -> MapFieldObservation:
    o = await db.get(MapFieldObservation, obs_id)
    if not o or o.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Observation not found")
    return o


async def _nearest_property(db: AsyncSession, lat: float, lng: float) -> uuid.UUID | None:
    from app.modules.properties.models import Property as P

    pt = cast(geo.point(lat, lng), Geography)
    return await db.scalar(
        select(P.id).where(P.deleted_at.is_(None), P.location.isnot(None),
                           func.ST_DWithin(cast(P.location, Geography), pt, NEAREST_PROPERTY_M))
        .order_by(func.ST_Distance(cast(P.location, Geography), pt)).limit(1)
    )


async def _link_photos(db: AsyncSession, doc_ids: list[uuid.UUID], targets: list[tuple[str, uuid.UUID]],
                       user: CurrentUser) -> None:
    if not doc_ids or not user.can("documents", "create"):
        return
    try:
        from app.modules.documents.service import link
    except ImportError:
        return
    for doc_id in doc_ids:
        for entity_type, entity_id in targets:
            try:
                async with db.begin_nested():
                    await link(db, doc_id, entity_type, entity_id, user)
            except HTTPException:
                continue


async def create_observation(db: AsyncSession, data: ObservationIn, user: CurrentUser) -> tuple[MapFieldObservation, bool]:
    """Idempotent on client_uuid: re-sending a queued observation returns the stored one (created=False)."""
    M = MapFieldObservation
    existing = await db.scalar(select(M).where(M.client_uuid == data.client_uuid))
    if existing:
        return existing, False

    property_id = data.property_id
    if property_id:
        from app.modules.properties.models import Property as P

        p = await db.get(P, property_id)
        if not p or p.deleted_at:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    elif user.can("properties", "view"):
        property_id = await _nearest_property(db, data.lat, data.lng)

    o = M(client_uuid=data.client_uuid, property_id=property_id, latitude=data.lat, longitude=data.lng,
          location=geo.point(data.lat, data.lng), accuracy_m=data.accuracy_m, observed_at=data.observed_at or utcnow(),
          category=data.category, note=(data.note or "").strip() or None,
          photo_document_ids=[str(i) for i in data.photo_document_ids], created_by_id=user.id, updated_by_id=user.id)
    db.add(o)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        await db.refresh(user.user)
        existing = await db.scalar(select(M).where(M.client_uuid == data.client_uuid))
        if existing:
            return existing, False
        raise
    targets = [("field_observation", o.id)] + ([("property", property_id)] if property_id else [])
    await _link_photos(db, data.photo_document_ids, targets, user)
    await audit.record(
        db, actor=user, action="property.field_observation" if property_id else "field_observation.created",
        entity_type="property" if property_id else "field_observation", entity_id=property_id or o.id,
        summary=f"Field observation ({o.category.replace('_', ' ')})" + (f": {o.note[:120]}" if o.note else ""),
        changes={"observation_id": o.id, "lat": o.latitude, "lng": o.longitude, "accuracy_m": o.accuracy_m,
                 "photos": len(o.photo_document_ids)},
        ip_address=user.ip_address,
    )
    await db.commit()
    return o, True


def observation_query(*, bbox: str | None, property_id: uuid.UUID | None, category: list[str] | None,
                      mine: bool, user: CurrentUser, q: str | None) -> Select:
    M = MapFieldObservation
    stmt = select(M).where(M.deleted_at.is_(None))
    if bbox:
        stmt = stmt.where(func.ST_Intersects(M.location, geo.envelope(bbox)))
    if property_id:
        stmt = stmt.where(M.property_id == property_id)
    if mine:
        stmt = stmt.where(M.created_by_id == user.id)
    if q:
        stmt = stmt.where(M.note.ilike(f"%{q}%"))
    return in_filter(stmt, M.category, category)


async def observation_outs(db: AsyncSession, rows: list[MapFieldObservation]) -> list[ObservationOut]:
    from app.modules.auth.models import User
    from app.modules.properties.models import Property as P

    prop_ids = {r.property_id for r in rows if r.property_id}
    user_ids = {r.created_by_id for r in rows if r.created_by_id}
    labels = {i: _label(n, a) for i, n, a in (await db.execute(
        select(P.id, P.name, P.address_line).where(P.id.in_(prop_ids)))).all()} if prop_ids else {}
    names = dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(user_ids)))).all()) if user_ids else {}
    out = []
    for r in rows:
        o = ObservationOut.model_validate(r)
        o.property_label = labels.get(r.property_id) if r.property_id else None
        o.created_by_name = names.get(r.created_by_id) if r.created_by_id else None
        out.append(o)
    return out
