import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.buybox import service
from app.modules.buybox.models import (
    EXCEPTION_STATES,
    OPERATORS,
    REQUIREMENTS,
    RESULTS,
    STRATEGY_SUGGESTIONS,
    BuyBox,
    BuyboxEvaluation,
    BuyboxVersion,
)
from app.modules.buybox.schemas import (
    BuyBoxCreate,
    BuyBoxFacets,
    BuyBoxListItem,
    BuyBoxOut,
    BuyBoxUpdate,
    CriteriaReplace,
    CriterionIn,
    EvaluateAllOut,
    EvaluationOut,
    ExceptionDecisionIn,
    ExceptionRequestIn,
    VersionOut,
)
from app.modules.buybox.service import BuyBoxFilters

router = APIRouter(tags=["buy boxes"])

SORTS = {
    "name": BuyBox.name, "strategy": BuyBox.strategy, "version": BuyBox.version, "is_active": BuyBox.is_active,
    "active_from": BuyBox.active_from, "active_to": BuyBox.active_to, "updated_at": BuyBox.updated_at,
    "created_at": BuyBox.created_at,
}
EVAL_SORTS = {"result": BuyboxEvaluation.result, "evaluated_at": BuyboxEvaluation.evaluated_at,
              "buy_box_version": BuyboxEvaluation.buy_box_version}


def filters(
    q: str | None = Query(None, max_length=200),
    strategy: list[str] | None = Query(None),
    is_active: bool | None = None,
    owner_id: uuid.UUID | None = None,
    result: list[str] | None = Query(None),
) -> BuyBoxFilters:
    return BuyBoxFilters(**locals())


@router.get("/buy-boxes", response_model=Page[BuyBoxListItem])
async def list_buy_boxes(
    db: DB, params: ListParams = Depends(), f: BuyBoxFilters = Depends(filters),
    _: CurrentUser = Depends(require("buybox", "view")),
):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, BuyBox.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[BuyBoxListItem](items=await service.to_items(db, items), total=total, page=params.page, page_size=params.page_size)


@router.get("/buy-boxes/facets", response_model=BuyBoxFacets)
async def facets(db: DB, f: BuyBoxFilters = Depends(filters), _: CurrentUser = Depends(require("buybox", "view"))):
    active = await facet_counts(db, service.build_query(f, skip={"is_active"}), BuyBox.is_active)
    boxes = service.build_query(f, skip={"result"}).with_only_columns(BuyBox.id).order_by(None).subquery()
    rows = await db.execute(
        select(BuyboxEvaluation.result, func.count())
        .where(BuyboxEvaluation.is_current.is_(True), BuyboxEvaluation.buy_box_id.in_(select(boxes.c.id)))
        .group_by(BuyboxEvaluation.result)
    )
    return BuyBoxFacets(
        strategy=await facet_counts(db, service.build_query(f, skip={"strategy"}), BuyBox.strategy),
        is_active={k.lower(): v for k, v in active.items()},
        result={r: int(c) for r, c in rows.all()},
    )


@router.get("/buy-boxes/meta")
async def meta(_: CurrentUser = Depends(require("buybox", "view"))):
    return {
        "operators": OPERATORS,
        "operator_labels": service.OP_TEXT,
        "requirements": REQUIREMENTS,
        "results": RESULTS,
        "exception_states": EXCEPTION_STATES,
        "strategies": STRATEGY_SUGGESTIONS,
        "fields": service.field_meta(),
    }


@router.post("/buy-boxes", response_model=BuyBoxOut, status_code=201)
async def create_buy_box(body: BuyBoxCreate, db: DB, user: CurrentUser = Depends(require("buybox", "create"))):
    return await service.to_out(db, await service.create(db, body, user))


@router.get("/buy-boxes/{box_id}", response_model=BuyBoxOut)
async def get_buy_box(box_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("buybox", "view"))):
    return await service.to_out(db, await service.get(db, box_id))


@router.patch("/buy-boxes/{box_id}", response_model=BuyBoxOut)
async def update_buy_box(
    box_id: uuid.UUID, body: BuyBoxUpdate, db: DB, user: CurrentUser = Depends(require("buybox", "edit"))
):
    box = await service.update(db, await service.get(db, box_id), body, user)
    return await service.to_out(db, box)


@router.delete("/buy-boxes/{box_id}", status_code=204)
async def archive_buy_box(box_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("buybox", "delete"))):
    await service.archive(db, await service.get(db, box_id), user)


@router.put("/buy-boxes/{box_id}/criteria", response_model=BuyBoxOut)
async def replace_criteria(
    box_id: uuid.UUID, body: CriteriaReplace, db: DB, user: CurrentUser = Depends(require("buybox", "edit"))
):
    box = await service.replace_criteria(db, await service.get(db, box_id), body.criteria, user, body.change_note)
    return await service.to_out(db, box)


@router.post("/buy-boxes/{box_id}/criteria", response_model=BuyBoxOut, status_code=201)
async def add_criterion(
    box_id: uuid.UUID, body: CriterionIn, db: DB, user: CurrentUser = Depends(require("buybox", "edit"))
):
    box = await service.get(db, box_id)
    items, _ = await service.current_inputs(db, box)
    box = await service.replace_criteria(db, box, [*items, body], user, f"Added {body.field}")
    return await service.to_out(db, box)


