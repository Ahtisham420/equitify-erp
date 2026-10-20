"""Platform administration (spec 36): integrations, credentials, feature flags, webhooks, job monitoring,
export monitoring, retention/legal hold, backups and system health.

Public helpers other modules may import (lazily, inside functions):
    flag_enabled(db, key, user) -> bool
    track_job(db, key)                       async context manager -> handle with `.counts` dict
    on_legal_hold(db, entity_type, entity_id) -> bool
    get_credentials(db, category, provider=None) -> dict
"""
import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import urllib.error
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import AuditEvent, to_jsonable
from app.common.query import ListParams, apply_search, paginate
from app.core.config import settings
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.platform import providers
from app.modules.platform.models import (
    INTEGRATION_CATEGORIES,
    BackupRecord,
    FeatureFlag,
    IntegrationProvider,
    JobRun,
    LegalHold,
    RetentionPolicy,
    WebhookDelivery,
    WebhookSubscription,
)
from app.modules.platform.schemas import (
    BackupIn,
    BackupOut,
    CategoryOut,
    CredentialsIn,
    DeliverResult,
    FlagCreate,
    FlagUpdate,
    HoldIn,
    IntegrationCreate,
    IntegrationOut,
    IntegrationUpdate,
    ProviderOption,
    RetentionIn,
    SubscriptionCreate,
    SubscriptionOut,
    SubscriptionUpdate,
)

# Domain events bridged to outbound webhooks (see handlers.py).
WEBHOOK_EVENTS = [
    "property.created", "property.updated",
    "opportunity.stage_changed", "opportunity.dead",
    "offer.sent", "offer.accepted", "offer.expired",
    "contract.executed", "closing.completed",
    "lease.created", "lease.updated", "lease.verified",
    "loan.maturity_window", "compliance.opted_out", "signal.created",
]
MAX_ATTEMPTS = 8
DELIVERY_TIMEOUT_SECONDS = 10
STALE_SENDING = timedelta(minutes=10)


