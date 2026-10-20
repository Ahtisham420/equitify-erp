import typing
import uuid
from dataclasses import dataclass
from datetime import date

from fastapi import HTTPException, status
from geoalchemy2 import Geography
from geoalchemy2.elements import WKTElement
from sqlalchemy import Float, Select, and_, cast, delete, false, func, literal, null, or_, select, true, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter, range_filter
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.parcels import geo
from app.modules.territories.models import (
    Corridor,
    GrowthRecord,
    Node,
    Territory,
    TerritoryMember,
    TradeArea,
    TrafficCount,
)
from app.modules.territories.schemas import (
    CorridorOut,
    MembersIn,
    OverlapOut,
    RecomputeOut,
    TerritoryIn,
    TerritoryListItem,
    TerritoryOut,
    TerritoryUpdate,
    TrafficCountOut,
)

GEO_FIELDS = {"latitude", "longitude", "county", "city", "state", "location"}
DEFAULT_CORRIDOR_BUFFER_FT = 500.0


# ============================================================================= shared CRUD helpers

async def get_obj(db: AsyncSession, model, obj_id: uuid.UUID, label: str):
    obj = await db.get(model, obj_id)
    if not obj or obj.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    return obj


def _set_point(obj) -> None:
    if obj.latitude is not None and obj.longitude is not None:
        obj.location = geo.point(obj.latitude, obj.longitude)
    else:
        obj.location = None


async def _apply_line(db: AsyncSession, obj: Corridor, raw: dict | None, clear: bool) -> dict | None:
    if raw:
        wkt, length_ft = await geo.line_from_geojson(db, raw)
        obj.geometry = WKTElement(wkt, srid=4326)
        obj.has_geometry = True
        obj.length_ft = round(length_ft, 2)
        return {"from": None, "to": f"line ({length_ft:,.0f} ft)"}
    if clear and obj.has_geometry:
        obj.geometry = None
        obj.has_geometry = False
        obj.length_ft = None
        return {"from": "line", "to": None}
    return None


async def _apply_polygon(db: AsyncSession, obj, raw: dict | None) -> dict | None:
    if not raw:
        return None
    shape = await geo.polygon_from_geojson(db, raw)
    obj.geometry = WKTElement(shape.wkt, srid=4326)
    obj.has_geometry = True
    return {"from": None, "to": f"polygon ({shape.acres:,.1f} ac)"}


async def create_record(db: AsyncSession, model, values: dict, actor: CurrentUser, entity: str, *,
                        geometry: dict | None = None, kind: str | None = None, summary: str | None = None):
    obj = model(**values, created_by_id=actor.id, updated_by_id=actor.id)
    if hasattr(model, "location"):
        _set_point(obj)
    if kind == "line":
        await _apply_line(db, obj, geometry, False)
    elif kind == "polygon":
        await _apply_polygon(db, obj, geometry)
    db.add(obj)
    await db.flush()
    await audit.record(db, actor=actor, action=f"{entity}.created", entity_type=entity, entity_id=obj.id,
                       summary=summary or getattr(obj, "name", None), ip_address=actor.ip_address)
    await db.commit()
    return obj


async def update_record(db: AsyncSession, obj, values: dict, actor: CurrentUser, entity: str, *,
                        geometry: dict | None = None, clear_geometry: bool = False, kind: str | None = None):
    changes = audit.diff(obj, values)
    for k, v in values.items():
        setattr(obj, k, v)
    # Check the class, not the instance: touching a deferred PostGIS column would trigger an async lazy load.
    if hasattr(type(obj), "location") and {"latitude", "longitude"} & changes.keys():
        _set_point(obj)
    geom_change = None
    if kind == "line":
        geom_change = await _apply_line(db, obj, geometry, clear_geometry)
    elif kind == "polygon":
        geom_change = await _apply_polygon(db, obj, geometry)
    if geom_change:
        changes["geometry"] = geom_change
    if not changes:
        return obj
    obj.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{entity}.updated", entity_type=entity, entity_id=obj.id,
                       changes=changes, summary=getattr(obj, "name", None), ip_address=actor.ip_address)
    await db.commit()
    return obj


async def archive_record(db: AsyncSession, obj, actor: CurrentUser, entity: str) -> None:
    obj.deleted_at = utcnow()
    obj.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{entity}.archived", entity_type=entity, entity_id=obj.id,
                       summary=getattr(obj, "name", None), ip_address=actor.ip_address)
    await db.commit()


async def geojson_of(db: AsyncSession, column, id_column, obj_id: uuid.UUID) -> dict | None:
    return geo.loads(await db.scalar(select(func.ST_AsGeoJSON(column, 7)).where(id_column == obj_id)))


# ============================================================================= corridors

