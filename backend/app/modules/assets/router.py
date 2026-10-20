import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common import audit, provenance
from app.common.provenance import ObservationOut
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.core.security import utcnow
from app.modules.assets import service
from app.modules.assets.calc import norm_key
from app.modules.assets.models import (
    ASSET_STATUSES,
    CONCENTRATION_DIMENSIONS,
    FIN_CATEGORIES,
    GROUP_BYS,
    MILESTONE_STATUSES,
    WATCH_TRIGGERS,
    Asset,
    AssetFinancial,
    AssetMilestone,
    ConcentrationLimit,
    TenantProfile,
    VarianceExplanation,
    WatchlistEntry,
)
from app.modules.assets.schemas import (
    AssetCreate,
    AssetFacets,
    AssetListItem,
    AssetOut,
    AssetUpdate,
    ExplainIn,
    ExplanationText,
    FinancialBulkIn,
    FinancialIn,
    FinancialOut,
    LimitIn,
    LimitOut,
    MilestoneIn,
    MilestoneOut,
    MilestoneUpdate,
    ReviewIn,
    SettingsIn,
    TenantProfileIn,
    TenantProfileOut,
    VarianceOut,
    VerifyPeriodsIn,
    WatchOut,
    WatchResolveIn,
)
from app.modules.assets.service import AssetFilters
from app.modules.properties.models import Property

router = APIRouter(prefix="/assets", tags=["assets"])

SORTS = {
    "property": Property.name, "address_line": Property.address_line, "status": Asset.status,
    "property_type": Property.property_type, "state": Property.state, "acquired_on": Asset.acquired_on,
    "basis": Asset.basis, "current_value": Asset.current_value, "updated_at": Asset.updated_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    property_type: list[str] | None = Query(None),
    state: list[str] | None = Query(None),
    manager_id: list[uuid.UUID] | None = Query(None),
    ids: list[uuid.UUID] | None = Query(None),
    property_id: uuid.UUID | None = None,
    watchlist: bool | None = None,
) -> AssetFilters:
    return AssetFilters(**locals())


@router.get("", response_model=Page[AssetListItem])
async def list_assets(db: DB, params: ListParams = Depends(), f: AssetFilters = Depends(filters),
                      _: CurrentUser = Depends(require("assets", "view"))):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Asset.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[AssetListItem](items=await service.to_items(db, items), total=total, page=params.page,
                               page_size=params.page_size)


@router.get("/facets", response_model=AssetFacets)
async def facets(db: DB, f: AssetFilters = Depends(filters), _: CurrentUser = Depends(require("assets", "view"))):
    cols = [Asset.id, Asset.status, Property.property_type, Property.state]
    q = service.build_query
    return AssetFacets(
        status=await facet_counts(db, q(f, skip={"status"}, cols=cols), Asset.status),
        property_type=await facet_counts(db, q(f, skip={"property_type"}, cols=cols), Property.property_type),
        state=await facet_counts(db, q(f, skip={"state"}, cols=cols), Property.state),
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("assets", "view"))):
    return {"statuses": ASSET_STATUSES, "categories": FIN_CATEGORIES, "group_bys": GROUP_BYS,
            "dimensions": CONCENTRATION_DIMENSIONS, "milestone_statuses": MILESTONE_STATUSES,
            "watch_triggers": WATCH_TRIGGERS}


@router.get("/portfolio")
async def portfolio(db: DB, group_by: str = Query("property_type"), f: AssetFilters = Depends(filters),
                    _: CurrentUser = Depends(require("assets", "view"))):
    if group_by not in GROUP_BYS:
        raise HTTPException(422, f"group_by must be one of {', '.join(GROUP_BYS)}")
    return await service.portfolio(db, f, group_by)


@router.get("/portfolio/cash-flow")
async def portfolio_cash_flow(db: DB, months: int = Query(12, ge=1, le=60), end: date | None = None,
                              f: AssetFilters = Depends(filters), _: CurrentUser = Depends(require("assets", "view"))):
    if not f.status:
        f.status = ["active", "held_for_sale"]
    assets = list(await db.scalars(service.build_query(f)))
    return await service.cash_flow(db, assets, months, end)


