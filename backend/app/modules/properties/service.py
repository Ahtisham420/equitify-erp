import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from geoalchemy2 import Geography
from geoalchemy2.elements import WKTElement
from sqlalchemy import Select, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.normalize import normalize_address
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.properties.models import MATERIAL_FIELDS, Property
from app.modules.properties.schemas import BulkIn, PropertyCreate, PropertyOut, PropertyUpdate

ENTITY = "property"

BASE_REQUIRED = ["address_line", "city", "state", "county", "latitude", "longitude", "year_built", "zoning"]
TYPE_REQUIRED: dict[str, list[str]] = {
    "stnl": ["building_area_sf", "land_area_acres", "asking_price", "noi", "wale_years", "occupancy_pct"],
    "multi_tenant_retail": ["building_area_sf", "land_area_acres", "occupancy_pct", "noi", "wale_years", "parking_spaces"],
    "retail": ["building_area_sf", "land_area_acres", "occupancy_pct", "noi", "parking_spaces"],
    "gas_convenience": ["building_area_sf", "land_area_acres", "traffic_count", "noi", "wale_years"],
    "medical": ["building_area_sf", "occupancy_pct", "noi", "wale_years", "parking_spaces"],
    "office": ["building_area_sf", "occupancy_pct", "noi", "parking_spaces", "construction_class"],
    "industrial": ["building_area_sf", "land_area_acres", "occupancy_pct", "noi", "construction_class"],
    "ground_lease": ["land_area_acres", "noi", "wale_years"],
    "land": ["land_area_acres", "future_land_use", "flood_zone", "traffic_count", "corridor"],
}


def missing_fields(p: Property) -> list[str]:
    required = BASE_REQUIRED + TYPE_REQUIRED.get(p.property_type, ["building_area_sf", "land_area_acres"])
    return [f for f in required if getattr(p, f, None) in (None, "", [])]


def completeness(p: Property) -> float:
    required = BASE_REQUIRED + TYPE_REQUIRED.get(p.property_type, ["building_area_sf", "land_area_acres"])
    return round(100 * (len(required) - len(missing_fields(p))) / len(required), 1)


def _set_location(p: Property) -> None:
    if p.latitude is not None and p.longitude is not None:
        p.location = WKTElement(f"POINT({p.longitude} {p.latitude})", srid=4326)
    else:
        p.location = None


@dataclass
class PropertyFilters:
    q: str | None = None
    status: list[str] | None = None
    property_type: list[str] | None = None
    state: list[str] | None = None
    county: str | None = None
    city: str | None = None
    tag: list[str] | None = None
    min_area: float | None = None
    max_area: float | None = None
    min_acres: float | None = None
    max_acres: float | None = None
    min_price: float | None = None
    max_price: float | None = None
    min_year: int | None = None
    max_year: int | None = None
    min_completeness: float | None = None
    near_lat: float | None = None
    near_lng: float | None = None
    radius_miles: float | None = None
    ids: list[uuid.UUID] | None = None


def build_query(f: PropertyFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Property).where(Property.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Property.name, Property.address_line, Property.city, Property.county,
                                     Property.normalized_address, Property.corridor])
    if "status" not in skip:
        stmt = in_filter(stmt, Property.status, f.status)
    if "property_type" not in skip:
        stmt = in_filter(stmt, Property.property_type, f.property_type)
    if "state" not in skip:
        stmt = in_filter(stmt, Property.state, f.state)
    stmt = in_filter(stmt, Property.id, f.ids)
    if f.county:
        stmt = stmt.where(Property.county.ilike(f"%{f.county}%"))
    if f.city:
        stmt = stmt.where(Property.city.ilike(f"%{f.city}%"))
    if f.tag:
        stmt = stmt.where(Property.tags.overlap(f.tag))
    stmt = range_filter(stmt, Property.building_area_sf, f.min_area, f.max_area)
    stmt = range_filter(stmt, Property.land_area_acres, f.min_acres, f.max_acres)
    stmt = range_filter(stmt, Property.asking_price, f.min_price, f.max_price)
    stmt = range_filter(stmt, Property.year_built, f.min_year, f.max_year)
    stmt = range_filter(stmt, Property.completeness_score, f.min_completeness, None)
    if f.near_lat is not None and f.near_lng is not None and f.radius_miles:
        point = WKTElement(f"POINT({f.near_lng} {f.near_lat})", srid=4326)
        stmt = stmt.where(
            func.ST_DWithin(cast(Property.location, Geography), cast(point, Geography), f.radius_miles * 1609.344)
        )
    return stmt


