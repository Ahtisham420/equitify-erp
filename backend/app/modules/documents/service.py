import hashlib
import importlib
import logging
import mimetypes
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import jwt
from fastapi import HTTPException, UploadFile, status
from sqlalchemy import Date, Select, cast, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.audit import to_jsonable
from app.common.query import apply_search, facet_counts, in_filter
from app.core import events
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.auth.permissions import allows
from app.modules.documents import ai
from app.modules.documents.models import (
    DOC_CLASSES,
    AICall,
    Document,
    DocumentAccessLog,
    DocumentLink,
    ExtractedValue,
    ExtractionJob,
)
from app.modules.documents.schemas import (
    AccessLogOut,
    Citation,
    DocumentFacets,
    DocumentListItem,
    DocumentOut,
    DocumentRef,
    DocumentUpdate,
    DraftIn,
    DraftOut,
    DraftSource,
    ExtractedValueOut,
    ExtractIn,
    LinkOut,
    ManualValueIn,
    SearchHit,
    SummarizeIn,
    SummaryOut,
    ValueFacets,
)

log = logging.getLogger("equitify.documents")

ENTITY = "document"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
CHUNK = 1024 * 1024
MAX_TEXT_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARS = 2_000_000
DETAIL_TEXT_CHARS = 200_000
VIEW_LOG_THROTTLE = timedelta(minutes=5)
TEXT_MIME = {"application/json", "application/xml"}
# Only these types are ever served inline; everything else is forced to download.
INLINE_MIME = {
    "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp",
    "text/plain", "text/markdown",
}

# Root of a version chain: links, holds and retention apply to the logical document.
ROOT = func.coalesce(Document.parent_document_id, Document.id)

# --- Extraction schemas --------------------------------------------------------------------------

def _f(field: str, type_: str = "text") -> ai.SchemaField:
    return {"field": field, "label": field.replace("_", " ").capitalize(), "type": type_}


_PURCHASE = [_f("purchase_price", "money"), _f("earnest_money", "money"), _f("feasibility_days", "number"),
             _f("closing_days", "number"), _f("effective_on", "date"), _f("closing_on", "date"),
             _f("buyer_name"), _f("seller_name")]
_LEASE = [_f("tenant_name"), _f("landlord_name"), _f("lease_type"), _f("commencement_on", "date"),
          _f("expiration_on", "date"), _f("rentable_sf", "number"), _f("base_rent_annual", "money"),
          _f("rent_psf", "money"), _f("renewal_options"), _f("security_deposit", "money"), _f("guarantor")]
_DEBT = [_f("lender_name"), _f("loan_amount", "money"), _f("interest_rate", "percent"), _f("maturity_on", "date"),
         _f("amortization_months", "number"), _f("io_months", "number"), _f("prepayment"), _f("recourse")]

CLASS_SCHEMAS: dict[str, list[ai.SchemaField]] = {
    "lease": _LEASE,
    "amendment": [_f("amendment_on", "date"), _f("expiration_on", "date"), _f("base_rent_annual", "money"),
                  _f("rentable_sf", "number"), _f("summary_of_changes")],
    "estoppel": [_f("tenant_name"), _f("commencement_on", "date"), _f("expiration_on", "date"),
                 _f("base_rent_monthly", "money"), _f("security_deposit", "money"), _f("defaults_claimed")],
    "snda": [_f("lender_name"), _f("tenant_name"), _f("effective_on", "date")],
    "acquisition": _PURCHASE,
    "contract": _PURCHASE,
    "loi": _PURCHASE,
    "debt": _DEBT,
    "loan_agreement": _DEBT,
    "tax": [_f("tax_year", "number"), _f("parcel_apn"), _f("assessed_value", "money"), _f("tax_amount", "money"),
            _f("due_on", "date")],
    "insurance": [_f("carrier"), _f("policy_number"), _f("coverage_amount", "money"), _f("effective_on", "date"),
                  _f("expires_on", "date"), _f("named_insured")],
    "closing": [_f("purchase_price", "money"), _f("closing_on", "date"), _f("buyer_name"), _f("seller_name")],
    "settlement_statement": [_f("purchase_price", "money"), _f("closing_on", "date"), _f("prorations"),
                             _f("cash_to_close", "money")],
    "survey": [_f("legal_description"), _f("parcel_apn"), _f("land_area_acres", "number"), _f("flood_zone"),
               _f("encroachments")],
    "title": [_f("legal_description"), _f("parcel_apn"), _f("vested_owner"), _f("exceptions"),
              _f("effective_on", "date")],
    "environmental": [_f("report_date", "date"), _f("recognized_conditions"), _f("recommendations")],
    "pca": [_f("report_date", "date"), _f("immediate_repairs_cost", "money"), _f("reserve_recommendation", "money")],
    "appraisal": [_f("appraised_value", "money"), _f("valuation_date", "date"), _f("cap_rate", "percent"),
                  _f("noi", "money")],
    "bov": [_f("value_low", "money"), _f("value_high", "money"), _f("cap_rate", "percent"), _f("noi", "money")],
    "entity": [_f("entity_name"), _f("entity_type"), _f("formation_state"), _f("signatories")],
    "correspondence": [_f("sender"), _f("recipient"), _f("sent_on", "date"), _f("subject")],
    "other": [],
}

# Property fields a confirmed value may be applied to (through provenance, never directly by AI).
PROPERTY_FIELDS: list[ai.SchemaField] = [
    _f("building_area_sf", "number"), _f("land_area_acres", "number"), _f("year_built", "number"),
    _f("year_renovated", "number"), _f("parking_spaces", "number"), _f("construction_class"),
    _f("asking_price", "money"), _f("last_sale_price", "money"), _f("last_sale_date", "date"),
    _f("occupancy_pct", "percent"), _f("wale_years", "number"), _f("noi", "money"), _f("zoning"),
    _f("future_land_use"), _f("flood_zone"), _f("traffic_count", "number"), _f("property_type"),
    _f("property_subtype"), _f("county"), _f("postal_code"),
]
PROPERTY_APPLICABLE = {f["field"] for f in PROPERTY_FIELDS}


def extraction_schema(doc_class: str, target_type: str | None, fields: list[str] | None = None) -> list[ai.SchemaField]:
    schema = list(CLASS_SCHEMAS.get(doc_class, []))
    if target_type == "property":
        schema += [f for f in PROPERTY_FIELDS if f["field"] not in {s["field"] for s in schema}]
    if fields:
        known = {s["field"]: s for s in schema + PROPERTY_FIELDS}
        schema = [known.get(name, _f(name)) for name in fields]
    return schema


def field_type(doc_class: str, field: str) -> str:
    for s in CLASS_SCHEMAS.get(doc_class, []) + PROPERTY_FIELDS:
        if s["field"] == field:
            return s.get("type", "text")
    return "text"


def all_schemas() -> dict[str, list[ai.SchemaField]]:
    return {**CLASS_SCHEMAS, "_property": PROPERTY_FIELDS}


# --- Polymorphic record helpers ------------------------------------------------------------------