@dataclass
class CorridorFilters:
    q: str | None = None
    road_class: list[str] | None = None
    county: str | None = None
    city: str | None = None
    has_geometry: bool | None = None


def corridor_query(f: CorridorFilters) -> Select:
    stmt = select(Corridor).where(Corridor.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Corridor.name, Corridor.road_name, Corridor.city, Corridor.county])
    stmt = in_filter(stmt, Corridor.road_class, f.road_class)
    if f.county:
        stmt = stmt.where(Corridor.county.ilike(f"%{f.county}%"))
    if f.city:
        stmt = stmt.where(Corridor.city.ilike(f"%{f.city}%"))
    if f.has_geometry is not None:
        stmt = stmt.where(Corridor.has_geometry.is_(f.has_geometry))
    return stmt


def corridor_extras():
    nodes = (select(func.count(Node.id)).where(Node.corridor_id == Corridor.id, Node.deleted_at.is_(None))
             .correlate(Corridor).scalar_subquery())
    latest = (select(TrafficCount.count).where(TrafficCount.corridor_id == Corridor.id, TrafficCount.deleted_at.is_(None))
              .order_by(TrafficCount.count_year.desc()).limit(1).correlate(Corridor).scalar_subquery())
    latest_year = (select(TrafficCount.count_year)
                   .where(TrafficCount.corridor_id == Corridor.id, TrafficCount.deleted_at.is_(None))
                   .order_by(TrafficCount.count_year.desc()).limit(1).correlate(Corridor).scalar_subquery())
    return nodes.label("node_count"), latest.label("latest_count"), latest_year.label("latest_count_year")


def corridor_rows(rows) -> list[CorridorOut]:
    return [CorridorOut.model_validate(c).model_copy(update={"node_count": int(n or 0), "latest_count": lc,
                                                              "latest_count_year": ly}) for c, n, lc, ly in rows]


async def corridor_out(db: AsyncSession, c: Corridor) -> CorridorOut:
    row = (await db.execute(select(Corridor, *corridor_extras()).where(Corridor.id == c.id))).one()
    out = corridor_rows([row])[0]
    out.geojson = await geojson_of(db, Corridor.geometry, Corridor.id, c.id)
    return out


# ============================================================================= nodes

@dataclass
class NodeFilters:
    q: str | None = None
    corridor_id: uuid.UUID | None = None
    county: str | None = None
    city: str | None = None
    signalized: bool | None = None


def node_query(f: NodeFilters) -> Select:
    stmt = select(Node, Corridor.name).outerjoin(Corridor, Corridor.id == Node.corridor_id).where(Node.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Node.name, Node.cross_street, Node.city, Node.county])
    if f.corridor_id:
        stmt = stmt.where(Node.corridor_id == f.corridor_id)
    if f.county:
        stmt = stmt.where(Node.county.ilike(f"%{f.county}%"))
    if f.city:
        stmt = stmt.where(Node.city.ilike(f"%{f.city}%"))
    if f.signalized is not None:
        stmt = stmt.where(Node.signalized.is_(f.signalized))
    return stmt


# ============================================================================= traffic counts

@dataclass
class TrafficFilters:
    q: str | None = None
    corridor_id: uuid.UUID | None = None
    node_id: uuid.UUID | None = None
    min_year: int | None = None
    max_year: int | None = None
    min_count: int | None = None
    max_count: int | None = None
    source: str | None = None


def traffic_query(f: TrafficFilters) -> Select:
    prev = func.lag(TrafficCount.count).over(
        partition_by=(TrafficCount.corridor_id, TrafficCount.node_id, TrafficCount.segment, TrafficCount.approach),
        order_by=TrafficCount.count_year,
    )
    lagged = select(TrafficCount.id.label("tid"), prev.label("prev")).where(TrafficCount.deleted_at.is_(None)).subquery()
    stmt = (
        select(TrafficCount, lagged.c.prev, Corridor.name, Node.name)
        .join(lagged, lagged.c.tid == TrafficCount.id)
        .outerjoin(Corridor, Corridor.id == TrafficCount.corridor_id)
        .outerjoin(Node, Node.id == TrafficCount.node_id)
        .where(TrafficCount.deleted_at.is_(None))
    )
    stmt = apply_search(stmt, f.q, [TrafficCount.segment, TrafficCount.approach, TrafficCount.source])
    if f.corridor_id:
        stmt = stmt.where(TrafficCount.corridor_id == f.corridor_id)
    if f.node_id:
        stmt = stmt.where(TrafficCount.node_id == f.node_id)
    if f.source:
        stmt = stmt.where(TrafficCount.source.ilike(f"%{f.source}%"))
    stmt = range_filter(stmt, TrafficCount.count_year, f.min_year, f.max_year)
    return range_filter(stmt, TrafficCount.count, f.min_count, f.max_count)


