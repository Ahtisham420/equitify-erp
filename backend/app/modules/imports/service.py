"""Guided imports: upload -> map -> validate (dry run + dedupe preview) -> commit -> rollback.

External data can only be committed against an active source/license record, and every created or
updated material fact carries that source as provenance.
"""
import csv
import io
import re
import uuid
from collections import Counter
from datetime import date
from typing import Any

from fastapi import HTTPException, UploadFile, status
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.normalize import normalize_address, normalize_name
from app.common.provenance import ProvenanceIn
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.imports.models import ENTITY_TYPES, DataSource, ImportJob, ImportRow
from app.modules.imports.schemas import (
    CommitIn,
    DataSourceIn,
    DataSourceUpdate,
    ImportJobDetail,
    ImportJobOut,
    TargetField,
)
from app.modules.imports.targets import TARGETS, Target, convert, suggest_mapping

MAX_BYTES = 15 * 1024 * 1024
MAX_ROWS = 10_000
SAMPLE_ROWS = 5
_PG_IN_CHUNK = 1000


def target_fields(entity_type: str) -> list[TargetField]:
    return [
        TargetField(key=t.key, label=t.label, type=t.type, required=t.required, options=list(t.options), group=t.group)
        for t in TARGETS[entity_type]
    ]


def _contacts():
    try:
        from app.modules.contacts import models
    except ImportError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Contacts module unavailable")
    return models


# --- Data sources -----------------------------------------------------------------------------

async def get_source(db: AsyncSession, source_id: uuid.UUID) -> DataSource:
    src = await db.get(DataSource, source_id)
    if not src or src.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Data source not found")
    return src


async def create_source(db: AsyncSession, data: DataSourceIn, actor: CurrentUser) -> DataSource:
    src = DataSource(**data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(src)
    await db.flush()
    await audit.record(db, actor=actor, action="data_source.created", entity_type="data_source", entity_id=src.id,
                       summary=src.provider, ip_address=actor.ip_address)
    await db.commit()
    return src


async def update_source(db: AsyncSession, src: DataSource, data: DataSourceUpdate, actor: CurrentUser) -> DataSource:
    values = data.model_dump(exclude_unset=True)
    if "provider" in values and not values["provider"]:
        values.pop("provider")
    changes = audit.diff(src, values)
    for k, v in values.items():
        setattr(src, k, v)
    if changes:
        src.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="data_source.updated", entity_type="data_source", entity_id=src.id,
                           summary=src.provider, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return src


async def archive_source(db: AsyncSession, src: DataSource, actor: CurrentUser) -> None:
    src.deleted_at = utcnow()
    src.is_active = False
    src.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="data_source.archived", entity_type="data_source", entity_id=src.id,
                       summary=src.provider, ip_address=actor.ip_address)
    await db.commit()


async def _require_active_source(db: AsyncSession, source_id: uuid.UUID | None) -> DataSource:
    src = await db.get(DataSource, source_id) if source_id else None
    if not src or src.deleted_at or not src.is_active:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "An active data source with license terms is required before external data can be loaded",
        )
    return src


# --- Jobs -------------------------------------------------------------------------------------

async def get_job(db: AsyncSession, job_id: uuid.UUID) -> ImportJob:
    job = await db.get(ImportJob, job_id)
    if not job or job.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Import not found")
    return job


async def job_out(db: AsyncSession, job: ImportJob, cls: type[ImportJobOut] = ImportJobOut) -> ImportJobOut:
    out = cls.model_validate(job)
    if job.data_source_id:
        out.data_source_name = await db.scalar(select(DataSource.provider).where(DataSource.id == job.data_source_id))
    return out


async def job_detail(db: AsyncSession, job: ImportJob) -> ImportJobDetail:
    out = await job_out(db, job, ImportJobDetail)
    assert isinstance(out, ImportJobDetail)
    sample = await db.scalars(
        select(ImportRow.raw).where(ImportRow.job_id == job.id).order_by(ImportRow.row_number).limit(SAMPLE_ROWS)
    )
    out.headers = list(job.headers or [])
    out.sample = list(sample)
    out.suggested_mapping = suggest_mapping(out.headers, TARGETS[job.entity_type])
    out.fields = target_fields(job.entity_type)
    return out


