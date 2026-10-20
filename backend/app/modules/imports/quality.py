"""Data quality metrics over properties: completeness, verification backlog, staleness and duplicates."""
from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.provenance import FieldObservation
from app.common.query import ListParams, apply_search, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.imports.models import QualityThreshold
from app.modules.imports.schemas import (
    BacklogFacets,
    BacklogItem,
    DuplicateGroup,
    DuplicateMember,
    QualitySummary,
    StaleField,
    StaleItem,
    Threshold,
    TypeCompleteness,
)
from app.modules.properties.models import MATERIAL_FIELDS, Property

# Days after which a current fact is considered stale. Admins can override per field.
DEFAULT_STALENESS: dict[str, int] = {
    "asking_price": 90,
    "occupancy_pct": 180,
    "noi": 365,
    "wale_years": 365,
    "zoning": 365,
    "future_land_use": 730,
    "traffic_count": 730,
    "flood_zone": 1825,
}

BANDS = {"low": "Below 50%", "medium": "50–79%", "high": "80% and above"}
LIVE = Property.deleted_at.is_(None)
OBS_SORTS = {
    "recorded_at": FieldObservation.recorded_at, "observed_on": FieldObservation.observed_on,
    "field": FieldObservation.field, "confidence": FieldObservation.confidence, "source": FieldObservation.source,
}


async def thresholds(db: AsyncSession) -> dict[str, int]:
    out = dict(DEFAULT_STALENESS)
    rows = await db.scalars(select(QualityThreshold).where(QualityThreshold.deleted_at.is_(None)))
    for t in rows:
        out[t.field] = t.days
    return out


async def list_thresholds(db: AsyncSession) -> list[Threshold]:
    current = await thresholds(db)
    return [
        Threshold(field=f, days=current.get(f), default_days=DEFAULT_STALENESS.get(f),
                  is_default=current.get(f) == DEFAULT_STALENESS.get(f))
        for f in sorted(MATERIAL_FIELDS)
    ]