def traffic_row(t: TrafficCount, prev: int | None, corridor_name: str | None, node_name: str | None) -> TrafficCountOut:
    out = TrafficCountOut.model_validate(t)
    out.corridor_name = corridor_name
    out.node_name = node_name
    out.change_pct = round((t.count - prev) / prev * 100, 1) if prev else None
    return out


async def traffic_trend(db: AsyncSession, *, corridor_id: uuid.UUID | None, node_id: uuid.UUID | None,
                        segment: str | None, approach: str | None) -> list[TrafficCount]:
    if not (corridor_id or node_id or segment):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Provide corridor_id, node_id or segment")
    stmt = select(TrafficCount).where(TrafficCount.deleted_at.is_(None))
    if corridor_id:
        stmt = stmt.where(TrafficCount.corridor_id == corridor_id)
    if node_id:
        stmt = stmt.where(TrafficCount.node_id == node_id)
    if segment:
        stmt = stmt.where(TrafficCount.segment == segment)
    if approach:
        stmt = stmt.where(TrafficCount.approach == approach)
    return list(await db.scalars(stmt.order_by(TrafficCount.count_year, TrafficCount.observed_on)))


# ============================================================================= trade areas

def trade_area_query(node_id: uuid.UUID | None, property_id: uuid.UUID | None, minutes: list[int] | None,
                     q: str | None) -> Select:
    from app.modules.properties.models import Property

    label = func.coalesce(Property.name, Property.address_line)
    stmt = (
        select(TradeArea, Node.name, label)
        .outerjoin(Node, Node.id == TradeArea.node_id)
        .outerjoin(Property, Property.id == TradeArea.property_id)
        .where(TradeArea.deleted_at.is_(None))
    )
    stmt = apply_search(stmt, q, [TradeArea.name, TradeArea.source, Node.name, Property.address_line])
    if node_id:
        stmt = stmt.where(TradeArea.node_id == node_id)
    if property_id:
        stmt = stmt.where(TradeArea.property_id == property_id)
    return in_filter(stmt, TradeArea.minutes, minutes)


# ============================================================================= growth context

@dataclass
class GrowthFilters:
    q: str | None = None
    kind: list[str] | None = None
    county: str | None = None
    city: str | None = None
    from_date: date | None = None
    to_date: date | None = None
    near_lat: float | None = None
    near_lng: float | None = None
    property_id: uuid.UUID | None = None
    node_id: uuid.UUID | None = None
    radius_miles: float | None = None


async def resolve_center(db: AsyncSession, *, lat: float | None, lng: float | None, property_id: uuid.UUID | None,
                         node_id: uuid.UUID | None) -> tuple[float, float] | None:
    if lat is not None and lng is not None:
        return lat, lng
    if property_id:
        from app.modules.properties.models import Property

        row = (await db.execute(select(Property.latitude, Property.longitude).where(Property.id == property_id))).first()
    elif node_id:
        row = (await db.execute(select(Node.latitude, Node.longitude).where(Node.id == node_id))).first()
    else:
        return None
    if not row or row[0] is None or row[1] is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The selected center has no coordinates")
    return float(row[0]), float(row[1])


async def growth_query(db: AsyncSession, f: GrowthFilters, *, skip: set[str] = frozenset()) -> Select:
    center = await resolve_center(db, lat=f.near_lat, lng=f.near_lng, property_id=f.property_id, node_id=f.node_id)
    dist = (
        func.ST_Distance(cast(GrowthRecord.location, Geography), cast(geo.point(*center), Geography)) / geo.M_PER_MILE
        if center else cast(null(), Float)
    )
    stmt = select(GrowthRecord, dist.label("distance_miles")).where(GrowthRecord.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [GrowthRecord.name, GrowthRecord.description, GrowthRecord.source, GrowthRecord.city])
    if "kind" not in skip:
        stmt = in_filter(stmt, GrowthRecord.kind, f.kind)
    if f.county:
        stmt = stmt.where(GrowthRecord.county.ilike(f"%{f.county}%"))
    if f.city:
        stmt = stmt.where(GrowthRecord.city.ilike(f"%{f.city}%"))
    stmt = range_filter(stmt, GrowthRecord.event_date, f.from_date, f.to_date)
    if center and f.radius_miles:
        stmt = stmt.where(func.ST_DWithin(cast(GrowthRecord.location, Geography), cast(geo.point(*center), Geography),
                                          f.radius_miles * geo.M_PER_MILE))
    return stmt


# ============================================================================= territories: visibility

def _role_key(user: CurrentUser) -> str | None:
    role = getattr(user.user, "role", None)
    return getattr(role, "key", None)


def visible_clause(user: CurrentUser):
    if user.is_admin:
        return true()
    conds = [Territory.visibility == "company", Territory.owner_id == user.id]
    role = _role_key(user)
    if role:
        conds.append(and_(Territory.visibility == "role", Territory.allowed_roles.any(role)))
    return or_(*conds)


