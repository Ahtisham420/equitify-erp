"""Tours, deal rooms & brokerage compliance (spec module 26).

- Tours: stops are ordered by nearest-neighbour over property coordinates (haversine, pure Python).
  Feedback creates an owned follow-up task and records the showing on the listing.
- Deal rooms: counterparties get explicit grants (folders, expiry, download right). When the room requires an NDA
  the grant needs an effective signed NDA, checked again on every access. Every document view/download and every
  denial is logged. Internal users need dealroom permission plus brokerage view when the room belongs to a
  listing/deal (access follows record permissions).
- Compliance: license expirations and disclosure deadlines raise alerts and critical dates; disclosures and
  transaction-file items can be blocking. `transaction_file_complete` gates commission release.
"""
import math
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.dealroom.models import (
    ACK_REQUIRED_TYPES,
    AD_CHECKLIST,
    AdReview,
    AgentLicense,
    DealRoom,
    DealRoomAccess,
    DealRoomAccessLog,
    DealRoomFolder,
    Disclosure,
    Nda,
    OfferSubmission,
    Tour,
    TourFeedback,
    TourStop,
    TransactionFile,
    TransactionFileItem,
)
from app.modules.dealroom.schemas import (
    AccessLogOut,
    AnalyticsOut,
    DocRef,
    FileItemOut,
    FileOut,
    FolderOut,
    LicenseOut,
    NdaOut,
    RoomOut,
    StopOut,
)

EARTH_RADIUS_MILES = 3958.7613
DEFAULT_FOLDERS = ["Marketing", "Financials", "Leases", "Due diligence", "Legal & title"]
LICENSE_WARN_DAYS = 60


def today() -> date:
    return utcnow().date()


# ============================================================================ helpers