@router.get("/concentration")
async def concentration(db: DB, _: CurrentUser = Depends(require("assets", "view"))):
    return await service.concentration(db)


@router.post("/concentration/check")
async def concentration_check(db: DB, user: CurrentUser = Depends(require("assets", "edit"))):
    breaches = await service.check_concentration(db)
    await audit.record(db, actor=user, action="asset.concentration_checked", entity_type="concentration_limit",
                       summary=f"{len(breaches)} breaches", ip_address=user.ip_address)
    await db.commit()
    return {"breaches": breaches}


# ---------------------------------------------------------------- concentration limits

@router.get("/concentration-limits", response_model=list[LimitOut])
async def list_limits(db: DB, _: CurrentUser = Depends(require("assets", "view"))):
    return list(await db.scalars(select(ConcentrationLimit).where(ConcentrationLimit.deleted_at.is_(None))
                                 .order_by(ConcentrationLimit.dimension, ConcentrationLimit.key)))


@router.post("/concentration-limits", response_model=LimitOut, status_code=201)
async def create_limit(body: LimitIn, db: DB, user: CurrentUser = Depends(require("assets", "approve"))):
    lim = ConcentrationLimit(**body.model_dump(), created_by_id=user.id, updated_by_id=user.id)
    db.add(lim)
    await db.flush()
    await audit.record(db, actor=user, action="concentration_limit.created", entity_type="concentration_limit",
                       entity_id=lim.id, changes=body.model_dump(), ip_address=user.ip_address)
    await db.commit()
    return lim


async def _limit(db, limit_id: uuid.UUID) -> ConcentrationLimit:
    lim = await db.get(ConcentrationLimit, limit_id)
    if not lim or lim.deleted_at:
        raise HTTPException(404, "Limit not found")
    return lim


@router.patch("/concentration-limits/{limit_id}", response_model=LimitOut)
async def update_limit(limit_id: uuid.UUID, body: LimitIn, db: DB, user: CurrentUser = Depends(require("assets", "approve"))):
    lim = await _limit(db, limit_id)
    values = body.model_dump()
    changes = audit.diff(lim, values)
    for k, v in values.items():
        setattr(lim, k, v)
    lim.updated_by_id = user.id
    await audit.record(db, actor=user, action="concentration_limit.updated", entity_type="concentration_limit",
                       entity_id=lim.id, changes=changes, ip_address=user.ip_address)
    await db.commit()
    return lim


@router.delete("/concentration-limits/{limit_id}", status_code=204)
async def delete_limit(limit_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("assets", "approve"))):
    lim = await _limit(db, limit_id)
    lim.deleted_at, lim.updated_by_id = utcnow(), user.id
    await audit.record(db, actor=user, action="concentration_limit.deleted", entity_type="concentration_limit",
                       entity_id=lim.id, ip_address=user.ip_address)
    await db.commit()


# ---------------------------------------------------------------- tenant profiles

@router.get("/tenant-profiles", response_model=list[TenantProfileOut])
async def list_tenant_profiles(db: DB, q: str | None = None, _: CurrentUser = Depends(require("assets", "view"))):
    stmt = select(TenantProfile).where(TenantProfile.deleted_at.is_(None)).order_by(TenantProfile.tenant_name)
    if q:
        stmt = stmt.where(TenantProfile.tenant_name.ilike(f"%{q}%"))
    return list(await db.scalars(stmt.limit(500)))