def can_edit(t: Territory, user: CurrentUser) -> bool:
    return user.is_admin or t.owner_id == user.id or user.can("territories", "approve")


async def get_visible(db: AsyncSession, territory_id: uuid.UUID, user: CurrentUser) -> Territory:
    t = await db.scalar(select(Territory).where(Territory.id == territory_id, Territory.deleted_at.is_(None),
                                                visible_clause(user)))
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Territory not found")
    return t


def require_edit(t: Territory, user: CurrentUser) -> None:
    if not can_edit(t, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the territory owner or an approver can change it")


@dataclass
class TerritoryFilters:
    q: str | None = None
    rule_type: list[str] | None = None
    visibility: list[str] | None = None
    parent_id: uuid.UUID | None = None
    top_level: bool | None = None
    mine: bool | None = None


def territory_query(f: TerritoryFilters, user: CurrentUser, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Territory).where(Territory.deleted_at.is_(None), visible_clause(user))
    stmt = apply_search(stmt, f.q, [Territory.name, Territory.description])
    if "rule_type" not in skip:
        stmt = in_filter(stmt, Territory.rule_type, f.rule_type)
    if "visibility" not in skip:
        stmt = in_filter(stmt, Territory.visibility, f.visibility)
    if f.parent_id:
        stmt = stmt.where(Territory.parent_id == f.parent_id)
    if f.top_level:
        stmt = stmt.where(Territory.parent_id.is_(None))
    if f.mine:
        stmt = stmt.where(Territory.owner_id == user.id)
    return stmt


async def territory_out(db: AsyncSession, t: Territory, user: CurrentUser) -> TerritoryOut:
    from app.modules.auth.models import User

    out = TerritoryOut.model_validate(t)
    out.can_edit = can_edit(t, user)
    names = dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(
        [i for i in (t.owner_id, t.assignee_id) if i])))).all()) if (t.owner_id or t.assignee_id) else {}
    out.owner_name = names.get(t.owner_id)
    out.assignee_name = names.get(t.assignee_id)
    if t.parent_id:
        out.parent_name = await db.scalar(select(Territory.name).where(Territory.id == t.parent_id))
    children = await db.scalars(territory_query(TerritoryFilters(parent_id=t.id), user).order_by(Territory.name))
    out.children = [TerritoryListItem.model_validate(c) for c in children]
    out.geojson = await geojson_of(db, Territory.geometry, Territory.id, t.id)
    return out


# ============================================================================= territories: rules

