import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from geoalchemy2 import Geography
from geoalchemy2.elements import WKTElement
from sqlalchemy import Select, and_, cast, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.common import audit, provenance
from app.common.normalize import normalize_apn
from app.common.provenance import ProvenanceIn
from app.common.query import in_filter, range_filter
from app.core.database import Base
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.parcels import geo
from app.modules.parcels.models import (
    BUILDING_MATERIAL,
    PARCEL_MATERIAL,
    SPACE_MATERIAL,
    Building,
    Parcel,
    ParcelVersion,
    PropertyParcel,
    Space,
)
from app.modules.parcels.schemas import (
    AdjacencyOut,
    AdjacentParcel,
    AssemblageGroup,
    AssemblageOut,
    BuildingIn,
    BuildingOut,
    BuildingUpdate,
    BulkAssociateIn,
    BulkAssociateOut,
    BulkPreviewParcel,
    LinkedProperty,
    OwnerRef,
    ParcelCreate,
    ParcelListItem,
    ParcelOut,
    ParcelUpdate,
    PropertyParcelIn,
    PropertyParcelOut,
    PropertyParcelUpdate,
    SpaceIn,
    SpaceUpdate,
)

ENTITY = "parcel"
ADJACENCY_TOLERANCE_M = 1.0
OwnerKey = tuple[str, uuid.UUID]


# ----------------------------------------------------------------------------- filters

@dataclass
class ParcelFilters:
    q: str | None = None
    county: list[str] | None = None
    state: list[str] | None = None
    min_acres: float | None = None
    max_acres: float | None = None
    has_geometry: bool | None = None
    property_id: uuid.UUID | None = None
    linked: bool | None = None
    bbox: str | None = None
    near_lat: float | None = None
    near_lng: float | None = None
    radius_miles: float | None = None
    territory_id: uuid.UUID | None = None
    ids: list[uuid.UUID] | None = None


def build_query(f: ParcelFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Parcel).where(Parcel.deleted_at.is_(None))
    if f.q:
        for term in f.q.split():
            conds = [col.ilike(f"%{term}%") for col in
                     (Parcel.apn, Parcel.county, Parcel.legal_description, Parcel.situs_address)]
            norm = normalize_apn(term)
            if norm:
                conds.append(Parcel.apn_normalized.ilike(f"%{norm}%"))
            stmt = stmt.where(or_(*conds))
    if "county" not in skip:
        stmt = in_filter(stmt, Parcel.county, f.county)
    if "state" not in skip:
        stmt = in_filter(stmt, Parcel.state, f.state)
    stmt = in_filter(stmt, Parcel.id, f.ids)
    stmt = range_filter(stmt, Parcel.acreage, f.min_acres, f.max_acres)
    if f.has_geometry is not None:
        stmt = stmt.where(Parcel.has_geometry.is_(f.has_geometry))
    if f.property_id:
        stmt = stmt.where(Parcel.id.in_(select(PropertyParcel.parcel_id).where(PropertyParcel.property_id == f.property_id)))
    if f.linked is not None:
        linked = Parcel.id.in_(select(PropertyParcel.parcel_id))
        stmt = stmt.where(linked if f.linked else ~linked)
    if f.bbox:
        stmt = stmt.where(func.ST_Intersects(Parcel.geometry, geo.envelope(f.bbox)))
    if f.near_lat is not None and f.near_lng is not None and f.radius_miles:
        stmt = stmt.where(func.ST_DWithin(cast(Parcel.geometry, Geography), cast(geo.point(f.near_lat, f.near_lng), Geography),
                                          f.radius_miles * geo.M_PER_MILE))
    if f.territory_id:
        from app.modules.territories.models import Territory

        boundary = select(Territory.geometry).where(Territory.id == f.territory_id).scalar_subquery()
        stmt = stmt.where(func.ST_Intersects(Parcel.geometry, boundary))
    return stmt


def _property_count():
    return (
        select(func.count(PropertyParcel.id)).where(PropertyParcel.parcel_id == Parcel.id).correlate(Parcel).scalar_subquery()
    )


def list_stmt(f: ParcelFilters) -> Select:
    return build_query(f).add_columns(_property_count().label("property_count"))


def list_items(rows) -> list[ParcelListItem]:
    return [ParcelListItem.model_validate(p).model_copy(update={"property_count": int(c or 0)}) for p, c in rows]


# ----------------------------------------------------------------------------- parcels

