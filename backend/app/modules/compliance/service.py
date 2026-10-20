"""Communication compliance: send-time eligibility, consent, opt-out propagation and the outbound log.

Public API used by other modules:
    check_send(db, channel=..., value=..., at=None) -> (allowed, reasons)
    status_for(db, channel, value) -> dict
    suppress_value(...), log_outbound(...), person_suppression_reasons(...), export_warnings(...)
"""
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.core import events
from app.core.security import utcnow
from app.modules.compliance.models import (
    CHANNELS,
    ComplianceRecord,
    ComplianceSettings,
    ConsentEvent,
    OutboundMessage,
    ProviderRestriction,
)

DEFAULT_QUIET_HOURS = {"start": "08:00", "end": "21:00", "channels": ["phone", "sms"], "default_utc_offset": -6}
DEFAULT_FREQUENCY_CAPS = {"per_contact": {"count": 3, "period_days": 7}}
DEFAULT_CHANNEL_CAPS = {
    "phone": {"count": 2, "period_days": 1},
    "sms": {"count": 1, "period_days": 1},
    "email": {"count": 2, "period_days": 7},
}

# Standard-time UTC offsets; US daylight saving is applied by _utc_offset except where not observed.
STATE_UTC_OFFSETS: dict[str, int] = {
    **dict.fromkeys(["CT", "DC", "DE", "FL", "GA", "IN", "KY", "MA", "MD", "ME", "MI", "NC", "NH", "NJ", "NY", "OH",
                     "PA", "RI", "SC", "VA", "VT", "WV"], -5),
    **dict.fromkeys(["AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI"], -6),
    **dict.fromkeys(["AZ", "CO", "ID", "MT", "NM", "UT", "WY"], -7),
    **dict.fromkeys(["CA", "NV", "OR", "WA"], -8),
    "AK": -9, "HI": -10, "PR": -4, "GU": 10, "VI": -4,
}
NO_DST = {"AZ", "HI", "PR", "GU", "VI"}
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# --------------------------------------------------------------------------- normalization & lookups

def normalize_value(channel: str, value: str | None) -> str:
    v = (value or "").strip()
    if channel == "email":
        return v.lower() if _EMAIL.match(v) else ""
    digits = re.sub(r"\D", "", v)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits if len(digits) >= 7 else ""


def related_channels(channel: str) -> list[str]:
    """A phone number's call and text records share DNC/suppression facts."""
    return ["email"] if channel == "email" else ["phone", "sms"]


def _require_normalized(channel: str, value: str) -> str:
    if channel not in CHANNELS:
        raise HTTPException(422, f"Unsupported channel '{channel}'")
    norm = normalize_value(channel, value)
    if not norm:
        raise HTTPException(422, f"'{value}' is not a valid {'email address' if channel == 'email' else 'phone number'}")
    return norm


async def get_settings(db: AsyncSession) -> ComplianceSettings:
    s = await db.scalar(select(ComplianceSettings).where(ComplianceSettings.deleted_at.is_(None))
                        .order_by(ComplianceSettings.created_at).limit(1))
    if s is None:
        s = ComplianceSettings(quiet_hours=dict(DEFAULT_QUIET_HOURS), frequency_caps=dict(DEFAULT_FREQUENCY_CAPS),
                               channel_caps=dict(DEFAULT_CHANNEL_CAPS), scrub_validity_days=31,
                               not_interested_suppression_days=180)
        db.add(s)
        await db.flush()
    return s


async def _records(db: AsyncSession, channel: str, norm: str) -> dict[str, ComplianceRecord]:
    rows = await db.scalars(select(ComplianceRecord).where(
        ComplianceRecord.normalized_value == norm, ComplianceRecord.channel.in_(related_channels(channel)),
        ComplianceRecord.deleted_at.is_(None)))
    return {r.channel: r for r in rows}


async def upsert(db: AsyncSession, channel: str, norm: str, value: str, person_id: uuid.UUID | None = None,
                 actor_id: uuid.UUID | None = None) -> ComplianceRecord:
    rec = await db.scalar(select(ComplianceRecord).where(
        ComplianceRecord.channel == channel, ComplianceRecord.normalized_value == norm))
    if rec is None:
        rec = ComplianceRecord(channel=channel, value=value.strip()[:320], normalized_value=norm, person_id=person_id,
                               phone_type="unknown", jurisdiction_country="US", dnc_status="unknown",
                               consent_state="unknown", internal_suppression=False, opt_out_count=0,
                               created_by_id=actor_id, updated_by_id=actor_id)
        db.add(rec)
        await db.flush()
    elif rec.deleted_at:
        rec.deleted_at = None
    if person_id and not rec.person_id:
        rec.person_id = person_id
    return rec


