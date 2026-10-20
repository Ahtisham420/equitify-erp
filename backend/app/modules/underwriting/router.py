import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.underwriting import engine, service
from app.modules.underwriting.models import UW_STATUSES, UwModel
from app.modules.underwriting.schemas import (
    AssumptionsIn,
    DecisionIn,
    DiffOut,
    EventOut,
    ModelCreate,
    ModelFacets,
    ModelListItem,
    ModelOut,
    ModelUpdate,
    NewVersionIn,
    ScenariosIn,
    SimulateIn,
    VersionItem,
)
from app.modules.underwriting.service import ModelFilters
from app.modules.underwriting.templates import PROPERTY_TYPE_TEMPLATE, TEMPLATES, seed

router = APIRouter(prefix="/uw-models", tags=["underwriting"])

SORTS = {
    "name": UwModel.name, "status": UwModel.status, "template": UwModel.template, "version": UwModel.version,
    "updated_at": UwModel.updated_at, "created_at": UwModel.created_at, "approved_at": UwModel.approved_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    template: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    opportunity_id: uuid.UUID | None = None,
    root_id: uuid.UUID | None = None,
    latest_only: bool = True,
    locked: bool | None = None,
) -> ModelFilters:
    return ModelFilters(**locals())


@router.get("", response_model=Page[ModelListItem])
async def list_models(db: DB, params: ListParams = Depends(), f: ModelFilters = Depends(filters),
                      _: CurrentUser = Depends(require("underwriting", "view"))):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, UwModel.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[ModelListItem](items=await service.to_items(db, items), total=total, page=params.page,
                               page_size=params.page_size)


@router.get("/facets", response_model=ModelFacets)
async def facets(db: DB, f: ModelFilters = Depends(filters), _: CurrentUser = Depends(require("underwriting", "view"))):
    return ModelFacets(
        status=await facet_counts(db, service.build_query(f, skip={"status"}), UwModel.status),
        template=await facet_counts(db, service.build_query(f, skip={"template"}), UwModel.template),
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("underwriting", "view"))):
    return {
        "statuses": UW_STATUSES,
        "templates": [{"key": k, **v} for k, v in TEMPLATES.items()],
        "property_type_template": PROPERTY_TYPE_TEMPLATE,
        "material_paths": [{"path": p, "label": label} for p, label in engine.MATERIAL_PATHS],
        "land_material_paths": [{"path": p, "label": label} for p, label in engine.LAND_MATERIAL_PATHS],
        "sensitivity_vars": engine.SENSITIVITY_VARS,
        "simulation_max_iterations": 2000,
    }


@router.get("/templates/{template}")
async def template_preview(template: str, _: CurrentUser = Depends(require("underwriting", "view"))):
    a = seed(template, start=date.today())
    a.pop("scenarios_seed", None)
    return a


@router.post("", response_model=ModelOut, status_code=201)
async def create_model(body: ModelCreate, db: DB, user: CurrentUser = Depends(require("underwriting", "create"))):
    return await service.to_out(db, await service.create(db, body, user), user)


@router.get("/{model_id}", response_model=ModelOut)
async def get_model(model_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("underwriting", "view"))):
    return await service.to_out(db, await service.get(db, model_id), user)


@router.patch("/{model_id}", response_model=ModelOut)
async def update_model(model_id: uuid.UUID, body: ModelUpdate, db: DB,
                       user: CurrentUser = Depends(require("underwriting", "edit"))):
    m = await service.update_meta(db, await service.get(db, model_id), body, user)
    return await service.to_out(db, m, user)


@router.delete("/{model_id}", status_code=204)
async def delete_model(model_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("underwriting", "delete"))):
    await service.archive(db, await service.get(db, model_id), user)


@router.put("/{model_id}/assumptions", response_model=ModelOut)
async def put_assumptions(model_id: uuid.UUID, body: AssumptionsIn, db: DB,
                          user: CurrentUser = Depends(require("underwriting", "edit"))):
    """Drafts change in place; any other version spawns a new draft version (response id differs)."""
    m = await service.save_assumptions(db, await service.get(db, model_id), body, user)
    return await service.to_out(db, m, user)