def _decode(content: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    return content.decode("latin-1")


def _parse_csv(text: str) -> tuple[list[str], list[dict[str, str]]]:
    sample = text[:20_000]
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    try:
        raw_headers = next(reader)
    except StopIteration:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The file is empty")

    headers: list[str] = []
    for i, h in enumerate(raw_headers):
        name = (h or "").strip() or f"Column {i + 1}"
        base, n = name, 2
        while name in headers:
            name, n = f"{base} ({n})", n + 1
        headers.append(name)

    rows: list[dict[str, str]] = []
    for cells in reader:
        if not any((c or "").strip() for c in cells):
            continue
        rows.append({h: (cells[i].strip() if i < len(cells) and cells[i] else "") for i, h in enumerate(headers)})
        if len(rows) > MAX_ROWS:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Imports are limited to {MAX_ROWS:,} rows per file")
    if not rows:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The file has a header row but no data rows")
    return headers, rows


async def upload(
    db: AsyncSession, *, file: UploadFile, entity_type: str, data_source_id: uuid.UUID, actor: CurrentUser
) -> ImportJob:
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unsupported entity type '{entity_type}'")
    src = await _require_active_source(db, data_source_id)
    filename = (file.filename or "upload.csv")[:255]
    if not filename.lower().endswith((".csv", ".txt", ".tsv")):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Upload a CSV file")
    content = await file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File is larger than 15 MB")
    headers, rows = _parse_csv(_decode(content))

    job = ImportJob(
        entity_type=entity_type, data_source_id=src.id, filename=filename, status="uploaded", headers=headers,
        column_mapping=suggest_mapping(headers, TARGETS[entity_type]), options={}, row_count=len(rows),
        counts={"total": len(rows)}, created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(job)
    await db.flush()
    db.add_all([ImportRow(job_id=job.id, row_number=i + 1, raw=r, status="pending", errors=[]) for i, r in enumerate(rows)])
    await audit.record(db, actor=actor, action="import.uploaded", entity_type="import_job", entity_id=job.id,
                       summary=f"{filename} · {len(rows)} {entity_type} rows from {src.provider}",
                       ip_address=actor.ip_address)
    await db.commit()
    return job


async def set_mapping(db: AsyncSession, job: ImportJob, mapping: dict[str, str | None], actor: CurrentUser) -> ImportJob:
    if job.status not in ("uploaded", "mapped", "validated"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Mapping can only change before the import is committed")
    valid = {t.key for t in TARGETS[job.entity_type]}
    headers = set(job.headers or [])
    clean: dict[str, str | None] = {}
    used: dict[str, str] = {}
    for header, key in mapping.items():
        if header not in headers:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown column '{header}'")
        key = key or None
        if key and key not in valid:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown target field '{key}'")
        if key and key in used:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"'{key}' is mapped from both '{used[key]}' and '{header}'")
        if key:
            used[key] = header
        clean[header] = key
    changes = audit.diff(job, {"column_mapping": clean})
    job.column_mapping = clean
    job.status = "mapped"
    job.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="import.mapped", entity_type="import_job", entity_id=job.id,
                       summary=job.filename, changes=changes or None, ip_address=actor.ip_address)
    await db.commit()
    return job


# --- Validation (dry run) ---------------------------------------------------------------------

def _map_row(raw: dict, mapping: dict[str, str | None], by_key: dict[str, Target]) -> tuple[dict, list[dict]]:
    mapped: dict[str, Any] = {}
    errors: list[dict] = []
    for header, key in mapping.items():
        if not key:
            continue
        t = by_key[key]
        value, err = convert(t, raw.get(header))
        if err:
            errors.append({"field": key, "column": header, "message": err})
        elif value is not None:
            mapped[key] = value
    failed = {e["field"] for e in errors}
    for t in by_key.values():
        if t.required and t.key not in mapped and t.key not in failed:
            errors.append({"field": t.key, "message": f"{t.label} is required"})
    return mapped, errors


def _entity_checks(entity_type: str, mapped: dict, errors: list[dict]) -> None:
    if entity_type == "property":
        from app.modules.properties.schemas import PropertyCreate

        try:
            PropertyCreate.model_validate(mapped)
        except ValidationError as exc:
            seen = {e["field"] for e in errors}
            for e in exc.errors():
                field = str(e["loc"][0]) if e.get("loc") else None
                if field not in seen:
                    errors.append({"field": field, "message": f"{field}: {e['msg']}" if field else e["msg"]})
    elif entity_type == "person":
        if not mapped.get("full_name"):
            name = " ".join(p for p in [mapped.get("first_name"), mapped.get("last_name")] if p)
            if name:
                mapped["full_name"] = name
            else:
                errors.append({"field": "full_name", "message": "A full name or first/last name is required"})


def _keys(entity_type: str, m: dict) -> list[str]:
    """Deterministic dedupe keys for a mapped row (shared by in-file and existing-record matching)."""
    if entity_type == "property":
        return [normalize_address(m.get("address_line"), m.get("city"), m.get("state"), m.get("postal_code"))]
    if entity_type == "person":
        if m.get("primary_email"):
            return [f"email:{m['primary_email'].lower()}"]
        return [f"name:{(m.get('full_name') or '').strip().lower()}|{(m.get('city') or '').strip().lower()}"]
    keys = [f"name:{normalize_name(m.get('name'))}"]
    if m.get("domain"):
        keys.append(f"domain:{m['domain'].strip().lower()}")
    return keys


def _chunks(items: list[str]):
    for i in range(0, len(items), _PG_IN_CHUNK):
        yield items[i:i + _PG_IN_CHUNK]


async def _find_existing(db: AsyncSession, entity_type: str, keys: set[str]) -> dict[str, uuid.UUID]:
    found: dict[str, uuid.UUID] = {}
    if not keys:
        return found
    if entity_type == "property":
        from app.modules.properties.models import Property

        for chunk in _chunks(sorted(keys)):
            rows = await db.execute(
                select(Property.id, Property.normalized_address, Property.alternate_addresses).where(
                    Property.deleted_at.is_(None),
                    or_(Property.normalized_address.in_(chunk), Property.alternate_addresses.has_any(array(chunk))),
                )
            )
            for pid, norm, alternates in rows.all():
                for k in [norm, *(alternates or [])]:
                    if k in keys:
                        found.setdefault(k, pid)
        return found

    models = _contacts()
    if entity_type == "person":
        Person = models.Person
        emails = [k[6:] for k in keys if k.startswith("email:")]
        names = {k[5:].split("|")[0] for k in keys if k.startswith("name:")}
        for chunk in _chunks(emails):
            rows = await db.execute(select(Person.id, func.lower(Person.primary_email)).where(
                Person.deleted_at.is_(None), func.lower(Person.primary_email).in_(chunk)))
            for pid, email in rows.all():
                found.setdefault(f"email:{email}", pid)
        for chunk in _chunks(sorted(names)):
            rows = await db.execute(select(Person.id, Person.full_name, Person.city).where(
                Person.deleted_at.is_(None), func.lower(Person.full_name).in_(chunk)))
            for pid, name, city in rows.all():
                found.setdefault(f"name:{(name or '').strip().lower()}|{(city or '').strip().lower()}", pid)
        return found

    Org = models.Organization
    domains = [k[7:] for k in keys if k.startswith("domain:")]
    wanted_names = {k for k in keys if k.startswith("name:")}
    for chunk in _chunks(domains):
        rows = await db.execute(select(Org.id, func.lower(Org.domain)).where(
            Org.deleted_at.is_(None), func.lower(Org.domain).in_(chunk)))
        for oid, domain in rows.all():
            found.setdefault(f"domain:{domain}", oid)
    if wanted_names:
        # Normalized-name match needs Python-side normalization; narrow by the first word first.
        first_words = sorted({k[5:].split(" ")[0] for k in wanted_names if k[5:]})
        for chunk in _chunks(first_words):
            conds = [Org.name.ilike(f"%{w}%") for w in chunk]
            rows = await db.execute(select(Org.id, Org.name).where(Org.deleted_at.is_(None), or_(*conds)))
            for oid, name in rows.all():
                key = f"name:{normalize_name(name)}"
                if key in wanted_names:
                    found.setdefault(key, oid)
    return found


async def validate(db: AsyncSession, job: ImportJob, actor: CurrentUser) -> ImportJob:
    if job.status not in ("uploaded", "mapped", "validated"):
        raise HTTPException(status.HTTP_409_CONFLICT, "This import has already been committed")
    targets = TARGETS[job.entity_type]
    by_key = {t.key: t for t in targets}
    mapping = {h: k for h, k in (job.column_mapping or {}).items() if k in by_key}
    mapped_fields = set(mapping.values())
    missing = [t.label for t in targets if t.required and t.key not in mapped_fields]
    if job.entity_type == "person" and not mapped_fields & {"full_name", "first_name", "last_name"}:
        missing.append("Full name (or first/last name)")
    if missing:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Map the required field(s): {', '.join(missing)}")

    rows = list(await db.scalars(select(ImportRow).where(ImportRow.job_id == job.id).order_by(ImportRow.row_number)))
    prepared: list[tuple[ImportRow, dict, list[dict], list[str]]] = []
    for r in rows:
        mapped, errors = _map_row(r.raw or {}, mapping, by_key)
        if not errors:
            _entity_checks(job.entity_type, mapped, errors)
        prepared.append((r, mapped, errors, _keys(job.entity_type, mapped) if not errors else []))

    existing = await _find_existing(db, job.entity_type, {k for *_, keys in prepared for k in keys})
    seen: dict[str, int] = {}
    counts: Counter[str] = Counter()
    for r, mapped, errors, keys in prepared:
        r.mapped, r.errors = mapped, errors
        r.duplicate_of_id = r.created_entity_id = None
        r.previous_values = None
        if errors:
            r.status = "invalid"
        else:
            hit = next((existing[k] for k in keys if k in existing), None)
            earlier = next((seen[k] for k in keys if k in seen), None)
            if hit:
                r.status, r.duplicate_of_id = "duplicate", hit
                r.errors = [{"field": None, "message": "Matches an existing record"}]
                counts["existing_duplicates"] += 1
            elif earlier:
                r.status = "duplicate"
                r.errors = [{"field": None, "message": f"Same record as row {earlier} in this file"}]
                counts["file_duplicates"] += 1
            else:
                r.status = "valid"
            for k in keys:
                seen.setdefault(k, r.row_number)
        counts[r.status] += 1

    job.counts = {"total": len(rows), "valid": counts["valid"], "invalid": counts["invalid"],
                  "duplicate": counts["duplicate"], "existing_duplicates": counts["existing_duplicates"],
                  "file_duplicates": counts["file_duplicates"]}
    job.status = "validated"
    job.validated_at = utcnow()
    job.error = None
    job.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="import.validated", entity_type="import_job", entity_id=job.id,
                       summary=job.filename, changes={"counts": job.counts}, ip_address=actor.ip_address)
    await db.commit()
    return job