# entity_type -> (module path, model class, label getter). Missing modules are tolerated.
TARGETS: dict[str, tuple[str, str, Any]] = {
    "property": ("app.modules.properties.models", "Property", lambda r: r.name or r.address_line),
    "person": ("app.modules.contacts.models", "Person", lambda r: r.full_name),
    "organization": ("app.modules.contacts.models", "Organization", lambda r: r.name),
    "opportunity": ("app.modules.pipeline.models", "Opportunity", lambda r: r.title),
    "lease": ("app.modules.leases.models", "Lease", lambda r: getattr(r, "tenant_name", None)),
    "loan": ("app.modules.debt.models", "Loan", lambda r: getattr(r, "lender_name", None)),
    "contract": ("app.modules.contracts.models", "Contract", lambda r: getattr(r, "title", None)),
    "asset": ("app.modules.assets.models", "Asset", lambda r: None),
    "uw_model": ("app.modules.underwriting.models", "UwModel", lambda r: getattr(r, "name", None)),
}
# Linked records are only shown to users who can view the owning module.
LINK_MODULES = {
    "property": "properties", "person": "contacts", "organization": "contacts", "opportunity": "pipeline",
    "offer": "offers", "contract": "contracts", "closing": "closing", "asset": "assets", "lease": "leases",
    "loan": "debt", "disposition": "dispositions", "work_order": "maintenance", "vendor": "operations",
    "capital_project": "operations", "insurance_policy": "operations", "capital_partner": "investors",
    "listing": "brokerage", "brokerage_deal": "brokerage", "uw_model": "underwriting",
}


def _target_model(entity_type: str | None):
    spec = TARGETS.get(entity_type or "")
    if not spec:
        return None, None
    try:
        return getattr(importlib.import_module(spec[0]), spec[1]), spec[2]
    except (ImportError, AttributeError):
        return None, None


async def _load_targets(db: AsyncSession, pairs: set[tuple[str, uuid.UUID]]) -> dict[tuple[str, uuid.UUID], Any]:
    by_type: dict[str, set[uuid.UUID]] = {}
    for t, i in pairs:
        by_type.setdefault(t, set()).add(i)
    out: dict[tuple[str, uuid.UUID], Any] = {}
    for t, ids in by_type.items():
        model, _ = _target_model(t)
        if model is None:
            continue
        try:
            for row in await db.scalars(select(model).where(model.id.in_(ids))):
                out[(t, row.id)] = row
        except Exception:  # noqa: BLE001 — a missing table in another module must not break documents
            log.warning("documents: could not load %s targets", t)
    return out


async def _labels(db: AsyncSession, pairs: set[tuple[str, uuid.UUID]]) -> dict[tuple[str, uuid.UUID], str | None]:
    rows = await _load_targets(db, pairs)
    out: dict[tuple[str, uuid.UUID], str | None] = {}
    for key, row in rows.items():
        _, getter = _target_model(key[0])
        try:
            out[key] = getter(row) if getter else None
        except Exception:  # noqa: BLE001
            out[key] = None
    return out


async def _user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())


def _link_visible(user: CurrentUser, entity_type: str) -> bool:
    module = LINK_MODULES.get(entity_type)
    return module is None or user.can(module, "view")


# --- Storage -------------------------------------------------------------------------------------

def storage_root() -> Path:
    return Path(settings.STORAGE_DIR).resolve()


def file_path(storage_key: str) -> Path:
    root = storage_root()
    path = (root / storage_key).resolve()
    if root not in path.parents:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return path


def _guess_mime(file: UploadFile) -> str:
    ctype = (file.content_type or "").split(";")[0].strip().lower()
    if not ctype or ctype == "application/octet-stream":
        ctype = mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    return ctype[:120]


async def _store(file: UploadFile) -> tuple[str, int, str]:
    """Stream the upload to private storage (year/month folders) while hashing. Returns (key, size, sha256)."""
    now = utcnow()
    ext = Path(file.filename or "").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,9}", ext or ""):
        ext = ""
    key = f"documents/{now:%Y}/{now:%m}/{uuid.uuid4().hex}{ext}"
    path = storage_root() / key
    path.parent.mkdir(parents=True, exist_ok=True)
    digest, size = hashlib.sha256(), 0
    try:
        with open(path, "wb") as out:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                                        f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit")
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "File is empty")
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return key, size, digest.hexdigest()


def _read_text(key: str, mime: str, size: int) -> str | None:
    if not (mime.startswith("text/") or mime in TEXT_MIME) or size > MAX_TEXT_BYTES:
        return None
    try:
        return file_path(key).read_bytes().decode("utf-8", errors="replace")[:MAX_TEXT_CHARS]
    except OSError:
        return None


# --- Queries -------------------------------------------------------------------------------------

@dataclass
class DocFilters:
    q: str | None = None
    doc_class: list[str] | None = None
    sensitivity: list[str] | None = None
    linked_type: list[str] | None = None
    extraction_status: list[str] | None = None
    entity_type: str | None = None
    entity_id: uuid.UUID | None = None
    legal_hold: bool | None = None
    uploaded_by_id: uuid.UUID | None = None
    created_from: date | None = None
    created_to: date | None = None


def _linked_roots(entity_types: list[str] | None = None, entity_id: uuid.UUID | None = None):
    stmt = select(DocumentLink.document_id)
    if entity_types:
        stmt = stmt.where(DocumentLink.entity_type.in_(entity_types))
    if entity_id:
        stmt = stmt.where(DocumentLink.entity_id == entity_id)
    return stmt


def visible(stmt: Select, user: CurrentUser) -> Select:
    if not user.can("documents", "view_sensitive"):
        stmt = stmt.where(Document.is_sensitive.is_(False))
    return stmt


def build_query(f: DocFilters, user: CurrentUser, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Document).where(Document.deleted_at.is_(None), Document.is_latest.is_(True))
    stmt = visible(stmt, user)
    stmt = apply_search(stmt, f.q, [Document.title, Document.filename, Document.description])
    if "doc_class" not in skip:
        stmt = in_filter(stmt, Document.doc_class, f.doc_class)
    if "sensitivity" not in skip and f.sensitivity:
        wanted = {v == "sensitive" for v in f.sensitivity}
        if len(wanted) == 1:
            stmt = stmt.where(Document.is_sensitive.is_(wanted.pop()))
    if "linked_type" not in skip and f.linked_type:
        stmt = stmt.where(ROOT.in_(_linked_roots(f.linked_type)))
    if "extraction_status" not in skip:
        stmt = in_filter(stmt, Document.extraction_status, f.extraction_status)
    if f.entity_type and f.entity_id:
        stmt = stmt.where(ROOT.in_(_linked_roots([f.entity_type], f.entity_id)))
    if f.legal_hold is not None:
        stmt = stmt.where(Document.legal_hold.is_(f.legal_hold))
    if f.uploaded_by_id:
        stmt = stmt.where(Document.uploaded_by_id == f.uploaded_by_id)
    if f.created_from:
        stmt = stmt.where(cast(Document.created_at, Date) >= f.created_from)
    if f.created_to:
        stmt = stmt.where(cast(Document.created_at, Date) <= f.created_to)
    return stmt


async def facets(db: AsyncSession, f: DocFilters, user: CurrentUser) -> DocumentFacets:
    sens = await facet_counts(db, build_query(f, user, skip={"sensitivity"}), Document.is_sensitive)
    sub = build_query(f, user, skip={"linked_type"}).order_by(None).subquery()
    linked = await db.execute(
        select(DocumentLink.entity_type, func.count(func.distinct(sub.c.id)))
        .join(sub, DocumentLink.document_id == func.coalesce(sub.c.parent_document_id, sub.c.id))
        .group_by(DocumentLink.entity_type)
    )
    return DocumentFacets(
        doc_class=await facet_counts(db, build_query(f, user, skip={"doc_class"}), Document.doc_class),
        sensitivity={"sensitive": sens.get("True", 0), "standard": sens.get("False", 0)},
        linked_type={str(k): int(v) for k, v in linked.all() if k},
        extraction_status=await facet_counts(db, build_query(f, user, skip={"extraction_status"}),
                                             Document.extraction_status),
    )