@router.post("/tenant-profiles", response_model=TenantProfileOut, status_code=201)
async def upsert_tenant_profile(body: TenantProfileIn, db: DB, user: CurrentUser = Depends(require("assets", "edit"))):
    key = norm_key(body.tenant_name)
    tp = await db.scalar(select(TenantProfile).where(TenantProfile.tenant_key == key))
    values = body.model_dump()
    if tp is None:
        tp = TenantProfile(tenant_key=key, **values, created_by_id=user.id, updated_by_id=user.id)
        db.add(tp)
        await db.flush()
        changes = values
    else:
        changes = audit.diff(tp, values)
        for k, v in values.items():
            setattr(tp, k, v)
        tp.deleted_at, tp.updated_by_id = None, user.id
    await audit.record(db, actor=user, action="tenant_profile.saved", entity_type="tenant_profile", entity_id=tp.id,
                       summary=tp.tenant_name, changes=changes, ip_address=user.ip_address)
    await db.commit()
    return tp


# ---------------------------------------------------------------- settings

@router.get("/settings")
async def get_settings(db: DB, _: CurrentUser = Depends(require("assets", "view"))):
    return await service.get_settings(db)


@router.put("/settings")
async def put_settings(body: SettingsIn, db: DB, user: CurrentUser = Depends(require("assets", "approve"))):
    return await service.save_settings(db, body, user)


# ---------------------------------------------------------------- watchlist

@router.get("/watchlist", response_model=list[WatchOut])
async def watchlist(db: DB, status: list[str] | None = Query(None), asset_id: uuid.UUID | None = None,
                    trigger: list[str] | None = Query(None), limit: int = Query(200, ge=1, le=1000),
                    _: CurrentUser = Depends(require("assets", "view"))):
    stmt = select(WatchlistEntry).where(WatchlistEntry.deleted_at.is_(None))
    if status:
        stmt = stmt.where(WatchlistEntry.status.in_(status))
    if trigger:
        stmt = stmt.where(WatchlistEntry.trigger.in_(trigger))
    if asset_id:
        stmt = stmt.where(WatchlistEntry.asset_id == asset_id)
    rows = list(await db.scalars(stmt.order_by(WatchlistEntry.last_detected_at.desc()).limit(limit)))
    return await service.watch_items(db, rows)


@router.post("/watchlist/scan")
async def watchlist_scan(db: DB, asset_id: uuid.UUID | None = None,
                         user: CurrentUser = Depends(require("assets", "edit"))):
    result = await service.scan_watchlist(db, user, [asset_id] if asset_id else None)
    await db.commit()
    return result


@router.post("/watchlist/{entry_id}/resolve", response_model=WatchOut)
async def resolve_watch(entry_id: uuid.UUID, body: WatchResolveIn, db: DB,
                        user: CurrentUser = Depends(require("assets", "edit"))):
    e = await db.get(WatchlistEntry, entry_id)
    if not e or e.deleted_at:
        raise HTTPException(404, "Watchlist entry not found")
    e = await service.resolve_watch(db, e, body.status, body.note, user)
    return (await service.watch_items(db, [e]))[0]


# ---------------------------------------------------------------- variances

@router.get("/variances", response_model=list[VarianceOut])
async def variances(db: DB, status: list[str] | None = Query(None), unexplained: bool = False,
                    asset_id: uuid.UUID | None = None, limit: int = Query(200, ge=1, le=1000),
                    _: CurrentUser = Depends(require("assets", "view"))):
    stmt = select(VarianceExplanation).where(VarianceExplanation.deleted_at.is_(None))
    if unexplained:
        stmt = stmt.where(VarianceExplanation.status.in_(["required", "rejected"]))
    elif status:
        stmt = stmt.where(VarianceExplanation.status.in_(status))
    if asset_id:
        stmt = stmt.where(VarianceExplanation.asset_id == asset_id)
    rows = list(await db.scalars(stmt.order_by(VarianceExplanation.period.desc(), VarianceExplanation.created_at.desc()).limit(limit)))
    return await service.variance_items(db, rows)


async def _variance(db, variance_id: uuid.UUID) -> VarianceExplanation:
    v = await db.get(VarianceExplanation, variance_id)
    if not v or v.deleted_at:
        raise HTTPException(404, "Variance record not found")
    return v