async def get(db: AsyncSession, parcel_id: uuid.UUID) -> Parcel:
    p = await db.get(Parcel, parcel_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Parcel not found")
    return p


async def to_out(db: AsyncSession, p: Parcel) -> ParcelOut:
    gj, area, count = (await db.execute(
        select(func.ST_AsGeoJSON(Parcel.geometry, 7), func.ST_Area(cast(Parcel.geometry, Geography)), _property_count())
        .where(Parcel.id == p.id)
    )).one()
    out = ParcelOut.model_validate(p)
    out.property_count = int(count or 0)
    out.geojson = geo.loads(gj)
    out.geometry_acreage = round(float(area) / geo.SQ_M_PER_ACRE, 4) if area else None
    out.provenance = {
        k: provenance.ObservationOut.model_validate(v)
        for k, v in (await provenance.current_observations(db, ENTITY, p.id)).items()
    }
    return out


async def find_duplicates(db: AsyncSession, county: str, apn_normalized: str, exclude: uuid.UUID | None = None) -> list[Parcel]:
    stmt = select(Parcel).where(
        Parcel.deleted_at.is_(None),
        func.lower(func.trim(Parcel.county)) == county.strip().lower(),
        Parcel.apn_normalized == apn_normalized,
    )
    if exclude:
        stmt = stmt.where(Parcel.id != exclude)
    return list(await db.scalars(stmt.limit(5)))


def _duplicate_error(dupes: list[Parcel]) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        {
            "message": "A parcel with this county and APN already exists. Review before merging.",
            "duplicates": [{"id": str(d.id), "apn": d.apn, "county": d.county, "situs_address": d.situs_address,
                            "acreage": d.acreage} for d in dupes],
        },
    )


def _prov(prov: ProvenanceIn, source: str | None, observed_on) -> ProvenanceIn:
    """Parcel `source`/`observed_on` columns feed the field observations when no explicit provenance is given."""
    upd = {}
    if source and prov.source == "Manual entry":
        upd["source"] = source
    if observed_on and not prov.observed_on:
        upd["observed_on"] = observed_on
    return prov.model_copy(update=upd) if upd else prov


def _apply_geometry(p: Parcel, g: geo.PolygonResult | None) -> None:
    if g:
        p.geometry = WKTElement(g.wkt, srid=4326)
        p.centroid = geo.point(g.centroid_lat, g.centroid_lng)
        p.has_geometry = True
        p.centroid_lat = round(g.centroid_lat, 7)
        p.centroid_lng = round(g.centroid_lng, 7)
    else:
        p.geometry = None
        p.centroid = None
        p.has_geometry = False
        p.centroid_lat = None
        p.centroid_lng = None


async def _snapshot(db: AsyncSession, p: Parcel, changed: list[str], actor: CurrentUser) -> None:
    """Version row with the parcel's current legal description + geometry (read in SQL; geometry stays in PostGIS)."""
    await db.flush()
    current = await db.scalar(select(func.coalesce(func.max(ParcelVersion.version), 0)).where(ParcelVersion.parcel_id == p.id))
    db.add(ParcelVersion(
        parcel_id=p.id,
        version=int(current or 0) + 1,
        legal_description=p.legal_description,
        geometry=select(Parcel.geometry).where(Parcel.id == p.id).scalar_subquery(),
        acreage=p.acreage,
        changed_fields=changed,
        source=p.source,
        observed_on=p.observed_on,
        recorded_by_id=actor.id,
    ))


async def create(db: AsyncSession, data: ParcelCreate, actor: CurrentUser, *, force: bool = False) -> Parcel:
    apn_norm = normalize_apn(data.apn)
    if not apn_norm:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "APN must contain letters or digits")
    dupes = await find_duplicates(db, data.county, apn_norm)
    if dupes and not force:
        raise _duplicate_error(dupes)

    shape = await geo.polygon_from_geojson(db, data.geometry) if data.geometry else None
    values = data.model_dump(exclude={"provenance", "geometry"})
    values["county"] = values["county"].strip()
    p = Parcel(**values, apn_normalized=apn_norm, created_by_id=actor.id, updated_by_id=actor.id)
    _apply_geometry(p, shape)
    if p.acreage is None and shape:
        p.acreage = round(shape.acres, 4)
    db.add(p)
    await db.flush()

    prov = _prov(data.provenance, data.source, data.observed_on)
    for field in PARCEL_MATERIAL:
        value = getattr(p, field)
        if value is not None:
            await provenance.observe(db, entity_type=ENTITY, entity_id=p.id, field=field, value=value, prov=prov,
                                     actor_id=actor.id)
    await _snapshot(db, p, ["created"], actor)
    await audit.record(db, actor=actor, action="parcel.created", entity_type=ENTITY, entity_id=p.id,
                       summary=f"{p.county} APN {p.apn}", ip_address=actor.ip_address,
                       changes={"possible_duplicate_of": [str(d.id) for d in dupes]} if dupes else None)
    await db.commit()
    return p