async def get(db: AsyncSession, document_id: uuid.UUID, user: CurrentUser) -> Document:
    d = await db.get(Document, document_id)
    if not d or d.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    if d.is_sensitive and not user.can("documents", "view_sensitive"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This document is marked sensitive")
    return d


async def _chain(db: AsyncSession, d: Document, *, include_deleted: bool = False) -> list[Document]:
    stmt = select(Document).where(ROOT == d.root_id)
    if not include_deleted:
        stmt = stmt.where(Document.deleted_at.is_(None))
    return list(await db.scalars(stmt.order_by(Document.version.desc())))


async def _links_for(db: AsyncSession, roots: set[uuid.UUID], user: CurrentUser) -> dict[uuid.UUID, list[LinkOut]]:
    if not roots:
        return {}
    links = [l for l in await db.scalars(select(DocumentLink).where(DocumentLink.document_id.in_(roots))
                                          .order_by(DocumentLink.created_at))
             if _link_visible(user, l.entity_type)]
    labels = await _labels(db, {(l.entity_type, l.entity_id) for l in links})
    out: dict[uuid.UUID, list[LinkOut]] = {}
    for l in links:
        out.setdefault(l.document_id, []).append(
            LinkOut.model_validate(l).model_copy(update={"label": labels.get((l.entity_type, l.entity_id))})
        )
    return out


async def to_list_items(db: AsyncSession, docs: list[Document], user: CurrentUser) -> list[DocumentListItem]:
    if not docs:
        return []
    links = await _links_for(db, {d.root_id for d in docs}, user)
    names = await _user_names(db, {d.uploaded_by_id for d in docs})
    pending = dict((await db.execute(
        select(ExtractedValue.document_id, func.count())
        .where(ExtractedValue.document_id.in_([d.id for d in docs]), ExtractedValue.status == "pending",
               ExtractedValue.deleted_at.is_(None))
        .group_by(ExtractedValue.document_id)
    )).all())
    return [
        DocumentListItem.model_validate(d).model_copy(update={
            "uploaded_by_name": names.get(d.uploaded_by_id) if d.uploaded_by_id else None,
            "pending_values": int(pending.get(d.id, 0)),
            "links": links.get(d.root_id, []),
            "tags": d.tags or [],
        })
        for d in docs
    ]


def delete_block_reason(d: Document) -> str | None:
    if d.legal_hold:
        return "Document is on legal hold"
    if d.retention_until and d.retention_until > date.today():
        return f"Retention period runs until {d.retention_until.isoformat()}"
    return None


async def _duplicates(db: AsyncSession, d: Document, user: CurrentUser) -> list[DocumentRef]:
    stmt = visible(select(Document).where(Document.sha256 == d.sha256, Document.id != d.id,
                                          Document.deleted_at.is_(None)), user)
    return [DocumentRef.model_validate(x) for x in await db.scalars(stmt.order_by(Document.created_at).limit(5))]


async def to_out(db: AsyncSession, d: Document, user: CurrentUser) -> DocumentOut:
    item = (await to_list_items(db, [d], user))[0]
    reason = delete_block_reason(d)
    return DocumentOut(
        **item.model_dump(),
        description=d.description,
        classification_confidence=d.classification_confidence,
        sha256=d.sha256,
        parent_document_id=d.parent_document_id,
        is_latest=d.is_latest,
        has_text=bool(d.text_content),
        text_content=d.text_content[:DETAIL_TEXT_CHARS] if d.text_content else None,
        text_source=d.text_source,
        can_delete=reason is None and user.can("documents", "delete"),
        delete_blocked_reason=reason,
        duplicates=await _duplicates(db, d, user),
    )


# --- Access logging & signed URLs ----------------------------------------------------------------

async def log_access(db: AsyncSession, d: Document, *, action: str, actor: Any, ip: str | None,
                     throttle: bool = False) -> None:
    """Writes document_access_log + audit. Does not commit."""
    user_id = getattr(actor, "id", None)
    if throttle and user_id:
        recent = await db.scalar(select(DocumentAccessLog.id).where(
            DocumentAccessLog.document_id == d.id, DocumentAccessLog.user_id == user_id,
            DocumentAccessLog.action == action, DocumentAccessLog.occurred_at >= utcnow() - VIEW_LOG_THROTTLE,
        ).limit(1))
        if recent:
            return
    db.add(DocumentAccessLog(document_id=d.id, user_id=user_id, action=action, ip_address=ip))
    await audit.record(db, actor=actor, action=f"document.{action}", entity_type=ENTITY, entity_id=d.id,
                       summary=d.title, ip_address=ip)


def signed_url(document_id: uuid.UUID, minutes: int = 10, *, user_id: uuid.UUID | None = None,
               inline: bool = False) -> str:
    """Short-lived download link. The token is the credential, so browsers can open it directly."""
    now = utcnow()
    payload = {
        "purpose": "doc",
        "doc": str(document_id),
        "sub": str(user_id) if user_id else None,
        "disp": "inline" if inline else "attachment",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=minutes)).timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return f"{settings.API_PREFIX}/documents/download?token={token}"


def can_inline(mime: str) -> bool:
    return mime in INLINE_MIME


async def resolve_download(db: AsyncSession, token: str, ip: str | None) -> tuple[Document, Path, bool]:
    denied = HTTPException(status.HTTP_403_FORBIDDEN, "This link is invalid or has expired")
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise denied
    if payload.get("purpose") != "doc" or not payload.get("doc"):
        raise denied
    try:
        d = await db.get(Document, uuid.UUID(payload["doc"]))
    except ValueError:
        raise denied
    if not d or d.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")

    actor: Any = None
    if payload.get("sub"):
        user = await db.get(User, uuid.UUID(payload["sub"]))
        if not user or user.status != "active" or user.deleted_at:
            raise denied
        perms = user.role.permissions or {}
        if not allows(perms, "documents", "view") or (d.is_sensitive and not allows(perms, "documents", "view_sensitive")):
            raise denied
        actor = user

    inline = payload.get("disp") == "inline" and can_inline(d.mime_type)
    path = file_path(d.storage_key)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File is missing from storage")
    await log_access(db, d, action="preview" if inline else "download", actor=actor, ip=ip)
    await db.commit()
    return d, path, inline


# --- Mutations -----------------------------------------------------------------------------------

def _clean_tags(raw: list[str] | str | None) -> list[str]:
    if raw is None:
        return []
    items = raw.split(",") if isinstance(raw, str) else raw
    out: list[str] = []
    for t in (i.strip()[:60] for i in items):
        if t and t not in out:
            out.append(t)
    return out


def _check_class(doc_class: str | None) -> None:
    if doc_class is not None and doc_class not in DOC_CLASSES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown document class '{doc_class}'")


