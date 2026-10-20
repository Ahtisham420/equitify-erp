import uuid
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import Select, case, func, select

from app.common import audit
from app.common.query import ListParams, Page, apply_search, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, Authed, CurrentUser, require
from app.modules.compliance import service
from app.modules.compliance.models import (
    CHANNELS,
    CONSENT_STATES,
    DNC_STATUSES,
    EVENT_TYPES,
    PHONE_TYPES,
    RESTRICTIONS,
    ComplianceRecord,
    ConsentEvent,
    OutboundMessage,
    ProviderRestriction,
)
from app.modules.compliance.schemas import (
    CheckIn,
    CheckOut,
    ConsentIn,
    EventOut,
    ExportCheckIn,
    ExportCheckOut,
    OptOutIn,
    OutboundOut,
    RecordDetail,
    RecordFacets,
    RecordOut,
    RecordUpdate,
    RecordUpsert,
    RestrictionIn,
    RestrictionOut,
    SettingsOut,
    SettingsUpdate,
    SuppressIn,
)

router = APIRouter(prefix="/compliance", tags=["compliance"])

RECORD_SORTS = {
    "value": ComplianceRecord.normalized_value, "channel": ComplianceRecord.channel,
    "dnc_status": ComplianceRecord.dnc_status, "consent_state": ComplianceRecord.consent_state,
    "scrub_expires_on": ComplianceRecord.scrub_expires_on, "updated_at": ComplianceRecord.updated_at,
    "opted_out_at": ComplianceRecord.opted_out_at,
}


class RecordFilters:
    def __init__(
        self,
        q: str | None = Query(None, max_length=200),
        channel: list[str] | None = Query(None),
        dnc_status: list[str] | None = Query(None),
        consent_state: list[str] | None = Query(None),
        phone_type: list[str] | None = Query(None),
        suppressed: list[str] | None = Query(None, description="'suppressed' and/or 'active'"),
        person_id: uuid.UUID | None = None,
        scrub_expired: bool = False,
        provider: str | None = None,
    ):
        self.q, self.channel, self.dnc_status, self.consent_state = q, channel, dnc_status, consent_state
        self.phone_type, self.suppressed, self.person_id = phone_type, suppressed, person_id
        self.scrub_expired, self.provider = scrub_expired, provider

    def query(self, skip: set[str] = frozenset()) -> Select:
        stmt = select(ComplianceRecord).where(ComplianceRecord.deleted_at.is_(None))
        if self.q:
            digits = "".join(ch for ch in self.q if ch.isdigit())
            cols = [ComplianceRecord.value, ComplianceRecord.normalized_value, ComplianceRecord.suppression_reason]
            stmt = apply_search(stmt, digits if len(digits) >= 3 and "@" not in self.q else self.q, cols)
        for key, col in (("channel", ComplianceRecord.channel), ("dnc_status", ComplianceRecord.dnc_status),
                         ("consent_state", ComplianceRecord.consent_state), ("phone_type", ComplianceRecord.phone_type)):
            if key not in skip:
                stmt = in_filter(stmt, col, getattr(self, key))
        if "suppressed" not in skip and self.suppressed and len(set(self.suppressed)) == 1:
            stmt = stmt.where(ComplianceRecord.internal_suppression.is_(self.suppressed[0] == "suppressed"))
        if self.person_id:
            stmt = stmt.where(ComplianceRecord.person_id == self.person_id)
        if self.scrub_expired:
            stmt = stmt.where(ComplianceRecord.scrub_expires_on < date.today())
        if self.provider:
            stmt = stmt.where(ComplianceRecord.provider.ilike(f"%{self.provider}%"))
        return stmt


def _can_record_opt_out(user: Authed) -> CurrentUser:
    # Recording an opt-out is protective, so anyone who works outreach may do it.
    if not (user.can("compliance", "edit") or user.can("outreach", "create")):
        raise HTTPException(403, "Missing permission compliance:edit")
    return user


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("compliance", "view"))):
    return {"channels": CHANNELS, "phone_types": PHONE_TYPES, "dnc_statuses": DNC_STATUSES,
            "consent_states": CONSENT_STATES, "event_types": EVENT_TYPES, "restrictions": RESTRICTIONS,
            "state_utc_offsets": service.STATE_UTC_OFFSETS}