@router.patch("/buy-boxes/{box_id}/criteria/{criterion_id}", response_model=BuyBoxOut)
async def update_criterion(
    box_id: uuid.UUID, criterion_id: uuid.UUID, body: CriterionIn, db: DB,
    user: CurrentUser = Depends(require("buybox", "edit")),
):
    box = await service.get(db, box_id)
    items, rows = await service.current_inputs(db, box)
    idx = next((i for i, r in enumerate(rows) if r.id == criterion_id), None)
    if idx is None:
        raise HTTPException(404, "Criterion not found")
    items[idx] = body
    box = await service.replace_criteria(db, box, items, user, f"Changed {body.field}")
    return await service.to_out(db, box)


@router.delete("/buy-boxes/{box_id}/criteria/{criterion_id}", response_model=BuyBoxOut)
async def delete_criterion(
    box_id: uuid.UUID, criterion_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("buybox", "edit"))
):
    box = await service.get(db, box_id)
    items, rows = await service.current_inputs(db, box)
    idx = next((i for i, r in enumerate(rows) if r.id == criterion_id), None)
    if idx is None:
        raise HTTPException(404, "Criterion not found")
    removed = items.pop(idx)
    box = await service.replace_criteria(db, box, items, user, f"Removed {removed.field}")
    return await service.to_out(db, box)


@router.get("/buy-boxes/{box_id}/versions", response_model=list[VersionOut])
async def list_versions(box_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("buybox", "view"))):
    await service.get(db, box_id)
    rows = list(await db.scalars(
        select(BuyboxVersion).where(BuyboxVersion.buy_box_id == box_id).order_by(BuyboxVersion.version.desc())
    ))
    names = await service.user_names(db, {r.created_by_id for r in rows})
    out = []
    for r in rows:
        v = VersionOut.model_validate(r)
        v.created_by_name = names.get(r.created_by_id) if r.created_by_id else None
        out.append(v)
    return out


@router.post("/buy-boxes/{box_id}/evaluate-all", response_model=EvaluateAllOut)
async def evaluate_all(box_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("buybox", "edit"))):
    return await service.evaluate_all(db, await service.get(db, box_id), user)


@router.get("/buy-boxes/{box_id}/evaluations", response_model=Page[EvaluationOut])
async def list_evaluations(
    box_id: uuid.UUID,
    db: DB,
    params: ListParams = Depends(),
    result: list[str] | None = Query(None),
    exception_status: list[str] | None = Query(None),
    current_only: bool = True,
    _: CurrentUser = Depends(require("buybox", "view")),
):
    await service.get(db, box_id)
    stmt = service.evaluations_query(box_id, result=result, exception_status=exception_status,
                                     current_only=current_only, q=params.q)
    stmt = apply_sort(stmt, params.sort, EVAL_SORTS, BuyboxEvaluation.evaluated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[EvaluationOut](items=await service.eval_outs(db, items), total=total, page=params.page, page_size=params.page_size)


@router.get("/properties/{property_id}/buybox-evaluations", response_model=list[EvaluationOut])
async def property_evaluations(
    property_id: uuid.UUID, db: DB, history: bool = False, _: CurrentUser = Depends(require("buybox", "view"))
):
    stmt = select(BuyboxEvaluation).where(BuyboxEvaluation.property_id == property_id)
    if not history:
        stmt = stmt.where(BuyboxEvaluation.is_current.is_(True),
                          BuyboxEvaluation.buy_box_id.in_(select(BuyBox.id).where(BuyBox.deleted_at.is_(None))))
    rows = list(await db.scalars(stmt.order_by(BuyboxEvaluation.evaluated_at.desc()).limit(500)))
    return await service.eval_outs(db, rows)


@router.post("/properties/{property_id}/buybox-evaluations/run", response_model=list[EvaluationOut])
async def run_property_evaluation(
    property_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("buybox", "edit"))
):
    evals = await service.evaluate_property(db, property_id, trigger="manual", actor_id=user.id, skip_unchanged=False)
    await db.commit()
    return await service.eval_outs(db, evals)


@router.get("/buybox-evaluations/{eval_id}", response_model=EvaluationOut)
async def get_evaluation(eval_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("buybox", "view"))):
    return (await service.eval_outs(db, [await service.get_evaluation(db, eval_id)]))[0]


@router.post("/buybox-evaluations/{eval_id}/exception-request", response_model=EvaluationOut)
async def request_exception(
    eval_id: uuid.UUID, body: ExceptionRequestIn, db: DB, user: CurrentUser = Depends(require("buybox", "edit"))
):
    ev = await service.request_exception(db, await service.get_evaluation(db, eval_id), body.reason, user)
    return (await service.eval_outs(db, [ev]))[0]


@router.post("/buybox-evaluations/{eval_id}/exception-decision", response_model=EvaluationOut)
async def decide_exception(
    eval_id: uuid.UUID, body: ExceptionDecisionIn, db: DB, user: CurrentUser = Depends(require("buybox", "approve"))
):
    ev = await service.decide_exception(db, await service.get_evaluation(db, eval_id), body.approve, body.reason, user)
    return (await service.eval_outs(db, [ev]))[0]
