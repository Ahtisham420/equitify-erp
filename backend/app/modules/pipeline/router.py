import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.pipeline import service
from app.modules.pipeline.models import (
    ACTIVE_STAGES,
    DEAD_REASONS,
    DEFAULT_STALL_DAYS,
    PRIORITIES,
    STAGES,
    TERMINAL_STAGES,
    Opportunity,
    OpportunityEvent,
)
from app.modules.pipeline.schemas import (
    BoardColumn,
    EventOut,
    GatesOut,
    MetricsOut,
    MoveIn,
    OpportunityCreate,
    OpportunityFacets,
    OpportunityListItem,
    OpportunityOut,
    OpportunityUpdate,
    StageGates,
    StageSettingsIn,
)
from app.modules.pipeline.service import OpportunityFilters

router = APIRouter(prefix="/opportunities", tags=["pipeline"])

SORTS = {
    "title": Opportunity.title, "stage": Opportunity.stage, "priority": Opportunity.priority,
    "stage_entered_at": Opportunity.stage_entered_at, "next_action_at": Opportunity.next_action_at,
    "price_expectation": Opportunity.price_expectation, "value": service.value_expr(),
    "updated_at": Opportunity.updated_at, "created_at": Opportunity.created_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    stage: list[str] | None = Query(None),
    owner_id: list[uuid.UUID] | None = Query(None),
    priority: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    dead_reason: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    stalled: bool | None = None,
    overdue: bool | None = None,
    min_value: float | None = None,
    max_value: float | None = None,
) -> OpportunityFilters:
    return OpportunityFilters(**locals())


@router.get("", response_model=Page[OpportunityListItem])
async def list_opportunities(
    db: DB, params: ListParams = Depends(), f: OpportunityFilters = Depends(filters),
    _: CurrentUser = Depends(require("pipeline", "view")),
):
    thresholds = await service.get_thresholds(db)
    stmt = apply_sort(service.build_query(f, thresholds), params.sort, SORTS, Opportunity.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[OpportunityListItem](items=await service.to_items(db, items, thresholds), total=total, page=params.page,
                page_size=params.page_size)


@router.get("/facets", response_model=OpportunityFacets)
async def facets(db: DB, f: OpportunityFilters = Depends(filters), _: CurrentUser = Depends(require("pipeline", "view"))):
    t = await service.get_thresholds(db)
    q = service.build_query
    return OpportunityFacets(
        stage=await facet_counts(db, q(f, t, skip={"stage"}), Opportunity.stage),
        priority=await facet_counts(db, q(f, t, skip={"priority"}), Opportunity.priority),
        owner_id=await facet_counts(db, q(f, t, skip={"owner_id"}), Opportunity.owner_id),
        source=await facet_counts(db, q(f, t, skip={"source"}), Opportunity.source),
        dead_reason=await facet_counts(db, q(f, t, skip={"dead_reason"}), Opportunity.dead_reason),
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("pipeline", "view"))):
    return {
        "stages": STAGES,
        "active_stages": ACTIVE_STAGES,
        "terminal_stages": TERMINAL_STAGES,
        "dead_reasons": DEAD_REASONS,
        "priorities": PRIORITIES,
        "reactivation_types": [{"type": k, **v} for k, v in service.REACTIVATION_SPEC.items()],
        "default_stall_days": DEFAULT_STALL_DAYS,
    }


@router.get("/board", response_model=list[BoardColumn])
async def board(
    db: DB,
    f: OpportunityFilters = Depends(filters),
    stages: list[str] | None = Query(None),
    per_stage: int = Query(50, ge=1, le=200),
    _: CurrentUser = Depends(require("pipeline", "view")),
):
    cols = [s for s in (stages or ACTIVE_STAGES) if s in STAGES]
    return await service.board(db, f, await service.get_thresholds(db), cols, per_stage)


@router.get("/metrics", response_model=MetricsOut)
async def metrics(
    db: DB, owner_id: list[uuid.UUID] | None = Query(None), _: CurrentUser = Depends(require("pipeline", "view"))
):
    return await service.metrics(db, await service.get_thresholds(db), owner_id)


@router.get("/stage-settings", response_model=dict[str, int])
async def get_stage_settings(db: DB, _: CurrentUser = Depends(require("pipeline", "view"))):
    return await service.get_thresholds(db)


@router.put("/stage-settings", response_model=dict[str, int])
async def put_stage_settings(body: StageSettingsIn, db: DB, user: CurrentUser = Depends(require("pipeline", "approve"))):
    return await service.save_thresholds(db, body.stall_days, user)


@router.post("", response_model=OpportunityOut, status_code=201)
async def create_opportunity(
    body: OpportunityCreate, db: DB, force: bool = False, user: CurrentUser = Depends(require("pipeline", "create"))
):
    if force and not user.can("pipeline", "approve"):
        raise HTTPException(403, "Creating a second opportunity for a property requires approval permission")
    return await service.to_out(db, await service.create(db, body, user, force=force))


@router.get("/{opportunity_id}", response_model=OpportunityOut)
async def get_opportunity(opportunity_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("pipeline", "view"))):
    return await service.to_out(db, await service.get(db, opportunity_id))


@router.patch("/{opportunity_id}", response_model=OpportunityOut)
async def update_opportunity(
    opportunity_id: uuid.UUID, body: OpportunityUpdate, db: DB, user: CurrentUser = Depends(require("pipeline", "edit"))
):
    o = await service.update(db, await service.get(db, opportunity_id), body, user)
    return await service.to_out(db, o)


@router.delete("/{opportunity_id}", status_code=204)
async def delete_opportunity(opportunity_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("pipeline", "view"))):
    o = await service.get(db, opportunity_id)
    if o.stage == "dead":
        raise HTTPException(409, "Dead opportunities are retained for reactivation and cannot be deleted")
    if not user.can("pipeline", "delete"):
        raise HTTPException(403, "Missing permission pipeline:delete")
    await service.archive(db, o, user)


@router.get("/{opportunity_id}/gates", response_model=GatesOut)
async def gates(opportunity_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("pipeline", "view"))):
    o = await service.get(db, opportunity_id)
    stages = []
    if o.stage != "closed":
        for s in STAGES:
            if s == o.stage:
                continue
            reqs = await service.check_gate(db, o, s)
            stages.append(StageGates(stage=s, ready=not service.unmet_of(reqs), requirements=reqs))
    return GatesOut(current_stage=o.stage, next_stage=service.next_stage(o.stage),
                    can_override=user.can("pipeline", "approve"), stages=stages)


@router.post("/{opportunity_id}/move", response_model=OpportunityOut)
async def move(
    opportunity_id: uuid.UUID, body: MoveIn, db: DB, user: CurrentUser = Depends(require("pipeline", "edit"))
):
    o = await service.move(db, await service.get(db, opportunity_id), body, user)
    return await service.to_out(db, o)


@router.get("/{opportunity_id}/events", response_model=list[EventOut])
async def stage_history(opportunity_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("pipeline", "view"))):
    await service.get(db, opportunity_id)
    return list(await db.scalars(
        select(OpportunityEvent).where(OpportunityEvent.opportunity_id == opportunity_id)
        .order_by(OpportunityEvent.at.desc())
    ))