# --- Commit -----------------------------------------------------------------------------------

def _diff_values(obj: Any, values: dict) -> dict:
    """Previous values for the fields the import would actually change."""
    return {k: to_jsonable(getattr(obj, k, None)) for k, v in values.items() if to_jsonable(getattr(obj, k, None)) != v}


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value)


async def _add_contact_points(db: AsyncSession, models: Any, owner: dict, mapped: dict, source: str) -> None:
    ContactPoint = getattr(models, "ContactPoint", None)
    if ContactPoint is None:
        return
    email = mapped.get("primary_email")
    phone = mapped.get("primary_phone") or mapped.get("phone")
    if email:
        db.add(ContactPoint(**owner, kind="email", value=email, normalized_value=email.lower(), label="Imported",
                            is_primary=True, source=source))
    if phone:
        db.add(ContactPoint(**owner, kind="phone", value=phone, normalized_value=_digits(phone)[-10:], label="Imported",
                            is_primary=True, source=source))


async def _commit_property(db: AsyncSession, r: ImportRow, prov: ProvenanceIn, actor: CurrentUser) -> None:
    from app.modules.properties import service as properties
    from app.modules.properties.models import Property
    from app.modules.properties.schemas import PropertyCreate, PropertyUpdate

    if r.status == "valid":
        try:
            p = await properties.create(db, PropertyCreate.model_validate({**r.mapped, "provenance": prov}), actor)
        except HTTPException as exc:
            if exc.status_code != status.HTTP_409_CONFLICT:
                raise
            dupes = exc.detail.get("duplicates", []) if isinstance(exc.detail, dict) else []
            r.status = "skipped"
            r.duplicate_of_id = uuid.UUID(dupes[0]["id"]) if dupes else None
            r.errors = [{"field": None, "message": "Matched an existing record at commit time"}]
            return
        r.status, r.created_entity_id = "created", p.id
        return

    p = await db.get(Property, r.duplicate_of_id)
    if not p or p.deleted_at:
        r.status, r.errors = "skipped", [{"field": None, "message": "Matched record no longer exists"}]
        return
    prev = _diff_values(p, r.mapped)
    if not prev:
        r.status, r.errors = "skipped", [{"field": None, "message": "No changes against the existing record"}]
        return
    data = PropertyUpdate.model_validate({**{k: r.mapped[k] for k in prev}, "provenance": prov})
    r.previous_values = prev
    r.status, r.created_entity_id = "updated", p.id
    await properties.update(db, p, data, actor)


