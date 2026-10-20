import csv
import io
import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from geoalchemy2 import Geometry
from sqlalchemy import Text, cast, func, select

from app.common import audit
from app.common.audit import to_jsonable
from app.common.query import ListParams, Page, apply_search, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, Authed, CurrentUser, require
from app.modules.imports import quality, service
from app.modules.imports.models import CADENCES, ENTITY_TYPES, JOB_STATUSES, ROW_STATUSES, DataSource, ImportJob, ImportRow
from app.modules.imports.schemas import (
    BacklogFacets,
    BacklogItem,
    CommitIn,
    DataSourceIn,
    DataSourceOut,
    DataSourceUpdate,
    DuplicateGroup,
    ImportFacets,
    ImportJobDetail,
    ImportJobOut,
    ImportRowOut,
    MappingIn,
    QualitySummary,
    StaleItem,
    TargetField,
    Threshold,
    ThresholdsIn,
)

router = APIRouter(tags=["imports"])

ENTITY_MODULE = {"property": "properties", "person": "contacts", "organization": "contacts"}


# --- Data sources (source/license registry) ---------------------------------------------------

def _source_query(q: str | None, is_active: bool | None, cadence: list[str] | None):
    stmt = select(DataSource).where(DataSource.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [DataSource.provider, DataSource.description, DataSource.contact_name,
                                  DataSource.permitted_use])
    if is_active is not None:
        stmt = stmt.where(DataSource.is_active.is_(is_active))
    return in_filter(stmt, DataSource.cadence, cadence)


async def _source_out(db: DB, sources: list[DataSource]) -> list[DataSourceOut]:
    ids = [s.id for s in sources]
    counts = dict((await db.execute(
        select(ImportJob.data_source_id, func.count()).where(ImportJob.data_source_id.in_(ids), ImportJob.deleted_at.is_(None))
        .group_by(ImportJob.data_source_id)
    )).all()) if ids else {}
    return [DataSourceOut.model_validate(s).model_copy(update={"import_count": counts.get(s.id, 0)}) for s in sources]


@router.get("/data-sources", response_model=Page[DataSourceOut])
async def list_sources(
    db: DB,
    params: ListParams = Depends(),
    is_active: bool | None = None,
    cadence: list[str] | None = Query(None),
    _: CurrentUser = Depends(require("imports", "view")),
):
    stmt = apply_sort(_source_query(params.q, is_active, cadence), params.sort, {
        "provider": DataSource.provider, "renewal_date": DataSource.renewal_date, "cost": DataSource.cost,
        "updated_at": DataSource.updated_at, "cadence": DataSource.cadence,
    }, DataSource.provider.asc())
    items, total = await paginate(db, stmt, params)
    return Page[DataSourceOut](items=await _source_out(db, items), total=total, page=params.page, page_size=params.page_size)


@router.get("/data-sources/meta")
async def sources_meta(_: CurrentUser = Depends(require("imports", "view"))):
    return {"cadences": CADENCES}


@router.post("/data-sources", response_model=DataSourceOut, status_code=201)
async def create_source(body: DataSourceIn, db: DB, user: CurrentUser = Depends(require("imports", "create"))):
    return (await _source_out(db, [await service.create_source(db, body, user)]))[0]


@router.get("/data-sources/{source_id}", response_model=DataSourceOut)
async def get_source(source_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("imports", "view"))):
    return (await _source_out(db, [await service.get_source(db, source_id)]))[0]


@router.patch("/data-sources/{source_id}", response_model=DataSourceOut)
async def update_source(source_id: uuid.UUID, body: DataSourceUpdate, db: DB,
                        user: CurrentUser = Depends(require("imports", "edit"))):
    src = await service.update_source(db, await service.get_source(db, source_id), body, user)
    return (await _source_out(db, [src]))[0]


@router.delete("/data-sources/{source_id}", status_code=204)
async def archive_source(source_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("imports", "delete"))):
    await service.archive_source(db, await service.get_source(db, source_id), user)


# --- Import jobs ------------------------------------------------------------------------------

def _job_query(q: str | None, status: list[str] | None, entity_type: list[str] | None,
               data_source_id: uuid.UUID | None, *, skip: set[str] = frozenset()):
    stmt = select(ImportJob).where(ImportJob.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [ImportJob.filename])
    if "status" not in skip:
        stmt = in_filter(stmt, ImportJob.status, status)
    if "entity_type" not in skip:
        stmt = in_filter(stmt, ImportJob.entity_type, entity_type)
    if data_source_id:
        stmt = stmt.where(ImportJob.data_source_id == data_source_id)
    return stmt