async def update(db: AsyncSession, p: Parcel, data: ParcelUpdate, actor: CurrentUser) -> Parcel:
    values = data.model_dump(exclude_unset=True, exclude={"provenance", "geometry", "clear_geometry"})
    if values.get("county"):
        values["county"] = values["county"].strip()
    new_norm = p.apn_normalized
    if "apn" in values or "county" in values:
        new_norm = normalize_apn(values.get("apn", p.apn)) or ""
        if not new_norm:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "APN must contain letters or digits")
        dupes = await find_duplicates(db, values.get("county", p.county), new_norm, exclude=p.id)
        if dupes:
            raise _duplicate_error(dupes)

    shape = await geo.polygon_from_geojson(db, data.geometry) if data.geometry else None
    had_geometry = p.has_geometry
    prov = _prov(data.provenance, values.get("source", p.source), values.get("observed_on", p.observed_on))
    changes = await provenance.apply_material(
        db, p, entity_type=ENTITY, data=values, material_fields=PARCEL_MATERIAL, prov=prov, actor_id=actor.id,
    )
    p.apn_normalized = new_norm
    geometry_changed = False
    if shape:
        _apply_geometry(p, shape)
        geometry_changed = True
        changes["geometry"] = {"from": "polygon" if had_geometry else None, "to": f"polygon ({shape.acres:.4f} ac)"}
    elif data.clear_geometry and had_geometry:
        _apply_geometry(p, None)
        geometry_changed = True
        changes["geometry"] = {"from": "polygon", "to": None}
    if not changes:
        return p

    p.updated_by_id = actor.id
    if geometry_changed or "legal_description" in changes:
        await _snapshot(db, p, [k for k in changes if k in {"geometry", "legal_description", "acreage"}], actor)
    await audit.record(db, actor=actor, action="parcel.updated", entity_type=ENTITY, entity_id=p.id, changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return p


async def archive(db: AsyncSession, p: Parcel, actor: CurrentUser) -> None:
    p.deleted_at = utcnow()
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="parcel.archived", entity_type=ENTITY, entity_id=p.id,
                       summary=f"{p.county} APN {p.apn}", ip_address=actor.ip_address)
    await db.commit()


async def merge(db: AsyncSession, source: Parcel, target: Parcel, actor: CurrentUser) -> Parcel:
    """Human-approved merge of a reviewed duplicate: links and buildings move to `target`, `source` is archived."""
    if source.id == target.id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Cannot merge a parcel into itself")
    existing = set(await db.scalars(select(PropertyParcel.property_id).where(PropertyParcel.parcel_id == target.id)))
    moved = 0
    for link in list(await db.scalars(select(PropertyParcel).where(PropertyParcel.parcel_id == source.id))):
        if link.property_id in existing:
            await db.delete(link)
        else:
            link.parcel_id = target.id
            link.updated_by_id = actor.id
            moved += 1
    await db.execute(update(Building).where(Building.parcel_id == source.id).values(parcel_id=target.id))
    source.deleted_at = utcnow()
    source.updated_by_id = actor.id
    source.facts = {**(source.facts or {}), "merged_into": str(target.id)}
    await audit.record(db, actor=actor, action="parcel.merged", entity_type=ENTITY, entity_id=source.id,
                       summary=f"Merged into {target.county} APN {target.apn}",
                       changes={"into": str(target.id), "links_moved": moved}, ip_address=actor.ip_address)
    await audit.record(db, actor=actor, action="parcel.merge_received", entity_type=ENTITY, entity_id=target.id,
                       summary=f"Absorbed {source.county} APN {source.apn}", changes={"from": str(source.id)},
                       ip_address=actor.ip_address)
    await db.commit()
    return target


