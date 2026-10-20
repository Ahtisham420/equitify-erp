import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_search, paginate
from app.core.deps import DB, Authed, CurrentUser, require
from app.modules.documents import ai
from app.modules.platform import ai_features, service
from app.modules.platform.models import INTEGRATION_CATEGORIES, JobRun, WebhookDelivery, WebhookSubscription
from app.modules.platform.schemas import (
    AcceptIn,
    ApiOut,
    BackupIn,
    BackupOut,
    CategoryOut,
    CredentialsIn,
    DeliverResult,
    DeliveryOut,
    EnvironmentOut,
    ExportByUser,
    ExportEventOut,
    FlagCreate,
    FlagOut,
    FlagUpdate,
    HealthOut,
    HoldIn,
    HoldOut,
    IntegrationCreate,
    IntegrationOut,
    IntegrationUpdate,
    JobRunOut,
    JobSummary,
    NLQueryIn,
    NLQueryOut,
    ReleaseIn,
    RetentionIn,
    RetentionOut,
    SubscriptionCreate,
    SubscriptionOut,
    SubscriptionUpdate,
    SuggestionOut,
    SummarizeOut,
    TalkingPointsOut,
    TestResult,
)

router = APIRouter(prefix="/platform", tags=["platform"])

VIEW = require("platform", "view")
ADMIN = require("platform", "approve")  # admin-only writes (admins hold every permission)


# --- Overview -------------------------------------------------------------------------------------