def _num(rule: dict, key: str, *, lo: float, hi: float, default: float | None = None) -> float:
    raw = rule.get(key, default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Rule field '{key}' must be a number")
    if not lo <= value <= hi:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Rule field '{key}' must be between {lo} and {hi}")
    return value


def _uuid(rule: dict, key: str) -> uuid.UUID | None:
    raw = rule.get(key)
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Rule field '{key}' must be an id")


async def normalize_rule(db: AsyncSession, rule_type: str, rule: dict) -> dict:
    """Validate the configurable membership rule and keep only the keys that rule type uses."""
    if rule_type in ("explicit", "boundary"):
        return {}
    if rule_type == "radius":
        out: dict = {"radius_miles": _num(rule, "radius_miles", lo=0.01, hi=200)}
        node_id, property_id = _uuid(rule, "node_id"), _uuid(rule, "property_id")
        if node_id:
            await get_obj(db, Node, node_id, "Node")
            out["node_id"] = str(node_id)
        elif property_id:
            out["property_id"] = str(property_id)
        else:
            out["lat"] = _num(rule, "lat", lo=-90, hi=90)
            out["lng"] = _num(rule, "lng", lo=-180, hi=180)
        await resolve_center(db, lat=out.get("lat"), lng=out.get("lng"), property_id=property_id, node_id=node_id)
        return out
    if rule_type == "corridor":
        corridor_id = _uuid(rule, "corridor_id")
        if not corridor_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose a corridor")
        c = await get_obj(db, Corridor, corridor_id, "Corridor")
        if not c.has_geometry:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The corridor has no line geometry yet")
        return {"corridor_id": str(corridor_id),
                "buffer_ft": _num(rule, "buffer_ft", lo=1, hi=26_400, default=DEFAULT_CORRIDOR_BUFFER_FT)}
    if rule_type in ("county", "city"):
        values = rule.get("values") or []
        if isinstance(values, str):
            values = values.split(",")
        values = [str(v).strip() for v in values if str(v).strip()]
        if not values:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Add at least one {rule_type}")
        out = {"values": values}
        if rule.get("state"):
            out["state"] = str(rule["state"]).strip()
        return out
    if rule_type == "saved_query":
        from app.modules.search.models import SavedView

        view_id = _uuid(rule, "saved_view_id")
        view = await db.get(SavedView, view_id) if view_id else None
        if not view or view.deleted_at or view.module != "properties":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose a saved property view")
        return {"saved_view_id": str(view.id), "saved_view_name": view.name}
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown rule type")


def _filters_from_params(params: dict):
    """Saved view params are URL strings; coerce them to PropertyFilters field types."""
    from app.modules.properties.service import PropertyFilters

    kwargs: dict = {}
    for name, hint in typing.get_type_hints(PropertyFilters).items():
        raw = params.get(name)
        if raw in (None, "", []):
            continue
        values = raw if isinstance(raw, list) else [raw]
        h = str(hint)
        try:
            if "list" in h:
                conv = uuid.UUID if "UUID" in h else str
                kwargs[name] = [conv(str(v)) for v in values]
            elif "float" in h:
                kwargs[name] = float(values[0])
            elif "int" in h:
                kwargs[name] = int(float(values[0]))
            else:
                kwargs[name] = str(values[0])
        except (TypeError, ValueError):
            continue
    return PropertyFilters(**kwargs)


async def rule_select(db: AsyncSession, t: Territory) -> Select | None:
    """SELECT properties.id matching the territory rule; None for explicit (manual-only) territories."""
    from app.modules.properties.models import Property

    rule = t.rule or {}
    base = select(Property.id).where(Property.deleted_at.is_(None))
    loc = cast(Property.location, Geography)
    if t.rule_type == "explicit":
        return None
    if t.rule_type == "boundary":
        if not t.has_geometry:
            return base.where(false())
        boundary = select(Territory.geometry).where(Territory.id == t.id).scalar_subquery()
        return base.where(Property.location.is_not(None), func.ST_Contains(boundary, Property.location))
    if t.rule_type == "radius":
        try:
            center = await resolve_center(db, lat=rule.get("lat"), lng=rule.get("lng"),
                                          property_id=_uuid(rule, "property_id"), node_id=_uuid(rule, "node_id"))
        except HTTPException:
            center = None
        if not center:
            return base.where(false())
        return base.where(func.ST_DWithin(loc, cast(geo.point(*center), Geography),
                                          float(rule.get("radius_miles") or 0) * geo.M_PER_MILE))
    if t.rule_type == "corridor":
        line = select(Corridor.geometry).where(Corridor.id == _uuid(rule, "corridor_id")).scalar_subquery()
        return base.where(func.ST_DWithin(loc, cast(line, Geography),
                                          float(rule.get("buffer_ft") or DEFAULT_CORRIDOR_BUFFER_FT) * geo.M_PER_FT))
    if t.rule_type in ("county", "city"):
        col = Property.county if t.rule_type == "county" else Property.city
        values = [v.lower() for v in rule.get("values") or []]
        stmt = base.where(func.lower(func.trim(col)).in_(values) if values else false())
        if rule.get("state"):
            stmt = stmt.where(func.lower(Property.state) == str(rule["state"]).lower())
        return stmt
    if t.rule_type == "saved_query":
        from app.modules.properties.service import build_query
        from app.modules.search.models import SavedView

        view = await db.get(SavedView, _uuid(rule, "saved_view_id")) if rule.get("saved_view_id") else None
        if not view or view.deleted_at:
            return base.where(false())
        return build_query(_filters_from_params(view.params or {})).with_only_columns(Property.id)
    return base.where(false())


def _to_geometry(geography_expr):
    """geography -> geometry(4326) as a SQL expression assigned to the column at flush."""
    return func.ST_SetSRID(func.geometry(geography_expr), 4326)


async def _refresh_display_geometry(db: AsyncSession, t: Territory) -> None:
    """Radius / corridor rules store their computed buffer so the territory can be drawn and used as a spatial filter."""
    rule = t.rule or {}
    if t.rule_type == "radius":
        try:
            center = await resolve_center(db, lat=rule.get("lat"), lng=rule.get("lng"),
                                          property_id=_uuid(rule, "property_id"), node_id=_uuid(rule, "node_id"))
        except HTTPException:
            center = None
        if center:
            meters = float(rule.get("radius_miles") or 0) * geo.M_PER_MILE
            t.geometry = _to_geometry(func.ST_Buffer(cast(geo.point(*center), Geography), meters))
            t.has_geometry = True
    elif t.rule_type == "corridor":
        line = select(Corridor.geometry).where(Corridor.id == _uuid(rule, "corridor_id")).scalar_subquery()
        meters = float(rule.get("buffer_ft") or DEFAULT_CORRIDOR_BUFFER_FT) * geo.M_PER_FT
        t.geometry = _to_geometry(func.ST_Buffer(cast(line, Geography), meters))
        t.has_geometry = True
    elif t.rule_type != "boundary":
        t.geometry = None
        t.has_geometry = False


async def _member_count(db: AsyncSession, territory_id: uuid.UUID) -> int:
    return int(await db.scalar(select(func.count()).select_from(TerritoryMember)
                               .where(TerritoryMember.territory_id == territory_id)) or 0)


async def recompute(db: AsyncSession, t: Territory) -> RecomputeOut:
    """Re-evaluate rule membership. Manual members are always kept. Does not commit."""
    await _refresh_display_geometry(db, t)
    await db.flush()
    stmt = await rule_select(db, t)
    added = removed = 0
    if stmt is not None:
        removed = (await db.execute(
            delete(TerritoryMember).where(TerritoryMember.territory_id == t.id, TerritoryMember.source == "rule",
                                          TerritoryMember.property_id.not_in(stmt))
        )).rowcount or 0
        sub = stmt.subquery()
        added = (await db.execute(
            pg_insert(TerritoryMember)
            .from_select(["id", "territory_id", "property_id", "source", "added_at"],
                         select(func.gen_random_uuid(), literal(t.id), sub.c.id, literal("rule"), func.now()))
            .on_conflict_do_nothing(index_elements=["territory_id", "property_id"])
        )).rowcount or 0
    t.member_count = await _member_count(db, t.id)
    t.last_computed_at = utcnow()
    return RecomputeOut(added=max(added, 0), removed=max(removed, 0), total=t.member_count)


async def _check_parent(db: AsyncSession, t_id: uuid.UUID | None, parent_id: uuid.UUID | None, user: CurrentUser) -> None:
    if not parent_id:
        return
    await get_visible(db, parent_id, user)
    cursor, seen = parent_id, set()
    while cursor and cursor not in seen:
        if cursor == t_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A territory cannot be nested inside itself")
        seen.add(cursor)
        cursor = await db.scalar(select(Territory.parent_id).where(Territory.id == cursor))


def _check_owner_change(owner_id: uuid.UUID | None, user: CurrentUser) -> None:
    if owner_id and owner_id != user.id and not (user.is_admin or user.can("territories", "approve")):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only approvers can assign a territory to another owner")


async def create_territory(db: AsyncSession, data: TerritoryIn, actor: CurrentUser) -> Territory:
    _check_owner_change(data.owner_id, actor)
    await _check_parent(db, None, data.parent_id, actor)
    if data.rule_type == "boundary" and not data.geometry:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Boundary territories need a polygon (GeoJSON)")
    rule = await normalize_rule(db, data.rule_type, data.rule)
    t = Territory(**data.model_dump(exclude={"rule", "geometry", "owner_id"}), rule=rule,
                  owner_id=data.owner_id or actor.id, created_by_id=actor.id, updated_by_id=actor.id)
    if data.rule_type == "boundary":
        await _apply_polygon(db, t, data.geometry)
    db.add(t)
    await db.flush()
    result = await recompute(db, t)
    await audit.record(db, actor=actor, action="territory.created", entity_type="territory", entity_id=t.id,
                       summary=t.name, changes={"rule_type": t.rule_type, "rule": rule, "members": result.total},
                       ip_address=actor.ip_address)
    await db.commit()
    return t


async def update_territory(db: AsyncSession, t: Territory, data: TerritoryUpdate, actor: CurrentUser) -> Territory:
    values = data.model_dump(exclude_unset=True, exclude={"geometry"})
    if "owner_id" in values:
        if values["owner_id"] is None:
            values.pop("owner_id")
        else:
            _check_owner_change(values["owner_id"], actor)
    if "parent_id" in values:
        await _check_parent(db, t.id, values["parent_id"], actor)
    rule_type = values.get("rule_type", t.rule_type)
    if "rule_type" in values or "rule" in values:
        values["rule"] = await normalize_rule(db, rule_type, values.get("rule", t.rule) or {})
    changes = audit.diff(t, values)
    for k, v in values.items():
        setattr(t, k, v)
    if data.geometry and rule_type == "boundary":
        changes["geometry"] = await _apply_polygon(db, t, data.geometry)
    if rule_type == "boundary" and not t.has_geometry:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Boundary territories need a polygon (GeoJSON)")
    if not changes:
        return t
    t.updated_by_id = actor.id
    if {"rule_type", "rule", "geometry"} & changes.keys():
        result = await recompute(db, t)
        changes["members"] = {"added": result.added, "removed": result.removed}
    await audit.record(db, actor=actor, action="territory.updated", entity_type="territory", entity_id=t.id,
                       summary=t.name, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return t


async def archive_territory(db: AsyncSession, t: Territory, actor: CurrentUser) -> None:
    await db.execute(update(Territory).where(Territory.parent_id == t.id).values(parent_id=t.parent_id))
    t.deleted_at = utcnow()
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="territory.archived", entity_type="territory", entity_id=t.id,
                       summary=t.name, ip_address=actor.ip_address)
    await db.commit()


async def recompute_and_commit(db: AsyncSession, t: Territory, actor: CurrentUser) -> RecomputeOut:
    result = await recompute(db, t)
    await audit.record(db, actor=actor, action="territory.recomputed", entity_type="territory", entity_id=t.id,
                       summary=f"{result.total} members (+{result.added} / -{result.removed})",
                       changes=result.model_dump(), ip_address=actor.ip_address)
    await db.commit()
    return result


# ============================================================================= territories: members

def members_query(territory_id: uuid.UUID, q: str | None, source: list[str] | None) -> Select:
    from app.modules.properties.models import Property

    stmt = (
        select(TerritoryMember.property_id, TerritoryMember.source, TerritoryMember.added_at, Property.name,
               Property.address_line, Property.city, Property.state, Property.county, Property.property_type,
               Property.status)
        .join(Property, Property.id == TerritoryMember.property_id)
        .where(TerritoryMember.territory_id == territory_id, Property.deleted_at.is_(None))
    )
    stmt = apply_search(stmt, q, [Property.name, Property.address_line, Property.city, Property.county])
    return in_filter(stmt, TerritoryMember.source, source)


async def add_members(db: AsyncSession, t: Territory, data: MembersIn, actor: CurrentUser) -> int:
    """Manual assignment (also used by bulk parcel/property selection). Manual members survive rule recomputes."""
    from app.modules.parcels.models import PropertyParcel
    from app.modules.properties.models import Property

    ids = set(data.property_ids)
    if data.parcel_ids:
        ids |= set(await db.scalars(select(PropertyParcel.property_id).where(PropertyParcel.parcel_id.in_(data.parcel_ids))))
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "No properties to add (parcels may not be linked to properties yet)")
    valid = list(await db.scalars(select(Property.id).where(Property.id.in_(ids), Property.deleted_at.is_(None))))
    if valid:
        stmt = pg_insert(TerritoryMember).values([
            {"id": uuid.uuid4(), "territory_id": t.id, "property_id": pid, "source": "manual", "added_at": utcnow(),
             "added_by_id": actor.id} for pid in valid
        ])
        await db.execute(stmt.on_conflict_do_update(index_elements=["territory_id", "property_id"],
                                                    set_={"source": "manual", "added_by_id": actor.id}))
    t.member_count = await _member_count(db, t.id)
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="territory.members_added", entity_type="territory", entity_id=t.id,
                       summary=f"{len(valid)} properties assigned manually",
                       changes={"property_ids": [str(i) for i in valid]}, ip_address=actor.ip_address)
    await db.commit()
    return len(valid)