async def versions(db: AsyncSession, parcel_id: uuid.UUID) -> list[dict]:
    rows = await db.execute(
        select(ParcelVersion, func.ST_AsGeoJSON(ParcelVersion.geometry, 7))
        .where(ParcelVersion.parcel_id == parcel_id)
        .order_by(ParcelVersion.version.desc())
    )
    return [{**{c: getattr(v, c) for c in ("id", "version", "legal_description", "acreage", "changed_fields", "source",
                                            "observed_on", "recorded_at", "recorded_by_id")}, "geojson": geo.loads(gj)}
            for v, gj in rows.all()]


# ----------------------------------------------------------------------------- GeoJSON

async def feature(db: AsyncSession, p: Parcel) -> dict:
    gj = await db.scalar(select(func.ST_AsGeoJSON(Parcel.geometry, 7)).where(Parcel.id == p.id))
    return {
        "type": "Feature",
        "id": str(p.id),
        "geometry": geo.loads(gj),
        "properties": {"id": str(p.id), "apn": p.apn, "county": p.county, "acreage": p.acreage,
                       "situs_address": p.situs_address},
    }


async def feature_collection(db: AsyncSession, f: ParcelFilters, limit: int) -> dict:
    stmt = (
        build_query(f)
        .where(Parcel.has_geometry.is_(True))
        .with_only_columns(Parcel.id, Parcel.apn, Parcel.county, Parcel.acreage, Parcel.situs_address,
                           func.ST_AsGeoJSON(Parcel.geometry, 6))
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "id": str(pid), "geometry": geo.loads(gj),
             "properties": {"id": str(pid), "apn": apn, "county": county, "acreage": acreage, "situs_address": situs}}
            for pid, apn, county, acreage, situs, gj in rows
        ],
        "truncated": len(rows) >= limit,
    }


# ----------------------------------------------------------------------------- ownership (read-only, optional module)

async def owners_for_parcels(
    db: AsyncSession, parcel_ids: list[uuid.UUID]
) -> tuple[dict[uuid.UUID, set[OwnerKey]], bool]:
    """Current owners per parcel via property_parcels -> ownership_interests. Returns (map, ownership_available)."""
    oi = Base.metadata.tables.get("ownership_interests")
    if oi is None:
        try:
            import app.modules.ownership.models  # noqa: F401
        except ImportError:
            return {}, False
        oi = Base.metadata.tables.get("ownership_interests")
        if oi is None:
            return {}, False
    if not parcel_ids:
        return {}, True
    stmt = (
        select(PropertyParcel.parcel_id, oi.c.owner_kind, oi.c.owner_person_id, oi.c.owner_organization_id)
        .join(oi, oi.c.property_id == PropertyParcel.property_id)
        .where(PropertyParcel.parcel_id.in_(parcel_ids),
               or_(oi.c.effective_to.is_(None), oi.c.effective_to >= func.current_date()))
    )
    if "deleted_at" in oi.c:
        stmt = stmt.where(oi.c.deleted_at.is_(None))
    out: dict[uuid.UUID, set[OwnerKey]] = {}
    for parcel_id, kind, person_id, org_id in (await db.execute(stmt)).all():
        owner_id = person_id if kind == "person" else org_id
        if owner_id:
            out.setdefault(parcel_id, set()).add((kind, owner_id))
    return out, True


async def owner_refs(db: AsyncSession, keys: set[OwnerKey]) -> list[OwnerRef]:
    names: dict[OwnerKey, str | None] = {}
    for kind, table, col in (("person", "people", "full_name"), ("organization", "organizations", "name")):
        ids = [i for k, i in keys if k == kind]
        t = Base.metadata.tables.get(table)
        if ids and t is not None and col in t.c:
            for oid, name in (await db.execute(select(t.c.id, t.c[col]).where(t.c.id.in_(ids)))).all():
                names[(kind, oid)] = name
    return sorted((OwnerRef(kind=k, id=i, name=names.get((k, i))) for k, i in keys), key=lambda o: (o.name or "").lower())


# ----------------------------------------------------------------------------- adjacency & assemblage

def _tolerance_deg(meters: float) -> float:
    return meters / geo.M_PER_DEGREE