@router.put("/{model_id}/scenarios", response_model=ModelOut)
async def put_scenarios(model_id: uuid.UUID, body: ScenariosIn, db: DB,
                        user: CurrentUser = Depends(require("underwriting", "edit"))):
    m = await service.save_scenarios(db, await service.get(db, model_id), body, user)
    return await service.to_out(db, m, user)


@router.post("/{model_id}/recalculate", response_model=ModelOut)
async def recalculate(model_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("underwriting", "edit"))):
    m = await service.recalculate(db, await service.get(db, model_id), user)
    return await service.to_out(db, m, user)


@router.post("/{model_id}/versions", response_model=ModelOut, status_code=201)
async def create_version(model_id: uuid.UUID, body: NewVersionIn, db: DB,
                         user: CurrentUser = Depends(require("underwriting", "edit"))):
    m = await service.new_version(db, await service.get(db, model_id), user, note=body.change_note)
    return await service.to_out(db, m, user)


@router.get("/{model_id}/versions", response_model=list[VersionItem])
async def list_versions(model_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("underwriting", "view"))):
    return await service.versions(db, await service.get(db, model_id))


@router.get("/{model_id}/diff", response_model=DiffOut)
async def version_diff(model_id: uuid.UUID, db: DB, against: uuid.UUID | None = None,
                       _: CurrentUser = Depends(require("underwriting", "view"))):
    return await service.diff(db, await service.get(db, model_id), against)


@router.get("/{model_id}/events", response_model=list[EventOut])
async def model_events(model_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("underwriting", "view"))):
    return await service.events_for(db, await service.get(db, model_id))


@router.post("/{model_id}/submit", response_model=ModelOut)
async def submit(model_id: uuid.UUID, body: DecisionIn, db: DB, user: CurrentUser = Depends(require("underwriting", "edit"))):
    return await service.to_out(db, await service.submit(db, await service.get(db, model_id), body, user), user)


@router.post("/{model_id}/approve", response_model=ModelOut)
async def approve(model_id: uuid.UUID, body: DecisionIn, db: DB,
                  user: CurrentUser = Depends(require("underwriting", "approve"))):
    return await service.to_out(db, await service.approve(db, await service.get(db, model_id), body, user), user)


@router.post("/{model_id}/reject", response_model=ModelOut)
async def reject(model_id: uuid.UUID, body: DecisionIn, db: DB,
                 user: CurrentUser = Depends(require("underwriting", "approve"))):
    return await service.to_out(db, await service.reject(db, await service.get(db, model_id), body, user), user)


@router.get("/{model_id}/sensitivity")
async def sensitivity(
    model_id: uuid.UUID, db: DB, metric: str = Query("irr", pattern="^[a-z_]+$"), scenario: str | None = None,
    price_step: float | None = Query(None, gt=0, le=50), noi_step: float | None = Query(None, gt=0, le=50),
    rate_step: float | None = Query(None, gt=0, le=500), exit_cap_step: float | None = Query(None, gt=0, le=500),
    hold_step: float | None = Query(None, gt=0, le=10),
    _: CurrentUser = Depends(require("underwriting", "view")),
):
    """Tornado data: one-way sensitivities of `metric` to price, NOI, interest rate, exit cap and hold period."""
    steps = {k: v for k, v in {"price": price_step, "noi": noi_step, "rate": rate_step, "exit_cap": exit_cap_step,
                               "hold": hold_step}.items() if v is not None}
    return await service.sensitivity(await service.get(db, model_id), metric, scenario, steps)


@router.post("/{model_id}/simulate")
async def simulate(model_id: uuid.UUID, body: SimulateIn, db: DB,
                   user: CurrentUser = Depends(require("underwriting", "view"))):
    return await service.simulate(db, await service.get(db, model_id), body, user)


@router.get("/{model_id}/variance")
async def variance(model_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("underwriting", "view"))):
    return await service.variance(db, await service.get(db, model_id))