async def remove_member(db: AsyncSession, t: Territory, property_id: uuid.UUID, actor: CurrentUser) -> None:
    res = await db.execute(delete(TerritoryMember).where(TerritoryMember.territory_id == t.id,
                                                         TerritoryMember.property_id == property_id))
    if not res.rowcount:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property is not a member of this territory")
    t.member_count = await _member_count(db, t.id)
    await audit.record(db, actor=actor, action="territory.member_removed", entity_type="territory", entity_id=t.id,
                       changes={"property_id": str(property_id)}, ip_address=actor.ip_address)
    await db.commit()


async def overlaps(db: AsyncSession, t: Territory, user: CurrentUser) -> list[OverlapOut]:
    mine = select(TerritoryMember.property_id).where(TerritoryMember.territory_id == t.id)
    rows = await db.execute(
        select(Territory.id, Territory.name, Territory.rule_type, func.count(TerritoryMember.id))
        .join(TerritoryMember, TerritoryMember.territory_id == Territory.id)
        .where(Territory.id != t.id, Territory.deleted_at.is_(None), visible_clause(user),
               TerritoryMember.property_id.in_(mine))
        .group_by(Territory.id, Territory.name, Territory.rule_type)
        .order_by(func.count(TerritoryMember.id).desc())
    )
    return [OverlapOut(id=i, name=n, rule_type=r, shared=c) for i, n, r, c in rows.all()]