async def _commit_contact(
    db: AsyncSession, job: ImportJob, r: ImportRow, models: Any, source: str, actor: CurrentUser
) -> None:
    Model = models.Person if job.entity_type == "person" else models.Organization
    if r.status == "valid":
        values = {k: v for k, v in r.mapped.items() if hasattr(Model, k)}
        obj = Model(**values, created_by_id=actor.id, updated_by_id=actor.id)
        if job.entity_type == "organization" and hasattr(Model, "normalized_name"):
            obj.normalized_name = normalize_name(values.get("name"))
        db.add(obj)
        await db.flush()
        owner_key = "person_id" if job.entity_type == "person" else "organization_id"
        await _add_contact_points(db, models, {owner_key: obj.id}, r.mapped, source)
        await audit.record(db, actor=actor, action=f"{job.entity_type}.created", entity_type=job.entity_type,
                           entity_id=obj.id, summary=f"Imported from {job.filename} ({source})",
                           ip_address=actor.ip_address)
        r.status, r.created_entity_id = "created", obj.id
        return

    obj = await db.get(Model, r.duplicate_of_id)
    if not obj or obj.deleted_at:
        r.status, r.errors = "skipped", [{"field": None, "message": "Matched record no longer exists"}]
        return
    values = {k: v for k, v in r.mapped.items() if hasattr(Model, k)}
    prev = _diff_values(obj, values)
    if not prev:
        r.status, r.errors = "skipped", [{"field": None, "message": "No changes against the existing record"}]
        return
    for k in prev:
        setattr(obj, k, values[k])
    obj.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{job.entity_type}.updated", entity_type=job.entity_type,
                       entity_id=obj.id, summary=f"Updated by import {job.filename} ({source})",
                       changes={k: {"from": prev[k], "to": values[k]} for k in prev}, ip_address=actor.ip_address)
    r.previous_values = prev
    r.status, r.created_entity_id = "updated", obj.id