async def adjacent(db: AsyncSession, p: Parcel, user: CurrentUser, tolerance_m: float = ADJACENCY_TOLERANCE_M) -> AdjacencyOut:
    if not p.has_geometry:
        return AdjacencyOut(items=[])
    me = aliased(Parcel)
    stmt = (
        select(Parcel.id, Parcel.county, Parcel.apn, Parcel.situs_address, Parcel.acreage,
               func.ST_Distance(cast(Parcel.geometry, Geography), cast(me.geometry, Geography)).label("distance_m"),
               func.ST_Touches(Parcel.geometry, me.geometry).label("touches"))
        .select_from(Parcel)
        .join(me, me.id == p.id)
        .where(Parcel.id != p.id, Parcel.deleted_at.is_(None), Parcel.has_geometry.is_(True),
               func.ST_DWithin(Parcel.geometry, me.geometry, _tolerance_deg(tolerance_m)))
        .order_by("distance_m")
        .limit(200)
    )
    rows = (await db.execute(stmt)).all()
    items = [AdjacentParcel(id=r.id, county=r.county, apn=r.apn, situs_address=r.situs_address, acreage=r.acreage,
                            distance_m=round(float(r.distance_m or 0), 2), touches=bool(r.touches)) for r in rows]
    if not user.can("ownership", "view"):
        return AdjacencyOut(items=items, owners_hidden=True)

    owners, _ = await owners_for_parcels(db, [p.id] + [i.id for i in items])
    mine = owners.get(p.id, set())
    all_keys = set(mine)
    for i in items:
        all_keys |= owners.get(i.id, set()) & mine
    refs = {(r.kind, r.id): r for r in await owner_refs(db, all_keys)}
    for i in items:
        i.shared_owners = [refs[k] for k in owners.get(i.id, set()) & mine if k in refs]
    return AdjacencyOut(items=items, owners=[refs[k] for k in mine if k in refs])


async def _neighbors(db: AsyncSession, ids: set[uuid.UUID], tolerance_m: float) -> set[uuid.UUID]:
    a, b = aliased(Parcel), aliased(Parcel)
    stmt = (
        select(b.id).distinct()
        .select_from(a)
        .join(b, and_(b.id != a.id, func.ST_DWithin(b.geometry, a.geometry, _tolerance_deg(tolerance_m))))
        .where(a.id.in_(ids), b.deleted_at.is_(None), b.has_geometry.is_(True))
    )
    return set(await db.scalars(stmt))


async def assemblage(db: AsyncSession, p: Parcel, user: CurrentUser, tolerance_m: float = ADJACENCY_TOLERANCE_M,
                     max_parcels: int = 200) -> AssemblageOut:
    """Contiguous parcels sharing a current owner with `p` (breadth-first over the adjacency graph, per owner)."""
    if not user.can("ownership", "view"):
        return AssemblageOut(owners=[], groups=[], owners_hidden=True)
    owners, available = await owners_for_parcels(db, [p.id])
    mine = owners.get(p.id, set())
    if not available or not mine:
        return AssemblageOut(owners=[], groups=[], ownership_available=available)

    refs = {(r.kind, r.id): r for r in await owner_refs(db, mine)}
    groups: list[AssemblageGroup] = []
    for owner in mine:
        group, frontier = {p.id}, {p.id}
        while frontier and p.has_geometry and len(group) < max_parcels:
            candidates = await _neighbors(db, frontier, tolerance_m) - group
            if not candidates:
                break
            cand_owners, _ = await owners_for_parcels(db, list(candidates))
            frontier = {c for c in candidates if owner in cand_owners.get(c, set())}
            group |= frontier
        if len(group) > 1:
            rows = (await db.execute(list_stmt(ParcelFilters(ids=list(group))).order_by(Parcel.apn))).all()
            parcels = list_items(rows)
            groups.append(AssemblageGroup(owner=refs.get(owner) or OwnerRef(kind=owner[0], id=owner[1]),
                                          parcels=parcels, total_acreage=round(sum(x.acreage or 0 for x in parcels), 4)))
    return AssemblageOut(owners=list(refs.values()), groups=groups)


async def is_contiguous(db: AsyncSession, ids: list[uuid.UUID], tolerance_m: float = ADJACENCY_TOLERANCE_M) -> bool | None:
    if len(ids) < 2:
        return None
    n = await db.scalar(
        select(func.ST_NumGeometries(func.ST_Multi(func.ST_Union(func.ST_Buffer(Parcel.geometry, _tolerance_deg(tolerance_m / 2))))))
        .where(Parcel.id.in_(ids), Parcel.has_geometry.is_(True))
    )
    return n == 1 if n is not None else None