async def for_property(db: AsyncSession, property_id: uuid.UUID, user: CurrentUser) -> list[Territory]:
    stmt = (
        select(Territory)
        .join(TerritoryMember, TerritoryMember.territory_id == Territory.id)
        .where(TerritoryMember.property_id == property_id, Territory.deleted_at.is_(None), visible_clause(user))
        .order_by(Territory.name)
    )
    return list(await db.scalars(stmt))


# ============================================================================= event-driven membership

async def evaluate_property(db: AsyncSession, property_id: uuid.UUID, changed: set[str] | None = None) -> None:
    """Re-evaluate rule-based territories for one property (runs inside the caller's transaction; no commit)."""
    await db.flush()
    stmt = select(Territory).where(Territory.deleted_at.is_(None), Territory.rule_type != "explicit")
    if changed is not None and not (GEO_FIELDS & changed):
        stmt = stmt.where(Territory.rule_type == "saved_query")
    from app.modules.properties.models import Property

    for t in list(await db.scalars(stmt)):
        rule = await rule_select(db, t)
        if rule is None:
            continue
        matches = bool(await db.scalar(rule.where(Property.id == property_id).limit(1)))
        current = await db.scalar(select(TerritoryMember.source).where(TerritoryMember.territory_id == t.id,
                                                                       TerritoryMember.property_id == property_id))
        if matches and current is None:
            await db.execute(pg_insert(TerritoryMember).values(
                id=uuid.uuid4(), territory_id=t.id, property_id=property_id, source="rule", added_at=utcnow(),
            ).on_conflict_do_nothing(index_elements=["territory_id", "property_id"]))
            t.member_count = (t.member_count or 0) + 1
        elif not matches and current == "rule":
            await db.execute(delete(TerritoryMember).where(TerritoryMember.territory_id == t.id,
                                                           TerritoryMember.property_id == property_id))
            t.member_count = max((t.member_count or 1) - 1, 0)