def _suppression_active(r: ComplianceRecord, at: datetime) -> bool:
    return bool(r.internal_suppression) and (r.suppressed_until is None or r.suppressed_until > at)


def _nth_sunday(year: int, month: int, n: int) -> date:
    d = date(year, month, 1)
    d += timedelta(days=(6 - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def _utc_offset(state: str | None, at: datetime, default: float) -> float:
    st = (state or "").upper()
    if st not in STATE_UTC_OFFSETS:
        return default
    offset = STATE_UTC_OFFSETS[st]
    if st not in NO_DST:
        d = at.astimezone(timezone.utc).date()
        if _nth_sunday(d.year, 3, 2) <= d < _nth_sunday(d.year, 11, 1):
            offset += 1
    return offset


def _minutes(hhmm: str) -> int:
    h, _, m = (hhmm or "00:00").partition(":")
    return int(h) * 60 + int(m or 0)


def _event(db: AsyncSession, rec: ComplianceRecord, event_type: str, *, source: str | None, evidence: str | None,
           actor, details: dict | None = None) -> ConsentEvent:
    ev = ConsentEvent(
        record_id=rec.id, channel=rec.channel, normalized_value=rec.normalized_value, person_id=rec.person_id,
        event_type=event_type, source=source, evidence=evidence, actor_id=getattr(actor, "id", None),
        actor_name=getattr(actor, "full_name", None), details=audit.to_jsonable(details) if details else None,
    )
    db.add(ev)
    return ev


# --------------------------------------------------------------------------- send-time eligibility

async def check_send(db: AsyncSession, *, channel: str, value: str, at: datetime | None = None) -> tuple[bool, list[str]]:
    """Evaluates the current compliance state for an outbound call/text/email. Blocks with visible reasons."""
    if channel not in CHANNELS:
        return False, [f"Unsupported channel '{channel}'"]
    norm = normalize_value(channel, value)
    if not norm:
        return False, [f"'{value}' is not a valid {'email address' if channel == 'email' else 'phone number'}"]
    at = at or utcnow()
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    settings = await get_settings(db)
    recs = await _records(db, channel, norm)
    rec = recs.get(channel)
    related = list(recs.values())
    reasons: list[str] = []

    if channel in ("phone", "sms"):
        scrub = rec if rec and rec.scrub_date else next((r for r in related if r.scrub_date), None)
        if scrub is None or scrub.dnc_status == "unknown":
            reasons.append("No do-not-call scrub on file for this number")
        elif scrub.scrub_expires_on and scrub.scrub_expires_on < at.date():
            reasons.append(f"Do-not-call scrub expired on {scrub.scrub_expires_on:%b %d, %Y}"
                           f" (source: {scrub.scrub_source or 'unknown'})")
        elif scrub.dnc_status == "listed" and not (rec and rec.consent_state == "granted"):
            reasons.append("Number is on a do-not-call list and there is no recorded consent")
        if channel == "sms" and any(r.phone_type == "landline" for r in related):
            reasons.append("Landline numbers cannot receive text messages")

    suppressed = next((r for r in related if _suppression_active(r, at)), None)
    if suppressed:
        until = f" until {suppressed.suppressed_until:%b %d, %Y}" if suppressed.suppressed_until else ""
        reasons.append(f"Internally suppressed{until}: {suppressed.suppression_reason or 'no reason recorded'}")
    revoked = next((r for r in related if r.consent_state == "revoked"), None)
    if revoked:
        when = f" on {revoked.opted_out_at:%b %d, %Y}" if revoked.opted_out_at else ""
        reasons.append(f"Contact opted out / revoked consent{when}")

    qh = {**DEFAULT_QUIET_HOURS, **(settings.quiet_hours or {})}
    if channel in qh.get("channels", []):
        state = next((r.jurisdiction_state for r in related if r.jurisdiction_state), None)
        offset = _utc_offset(state, at, float(qh.get("default_utc_offset", -6)))
        local = at.astimezone(timezone.utc) + timedelta(hours=offset)
        start, end, now_m = _minutes(qh["start"]), _minutes(qh["end"]), local.hour * 60 + local.minute
        inside = start <= now_m < end if start < end else (now_m >= start or now_m < end)
        if not inside:
            reasons.append(f"Outside permitted contact hours ({qh['start']}–{qh['end']} local); it is "
                           f"{local:%H:%M} in {state or 'the default timezone'}")

    person_id = next((r.person_id for r in related if r.person_id), None)
    fc = (settings.frequency_caps or {}).get("per_contact")
    if fc and fc.get("count") is not None:
        days = int(fc.get("period_days", 7))
        target = OutboundMessage.person_id == person_id if person_id else OutboundMessage.normalized_value == norm
        n = await db.scalar(select(func.count()).select_from(OutboundMessage).where(
            target, OutboundMessage.allowed.is_(True), OutboundMessage.sent_at >= at - timedelta(days=days),
            OutboundMessage.sent_at <= at))
        if (n or 0) >= int(fc["count"]):
            reasons.append(f"Frequency cap reached: {n} outbound touches in the last {days} days (limit {fc['count']})")
    cc = (settings.channel_caps or {}).get(channel)
    if cc and cc.get("count") is not None:
        days = int(cc.get("period_days", 1))
        n = await db.scalar(select(func.count()).select_from(OutboundMessage).where(
            OutboundMessage.channel == channel, OutboundMessage.normalized_value == norm,
            OutboundMessage.allowed.is_(True), OutboundMessage.sent_at >= at - timedelta(days=days),
            OutboundMessage.sent_at <= at))
        if (n or 0) >= int(cc["count"]):
            reasons.append(f"{channel.upper() if channel == 'sms' else channel.title()} cap reached: {n} in the last "
                           f"{days} day{'s' if days != 1 else ''} (limit {cc['count']})")
    return not reasons, reasons


async def status_for(db: AsyncSession, channel: str, value: str) -> dict:
    allowed, reasons = await check_send(db, channel=channel, value=value)
    norm = normalize_value(channel, value)
    rec = (await _records(db, channel, norm)).get(channel) if norm else None
    return {
        "channel": channel, "value": value, "normalized_value": norm, "allowed": allowed, "reasons": reasons,
        "dnc_status": rec.dnc_status if rec else "unknown", "consent_state": rec.consent_state if rec else "unknown",
        "suppressed": bool(rec and _suppression_active(rec, utcnow())),
        "phone_type": rec.phone_type if rec else None, "record_id": rec.id if rec else None,
    }


async def log_outbound(db: AsyncSession, *, channel: str, value: str, content: str | None, actor,
                       allowed: bool, reasons: list[str] | None = None, subject: str | None = None,
                       interaction_id: uuid.UUID | None = None, person_id: uuid.UUID | None = None) -> OutboundMessage:
    """Appends to the immutable outbound content log. Does not commit."""
    msg = OutboundMessage(
        channel=channel, to_value=value.strip()[:320], normalized_value=normalize_value(channel, value) or value.strip(),
        person_id=person_id, subject=subject, content=content, actor_id=getattr(actor, "id", None),
        actor_name=getattr(actor, "full_name", None), interaction_id=interaction_id, allowed=allowed,
        block_reasons=reasons or [],
    )
    db.add(msg)
    await db.flush()
    return msg


# --------------------------------------------------------------------------- CRM lookups (guarded lazy imports)

async def _person_for_value(db: AsyncSession, channel: str, norm: str) -> uuid.UUID | None:
    try:
        from app.modules.contacts.models import ContactPoint
    except ImportError:
        return None
    if channel == "email":
        cond = func.lower(ContactPoint.value) == norm
        kind = "email"
    else:
        cond = func.right(func.regexp_replace(ContactPoint.value, "[^0-9]", "", "g"), 10) == norm[-10:]
        kind = "phone"
    return await db.scalar(select(ContactPoint.person_id).where(
        ContactPoint.kind == kind, ContactPoint.person_id.is_not(None), cond).limit(1))


async def person_contact_values(db: AsyncSession, person_id: uuid.UUID) -> list[tuple[str, str, str | None]]:
    """[(kind 'phone'|'email', value, label)] from contact points plus the person's primary phone/email."""
    out: list[tuple[str, str, str | None]] = []
    try:
        from app.modules.contacts.models import ContactPoint

        stmt = select(ContactPoint).where(ContactPoint.person_id == person_id)
        if hasattr(ContactPoint, "deleted_at"):
            stmt = stmt.where(ContactPoint.deleted_at.is_(None))
        for cp in await db.scalars(stmt):
            if cp.kind in ("phone", "email") and cp.value:
                out.append((cp.kind, cp.value, cp.label))
    except ImportError:
        pass
    try:
        from app.modules.contacts.models import Person

        p = await db.get(Person, person_id)
        if p is not None:
            if p.primary_phone:
                out.append(("phone", p.primary_phone, "Primary"))
            if p.primary_email:
                out.append(("email", p.primary_email, "Primary"))
    except ImportError:
        pass
    seen: set[tuple[str, str]] = set()
    unique = []
    for kind, value, label in out:
        key = (kind, normalize_value("email" if kind == "email" else "phone", value))
        if key[1] and key not in seen:
            seen.add(key)
            unique.append((kind, value, label))
    return unique


async def _exit_enrollments(db: AsyncSession, person_id: uuid.UUID, reason: str) -> int:
    try:
        from app.modules.outreach.models import SequenceEnrollment
    except ImportError:
        return 0
    res = await db.execute(
        update(SequenceEnrollment)
        .where(SequenceEnrollment.person_id == person_id, SequenceEnrollment.status.in_(["active", "paused"]))
        .values(status="exited", exit_reason=reason, exited_at=utcnow(), next_step_at=None)
    )
    return res.rowcount or 0


# --------------------------------------------------------------------------- suppression, opt-out, consent

async def suppress_value(db: AsyncSession, *, channel: str, value: str, reason: str, actor=None,
                         person_id: uuid.UUID | None = None, until: datetime | None = None,
                         source: str = "manual") -> ComplianceRecord | None:
    """Internal suppression of a value (and its call/text sibling). Does not commit."""
    norm = normalize_value(channel, value)
    if not norm:
        return None
    if until is not None and until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    first = None
    for ch in related_channels(channel):
        rec = await upsert(db, ch, norm, value, person_id, getattr(actor, "id", None))
        first = first or rec
        if _suppression_active(rec, utcnow()) and rec.suppressed_until is None:
            continue  # already indefinitely suppressed; never shorten it
        rec.internal_suppression = True
        rec.suppression_reason = reason[:200]
        rec.suppressed_at = utcnow()
        rec.suppressed_until = until
        _event(db, rec, "suppressed", source=source, evidence=None, actor=actor,
               details={"reason": reason, "until": until})
    return first


async def _apply_opt_out(db: AsyncSession, *, channel: str, value: str, person_id: uuid.UUID | None, source: str,
                         evidence: str | None, actor, event_type: str = "opt_out") -> dict:
    from app.modules.tasks.service import record_rule_run, rule_config

    norm = _require_normalized(channel, value)
    now = utcnow()
    rec = await upsert(db, channel, norm, value, person_id, getattr(actor, "id", None))
    person_id = person_id or rec.person_id or await _person_for_value(db, channel, norm)
    if person_id and not rec.person_id:
        rec.person_id = person_id
    rec.consent_state = "revoked"
    rec.opted_out_at = now
    rec.opt_out_count = (rec.opt_out_count or 0) + 1
    rec.internal_suppression = True
    rec.suppression_reason = f"Opted out ({source})"[:200]
    rec.suppressed_at = now
    rec.suppressed_until = None
    rec.updated_by_id = getattr(actor, "id", None)
    _event(db, rec, event_type, source=source, evidence=evidence, actor=actor)

    targets: dict[tuple[str, str], str] = {}
    for ch in related_channels(channel):
        targets[(ch, norm)] = value
    enabled, _ = await rule_config(db, "compliance.optout_propagation")
    if enabled and person_id:
        for kind, v, _label in await person_contact_values(db, person_id):
            for ch in related_channels("email" if kind == "email" else "phone"):
                n = normalize_value(ch, v)
                if n:
                    targets.setdefault((ch, n), v)
    targets.pop((channel, norm), None)

    propagated = 0
    for (ch, n), v in targets.items():
        r = await upsert(db, ch, n, v, person_id, getattr(actor, "id", None))
        if _suppression_active(r, now) and r.suppressed_until is None:
            continue
        r.internal_suppression = True
        r.suppression_reason = f"Opt-out propagated from {channel} {value}"[:200]
        r.suppressed_at = now
        r.suppressed_until = None
        _event(db, r, "suppressed", source="opt_out_propagation", evidence=None, actor=actor,
               details={"origin_channel": channel, "origin_value": norm})
        propagated += 1

    exited = await _exit_enrollments(db, person_id, "opted_out") if person_id else 0
    if enabled:
        await record_rule_run(db, "compliance.optout_propagation")
    await audit.record(db, actor=actor, action="compliance.opted_out", entity_type="compliance_record",
                       entity_id=rec.id, summary=f"{channel} {norm}",
                       changes={"propagated": propagated, "enrollments_exited": exited, "source": source},
                       ip_address=getattr(actor, "ip_address", None))
    if person_id:
        await audit.record(db, actor=actor, action="person.opted_out", entity_type="person", entity_id=person_id,
                           summary=f"Opted out via {channel}", ip_address=getattr(actor, "ip_address", None))
    await events.emit(db, "compliance.opted_out", person_id=person_id, channel=channel, value=norm, actor=actor)
    return {"record": rec, "propagated": propagated, "enrollments_exited": exited}


async def opt_out(db: AsyncSession, data, actor) -> dict:
    result = await _apply_opt_out(db, channel=data.channel, value=data.value, person_id=data.person_id,
                                  source=data.source, evidence=data.evidence, actor=actor)
    await db.commit()
    return result


async def set_consent(db: AsyncSession, data, actor) -> ComplianceRecord:
    if data.state == "revoked":
        result = await _apply_opt_out(db, channel=data.channel, value=data.value, person_id=data.person_id,
                                      source=data.source, evidence=data.evidence, actor=actor,
                                      event_type="consent_revoked")
        await db.commit()
        return result["record"]

    norm = _require_normalized(data.channel, data.value)
    rec = await upsert(db, data.channel, norm, data.value, data.person_id, actor.id)
    reversing = rec.consent_state == "revoked" or (rec.internal_suppression and data.lift_suppression)
    if reversing:
        # Users cannot casually reverse suppression: approval permission plus recorded evidence.
        if not actor.can("compliance", "approve"):
            raise HTTPException(403, "Reversing an opt-out or suppression requires compliance approval permission")
        if not data.evidence or len(data.evidence.strip()) < 10:
            raise HTTPException(422, "Describe the evidence of the new consent (at least 10 characters)")
    now = utcnow()
    before = {"consent_state": rec.consent_state, "internal_suppression": rec.internal_suppression}
    rec.consent_state = "granted"
    rec.consent_source = data.source
    rec.consent_date = now
    rec.updated_by_id = actor.id
    _event(db, rec, "consent_granted", source=data.source, evidence=data.evidence, actor=actor)
    if reversing and rec.internal_suppression:
        rec.internal_suppression = False
        rec.suppression_reason = None
        rec.suppressed_until = None
        _event(db, rec, "suppression_lifted", source=data.source, evidence=data.evidence, actor=actor,
               details={"previous": before})
    await audit.record(db, actor=actor, action="compliance.consent_granted", entity_type="compliance_record",
                       entity_id=rec.id, summary=f"{rec.channel} {rec.normalized_value}",
                       changes={"from": before, "to": {"consent_state": "granted",
                                                       "internal_suppression": rec.internal_suppression}},
                       ip_address=actor.ip_address)
    await db.commit()
    return rec


async def manual_suppress(db: AsyncSession, data, actor) -> ComplianceRecord:
    _require_normalized(data.channel, data.value)
    rec = await suppress_value(db, channel=data.channel, value=data.value, reason=data.reason, actor=actor,
                               person_id=data.person_id, until=data.until, source="manual")
    await audit.record(db, actor=actor, action="compliance.suppressed", entity_type="compliance_record",
                       entity_id=rec.id if rec else None, summary=f"{data.channel} {data.value}: {data.reason}",
                       ip_address=actor.ip_address)
    await db.commit()
    return rec


async def person_suppression_reasons(db: AsyncSession, person_id: uuid.UUID) -> list[str]:
    now = utcnow()
    rows = await db.scalars(select(ComplianceRecord).where(
        ComplianceRecord.person_id == person_id, ComplianceRecord.deleted_at.is_(None),
        or_(ComplianceRecord.consent_state == "revoked", ComplianceRecord.internal_suppression.is_(True))))
    reasons = []
    for r in rows:
        if r.consent_state == "revoked":
            reasons.append(f"Opted out on {r.channel} {r.value}")
        elif _suppression_active(r, now):
            reasons.append(f"{r.channel.title()} {r.value} suppressed: {r.suppression_reason or 'no reason'}")
    return reasons


# --------------------------------------------------------------------------- scrub facts & settings

async def upsert_record(db: AsyncSession, data, actor) -> ComplianceRecord:
    norm = _require_normalized(data.channel, data.value)
    rec = await upsert(db, data.channel, norm, data.value, data.person_id, actor.id)
    values = data.model_dump(exclude_unset=True, exclude={"channel", "value"})
    return await update_record(db, rec, values, actor, created=True)


async def update_record(db: AsyncSession, rec: ComplianceRecord, values: dict, actor, created: bool = False):
    values = {k: v for k, v in values.items() if k != "person_id" or v is not None}
    if values.get("jurisdiction_state"):
        values["jurisdiction_state"] = values["jurisdiction_state"].upper()
    if values.get("jurisdiction_country"):
        values["jurisdiction_country"] = values["jurisdiction_country"].upper()
    if "scrub_date" in values or "dnc_status" in values:
        scrub_date = values.get("scrub_date", rec.scrub_date)
        if scrub_date:
            settings = await get_settings(db)
            values["scrub_expires_on"] = scrub_date + timedelta(days=settings.scrub_validity_days or 31)
    changes = audit.diff(rec, values)
    if not changes and not created:
        return rec
    for k, v in values.items():
        setattr(rec, k, v)
    rec.updated_by_id = actor.id
    if {"dnc_status", "scrub_date", "scrub_source"} & changes.keys():
        _event(db, rec, "dnc_scrubbed", source=rec.scrub_source, evidence=None, actor=actor,
               details={k: changes[k] for k in ("dnc_status", "scrub_date", "scrub_source") if k in changes})
    await audit.record(db, actor=actor, action="compliance_record.updated", entity_type="compliance_record",
                       entity_id=rec.id, summary=f"{rec.channel} {rec.normalized_value}", changes=changes or None,
                       ip_address=actor.ip_address)
    await db.commit()
    return rec


async def update_settings(db: AsyncSession, data, actor) -> ComplianceSettings:
    s = await get_settings(db)
    values = data.model_dump(exclude_unset=True, mode="json")
    if "counsel_reviewed_at" in values and values["counsel_reviewed_at"]:
        values["counsel_reviewed_at"] = date.fromisoformat(values["counsel_reviewed_at"])
    changes = audit.diff(s, values)
    for k, v in values.items():
        setattr(s, k, v)
    s.updated_by_id = actor.id
    if changes:
        await audit.record(db, actor=actor, action="compliance_settings.updated", entity_type="compliance_settings",
                           entity_id=s.id, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return s


async def export_warnings(db: AsyncSession, *, providers: list[str] | None = None,
                          values: list[tuple[str, str]] | None = None) -> tuple[bool, list[str]]:
    """Warnings (and hard blocks) before exporting contact data sourced from restricted providers."""
    providers = {p for p in (providers or []) if p}
    warnings: list[str] = []
    opted_out = 0
    for channel, value in values or []:
        norm = normalize_value(channel, value)
        if not norm:
            continue
        for r in (await _records(db, channel, norm)).values():
            if r.provider:
                providers.add(r.provider)
            if r.consent_state == "revoked" or _suppression_active(r, utcnow()):
                opted_out += 1
                break
    blocked = False
    if providers:
        rows = await db.scalars(select(ProviderRestriction).where(
            ProviderRestriction.is_active.is_(True), ProviderRestriction.deleted_at.is_(None),
            func.lower(ProviderRestriction.provider).in_([p.lower() for p in providers])))
        for r in rows:
            label = r.restriction.replace("_", " ")
            warnings.append(f"Data from {r.provider} is restricted ({label})" + (f": {r.notes}" if r.notes else ""))
            blocked = blocked or r.block_export
    if opted_out:
        warnings.append(f"{opted_out} contact value{'s are' if opted_out != 1 else ' is'} opted out or suppressed")
    return blocked, warnings