async def get_or_404(db: AsyncSession, model: Any, obj_id: uuid.UUID, label: str) -> Any:
    obj = await db.get(model, obj_id)
    if not obj or getattr(obj, "deleted_at", None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    return obj


async def create_row(db: AsyncSession, model: Any, entity: str, values: dict, actor: CurrentUser,
                     summary: str | None = None) -> Any:
    obj = model(**values, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(obj)
    await db.flush()
    await audit.record(db, actor=actor, action=f"{entity}.created", entity_type=entity, entity_id=obj.id,
                       summary=summary, ip_address=actor.ip_address)
    return obj


async def patch_row(db: AsyncSession, obj: Any, entity: str, values: dict, actor: CurrentUser) -> dict:
    changes = audit.diff(obj, values)
    for k in changes:
        setattr(obj, k, values[k])
    if changes:
        obj.updated_by_id = actor.id
        await audit.record(db, actor=actor, action=f"{entity}.updated", entity_type=entity, entity_id=obj.id,
                           changes=changes, ip_address=actor.ip_address)
    return changes


async def archive_row(db: AsyncSession, obj: Any, entity: str, actor: CurrentUser) -> None:
    obj.deleted_at = utcnow()
    obj.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{entity}.archived", entity_type=entity, entity_id=obj.id,
                       ip_address=actor.ip_address)
    await db.commit()


async def enrich(db: AsyncSession, items: list, spec: dict[str, tuple[str, str]]) -> list:
    from app.modules.brokerage.service import enrich as _enrich

    return await _enrich(db, items, spec)


async def names(db: AsyncSession, kind: str, ids: set) -> dict:
    from app.modules.brokerage.service import _names

    return await _names(db, kind, {i for i in ids if i})


async def upsert_critical_date(db: AsyncSession, **kwargs: Any) -> uuid.UUID | None:
    try:
        from app.modules.contracts.service import upsert_critical_date as upsert
    except ImportError:
        return None
    cd = await upsert(db, **kwargs)
    return getattr(cd, "id", None)


async def link_document(db: AsyncSession, document_id: uuid.UUID | None, entity_type: str, entity_id: uuid.UUID,
                        actor: CurrentUser) -> None:
    if not document_id:
        return
    try:
        from app.modules.documents.service import link
    except ImportError:
        return
    await link(db, document_id, entity_type, entity_id, actor)


async def document_refs(db: AsyncSession, ids: set) -> dict[uuid.UUID, dict]:
    from app.modules.brokerage.service import document_titles

    return await document_titles(db, ids)


# ============================================================================ tours & routing


def haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MILES * math.asin(min(1.0, math.sqrt(a)))


def nearest_neighbour_order(points: list[tuple[Any, float | None, float | None]],
                            start: tuple[float, float] | None = None) -> list[Any]:
    """Greedy route: from `start` (or the first located point) always visit the closest unvisited point.
    Points without coordinates keep their relative order at the end."""
    located = [(k, la, ln) for k, la, ln in points if la is not None and ln is not None]
    unlocated = [k for k, la, ln in points if la is None or ln is None]
    if not located:
        return [k for k, _, _ in points]
    remaining = list(located)
    route: list[Any] = []
    if start is None:
        first = remaining.pop(0)
        route.append(first[0])
        cur = (first[1], first[2])
    else:
        cur = start
    while remaining:
        i = min(range(len(remaining)), key=lambda j: (haversine_miles(cur[0], cur[1], remaining[j][1],
                                                                      remaining[j][2]), j))
        k, la, ln = remaining.pop(i)
        route.append(k)
        cur = (la, ln)
    return route + unlocated


async def _stop_rows(db: AsyncSession, tour_id: uuid.UUID) -> list[tuple[TourStop, Any]]:
    from app.modules.properties.models import Property

    return list((await db.execute(
        select(TourStop, Property.latitude, Property.longitude, Property.name, Property.address_line, Property.city)
        .join(Property, Property.id == TourStop.property_id)
        .where(TourStop.tour_id == tour_id, TourStop.deleted_at.is_(None))
        .order_by(TourStop.sequence, TourStop.created_at))).all())


def _recompute(tour: Tour, ordered: list[tuple[TourStop, Any]]) -> None:
    prev = (tour.start_lat, tour.start_lng) if tour.start_lat is not None and tour.start_lng is not None else None
    total = 0.0
    for i, row in enumerate(ordered):
        stop, lat, lng = row[0], row[1], row[2]
        stop.sequence = i + 1
        if lat is not None and lng is not None and prev is not None:
            stop.distance_from_prev_miles = round(haversine_miles(prev[0], prev[1], lat, lng), 2)
            total += stop.distance_from_prev_miles
        else:
            stop.distance_from_prev_miles = None
        if lat is not None and lng is not None:
            prev = (lat, lng)
    tour.total_distance_miles = round(total, 2)


async def recompute_distances(db: AsyncSession, tour: Tour) -> None:
    _recompute(tour, await _stop_rows(db, tour.id))


async def optimize_route(db: AsyncSession, tour: Tour, actor: CurrentUser) -> int:
    rows = await _stop_rows(db, tour.id)
    by_id = {r[0].id: r for r in rows}
    start = (tour.start_lat, tour.start_lng) if tour.start_lat is not None and tour.start_lng is not None else None
    order = nearest_neighbour_order([(r[0].id, r[1], r[2]) for r in rows], start)
    _recompute(tour, [by_id[i] for i in order])
    tour.optimized_at, tour.updated_by_id = utcnow(), actor.id
    await audit.record(db, actor=actor, action="tour.route_optimized", entity_type="tour", entity_id=tour.id,
                       summary=f"{len(rows)} stops, {tour.total_distance_miles} mi", ip_address=actor.ip_address)
    return sum(1 for r in rows if r[1] is None or r[2] is None)


async def stop_outs(db: AsyncSession, tour_id: uuid.UUID) -> list[StopOut]:
    outs = []
    for stop, lat, lng, name, addr, city in await _stop_rows(db, tour_id):
        o = StopOut.model_validate(stop)
        o.property_label = name or addr
        o.address = ", ".join(x for x in [addr, city] if x)
        o.latitude, o.longitude, o.has_location = lat, lng, lat is not None and lng is not None
        outs.append(o)
    return outs


async def _live_listing(db: AsyncSession, property_id: uuid.UUID) -> uuid.UUID | None:
    try:
        from app.modules.brokerage.models import LIVE_LISTING_STATUSES, Listing
    except ImportError:
        return None
    return await db.scalar(select(Listing.id).where(Listing.property_id == property_id, Listing.deleted_at.is_(None),
                                                    Listing.status.in_(LIVE_LISTING_STATUSES)).limit(1))


async def add_stop(db: AsyncSession, tour: Tour, data: BaseModel, actor: CurrentUser, *, commit: bool = True) -> TourStop:
    from app.modules.properties.service import get as get_property

    values = data.model_dump()
    await get_property(db, values["property_id"])
    values["listing_id"] = values.get("listing_id") or await _live_listing(db, values["property_id"])
    n = await db.scalar(select(func.count()).select_from(TourStop).where(TourStop.tour_id == tour.id,
                                                                        TourStop.deleted_at.is_(None)))
    stop = await create_row(db, TourStop, "tour_stop", {**values, "tour_id": tour.id, "sequence": int(n or 0) + 1},
                            actor)
    await audit.record(db, actor=actor, action="tour.stop_added", entity_type="tour", entity_id=tour.id,
                       ip_address=actor.ip_address)
    if commit:
        await recompute_distances(db, tour)
        await db.commit()
    return stop


async def create_tour(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> Tour:
    from app.modules.dealroom.schemas import StopIn

    values = data.model_dump(exclude={"property_ids"})
    values["agent_id"] = values.get("agent_id") or actor.id
    values["participants"] = audit.to_jsonable(values.get("participants") or [])
    if not values.get("title"):
        client = None
        for kind, key in (("organization", "client_organization_id"), ("person", "client_person_id")):
            if values.get(key):
                client = (await names(db, kind, {values[key]})).get(values[key])
                break
        values["title"] = f"Tour {values['scheduled_on'].isoformat()}" + (f" · {client}" if client else "")
    tour = await create_row(db, Tour, "tour", values, actor, summary=values["title"])
    for pid in dict.fromkeys(getattr(data, "property_ids", []) or []):
        await add_stop(db, tour, StopIn(property_id=pid), actor, commit=False)
    await db.flush()
    if getattr(data, "property_ids", None):
        await optimize_route(db, tour, actor)
    await db.commit()
    return tour


async def update_tour(db: AsyncSession, tour: Tour, data: BaseModel, actor: CurrentUser) -> Tour:
    values = data.model_dump(exclude_unset=True)
    values = {k: v for k, v in values.items() if not (v is None and k in ("title", "status", "scheduled_on"))}
    if "participants" in values:
        values["participants"] = audit.to_jsonable(values["participants"] or [])
    changes = await patch_row(db, tour, "tour", values, actor)
    if {"start_lat", "start_lng"} & changes.keys():
        await recompute_distances(db, tour)
    await db.commit()
    return tour


async def update_stop(db: AsyncSession, stop: TourStop, data: BaseModel, actor: CurrentUser) -> TourStop:
    tour = await get_or_404(db, Tour, stop.tour_id, "Tour")
    values = {k: v for k, v in data.model_dump(exclude_unset=True).items()
              if not (v is None and k in ("status", "duration_minutes", "sequence"))}
    new_seq = values.pop("sequence", None)
    await patch_row(db, stop, "tour_stop", values, actor)
    if new_seq is not None:
        rows = await _stop_rows(db, tour.id)
        others = [r for r in rows if r[0].id != stop.id]
        mine = next(r for r in rows if r[0].id == stop.id)
        idx = max(0, min(len(others), new_seq - 1))
        _recompute(tour, others[:idx] + [mine] + others[idx:])
        tour.optimized_at = None
    await db.commit()
    return stop


async def remove_stop(db: AsyncSession, stop: TourStop, actor: CurrentUser) -> None:
    tour = await get_or_404(db, Tour, stop.tour_id, "Tour")
    stop.deleted_at, stop.updated_by_id = utcnow(), actor.id
    await audit.record(db, actor=actor, action="tour.stop_removed", entity_type="tour", entity_id=tour.id,
                       ip_address=actor.ip_address)
    await db.flush()
    await recompute_distances(db, tour)
    await db.commit()


async def add_feedback(db: AsyncSession, tour: Tour, data: BaseModel, actor: CurrentUser) -> TourFeedback:
    from app.modules.tasks.service import create_task

    values = data.model_dump()
    stop = None
    if values.get("stop_id"):
        stop = await get_or_404(db, TourStop, values["stop_id"], "Stop")
        if stop.tour_id != tour.id:
            raise HTTPException(422, "Stop belongs to another tour")
        values["property_id"] = values.get("property_id") or stop.property_id
        values["listing_id"] = stop.listing_id
    if not values.get("property_id"):
        raise HTTPException(422, "Choose the stop or property the feedback is about")
    values["person_id"] = values.get("person_id") or tour.client_person_id
    fb = await create_row(db, TourFeedback, "tour_feedback", {**values, "tour_id": tour.id}, actor)
    if stop and stop.status == "planned":
        stop.status = "visited"

    plabel = (await names(db, "property", {fb.property_id})).get(fb.property_id)
    who = None
    if fb.person_id:
        who = (await names(db, "person", {fb.person_id})).get(fb.person_id)
    elif tour.client_organization_id:
        who = (await names(db, "organization", {tour.client_organization_id})).get(tour.client_organization_id)
    due = fb.next_action_at or utcnow() + timedelta(days=2)
    task = await create_task(
        db, title=fb.next_action or f"Follow up with {who or 'client'} on {plabel or 'toured property'}",
        assignee_id=tour.agent_id or actor.id, due_at=due, task_type="follow_up",
        description="\n".join(x for x in [fb.feedback, f"Objections: {fb.objections}" if fb.objections else None] if x)
        or None, related_type="tour", related_id=tour.id, related_label=tour.title, source="dealroom.tour_feedback",
        idempotency_key=f"dealroom:tour_feedback:{fb.id}", actor_id=actor.id)
    fb.follow_up_task_id = task.id

    try:
        from app.modules.brokerage.service import record_showing_from_tour

        when = datetime.combine(tour.scheduled_on, datetime.min.time(), tzinfo=utcnow().tzinfo)
        showing = await record_showing_from_tour(
            db, listing_id=fb.listing_id, property_id=fb.property_id, tour_id=tour.id, scheduled_at=when,
            person_id=fb.person_id, organization_id=tour.client_organization_id, interest_level=fb.interest_level,
            feedback=fb.feedback, actor=actor)
        fb.showing_id = showing.id
    except ImportError:
        pass
    await db.commit()
    return fb


# ============================================================================ NDAs


def nda_effective(n: Nda) -> bool:
    return n.status == "signed" and not n.deleted_at and (n.expires_on is None or n.expires_on >= today())


async def nda_outs(db: AsyncSession, rows: list[Nda]) -> list[NdaOut]:
    outs = []
    for r in rows:
        o = NdaOut.model_validate(r)
        o.is_effective = nda_effective(r)
        outs.append(o)
    return await enrich(db, outs, {"person_id": ("person", "person_label"),
                                   "organization_id": ("organization", "organization_label")})


async def save_nda(db: AsyncSession, data: BaseModel, actor: CurrentUser, n: Nda | None = None) -> Nda:
    values = data.model_dump(exclude_unset=n is not None)
    values = {k: v for k, v in values.items() if not (n is not None and v is None and k in
                                                      ("status", "counterparty_kind"))}
    merged = {**({"person_id": n.person_id, "organization_id": n.organization_id} if n else {}), **values}
    if not (merged.get("person_id") or merged.get("organization_id")):
        raise HTTPException(422, "An NDA needs a counterparty (person or organization)")
    st = values.get("status")
    if st == "sent" and not values.get("sent_at") and not (n and n.sent_at):
        values["sent_at"] = utcnow()
    if st == "signed" and not values.get("signed_at") and not (n and n.signed_at):
        values["signed_at"] = utcnow()
    if values.get("deal_room_id") and not values.get("listing_id"):
        room = await db.get(DealRoom, values["deal_room_id"])
        if room:
            values["listing_id"] = room.listing_id
    if n is None:
        n = await create_row(db, Nda, "nda", values, actor)
    else:
        await patch_row(db, n, "nda", values, actor)
    await link_document(db, n.document_id, "nda", n.id, actor)
    await db.commit()
    return n


async def find_effective_nda(db: AsyncSession, room: DealRoom, person_id: uuid.UUID | None,
                             organization_id: uuid.UUID | None) -> Nda | None:
    if not (person_id or organization_id):
        return None
    who = []
    if person_id:
        who.append(Nda.person_id == person_id)
    if organization_id:
        who.append(Nda.organization_id == organization_id)
    scope = [Nda.deal_room_id == room.id]
    if room.listing_id:
        scope.append(Nda.listing_id == room.listing_id)
    if room.brokerage_deal_id:
        scope.append(Nda.brokerage_deal_id == room.brokerage_deal_id)
    rows = await db.scalars(select(Nda).where(Nda.deleted_at.is_(None), Nda.status == "signed", or_(*who),
                                              or_(*scope)).order_by(Nda.signed_at.desc().nulls_last()))
    return next((n for n in rows if nda_effective(n)), None)


# ============================================================================ deal rooms: access control


def can_use_room_internally(user: CurrentUser, room: DealRoom) -> bool:
    if not user.can("dealroom", "view"):
        return False
    if (room.listing_id or room.brokerage_deal_id) and not user.can("brokerage", "view"):
        return False
    return True


async def internal_room(db: AsyncSession, room_id: uuid.UUID, user: CurrentUser) -> DealRoom:
    room = await get_or_404(db, DealRoom, room_id, "Deal room")
    if not can_use_room_internally(user, room):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to this deal room's record")
    return room


async def _grant_problem(db: AsyncSession, room: DealRoom, g: DealRoomAccess) -> str | None:
    if g.deleted_at or g.status == "revoked":
        return "Access has been revoked"
    if g.expires_at and g.expires_at < utcnow():
        return "Access has expired"
    if room.status != "open":
        return "This deal room is not open"
    if room.requires_nda:
        nda = await db.get(Nda, g.nda_id) if g.nda_id else None
        if not (nda and nda_effective(nda)):
            nda = await find_effective_nda(db, room, g.person_id, g.organization_id)
        if not nda:
            return "A signed confidentiality agreement is required"
    return None


async def portal_grant(db: AsyncSession, room: DealRoom, user: CurrentUser) -> DealRoomAccess:
    """Active grant for a counterparty user, or 403 (denial is logged)."""
    grants = list(await db.scalars(select(DealRoomAccess).where(
        DealRoomAccess.room_id == room.id, DealRoomAccess.user_id == user.id, DealRoomAccess.deleted_at.is_(None))
        .order_by(DealRoomAccess.created_at.desc())))
    problem = "No access grant for this deal room"
    for g in grants:
        problem = await _grant_problem(db, room, g) or ""
        if not problem:
            g.last_accessed_at = utcnow()
            return g
    await log_access(db, room, None, user, "denied", detail=problem, is_internal=False)
    await db.commit()
    raise HTTPException(status.HTTP_403_FORBIDDEN, problem)


def folder_visible(folder: DealRoomFolder, grant: DealRoomAccess | None) -> bool:
    if grant is None:
        return True
    if grant.folder_ids:
        return folder.id in grant.folder_ids
    return not folder.is_restricted


async def log_access(db: AsyncSession, room: DealRoom, grant: DealRoomAccess | None, user: CurrentUser | None,
                     action: str, *, document_id: uuid.UUID | None = None, folder_id: uuid.UUID | None = None,
                     detail: str | None = None, is_internal: bool) -> None:
    db.add(DealRoomAccessLog(
        room_id=room.id, access_id=grant.id if grant else None, folder_id=folder_id, document_id=document_id,
        action=action, user_id=getattr(user, "id", None), person_id=grant.person_id if grant else None,
        organization_id=grant.organization_id if grant else None, actor_name=getattr(user, "full_name", None),
        is_internal=is_internal, detail=detail, ip_address=getattr(user, "ip_address", None)))


async def _linked_folder_docs(db: AsyncSession, folder_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Documents uploaded against a folder through the documents module (document_links)."""
    if not folder_ids:
        return {}
    try:
        from app.modules.documents.models import DocumentLink
    except ImportError:
        return {}
    out: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for doc_id, entity_id in (await db.execute(select(DocumentLink.document_id, DocumentLink.entity_id).where(
            DocumentLink.entity_type == "deal_room_folder", DocumentLink.entity_id.in_(folder_ids)))).all():
        out[entity_id].append(doc_id)
    return out


async def folder_outs(db: AsyncSession, room: DealRoom, grant: DealRoomAccess | None = None) -> list[FolderOut]:
    folders = [f for f in await db.scalars(select(DealRoomFolder).where(
        DealRoomFolder.room_id == room.id, DealRoomFolder.deleted_at.is_(None))
        .order_by(DealRoomFolder.sort_order, DealRoomFolder.name)) if folder_visible(f, grant)]
    linked = await _linked_folder_docs(db, [f.id for f in folders])
    all_ids: dict[uuid.UUID, list[uuid.UUID]] = {
        f.id: list(dict.fromkeys([*(f.document_ids or []), *linked.get(f.id, [])])) for f in folders}
    refs = await document_refs(db, {d for ids in all_ids.values() for d in ids})
    outs = []
    for f in folders:
        o = FolderOut.model_validate(f)
        o.document_ids = all_ids[f.id]
        o.documents = [DocRef(**refs.get(d, {"id": d})) for d in all_ids[f.id]]
        outs.append(o)
    return outs


async def open_document(db: AsyncSession, room: DealRoom, document_id: uuid.UUID, action: str,
                        user: CurrentUser, grant: DealRoomAccess | None) -> str | None:
    """Authorise, log and return a short-lived URL for a document in the room."""
    folders = await folder_outs(db, room, grant)
    folder = next((f for f in folders if document_id in f.document_ids), None)
    internal = grant is None
    problem = None
    if folder is None:
        problem = "Document is not shared in a folder you can access"
    elif action == "download" and grant is not None and not grant.can_download:
        problem = "Download is not permitted for this grant"
    if problem:
        await log_access(db, room, grant, user, "denied", document_id=document_id,
                         folder_id=folder.id if folder else None, detail=problem, is_internal=internal)
        await db.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, problem)
    await log_access(db, room, grant, user, action, document_id=document_id, folder_id=folder.id,
                     is_internal=internal)
    url = None
    try:
        from app.modules.documents.service import signed_url

        url = signed_url(document_id, minutes=10)
    except ImportError:
        url = None
    await db.commit()
    return url


# ============================================================================ deal rooms: CRUD


async def room_outs(db: AsyncSession, rows: list[DealRoom]) -> list[RoomOut]:
    if not rows:
        return []
    ids = [r.id for r in rows]
    grants = dict((await db.execute(select(DealRoomAccess.room_id, func.count()).where(
        DealRoomAccess.room_id.in_(ids), DealRoomAccess.deleted_at.is_(None), DealRoomAccess.status == "active")
        .group_by(DealRoomAccess.room_id))).all())
    docs = dict((await db.execute(select(DealRoomFolder.room_id,
                                         func.sum(func.coalesce(func.cardinality(DealRoomFolder.document_ids), 0)))
                                  .where(DealRoomFolder.room_id.in_(ids), DealRoomFolder.deleted_at.is_(None))
                                  .group_by(DealRoomFolder.room_id))).all())
    views = {rid: (int(n), last) for rid, n, last in (await db.execute(
        select(DealRoomAccessLog.room_id, func.count(), func.max(DealRoomAccessLog.at))
        .where(DealRoomAccessLog.room_id.in_(ids), DealRoomAccessLog.action.in_(["view", "download"]))
        .group_by(DealRoomAccessLog.room_id))).all()}
    offers = dict((await db.execute(select(OfferSubmission.room_id, func.count()).where(
        OfferSubmission.room_id.in_(ids), OfferSubmission.deleted_at.is_(None))
        .group_by(OfferSubmission.room_id))).all())
    outs = []
    for r in rows:
        o = RoomOut.model_validate(r)
        o.grant_count, o.document_count = int(grants.get(r.id, 0)), int(docs.get(r.id, 0) or 0)
        o.view_count, o.last_activity_at = views.get(r.id, (0, None))
        o.offer_count = int(offers.get(r.id, 0))
        outs.append(o)
    return await enrich(db, outs, {"property_id": ("property", "property_label"), "owner_id": ("user", "owner_name")})


async def create_room(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> DealRoom:
    values = data.model_dump(exclude={"default_folders"})
    listing = deal = None
    try:
        from app.modules.brokerage.models import BrokerageDeal, Listing

        if values.get("listing_id"):
            listing = await get_or_404(db, Listing, values["listing_id"], "Listing")
            values["property_id"] = values.get("property_id") or listing.property_id
        if values.get("brokerage_deal_id"):
            deal = await get_or_404(db, BrokerageDeal, values["brokerage_deal_id"], "Deal")
            values["property_id"] = values.get("property_id") or deal.property_id
            values["listing_id"] = values.get("listing_id") or deal.listing_id
    except ImportError:
        pass
    if (values.get("listing_id") or values.get("brokerage_deal_id")) and not actor.can("brokerage", "view"):
        raise HTTPException(403, "Brokerage access is required to open a room for this record")
    if not values.get("name"):
        label = (await names(db, "property", {values.get("property_id")})).get(values.get("property_id")) \
            if values.get("property_id") else None
        values["name"] = f"{label or 'Deal'} deal room"
    values["owner_id"] = values.get("owner_id") or actor.id
    if values.get("status") == "open":
        values["opened_at"] = utcnow()
    room = await create_row(db, DealRoom, "deal_room", values, actor, summary=values["name"])
    if getattr(data, "default_folders", False):
        for i, name in enumerate(DEFAULT_FOLDERS):
            db.add(DealRoomFolder(room_id=room.id, name=name, sort_order=i, created_by_id=actor.id,
                                  updated_by_id=actor.id))
    if listing is not None and not listing.deal_room_id:
        listing.deal_room_id = room.id
    await db.commit()
    return room


async def update_room(db: AsyncSession, room: DealRoom, data: BaseModel, actor: CurrentUser) -> DealRoom:
    values = data.model_dump(exclude_unset=True)
    values = {k: v for k, v in values.items() if not (v is None and k in ("name", "status", "requires_nda",
                                                                          "allow_offers"))}
    if values.get("status") == "open" and room.status != "open":
        values["opened_at"] = utcnow()
    if values.get("status") in ("closed", "archived") and room.status not in ("closed", "archived"):
        values["closed_at"] = utcnow()
    await patch_row(db, room, "deal_room", values, actor)
    await db.commit()
    return room


async def save_folder(db: AsyncSession, room: DealRoom, data: BaseModel, actor: CurrentUser,
                      folder: DealRoomFolder | None = None) -> DealRoomFolder:
    values = data.model_dump(exclude_unset=folder is not None)
    values = {k: v for k, v in values.items() if not (v is None and k in ("name", "sort_order", "is_restricted"))}
    if "document_ids" in values:
        values["document_ids"] = list(dict.fromkeys(values["document_ids"] or []))
    if folder is None:
        folder = await create_row(db, DealRoomFolder, "deal_room_folder", {**values, "room_id": room.id}, actor,
                                  summary=values.get("name"))
    else:
        await patch_row(db, folder, "deal_room_folder", values, actor)
    for doc_id in folder.document_ids or []:
        await link_document(db, doc_id, "deal_room", room.id, actor)
    await db.commit()
    return folder


async def grant_access(db: AsyncSession, room: DealRoom, data: BaseModel, actor: CurrentUser) -> DealRoomAccess:
    values = data.model_dump()
    kind = values["grantee_kind"]
    if kind == "person" and not values.get("person_id"):
        raise HTTPException(422, "Choose the person to grant access to")
    if kind == "organization" and not values.get("organization_id"):
        raise HTTPException(422, "Choose the organization to grant access to")
    if kind == "user" and not values.get("user_id"):
        raise HTTPException(422, "Choose the portal user to grant access to")
    folder_ids = set(await db.scalars(select(DealRoomFolder.id).where(DealRoomFolder.room_id == room.id,
                                                                       DealRoomFolder.deleted_at.is_(None))))
    if any(f not in folder_ids for f in values.get("folder_ids") or []):
        raise HTTPException(422, "Folders must belong to this deal room")
    if room.requires_nda:
        nda = None
        if values.get("nda_id"):
            nda = await get_or_404(db, Nda, values["nda_id"], "NDA")
        if not (nda and nda_effective(nda)):
            nda = await find_effective_nda(db, room, values.get("person_id"), values.get("organization_id"))
        if not nda:
            raise HTTPException(422, "This room requires a signed confidentiality agreement from the counterparty "
                                     "before access can be granted")
        values["nda_id"] = nda.id
    g = await create_row(db, DealRoomAccess, "deal_room_access", {**values, "room_id": room.id, "status": "active"},
                         actor)
    await audit.record(db, actor=actor, action="deal_room.access_granted", entity_type="deal_room", entity_id=room.id,
                       changes={"access_id": {"from": None, "to": str(g.id)}}, ip_address=actor.ip_address)
    await db.commit()
    return g


async def revoke_access(db: AsyncSession, g: DealRoomAccess, actor: CurrentUser) -> DealRoomAccess:
    if g.status == "revoked":
        return g
    g.status, g.revoked_at, g.revoked_by_id, g.updated_by_id = "revoked", utcnow(), actor.id, actor.id
    await audit.record(db, actor=actor, action="deal_room.access_revoked", entity_type="deal_room",
                       entity_id=g.room_id, changes={"access_id": {"from": str(g.id), "to": None}},
                       ip_address=actor.ip_address)
    await db.commit()
    return g


async def access_outs(db: AsyncSession, room: DealRoom, rows: list[DealRoomAccess]) -> list:
    from app.modules.dealroom.schemas import AccessOut

    ndas = {n.id: n for n in await db.scalars(select(Nda).where(Nda.id.in_({r.nda_id for r in rows if r.nda_id})))} \
        if rows else {}
    outs = []
    for r in rows:
        o = AccessOut.model_validate(r)
        nda = ndas.get(r.nda_id) if r.nda_id else None
        o.nda_status = ("signed" if nda_effective(nda) else nda.status) if nda else None
        if r.status == "revoked":
            o.effective_status = "revoked"
        elif r.expires_at and r.expires_at < utcnow():
            o.effective_status = "expired"
        elif room.requires_nda and not (nda and nda_effective(nda)):
            o.effective_status = "nda_required"
        else:
            o.effective_status = "active"
        outs.append(o)
    return await enrich(db, outs, {"person_id": ("person", "person_label"),
                                   "organization_id": ("organization", "organization_label"),
                                   "user_id": ("user", "user_name")})


async def analytics(db: AsyncSession, room: DealRoom) -> AnalyticsOut:
    logs = list(await db.scalars(select(DealRoomAccessLog).where(DealRoomAccessLog.room_id == room.id)
                                 .order_by(DealRoomAccessLog.at.desc()).limit(5000)))
    refs = await document_refs(db, {lg.document_id for lg in logs if lg.document_id})
    person_names = await names(db, "person", {lg.person_id for lg in logs if lg.person_id})
    org_names = await names(db, "organization", {lg.organization_id for lg in logs if lg.organization_id})
    viewers: dict[str, dict] = {}
    docs: dict[uuid.UUID, dict] = {}
    for lg in logs:
        key = str(lg.access_id or lg.user_id or "unknown")
        label = person_names.get(lg.person_id) or org_names.get(lg.organization_id) or lg.actor_name or "Unknown"
        v = viewers.setdefault(key, {"viewer": label, "internal": lg.is_internal, "views": 0, "downloads": 0,
                                     "denied": 0, "documents": set(), "last_at": lg.at})
        if lg.action in ("view", "download", "denied"):
            v[{"view": "views", "download": "downloads", "denied": "denied"}[lg.action]] += 1
        if lg.document_id and lg.action in ("view", "download"):
            v["documents"].add(lg.document_id)
            d = docs.setdefault(lg.document_id, {"document_id": str(lg.document_id),
                                                 "title": (refs.get(lg.document_id) or {}).get("title"),
                                                 "views": 0, "downloads": 0, "viewers": set(), "last_at": lg.at})
            d["views" if lg.action == "view" else "downloads"] += 1
            d["viewers"].add(key)
    by_viewer = [{**{k: v for k, v in x.items() if k != "documents"}, "documents": len(x["documents"])}
                 for x in viewers.values()]
    by_document = [{**{k: v for k, v in x.items() if k != "viewers"}, "unique_viewers": len(x["viewers"])}
                   for x in docs.values()]
    recent = []
    for lg in logs[:200]:
        o = AccessLogOut.model_validate(lg)
        o.document_title = (refs.get(lg.document_id) or {}).get("title") if lg.document_id else None
        if not lg.is_internal and (lg.person_id or lg.organization_id):
            o.actor_name = person_names.get(lg.person_id) or org_names.get(lg.organization_id) or lg.actor_name
        recent.append(o)
    return AnalyticsOut(
        total_views=sum(1 for lg in logs if lg.action == "view"),
        total_downloads=sum(1 for lg in logs if lg.action == "download"),
        denied=sum(1 for lg in logs if lg.action == "denied"),
        unique_viewers=len({k for k, v in viewers.items() if v["views"] or v["downloads"]}),
        by_viewer=sorted(by_viewer, key=lambda x: x["last_at"], reverse=True),
        by_document=sorted(by_document, key=lambda x: x["views"] + x["downloads"], reverse=True),
        recent=recent,
    )


# ============================================================================ offers


async def submit_offer(db: AsyncSession, room: DealRoom, data: BaseModel, actor: CurrentUser,
                       grant: DealRoomAccess | None) -> OfferSubmission:
    from app.modules.tasks.service import create_task

    if not room.allow_offers:
        raise HTTPException(422, "This deal room is not accepting offers")
    if grant is not None:
        if room.status != "open":
            raise HTTPException(422, "This deal room is not open")
        if not grant.can_submit_offers:
            raise HTTPException(403, "Offer submission is not permitted for this grant")
        if room.offer_deadline and room.offer_deadline < utcnow():
            raise HTTPException(422, "The offer deadline has passed")
    elif room.status == "archived":
        raise HTTPException(422, "This deal room is archived")
    values = data.model_dump()
    if grant is not None:
        values["submitter_person_id"] = grant.person_id or values.get("submitter_person_id")
        values["submitter_organization_id"] = grant.organization_id or values.get("submitter_organization_id")
        values["submitter_name"] = values.get("submitter_name") or actor.full_name
        values["submitter_user_id"] = actor.id
    if not (values.get("submitter_person_id") or values.get("submitter_organization_id")
            or values.get("submitter_name")):
        raise HTTPException(422, "Identify who is submitting the offer")
    version = 1
    if values.get("parent_submission_id"):
        parent = await get_or_404(db, OfferSubmission, values["parent_submission_id"], "Offer")
        if parent.room_id != room.id:
            raise HTTPException(422, "The previous offer belongs to another deal room")
        version = parent.version + 1
    offer = await create_row(db, OfferSubmission, "offer_submission", {
        **values, "room_id": room.id, "listing_id": room.listing_id, "brokerage_deal_id": room.brokerage_deal_id,
        "property_id": room.property_id, "access_id": grant.id if grant else None, "version": version,
        "status": "submitted", "submitted_at": utcnow()}, actor, summary=f"Offer {values['price']:,.0f}")
    await log_access(db, room, grant, actor, "submit_offer", detail=f"Offer v{version}", is_internal=grant is None)
    await link_document(db, offer.document_id, "deal_room", room.id, actor)
    who = values.get("submitter_name") or values.get("buyer_entity") or "counterparty"
    await create_task(db, title=f"Review offer from {who}", assignee_id=room.owner_id, task_type="review",
                      priority="high", due_at=utcnow() + timedelta(days=1), related_type="deal_room",
                      related_id=room.id, related_label=room.name, source="dealroom.offer_submission",
                      idempotency_key=f"dealroom:offer:{offer.id}", actor_id=actor.id)
    await events.emit(db, "offer_submission.received", offer_submission_id=offer.id, room_id=room.id,
                      listing_id=room.listing_id, actor=actor)
    await db.commit()
    return offer


async def review_offer(db: AsyncSession, offer: OfferSubmission, new_status: str, notes: str | None,
                       actor: CurrentUser) -> OfferSubmission:
    if offer.status in ("accepted", "rejected", "withdrawn") and new_status != offer.status:
        raise HTTPException(409, f"This offer is already {offer.status}")
    old = offer.status
    offer.status, offer.review_notes = new_status, notes if notes is not None else offer.review_notes
    offer.reviewed_by_id, offer.reviewed_at, offer.updated_by_id = actor.id, utcnow(), actor.id
    await audit.record(db, actor=actor, action="offer_submission.reviewed", entity_type="offer_submission",
                       entity_id=offer.id, changes={"status": {"from": old, "to": new_status}}, summary=notes,
                       ip_address=actor.ip_address)
    if new_status == "accepted":
        await events.emit(db, "offer_submission.accepted", offer_submission_id=offer.id, listing_id=offer.listing_id,
                          brokerage_deal_id=offer.brokerage_deal_id, actor=actor)
    await db.commit()
    return offer


# ============================================================================ licenses


def license_alert_level(lic: AgentLicense) -> str | None:
    if lic.status == "expired" or (lic.expires_on and lic.expires_on < today()):
        return "expired"
    if lic.expires_on:
        days = (lic.expires_on - today()).days
        if days <= 14:
            return "critical"
        if days <= LICENSE_WARN_DAYS:
            return "warning"
    return None


async def license_outs(db: AsyncSession, rows: list[AgentLicense]) -> list[LicenseOut]:
    users = await names(db, "user", {r.user_id for r in rows})
    outs = []
    for r in rows:
        o = LicenseOut.model_validate(r)
        o.days_to_expiry = (r.expires_on - today()).days if r.expires_on else None
        o.alert_level = license_alert_level(r)
        o.user_name = users.get(r.user_id) if r.user_id else None
        outs.append(o)
    return outs


async def save_license(db: AsyncSession, data: BaseModel, actor: CurrentUser,
                       lic: AgentLicense | None = None) -> AgentLicense:
    values = data.model_dump(exclude_unset=lic is not None)
    values = {k: v for k, v in values.items() if not (lic is not None and v is None and k in
                                                      ("license_type", "license_number", "state", "status",
                                                       "holder_name"))}
    if not values.get("holder_name") and lic is None:
        if values.get("user_id"):
            values["holder_name"] = (await names(db, "user", {values["user_id"]})).get(values["user_id"])
        if not values.get("holder_name"):
            raise HTTPException(422, "Holder name or user is required")
    if lic is None:
        lic = await create_row(db, AgentLicense, "agent_license", values, actor,
                               summary=f"{values.get('state')} {values.get('license_number')}")
    else:
        await patch_row(db, lic, "agent_license", values, actor)
    if lic.expires_on:
        cd = await upsert_critical_date(
            db, related_type="agent_license", related_id=lic.id, date_type="license_expiration",
            label=f"License {lic.license_number} ({lic.state}) expires", due_on=lic.expires_on,
            owner_id=lic.user_id, lead_days=LICENSE_WARN_DAYS, is_blocking=False, source="rule", status="confirmed",
            key="license_expiration", actor=actor)
        lic.critical_date_id = cd or lic.critical_date_id
    await link_document(db, lic.document_id, "agent_license", lic.id, actor)
    await db.commit()
    return lic


async def scan_compliance(db: AsyncSession, actor: CurrentUser | None) -> dict:
    """Expire lapsed licenses and raise alerts for upcoming license / disclosure deadlines (idempotent)."""
    from app.modules.tasks.service import raise_alert

    lic_alerts = expired = disc_alerts = 0
    licenses = list(await db.scalars(select(AgentLicense).where(AgentLicense.deleted_at.is_(None),
                                                                AgentLicense.status.notin_(["inactive"]))))
    for lic in licenses:
        level = license_alert_level(lic)
        if not level:
            continue
        if level == "expired" and lic.status != "expired":
            old, lic.status = lic.status, "expired"
            expired += 1
            if actor is not None:
                await audit.record(db, actor=actor, action="agent_license.expired", entity_type="agent_license",
                                   entity_id=lic.id, changes={"status": {"from": old, "to": "expired"}},
                                   ip_address=getattr(actor, "ip_address", None))
        days = (lic.expires_on - today()).days if lic.expires_on else None
        ce_gap = (lic.ce_hours_required or 0) - (lic.ce_hours_completed or 0)
        reason = ("License has expired" if level == "expired" else f"License expires in {days} days") + \
                 (f"; {ce_gap:g} CE hours outstanding" if ce_gap > 0 else "") + \
                 ". Agents cannot represent clients or be paid on transactions with a lapsed license."
        await raise_alert(
            db, title=f"{lic.holder_name}: {lic.state} license {lic.license_number}", reason=reason,
            severity={"expired": "critical", "critical": "high", "warning": "medium"}[level], owner_id=lic.user_id,
            related_type="agent_license", related_id=lic.id, related_label=lic.holder_name,
            rule_key="dealroom.license_expiration",
            due_at=datetime.combine(lic.expires_on, datetime.min.time(), tzinfo=utcnow().tzinfo)
            if lic.expires_on else None,
            idempotency_key=f"dealroom:license:{lic.id}:{lic.expires_on}:{level}")
        lic.last_alerted_at = utcnow()
        lic_alerts += 1

    horizon = today() + timedelta(days=3)
    for d in await db.scalars(select(Disclosure).where(
            Disclosure.deleted_at.is_(None), Disclosure.due_on.is_not(None), Disclosure.due_on <= horizon,
            Disclosure.status.notin_(["waived", "acknowledged"]))):
        if disclosure_satisfied(d):
            continue
        overdue = d.due_on < today()
        await raise_alert(
            db, title=f"Disclosure {'overdue' if overdue else 'due'}: {d.title}",
            reason=("Required disclosure was not delivered by its deadline" if overdue else
                    f"Required disclosure is due {d.due_on.isoformat()}") +
                   (" and blocks commission release." if d.is_blocking else "."),
            severity="high" if overdue else "medium", owner_id=d.owner_id,
            related_type="brokerage_deal" if d.brokerage_deal_id else "disclosure",
            related_id=d.brokerage_deal_id or d.id, related_label=d.title, rule_key="dealroom.disclosure_deadline",
            idempotency_key=f"dealroom:disclosure:{d.id}:{'overdue' if overdue else 'due'}")
        disc_alerts += 1
    if actor is not None:
        await audit.record(db, actor=actor, action="dealroom.compliance_scanned", entity_type="dealroom",
                           summary=f"{lic_alerts} license alerts, {disc_alerts} disclosure alerts",
                           ip_address=getattr(actor, "ip_address", None))
    await db.commit()
    return {"licenses_checked": len(licenses), "license_alerts": lic_alerts, "licenses_expired": expired,
            "disclosure_alerts": disc_alerts}


# ============================================================================ disclosures


def disclosure_satisfied(d: Disclosure) -> bool:
    if d.status == "waived":
        return True
    if d.requires_acknowledgement:
        return d.status == "acknowledged"
    return d.status in ("delivered", "acknowledged")


async def _disclosure_critical_date(db: AsyncSession, d: Disclosure, actor: CurrentUser) -> None:
    if not d.due_on:
        return
    cd = await upsert_critical_date(
        db, related_type="disclosure", related_id=d.id, date_type="disclosure_due", label=f"Disclosure: {d.title}",
        due_on=d.due_on, property_id=d.property_id, owner_id=d.owner_id, lead_days=3, is_blocking=d.is_blocking,
        source="rule", status="completed" if disclosure_satisfied(d) else "confirmed", key="disclosure_due",
        actor=actor)
    d.critical_date_id = cd or d.critical_date_id


async def create_disclosure(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> Disclosure:
    values = data.model_dump()
    dtype = values["disclosure_type"]
    if values.get("requires_acknowledgement") is None:
        values["requires_acknowledgement"] = dtype in ACK_REQUIRED_TYPES
    if not values.get("title"):
        values["title"] = dtype.replace("_", " ").capitalize() + " disclosure"
    try:
        from app.modules.brokerage.models import BrokerageDeal, Listing

        if values.get("brokerage_deal_id"):
            deal = await get_or_404(db, BrokerageDeal, values["brokerage_deal_id"], "Deal")
            values["property_id"] = values.get("property_id") or deal.property_id
            values["listing_id"] = values.get("listing_id") or deal.listing_id
            values["owner_id"] = values.get("owner_id") or deal.agent_id
        elif values.get("listing_id"):
            listing = await get_or_404(db, Listing, values["listing_id"], "Listing")
            values["property_id"] = values.get("property_id") or listing.property_id
            values["owner_id"] = values.get("owner_id") or listing.agent_id
    except ImportError:
        pass
    values["owner_id"] = values.get("owner_id") or actor.id
    d = await create_row(db, Disclosure, "disclosure", {**values, "status": "required"}, actor, summary=values["title"])
    await _disclosure_critical_date(db, d, actor)
    await db.commit()
    return d


async def update_disclosure(db: AsyncSession, d: Disclosure, data: BaseModel, actor: CurrentUser) -> Disclosure:
    values = {k: v for k, v in data.model_dump(exclude_unset=True).items()
              if not (v is None and k in ("disclosure_type", "title", "is_blocking", "requires_acknowledgement"))}
    await patch_row(db, d, "disclosure", values, actor)
    await _disclosure_critical_date(db, d, actor)
    await db.commit()
    return d


async def deliver_disclosure(db: AsyncSession, d: Disclosure, data: BaseModel, actor: CurrentUser) -> Disclosure:
    values = data.model_dump()
    if not (values.get("evidence_document_id") or (values.get("evidence_note") or "").strip()):
        raise HTTPException(422, "Delivery evidence (document or note) is required")
    if d.status == "waived":
        raise HTTPException(409, "This disclosure was waived")
    await patch_row(db, d, "disclosure", {
        "delivered_at": values.get("delivered_at") or utcnow(), "delivery_method": values["delivery_method"],
        "evidence_document_id": values.get("evidence_document_id") or d.evidence_document_id,
        "evidence_note": values.get("evidence_note") or d.evidence_note,
        "status": "acknowledged" if d.status == "acknowledged" else "delivered"}, actor)
    await link_document(db, d.evidence_document_id, "disclosure", d.id, actor)
    await _disclosure_critical_date(db, d, actor)
    await db.commit()
    return d


async def acknowledge_disclosure(db: AsyncSession, d: Disclosure, data: BaseModel, actor: CurrentUser) -> Disclosure:
    values = data.model_dump()
    if d.status == "waived":
        raise HTTPException(409, "This disclosure was waived")
    if not d.delivered_at:
        raise HTTPException(422, "Record delivery (with evidence) before the acknowledgement")
    await patch_row(db, d, "disclosure", {
        "acknowledged_at": values.get("acknowledged_at") or utcnow(),
        "acknowledged_by_name": values["acknowledged_by_name"],
        "acknowledgement_document_id": values.get("acknowledgement_document_id") or d.acknowledgement_document_id,
        "status": "acknowledged"}, actor)
    await link_document(db, d.acknowledgement_document_id, "disclosure", d.id, actor)
    await _disclosure_critical_date(db, d, actor)
    await db.commit()
    return d


async def waive_disclosure(db: AsyncSession, d: Disclosure, reason: str, actor: CurrentUser) -> Disclosure:
    await patch_row(db, d, "disclosure", {"status": "waived", "waived_reason": reason}, actor)
    await _disclosure_critical_date(db, d, actor)
    await db.commit()
    return d


# ============================================================================ advertising review


async def submit_ad_review(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> AdReview:
    values = data.model_dump()
    try:
        from app.modules.brokerage.models import MarketingItem

        if values.get("marketing_item_id"):
            item = await get_or_404(db, MarketingItem, values["marketing_item_id"], "Marketing item")
            values["listing_id"] = values.get("listing_id") or item.listing_id
            values["document_id"] = values.get("document_id") or ((item.document_ids or [None])[0])
            if item.status in ("draft", "approved"):
                item.status = "in_review"
    except ImportError:
        pass
    checklist = [{"key": k, "label": label, "checked": False} for k, label in AD_CHECKLIST]
    r = await create_row(db, AdReview, "ad_review", {**values, "submitted_by_id": actor.id, "submitted_at": utcnow(),
                                                     "status": "pending", "checklist": checklist}, actor,
                         summary=values["title"])
    await db.commit()
    return r


async def decide_ad_review(db: AsyncSession, r: AdReview, data: BaseModel, actor: CurrentUser) -> AdReview:
    values = data.model_dump()
    if r.status != "pending":
        raise HTTPException(409, f"This review was already {r.status.replace('_', ' ')}")
    if r.submitted_by_id == actor.id and not actor.is_admin:
        raise HTTPException(403, "Advertising must be reviewed by someone other than the submitter")
    checked = {c.get("key"): bool(c.get("checked")) for c in values.get("checklist") or []}
    checklist = [{**c, "checked": checked.get(c["key"], c.get("checked", False))} for c in (r.checklist or [])]
    if values["status"] == "approved" and not all(c["checked"] for c in checklist):
        raise HTTPException(422, "Every review checklist item must be confirmed before approval")
    if values["status"] != "approved" and not (values.get("review_notes") or "").strip():
        raise HTTPException(422, "Explain what needs to change")
    old = r.status
    r.status, r.checklist, r.review_notes = values["status"], checklist, values.get("review_notes")
    r.reviewer_id, r.reviewed_at, r.updated_by_id = actor.id, utcnow(), actor.id
    await audit.record(db, actor=actor, action=f"ad_review.{values['status']}", entity_type="ad_review",
                       entity_id=r.id, changes={"status": {"from": old, "to": r.status}}, summary=r.review_notes,
                       ip_address=actor.ip_address)
    if r.marketing_item_id:
        try:
            from app.modules.brokerage.models import MarketingItem

            item = await db.get(MarketingItem, r.marketing_item_id)
            if item and item.status == "in_review":
                item.status = "approved" if r.status == "approved" else "draft"
        except ImportError:
            pass
    await db.commit()
    return r


# ============================================================================ transaction files


def _template(side: str, is_dual: bool) -> list[tuple[str, str, str]]:
    items = [
        ("agreement", "Engagement or representation agreement", "agreement"),
        ("agency_disclosure", "Agency relationship disclosure delivered", "disclosure"),
        ("executed_contract", "Executed purchase or lease agreement", "contract"),
        ("license_current", "Agent license current", "compliance"),
    ]
    if side in ("listing", "landlord", "dual"):
        items += [("seller_disclosures", "Seller / landlord property disclosures", "disclosure"),
                  ("ad_approvals", "Advertising reviewed and approved", "compliance")]
    if is_dual or side == "dual":
        items.append(("dual_rep_ack", "Dual representation / intermediary acknowledgement", "disclosure"))
    items += [("closing_statement", "Settlement or closing statement", "closing"),
              ("commission_agreement", "Commission agreement or invoice", "financial")]
    return items


AUTO_KEYS = {"agreement", "agency_disclosure", "license_current", "ad_approvals", "dual_rep_ack"}


async def ensure_transaction_file(db: AsyncSession, deal: Any, actor: CurrentUser | None) -> TransactionFile:
    """Create the deal's transaction file from the template if missing. Does not commit."""
    f = await db.scalar(select(TransactionFile).where(TransactionFile.brokerage_deal_id == deal.id))
    if f:
        if deal.is_dual_rep:
            have = set(await db.scalars(select(TransactionFileItem.key).where(TransactionFileItem.file_id == f.id)))
            if "dual_rep_ack" not in have:
                db.add(TransactionFileItem(file_id=f.id, key="dual_rep_ack", category="disclosure", sort_order=50,
                                           label="Dual representation / intermediary acknowledgement"))
        return f
    actor_id = getattr(actor, "id", None)
    f = TransactionFile(brokerage_deal_id=deal.id, template_key=deal.side, status="open", created_by_id=actor_id,
                        updated_by_id=actor_id)
    db.add(f)
    await db.flush()
    for i, (key, label, cat) in enumerate(_template(deal.side, deal.is_dual_rep)):
        db.add(TransactionFileItem(file_id=f.id, key=key, label=label, category=cat, is_required=True,
                                   sort_order=i * 10, created_by_id=actor_id, updated_by_id=actor_id))
    if actor is not None:
        await audit.record(db, actor=actor, action="transaction_file.created", entity_type="brokerage_deal",
                           entity_id=deal.id, ip_address=getattr(actor, "ip_address", None))
    await db.flush()
    return f


def item_manually_satisfied(i: TransactionFileItem) -> bool:
    if i.status in ("approved", "waived"):
        return True
    return i.status == "provided" and bool(i.document_id or (i.evidence_note or "").strip())


async def _auto_checks(db: AsyncSession, deal: Any) -> dict[str, tuple[bool, str]]:
    """System-evaluated evidence for template items: {key: (met, detail)}."""
    from app.modules.brokerage.models import EngagementAgreement, Listing, MarketingItem, RepAgreement

    out: dict[str, tuple[bool, str]] = {}
    agreement_ok, detail = False, "No signed agreement linked"
    if deal.rep_agreement_id:
        ra = await db.get(RepAgreement, deal.rep_agreement_id)
        if ra and not ra.deleted_at and ra.signed_on:
            agreement_ok, detail = True, f"Representation agreement signed {ra.signed_on.isoformat()}"
    listing = await db.get(Listing, deal.listing_id) if deal.listing_id else None
    if not agreement_ok and listing and listing.engagement_agreement_id:
        ea = await db.get(EngagementAgreement, listing.engagement_agreement_id)
        if ea and not ea.deleted_at and ea.signed_on:
            agreement_ok, detail = True, f"Engagement agreement signed {ea.signed_on.isoformat()}"
    out["agreement"] = (agreement_ok, detail)

    discs = list(await db.scalars(select(Disclosure).where(Disclosure.brokerage_deal_id == deal.id,
                                                           Disclosure.deleted_at.is_(None))))
    agency = [d for d in discs if d.disclosure_type == "agency"]
    out["agency_disclosure"] = (bool(agency) and all(disclosure_satisfied(d) for d in agency),
                                "Agency disclosure delivered" if agency and all(disclosure_satisfied(d) for d in agency)
                                else "Record and deliver the agency disclosure")
    dual = [d for d in discs if d.disclosure_type in ACK_REQUIRED_TYPES]
    out["dual_rep_ack"] = (bool(dual) and all(disclosure_satisfied(d) for d in dual),
                           "Acknowledged" if dual and all(disclosure_satisfied(d) for d in dual)
                           else "Dual representation acknowledgement not signed")

    lic_ok, lic_detail = False, "No license on file for the agent"
    if deal.agent_id:
        for lic in await db.scalars(select(AgentLicense).where(AgentLicense.user_id == deal.agent_id,
                                                               AgentLicense.deleted_at.is_(None))):
            if lic.status in ("active", "pending_renewal") and (lic.expires_on is None or lic.expires_on >= today()):
                lic_ok, lic_detail = True, f"{lic.state} {lic.license_number} current"
                break
            lic_detail = f"{lic.state} {lic.license_number} is {license_alert_level(lic) or lic.status}"
    out["license_current"] = (lic_ok, lic_detail)

    ad_ok, ad_detail = True, "No published marketing"
    if listing:
        published = list(await db.scalars(select(MarketingItem.id).where(
            MarketingItem.listing_id == listing.id, MarketingItem.deleted_at.is_(None),
            or_(MarketingItem.status == "published", MarketingItem.syndication_status == "live"))))
        if published:
            approved = set(await db.scalars(select(AdReview.marketing_item_id).where(
                AdReview.marketing_item_id.in_(published), AdReview.status == "approved",
                AdReview.deleted_at.is_(None))))
            missing = [m for m in published if m not in approved]
            ad_ok = not missing
            ad_detail = "All published marketing approved" if ad_ok else f"{len(missing)} published item(s) unapproved"
    out["ad_approvals"] = (ad_ok, ad_detail)
    return out


async def evaluate_file(db: AsyncSession, f: TransactionFile) -> tuple[list[tuple[TransactionFileItem, bool, str | None]],
                                                                         list[str]]:
    """Items with satisfaction state, and the list of blockers (required items + blocking disclosures)."""
    from app.modules.brokerage.models import BrokerageDeal

    deal = await db.get(BrokerageDeal, f.brokerage_deal_id)
    items = list(await db.scalars(select(TransactionFileItem).where(
        TransactionFileItem.file_id == f.id, TransactionFileItem.deleted_at.is_(None))
        .order_by(TransactionFileItem.sort_order, TransactionFileItem.created_at)))
    auto = await _auto_checks(db, deal) if deal else {}
    evaluated, blockers = [], []
    for i in items:
        met, detail = item_manually_satisfied(i), None
        if i.key in AUTO_KEYS and i.key in auto and i.status != "rejected":
            auto_met, detail = auto[i.key]
            met = met or auto_met
        evaluated.append((i, met, detail))
        if i.is_required and not met:
            blockers.append(i.label + (f" ({detail})" if detail else ""))
    for d in await db.scalars(select(Disclosure).where(Disclosure.brokerage_deal_id == f.brokerage_deal_id,
                                                       Disclosure.deleted_at.is_(None), Disclosure.is_blocking.is_(True))):
        if not disclosure_satisfied(d):
            blockers.append(f"Blocking disclosure: {d.title}")
    return evaluated, list(dict.fromkeys(blockers))


async def transaction_file_complete(db: AsyncSession, brokerage_deal_id: uuid.UUID) -> tuple[bool, list[str]]:
    """Public contract: True when every required compliance item is satisfied (commission release gate)."""
    f = await db.scalar(select(TransactionFile).where(TransactionFile.brokerage_deal_id == brokerage_deal_id,
                                                      TransactionFile.deleted_at.is_(None)))
    if not f:
        return False, ["Transaction file has not been started"]
    _, blockers = await evaluate_file(db, f)
    return not blockers, blockers


async def file_out(db: AsyncSession, f: TransactionFile, *, with_items: bool = True) -> FileOut:
    from app.modules.brokerage.models import BrokerageDeal

    evaluated, blockers = await evaluate_file(db, f)
    deal = await db.get(BrokerageDeal, f.brokerage_deal_id)
    o = FileOut.model_validate(f)
    required = [(i, met) for i, met, _ in evaluated if i.is_required]
    o.required_total, o.required_done = len(required), sum(1 for _, m in required if m)
    o.completeness_pct = round(100 * o.required_done / o.required_total, 1) if o.required_total else 100.0
    o.complete, o.blockers = not blockers, blockers
    if deal:
        o.deal_title, o.deal_stage = deal.title, deal.stage
        o.agent_name = (await names(db, "user", {deal.agent_id})).get(deal.agent_id) if deal.agent_id else None
    if with_items:
        refs = await document_refs(db, {i.document_id for i, _, _ in evaluated if i.document_id})
        for i, met, detail in evaluated:
            io = FileItemOut.model_validate(i)
            io.is_satisfied = met
            if detail and not io.evidence_note:
                io.evidence_note = detail
            io.document_title = (refs.get(i.document_id) or {}).get("title") if i.document_id else None
            o.items.append(io)
    return o


async def update_file_item(db: AsyncSession, item: TransactionFileItem, data: BaseModel,
                           actor: CurrentUser) -> TransactionFileItem:
    values = data.model_dump(exclude_unset=True)
    st = values.get("status")
    if st in ("approved", "waived", "rejected") and not actor.can("dealroom", "approve"):
        raise HTTPException(403, "Approving, waiving or rejecting compliance items requires dealroom approval")
    if st == "waived" and not (values.get("waived_reason") or "").strip():
        raise HTTPException(422, "A reason is required to waive a compliance item")
    if st == "provided" and not (values.get("document_id") or item.document_id or
                                 (values.get("evidence_note") or item.evidence_note or "").strip()):
        raise HTTPException(422, "Attach a document or describe the evidence")
    if "is_required" in values and values["is_required"] is None:
        values.pop("is_required")
    if "is_required" in values and values["is_required"] is False and not actor.can("dealroom", "approve"):
        raise HTTPException(403, "Only approvers can make a compliance item optional")
    if st is None:
        values.pop("status", None)
    if st in ("approved", "waived", "rejected"):
        values["reviewed_by_id"], values["reviewed_at"] = actor.id, utcnow()
    await patch_row(db, item, "transaction_file_item", values, actor)
    f = await db.get(TransactionFile, item.file_id)
    if item.document_id and f:
        await link_document(db, item.document_id, "brokerage_deal", f.brokerage_deal_id, actor)
    if f:
        await db.flush()
        _, blockers = await evaluate_file(db, f)
        if f.status != "approved":
            f.status = "complete" if not blockers else "open"
    await db.commit()
    return item


async def approve_file(db: AsyncSession, f: TransactionFile, actor: CurrentUser) -> TransactionFile:
    ok, blockers = await transaction_file_complete(db, f.brokerage_deal_id)
    if not ok:
        raise HTTPException(422, {"message": "Transaction file is incomplete", "unmet": blockers})
    old = f.status
    f.status, f.approved_by_id, f.approved_at, f.updated_by_id = "approved", actor.id, utcnow(), actor.id
    await audit.record(db, actor=actor, action="transaction_file.approved", entity_type="brokerage_deal",
                       entity_id=f.brokerage_deal_id, changes={"status": {"from": old, "to": "approved"}},
                       ip_address=actor.ip_address)
    await events.emit(db, "transaction_file.approved", brokerage_deal_id=f.brokerage_deal_id, actor=actor)
    await db.commit()
    return f


# ============================================================================ reassignment


async def reassign_user(db: AsyncSession, user_id: uuid.UUID, to_id: uuid.UUID) -> None:
    from sqlalchemy import update

    for model, col in ((Tour, "agent_id"), (DealRoom, "owner_id"), (Disclosure, "owner_id")):
        column = getattr(model, col)
        await db.execute(update(model).where(column == user_id, model.deleted_at.is_(None)).values({col: to_id}))