async def reassign_owner(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None) -> None:
    if not reassign_to_id:
        return
    await db.execute(update(Territory).where(Territory.owner_id == user_id).values(owner_id=reassign_to_id))
    await db.execute(update(Territory).where(Territory.assignee_id == user_id).values(assignee_id=reassign_to_id))


# ============================================================================= geography-driven property search

@dataclass
class GeoPropertyFilters:
    q: str | None = None
    corridor_id: uuid.UUID | None = None
    buffer_ft: float | None = None
    node_id: uuid.UUID | None = None
    radius_miles: float | None = None
    min_traffic: int | None = None
    traffic_radius_miles: float | None = None
    growth_kind: list[str] | None = None
    growth_radius_miles: float | None = None
    territory_id: uuid.UUID | None = None


async def geo_property_query(db: AsyncSession, f: GeoPropertyFilters) -> Select:
    from app.modules.properties.models import Property

    loc = cast(Property.location, Geography)
    dist = cast(null(), Float)
    stmt_where = [Property.deleted_at.is_(None)]
    if f.corridor_id:
        c = await get_obj(db, Corridor, f.corridor_id, "Corridor")
        if not c.has_geometry:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The corridor has no line geometry yet")
        line = cast(select(Corridor.geometry).where(Corridor.id == c.id).scalar_subquery(), Geography)
        stmt_where.append(func.ST_DWithin(loc, line, (f.buffer_ft or DEFAULT_CORRIDOR_BUFFER_FT) * geo.M_PER_FT))
        dist = func.ST_Distance(loc, line) / geo.M_PER_MILE
    if f.node_id:
        center = await resolve_center(db, lat=None, lng=None, property_id=None, node_id=f.node_id)
        pt = cast(geo.point(*center), Geography)
        stmt_where.append(func.ST_DWithin(loc, pt, (f.radius_miles or 1) * geo.M_PER_MILE))
        dist = func.ST_Distance(loc, pt) / geo.M_PER_MILE
    if f.min_traffic:
        near_counts = (
            select(TrafficCount.id)
            .where(TrafficCount.deleted_at.is_(None), TrafficCount.count >= f.min_traffic,
                   TrafficCount.location.is_not(None),
                   func.ST_DWithin(cast(TrafficCount.location, Geography), loc,
                                   (f.traffic_radius_miles or 0.25) * geo.M_PER_MILE))
            .correlate(Property)
            .exists()
        )
        stmt_where.append(or_(Property.traffic_count >= f.min_traffic, near_counts))
    if f.growth_kind:
        near_growth = (
            select(GrowthRecord.id)
            .where(GrowthRecord.deleted_at.is_(None), GrowthRecord.kind.in_(f.growth_kind),
                   func.ST_DWithin(cast(GrowthRecord.location, Geography), loc,
                                   (f.growth_radius_miles or 1) * geo.M_PER_MILE))
            .correlate(Property)
            .exists()
        )
        stmt_where.append(near_growth)
    if f.territory_id:
        stmt_where.append(Property.id.in_(select(TerritoryMember.property_id)
                                          .where(TerritoryMember.territory_id == f.territory_id)))
    stmt = select(Property.id, Property.name, Property.address_line, Property.city, Property.state,
                  Property.property_type, Property.status, Property.traffic_count, dist.label("distance_miles")
                  ).where(*stmt_where)
    return apply_search(stmt, f.q, [Property.name, Property.address_line, Property.city, Property.county])