def _not_found(what: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")


# --- Encryption at rest --------------------------------------------------------------------------


@lru_cache
def _fernet() -> Fernet:
    key = settings.ENCRYPTION_KEY.strip()
    if not key:
        # Development fallback only: production must set ENCRYPTION_KEY (see /platform/environment).
        key = base64.urlsafe_b64encode(hashlib.sha256(f"equitify:{settings.JWT_SECRET}".encode()).digest()).decode()
    return Fernet(key.encode())


def encrypt_json(data: dict) -> str:
    return _fernet().encrypt(json.dumps(data, separators=(",", ":")).encode()).decode()


def decrypt_json(token: str | None) -> dict:
    if not token:
        return {}
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except (InvalidToken, ValueError):
        return {}


def encrypt_text(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_text(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return ""


def mask(value: str) -> str:
    value = str(value or "")
    return "••••••••" if len(value) <= 8 else f"••••••••{value[-4:]}"


# --- Integrations --------------------------------------------------------------------------------


def integration_out(row: IntegrationProvider) -> IntegrationOut:
    out = IntegrationOut.model_validate(row)
    creds = decrypt_json(row.credentials_encrypted)
    out.credentials = {k: mask(v) for k, v in creds.items()}
    return out


def _options(category: str) -> list[ProviderOption]:
    return [ProviderOption(name=s.name, label=s.label, description=s.description,
                           required_config=s.required_config, required_credentials=s.required_credentials)
            for s in providers.available(category)]


async def ensure_catalog(db: AsyncSession) -> None:
    """Lazily seed one built-in provider per spec category the first time the catalog is opened."""
    if await db.scalar(select(func.count()).select_from(IntegrationProvider)):
        return
    defaults = {"storage": ("local", "active"), "spreadsheets": ("csv", "active"),
                "ai": ("anthropic", "active" if settings.ANTHROPIC_API_KEY else "not_configured")}
    for category in INTEGRATION_CATEGORIES:
        name, state = defaults.get(category, ("manual", "manual"))
        spec = providers.get(category, name)
        db.add(IntegrationProvider(category=category, provider=name, label=spec.label if spec else name,
                                   status=state, is_primary=True, config={}))
    await audit.record(db, actor=None, action="integration.catalog_seeded", entity_type="integration",
                       summary=f"{len(INTEGRATION_CATEGORIES)} categories")
    await db.commit()


async def list_catalog(db: AsyncSession) -> list[CategoryOut]:
    await ensure_catalog(db)
    rows = list(await db.scalars(select(IntegrationProvider).where(IntegrationProvider.deleted_at.is_(None))
                                 .order_by(IntegrationProvider.is_primary.desc(), IntegrationProvider.provider)))
    by_cat: dict[str, list[IntegrationProvider]] = {}
    for r in rows:
        by_cat.setdefault(r.category, []).append(r)
    return [CategoryOut(key=k, label=label, providers=[integration_out(r) for r in by_cat.get(k, [])],
                        options=_options(k)) for k, label in INTEGRATION_CATEGORIES.items()]


async def get_integration(db: AsyncSession, integration_id: uuid.UUID) -> IntegrationProvider:
    row = await db.get(IntegrationProvider, integration_id)
    if not row or row.deleted_at:
        raise _not_found("Integration")
    return row


async def _set_primary(db: AsyncSession, row: IntegrationProvider) -> None:
    others = await db.scalars(select(IntegrationProvider).where(
        IntegrationProvider.category == row.category, IntegrationProvider.id != row.id,
        IntegrationProvider.is_primary.is_(True)))
    for o in others:
        o.is_primary = False


async def create_integration(db: AsyncSession, data: IntegrationCreate, actor: CurrentUser) -> IntegrationProvider:
    if data.category not in INTEGRATION_CATEGORIES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown integration category {data.category}")
    exists = await db.scalar(select(IntegrationProvider).where(
        IntegrationProvider.category == data.category, IntegrationProvider.provider == data.provider))
    if exists and not exists.deleted_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "This provider is already configured for the category")
    spec = providers.get(data.category, data.provider)
    row = exists or IntegrationProvider(category=data.category, provider=data.provider, created_by_id=actor.id)
    row.deleted_at = None
    row.label = data.label or (spec.label if spec else data.provider)
    row.config = data.config
    row.usage_restrictions = data.usage_restrictions
    row.status = "not_configured"
    row.is_primary = data.is_primary
    row.updated_by_id = actor.id
    creds = {k.strip(): v for k, v in data.credentials.items() if k.strip() and v}
    if creds:
        row.credentials_encrypted = encrypt_json(creds)
        row.credential_keys = sorted(creds)
        row.credentials_version = (row.credentials_version or 0) + 1
        row.credentials_rotated_at = utcnow()
    if not exists:
        db.add(row)
    await db.flush()
    if row.is_primary:
        await _set_primary(db, row)
    await audit.record(db, actor=actor, action="integration.created", entity_type="integration", entity_id=row.id,
                       summary=f"{data.category}/{data.provider}",
                       changes={"config_keys": sorted(data.config), "credential_keys": sorted(creds)},
                       ip_address=actor.ip_address)
    await db.commit()
    return row


async def update_integration(db: AsyncSession, row: IntegrationProvider, data: IntegrationUpdate,
                             actor: CurrentUser) -> IntegrationProvider:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(row, values)
    if not changes:
        return row
    for k, v in values.items():
        setattr(row, k, v)
    row.updated_by_id = actor.id
    if values.get("is_primary"):
        await _set_primary(db, row)
    await audit.record(db, actor=actor, action="integration.updated", entity_type="integration", entity_id=row.id,
                       summary=f"{row.category}/{row.provider}", changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return row


async def rotate_credentials(db: AsyncSession, row: IntegrationProvider, data: CredentialsIn,
                             actor: CurrentUser) -> IntegrationProvider:
    previous_keys = list(row.credential_keys or [])
    supplied = {k.strip(): v for k, v in data.credentials.items() if k.strip() and v}
    if not supplied and not data.remove_keys:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Enter at least one credential value to rotate")
    merged = {k: v for k, v in decrypt_json(row.credentials_encrypted).items() if k not in data.remove_keys}
    merged.update(supplied)
    row.credentials_encrypted = encrypt_json(merged) if merged else None
    row.credential_keys = sorted(merged)
    row.credentials_version = (row.credentials_version or 0) + 1
    row.credentials_rotated_at = utcnow()
    row.updated_by_id = actor.id
    # Values are never written to the audit trail — only which keys changed and the new version.
    await audit.record(db, actor=actor, action="integration.credentials_rotated", entity_type="integration",
                       entity_id=row.id, summary=data.reason or f"{row.category}/{row.provider}",
                       changes={"keys": {"from": previous_keys, "to": row.credential_keys},
                                "version": row.credentials_version}, ip_address=actor.ip_address)
    await db.commit()
    return row


async def archive_integration(db: AsyncSession, row: IntegrationProvider, actor: CurrentUser) -> None:
    row.deleted_at, row.status, row.is_primary, row.updated_by_id = utcnow(), "disabled", False, actor.id
    await audit.record(db, actor=actor, action="integration.archived", entity_type="integration", entity_id=row.id,
                       summary=f"{row.category}/{row.provider}", ip_address=actor.ip_address)
    await db.commit()


async def test_integration(db: AsyncSession, row: IntegrationProvider, actor: CurrentUser) -> tuple[bool, str, list[str]]:
    """Validate configuration and run the adapter's own (side-effect free) check; record the result."""
    missing = providers.validate(row.category, row.provider, row.config or {}, row.credential_keys or [])
    if missing:
        ok, message = False, "Missing required settings: " + ", ".join(missing)
    else:
        try:
            adapter = providers.build(row, decrypt_json(row.credentials_encrypted))
            check = getattr(adapter, "test", None)
            ok, message = (await check()) if check else (True, "Configuration is valid.")
        except LookupError as exc:
            ok, message = False, f"{exc}. Install the vendor adapter before activating this provider."
        except Exception as exc:  # noqa: BLE001 — adapter failures are reported, never raised to the user path
            ok, message = False, f"{type(exc).__name__}: {exc}"[:1000]
    now = utcnow()
    row.last_tested_at = now
    if ok:
        row.last_success_at, row.last_error, row.last_error_at = now, None, None
        if row.status in ("not_configured", "error"):
            row.status = "manual" if row.provider in ("manual", "csv") else "active"
    else:
        row.last_error, row.last_error_at = message, now
        if row.status != "disabled":
            row.status = "error"
    await audit.record(db, actor=actor, action="integration.tested", entity_type="integration", entity_id=row.id,
                       summary=f"{'ok' if ok else 'failed'}: {message}"[:500], ip_address=actor.ip_address)
    await db.commit()
    return ok, message, missing


async def get_credentials(db: AsyncSession, category: str, provider: str | None = None) -> dict:
    """Decrypted credentials of the primary (or named) provider for adapter use only. Never return to clients."""
    stmt = select(IntegrationProvider).where(IntegrationProvider.category == category,
                                             IntegrationProvider.deleted_at.is_(None))
    stmt = stmt.where(IntegrationProvider.provider == provider) if provider else stmt.where(
        IntegrationProvider.is_primary.is_(True))
    row = await db.scalar(stmt.limit(1))
    return decrypt_json(row.credentials_encrypted) if row else {}


async def record_provider_result(db: AsyncSession, category: str, provider: str, *, ok: bool,
                                 error: str | None = None) -> None:
    """Adapters call this after real traffic so the catalog shows last success / last error. Does not commit."""
    row = await db.scalar(select(IntegrationProvider).where(IntegrationProvider.category == category,
                                                            IntegrationProvider.provider == provider))
    if not row:
        return
    now = utcnow()
    if ok:
        row.last_success_at = now
    else:
        row.last_error, row.last_error_at = (error or "error")[:2000], now


# --- Feature flags -------------------------------------------------------------------------------


async def list_flags(db: AsyncSession) -> list[FeatureFlag]:
    return list(await db.scalars(select(FeatureFlag).where(FeatureFlag.deleted_at.is_(None)).order_by(FeatureFlag.key)))


async def get_flag(db: AsyncSession, flag_id: uuid.UUID) -> FeatureFlag:
    f = await db.get(FeatureFlag, flag_id)
    if not f or f.deleted_at:
        raise _not_found("Feature flag")
    return f


async def create_flag(db: AsyncSession, data: FlagCreate, actor: CurrentUser) -> FeatureFlag:
    if await db.scalar(select(FeatureFlag.id).where(FeatureFlag.key == data.key)):
        raise HTTPException(status.HTTP_409_CONFLICT, "A flag with this key already exists")
    f = FeatureFlag(**data.model_dump(exclude={"rollout_user_ids"}),
                    rollout_user_ids=[str(u) for u in data.rollout_user_ids],
                    created_by_id=actor.id, updated_by_id=actor.id)
    db.add(f)
    await db.flush()
    await audit.record(db, actor=actor, action="feature_flag.created", entity_type="feature_flag", entity_id=f.id,
                       summary=f.key, changes={"enabled": {"from": None, "to": f.enabled}},
                       ip_address=actor.ip_address)
    await db.commit()
    return f


async def update_flag(db: AsyncSession, f: FeatureFlag, data: FlagUpdate, actor: CurrentUser) -> FeatureFlag:
    values = data.model_dump(exclude_unset=True, exclude={"reason"})
    if "rollout_user_ids" in values and values["rollout_user_ids"] is not None:
        values["rollout_user_ids"] = [str(u) for u in values["rollout_user_ids"]]
    changes = audit.diff(f, values)
    if not changes:
        return f
    if (f.is_sensitive or values.get("is_sensitive") or "is_sensitive" in changes) and not (data.reason or "").strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "Changing a money/date/permission-sensitive flag requires a reason")
    for k, v in values.items():
        setattr(f, k, v)
    f.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="feature_flag.updated", entity_type="feature_flag", entity_id=f.id,
                       summary=f"{f.key}{' — ' + data.reason if data.reason else ''}"[:500], changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return f


async def flag_enabled(db: AsyncSession, key: str, user: Any = None) -> bool:
    """True when the flag exists, is enabled and the user is inside its rollout (empty rollout = everyone)."""
    f = await db.scalar(select(FeatureFlag).where(FeatureFlag.key == key, FeatureFlag.deleted_at.is_(None)))
    if not f or not f.enabled:
        return False
    if not f.rollout_roles and not f.rollout_user_ids:
        return True
    if user is None:
        return False
    u = getattr(user, "user", user)
    role = getattr(getattr(u, "role", None), "key", None)
    return (role in (f.rollout_roles or [])) or (str(getattr(u, "id", "")) in (f.rollout_user_ids or []))


# --- Webhooks ------------------------------------------------------------------------------------


def _validate_events(events: list[str]) -> list[str]:
    allowed = set(WEBHOOK_EVENTS) | {"*"}
    bad = [e for e in events if e not in allowed]
    if bad:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown events: {', '.join(bad)}")
    return sorted(set(events))


def subscription_out(s: WebhookSubscription, secret: str | None = None) -> SubscriptionOut:
    out = SubscriptionOut.model_validate(s)
    out.secret = secret
    return out


async def list_subscriptions(db: AsyncSession) -> list[WebhookSubscription]:
    return list(await db.scalars(select(WebhookSubscription).where(WebhookSubscription.deleted_at.is_(None))
                                 .order_by(WebhookSubscription.created_at.desc())))


async def get_subscription(db: AsyncSession, sub_id: uuid.UUID) -> WebhookSubscription:
    s = await db.get(WebhookSubscription, sub_id)
    if not s or s.deleted_at:
        raise _not_found("Webhook subscription")
    return s


async def create_subscription(db: AsyncSession, data: SubscriptionCreate, actor: CurrentUser) -> SubscriptionOut:
    secret = f"whsec_{secrets.token_urlsafe(32)}"
    s = WebhookSubscription(name=data.name, url=data.url, events=_validate_events(data.events), active=data.active,
                            secret_encrypted=encrypt_text(secret), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(s)
    await db.flush()
    await audit.record(db, actor=actor, action="webhook.created", entity_type="webhook_subscription", entity_id=s.id,
                       summary=f"{s.name} → {s.url}", changes={"events": {"from": None, "to": s.events}},
                       ip_address=actor.ip_address)
    await db.commit()
    return subscription_out(s, secret)


async def update_subscription(db: AsyncSession, s: WebhookSubscription, data: SubscriptionUpdate,
                              actor: CurrentUser) -> WebhookSubscription:
    values = data.model_dump(exclude_unset=True)
    if values.get("events") is not None:
        values["events"] = _validate_events(values["events"])
    changes = audit.diff(s, values)
    if changes:
        for k, v in values.items():
            setattr(s, k, v)
        if values.get("active"):
            s.consecutive_failures = 0
        s.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="webhook.updated", entity_type="webhook_subscription",
                           entity_id=s.id, summary=s.name, changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return s


async def rotate_secret(db: AsyncSession, s: WebhookSubscription, actor: CurrentUser) -> SubscriptionOut:
    secret = f"whsec_{secrets.token_urlsafe(32)}"
    s.secret_encrypted, s.updated_by_id = encrypt_text(secret), actor.id
    await audit.record(db, actor=actor, action="webhook.secret_rotated", entity_type="webhook_subscription",
                       entity_id=s.id, summary=s.name, ip_address=actor.ip_address)
    await db.commit()
    return subscription_out(s, secret)


async def archive_subscription(db: AsyncSession, s: WebhookSubscription, actor: CurrentUser) -> None:
    s.deleted_at, s.active, s.updated_by_id = utcnow(), False, actor.id
    await audit.record(db, actor=actor, action="webhook.archived", entity_type="webhook_subscription",
                       entity_id=s.id, summary=s.name, ip_address=actor.ip_address)
    await db.commit()


def event_payload(payload: dict) -> dict:
    """JSON-safe copy of a domain-event payload; the in-process actor object becomes `actor_id`."""
    out: dict[str, Any] = {}
    for k, v in payload.items():
        if k == "actor":
            out["actor_id"] = str(v.id) if getattr(v, "id", None) else None
        elif isinstance(v, (set, frozenset)):
            out[k] = sorted(str(x) for x in v)
        elif hasattr(v, "__table__"):
            out[f"{k}_id"] = str(getattr(v, "id", "")) or None
        else:
            out[k] = to_jsonable(v)
    try:
        json.dumps(out)
    except TypeError:
        out = {k: (v if isinstance(v, (str, int, float, bool, list, dict, type(None))) else str(v))
               for k, v in out.items()}
    return out


async def enqueue(db: AsyncSession, event: str, payload: dict, *, subscription_id: uuid.UUID | None = None) -> int:
    """Write outbox rows for matching active subscriptions. Runs inside the event transaction; no network I/O."""
    stmt = select(WebhookSubscription.id).where(WebhookSubscription.active.is_(True),
                                                WebhookSubscription.deleted_at.is_(None))
    stmt = stmt.where(WebhookSubscription.id == subscription_id) if subscription_id else stmt.where(
        WebhookSubscription.events.overlap([event, "*"]))
    ids = list(await db.scalars(stmt))
    data = event_payload(payload)
    for sid in ids:
        db.add(WebhookDelivery(subscription_id=sid, event=event, payload=data, status="pending",
                               next_attempt_at=utcnow()))
    return len(ids)


async def send_test(db: AsyncSession, s: WebhookSubscription, actor: CurrentUser) -> int:
    n = await enqueue(db, "ping", {"message": "Test delivery from EquitiFy", "subscription_id": str(s.id),
                                   "actor": actor}, subscription_id=s.id)
    await audit.record(db, actor=actor, action="webhook.test_queued", entity_type="webhook_subscription",
                       entity_id=s.id, summary=s.name, ip_address=actor.ip_address)
    await db.commit()
    return n


def _post(url: str, body: bytes, headers: dict[str, str], timeout: int) -> tuple[int | None, str | None]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — scheme restricted to http(s)
            return int(resp.status), None
    except urllib.error.HTTPError as exc:
        return int(exc.code), f"HTTP {exc.code} {exc.reason}"[:500]
    except Exception as exc:  # noqa: BLE001 — network errors become retryable delivery failures
        return None, f"{type(exc).__name__}: {exc}"[:500]


def sign(secret: str, timestamp: str, body: str) -> str:
    return hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()


def _backoff(attempts: int) -> timedelta:
    return timedelta(minutes=min(2 ** max(attempts - 1, 0), 360))


async def deliver_pending(db: AsyncSession, actor: CurrentUser | None = None, limit: int = 50) -> DeliverResult:
    result = DeliverResult(attempted=0, delivered=0, failed=0, dead=0)
    async with track_job(db, "webhooks.deliver", actor_id=getattr(actor, "id", None)) as job:
        now = utcnow()
        due = or_(
            (WebhookDelivery.status.in_(["pending", "failed"])) & (WebhookDelivery.next_attempt_at <= now),
            (WebhookDelivery.status == "sending") & (WebhookDelivery.last_attempt_at < now - STALE_SENDING),
        )
        rows = list(await db.scalars(select(WebhookDelivery).where(due).order_by(WebhookDelivery.next_attempt_at)
                                     .limit(limit).with_for_update(skip_locked=True)))
        subs = {s.id: s for s in await db.scalars(select(WebhookSubscription).where(
            WebhookSubscription.id.in_(list({r.subscription_id for r in rows}))))} if rows else {}
        for r in rows:  # claim, then end the transaction (and its locks) before any network I/O
            r.status, r.last_attempt_at = "sending", now
        await db.commit()
        for r in rows:
            result.attempted += 1
            sub = subs.get(r.subscription_id)
            if not sub or not sub.active or sub.deleted_at:
                r.status, r.last_error = "dead", "Subscription is inactive or archived"
                result.dead += 1
                await db.commit()
                continue
            body = json.dumps({"id": str(r.id), "event": r.event, "created_at": r.created_at.isoformat(),
                               "data": r.payload}, separators=(",", ":"), default=str)
            ts = str(int(time.time()))
            headers = {
                "Content-Type": "application/json",
                "User-Agent": f"{settings.APP_NAME}-Webhooks/1",
                "X-EquitiFy-Event": r.event,
                "X-EquitiFy-Delivery": str(r.id),
                "X-EquitiFy-Timestamp": ts,
                "X-EquitiFy-Signature": f"t={ts},v1={sign(decrypt_text(sub.secret_encrypted), ts, body)}",
            }
            code, error = await asyncio.to_thread(_post, sub.url, body.encode(), headers, DELIVERY_TIMEOUT_SECONDS)
            r.attempts += 1
            r.last_status_code, r.last_attempt_at = code, utcnow()
            sub.last_delivery_at = r.last_attempt_at
            if code is not None and 200 <= code < 300:
                r.status, r.delivered_at, r.last_error = "delivered", r.last_attempt_at, None
                sub.consecutive_failures = 0
                result.delivered += 1
            else:
                r.last_error = error or f"HTTP {code}"
                sub.consecutive_failures = (sub.consecutive_failures or 0) + 1
                if r.attempts >= MAX_ATTEMPTS:
                    r.status = "dead"
                    result.dead += 1
                else:
                    r.status, r.next_attempt_at = "failed", r.last_attempt_at + _backoff(r.attempts)
                    result.failed += 1
            await db.commit()
        job.counts.update(result.model_dump())
    return result


async def retry_delivery(db: AsyncSession, delivery_id: uuid.UUID, actor: CurrentUser) -> WebhookDelivery:
    r = await db.get(WebhookDelivery, delivery_id)
    if not r:
        raise _not_found("Delivery")
    if r.status == "delivered":
        raise HTTPException(status.HTTP_409_CONFLICT, "Delivery already succeeded")
    if r.status == "dead":
        r.attempts = 0
    r.status, r.next_attempt_at = "pending", utcnow()
    await audit.record(db, actor=actor, action="webhook.delivery_retried", entity_type="webhook_delivery",
                       entity_id=r.id, summary=r.event, ip_address=actor.ip_address)
    await db.commit()
    return r


# --- Job monitoring ------------------------------------------------------------------------------


class JobHandle:
    def __init__(self, run_id: uuid.UUID | None):
        self.id = run_id
        self.counts: dict[str, Any] = {}


async def _finish_job(run_id: uuid.UUID | None, state: str, error: str | None, counts: dict, started: float) -> None:
    if run_id is None:
        return
    from app.core.database import SessionLocal

    try:
        async with SessionLocal() as s:
            run = await s.get(JobRun, run_id)
            if run:
                run.status, run.error, run.finished_at = state, error, utcnow()
                run.duration_ms = int((time.perf_counter() - started) * 1000)
                run.counts = to_jsonable(counts)
                await s.commit()
    except Exception:  # noqa: BLE001 — monitoring must never break the job itself
        pass


@asynccontextmanager
async def track_job(db: AsyncSession, key: str, *, actor_id: uuid.UUID | None = None):
    """Record a `job_runs` row around a background job.

        async with platform.service.track_job(db, "leases.notices") as job:
            ...; job.counts["created"] = n

    Bookkeeping uses its own session so a failed/rolled-back job is still recorded as failed.
    """
    from app.core.database import SessionLocal

    started = time.perf_counter()
    run_id: uuid.UUID | None = None
    try:
        async with SessionLocal() as s:
            run = JobRun(job_key=key[:80], status="running", triggered_by_id=actor_id)
            s.add(run)
            await s.commit()
            run_id = run.id
    except Exception:  # noqa: BLE001
        run_id = None
    handle = JobHandle(run_id)
    try:
        yield handle
    except BaseException as exc:
        await _finish_job(run_id, "failed", f"{type(exc).__name__}: {exc}"[:4000], handle.counts, started)
        raise
    await _finish_job(run_id, "succeeded", None, handle.counts, started)


async def job_summary(db: AsyncSession, days: int = 7) -> list[dict]:
    since = utcnow() - timedelta(days=days)
    rows = list(await db.scalars(select(JobRun).where(JobRun.started_at >= since).order_by(JobRun.started_at.desc())))
    out: dict[str, dict] = {}
    for r in rows:
        s = out.setdefault(r.job_key, {"job_key": r.job_key, "runs": 0, "failures": 0, "last_status": r.status,
                                       "last_started_at": r.started_at, "last_error": r.error})
        s["runs"] += 1
        s["failures"] += 1 if r.status == "failed" else 0
    return sorted(out.values(), key=lambda s: (-s["failures"], s["job_key"]))


# --- Bulk-export monitor -------------------------------------------------------------------------

_ROWS = re.compile(r"(\d[\d,]*)\s+(?:rows?|records?|items?)", re.I)


def export_rows(e: AuditEvent) -> int | None:
    changes = e.changes or {}
    for key in ("rows", "row_count", "count"):
        v = changes.get(key)
        if isinstance(v, (int, float)):
            return int(v)
    m = _ROWS.search(e.summary or "")
    return int(m.group(1).replace(",", "")) if m else None


def export_query(days: int, actor_id: uuid.UUID | None, q: str | None):
    stmt = select(AuditEvent).where(or_(AuditEvent.action.like("%exported"), AuditEvent.action.like("%export")),
                                    AuditEvent.occurred_at >= utcnow() - timedelta(days=days))
    if actor_id:
        stmt = stmt.where(AuditEvent.actor_id == actor_id)
    return apply_search(stmt, q, [AuditEvent.action, AuditEvent.actor_name, AuditEvent.summary, AuditEvent.entity_type])


async def list_exports(db: AsyncSession, params: ListParams, days: int, actor_id: uuid.UUID | None) -> tuple[list, int]:
    stmt = export_query(days, actor_id, params.q).order_by(AuditEvent.occurred_at.desc())
    return await paginate(db, stmt, params)


async def exports_by_user(db: AsyncSession, days: int) -> list[dict]:
    rows = list(await db.scalars(export_query(days, None, None).order_by(AuditEvent.occurred_at.desc()).limit(10_000)))
    out: dict[str, dict] = {}
    for e in rows:
        s = out.setdefault(str(e.actor_id), {"actor_id": e.actor_id, "actor_name": e.actor_name, "exports": 0,
                                             "rows": 0, "last_at": e.occurred_at})
        s["exports"] += 1
        s["rows"] += export_rows(e) or 0
    return sorted(out.values(), key=lambda s: -s["rows"])


# --- Retention & legal hold ----------------------------------------------------------------------


async def list_retention(db: AsyncSession) -> list[RetentionPolicy]:
    return list(await db.scalars(select(RetentionPolicy).where(RetentionPolicy.deleted_at.is_(None))
                                 .order_by(RetentionPolicy.entity_type)))


async def upsert_retention(db: AsyncSession, data: RetentionIn, actor: CurrentUser) -> RetentionPolicy:
    row = await db.scalar(select(RetentionPolicy).where(RetentionPolicy.entity_type == data.entity_type))
    values = data.model_dump()
    if row:
        changes = audit.diff(row, values)
        if row.deleted_at:
            row.deleted_at = None
            changes["restored"] = {"from": False, "to": True}
        for k, v in values.items():
            setattr(row, k, v)
        row.updated_by_id = actor.id
        action = "retention_policy.updated"
    else:
        row = RetentionPolicy(**values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(row)
        await db.flush()
        changes = {"retain_days": {"from": None, "to": row.retain_days}}
        action = "retention_policy.created"
    await audit.record(db, actor=actor, action=action, entity_type="retention_policy", entity_id=row.id,
                       summary=row.entity_type, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return row


async def list_holds(db: AsyncSession, active_only: bool = True) -> list[LegalHold]:
    stmt = select(LegalHold).where(LegalHold.deleted_at.is_(None))
    if active_only:
        stmt = stmt.where(LegalHold.released_at.is_(None))
    return list(await db.scalars(stmt.order_by(LegalHold.placed_at.desc()).limit(500)))


async def place_hold(db: AsyncSession, data: HoldIn, actor: CurrentUser) -> LegalHold:
    h = LegalHold(**data.model_dump(), placed_by_id=actor.id, placed_at=utcnow(),
                  created_by_id=actor.id, updated_by_id=actor.id)
    db.add(h)
    await db.flush()
    await audit.record(db, actor=actor, action="legal_hold.placed", entity_type="legal_hold", entity_id=h.id,
                       summary=f"{h.entity_type}{'/' + str(h.entity_id) if h.entity_id else ' (all)'}: {h.reason}"[:500],
                       ip_address=actor.ip_address)
    await db.commit()
    return h


async def release_hold(db: AsyncSession, hold_id: uuid.UUID, reason: str, actor: CurrentUser) -> LegalHold:
    h = await db.get(LegalHold, hold_id)
    if not h or h.deleted_at:
        raise _not_found("Legal hold")
    if h.released_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Hold is already released")
    h.released_at, h.released_by_id, h.release_reason, h.updated_by_id = utcnow(), actor.id, reason, actor.id
    await audit.record(db, actor=actor, action="legal_hold.released", entity_type="legal_hold", entity_id=h.id,
                       summary=reason[:500], ip_address=actor.ip_address)
    await db.commit()
    return h


async def on_legal_hold(db: AsyncSession, entity_type: str, entity_id: uuid.UUID | None) -> bool:
    """True while an open hold covers this record (or its whole entity type). Callers must block purge/destroy."""
    cond = LegalHold.entity_id.is_(None)
    if entity_id is not None:
        cond = or_(cond, LegalHold.entity_id == entity_id)
    found = await db.scalar(select(LegalHold.id).where(
        LegalHold.entity_type == entity_type, LegalHold.released_at.is_(None), LegalHold.deleted_at.is_(None), cond,
    ).limit(1))
    return found is not None


# --- Backups -------------------------------------------------------------------------------------


def backup_out(b: BackupRecord) -> BackupOut:
    out = BackupOut.model_validate(b)
    checks = []
    if b.rpo_target_minutes is not None and b.achieved_rpo_minutes is not None:
        checks.append(b.achieved_rpo_minutes <= b.rpo_target_minutes)
    if b.rto_target_minutes is not None and b.achieved_rto_minutes is not None:
        checks.append(b.achieved_rto_minutes <= b.rto_target_minutes)
    out.meets_targets = (all(checks) and b.result == "success") if checks else None
    return out


async def list_backups(db: AsyncSession, kind: str | None = None) -> list[BackupRecord]:
    stmt = select(BackupRecord).where(BackupRecord.deleted_at.is_(None))
    if kind:
        stmt = stmt.where(BackupRecord.kind == kind)
    return list(await db.scalars(stmt.order_by(BackupRecord.performed_at.desc()).limit(200)))


async def record_backup(db: AsyncSession, data: BackupIn, actor: CurrentUser) -> BackupRecord:
    values = data.model_dump()
    values["performed_at"] = values["performed_at"] or utcnow()
    b = BackupRecord(**values, performed_by_id=actor.id, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(b)
    await db.flush()
    await audit.record(db, actor=actor, action=f"backup.{data.kind}_recorded", entity_type="backup_record",
                       entity_id=b.id, summary=f"{data.environment}: {data.result}", ip_address=actor.ip_address)
    await db.commit()
    return b


# --- Health --------------------------------------------------------------------------------------


async def db_latency_ms(db: AsyncSession) -> float | None:
    started = time.perf_counter()
    try:
        await db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        return None
    return round((time.perf_counter() - started) * 1000, 2)


async def health(db: AsyncSession) -> dict:
    from app.modules.documents import ai

    now = utcnow()
    latency = await db_latency_ms(db)
    job_failures = int(await db.scalar(select(func.count()).select_from(JobRun).where(
        JobRun.status == "failed", JobRun.started_at >= now - timedelta(hours=24))) or 0)
    dead = int(await db.scalar(select(func.count()).select_from(WebhookDelivery).where(
        WebhookDelivery.status == "dead")) or 0)
    pending = int(await db.scalar(select(func.count()).select_from(WebhookDelivery).where(
        WebhookDelivery.status.in_(["pending", "failed", "sending"]))) or 0)
    int_errors = int(await db.scalar(select(func.count()).select_from(IntegrationProvider).where(
        IntegrationProvider.status == "error", IntegrationProvider.deleted_at.is_(None))) or 0)
    last_backup = await db.scalar(select(func.max(BackupRecord.performed_at)).where(
        BackupRecord.kind == "backup", BackupRecord.result == "success", BackupRecord.deleted_at.is_(None)))
    last_restore = await db.scalar(select(func.max(BackupRecord.performed_at)).where(
        BackupRecord.kind == "restore_test", BackupRecord.deleted_at.is_(None)))
    ai_status = ai.provider_status()

    checks = [
        {"key": "database", "label": "Database",
         "status": "error" if latency is None else ("warning" if latency > 250 else "ok"),
         "detail": "Unreachable" if latency is None else f"{latency} ms round trip"},
        {"key": "jobs", "label": "Background jobs", "status": "warning" if job_failures else "ok",
         "detail": f"{job_failures} failed run(s) in the last 24 hours"},
        {"key": "webhooks", "label": "Webhooks", "status": "warning" if dead else "ok",
         "detail": f"{dead} dead-lettered, {pending} pending delivery"},
        {"key": "integrations", "label": "Integrations", "status": "warning" if int_errors else "ok",
         "detail": f"{int_errors} provider(s) reporting errors"},
        {"key": "ai", "label": "AI provider", "status": "ok",
         "detail": (f"{ai_status['name']} · {ai_status['model']}" if ai_status["available"]
                    else "Not configured — AI features run in manual mode")},
        {"key": "backup", "label": "Backups",
         "status": "ok" if last_backup and now - last_backup <= timedelta(days=2) else "warning",
         "detail": f"Last successful backup {last_backup:%Y-%m-%d %H:%M} UTC" if last_backup else "No backup recorded"},
        {"key": "restore", "label": "Restoration tests",
         "status": "ok" if last_restore and now - last_restore <= timedelta(days=90) else "warning",
         "detail": f"Last restore test {last_restore:%Y-%m-%d}" if last_restore else "No restoration test recorded"},
        {"key": "encryption", "label": "Credential encryption",
         "status": "ok" if settings.ENCRYPTION_KEY or settings.ENVIRONMENT != "production" else "error",
         "detail": "Dedicated ENCRYPTION_KEY configured" if settings.ENCRYPTION_KEY
         else "Using development key derived from JWT_SECRET"},
    ]
    worst = "error" if any(c["status"] == "error" for c in checks) else (
        "warning" if any(c["status"] == "warning" for c in checks) else "ok")
    return {
        "status": worst, "environment": settings.ENVIRONMENT, "checked_at": now, "db_latency_ms": latency,
        "job_failures_24h": job_failures, "webhook_dead_letters": dead, "webhook_pending": pending,
        "integrations_in_error": int_errors, "ai": ai_status, "last_backup_at": last_backup,
        "last_restore_test_at": last_restore, "checks": checks,
    }


def environment_info() -> dict:
    return {
        "environment": settings.ENVIRONMENT,
        "app_name": settings.APP_NAME,
        "api_prefix": settings.API_PREFIX,
        "api_version": "v1",
        "encryption_key_configured": bool(settings.ENCRYPTION_KEY),
        "ai_configured": bool(settings.ANTHROPIC_API_KEY),
        "mfa_enforced": settings.MFA_ENFORCED,
        "data_rules": [
            "Production, staging and development run as separate deployments with separate databases and keys.",
            "Production data is never copied to development or staging without anonymization.",
            "Integration credentials and webhook secrets are encrypted at rest and never returned in plaintext.",
            "Documents are served only through short-lived signed URLs.",
            "Audit events are immutable; exports and critical changes are always audited.",
            "Money, date and permission-sensitive changes ship behind feature flags with a recorded reason.",
        ],
    }


def api_catalog() -> dict:
    from app.modules.auth.permissions import ACTIONS, MODULES

    return {
        "version": "v1",
        "prefix": settings.API_PREFIX,
        "auth": ["Bearer access token (users)", "X-API-Key header (service credentials, scoped)"],
        "actions": ACTIONS,
        "modules": [{"module": m, "label": label, "scopes": [f"{m}:{a}" for a in ACTIONS]}
                    for m, label in MODULES.items()],
        "webhook_events": WEBHOOK_EVENTS,
    }


async def user_names(db: AsyncSession, ids: set) -> dict:
    from app.modules.auth.models import User

    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())