@router.post("/variances/{variance_id}/submit", response_model=VarianceOut)
async def submit_variance(variance_id: uuid.UUID, body: ExplanationText, db: DB,
                          user: CurrentUser = Depends(require("assets", "edit"))):
    v = await service.submit_explanation(db, await _variance(db, variance_id), body.explanation, user)
    return (await service.variance_items(db, [v]))[0]


@router.post("/variances/{variance_id}/review", response_model=VarianceOut)
async def review_variance(variance_id: uuid.UUID, body: ReviewIn, db: DB,
                          user: CurrentUser = Depends(require("assets", "approve"))):
    v = await service.review_explanation(db, await _variance(db, variance_id), body.decision, body.note, user)
    return (await service.variance_items(db, [v]))[0]


# ---------------------------------------------------------------- milestones / financial rows by id

@router.patch("/milestones/{milestone_id}", response_model=MilestoneOut)
async def update_milestone(milestone_id: uuid.UUID, body: MilestoneUpdate, db: DB,
                           user: CurrentUser = Depends(require("assets", "edit"))):
    m = await db.get(AssetMilestone, milestone_id)
    if not m or m.deleted_at:
        raise HTTPException(404, "Milestone not found")
    m = await service.update_milestone(db, m, body, user)
    return (await service.milestone_items(db, [m]))[0]


@router.delete("/financials/{financial_id}", status_code=204)
async def delete_financial(financial_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("assets", "edit"))):
    f = await db.get(AssetFinancial, financial_id)
    if not f or f.deleted_at:
        raise HTTPException(404, "Financial row not found")
    if f.verified and not user.can("assets", "approve"):
        raise HTTPException(403, "Deleting a verified actual requires approval permission")
    await service.delete_financial(db, f, user)


@router.get("/by-property/{property_id}", response_model=AssetOut)
async def asset_by_property(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("assets", "view"))):
    a = await service.by_property(db, property_id)
    if not a:
        raise HTTPException(404, "This property has no asset record")
    return await service.to_out(db, a)


# ---------------------------------------------------------------- asset record

@router.post("", response_model=AssetOut, status_code=201)
async def create_asset(body: AssetCreate, db: DB, user: CurrentUser = Depends(require("assets", "create"))):
    return await service.to_out(db, await service.create(db, body, user))


@router.get("/{asset_id}", response_model=AssetOut)
async def get_asset(asset_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("assets", "view"))):
    return await service.to_out(db, await service.get(db, asset_id))


@router.patch("/{asset_id}", response_model=AssetOut)
async def update_asset(asset_id: uuid.UUID, body: AssetUpdate, db: DB, user: CurrentUser = Depends(require("assets", "edit"))):
    a = await service.update(db, await service.get(db, asset_id), body, user)
    return await service.to_out(db, a)


@router.delete("/{asset_id}", status_code=204)
async def archive_asset(asset_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("assets", "delete"))):
    await service.archive(db, await service.get(db, asset_id), user)


@router.get("/{asset_id}/history", response_model=list[ObservationOut])
async def asset_history(asset_id: uuid.UUID, db: DB, field: str | None = None,
                        _: CurrentUser = Depends(require("assets", "view"))):
    return await provenance.history(db, service.ENTITY, asset_id, field)


@router.get("/{asset_id}/financials", response_model=list[FinancialOut])
async def list_financials(
    asset_id: uuid.UUID, db: DB, period_from: date | None = None, period_to: date | None = None,
    category: list[str] | None = Query(None), account: str | None = None, include_history: bool = False,
    _: CurrentUser = Depends(require("assets", "view")),
):
    await service.get(db, asset_id)
    stmt = select(AssetFinancial).where(AssetFinancial.asset_id == asset_id)
    if not include_history:  # history = superseded and deleted rows too (is_current=False)
        stmt = stmt.where(AssetFinancial.is_current.is_(True), AssetFinancial.deleted_at.is_(None))
    if period_from:
        stmt = stmt.where(AssetFinancial.period >= period_from)
    if period_to:
        stmt = stmt.where(AssetFinancial.period <= period_to)
    if category:
        stmt = stmt.where(AssetFinancial.category.in_(category))
    if account:
        stmt = stmt.where(AssetFinancial.account == account)
    return list(await db.scalars(stmt.order_by(AssetFinancial.period.desc(), AssetFinancial.category,
                                               AssetFinancial.account, AssetFinancial.created_at.desc()).limit(5000)))


