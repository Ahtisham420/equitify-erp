import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select

from app.common.query import ListParams, Page, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.properties.models import Property
from app.modules.scoring import service
from app.modules.scoring.models import COMPONENT_LABELS, COMPONENTS, OpportunityScore, ScoreConfig, ScoreOutcome
from app.modules.scoring.schemas import (
    ConfigIn,
    ConfigOut,
    HistoryPoint,
    OutcomeIn,
    OutcomeOut,
    OutcomeSummary,
    PropertyScoreOut,
    RankingFacets,
    RankingItem,
    RejectIn,
    ScoreOut,
)
from app.modules.scoring.service import RankingFilters

router = APIRouter(prefix="/scoring", tags=["scoring"])

SORTS = {
    "score": OpportunityScore.score, "confidence": OpportunityScore.confidence,
    "adjusted_score": OpportunityScore.adjusted_score, "computed_at": OpportunityScore.computed_at,
    "band": service.BAND_ORDER,
}


def filters(
    q: str | None = Query(None, max_length=200),
    band: list[str] | None = Query(None),
    property_type: list[str] | None = Query(None),
    min_score: float | None = Query(None, ge=0, le=100),
    max_score: float | None = Query(None, ge=0, le=100),
    min_confidence: float | None = Query(None, ge=0, le=1),
    territory_id: uuid.UUID | None = None,
    needs_research: bool | None = None,
) -> RankingFilters:
    return RankingFilters(**locals())