async def get(db: AsyncSession, property_id: uuid.UUID) -> Property:
    p = await db.get(Property, property_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    return p


async def to_out(db: AsyncSession, p: Property) -> PropertyOut:
    out = PropertyOut.model_validate(p)
    out.missing_fields = missing_fields(p)
    out.provenance = {
        k: provenance.ObservationOut.model_validate(v)
        for k, v in (await provenance.current_observations(db, ENTITY, p.id)).items()
    }
    return out


async def find_duplicates(db: AsyncSession, normalized: str, exclude: uuid.UUID | None = None) -> list[Property]:
    stmt = select(Property).where(
        Property.deleted_at.is_(None),
        or_(Property.normalized_address == normalized, Property.alternate_addresses.contains([normalized])),
    )
    if exclude:
        stmt = stmt.where(Property.id != exclude)
    return list(await db.scalars(stmt.limit(5)))


async def create(db: AsyncSession, data: PropertyCreate, actor: CurrentUser, *, force: bool = False) -> Property:
    normalized = normalize_address(data.address_line, data.city, data.state, data.postal_code)
    dupes = await find_duplicates(db, normalized)
    if dupes and not force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": "A property with this address already exists",
                "duplicates": [{"id": str(d.id), "address_line": d.address_line, "city": d.city,
                                "status": d.status} for d in dupes],
            },
        )

    values = data.model_dump(exclude={"provenance"})
    values["alternate_addresses"] = [normalize_address(a) for a in values["alternate_addresses"]]
    p = Property(**values, normalized_address=normalized, created_by_id=actor.id, updated_by_id=actor.id)
    _set_location(p)
    p.completeness_score = completeness(p)
    db.add(p)
    await db.flush()

    for field in MATERIAL_FIELDS:
        value = getattr(p, field)
        if value is not None:
            await provenance.observe(db, entity_type=ENTITY, entity_id=p.id, field=field, value=value,
                                     prov=data.provenance, actor_id=actor.id)

    await audit.record(db, actor=actor, action="property.created", entity_type=ENTITY, entity_id=p.id,
                       summary=p.name or p.address_line, ip_address=actor.ip_address)
    await events.emit(db, "property.created", property_id=p.id, actor=actor)
    await db.commit()
    return p


async def update(db: AsyncSession, p: Property, data: PropertyUpdate, actor: CurrentUser) -> Property:
    values = data.model_dump(exclude_unset=True, exclude={"provenance"})
    if "alternate_addresses" in values and values["alternate_addresses"] is not None:
        values["alternate_addresses"] = [normalize_address(a) for a in values["alternate_addresses"]]

    changes = await provenance.apply_material(
        db, p, entity_type=ENTITY, data=values, material_fields=MATERIAL_FIELDS,
        prov=data.provenance, actor_id=actor.id,
    )
    if not changes:
        return p

    if {"address_line", "city", "state", "postal_code"} & changes.keys():
        p.normalized_address = normalize_address(p.address_line, p.city, p.state, p.postal_code)
    if {"latitude", "longitude"} & changes.keys():
        _set_location(p)
    p.completeness_score = completeness(p)
    p.updated_by_id = actor.id

    await audit.record(db, actor=actor, action="property.updated", entity_type=ENTITY, entity_id=p.id,
                       changes=changes, ip_address=actor.ip_address)
    await events.emit(db, "property.updated", property_id=p.id, changed=set(changes), actor=actor)
    await db.commit()
    return p


async def archive(db: AsyncSession, p: Property, actor: CurrentUser) -> None:
    """Soft delete only — property records persist for history and reactivation."""
    p.deleted_at = utcnow()
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="property.archived", entity_type=ENTITY, entity_id=p.id,
                       summary=p.name or p.address_line, ip_address=actor.ip_address)
    await db.commit()


async def bulk_update(db: AsyncSession, data: BulkIn, actor: CurrentUser) -> int:
    rows = list(await db.scalars(select(Property).where(Property.id.in_(data.ids), Property.deleted_at.is_(None))))
    for p in rows:
        changes: dict = {}
        if data.status and p.status != data.status:
            changes["status"] = {"from": p.status, "to": data.status}
            p.status = data.status
        if data.add_tags or data.remove_tags:
            tags = [t for t in (p.tags or []) if t not in data.remove_tags]
            tags += [t for t in data.add_tags if t not in tags]
            if tags != p.tags:
                changes["tags"] = {"from": p.tags, "to": tags}
                p.tags = tags
        if changes:
            p.updated_by_id = actor.id
            await audit.record(db, actor=actor, action="property.bulk_updated", entity_type=ENTITY,
                               entity_id=p.id, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return len(rows)


async def verify_observation(db: AsyncSession, obs_id: uuid.UUID, state: str, actor: CurrentUser):
    obs = await provenance.set_verification(db, obs_id, state, actor.id)
    if not obs or obs.entity_type != ENTITY:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Observation not found")
    await audit.record(db, actor=actor, action=f"property.field_{state}", entity_type=ENTITY,
                       entity_id=obs.entity_id, summary=obs.field, ip_address=actor.ip_address)
    await events.emit(db, "property.updated", property_id=obs.entity_id, changed={obs.field}, actor=actor)
    await db.commit()
    return obs