@router.post("/{asset_id}/financials", response_model=FinancialOut, status_code=201)
async def add_financial(asset_id: uuid.UUID, body: FinancialIn, db: DB, user: CurrentUser = Depends(require("assets", "edit"))):
    return await service.add_financial(db, await service.get(db, asset_id), body, user)


@router.post("/{asset_id}/financials/bulk")
async def bulk_financials(asset_id: uuid.UUID, body: FinancialBulkIn, db: DB,
                          user: CurrentUser = Depends(require("assets", "edit"))):
    return await service.bulk_financials(db, await service.get(db, asset_id), body.rows, body.source, user)


@router.post("/{asset_id}/financials/verify")
async def verify_financials(asset_id: uuid.UUID, body: VerifyPeriodsIn, db: DB,
                            user: CurrentUser = Depends(require("assets", "approve"))):
    n = await service.verify_financials(db, await service.get(db, asset_id), body.period_from, body.period_to, user)
    return {"verified": n}


@router.get("/{asset_id}/performance")
async def performance(asset_id: uuid.UUID, db: DB, year: int | None = Query(None, ge=1990, le=2100),
                      month: int | None = Query(None, ge=1, le=12), _: CurrentUser = Depends(require("assets", "view"))):
    return await service.performance(db, await service.get(db, asset_id), year or date.today().year, month)


@router.post("/{asset_id}/variances/scan")
async def scan_variances(asset_id: uuid.UUID, db: DB, year: int | None = Query(None, ge=1990, le=2100),
                         month: int | None = Query(None, ge=1, le=12), user: CurrentUser = Depends(require("assets", "edit"))):
    a = await service.get(db, asset_id)
    n = await service.detect_variances(db, a, year or date.today().year, month, user)
    await audit.record(db, actor=user, action="asset.variances_scanned", entity_type="asset", entity_id=a.id,
                       summary=f"{n} explanations required", ip_address=user.ip_address)
    await db.commit()
    return {"created": n}


@router.post("/{asset_id}/variances/explain", response_model=VarianceOut)
async def explain_variance(asset_id: uuid.UUID, body: ExplainIn, db: DB, user: CurrentUser = Depends(require("assets", "edit"))):
    v = await service.explain(db, await service.get(db, asset_id), body, user)
    return (await service.variance_items(db, [v]))[0]


@router.get("/{asset_id}/cash-flow")
async def asset_cash_flow(asset_id: uuid.UUID, db: DB, months: int = Query(12, ge=1, le=60), end: date | None = None,
                          _: CurrentUser = Depends(require("assets", "view"))):
    return await service.cash_flow(db, [await service.get(db, asset_id)], months, end)


@router.get("/{asset_id}/milestones", response_model=list[MilestoneOut])
async def list_milestones(asset_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("assets", "view"))):
    rows = list(await db.scalars(select(AssetMilestone).where(AssetMilestone.asset_id == asset_id,
                                                             AssetMilestone.deleted_at.is_(None))
                                 .order_by(AssetMilestone.due_on.asc().nulls_last(), AssetMilestone.created_at)))
    return await service.milestone_items(db, rows)


@router.post("/{asset_id}/milestones", response_model=MilestoneOut, status_code=201)
async def create_milestone(asset_id: uuid.UUID, body: MilestoneIn, db: DB, user: CurrentUser = Depends(require("assets", "edit"))):
    m = await service.create_milestone(db, await service.get(db, asset_id), body, user)
    return (await service.milestone_items(db, [m]))[0]