@router.get("/meta")
async def meta(db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    cfg = await service.active_config(db)
    await db.commit()
    return {"components": [{"key": k, "label": COMPONENT_LABELS[k]} for k in COMPONENTS],
            "bands": ["high", "medium", "low"], "active_version": cfg.version,
            "min_outcomes": service.MIN_OUTCOMES}


# ----------------------------------------------------------------------------- rankings


@router.get("/rankings", response_model=Page[RankingItem])
async def rankings(db: DB, params: ListParams = Depends(), f: RankingFilters = Depends(filters),
                   _: CurrentUser = Depends(require("scoring", "view"))):
    # Default: rank by score within confidence band (High, then Medium, then Low).
    stmt = service.rankings_query(f)
    if params.sort:
        stmt = apply_sort(stmt, params.sort, SORTS, OpportunityScore.score.desc())
    else:
        stmt = stmt.order_by(service.BAND_ORDER, OpportunityScore.score.desc(), OpportunityScore.confidence.desc())
    rows, total = await paginate(db, stmt, params)
    items = await service.ranking_items(db, rows, (params.page - 1) * params.page_size)
    return Page[RankingItem](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/rankings/facets", response_model=RankingFacets)
async def ranking_facets(db: DB, f: RankingFilters = Depends(filters),
                         _: CurrentUser = Depends(require("scoring", "view"))):
    return RankingFacets(
        band=await facet_counts(db, service.rankings_query(f, skip={"band"}), OpportunityScore.band),
        property_type=await facet_counts(db, service.rankings_query(f, skip={"property_type"}), Property.property_type),
    )


@router.post("/rescore-all")
async def rescore_all(db: DB, user: CurrentUser = Depends(require("scoring", "approve"))):
    from app.common import audit

    n = await service.rescore_all(db, actor=user, trigger="manual_bulk", alerts=True)
    await audit.record(db, actor=user, action="scoring.rescored_all", entity_type="scoring", summary=f"{n} properties",
                       ip_address=user.ip_address)
    await db.commit()
    return {"rescored": n}


# ----------------------------------------------------------------------------- property


@router.get("/properties/{property_id}", response_model=PropertyScoreOut)
async def property_score(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    eligible, rows = await service.eligibility(db, property_id)
    cur = await service.current_score(db, property_id)
    history = await service.property_history(db, property_id)
    return PropertyScoreOut(property_id=property_id, eligible=eligible, eligibility=rows,
                            score=ScoreOut.model_validate(cur) if cur else None,
                            history=[HistoryPoint.model_validate(h) for h in history])


@router.get("/properties/{property_id}/history", response_model=list[ScoreOut])
async def property_history(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    return [ScoreOut.model_validate(h) for h in await service.property_history(db, property_id)]


@router.get("/scores/{score_id}", response_model=ScoreOut)
async def get_score(score_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    row = await db.get(OpportunityScore, score_id)
    if not row:
        raise HTTPException(404, "Score not found")
    return ScoreOut.model_validate(row)


@router.post("/properties/{property_id}/rescore", response_model=PropertyScoreOut)
async def rescore(property_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("scoring", "edit"))):
    from app.common import audit

    p = await db.get(Property, property_id)
    if not p or p.deleted_at:
        raise HTTPException(404, "Property not found")
    row = await service.rescore_property(db, property_id, user, trigger="manual")
    await audit.record(db, actor=user, action="property.rescored", entity_type="property", entity_id=property_id,
                       summary=f"Score {row.score} · {row.band} confidence" if row else "Not eligible for scoring",
                       ip_address=user.ip_address)
    await db.commit()
    return await property_score(property_id, db, user)


# ----------------------------------------------------------------------------- configs


@router.get("/configs", response_model=list[ConfigOut])
async def list_configs(db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    await service.active_config(db)
    await db.commit()
    return list(await db.scalars(select(ScoreConfig).where(ScoreConfig.deleted_at.is_(None))
                                 .order_by(ScoreConfig.version.desc())))


@router.post("/configs", response_model=ConfigOut, status_code=201)
async def create_config(body: ConfigIn, db: DB, user: CurrentUser = Depends(require("scoring", "edit"))):
    return await service.create_config(db, body, user)


@router.post("/configs/recalibrate", response_model=ConfigOut, status_code=201)
async def recalibrate(db: DB, user: CurrentUser = Depends(require("scoring", "edit"))):
    return await service.propose_recalibration(db, user)


@router.get("/configs/{config_id}", response_model=ConfigOut)
async def get_config(config_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    return await service.get_config(db, config_id)


@router.put("/configs/{config_id}", response_model=ConfigOut)
async def update_config(config_id: uuid.UUID, body: ConfigIn, db: DB,
                        user: CurrentUser = Depends(require("scoring", "edit"))):
    return await service.update_config(db, await service.get_config(db, config_id), body, user)


@router.post("/configs/{config_id}/activate", response_model=ConfigOut)
async def activate_config(config_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("scoring", "approve"))):
    return await service.activate_config(db, await service.get_config(db, config_id), user)


@router.post("/configs/{config_id}/reject", response_model=ConfigOut)
async def reject_config(config_id: uuid.UUID, body: RejectIn, db: DB,
                        user: CurrentUser = Depends(require("scoring", "approve"))):
    return await service.reject_config(db, await service.get_config(db, config_id), body.reason, user)


# ----------------------------------------------------------------------------- outcomes


@router.get("/outcomes", response_model=Page[OutcomeOut])
async def list_outcomes(
    db: DB, params: ListParams = Depends(), result: list[str] | None = Query(None),
    disposition: list[str] | None = Query(None), band: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None, _: CurrentUser = Depends(require("scoring", "view")),
):
    stmt = select(ScoreOutcome).where(ScoreOutcome.deleted_at.is_(None))
    stmt = in_filter(stmt, ScoreOutcome.result, result)
    stmt = in_filter(stmt, ScoreOutcome.disposition, disposition)
    stmt = in_filter(stmt, ScoreOutcome.band_at_decision, band)
    if property_id:
        stmt = stmt.where(ScoreOutcome.property_id == property_id)
    stmt = apply_sort(stmt, params.sort, {"decided_at": ScoreOutcome.decided_at,
                                          "score_at_decision": ScoreOutcome.score_at_decision,
                                          "elapsed_days": ScoreOutcome.elapsed_days}, ScoreOutcome.decided_at.desc())
    rows, total = await paginate(db, stmt, params)
    labels = {}
    if rows:
        labels = {i: n or a for i, n, a in (await db.execute(select(Property.id, Property.name, Property.address_line)
                                                             .where(Property.id.in_({r.property_id for r in rows})))).all()}
    items = []
    for r in rows:
        o = OutcomeOut.model_validate(r)
        o.property_label = labels.get(r.property_id)
        items.append(o)
    return Page[OutcomeOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/outcomes/summary", response_model=OutcomeSummary)
async def outcomes_summary(db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    return await service.outcome_summary(db)


@router.get("/outcomes/facets")
async def outcome_facets(db: DB, _: CurrentUser = Depends(require("scoring", "view"))):
    base = select(ScoreOutcome).where(ScoreOutcome.deleted_at.is_(None))
    return {
        "result": await facet_counts(db, base, ScoreOutcome.result),
        "disposition": await facet_counts(db, base, ScoreOutcome.disposition),
        "band": await facet_counts(db, base, ScoreOutcome.band_at_decision),
        "total": int(await db.scalar(select(func.count()).select_from(base.subquery())) or 0),
    }


@router.post("/outcomes", response_model=OutcomeOut, status_code=201)
async def create_outcome(body: OutcomeIn, db: DB, user: CurrentUser = Depends(require("scoring", "edit"))):
    return await service.create_manual_outcome(db, body, user)