# ----------------------------------------------------------------------------- property <-> parcel links

async def parcel_properties(db: AsyncSession, parcel_id: uuid.UUID) -> list[LinkedProperty]:
    from app.modules.properties.models import Property

    rows = await db.execute(
        select(PropertyParcel, Property)
        .join(Property, Property.id == PropertyParcel.property_id)
        .where(PropertyParcel.parcel_id == parcel_id, Property.deleted_at.is_(None))
        .order_by(PropertyParcel.created_at)
    )
    return [LinkedProperty(link_id=l.id, relationship=l.relationship, property_id=pr.id, name=pr.name,
                           address_line=pr.address_line, city=pr.city, state=pr.state, status=pr.status,
                           property_type=pr.property_type) for l, pr in rows.all()]


async def property_parcels(db: AsyncSession, property_id: uuid.UUID) -> list[PropertyParcelOut]:
    rows = await db.execute(
        list_stmt(ParcelFilters()).add_columns(PropertyParcel)
        .join(PropertyParcel, PropertyParcel.parcel_id == Parcel.id)
        .where(PropertyParcel.property_id == property_id)
        .order_by(PropertyParcel.created_at)
    )
    out = []
    for p, count, link in rows.all():
        item = ParcelListItem.model_validate(p).model_copy(update={"property_count": int(count or 0)})
        out.append(PropertyParcelOut(link_id=link.id, relationship=link.relationship, notes=link.notes, parcel=item))
    return out


async def get_link(db: AsyncSession, property_id: uuid.UUID, link_id: uuid.UUID) -> PropertyParcel:
    link = await db.get(PropertyParcel, link_id)
    if not link or link.property_id != property_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Parcel link not found")
    return link


async def link_parcel(db: AsyncSession, property_id: uuid.UUID, data: PropertyParcelIn, actor: CurrentUser) -> PropertyParcel:
    parcel = await get(db, data.parcel_id)
    exists = await db.scalar(select(PropertyParcel.id).where(PropertyParcel.property_id == property_id,
                                                              PropertyParcel.parcel_id == parcel.id))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "Parcel is already linked to this property")
    link = PropertyParcel(property_id=property_id, parcel_id=parcel.id, relationship=data.relationship, notes=data.notes,
                          created_by_id=actor.id, updated_by_id=actor.id)
    db.add(link)
    await db.flush()
    await _audit_link(db, actor, "linked", property_id, parcel, data.relationship)
    await db.commit()
    return link


async def _audit_link(db: AsyncSession, actor: CurrentUser, verb: str, property_id: uuid.UUID, parcel: Parcel, rel: str):
    summary = f"{parcel.county} APN {parcel.apn} ({rel})"
    await audit.record(db, actor=actor, action=f"parcel.{verb}", entity_type=ENTITY, entity_id=parcel.id,
                       summary=summary, changes={"property_id": str(property_id), "relationship": rel},
                       ip_address=actor.ip_address)
    await audit.record(db, actor=actor, action=f"property.parcel_{verb}", entity_type="property", entity_id=property_id,
                       summary=summary, changes={"parcel_id": str(parcel.id), "relationship": rel},
                       ip_address=actor.ip_address)


async def update_link(db: AsyncSession, link: PropertyParcel, data: PropertyParcelUpdate, actor: CurrentUser) -> PropertyParcel:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(link, values)
    if not changes:
        return link
    for k, v in values.items():
        setattr(link, k, v)
    link.updated_by_id = actor.id
    parcel = await db.get(Parcel, link.parcel_id)
    await audit.record(db, actor=actor, action="property.parcel_link_updated", entity_type="property",
                       entity_id=link.property_id, changes=changes,
                       summary=f"{parcel.county} APN {parcel.apn}" if parcel else None, ip_address=actor.ip_address)
    await db.commit()
    return link


async def unlink(db: AsyncSession, link: PropertyParcel, actor: CurrentUser) -> None:
    parcel = await db.get(Parcel, link.parcel_id)
    if parcel:
        await _audit_link(db, actor, "unlinked", link.property_id, parcel, link.relationship)
    await db.delete(link)
    await db.commit()