@router.get("/health", response_model=HealthOut)
async def health(db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.health(db)


@router.get("/environment", response_model=EnvironmentOut)
async def environment(_: CurrentUser = Depends(VIEW)):
    return service.environment_info()


@router.get("/api", response_model=ApiOut)
async def api_catalog(_: CurrentUser = Depends(VIEW)):
    """Versioned API (/api/v1) and the scopes available to service credentials (MODULES × ACTIONS)."""
    return service.api_catalog()


# --- Integrations ---------------------------------------------------------------------------------


@router.get("/integrations", response_model=list[CategoryOut])
async def integrations(db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.list_catalog(db)


@router.get("/integrations/categories")
async def integration_categories(_: CurrentUser = Depends(VIEW)):
    return [{"key": k, "label": v} for k, v in INTEGRATION_CATEGORIES.items()]


@router.post("/integrations", response_model=IntegrationOut, status_code=201)
async def create_integration(body: IntegrationCreate, db: DB, user: CurrentUser = Depends(ADMIN)):
    return service.integration_out(await service.create_integration(db, body, user))


@router.patch("/integrations/{integration_id}", response_model=IntegrationOut)
async def update_integration(integration_id: uuid.UUID, body: IntegrationUpdate, db: DB,
                             user: CurrentUser = Depends(ADMIN)):
    row = await service.get_integration(db, integration_id)
    return service.integration_out(await service.update_integration(db, row, body, user))


@router.put("/integrations/{integration_id}/credentials", response_model=IntegrationOut)
async def rotate_credentials(integration_id: uuid.UUID, body: CredentialsIn, db: DB,
                             user: CurrentUser = Depends(ADMIN)):
    row = await service.get_integration(db, integration_id)
    return service.integration_out(await service.rotate_credentials(db, row, body, user))


@router.post("/integrations/{integration_id}/test", response_model=TestResult)
async def test_integration(integration_id: uuid.UUID, db: DB, user: CurrentUser = Depends(ADMIN)):
    row = await service.get_integration(db, integration_id)
    ok, message, missing = await service.test_integration(db, row, user)
    return TestResult(ok=ok, message=message, missing=missing, integration=service.integration_out(row))


@router.delete("/integrations/{integration_id}", status_code=204)
async def archive_integration(integration_id: uuid.UUID, db: DB, user: CurrentUser = Depends(ADMIN)):
    await service.archive_integration(db, await service.get_integration(db, integration_id), user)


# --- Feature flags --------------------------------------------------------------------------------


@router.get("/flags", response_model=list[FlagOut])
async def flags(db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.list_flags(db)


@router.get("/flags/check/{key}")
async def check_flag(key: str, db: DB, user: Authed):
    """Any signed-in user may ask whether a flag is on for them."""
    return {"key": key, "enabled": await service.flag_enabled(db, key, user)}


@router.post("/flags", response_model=FlagOut, status_code=201)
async def create_flag(body: FlagCreate, db: DB, user: CurrentUser = Depends(ADMIN)):
    return await service.create_flag(db, body, user)


@router.patch("/flags/{flag_id}", response_model=FlagOut)
async def update_flag(flag_id: uuid.UUID, body: FlagUpdate, db: DB, user: CurrentUser = Depends(ADMIN)):
    return await service.update_flag(db, await service.get_flag(db, flag_id), body, user)


# --- Webhooks -------------------------------------------------------------------------------------


@router.get("/webhooks/events")
async def webhook_events(_: CurrentUser = Depends(VIEW)):
    return service.WEBHOOK_EVENTS


@router.get("/webhooks/subscriptions", response_model=list[SubscriptionOut])
async def subscriptions(db: DB, _: CurrentUser = Depends(VIEW)):
    return [service.subscription_out(s) for s in await service.list_subscriptions(db)]


@router.post("/webhooks/subscriptions", response_model=SubscriptionOut, status_code=201)
async def create_subscription(body: SubscriptionCreate, db: DB, user: CurrentUser = Depends(ADMIN)):
    return await service.create_subscription(db, body, user)


@router.patch("/webhooks/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def update_subscription(sub_id: uuid.UUID, body: SubscriptionUpdate, db: DB,
                              user: CurrentUser = Depends(ADMIN)):
    s = await service.update_subscription(db, await service.get_subscription(db, sub_id), body, user)
    return service.subscription_out(s)


@router.post("/webhooks/subscriptions/{sub_id}/rotate-secret", response_model=SubscriptionOut)
async def rotate_secret(sub_id: uuid.UUID, db: DB, user: CurrentUser = Depends(ADMIN)):
    return await service.rotate_secret(db, await service.get_subscription(db, sub_id), user)


@router.post("/webhooks/subscriptions/{sub_id}/test")
async def test_subscription(sub_id: uuid.UUID, db: DB, user: CurrentUser = Depends(ADMIN)):
    return {"queued": await service.send_test(db, await service.get_subscription(db, sub_id), user)}


@router.delete("/webhooks/subscriptions/{sub_id}", status_code=204)
async def archive_subscription(sub_id: uuid.UUID, db: DB, user: CurrentUser = Depends(ADMIN)):
    await service.archive_subscription(db, await service.get_subscription(db, sub_id), user)


@router.get("/webhooks/deliveries", response_model=Page[DeliveryOut])
async def deliveries(
    db: DB,
    params: ListParams = Depends(),
    status: list[str] | None = Query(None),
    event: list[str] | None = Query(None),
    subscription_id: uuid.UUID | None = None,
    _: CurrentUser = Depends(VIEW),
):
    stmt = select(WebhookDelivery)
    if status:
        stmt = stmt.where(WebhookDelivery.status.in_(status))
    if event:
        stmt = stmt.where(WebhookDelivery.event.in_(event))
    if subscription_id:
        stmt = stmt.where(WebhookDelivery.subscription_id == subscription_id)
    stmt = apply_search(stmt, params.q, [WebhookDelivery.event, WebhookDelivery.last_error])
    rows, total = await paginate(db, stmt.order_by(WebhookDelivery.created_at.desc()), params)
    names = dict((await db.execute(select(WebhookSubscription.id, WebhookSubscription.name).where(
        WebhookSubscription.id.in_(list({r.subscription_id for r in rows}))))).all()) if rows else {}
    items = []
    for r in rows:
        out = DeliveryOut.model_validate(r)
        out.subscription_name = names.get(r.subscription_id)
        items.append(out)
    return Page[DeliveryOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("/webhooks/deliveries/{delivery_id}/retry", response_model=DeliveryOut)
async def retry_delivery(delivery_id: uuid.UUID, db: DB, user: CurrentUser = Depends(ADMIN)):
    return await service.retry_delivery(db, delivery_id, user)


@router.post("/webhooks/deliver-pending", response_model=DeliverResult)
async def deliver_pending(db: DB, limit: int = Query(50, ge=1, le=500), user: CurrentUser = Depends(ADMIN)):
    """Delivery worker: call from a scheduler (service credential with platform:approve) or manually."""
    return await service.deliver_pending(db, user, limit)


# --- Jobs -----------------------------------------------------------------------------------------


@router.get("/jobs", response_model=Page[JobRunOut])
async def jobs(
    db: DB,
    params: ListParams = Depends(),
    status: list[str] | None = Query(None),
    job_key: list[str] | None = Query(None),
    _: CurrentUser = Depends(VIEW),
):
    stmt = select(JobRun)
    if status:
        stmt = stmt.where(JobRun.status.in_(status))
    if job_key:
        stmt = stmt.where(JobRun.job_key.in_(job_key))
    stmt = apply_search(stmt, params.q, [JobRun.job_key, JobRun.error])
    rows, total = await paginate(db, stmt.order_by(JobRun.started_at.desc()), params)
    return Page[JobRunOut](items=rows, total=total, page=params.page, page_size=params.page_size)


@router.get("/jobs/summary", response_model=list[JobSummary])
async def jobs_summary(db: DB, days: int = Query(7, ge=1, le=90), _: CurrentUser = Depends(VIEW)):
    return await service.job_summary(db, days)


# --- Bulk-export monitor --------------------------------------------------------------------------


@router.get("/exports", response_model=Page[ExportEventOut])
async def exports(
    db: DB,
    params: ListParams = Depends(),
    days: int = Query(30, ge=1, le=3650),
    actor_id: uuid.UUID | None = None,
    _: CurrentUser = Depends(VIEW),
):
    rows, total = await service.list_exports(db, params, days, actor_id)
    items = [ExportEventOut(id=e.id, occurred_at=e.occurred_at, actor_id=e.actor_id, actor_name=e.actor_name,
                            action=e.action, entity_type=e.entity_type, summary=e.summary,
                            rows=service.export_rows(e), ip_address=e.ip_address) for e in rows]
    return Page[ExportEventOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/exports/by-user", response_model=list[ExportByUser])
async def exports_by_user(db: DB, days: int = Query(30, ge=1, le=3650), _: CurrentUser = Depends(VIEW)):
    return await service.exports_by_user(db, days)


# --- Retention & legal holds ----------------------------------------------------------------------


@router.get("/retention", response_model=list[RetentionOut])
async def retention(db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.list_retention(db)


@router.post("/retention", response_model=RetentionOut)
async def upsert_retention(body: RetentionIn, db: DB, user: CurrentUser = Depends(ADMIN)):
    return await service.upsert_retention(db, body, user)


@router.get("/legal-holds", response_model=list[HoldOut])
async def legal_holds(db: DB, active: bool = True, _: CurrentUser = Depends(VIEW)):
    rows = await service.list_holds(db, active)
    names = await service.user_names(db, {h.placed_by_id for h in rows})
    out = []
    for h in rows:
        o = HoldOut.model_validate(h)
        o.placed_by_name = names.get(h.placed_by_id)
        out.append(o)
    return out


@router.get("/legal-holds/check")
async def check_hold(entity_type: str, db: DB, user: Authed, entity_id: uuid.UUID | None = None):
    return {"entity_type": entity_type, "entity_id": entity_id,
            "on_hold": await service.on_legal_hold(db, entity_type, entity_id)}


@router.post("/legal-holds", response_model=HoldOut, status_code=201)
async def place_hold(body: HoldIn, db: DB, user: CurrentUser = Depends(ADMIN)):
    h = await service.place_hold(db, body, user)
    out = HoldOut.model_validate(h)
    out.placed_by_name = user.full_name
    return out


@router.post("/legal-holds/{hold_id}/release", response_model=HoldOut)
async def release_hold(hold_id: uuid.UUID, body: ReleaseIn, db: DB, user: CurrentUser = Depends(ADMIN)):
    return await service.release_hold(db, hold_id, body.reason, user)


# --- Backups --------------------------------------------------------------------------------------


@router.get("/backups", response_model=list[BackupOut])
async def backups(db: DB, kind: str | None = None, _: CurrentUser = Depends(VIEW)):
    return [service.backup_out(b) for b in await service.list_backups(db, kind)]


@router.post("/backups", response_model=BackupOut, status_code=201)
async def record_backup(body: BackupIn, db: DB, user: CurrentUser = Depends(ADMIN)):
    return service.backup_out(await service.record_backup(db, body, user))


# --- AI (Release 6) -------------------------------------------------------------------------------


@router.get("/ai/status")
async def ai_status(_: Authed):
    return ai.provider_status()


@router.post("/ai/nl-query", response_model=NLQueryOut)
async def nl_query(body: NLQueryIn, db: DB, user: CurrentUser = Depends(require("properties", "view"))):
    return await ai_features.nl_query(db, body.question.strip(), body.page, body.page_size, user)


@router.get("/ai/interactions/{interaction_id}/suggestions", response_model=list[SuggestionOut])
async def interaction_suggestions(interaction_id: uuid.UUID, db: DB,
                                  _: CurrentUser = Depends(require("outreach", "view"))):
    return await ai_features.list_suggestions(db, "interaction", interaction_id)


@router.post("/ai/interactions/{interaction_id}/summarize", response_model=SummarizeOut)
async def summarize_interaction(interaction_id: uuid.UUID, db: DB,
                                user: CurrentUser = Depends(require("outreach", "edit"))):
    return await ai_features.summarize_interaction(db, interaction_id, user)


@router.post("/ai/suggestions/{suggestion_id}/accept", response_model=SuggestionOut)
async def accept_suggestion(suggestion_id: uuid.UUID, body: AcceptIn, db: DB,
                            user: CurrentUser = Depends(require("outreach", "edit"))):
    return await ai_features.accept_suggestion(db, suggestion_id, body, user)


@router.post("/ai/suggestions/{suggestion_id}/reject", response_model=SuggestionOut)
async def reject_suggestion(suggestion_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("outreach", "edit"))):
    return await ai_features.reject_suggestion(db, suggestion_id, user)


@router.get("/ai/talking-points/{person_id}", response_model=TalkingPointsOut)
async def talking_points(person_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "view"))):
    return await ai_features.talking_points(db, person_id, user)