@router.get("/records", response_model=Page[RecordOut])
async def list_records(db: DB, params: ListParams = Depends(), f: RecordFilters = Depends(),
                       _: CurrentUser = Depends(require("compliance", "view"))):
    stmt = apply_sort(f.query(), params.sort, RECORD_SORTS, ComplianceRecord.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[RecordOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/records/facets", response_model=RecordFacets)
async def record_facets(db: DB, f: RecordFilters = Depends(), _: CurrentUser = Depends(require("compliance", "view"))):
    sub = f.query({"suppressed"}).order_by(None).subquery()
    flag = case((sub.c.internal_suppression.is_(True), "suppressed"), else_="active")
    rows = await db.execute(select(flag, func.count()).group_by(flag))
    return RecordFacets(
        channel=await facet_counts(db, f.query({"channel"}), ComplianceRecord.channel),
        dnc_status=await facet_counts(db, f.query({"dnc_status"}), ComplianceRecord.dnc_status),
        consent_state=await facet_counts(db, f.query({"consent_state"}), ComplianceRecord.consent_state),
        phone_type=await facet_counts(db, f.query({"phone_type"}), ComplianceRecord.phone_type),
        suppressed={str(k): int(v) for k, v in rows.all()},
    )


@router.post("/records", response_model=RecordOut, status_code=201)
async def upsert_record(body: RecordUpsert, db: DB, user: CurrentUser = Depends(require("compliance", "edit"))):
    """Create or update scrub/classification facts (phone type, jurisdiction, DNC scrub, provider)."""
    return await service.upsert_record(db, body, user)


@router.get("/records/{record_id}", response_model=RecordDetail)
async def get_record(record_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("compliance", "view"))):
    rec = await db.get(ComplianceRecord, record_id)
    if not rec or rec.deleted_at:
        raise HTTPException(404, "Compliance record not found")
    events = list(await db.scalars(
        select(ConsentEvent).where(ConsentEvent.normalized_value == rec.normalized_value,
                                   ConsentEvent.channel.in_(service.related_channels(rec.channel)))
        .order_by(ConsentEvent.occurred_at.desc()).limit(200)))
    allowed, reasons = await service.check_send(db, channel=rec.channel, value=rec.value)
    await db.commit()  # check_send may lazily create the settings row
    out = RecordDetail.model_validate(rec)
    out.events = [EventOut.model_validate(e) for e in events]
    out.allowed, out.reasons = allowed, reasons
    return out


@router.patch("/records/{record_id}", response_model=RecordOut)
async def update_record(record_id: uuid.UUID, body: RecordUpdate, db: DB,
                        user: CurrentUser = Depends(require("compliance", "edit"))):
    rec = await db.get(ComplianceRecord, record_id)
    if not rec or rec.deleted_at:
        raise HTTPException(404, "Compliance record not found")
    return await service.update_record(db, rec, body.model_dump(exclude_unset=True), user)


@router.post("/check", response_model=CheckOut)
async def check(body: CheckIn, db: DB, _: CurrentUser = Depends(require("compliance", "view"))):
    """Send-time eligibility test for a value. Nothing is sent or logged."""
    allowed, reasons = await service.check_send(db, channel=body.channel, value=body.value, at=body.at)
    norm = service.normalize_value(body.channel, body.value)
    rec = (await service._records(db, body.channel, norm)).get(body.channel) if norm else None
    await db.commit()
    return CheckOut(channel=body.channel, value=body.value, normalized_value=norm, allowed=allowed, reasons=reasons,
                    record=RecordOut.model_validate(rec) if rec else None)


@router.post("/opt-out")
async def opt_out(body: OptOutIn, db: DB, user: CurrentUser = Depends(_can_record_opt_out)):
    """Records an opt-out; immediately suppresses all of the person's contact points and exits sequences."""
    result = await service.opt_out(db, body, user)
    return {"record": RecordOut.model_validate(result["record"]), "propagated": result["propagated"],
            "enrollments_exited": result["enrollments_exited"]}


@router.post("/consent", response_model=RecordOut)
async def consent(body: ConsentIn, db: DB, user: CurrentUser = Depends(require("compliance", "edit"))):
    """Records consent granted/revoked. Reversing a suppression needs compliance:approve and evidence."""
    return await service.set_consent(db, body, user)


@router.post("/suppress", response_model=RecordOut)
async def suppress(body: SuppressIn, db: DB, user: CurrentUser = Depends(_can_record_opt_out)):
    return await service.manual_suppress(db, body, user)


@router.get("/events", response_model=Page[EventOut])
async def list_events(
    db: DB, params: ListParams = Depends(), event_type: list[str] | None = Query(None),
    channel: list[str] | None = Query(None), person_id: uuid.UUID | None = None,
    _: CurrentUser = Depends(require("compliance", "view")),
):
    stmt = select(ConsentEvent)
    stmt = apply_search(stmt, params.q, [ConsentEvent.normalized_value, ConsentEvent.source, ConsentEvent.evidence,
                                         ConsentEvent.actor_name])
    stmt = in_filter(stmt, ConsentEvent.event_type, event_type)
    stmt = in_filter(stmt, ConsentEvent.channel, channel)
    if person_id:
        stmt = stmt.where(ConsentEvent.person_id == person_id)
    items, total = await paginate(db, stmt.order_by(ConsentEvent.occurred_at.desc()), params)
    return Page[EventOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/outbound", response_model=Page[OutboundOut])
async def outbound_log(
    db: DB, params: ListParams = Depends(), channel: list[str] | None = Query(None),
    allowed: list[str] | None = Query(None, description="'true' and/or 'false'"),
    person_id: uuid.UUID | None = None, interaction_id: uuid.UUID | None = None,
    date_from: date | None = None, date_to: date | None = None,
    _: CurrentUser = Depends(require("compliance", "view")),
):
    """Immutable outbound content log (read-only)."""
    stmt = select(OutboundMessage)
    stmt = apply_search(stmt, params.q, [OutboundMessage.to_value, OutboundMessage.normalized_value,
                                         OutboundMessage.content, OutboundMessage.actor_name])
    stmt = in_filter(stmt, OutboundMessage.channel, channel)
    if allowed and len(set(allowed)) == 1:
        stmt = stmt.where(OutboundMessage.allowed.is_(allowed[0] == "true"))
    if person_id:
        stmt = stmt.where(OutboundMessage.person_id == person_id)
    if interaction_id:
        stmt = stmt.where(OutboundMessage.interaction_id == interaction_id)
    if date_from:
        stmt = stmt.where(OutboundMessage.sent_at >= datetime.combine(date_from, time.min, tzinfo=timezone.utc))
    if date_to:
        stmt = stmt.where(OutboundMessage.sent_at < datetime.combine(date_to + timedelta(days=1), time.min,
                                                                     tzinfo=timezone.utc))
    sorts = {"sent_at": OutboundMessage.sent_at, "channel": OutboundMessage.channel}
    items, total = await paginate(db, apply_sort(stmt, params.sort, sorts, OutboundMessage.sent_at.desc()), params)
    return Page[OutboundOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/settings", response_model=SettingsOut)
async def get_settings(db: DB, _: CurrentUser = Depends(require("compliance", "view"))):
    s = await service.get_settings(db)
    await db.commit()
    return s


@router.patch("/settings", response_model=SettingsOut)
async def update_settings(body: SettingsUpdate, db: DB, user: CurrentUser = Depends(require("compliance", "edit"))):
    if not user.is_admin:
        raise HTTPException(403, "Only administrators can change compliance settings")
    return await service.update_settings(db, body, user)


@router.get("/provider-restrictions", response_model=list[RestrictionOut])
async def list_restrictions(db: DB, _: CurrentUser = Depends(require("compliance", "view"))):
    return list(await db.scalars(select(ProviderRestriction).where(ProviderRestriction.deleted_at.is_(None))
                                 .order_by(ProviderRestriction.provider)))


@router.post("/provider-restrictions", response_model=RestrictionOut, status_code=201)
async def create_restriction(body: RestrictionIn, db: DB, user: CurrentUser = Depends(require("compliance", "edit"))):
    existing = await db.scalar(select(ProviderRestriction).where(ProviderRestriction.provider == body.provider))
    if existing and not existing.deleted_at:
        raise HTTPException(409, "This provider already has a restriction")
    r = existing or ProviderRestriction(provider=body.provider, created_by_id=user.id)
    for k, v in body.model_dump().items():
        setattr(r, k, v)
    r.deleted_at = None
    r.updated_by_id = user.id
    db.add(r)
    await db.flush()
    await audit.record(db, actor=user, action="provider_restriction.created", entity_type="provider_restriction",
                       entity_id=r.id, summary=f"{r.provider}: {r.restriction}", ip_address=user.ip_address)
    await db.commit()
    return r


@router.patch("/provider-restrictions/{restriction_id}", response_model=RestrictionOut)
async def update_restriction(restriction_id: uuid.UUID, body: RestrictionIn, db: DB,
                             user: CurrentUser = Depends(require("compliance", "edit"))):
    r = await db.get(ProviderRestriction, restriction_id)
    if not r or r.deleted_at:
        raise HTTPException(404, "Restriction not found")
    data = body.model_dump()
    changes = audit.diff(r, data)
    for k, v in data.items():
        setattr(r, k, v)
    r.updated_by_id = user.id
    if changes:
        await audit.record(db, actor=user, action="provider_restriction.updated", entity_type="provider_restriction",
                           entity_id=r.id, changes=changes, ip_address=user.ip_address)
    await db.commit()
    return r


@router.post("/export-check", response_model=ExportCheckOut)
async def export_check(body: ExportCheckIn, db: DB, _: Authed):
    """Warnings/blocks before exporting contact data (restricted providers, opted-out values)."""
    blocked, warnings = await service.export_warnings(
        db, providers=body.providers, values=[(v.channel, v.value) for v in body.values])
    return ExportCheckOut(blocked=blocked, warnings=warnings)

