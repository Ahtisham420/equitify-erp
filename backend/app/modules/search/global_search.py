"""Global search. Each source declares its permission module, so results never leak across permissions."""
from dataclasses import dataclass
from typing import Any, Callable

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser


@dataclass
class Source:
    type: str
    module: str
    model: Any
    columns: list[str]
    title: Callable[[Any], str]
    subtitle: Callable[[Any], str | None]
    href: Callable[[Any], str]


def _sources() -> list[Source]:
    from app.modules.contacts.models import Organization, Person
    from app.modules.parcels.models import Parcel
    from app.modules.pipeline.models import Opportunity
    from app.modules.properties.models import Property

    def join(*parts: str | None) -> str | None:
        return ", ".join(p for p in parts if p) or None

    return [
        Source(
            "property", "properties", Property, ["name", "address_line", "city", "county", "normalized_address"],
            lambda p: p.name or p.address_line,
            lambda p: join(p.address_line if p.name else None, p.city, p.state),
            lambda p: f"/properties/{p.id}",
        ),
        Source(
            "opportunity", "pipeline", Opportunity, ["title"],
            lambda o: o.title,
            lambda o: o.stage.replace("_", " ").capitalize(),
            lambda o: f"/pipeline/{o.id}",
        ),
        Source(
            "person", "contacts", Person, ["full_name", "title", "city", "primary_email"],
            lambda p: p.full_name,
            lambda p: join(p.title, p.city, p.state),
            lambda p: f"/people/{p.id}",
        ),
        Source(
            "organization", "contacts", Organization, ["name", "legal_name", "domain"],
            lambda o: o.name,
            lambda o: join(o.legal_name if o.legal_name != o.name else None, o.city, o.state),
            lambda o: f"/organizations/{o.id}",
        ),
        Source(
            "parcel", "parcels", Parcel, ["apn", "apn_normalized", "situs_address", "county"],
            lambda p: f"APN {p.apn}",
            lambda p: join(p.situs_address, p.county),
            lambda p: f"/parcels/{p.id}",
        ),
    ]


async def global_search(db: AsyncSession, user: CurrentUser, q: str, limit: int) -> list[dict]:
    hits: list[dict] = []
    terms = q.split()
    for src in _sources():
        if not user.can(src.module, "view"):
            continue
        stmt = select(src.model)
        if hasattr(src.model, "deleted_at"):
            stmt = stmt.where(src.model.deleted_at.is_(None))
        if hasattr(src.model, "merged_into_id"):
            stmt = stmt.where(src.model.merged_into_id.is_(None))
        for term in terms:
            stmt = stmt.where(or_(*[getattr(src.model, c).ilike(f"%{term}%") for c in src.columns]))
        for row in await db.scalars(stmt.limit(max(3, limit // 4))):
            hits.append({"type": src.type, "id": row.id, "title": src.title(row), "subtitle": src.subtitle(row),
                         "href": src.href(row)})
    return hits[:limit]
