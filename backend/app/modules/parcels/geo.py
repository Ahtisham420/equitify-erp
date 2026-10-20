"""PostGIS helpers shared by parcels and territories. PostGIS is authoritative for geometry:
GeoJSON input is parsed, repaired and measured in the database, never in Python."""
import json
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from geoalchemy2 import Geography
from geoalchemy2.elements import WKTElement
from sqlalchemy import Text, cast, func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

SQ_M_PER_ACRE = 4046.8564224
M_PER_MILE = 1609.344
M_PER_FT = 0.3048
M_PER_DEGREE = 111_320.0


def _invalid(msg: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, msg)


def _flatten(raw: Any, allowed: set[str]) -> dict:
    """Accept a GeoJSON geometry, Feature or FeatureCollection and return a single geometry object."""
    if not isinstance(raw, dict):
        raise _invalid("Geometry must be a GeoJSON object")
    kind = raw.get("type")
    if kind == "Feature":
        return _flatten(raw.get("geometry"), allowed)
    if kind == "FeatureCollection":
        geoms = [_flatten(f.get("geometry"), allowed) for f in raw.get("features") or [] if isinstance(f, dict)]
        if not geoms:
            raise _invalid("FeatureCollection has no geometries")
        return geoms[0] if len(geoms) == 1 else {"type": "GeometryCollection", "geometries": geoms}
    if kind in allowed or kind == "GeometryCollection":
        return raw
    raise _invalid(f"Expected GeoJSON {' / '.join(sorted(allowed))}, got {kind or 'unknown'}")


def _from_geojson(geom: dict):
    return func.ST_SetSRID(func.ST_GeomFromGeoJSON(cast(json.dumps(geom), Text)), 4326)


@dataclass
class PolygonResult:
    wkt: str
    centroid_lat: float
    centroid_lng: float
    acres: float


async def polygon_from_geojson(db: AsyncSession, raw: Any) -> PolygonResult:
    geom = _flatten(raw, {"Polygon", "MultiPolygon"})
    sub = select(func.ST_Multi(func.ST_CollectionExtract(func.ST_MakeValid(_from_geojson(geom)), 3)).label("g")).subquery()
    stmt = select(
        func.ST_AsText(sub.c.g),
        func.ST_IsEmpty(sub.c.g),
        func.ST_Y(func.ST_Centroid(sub.c.g)),
        func.ST_X(func.ST_Centroid(sub.c.g)),
        func.ST_Area(cast(sub.c.g, Geography)),
    )
    try:
        async with db.begin_nested():
            wkt, empty, lat, lng, area = (await db.execute(stmt)).one()
    except DBAPIError:
        raise _invalid("Invalid GeoJSON geometry")
    if empty or not wkt:
        raise _invalid("Geometry must contain at least one polygon")
    return PolygonResult(wkt=wkt, centroid_lat=float(lat), centroid_lng=float(lng), acres=float(area or 0) / SQ_M_PER_ACRE)


async def line_from_geojson(db: AsyncSession, raw: Any) -> tuple[str, float]:
    """Returns (WKT LINESTRING, length in feet)."""
    geom = _flatten(raw, {"LineString", "MultiLineString"})
    sub = select(func.ST_LineMerge(func.ST_Multi(func.ST_CollectionExtract(_from_geojson(geom), 2))).label("g")).subquery()
    stmt = select(func.ST_AsText(sub.c.g), func.GeometryType(sub.c.g), func.ST_Length(cast(sub.c.g, Geography)))
    try:
        async with db.begin_nested():
            wkt, gtype, length = (await db.execute(stmt)).one()
    except DBAPIError:
        raise _invalid("Invalid GeoJSON geometry")
    if gtype != "LINESTRING":
        raise _invalid("Corridor geometry must be one connected line")
    return wkt, float(length or 0) / M_PER_FT


def point(lat: float, lng: float) -> WKTElement:
    return WKTElement(f"POINT({lng} {lat})", srid=4326)


def envelope(bbox: str):
    """`minLng,minLat,maxLng,maxLat` -> PostGIS envelope."""
    try:
        minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    except ValueError:
        raise _invalid("bbox must be minLng,minLat,maxLng,maxLat")
    return func.ST_MakeEnvelope(minx, miny, maxx, maxy, 4326)


def loads(value: str | None) -> dict | None:
    return json.loads(value) if value else None