async def bulk_associate(db: AsyncSession, data: BulkAssociateIn, actor: CurrentUser) -> BulkAssociateOut:
    from app.modules.properties import service as property_service

    found = {p.id: p for p in await db.scalars(select(Parcel).where(Parcel.id.in_(data.parcel_ids), Parcel.deleted_at.is_(None)))}
    parcels = [found[i] for i in dict.fromkeys(data.parcel_ids) if i in found]
    missing = [i for i in data.parcel_ids if i not in found]
    if not parcels:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "None of the selected parcels exist")

    property_id = data.property_id
    if property_id:
        await property_service.get(db, property_id)
    elif not data.new_property and not data.preview:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose a property or provide a new property")

    ids = [p.id for p in parcels]
    links = (await db.execute(select(PropertyParcel.parcel_id, PropertyParcel.property_id, PropertyParcel.relationship)
                              .where(PropertyParcel.parcel_id.in_(ids)))).all()
    already = {pid for pid, prop, _ in links if prop == property_id}
    elsewhere: dict[uuid.UUID, list[uuid.UUID]] = {}
    for pid, prop, _ in links:
        if prop != property_id:
            elsewhere.setdefault(pid, []).append(prop)
    has_primary = False
    if property_id:
        has_primary = bool(await db.scalar(select(PropertyParcel.id).where(
            PropertyParcel.property_id == property_id, PropertyParcel.relationship == "primary").limit(1)))

    preview: list[BulkPreviewParcel] = []
    for p in parcels:
        if data.relationship:
            rel = data.relationship
        elif not has_primary and p.id not in already:
            rel, has_primary = "primary", True
        else:
            rel = "assemblage"
        preview.append(BulkPreviewParcel(id=p.id, apn=p.apn, county=p.county, acreage=p.acreage, has_geometry=p.has_geometry,
                                         already_linked=p.id in already, relationship=rel,
                                         linked_elsewhere=elsewhere.get(p.id, [])))
    out = BulkAssociateOut(
        preview=data.preview, property_id=property_id, parcels=preview, missing_ids=missing,
        total_acreage=round(sum(p.acreage or 0 for p in parcels), 4),
        contiguous=await is_contiguous(db, [p.id for p in parcels if p.has_geometry]),
    )
    if data.preview:
        return out

    if not property_id and data.new_property:
        prop = await property_service.create(db, data.new_property, actor)  # commits the property on its own
        property_id = prop.id
        out.property_id = property_id
    linked = 0
    for item in preview:
        if item.already_linked:
            continue
        db.add(PropertyParcel(property_id=property_id, parcel_id=item.id, relationship=item.relationship,
                              created_by_id=actor.id, updated_by_id=actor.id))
        await _audit_link(db, actor, "linked", property_id, found[item.id], item.relationship)
        linked += 1
    await db.commit()
    out.linked = linked
    return out


# ----------------------------------------------------------------------------- buildings

