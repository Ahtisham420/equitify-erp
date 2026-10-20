import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.reactivation import service
from app.modules.reactivation.models import (
    ITEM_STATUSES,
    REVISIT_DAYS_BY_REASON,
    TRIGGER_STATUSES,
    ReactivationItem,
    ReactivationTrigger,
)
from app.modules.reactivation.schemas import (
    AnalyticsOut,
    ArmIn,
    CancelIn,
    DismissIn,
    ItemFacets,
    ItemOut,
    ReactivateIn,
    ScanOut,
    SnoozeIn,
    TriggerOut,
    TriggerUpdate,
)

router = APIRouter(prefix="/reactivation", tags=["reactivation"])

ITEM_SORTS = {"fired_at": ReactivationItem.fired_at, "trigger_type": ReactivationItem.trigger_type,
              "status": ReactivationItem.status, "score_after": ReactivationItem.score_after,
              "snoozed_until": ReactivationItem.snoozed_until}


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("reactivation", "view"))):
    from app.modules.pipeline.models import ACTIVE_STAGES, DEAD_REASONS
    from app.modules.pipeline.service import REACTIVATION_SPEC

    return {
        "trigger_types": [{"type": k, "label": v, **{kk: vv for kk, vv in REACTIVATION_SPEC.get(k, {}).items()
                                                      if kk != "label"}} for k, v in service.TYPE_LABELS.items()],
        "item_statuses": ITEM_STATUSES, "trigger_statuses": TRIGGER_STATUSES,
        "reactivate_stages": [*ACTIVE_STAGES, "nurture"], "dead_reasons": DEAD_REASONS,
        "revisit_days_by_reason": REVISIT_DAYS_BY_REASON,
        "property_fields": service.property_fields(), "field_operators": service.FIELD_OPERATORS,
    }


# ----------------------------------------------------------------------------- queue


def item_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    trigger_type: list[str] | None = Query(None),
    owner_id: list[str] | None = Query(None),
    opportunity_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
) -> dict:
    return {"q": q, "status_": status, "trigger_type": trigger_type, "owner_id": owner_id,
            "opportunity_id": opportunity_id, "property_id": property_id}


@router.get("/items", response_model=Page[ItemOut])
async def list_items(db: DB, params: ListParams = Depends(), f: dict = Depends(item_filters),
                     user: CurrentUser = Depends(require("reactivation", "view"))):
    stmt = apply_sort(service.item_query(**f, actor_id=user.id), params.sort, ITEM_SORTS,
                      ReactivationItem.fired_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[ItemOut](items=await service.item_outs(db, rows), total=total, page=params.page,
                         page_size=params.page_size)


@router.get("/items/facets", response_model=ItemFacets)
async def item_facets(db: DB, f: dict = Depends(item_filters), user: CurrentUser = Depends(require("reactivation", "view"))):
    q = service.item_query
    eff = service.effective_status_expr().label("effective_status")
    return ItemFacets(
        status=await facet_counts(db, q(**f, actor_id=user.id, skip={"status"}), eff),
        trigger_type=await facet_counts(db, q(**f, actor_id=user.id, skip={"trigger_type"}),
                                        ReactivationItem.trigger_type),
        owner_id=await facet_counts(db, q(**f, actor_id=user.id, skip={"owner_id"}), ReactivationItem.owner_id),
    )


@router.get("/items/{item_id}", response_model=ItemOut)
async def get_item(item_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("reactivation", "view"))):
    return (await service.item_outs(db, [await service.get_item(db, item_id)]))[0]


@router.post("/items/{item_id}/reactivate", response_model=ItemOut)
async def reactivate(item_id: uuid.UUID, body: ReactivateIn, db: DB,
                     user: CurrentUser = Depends(require("reactivation", "edit"))):
    item = await service.reactivate(db, await service.get_item(db, item_id), body.to_stage, body.override_reason,
                                    body.note, body.fields, user)
    item = await db.get(ReactivationItem, item.id, populate_existing=True)
    return (await service.item_outs(db, [item]))[0]


@router.post("/items/{item_id}/snooze", response_model=ItemOut)
async def snooze(item_id: uuid.UUID, body: SnoozeIn, db: DB, user: CurrentUser = Depends(require("reactivation", "edit"))):
    item = await service.snooze(db, await service.get_item(db, item_id), body.until, body.reason, user)
    return (await service.item_outs(db, [item]))[0]


@router.post("/items/{item_id}/dismiss", response_model=ItemOut)
async def dismiss(item_id: uuid.UUID, body: DismissIn, db: DB, user: CurrentUser = Depends(require("reactivation", "edit"))):
    item = await service.dismiss(db, await service.get_item(db, item_id), body.reason, body.rearm, user)
    return (await service.item_outs(db, [item]))[0]


# ----------------------------------------------------------------------------- triggers


@router.get("/triggers", response_model=Page[TriggerOut])
async def list_triggers(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
    trigger_type: list[str] | None = Query(None), opportunity_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None, _: CurrentUser = Depends(require("reactivation", "view")),
):
    stmt = select(ReactivationTrigger).where(ReactivationTrigger.deleted_at.is_(None))
    stmt = in_filter(stmt, ReactivationTrigger.status, status)
    stmt = in_filter(stmt, ReactivationTrigger.trigger_type, trigger_type)
    if opportunity_id:
        stmt = stmt.where(ReactivationTrigger.opportunity_id == opportunity_id)
    if property_id:
        stmt = stmt.where(ReactivationTrigger.property_id == property_id)
    stmt = apply_sort(stmt, params.sort, {"armed_at": ReactivationTrigger.armed_at, "fire_on": ReactivationTrigger.fire_on,
                                          "last_checked_at": ReactivationTrigger.last_checked_at,
                                          "trigger_type": ReactivationTrigger.trigger_type},
                      ReactivationTrigger.armed_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[TriggerOut](items=await service.trigger_outs(db, rows), total=total, page=params.page,
                            page_size=params.page_size)


@router.patch("/triggers/{trigger_id}", response_model=TriggerOut)
async def update_trigger(trigger_id: uuid.UUID, body: TriggerUpdate, db: DB,
                         user: CurrentUser = Depends(require("reactivation", "edit"))):
    t = await service.update_trigger(db, await service.get_trigger(db, trigger_id), body.params, user)
    return (await service.trigger_outs(db, [t]))[0]


@router.post("/triggers/{trigger_id}/cancel", response_model=TriggerOut)
async def cancel_trigger(trigger_id: uuid.UUID, body: CancelIn, db: DB,
                         user: CurrentUser = Depends(require("reactivation", "edit"))):
    t = await service.cancel_trigger(db, await service.get_trigger(db, trigger_id), body.reason, user)
    return (await service.trigger_outs(db, [t]))[0]


@router.post("/opportunities/{opportunity_id}/arm", response_model=list[TriggerOut])
async def arm(opportunity_id: uuid.UUID, body: ArmIn, db: DB, user: CurrentUser = Depends(require("reactivation", "edit"))):
    rows = await service.arm_manual(db, opportunity_id, body.trigger_type, body.params, user)
    return await service.trigger_outs(db, rows)


# ----------------------------------------------------------------------------- scan & analytics


@router.post("/scan", response_model=ScanOut)
async def scan(db: DB, user: CurrentUser = Depends(require("reactivation", "approve"))):
    return await service.scan(db, user)


@router.get("/analytics", response_model=AnalyticsOut)
async def analytics(db: DB, since_days: int | None = Query(None, ge=1, le=3650),
                    _: CurrentUser = Depends(require("reactivation", "view"))):
    return await service.analytics(db, since_days)