@router.get("/imports", response_model=Page[ImportJobOut])
async def list_imports(
    db: DB,
    params: ListParams = Depends(),
    status: list[str] | None = Query(None),
    entity_type: list[str] | None = Query(None),
    data_source_id: uuid.UUID | None = None,
    _: CurrentUser = Depends(require("imports", "view")),
):
    stmt = apply_sort(_job_query(params.q, status, entity_type, data_source_id), params.sort, {
        "created_at": ImportJob.created_at, "filename": ImportJob.filename, "status": ImportJob.status,
        "row_count": ImportJob.row_count, "committed_at": ImportJob.committed_at,
    }, ImportJob.created_at.desc())
    items, total = await paginate(db, stmt, params)
    names = dict((await db.execute(
        select(DataSource.id, DataSource.provider).where(DataSource.id.in_(list({j.data_source_id for j in items if j.data_source_id})))
    )).all()) if items else {}
    out = [ImportJobOut.model_validate(j).model_copy(update={"data_source_name": names.get(j.data_source_id)}) for j in items]
    return Page[ImportJobOut](items=out, total=total, page=params.page, page_size=params.page_size)


@router.get("/imports/facets", response_model=ImportFacets)
async def import_facets(
    db: DB,
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    entity_type: list[str] | None = Query(None),
    data_source_id: uuid.UUID | None = None,
    _: CurrentUser = Depends(require("imports", "view")),
):
    return ImportFacets(
        status=await facet_counts(db, _job_query(q, status, entity_type, data_source_id, skip={"status"}), ImportJob.status),
        entity_type=await facet_counts(db, _job_query(q, status, entity_type, data_source_id, skip={"entity_type"}),
                                       ImportJob.entity_type),
    )


@router.get("/imports/meta")
async def imports_meta(_: CurrentUser = Depends(require("imports", "view"))):
    return {"entity_types": ENTITY_TYPES, "statuses": JOB_STATUSES, "row_statuses": ROW_STATUSES,
            "max_rows": service.MAX_ROWS}


@router.get("/imports/fields", response_model=list[TargetField])
async def target_fields(entity_type: Literal["property", "person", "organization"],
                        _: CurrentUser = Depends(require("imports", "view"))):
    return service.target_fields(entity_type)


@router.post("/imports", response_model=ImportJobDetail, status_code=201)
async def upload(
    db: DB,
    file: UploadFile = File(...),
    entity_type: str = Form(...),
    data_source_id: uuid.UUID = Form(...),
    user: CurrentUser = Depends(require("imports", "create")),
):
    job = await service.upload(db, file=file, entity_type=entity_type, data_source_id=data_source_id, actor=user)
    return await service.job_detail(db, job)


@router.get("/imports/{job_id}", response_model=ImportJobDetail)
async def get_import(job_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("imports", "view"))):
    return await service.job_detail(db, await service.get_job(db, job_id))


@router.put("/imports/{job_id}/mapping", response_model=ImportJobDetail)
async def set_mapping(job_id: uuid.UUID, body: MappingIn, db: DB, user: CurrentUser = Depends(require("imports", "create"))):
    job = await service.set_mapping(db, await service.get_job(db, job_id), body.column_mapping, user)
    return await service.job_detail(db, job)


@router.post("/imports/{job_id}/validate", response_model=ImportJobDetail)
async def validate(job_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("imports", "create"))):
    job = await service.validate(db, await service.get_job(db, job_id), user)
    return await service.job_detail(db, job)


@router.get("/imports/{job_id}/rows", response_model=Page[ImportRowOut])
async def list_rows(
    job_id: uuid.UUID,
    db: DB,
    params: ListParams = Depends(),
    status: list[str] | None = Query(None),
    _: CurrentUser = Depends(require("imports", "view")),
):
    await service.get_job(db, job_id)
    stmt = select(ImportRow).where(ImportRow.job_id == job_id)
    stmt = in_filter(stmt, ImportRow.status, status)
    if params.q:
        stmt = stmt.where(cast(ImportRow.raw, Text).ilike(f"%{params.q}%"))
    stmt = apply_sort(stmt, params.sort, {"row_number": ImportRow.row_number, "status": ImportRow.status},
                      ImportRow.row_number.asc())
    items, total = await paginate(db, stmt, params)
    return Page[ImportRowOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/imports/{job_id}/row-facets")
async def row_facets(job_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("imports", "view"))) -> dict[str, int]:
    await service.get_job(db, job_id)
    return await facet_counts(db, select(ImportRow).where(ImportRow.job_id == job_id), ImportRow.status)


