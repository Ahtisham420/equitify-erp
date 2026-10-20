import uuid
from datetime import date, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse

from app.common.query import ListParams, Page, apply_sort, paginate
from app.core.deps import DB, CurrentUser, require
from app.core.security import utcnow
from app.modules.documents import ai, service
from app.modules.documents.models import (
    ACCESS_ACTIONS,
    DOC_CLASSES,
    EXTRACTION_STATUSES,
    LINK_TYPES,
    VALUE_STATUSES,
    AICall,
    Document,
    ExtractedValue,
)
from app.modules.documents.schemas import (
    AccessLogOut,
    AICallOut,
    ConfirmIn,
    DocumentFacets,
    DocumentListItem,
    DocumentOut,
    DocumentUpdate,
    DraftIn,
    DraftOut,
    EditIn,
    ExtractedValueOut,
    ExtractIn,
    JobOut,
    LinkIn,
    LinkOut,
    ManualValueIn,
    RejectIn,
    SearchHit,
    SignedUrlOut,
    SummarizeIn,
    SummaryOut,
    TextIn,
    ValueFacets,
)
from app.modules.documents.service import DocFilters, ValueFilters

router = APIRouter(prefix="/documents", tags=["documents"])

SORTS = {
    "title": Document.title, "doc_class": Document.doc_class, "size_bytes": Document.size_bytes,
    "created_at": Document.created_at, "updated_at": Document.updated_at, "version": Document.version,
    "retention_until": Document.retention_until, "filename": Document.filename,
}
VALUE_SORTS = {
    "created_at": ExtractedValue.created_at, "confidence": ExtractedValue.confidence, "field": ExtractedValue.field,
    "status": ExtractedValue.status, "reviewed_at": ExtractedValue.reviewed_at, "page": ExtractedValue.page,
}


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def filters(
    q: str | None = Query(None, max_length=200),
    doc_class: list[str] | None = Query(None),
    sensitivity: list[str] | None = Query(None),
    linked_type: list[str] | None = Query(None),
    extraction_status: list[str] | None = Query(None),
    entity_type: str | None = Query(None, max_length=40),
    entity_id: uuid.UUID | None = None,
    legal_hold: bool | None = None,
    uploaded_by_id: uuid.UUID | None = None,
    created_from: date | None = None,
    created_to: date | None = None,
) -> DocFilters:
    return DocFilters(**locals())


def value_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    field: list[str] | None = Query(None),
    document_id: uuid.UUID | None = None,
    target_entity_type: list[str] | None = Query(None),
    target_entity_id: uuid.UUID | None = None,
    origin: list[str] | None = Query(None),
    min_confidence: float | None = Query(None, ge=0, le=1),
    max_confidence: float | None = Query(None, ge=0, le=1),
) -> ValueFilters:
    return ValueFilters(**locals())


# --- Library -------------------------------------------------------------------------------------

@router.get("", response_model=Page[DocumentListItem])
async def list_documents(
    db: DB,
    params: ListParams = Depends(),
    f: DocFilters = Depends(filters),
    user: CurrentUser = Depends(require("documents", "view")),
):
    stmt = apply_sort(service.build_query(f, user), params.sort, SORTS, Document.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[DocumentListItem](items=await service.to_list_items(db, items, user), total=total,
                                  page=params.page, page_size=params.page_size)


@router.get("/facets", response_model=DocumentFacets)
async def document_facets(db: DB, f: DocFilters = Depends(filters),
                          user: CurrentUser = Depends(require("documents", "view"))):
    return await service.facets(db, f, user)


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("documents", "view"))):
    return {
        "doc_classes": DOC_CLASSES, "link_types": LINK_TYPES, "extraction_statuses": EXTRACTION_STATUSES,
        "value_statuses": VALUE_STATUSES, "access_actions": ACCESS_ACTIONS,
        "max_upload_mb": service.MAX_UPLOAD_BYTES // (1024 * 1024), "inline_types": sorted(service.INLINE_MIME),
        "schemas": service.all_schemas(), "property_fields": sorted(service.PROPERTY_APPLICABLE),
        "ai": ai.provider_status(),
    }


@router.get("/search", response_model=list[SearchHit])
async def search(db: DB, q: str = Query(..., min_length=1, max_length=300), limit: int = Query(20, ge=1, le=50),
                 user: CurrentUser = Depends(require("documents", "view"))):
    return await service.search(db, q, user, limit)