async def _recount(db: AsyncSession, job: ImportJob, extra: dict | None = None) -> None:
    rows = await db.execute(
        select(ImportRow.status, func.count()).where(ImportRow.job_id == job.id).group_by(ImportRow.status)
    )
    counts = {k: v for k, v in (job.counts or {}).items() if k in ("existing_duplicates", "file_duplicates")}
    counts.update({s: int(c) for s, c in rows.all()})
    counts["total"] = job.row_count
    job.counts = {**counts, **(extra or {})}


async def commit(db: AsyncSession, job: ImportJob, body: CommitIn, actor: CurrentUser) -> ImportJob:
    if job.status != "validated":
        raise HTTPException(status.HTTP_409_CONFLICT, "Validate the import (dry run) before committing")
    src = await _require_active_source(db, job.data_source_id)
    models = _contacts() if job.entity_type != "property" else None
    source_name = src.provider[:200]
    prov = ProvenanceIn(source=source_name, observed_on=date.today(), verified=False)
    job_id = job.id

    rows = list(await db.scalars(
        select(ImportRow).where(ImportRow.job_id == job.id, ImportRow.status.in_(["valid", "duplicate"]))
        .order_by(ImportRow.row_number)
    ))
    job.options = {"on_duplicate": body.on_duplicate}
    try:
        for r in rows:
            if r.status == "duplicate" and not (body.on_duplicate == "update" and r.duplicate_of_id):
                r.status = "skipped"
                continue
            if job.entity_type == "property":
                await _commit_property(db, r, prov, actor)
            else:
                await _commit_contact(db, job, r, models, source_name, actor)
    except Exception as exc:  # noqa: BLE001 - record the failure on the job; committed rows stay rollback-able
        await db.rollback()
        # rollback() expires everything, including the request's User row behind `actor`; reload it
        # explicitly so audit.record's actor.id / actor.full_name don't trigger an async lazy load.
        await db.refresh(actor.user)
        job = await get_job(db, job_id)
        job.status = "failed"
        job.error = str(getattr(exc, "detail", None) or exc)[:2000]
        await _recount(db, job)
        await audit.record(db, actor=actor, action="import.failed", entity_type="import_job", entity_id=job.id,
                           summary=job.filename, changes={"error": job.error}, ip_address=actor.ip_address)
        await db.commit()
        return job

    job = await get_job(db, job_id)
    await _recount(db, job)
    job.status = "committed"
    job.committed_at = utcnow()
    job.committed_by_id = actor.id
    job.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="import.committed", entity_type="import_job", entity_id=job.id,
                       summary=f"{job.filename} · {source_name}",
                       changes={"counts": job.counts, "on_duplicate": body.on_duplicate}, ip_address=actor.ip_address)
    await db.commit()
    return job