@router.post("/imports/{job_id}/commit", response_model=ImportJobDetail)
async def commit(job_id: uuid.UUID, body: CommitIn, db: DB, user: CurrentUser = Depends(require("imports", "create"))):
    job = await service.get_job(db, job_id)
    module = ENTITY_MODULE[job.entity_type]
    if not user.can(module, "create") or (body.on_duplicate == "update" and not user.can(module, "edit")):
        raise HTTPException(403, f"Missing permission {module}:{'edit' if body.on_duplicate == 'update' else 'create'}")
    job = await service.commit(db, job, body, user)
    return await service.job_detail(db, job)


@router.post("/imports/{job_id}/rollback", response_model=ImportJobDetail)
async def rollback(job_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("imports", "edit"))):
    job = await service.get_job(db, job_id)
    module = ENTITY_MODULE[job.entity_type]
    if not user.can(module, "edit"):
        raise HTTPException(403, f"Missing permission {module}:edit")
    job = await service.rollback(db, job, user)
    return await service.job_detail(db, job)


# --- Data quality -----------------------------------------------------------------------------

@router.get("/data-quality/summary", response_model=QualitySummary, tags=["data-quality"])
async def dq_summary(db: DB, _: CurrentUser = Depends(require("properties", "view"))):
    return await quality.summary(db)


@router.get("/data-quality/backlog", response_model=Page[BacklogItem], tags=["data-quality"])
async def dq_backlog(
    db: DB,
    params: ListParams = Depends(),
    field: list[str] | None = Query(None),
    source: str | None = Query(None, max_length=200),
    ai_derived: bool | None = None,
    _: CurrentUser = Depends(require("properties", "view")),
):
    items, total = await quality.backlog(db, params, field, source, ai_derived)
    return Page[BacklogItem](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/data-quality/backlog/facets", response_model=BacklogFacets, tags=["data-quality"])
async def dq_backlog_facets(
    db: DB,
    params: ListParams = Depends(),
    field: list[str] | None = Query(None),
    source: str | None = Query(None, max_length=200),
    ai_derived: bool | None = None,
    _: CurrentUser = Depends(require("properties", "view")),
):
    return await quality.backlog_facets(db, params, field, source, ai_derived)


@router.get("/data-quality/stale", response_model=Page[StaleItem], tags=["data-quality"])
async def dq_stale(
    db: DB,
    params: ListParams = Depends(),
    field: list[str] | None = Query(None),
    _: CurrentUser = Depends(require("properties", "view")),
):
    items, total = await quality.stale(db, params, field)
    return Page[StaleItem](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/data-quality/duplicates", response_model=Page[DuplicateGroup], tags=["data-quality"])
async def dq_duplicates(db: DB, params: ListParams = Depends(), _: CurrentUser = Depends(require("properties", "view"))):
    items, total = await quality.duplicates(db, params)
    return Page[DuplicateGroup](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/data-quality/thresholds", response_model=list[Threshold], tags=["data-quality"])
async def dq_thresholds(db: DB, _: CurrentUser = Depends(require("properties", "view"))):
    return await quality.list_thresholds(db)


@router.put("/data-quality/thresholds", response_model=list[Threshold], tags=["data-quality"])
async def dq_set_thresholds(body: ThresholdsIn, db: DB, user: CurrentUser = Depends(require("properties", "approve"))):
    return await quality.set_thresholds(db, body.thresholds, user)


# --- Core data export (open format) -----------------------------------------------------------

def _export_target(entity: str):
    if entity == "properties":
        from app.modules.properties.models import Property

        return Property, "properties", "property"
    if entity == "tasks":
        from app.modules.tasks.models import Task

        return Task, "tasks", "task"
    try:
        from app.modules.contacts import models
    except ImportError:
        raise HTTPException(422, "Contacts module unavailable")
    return (models.Person, "contacts", "person") if entity == "people" else (models.Organization, "contacts", "organization")


def _cell(value) -> str:
    value = to_jsonable(value)
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(value)
    return str(value)


@router.get("/exports/core", tags=["exports"])
async def export_core(
    db: DB,
    user: Authed,
    entity: Literal["properties", "people", "organizations", "tasks"],
    include_archived: bool = False,
):
    model, module, entity_type = _export_target(entity)
    if not user.can(module, "export"):
        raise HTTPException(403, f"Missing permission {module}:export")
    columns = [c for c in model.__table__.columns if not isinstance(c.type, Geometry)]
    stmt = select(model)
    if not include_archived:
        stmt = stmt.where(model.deleted_at.is_(None))
    rows = list(await db.scalars(stmt.order_by(model.created_at)))

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([c.name for c in columns])
    for r in rows:
        writer.writerow([_cell(getattr(r, c.key, None)) for c in columns])
    await audit.record(db, actor=user, action=f"{entity_type}.exported", entity_type=entity_type,
                       summary=f"Core export · {len(rows)} rows", changes={"include_archived": include_archived},
                       ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={entity}.csv"},
    )