async def _check_parcel_on_property(db: AsyncSession, property_id: uuid.UUID, parcel_id: uuid.UUID | None) -> None:
    if parcel_id and not await db.scalar(select(PropertyParcel.id).where(PropertyParcel.property_id == property_id,
                                                                         PropertyParcel.parcel_id == parcel_id)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Parcel is not linked to this property")


async def list_buildings(db: AsyncSession, property_id: uuid.UUID) -> list[BuildingOut]:
    counts = dict((await db.execute(
        select(Space.building_id, func.count(Space.id))
        .where(Space.property_id == property_id, Space.deleted_at.is_(None), Space.building_id.is_not(None))
        .group_by(Space.building_id)
    )).all())
    rows = await db.scalars(select(Building).where(Building.property_id == property_id, Building.deleted_at.is_(None))
                            .order_by(Building.name))
    return [BuildingOut.model_validate(b).model_copy(update={"space_count": counts.get(b.id, 0)}) for b in rows]


async def get_building(db: AsyncSession, property_id: uuid.UUID, building_id: uuid.UUID) -> Building:
    b = await db.get(Building, building_id)
    if not b or b.deleted_at or b.property_id != property_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Building not found")
    return b


async def create_building(db: AsyncSession, property_id: uuid.UUID, data: BuildingIn, actor: CurrentUser) -> Building:
    await _check_parcel_on_property(db, property_id, data.parcel_id)
    b = Building(**data.model_dump(exclude={"provenance"}), property_id=property_id, created_by_id=actor.id,
                 updated_by_id=actor.id)
    db.add(b)
    await db.flush()
    for field in BUILDING_MATERIAL:
        if getattr(b, field) is not None:
            await provenance.observe(db, entity_type="building", entity_id=b.id, field=field, value=getattr(b, field),
                                     prov=data.provenance, actor_id=actor.id)
    await audit.record(db, actor=actor, action="property.building_added", entity_type="property", entity_id=property_id,
                       summary=b.name, changes={"building_id": str(b.id)}, ip_address=actor.ip_address)
    await db.commit()
    return b


async def update_building(db: AsyncSession, b: Building, data: BuildingUpdate, actor: CurrentUser) -> Building:
    values = data.model_dump(exclude_unset=True, exclude={"provenance"})
    if "parcel_id" in values:
        await _check_parcel_on_property(db, b.property_id, values["parcel_id"])
    changes = await provenance.apply_material(db, b, entity_type="building", data=values, material_fields=BUILDING_MATERIAL,
                                              prov=data.provenance, actor_id=actor.id)
    if changes:
        b.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="property.building_updated", entity_type="property",
                           entity_id=b.property_id, summary=b.name, changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return b


async def archive_building(db: AsyncSession, b: Building, actor: CurrentUser) -> None:
    b.deleted_at = utcnow()
    b.updated_by_id = actor.id
    await db.execute(update(Space).where(Space.building_id == b.id).values(building_id=None))
    await audit.record(db, actor=actor, action="property.building_removed", entity_type="property",
                       entity_id=b.property_id, summary=b.name, ip_address=actor.ip_address)
    await db.commit()


# ----------------------------------------------------------------------------- spaces / suites

async def list_spaces(db: AsyncSession, property_id: uuid.UUID, *, q: str | None = None,
                      building_id: uuid.UUID | None = None, occupancy_status: list[str] | None = None) -> list[Space]:
    stmt = select(Space).where(Space.property_id == property_id, Space.deleted_at.is_(None))
    if q:
        stmt = stmt.where(or_(Space.suite.ilike(f"%{q}%"), Space.tenant_name.ilike(f"%{q}%")))
    if building_id:
        stmt = stmt.where(Space.building_id == building_id)
    stmt = in_filter(stmt, Space.occupancy_status, occupancy_status)
    return list(await db.scalars(stmt.order_by(Space.suite)))


async def get_space(db: AsyncSession, property_id: uuid.UUID, space_id: uuid.UUID) -> Space:
    s = await db.get(Space, space_id)
    if not s or s.deleted_at or s.property_id != property_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Space not found")
    return s


async def _check_building(db: AsyncSession, property_id: uuid.UUID, building_id: uuid.UUID | None) -> None:
    if building_id:
        await get_building(db, property_id, building_id)


async def create_space(db: AsyncSession, property_id: uuid.UUID, data: SpaceIn, actor: CurrentUser) -> Space:
    await _check_building(db, property_id, data.building_id)
    s = Space(**data.model_dump(exclude={"provenance"}), property_id=property_id, created_by_id=actor.id,
              updated_by_id=actor.id)
    db.add(s)
    await db.flush()
    for field in SPACE_MATERIAL:
        if getattr(s, field) is not None:
            await provenance.observe(db, entity_type="space", entity_id=s.id, field=field, value=getattr(s, field),
                                     prov=data.provenance, actor_id=actor.id)
    await audit.record(db, actor=actor, action="property.space_added", entity_type="property", entity_id=property_id,
                       summary=f"Suite {s.suite}", changes={"space_id": str(s.id)}, ip_address=actor.ip_address)
    await db.commit()
    return s


async def update_space(db: AsyncSession, s: Space, data: SpaceUpdate, actor: CurrentUser) -> Space:
    values = data.model_dump(exclude_unset=True, exclude={"provenance"})
    if values.get("building_id"):
        await _check_building(db, s.property_id, values["building_id"])
    changes = await provenance.apply_material(db, s, entity_type="space", data=values, material_fields=SPACE_MATERIAL,
                                              prov=data.provenance, actor_id=actor.id)
    if changes:
        s.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="property.space_updated", entity_type="property",
                           entity_id=s.property_id, summary=f"Suite {s.suite}", changes=changes,
                           ip_address=actor.ip_address)
        await db.commit()
    return s


async def archive_space(db: AsyncSession, s: Space, actor: CurrentUser) -> None:
    s.deleted_at = utcnow()
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="property.space_removed", entity_type="property", entity_id=s.property_id,
                       summary=f"Suite {s.suite}", ip_address=actor.ip_address)
    await db.commit()