async def _queue_job(db: AsyncSession, d: Document, actor_id: uuid.UUID | None, *, target_type: str | None = None,
                     target_id: uuid.UUID | None = None, fields: list[str] | None = None) -> ExtractionJob:
    if not (target_type and target_id):
        links = list(await db.scalars(select(DocumentLink).where(DocumentLink.document_id == d.root_id)
                                      .order_by(DocumentLink.created_at)))
        pick = next((l for l in links if l.entity_type == "property"), links[0] if links else None)
        if pick:
            target_type, target_id = pick.entity_type, pick.entity_id
    job = ExtractionJob(document_id=d.id, status="queued", target_entity_type=target_type,
                        target_entity_id=target_id, fields=fields or [], created_by_id=actor_id,
                        updated_by_id=actor_id)
    db.add(job)
    d.extraction_status = "queued"
    await db.flush()
    return job


async def upload(
    db: AsyncSession,
    *,
    file: UploadFile,
    actor: CurrentUser,
    title: str | None = None,
    doc_class: str | None = None,
    description: str | None = None,
    is_sensitive: bool = False,
    retention_until: date | None = None,
    tags: str | None = None,
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    auto_extract: bool = True,
) -> tuple[Document, ExtractionJob | None]:
    _check_class(doc_class)
    if is_sensitive and not actor.can("documents", "view_sensitive"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Marking a document sensitive requires documents:view_sensitive")
    if bool(entity_type) != bool(entity_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "entity_type and entity_id must be sent together")
    filename = (Path(file.filename or "upload").name or "upload")[:300]
    mime = _guess_mime(file)
    key, size, sha = await _store(file)
    try:
        d = Document(
            title=(title or Path(filename).stem or filename)[:300],
            description=description,
            doc_class=doc_class or "other",
            classification_source="manual" if doc_class else "default",
            filename=filename, mime_type=mime, size_bytes=size, sha256=sha, storage_key=key, version=1,
            is_latest=True, retention_until=retention_until, is_sensitive=is_sensitive,
            uploaded_by_id=actor.id, tags=_clean_tags(tags), created_by_id=actor.id, updated_by_id=actor.id,
        )
        d.text_content = _read_text(key, mime, size)
        d.text_source = "file" if d.text_content else None
        db.add(d)
        await db.flush()
        if entity_type and entity_id:
            await link(db, d.id, entity_type, entity_id, actor)
        job = await _queue_job(db, d, actor.id) if auto_extract else None
        await audit.record(db, actor=actor, action="document.uploaded", entity_type=ENTITY, entity_id=d.id,
                           summary=f"{d.title} ({filename})", ip_address=actor.ip_address,
                           changes={"doc_class": d.doc_class, "size_bytes": size, "sha256": sha})
        await events.emit(db, "document.uploaded", document_id=d.id, actor=actor)
        await db.commit()
    except BaseException:
        await db.rollback()
        file_path(key).unlink(missing_ok=True)
        raise
    return d, job


async def new_version(db: AsyncSession, base: Document, *, file: UploadFile, actor: CurrentUser,
                      auto_extract: bool = True) -> tuple[Document, ExtractionJob | None]:
    chain = await _chain(db, base)
    latest = next((c for c in chain if c.is_latest), chain[0] if chain else base)
    filename = (Path(file.filename or latest.filename).name or latest.filename)[:300]
    mime = _guess_mime(file)
    key, size, sha = await _store(file)
    try:
        await db.execute(update(Document).where(ROOT == base.root_id).values(is_latest=False))
        d = Document(
            title=latest.title, description=latest.description, doc_class=latest.doc_class,
            classification_source=latest.classification_source,
            classification_confidence=latest.classification_confidence,
            filename=filename, mime_type=mime, size_bytes=size, sha256=sha, storage_key=key,
            version=max(c.version for c in chain) + 1 if chain else base.version + 1,
            parent_document_id=base.root_id, is_latest=True, retention_until=latest.retention_until,
            legal_hold=latest.legal_hold, is_sensitive=latest.is_sensitive, uploaded_by_id=actor.id,
            tags=list(latest.tags or []), created_by_id=actor.id, updated_by_id=actor.id,
        )
        d.text_content = _read_text(key, mime, size)
        d.text_source = "file" if d.text_content else None
        db.add(d)
        await db.flush()
        job = await _queue_job(db, d, actor.id) if auto_extract else None
        await audit.record(db, actor=actor, action="document.versioned", entity_type=ENTITY, entity_id=d.id,
                           summary=f"{d.title} v{d.version}", ip_address=actor.ip_address,
                           changes={"previous_version_id": latest.id, "version": d.version, "sha256": sha})
        await events.emit(db, "document.uploaded", document_id=d.id, actor=actor)
        await db.commit()
    except BaseException:
        await db.rollback()
        file_path(key).unlink(missing_ok=True)
        raise
    return d, job


async def update_document(db: AsyncSession, d: Document, data: DocumentUpdate, actor: CurrentUser) -> Document:
    values = data.model_dump(exclude_unset=True)
    _check_class(values.get("doc_class"))
    for key in ("title", "doc_class", "is_sensitive", "legal_hold"):
        if key in values and values[key] is None:
            values.pop(key)
    if "tags" in values:
        values["tags"] = _clean_tags(values["tags"])
    if values.get("legal_hold") is False and d.legal_hold and not actor.can("documents", "approve"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Releasing a legal hold requires documents:approve")
    if "retention_until" in values and d.retention_until and not actor.can("documents", "approve"):
        new = values["retention_until"]
        if new is None or new < d.retention_until:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Shortening retention requires documents:approve")
    if values.get("is_sensitive") and not actor.can("documents", "view_sensitive"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Marking a document sensitive requires documents:view_sensitive")
    if "doc_class" in values and values["doc_class"] != d.doc_class:
        values["classification_source"] = "manual"
        values["classification_confidence"] = None

    changes = audit.diff(d, values)
    if not changes:
        return d
    # Metadata, holds and retention belong to the logical document: apply to every version.
    for doc in await _chain(db, d, include_deleted=True):
        for k, v in values.items():
            setattr(doc, k, v)
        doc.updated_by_id = actor.id
    action = "document.updated"
    if "legal_hold" in changes:
        action = "document.legal_hold_placed" if values["legal_hold"] else "document.legal_hold_released"
    await audit.record(db, actor=actor, action=action, entity_type=ENTITY, entity_id=d.id, changes=changes,
                       summary=d.title, ip_address=actor.ip_address)
    await db.commit()
    return d


async def set_text(db: AsyncSession, d: Document, text: str, actor: CurrentUser) -> Document:
    old_len = len(d.text_content or "")
    d.text_content = text[:MAX_TEXT_CHARS] or None
    d.text_source = "manual" if d.text_content else None
    d.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="document.text_set", entity_type=ENTITY, entity_id=d.id,
                       changes={"text_length": {"from": old_len, "to": len(d.text_content or "")}},
                       summary=d.title, ip_address=actor.ip_address)
    await db.commit()
    return d


async def delete_document(db: AsyncSession, d: Document, actor: CurrentUser) -> None:
    reason = delete_block_reason(d)
    if reason:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Cannot delete: {reason.lower()}")
    d.deleted_at = utcnow()
    d.updated_by_id = actor.id
    if d.is_latest:
        d.is_latest = False
        prev = await db.scalar(select(Document).where(ROOT == d.root_id, Document.id != d.id,
                                                      Document.deleted_at.is_(None))
                               .order_by(Document.version.desc()).limit(1))
        if prev:
            prev.is_latest = True
    await audit.record(db, actor=actor, action="document.deleted", entity_type=ENTITY, entity_id=d.id,
                       summary=f"{d.title} v{d.version}", ip_address=actor.ip_address)
    await db.commit()


async def link(db: AsyncSession, document_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID,
               actor: Any) -> DocumentLink:
    """Public contract: link a document (any version) to a record. Idempotent. Does not commit."""
    d = await db.get(Document, document_id)
    if not d or d.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    if not re.fullmatch(r"[a-z][a-z_]{1,39}", entity_type or ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid entity type")
    root = d.root_id
    existing = await db.scalar(select(DocumentLink).where(
        DocumentLink.document_id == root, DocumentLink.entity_type == entity_type, DocumentLink.entity_id == entity_id
    ))
    if existing:
        return existing
    lnk = DocumentLink(document_id=root, entity_type=entity_type, entity_id=entity_id,
                       created_by_id=getattr(actor, "id", None))
    db.add(lnk)
    await db.flush()
    await audit.record(db, actor=actor, action="document.linked", entity_type=ENTITY, entity_id=d.id,
                       changes={"entity_type": entity_type, "entity_id": entity_id}, summary=d.title,
                       ip_address=getattr(actor, "ip_address", None))
    return lnk


async def unlink(db: AsyncSession, d: Document, link_id: uuid.UUID, actor: CurrentUser) -> None:
    lnk = await db.get(DocumentLink, link_id)
    if not lnk or lnk.document_id != d.root_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found")
    await audit.record(db, actor=actor, action="document.unlinked", entity_type=ENTITY, entity_id=d.id,
                       changes={"entity_type": lnk.entity_type, "entity_id": lnk.entity_id}, summary=d.title,
                       ip_address=actor.ip_address)
    await db.delete(lnk)
    await db.commit()


async def versions(db: AsyncSession, d: Document, user: CurrentUser) -> list[DocumentListItem]:
    return await to_list_items(db, await _chain(db, d), user)


async def access_log(db: AsyncSession, d: Document) -> list[AccessLogOut]:
    ids = [c.id for c in await _chain(db, d, include_deleted=True)]
    rows = list(await db.scalars(select(DocumentAccessLog).where(DocumentAccessLog.document_id.in_(ids))
                                 .order_by(DocumentAccessLog.occurred_at.desc()).limit(200)))
    names = await _user_names(db, {r.user_id for r in rows})
    return [AccessLogOut.model_validate(r).model_copy(update={"user_name": names.get(r.user_id) if r.user_id else None})
            for r in rows]


# --- Extraction workflow -------------------------------------------------------------------------

async def request_extraction(db: AsyncSession, d: Document, body: ExtractIn,
                             actor: CurrentUser) -> tuple[ExtractionJob, bool]:
    """Returns (job, created). An already queued/running job is returned instead of starting another."""
    if bool(body.target_entity_type) != bool(body.target_entity_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Target type and id must be sent together")
    # Jobs older than 15 minutes are treated as abandoned (e.g. the worker restarted) and do not block a re-run.
    running = await db.scalar(select(ExtractionJob).where(
        ExtractionJob.document_id == d.id, ExtractionJob.status.in_(["queued", "running"]),
        ExtractionJob.created_at >= utcnow() - timedelta(minutes=15),
    ))
    if running:
        return running, False
    job = await _queue_job(db, d, actor.id, target_type=body.target_entity_type,
                           target_id=body.target_entity_id, fields=body.fields)
    await audit.record(db, actor=actor, action="document.extraction_requested", entity_type=ENTITY, entity_id=d.id,
                       changes={"target_entity_type": job.target_entity_type, "target_entity_id": job.target_entity_id},
                       summary=d.title, ip_address=actor.ip_address)
    await db.commit()
    return job, True


def _finish(job: ExtractionJob, d: Document, state: str, message: str) -> None:
    job.status = state
    job.message = message
    job.finished_at = utcnow()
    d.extraction_status = state


def _clamp(v: Any) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


def _int_or_none(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


async def run_extraction(job_id: uuid.UUID) -> None:
    """Background task entry point. Uses its own session; never raises into the request path."""
    async with SessionLocal() as db:
        try:
            await _run_extraction(db, job_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("documents: extraction job %s failed", job_id)
            await db.rollback()
            job = await db.get(ExtractionJob, job_id, populate_existing=True)
            if job:
                d = await db.get(Document, job.document_id)
                job.status, job.message, job.finished_at = "failed", str(exc)[:2000], utcnow()
                if d:
                    d.extraction_status = "failed"
                await db.commit()


async def _run_extraction(db: AsyncSession, job_id: uuid.UUID) -> None:
    job = await db.get(ExtractionJob, job_id)
    if not job or job.status != "queued":
        return
    d = await db.get(Document, job.document_id)
    if not d or d.deleted_at:
        job.status, job.message, job.finished_at = "failed", "Document is no longer available", utcnow()
        await db.commit()
        return

    provider = ai.get_provider()
    job.provider, job.model = provider.name, provider.model
    if not provider.available:
        _finish(job, d, "skipped", "No AI provider is configured. Values can be entered manually with citations.")
        await db.commit()
        return
    text, pdf_path = d.text_content or "", None
    if (d.mime_type or "").lower() == "application/pdf":
        try:  # providers that read PDFs natively (Claude) get the stored file
            from app.modules.documents.claude_provider import document_content

            text, pdf_path = document_content(d)
        except ImportError:
            pass
    if not text and not pdf_path:
        _finish(job, d, "skipped", "No document text is available. Add the text, then run extraction again.")
        await db.commit()
        return
    pdf_kw = {"pdf_path": pdf_path} if pdf_path else {}

    job.status, job.started_at, d.extraction_status = "running", utcnow(), "running"
    await db.commit()
    actor_id = job.created_by_id
    try:
        if d.classification_source in ("default", "ai"):
            filename = d.filename
            result = await ai.logged_call(
                db, provider, purpose="classify", prompt_parts=(filename, d.sha256),
                call=lambda: provider.classify(text, filename, **pdf_kw), document_id=d.id, actor_id=actor_id,
                summarize_output=lambda r: {"doc_class": r.get("doc_class"), "confidence": r.get("confidence")},
            )
            if result.get("doc_class") in DOC_CLASSES:
                d.doc_class = result["doc_class"]
                d.classification_source = "ai"
                d.classification_confidence = _clamp(result.get("confidence"))
        doc_class = d.doc_class
        schema = extraction_schema(doc_class, job.target_entity_type, job.fields or None)
        items = await ai.logged_call(
            db, provider, purpose="extract", prompt_parts=(d.sha256, doc_class, schema),
            call=lambda: provider.extract(text, doc_class, schema, **pdf_kw), document_id=d.id, actor_id=actor_id,
            summarize_output=lambda r: {"count": len(r or [])},
        )
    except Exception as exc:  # noqa: BLE001 — provider failure: log call (already added) and mark failed
        _finish(job, d, "failed", f"AI provider error: {exc}"[:2000])
        await db.commit()
        return

    types = {s["field"]: s.get("type", "text") for s in schema}
    count = 0
    for item in items or []:
        name = str(item.get("field") or "").strip()[:80]
        value = item.get("value")
        if not name or value in (None, ""):
            continue
        db.add(ExtractedValue(
            document_id=d.id, job_id=job.id, origin="ai", target_entity_type=job.target_entity_type,
            target_entity_id=job.target_entity_id, field=name, value_type=types.get(name, "text"),
            value=to_jsonable(value), original_value=to_jsonable(value), page=_int_or_none(item.get("page")),
            clause=(str(item["clause"])[:200] if item.get("clause") else None),
            citation_text=(str(item["citation_text"]) if item.get("citation_text") else None),
            confidence=_clamp(item.get("confidence")), status="pending", ai_model=provider.model,
            created_by_id=actor_id, updated_by_id=actor_id,
        ))
        count += 1
    job.values_count = count
    _finish(job, d, "completed", f"{count} values extracted for review")
    if count:
        from app.modules.tasks.service import create_task

        await create_task(
            db, title=f"Review {count} extracted values: {d.title}", assignee_id=actor_id, task_type="review",
            related_type=ENTITY, related_id=d.id, related_label=d.title, source="documents.extraction",
            idempotency_key=f"doc-extract:{job.id}", actor_id=actor_id,
        )
    await audit.record(db, actor=None, action="document.extracted", entity_type=ENTITY, entity_id=d.id,
                       summary=f"{count} values extracted by {provider.name}/{provider.model}")
    await db.commit()


async def list_jobs(db: AsyncSession, d: Document) -> list[ExtractionJob]:
    return list(await db.scalars(select(ExtractionJob).where(ExtractionJob.document_id == d.id)
                                 .order_by(ExtractionJob.created_at.desc()).limit(50)))


async def add_manual_value(db: AsyncSession, d: Document, body: ManualValueIn, actor: CurrentUser) -> ExtractedValue:
    if bool(body.target_entity_type) != bool(body.target_entity_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Target type and id must be sent together")
    ev = ExtractedValue(
        document_id=d.id, origin="manual", target_entity_type=body.target_entity_type,
        target_entity_id=body.target_entity_id, field=body.field.strip(), value_type=body.value_type,
        value=to_jsonable(body.value), original_value=to_jsonable(body.value), page=body.page, clause=body.clause,
        citation_text=body.citation_text, confidence=body.confidence, status="pending",
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(ev)
    await db.flush()
    await audit.record(db, actor=actor, action="document.value_added", entity_type=ENTITY, entity_id=d.id,
                       changes={"field": ev.field, "value": ev.value, "page": ev.page}, summary=d.title,
                       ip_address=actor.ip_address)
    await db.commit()
    return ev


# --- Verification queue --------------------------------------------------------------------------

@dataclass
class ValueFilters:
    q: str | None = None
    status: list[str] | None = None
    field: list[str] | None = None
    document_id: uuid.UUID | None = None
    target_entity_type: list[str] | None = None
    target_entity_id: uuid.UUID | None = None
    origin: list[str] | None = None
    min_confidence: float | None = None
    max_confidence: float | None = None


def value_query(f: ValueFilters, user: CurrentUser, *, skip: set[str] = frozenset()) -> Select:
    stmt = (select(ExtractedValue).join(Document, Document.id == ExtractedValue.document_id)
            .where(ExtractedValue.deleted_at.is_(None), Document.deleted_at.is_(None)))
    stmt = visible(stmt, user)
    stmt = apply_search(stmt, f.q, [ExtractedValue.field, ExtractedValue.citation_text, ExtractedValue.clause,
                                     Document.title])
    if "status" not in skip:
        stmt = in_filter(stmt, ExtractedValue.status, f.status)
    if "field" not in skip:
        stmt = in_filter(stmt, ExtractedValue.field, f.field)
    if "target_entity_type" not in skip:
        stmt = in_filter(stmt, ExtractedValue.target_entity_type, f.target_entity_type)
    stmt = in_filter(stmt, ExtractedValue.origin, f.origin)
    if f.document_id:
        stmt = stmt.where(ExtractedValue.document_id == f.document_id)
    if f.target_entity_id:
        stmt = stmt.where(ExtractedValue.target_entity_id == f.target_entity_id)
    if f.min_confidence is not None:
        stmt = stmt.where(ExtractedValue.confidence >= f.min_confidence)
    if f.max_confidence is not None:
        stmt = stmt.where(ExtractedValue.confidence <= f.max_confidence)
    return stmt


async def value_facets(db: AsyncSession, f: ValueFilters, user: CurrentUser) -> ValueFacets:
    return ValueFacets(
        status=await facet_counts(db, value_query(f, user, skip={"status"}), ExtractedValue.status),
        field=await facet_counts(db, value_query(f, user, skip={"field"}), ExtractedValue.field),
        target_entity_type=await facet_counts(db, value_query(f, user, skip={"target_entity_type"}),
                                              ExtractedValue.target_entity_type),
    )


def _norm(value: Any, value_type: str) -> Any:
    if value is None:
        return None
    if value_type in ("number", "money", "percent") or isinstance(value, (int, float, Decimal)):
        try:
            return round(float(str(value).replace(",", "").replace("$", "").replace("%", "").strip()), 4)
        except ValueError:
            pass
    if value_type == "date" or isinstance(value, (date, datetime)):
        return str(to_jsonable(value))[:10]
    return str(value).strip().lower()


async def values_out(db: AsyncSession, values: list[ExtractedValue]) -> list[ExtractedValueOut]:
    if not values:
        return []
    titles = dict((await db.execute(select(Document.id, Document.title)
                                    .where(Document.id.in_({v.document_id for v in values})))).all())
    names = await _user_names(db, {v.reviewer_id for v in values})
    pairs = {(v.target_entity_type, v.target_entity_id) for v in values if v.target_entity_type and v.target_entity_id}
    targets = await _load_targets(db, pairs)
    labels = await _labels(db, pairs) if pairs else {}
    out: list[ExtractedValueOut] = []
    for v in values:
        key = (v.target_entity_type, v.target_entity_id)
        row = targets.get(key) if v.target_entity_type and v.target_entity_id else None
        current, conflict = None, None
        if row is not None and v.field in type(row).__table__.columns:
            current = to_jsonable(getattr(row, v.field, None))
            conflict = current is not None and _norm(current, v.value_type) != _norm(v.value, v.value_type)
        out.append(ExtractedValueOut.model_validate(v).model_copy(update={
            "document_title": titles.get(v.document_id),
            "reviewer_name": names.get(v.reviewer_id) if v.reviewer_id else None,
            "target_label": labels.get(key),
            "is_date": v.value_type == "date",
            "applicable": v.target_entity_type == "property" and bool(v.target_entity_id)
                          and v.field in PROPERTY_APPLICABLE,
            "current_value": current,
            "conflict": conflict,
        }))
    return out


async def get_value(db: AsyncSession, value_id: uuid.UUID, user: CurrentUser) -> tuple[ExtractedValue, Document]:
    ev = await db.get(ExtractedValue, value_id)
    if not ev or ev.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Extracted value not found")
    return ev, await get(db, ev.document_id, user)


def _coerce(model: Any, field: str, value: Any) -> Any:
    col = model.__table__.columns.get(field)
    if col is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"'{field}' is not a field on the target record")
    if value is None or value == "":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A value is required")
    try:
        pytype = col.type.python_type
    except NotImplementedError:
        pytype = str
    raw = str(value).strip()
    try:
        if pytype is int:
            return int(round(float(raw.replace(",", "").replace("$", ""))))
        if pytype in (float, Decimal):
            return float(raw.replace(",", "").replace("$", "").replace("%", ""))
        if pytype is date:
            return date.fromisoformat(raw[:10])
        if pytype is datetime:
            return datetime.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"'{value}' is not a valid value for {field}")
    length = getattr(col.type, "length", None)
    return raw[:length] if length else raw


async def _apply_to_property(db: AsyncSession, ev: ExtractedValue, d: Document, value: Any, actor: CurrentUser,
                             accept_conflict: bool) -> tuple[uuid.UUID, Any]:
    """Apply a human-confirmed value to a property through provenance. Returns (observation id, coerced value)."""
    from app.modules.properties.models import PROPERTY_TYPES, Property
    from app.modules.properties.service import completeness

    if not actor.can("properties", "edit"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Applying values to a property requires properties:edit")
    p = await db.get(Property, ev.target_entity_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Target property not found")
    coerced = _coerce(Property, ev.field, value)
    if ev.field == "property_type" and coerced not in PROPERTY_TYPES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"'{coerced}' is not a valid property type")
    current = getattr(p, ev.field)
    changed = current != coerced
    if changed and current is not None and not accept_conflict:
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "message": f"The property already has {ev.field.replace('_', ' ')} = {to_jsonable(current)}. "
                       "Review the conflict and confirm replacing it explicitly.",
            "current_value": to_jsonable(current),
            "extracted_value": to_jsonable(coerced),
        })
    if changed:
        setattr(p, ev.field, coerced)
        p.completeness_score = completeness(p)
        p.updated_by_id = actor.id

    cite = f" p.{ev.page}" if ev.page else ""
    cite += f" §{ev.clause}" if ev.clause else ""
    prov = provenance.ProvenanceIn(
        source=f"Document: {d.title}{cite}"[:200], observed_on=date.today(), confidence=ev.confidence,
        verified=False, ai_derived=ev.origin == "ai",
    )
    obs = await provenance.observe(db, entity_type="property", entity_id=p.id, field=ev.field, value=coerced,
                                   prov=prov, actor_id=actor.id)
    await db.flush()
    # The named reviewer verifies; the AI-derived flag stays on the observation permanently.
    obs.verification, obs.verified_by_id, obs.verified_at = "verified", actor.id, utcnow()
    if changed:
        await audit.record(db, actor=actor, action="property.updated", entity_type="property", entity_id=p.id,
                           changes={ev.field: {"from": to_jsonable(current), "to": to_jsonable(coerced)}},
                           summary=f"Confirmed from document {d.title}", ip_address=actor.ip_address)
        await events.emit(db, "property.updated", property_id=p.id, changed={ev.field}, actor=actor)
    return obs.id, coerced


async def confirm_value(db: AsyncSession, ev: ExtractedValue, d: Document, actor: CurrentUser, *,
                        accept_conflict: bool = False, note: str | None = None, edited: bool = False,
                        new_value: Any = None) -> ExtractedValue:
    if ev.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, f"This value was already {ev.status}")
    value = new_value if edited else ev.value
    if edited and (value is None or value == ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A value is required")
    if ev.target_entity_type == "property" and ev.target_entity_id and ev.field in PROPERTY_APPLICABLE:
        obs_id, value = await _apply_to_property(db, ev, d, value, actor, accept_conflict)
        ev.applied_observation_id = obs_id
    ev.value = to_jsonable(value)
    ev.status = "edited" if edited else "confirmed"
    ev.reviewer_id, ev.reviewed_at, ev.review_note, ev.updated_by_id = actor.id, utcnow(), note, actor.id
    await audit.record(db, actor=actor, action=f"document.value_{ev.status}", entity_type=ENTITY, entity_id=d.id,
                       changes={"field": ev.field, "original_value": ev.original_value, "value": ev.value,
                                "target_entity_type": ev.target_entity_type, "target_entity_id": ev.target_entity_id},
                       summary=f"{ev.field} on {d.title}", ip_address=actor.ip_address)
    # Consumers (leases, contracts, ...) may pick up confirmed values. Dates stay proposals in those modules.
    await events.emit(db, "document.value_confirmed", extracted_value_id=ev.id, document_id=d.id,
                      target_entity_type=ev.target_entity_type, target_entity_id=ev.target_entity_id,
                      field=ev.field, value=ev.value, value_type=ev.value_type, actor=actor)
    await db.commit()
    return ev


async def reject_value(db: AsyncSession, ev: ExtractedValue, d: Document, actor: CurrentUser,
                       note: str | None) -> ExtractedValue:
    if ev.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, f"This value was already {ev.status}")
    ev.status = "rejected"
    ev.reviewer_id, ev.reviewed_at, ev.review_note, ev.updated_by_id = actor.id, utcnow(), note, actor.id
    await audit.record(db, actor=actor, action="document.value_rejected", entity_type=ENTITY, entity_id=d.id,
                       changes={"field": ev.field, "value": ev.value}, summary=note or ev.field,
                       ip_address=actor.ip_address)
    await db.commit()
    return ev


# --- Retrieval, summaries, drafting --------------------------------------------------------------

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "has", "have", "how", "in", "is",
    "it", "of", "on", "or", "show", "me", "the", "this", "that", "to", "was", "what", "when", "where", "which",
    "who", "with", "find", "all", "any", "our", "we", "documents", "document", "docs",
}


def search_terms(q: str) -> list[str]:
    terms = [t for t in re.findall(r"[\w$.%/-]+", q.lower()) if t not in STOPWORDS and len(t) > 1]
    return list(dict.fromkeys(terms))[:8]


def _snippet(text: str | None, terms: list[str], width: int = 140) -> str | None:
    if not text:
        return None
    low = text.lower()
    for t in terms:
        idx = low.find(t)
        if idx >= 0:
            start, end = max(0, idx - width), min(len(text), idx + len(t) + width)
            body = re.sub(r"\s+", " ", text[start:end]).strip()
            return f"{'…' if start else ''}{body}{'…' if end < len(text) else ''}"
    return None


async def search(db: AsyncSession, q: str, user: CurrentUser, limit: int = 20) -> list[SearchHit]:
    terms = search_terms(q)
    if not terms:
        return []
    conds = []
    for t in terms:
        pattern = f"%{t}%"
        ev_match = exists().where(
            ExtractedValue.document_id == Document.id, ExtractedValue.deleted_at.is_(None),
            ExtractedValue.status != "rejected",
            or_(ExtractedValue.citation_text.ilike(pattern), ExtractedValue.field.ilike(pattern)),
        )
        conds.append(or_(Document.title.ilike(pattern), Document.filename.ilike(pattern),
                         Document.description.ilike(pattern), Document.text_content.ilike(pattern), ev_match))
    stmt = visible(select(Document).where(Document.deleted_at.is_(None), Document.is_latest.is_(True), or_(*conds)), user)
    docs = list(await db.scalars(stmt.order_by(Document.updated_at.desc()).limit(200)))

    def score(d: Document) -> tuple[int, int]:
        meta = f"{d.title} {d.filename} {d.description or ''}".lower()
        body = (d.text_content or "").lower()
        return (sum(t in meta for t in terms) * 3 + sum(t in body for t in terms), int(d.updated_at.timestamp()))

    docs = sorted(docs, key=score, reverse=True)[:limit]
    if not docs:
        return []
    ids = [d.id for d in docs]
    cites = list(await db.scalars(
        select(ExtractedValue).where(
            ExtractedValue.document_id.in_(ids), ExtractedValue.deleted_at.is_(None),
            ExtractedValue.status != "rejected",
            or_(*[or_(ExtractedValue.citation_text.ilike(f"%{t}%"), ExtractedValue.field.ilike(f"%{t}%"))
                  for t in terms]),
        ).order_by(ExtractedValue.confidence.desc()).limit(100)
    ))
    links = await _links_for(db, {d.root_id for d in docs}, user)
    hits: list[SearchHit] = []
    for d in docs:
        meta = f"{d.title} {d.filename} {d.description or ''}".lower()
        matched = [k for k, ok in (("metadata", any(t in meta for t in terms)),
                                   ("text", any(t in (d.text_content or "").lower() for t in terms))) if ok]
        doc_cites = [Citation(document_id=c.document_id, page=c.page, clause=c.clause,
                              text=(c.citation_text or f"{c.field}: {c.value}")[:300])
                     for c in cites if c.document_id == d.id][:3]
        if doc_cites:
            matched.append("citations")
        hits.append(SearchHit(
            document_id=d.id, title=d.title, doc_class=d.doc_class, filename=d.filename, is_sensitive=d.is_sensitive,
            matched_in=matched, snippet=_snippet(d.text_content, terms) or _snippet(d.description, terms),
            citations=doc_cites, links=links.get(d.root_id, []),
        ))
    return hits


async def summarize(db: AsyncSession, body: SummarizeIn, user: CurrentUser) -> SummaryOut:
    ids = list(dict.fromkeys(body.document_ids))
    if body.entity_type and body.entity_id:
        f = DocFilters(entity_type=body.entity_type, entity_id=body.entity_id)
        ids += [d.id for d in await db.scalars(build_query(f, user).limit(50)) if d.id not in ids]
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Select at least one document")
    docs = [await get(db, i, user) for i in ids[:50]]
    provider = ai.get_provider()
    if not provider.available:
        return SummaryOut(ai_used=False, provider=provider.name, summary=None, document_ids=ids,
                          message="AI summaries are not enabled on this workspace yet.")
    texts = [ai.SourceText(document_id=str(d.id), title=d.title, text=d.text_content or "") for d in docs if d.text_content]
    if not texts:
        return SummaryOut(ai_used=False, provider=provider.name, summary=None, document_ids=ids,
                          message="None of the selected documents have text to summarize.")
    purpose = body.purpose
    try:
        result = await ai.logged_call(
            db, provider, purpose=f"summarize:{purpose}", prompt_parts=(purpose, [d.sha256 for d in docs]),
            call=lambda: provider.summarize(texts, purpose), document_id=docs[0].id if len(docs) == 1 else None,
            actor_id=user.id, summarize_output=lambda r: {"chars": len(r.get("summary") or "")},
        )
    except Exception as exc:  # noqa: BLE001 — never block the user path on AI
        await db.commit()
        return SummaryOut(ai_used=False, provider=provider.name, summary=None, document_ids=ids,
                          message=f"The AI provider could not produce a summary ({type(exc).__name__}).")
    await audit.record(db, actor=user, action="document.summarized", entity_type=ENTITY,
                       entity_id=docs[0].id if len(docs) == 1 else None,
                       changes={"document_ids": ids, "purpose": purpose}, ip_address=user.ip_address)
    await db.commit()
    citations = []
    for c in result.get("citations") or []:
        try:
            citations.append(Citation.model_validate(c))
        except Exception:  # noqa: BLE001
            continue
    return SummaryOut(ai_used=True, provider=provider.name, summary=result.get("summary") or "",
                      citations=citations, document_ids=ids)


def _fmt(value: Any) -> str:
    value = to_jsonable(value)
    if isinstance(value, float):
        return f"{value:,.2f}".rstrip("0").rstrip(".")
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


DRAFT_INTROS = {
    "outreach": "Hello [Name],\n\nI am reaching out about {title}. We follow this market closely and would welcome "
                "a brief conversation about the property and whether you would consider an offer.",
    "offer": "Re: Non-binding letter of intent — {title}\n\nThis letter outlines the principal terms under which "
             "[Buyer] proposes to acquire the property described below.",
    "proposal": "Proposal for {title}\n\nThank you for the opportunity to present our approach to marketing and "
                "advising on the property described below.",
    "report": "Property report — {title}\n\nSummary of verified information on file.",
}


async def draft(db: AsyncSession, body: DraftIn, user: CurrentUser) -> DraftOut:
    """Drafting from verified data only: verified observations and human-confirmed extracted values."""
    from app.modules.properties.models import Property

    if not user.can("properties", "view"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing permission properties:view")
    p = await db.get(Property, body.entity_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    title = p.name or p.address_line
    sources: list[DraftSource] = [
        DraftSource(field="address", value=", ".join(x for x in [p.address_line, p.city, p.state] if x),
                    source="Property record"),
        DraftSource(field="property_type", value=p.property_type, source="Property record"),
    ]
    for field, obs in sorted((await provenance.current_observations(db, "property", p.id)).items()):
        if obs.verification == "verified" and field != "property_type":
            sources.append(DraftSource(field=field, value=obs.value, source=obs.source))
    confirmed = await db.scalars(
        visible(select(ExtractedValue).join(Document, Document.id == ExtractedValue.document_id).where(
            ExtractedValue.target_entity_type == "property", ExtractedValue.target_entity_id == p.id,
            ExtractedValue.status.in_(["confirmed", "edited"]), ExtractedValue.deleted_at.is_(None),
            Document.deleted_at.is_(None),
        ), user).order_by(ExtractedValue.reviewed_at.desc()).limit(40)
    )
    seen = {s.field for s in sources}
    for ev in confirmed:
        if ev.field not in seen:
            seen.add(ev.field)
            sources.append(DraftSource(field=ev.field, value=ev.value,
                                       source=f"Confirmed document value{f' p.{ev.page}' if ev.page else ''}"))

    facts = "\n".join(f"- {s.field.replace('_', ' ').capitalize()}: {_fmt(s.value)}" for s in sources)
    template = (
        f"{DRAFT_INTROS[body.kind].format(title=title)}\n\nVerified facts:\n{facts}\n\n"
        f"{('Notes: ' + body.instructions.strip() + chr(10) + chr(10)) if body.instructions else ''}"
        f"Regards,\n{user.full_name}"
    )
    provider = ai.get_provider()
    if not provider.available:
        return DraftOut(ai_used=False, provider=provider.name, draft=template, sources=sources)
    kind = body.kind
    texts = [ai.SourceText(document_id="", title="Verified facts and template", text=template)]
    try:
        result = await ai.logged_call(
            db, provider, purpose=f"draft:{kind}", prompt_parts=(kind, template),
            call=lambda: provider.summarize(texts, f"draft:{kind}"), actor_id=user.id,
            summarize_output=lambda r: {"chars": len(r.get("summary") or "")},
        )
        text = (result.get("summary") or "").strip()
    except Exception:  # noqa: BLE001
        text = ""
    await db.commit()
    return DraftOut(ai_used=bool(text), provider=provider.name, draft=text or template, sources=sources)


def ai_calls_query(document_id: uuid.UUID | None, purpose: list[str] | None) -> Select:
    stmt = select(AICall)
    if document_id:
        stmt = stmt.where(AICall.document_id == document_id)
    return in_filter(stmt, AICall.purpose, purpose)