async def set_thresholds(db: AsyncSession, values: dict[str, int | None], actor: CurrentUser) -> list[Threshold]:
    existing = {t.field: t for t in await db.scalars(select(QualityThreshold))}
    before = await thresholds(db)
    for field, days in values.items():
        if field not in MATERIAL_FIELDS:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"'{field}' is not a sourced property field")
        if days is not None and not 1 <= days <= 36_500:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Thresholds must be between 1 and 36,500 days")
        row = existing.get(field)
        if days is None:
            if row and not row.deleted_at:
                row.deleted_at = utcnow()
                row.updated_by_id = actor.id
            continue
        if row:
            row.days, row.deleted_at, row.updated_by_id = days, None, actor.id
        else:
            db.add(QualityThreshold(field=field, days=days, created_by_id=actor.id, updated_by_id=actor.id))
    await db.flush()
    after = await thresholds(db)
    changes = {f: {"from": before.get(f), "to": after.get(f)} for f in set(before) | set(after)
               if before.get(f) != after.get(f)}
    if changes:
        await audit.record(db, actor=actor, action="data_quality.thresholds_changed", entity_type="data_quality",
                           summary="Staleness thresholds", changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return await list_thresholds(db)


def _obs_base() -> Select:
    return (
        select(FieldObservation, Property.name, Property.address_line, Property.city, Property.state)
        .join(Property, Property.id == FieldObservation.entity_id)
        .where(FieldObservation.entity_type == "property", FieldObservation.is_current.is_(True), LIVE)
    )


def _stale_condition(limits: dict[str, int], today: date):
    return or_(*[
        and_(FieldObservation.field == f, FieldObservation.observed_on < today - timedelta(days=d))
        for f, d in limits.items()
    ])


async def summary(db: AsyncSession) -> QualitySummary:
    total = await db.scalar(select(func.count()).select_from(Property).where(LIVE)) or 0
    avg = await db.scalar(select(func.avg(Property.completeness_score)).where(LIVE)) or 0

    band = case((Property.completeness_score < 50, "low"), (Property.completeness_score < 80, "medium"), else_="high")
    bands = {k: 0 for k in BANDS}
    for b, c in (await db.execute(select(band, func.count()).where(LIVE).group_by(band))).all():
        bands[b] = int(c)

    by_type = [
        TypeCompleteness(property_type=t, count=int(c), average=round(float(a or 0), 1))
        for t, c, a in (await db.execute(
            select(Property.property_type, func.count(), func.avg(Property.completeness_score))
            .where(LIVE).group_by(Property.property_type).order_by(func.count().desc())
        )).all()
    ]

    unverified = _obs_base().where(FieldObservation.verification == "unverified").order_by(None).subquery()
    backlog = await db.scalar(select(func.count()).select_from(unverified)) or 0
    ai = await db.scalar(select(func.count()).select_from(unverified).where(unverified.c.ai_derived.is_(True))) or 0

    limits = await thresholds(db)
    today = date.today()
    stale_rows = dict((await db.execute(
        select(FieldObservation.field, func.count())
        .join(Property, Property.id == FieldObservation.entity_id)
        .where(FieldObservation.entity_type == "property", FieldObservation.is_current.is_(True), LIVE,
               _stale_condition(limits, today))
        .group_by(FieldObservation.field)
    )).all()) if limits else {}
    stale_by_field = sorted(
        [StaleField(field=f, threshold_days=d, stale=int(stale_rows.get(f, 0))) for f, d in limits.items()],
        key=lambda s: -s.stale,
    )

    groups = (
        select(Property.normalized_address, func.count().label("n"))
        .where(LIVE).group_by(Property.normalized_address).having(func.count() > 1).subquery()
    )
    dup_groups = await db.scalar(select(func.count()).select_from(groups)) or 0
    dup_props = await db.scalar(select(func.coalesce(func.sum(groups.c.n), 0))) or 0

    return QualitySummary(
        total_properties=total,
        average_completeness=round(float(avg), 1),
        completeness_bands=bands,
        completeness_by_type=by_type,
        verification_backlog=backlog,
        ai_unverified=ai,
        stale_total=sum(s.stale for s in stale_by_field),
        stale_by_field=stale_by_field,
        duplicate_groups=dup_groups,
        duplicate_properties=int(dup_props),
        duplicate_rate=round(100 * int(dup_props) / total, 2) if total else 0.0,
    )


def _item(row, cls=BacklogItem, **extra):
    obs, name, address, city, state = row
    return cls(
        id=obs.id, property_id=obs.entity_id, property_title=name or address,
        property_location=", ".join(p for p in [address if name else None, city, state] if p) or None,
        field=obs.field, value=obs.value, source=obs.source, observed_on=obs.observed_on,
        confidence=obs.confidence, ai_derived=obs.ai_derived, recorded_at=obs.recorded_at, **extra,
    )


def _backlog_query(params: ListParams, field: list[str] | None, source: str | None, ai_derived: bool | None,
                   *, skip: set[str] = frozenset()) -> Select:
    stmt = _obs_base().where(FieldObservation.verification == "unverified")
    stmt = apply_search(stmt, params.q, [Property.name, Property.address_line, Property.city, FieldObservation.source])
    if "field" not in skip:
        stmt = in_filter(stmt, FieldObservation.field, field)
    if source:
        stmt = stmt.where(FieldObservation.source.ilike(f"%{source}%"))
    if ai_derived is not None and "ai_derived" not in skip:
        stmt = stmt.where(FieldObservation.ai_derived.is_(ai_derived))
    return stmt


async def backlog(db: AsyncSession, params: ListParams, field: list[str] | None, source: str | None,
                  ai_derived: bool | None) -> tuple[list[BacklogItem], int]:
    stmt = apply_sort(_backlog_query(params, field, source, ai_derived), params.sort, OBS_SORTS,
                      FieldObservation.recorded_at.asc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    return [_item(r) for r in rows], total


async def backlog_facets(db: AsyncSession, params: ListParams, field: list[str] | None, source: str | None,
                         ai_derived: bool | None) -> BacklogFacets:
    fields = await facet_counts(db, _backlog_query(params, field, source, ai_derived, skip={"field"}),
                                FieldObservation.field)
    ai = await facet_counts(db, _backlog_query(params, field, source, ai_derived, skip={"ai_derived"}),
                            FieldObservation.ai_derived)
    return BacklogFacets(field=fields, ai_derived={k.lower(): v for k, v in ai.items()})


async def stale(db: AsyncSession, params: ListParams, field: list[str] | None) -> tuple[list[StaleItem], int]:
    limits = await thresholds(db)
    if field:
        limits = {f: d for f, d in limits.items() if f in field}
    if not limits:
        return [], 0
    today = date.today()
    stmt = _obs_base().where(_stale_condition(limits, today))
    stmt = apply_search(stmt, params.q, [Property.name, Property.address_line, Property.city, FieldObservation.source])
    stmt = apply_sort(stmt, params.sort, OBS_SORTS, FieldObservation.observed_on.asc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    items = []
    for r in rows:
        obs = r[0]
        age = (today - obs.observed_on).days if obs.observed_on else 0
        items.append(_item(r, StaleItem, verification=obs.verification, threshold_days=limits[obs.field], age_days=age))
    return items, total


async def duplicates(db: AsyncSession, params: ListParams) -> tuple[list[DuplicateGroup], int]:
    groups = select(Property.normalized_address, func.count().label("n")).where(LIVE)
    if params.q:
        for term in params.q.split():
            groups = groups.where(Property.normalized_address.ilike(f"%{term}%"))
    groups = groups.group_by(Property.normalized_address).having(func.count() > 1)
    total = await db.scalar(select(func.count()).select_from(groups.subquery())) or 0
    page = (await db.execute(
        groups.order_by(func.count().desc(), Property.normalized_address)
        .offset((params.page - 1) * params.page_size).limit(params.page_size)
    )).all()
    keys = [k for k, _ in page]
    members: dict[str, list[DuplicateMember]] = {k: [] for k in keys}
    if keys:
        for p in await db.scalars(
            select(Property).where(LIVE, Property.normalized_address.in_(keys)).order_by(Property.created_at)
        ):
            members[p.normalized_address].append(DuplicateMember.model_validate(p, from_attributes=True))
    return [DuplicateGroup(normalized_address=k, count=int(n), properties=members[k]) for k, n in page], int(total)