# --- Rollback ---------------------------------------------------------------------------------

async def rollback(db: AsyncSession, job: ImportJob, actor: CurrentUser) -> ImportJob:
    if job.status not in ("committed", "failed"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Only committed imports can be rolled back")
    job_id = job.id
    rows = list(await db.scalars(
        select(ImportRow).where(ImportRow.job_id == job.id, ImportRow.status.in_(["created", "updated"]))
        .order_by(ImportRow.row_number.desc())
    ))
    now = utcnow()
    reverted = conflicts = 0

    if job.entity_type == "property":
        from app.modules.properties import service as properties
        from app.modules.properties.models import Property
        from app.modules.properties.schemas import PropertyUpdate

        prov = ProvenanceIn(source=f"Import rollback: {job.filename}"[:200], observed_on=date.today(), verified=False)
        Model: Any = Property
    else:
        Model = _contacts().Person if job.entity_type == "person" else _contacts().Organization

    for r in rows:
        obj = await db.get(Model, r.created_entity_id) if r.created_entity_id else None
        if not obj or obj.deleted_at:
            continue
        if r.status == "created":
            obj.deleted_at = now
            obj.updated_by_id = actor.id
            await audit.record(db, actor=actor, action=f"{job.entity_type}.archived", entity_type=job.entity_type,
                               entity_id=obj.id, summary=f"Import rollback: {job.filename}", ip_address=actor.ip_address)
            reverted += 1
            continue
        # Only restore fields that still hold the imported value; later edits are kept and reported.
        restore, kept = {}, []
        for field, old in (r.previous_values or {}).items():
            if to_jsonable(getattr(obj, field, None)) == (r.mapped or {}).get(field):
                restore[field] = old
            else:
                kept.append(field)
        if kept:
            conflicts += 1
            r.errors = [{"field": f, "message": "Changed after import; kept current value on rollback"} for f in kept]
        if not restore:
            continue
        if job.entity_type == "property":
            await properties.update(db, obj, PropertyUpdate.model_validate({**restore, "provenance": prov}), actor)
        else:
            changes = audit.diff(obj, restore)
            for k, v in restore.items():
                setattr(obj, k, v)
            obj.updated_by_id = actor.id
            await audit.record(db, actor=actor, action=f"{job.entity_type}.updated", entity_type=job.entity_type,
                               entity_id=obj.id, summary=f"Import rollback: {job.filename}", changes=changes,
                               ip_address=actor.ip_address)
        reverted += 1

    job = await get_job(db, job_id)
    await _recount(db, job, {"reverted": reverted, "rollback_conflicts": conflicts})
    job.status = "rolled_back"
    job.rolled_back_at = utcnow()
    job.rolled_back_by_id = actor.id
    job.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="import.rolled_back", entity_type="import_job", entity_id=job.id,
                       summary=job.filename, changes={"reverted": reverted, "conflicts": conflicts},
                       ip_address=actor.ip_address)
    await db.commit()
    return job