@router.get("/download", include_in_schema=False)
async def download(request: Request, db: DB, token: str = Query(..., max_length=4000)):
    """Signed-URL access: the token is the credential (no bearer header), so browsers can open it directly."""
    d, path, inline = await service.resolve_download(db, token, _ip(request))
    return FileResponse(
        path, media_type=d.mime_type, filename=d.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.post("/summarize", response_model=SummaryOut)
async def summarize(body: SummarizeIn, db: DB, user: CurrentUser = Depends(require("documents", "view"))):
    return await service.summarize(db, body, user)


@router.post("/draft", response_model=DraftOut)
async def draft(body: DraftIn, db: DB, user: CurrentUser = Depends(require("documents", "view"))):
    return await service.draft(db, body, user)


@router.get("/ai-calls", response_model=Page[AICallOut])
async def ai_calls(
    db: DB,
    params: ListParams = Depends(),
    document_id: uuid.UUID | None = None,
    purpose: list[str] | None = Query(None),
    user: CurrentUser = Depends(require("documents", "view")),
):
    if document_id:
        await service.get(db, document_id, user)
    elif not user.can("audit", "view"):
        raise HTTPException(403, "Viewing all AI calls requires audit:view")
    stmt = apply_sort(service.ai_calls_query(document_id, purpose), params.sort,
                      {"created_at": AICall.created_at, "latency_ms": AICall.latency_ms}, AICall.created_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[AICallOut](items=items, total=total, page=params.page, page_size=params.page_size)


# --- Verification queue --------------------------------------------------------------------------

@router.get("/extracted-values", response_model=Page[ExtractedValueOut])
async def list_values(
    db: DB,
    params: ListParams = Depends(),
    f: ValueFilters = Depends(value_filters),
    user: CurrentUser = Depends(require("documents", "view")),
):
    stmt = apply_sort(service.value_query(f, user), params.sort, VALUE_SORTS, ExtractedValue.created_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[ExtractedValueOut](items=await service.values_out(db, items), total=total, page=params.page,
                                   page_size=params.page_size)


@router.get("/extracted-values/facets", response_model=ValueFacets)
async def value_facets(db: DB, f: ValueFilters = Depends(value_filters),
                       user: CurrentUser = Depends(require("documents", "view"))):
    return await service.value_facets(db, f, user)


@router.post("/extracted-values/{value_id}/confirm", response_model=ExtractedValueOut)
async def confirm_value(value_id: uuid.UUID, body: ConfirmIn, db: DB,
                        user: CurrentUser = Depends(require("documents", "edit"))):
    ev, d = await service.get_value(db, value_id, user)
    ev = await service.confirm_value(db, ev, d, user, accept_conflict=body.accept_conflict, note=body.note)
    return (await service.values_out(db, [ev]))[0]


@router.post("/extracted-values/{value_id}/edit", response_model=ExtractedValueOut)
async def edit_value(value_id: uuid.UUID, body: EditIn, db: DB,
                     user: CurrentUser = Depends(require("documents", "edit"))):
    ev, d = await service.get_value(db, value_id, user)
    ev = await service.confirm_value(db, ev, d, user, accept_conflict=body.accept_conflict, note=body.note,
                                     edited=True, new_value=body.value)
    return (await service.values_out(db, [ev]))[0]


@router.post("/extracted-values/{value_id}/reject", response_model=ExtractedValueOut)
async def reject_value(value_id: uuid.UUID, body: RejectIn, db: DB,
                       user: CurrentUser = Depends(require("documents", "edit"))):
    ev, d = await service.get_value(db, value_id, user)
    ev = await service.reject_value(db, ev, d, user, body.note)
    return (await service.values_out(db, [ev]))[0]


# --- Upload --------------------------------------------------------------------------------------

@router.post("", response_model=DocumentOut, status_code=201)
async def upload(
    db: DB,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str | None = Form(None, max_length=300),
    doc_class: str | None = Form(None),
    description: str | None = Form(None),
    is_sensitive: bool = Form(False),
    retention_until: date | None = Form(None),
    tags: str | None = Form(None),
    entity_type: str | None = Form(None),
    entity_id: uuid.UUID | None = Form(None),
    auto_extract: bool = Form(True),
    user: CurrentUser = Depends(require("documents", "create")),
):
    d, job = await service.upload(
        db, file=file, actor=user, title=title, doc_class=doc_class, description=description,
        is_sensitive=is_sensitive, retention_until=retention_until, tags=tags, entity_type=entity_type,
        entity_id=entity_id, auto_extract=auto_extract,
    )
    if job:
        background.add_task(service.run_extraction, job.id)
    return await service.to_out(db, d, user)


# --- Single document -----------------------------------------------------------------------------

@router.get("/{document_id}", response_model=DocumentOut)
async def get_document(document_id: uuid.UUID, request: Request, db: DB,
                       user: CurrentUser = Depends(require("documents", "view"))):
    d = await service.get(db, document_id, user)
    await service.log_access(db, d, action="view", actor=user, ip=_ip(request), throttle=True)
    await db.commit()
    return await service.to_out(db, d, user)


@router.patch("/{document_id}", response_model=DocumentOut)
async def update_document(document_id: uuid.UUID, body: DocumentUpdate, db: DB,
                          user: CurrentUser = Depends(require("documents", "edit"))):
    d = await service.update_document(db, await service.get(db, document_id, user), body, user)
    return await service.to_out(db, d, user)


@router.delete("/{document_id}", status_code=204)
async def delete_document(document_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("documents", "delete"))):
    await service.delete_document(db, await service.get(db, document_id, user), user)


@router.get("/{document_id}/versions", response_model=list[DocumentListItem])
async def list_versions(document_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("documents", "view"))):
    return await service.versions(db, await service.get(db, document_id, user), user)


@router.post("/{document_id}/versions", response_model=DocumentOut, status_code=201)
async def upload_version(
    document_id: uuid.UUID,
    db: DB,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    auto_extract: bool = Form(True),
    user: CurrentUser = Depends(require("documents", "edit")),
):
    base = await service.get(db, document_id, user)
    d, job = await service.new_version(db, base, file=file, actor=user, auto_extract=auto_extract)
    if job:
        background.add_task(service.run_extraction, job.id)
    return await service.to_out(db, d, user)


@router.put("/{document_id}/text", response_model=DocumentOut)
async def set_text(document_id: uuid.UUID, body: TextIn, db: DB,
                   user: CurrentUser = Depends(require("documents", "edit"))):
    d = await service.set_text(db, await service.get(db, document_id, user), body.text, user)
    return await service.to_out(db, d, user)


@router.post("/{document_id}/links", response_model=LinkOut, status_code=201)
async def add_link(document_id: uuid.UUID, body: LinkIn, db: DB,
                   user: CurrentUser = Depends(require("documents", "edit"))):
    d = await service.get(db, document_id, user)
    lnk = await service.link(db, d.id, body.entity_type, body.entity_id, user)
    await db.commit()
    return LinkOut.model_validate(lnk)


@router.delete("/{document_id}/links/{link_id}", status_code=204)
async def remove_link(document_id: uuid.UUID, link_id: uuid.UUID, db: DB,
                      user: CurrentUser = Depends(require("documents", "edit"))):
    await service.unlink(db, await service.get(db, document_id, user), link_id, user)


@router.get("/{document_id}/signed-url", response_model=SignedUrlOut)
async def get_signed_url(document_id: uuid.UUID, db: DB, inline: bool = False, minutes: int = Query(10, ge=1, le=60),
                         user: CurrentUser = Depends(require("documents", "view"))):
    d = await service.get(db, document_id, user)
    inline = inline and service.can_inline(d.mime_type)
    return SignedUrlOut(url=service.signed_url(d.id, minutes, user_id=user.id, inline=inline),
                        expires_at=utcnow() + timedelta(minutes=minutes), inline=inline)


@router.get("/{document_id}/access-log", response_model=list[AccessLogOut])
async def access_log(document_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("documents", "view"))):
    return await service.access_log(db, await service.get(db, document_id, user))


@router.post("/{document_id}/extract", response_model=JobOut, status_code=202)
async def extract(document_id: uuid.UUID, body: ExtractIn, db: DB, background: BackgroundTasks,
                  user: CurrentUser = Depends(require("documents", "edit"))):
    job, created = await service.request_extraction(db, await service.get(db, document_id, user), body, user)
    if created:
        background.add_task(service.run_extraction, job.id)
    return job


@router.get("/{document_id}/jobs", response_model=list[JobOut])
async def list_jobs(document_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("documents", "view"))):
    return await service.list_jobs(db, await service.get(db, document_id, user))


@router.post("/{document_id}/values", response_model=ExtractedValueOut, status_code=201)
async def add_value(document_id: uuid.UUID, body: ManualValueIn, db: DB,
                    user: CurrentUser = Depends(require("documents", "edit"))):
    ev = await service.add_manual_value(db, await service.get(db, document_id, user), body, user)
    return (await service.values_out(db, [ev]))[0]
