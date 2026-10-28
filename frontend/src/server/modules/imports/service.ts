/**
 * Guided imports: upload -> map -> validate (dry run + dedupe preview) -> commit -> rollback.
 *
 * External data can only be committed against an active source/license record, and every created or
 * updated material fact carries that source as provenance.
 */
import { and, asc, desc, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { normalizeAddress, normalizeName } from "../../common/normalize";
import { provenanceIn } from "../../common/provenance";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, insertMany, patch } from "../../db/orm";
import { contactPoints, organizations, people } from "../contacts/schema";
import { properties } from "../properties/schema";
import { propertyCreate, propertyUpdate } from "../properties/schemas";
import * as propertiesService from "../properties/service";
import { decodeBytes, parseCsv, sniffDelimiter } from "./csv";
import {
  ENTITY_TYPES,
  dataSources,
  importJobs,
  importRows,
  type DataSource,
  type ImportJob,
  type ImportRow,
} from "./schema";
import type { CommitIn, DataSourceIn, DataSourceUpdate, TargetField } from "./schemas";
import { TARGETS, convert, suggestMapping, type Target } from "./targets";

export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_ROWS = 10_000;
const SAMPLE_ROWS = 5;
const PG_IN_CHUNK = 1000;
const INSERT_CHUNK = 500;

export function targetFields(entityType: string): TargetField[] {
  return TARGETS[entityType].map((t) => ({
    key: t.key, label: t.label, type: t.type, required: t.required, options: [...t.options], group: t.group,
  }));
}

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Table + permission-independent model lookup for the contact entity types (`hasattr(Model, k)` -> column keys). */
function contactTable(entityType: string): PgTable & { id: any; deleted_at: any } {
  return (entityType === "person" ? people : organizations) as never;
}
const columnKeys = (table: PgTable) => new Set(Object.keys(getTableColumns(table)));

// --- Data sources -----------------------------------------------------------------------------

export async function getSource(db: Db, sourceId: string): Promise<DataSource> {
  const src = await get(db, dataSources, sourceId);
  if (!src || src.deleted_at) throw new HttpError(404, "Data source not found");
  return src;
}

export async function createSource(db: Db, data: DataSourceIn, actor: CurrentUser): Promise<DataSource> {
  const src = await insert(db, dataSources, { ...data, created_by_id: actor.id, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "data_source.created", entity_type: "data_source", entity_id: src.id, summary: src.provider,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return src;
}

export async function updateSource(db: Db, src: DataSource, data: DataSourceUpdate, actor: CurrentUser): Promise<DataSource> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if ("provider" in values && !values.provider) delete values.provider;
  const changes = audit.diff(src, values);
  const hasChanges = Object.keys(changes).length > 0;
  if (Object.keys(values).length || hasChanges) {
    await patch(db, dataSources, src, { ...values, ...(hasChanges ? { updated_by_id: actor.id } : {}) } as never);
  }
  if (hasChanges) {
    await audit.record(db, {
      actor, action: "data_source.updated", entity_type: "data_source", entity_id: src.id, summary: src.provider,
      changes, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return src;
}

export async function archiveSource(db: Db, src: DataSource, actor: CurrentUser): Promise<void> {
  await patch(db, dataSources, src, { deleted_at: utcnow(), is_active: false, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "data_source.archived", entity_type: "data_source", entity_id: src.id, summary: src.provider,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

async function requireActiveSource(db: Db, sourceId: string | null | undefined): Promise<DataSource> {
  const src = sourceId ? await get(db, dataSources, sourceId) : undefined;
  if (!src || src.deleted_at || !src.is_active) {
    throw new HttpError(422, "An active data source with license terms is required before external data can be loaded");
  }
  return src;
}

export function dataSourceOut(s: DataSource, importCount = 0) {
  return {
    id: s.id, provider: s.provider, description: s.description, license_terms: s.license_terms,
    permitted_use: s.permitted_use, redistribution_allowed: s.redistribution_allowed, cadence: s.cadence, cost: s.cost,
    cost_notes: s.cost_notes, contact_name: s.contact_name, contact_email: s.contact_email, contact_phone: s.contact_phone,
    renewal_date: s.renewal_date, is_active: s.is_active, import_count: importCount, created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// --- Jobs -------------------------------------------------------------------------------------

export async function getJob(db: Db, jobId: string): Promise<ImportJob> {
  const job = await get(db, importJobs, jobId);
  if (!job || job.deleted_at) throw new HttpError(404, "Import not found");
  return job;
}

export function jobOut(job: ImportJob, dataSourceName: string | null = null) {
  return {
    id: job.id, entity_type: job.entity_type, data_source_id: job.data_source_id, data_source_name: dataSourceName,
    filename: job.filename, status: job.status, row_count: job.row_count, counts: job.counts,
    column_mapping: job.column_mapping, options: job.options, error: job.error, created_by_id: job.created_by_id,
    created_at: job.created_at, validated_at: job.validated_at, committed_at: job.committed_at,
    rolled_back_at: job.rolled_back_at,
  };
}

export async function jobDetail(db: Db, job: ImportJob) {
  let name: string | null = null;
  if (job.data_source_id) {
    const [s] = await db.select({ p: dataSources.provider }).from(dataSources).where(eq(dataSources.id, job.data_source_id)).limit(1);
    name = s?.p ?? null;
  }
  const sample = await db
    .select({ raw: importRows.raw })
    .from(importRows)
    .where(eq(importRows.job_id, job.id))
    .orderBy(asc(importRows.row_number))
    .limit(SAMPLE_ROWS);
  const headers = [...(job.headers ?? [])];
  return {
    ...jobOut(job, name),
    headers,
    sample: sample.map((r) => r.raw),
    suggested_mapping: suggestMapping(headers, TARGETS[job.entity_type]),
    fields: targetFields(job.entity_type),
  };
}

function parseCsvFile(text: string): [string[], Array<Record<string, string>>] {
  const records = parseCsv(text, sniffDelimiter(text));
  // Leading blank lines carry no header; skip them rather than treating the file as headerless.
  while (records.length && !records[0].length) records.shift();
  const rawHeaders = records.shift();
  if (!rawHeaders) throw new HttpError(422, "The file is empty");

  const headers: string[] = [];
  rawHeaders.forEach((h, i) => {
    let name = (h || "").trim() || `Column ${i + 1}`;
    const base = name;
    let n = 2;
    while (headers.includes(name)) name = `${base} (${n++})`;
    headers.push(name);
  });

  const rows: Array<Record<string, string>> = [];
  for (const cells of records) {
    if (!cells.some((c) => (c || "").trim())) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = i < cells.length && cells[i] ? cells[i].trim() : "";
    });
    rows.push(row);
    if (rows.length > MAX_ROWS) throw new HttpError(422, `Imports are limited to ${MAX_ROWS.toLocaleString("en-US")} rows per file`);
  }
  if (!rows.length) throw new HttpError(422, "The file has a header row but no data rows");
  return [headers, rows];
}

export async function upload(
  db: Db, o: { file: File; entity_type: string; data_source_id: string; actor: CurrentUser },
): Promise<ImportJob> {
  const { file, entity_type, data_source_id, actor } = o;
  if (!(ENTITY_TYPES as readonly string[]).includes(entity_type)) {
    throw new HttpError(422, `Unsupported entity type '${entity_type}'`);
  }
  const src = await requireActiveSource(db, data_source_id);
  const filename = (file.name || "upload.csv").slice(0, 255);
  if (![".csv", ".txt", ".tsv"].some((ext) => filename.toLowerCase().endsWith(ext))) {
    throw new HttpError(422, "Upload a CSV file");
  }
  if (file.size > MAX_BYTES) throw new HttpError(413, "File is larger than 15 MB");
  const content = new Uint8Array(await file.arrayBuffer());
  if (content.length > MAX_BYTES) throw new HttpError(413, "File is larger than 15 MB");
  const [headers, rows] = parseCsvFile(decodeBytes(content));

  const job = await insert(db, importJobs, {
    entity_type, data_source_id: src.id, filename, status: "uploaded", headers,
    column_mapping: suggestMapping(headers, TARGETS[entity_type]), options: {}, row_count: rows.length,
    counts: { total: rows.length }, created_by_id: actor.id, updated_by_id: actor.id,
  });
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await insertMany(
      db, importRows,
      rows.slice(i, i + INSERT_CHUNK).map((r, k) => ({ job_id: job.id, row_number: i + k + 1, raw: r, status: "pending", errors: [] })),
    );
  }
  await audit.record(db, {
    actor, action: "import.uploaded", entity_type: "import_job", entity_id: job.id,
    summary: `${filename} · ${rows.length} ${entity_type} rows from ${src.provider}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return job;
}

export async function setMapping(db: Db, job: ImportJob, mapping: Record<string, string | null>, actor: CurrentUser): Promise<ImportJob> {
  if (!["uploaded", "mapped", "validated"].includes(job.status)) {
    throw new HttpError(409, "Mapping can only change before the import is committed");
  }
  const valid = new Set(TARGETS[job.entity_type].map((t) => t.key));
  const headers = new Set(job.headers ?? []);
  const clean: Record<string, string | null> = {};
  const used: Record<string, string> = {};
  for (const [header, key0] of Object.entries(mapping)) {
    if (!headers.has(header)) throw new HttpError(422, `Unknown column '${header}'`);
    const key = key0 || null;
    if (key && !valid.has(key)) throw new HttpError(422, `Unknown target field '${key}'`);
    if (key && key in used) throw new HttpError(422, `'${key}' is mapped from both '${used[key]}' and '${header}'`);
    if (key) used[key] = header;
    clean[header] = key;
  }
  const changes = audit.diff(job, { column_mapping: clean });
  await patch(db, importJobs, job, { column_mapping: clean, status: "mapped", updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "import.mapped", entity_type: "import_job", entity_id: job.id, summary: job.filename,
    changes: Object.keys(changes).length ? changes : null, ip_address: actor.ip_address,
  });
  await db.commit();
  return job;
}

// --- Validation (dry run) ---------------------------------------------------------------------

type RowError = { field: string | null; message: string; column?: string };

function mapRow(raw: Record<string, any>, mapping: Record<string, string>, byKey: Map<string, Target>): [Record<string, any>, RowError[]] {
  const mapped: Record<string, any> = {};
  const errors: RowError[] = [];
  for (const [header, key] of Object.entries(mapping)) {
    if (!key) continue;
    const t = byKey.get(key)!;
    const [value, err] = convert(t, raw[header]);
    if (err) errors.push({ field: key, column: header, message: err });
    else if (value !== null && value !== undefined) mapped[key] = value;
  }
  const failed = new Set(errors.map((e) => e.field));
  for (const t of byKey.values()) {
    if (t.required && !(t.key in mapped) && !failed.has(t.key)) errors.push({ field: t.key, message: `${t.label} is required` });
  }
  return [mapped, errors];
}

function entityChecks(entityType: string, mapped: Record<string, any>, errors: RowError[]): void {
  if (entityType === "property") {
    const r = propertyCreate.safeParse(mapped);
    if (!r.success) {
      const seen = new Set(errors.map((e) => e.field));
      for (const e of r.error.issues) {
        const field = e.path.length ? String(e.path[0]) : null;
        if (!seen.has(field)) errors.push({ field, message: field ? `${field}: ${e.message}` : e.message });
      }
    }
  } else if (entityType === "person") {
    if (!mapped.full_name) {
      const name = [mapped.first_name, mapped.last_name].filter(Boolean).join(" ");
      if (name) mapped.full_name = name;
      else errors.push({ field: "full_name", message: "A full name or first/last name is required" });
    }
  }
}

/** Deterministic dedupe keys for a mapped row (shared by in-file and existing-record matching). */
function dedupeKeys(entityType: string, m: Record<string, any>): string[] {
  if (entityType === "property") return [normalizeAddress(m.address_line, m.city, m.state, m.postal_code)];
  if (entityType === "person") {
    if (m.primary_email) return [`email:${String(m.primary_email).toLowerCase()}`];
    return [`name:${String(m.full_name || "").trim().toLowerCase()}|${String(m.city || "").trim().toLowerCase()}`];
  }
  const keys = [`name:${normalizeName(m.name)}`];
  if (m.domain) keys.push(`domain:${String(m.domain).trim().toLowerCase()}`);
  return keys;
}

function* chunks<T>(items: T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += PG_IN_CHUNK) yield items.slice(i, i + PG_IN_CHUNK);
}

async function findExisting(db: Db, entityType: string, keys: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const setDefault = (k: string, id: string) => {
    if (!found.has(k)) found.set(k, id);
  };
  if (!keys.size) return found;
  if (entityType === "property") {
    for (const chunk of chunks([...keys].sort())) {
      const rows = await db
        .select({ id: properties.id, norm: properties.normalized_address, alt: properties.alternate_addresses })
        .from(properties)
        .where(
          and(
            isNull(properties.deleted_at),
            or(
              inArray(properties.normalized_address, chunk),
              sql`${properties.alternate_addresses} ?| array[${sql.join(chunk.map((c) => sql`${c}`), sql`, `)}]::text[]`,
            ),
          ),
        );
      for (const r of rows) for (const k of [r.norm, ...(r.alt ?? [])]) if (keys.has(k)) setDefault(k, r.id);
    }
    return found;
  }

  if (entityType === "person") {
    const emails = [...keys].filter((k) => k.startsWith("email:")).map((k) => k.slice(6));
    const names = [...new Set([...keys].filter((k) => k.startsWith("name:")).map((k) => k.slice(5).split("|")[0]))];
    for (const chunk of chunks(emails)) {
      const rows = await db
        .select({ id: people.id, email: sql<string>`lower(${people.primary_email})` })
        .from(people)
        .where(and(isNull(people.deleted_at), inArray(sql`lower(${people.primary_email})`, chunk)));
      for (const r of rows) setDefault(`email:${r.email}`, r.id);
    }
    for (const chunk of chunks(names.sort())) {
      const rows = await db
        .select({ id: people.id, name: people.full_name, city: people.city })
        .from(people)
        .where(and(isNull(people.deleted_at), inArray(sql`lower(${people.full_name})`, chunk)));
      for (const r of rows) setDefault(`name:${(r.name || "").trim().toLowerCase()}|${(r.city || "").trim().toLowerCase()}`, r.id);
    }
    return found;
  }

  const domains = [...keys].filter((k) => k.startsWith("domain:")).map((k) => k.slice(7));
  const wantedNames = new Set([...keys].filter((k) => k.startsWith("name:")));
  for (const chunk of chunks(domains)) {
    const rows = await db
      .select({ id: organizations.id, domain: sql<string>`lower(${organizations.domain})` })
      .from(organizations)
      .where(and(isNull(organizations.deleted_at), inArray(sql`lower(${organizations.domain})`, chunk)));
    for (const r of rows) setDefault(`domain:${r.domain}`, r.id);
  }
  if (wantedNames.size) {
    // Normalized-name match needs app-side normalization; narrow by the first word first.
    const firstWords = [...new Set([...wantedNames].filter((k) => k.slice(5)).map((k) => k.slice(5).split(" ")[0]))].sort();
    for (const chunk of chunks(firstWords)) {
      const rows = await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(and(isNull(organizations.deleted_at), or(...chunk.map((w) => sql`${organizations.name} ilike ${"%" + w + "%"}`))));
      for (const r of rows) {
        const key = `name:${normalizeName(r.name)}`;
        if (wantedNames.has(key)) setDefault(key, r.id);
      }
    }
  }
  return found;
}

export async function validate(db: Db, job: ImportJob, actor: CurrentUser): Promise<ImportJob> {
  if (!["uploaded", "mapped", "validated"].includes(job.status)) throw new HttpError(409, "This import has already been committed");
  const targets = TARGETS[job.entity_type];
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const mapping: Record<string, string> = {};
  for (const [h, k] of Object.entries(job.column_mapping ?? {})) if (k && byKey.has(k)) mapping[h] = k;
  const mappedFields = new Set(Object.values(mapping));
  const missing = targets.filter((t) => t.required && !mappedFields.has(t.key)).map((t) => t.label);
  if (job.entity_type === "person" && !["full_name", "first_name", "last_name"].some((f) => mappedFields.has(f))) {
    missing.push("Full name (or first/last name)");
  }
  if (missing.length) throw new HttpError(422, `Map the required field(s): ${missing.join(", ")}`);

  const rows = await db.select().from(importRows).where(eq(importRows.job_id, job.id)).orderBy(asc(importRows.row_number));
  const prepared = rows.map((r) => {
    const [mapped, errors] = mapRow(r.raw ?? {}, mapping, byKey);
    if (!errors.length) entityChecks(job.entity_type, mapped, errors);
    return { r, mapped, errors, keys: !errors.length ? dedupeKeys(job.entity_type, mapped) : [] };
  });

  const existing = await findExisting(db, job.entity_type, new Set(prepared.flatMap((p) => p.keys)));
  const seen = new Map<string, number>();
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  for (const { r, mapped, errors, keys } of prepared) {
    let status: string;
    let rowErrors: Array<Record<string, any>> = errors;
    let duplicateOf: string | null = null;
    if (errors.length) {
      status = "invalid";
    } else {
      const hitKey = keys.find((k) => existing.has(k));
      const earlierKey = keys.find((k) => seen.has(k));
      if (hitKey !== undefined) {
        status = "duplicate";
        duplicateOf = existing.get(hitKey)!;
        rowErrors = [{ field: null, message: "Matches an existing record" }];
        bump("existing_duplicates");
      } else if (earlierKey !== undefined) {
        status = "duplicate";
        rowErrors = [{ field: null, message: `Same record as row ${seen.get(earlierKey)} in this file` }];
        bump("file_duplicates");
      } else {
        status = "valid";
      }
      for (const k of keys) if (!seen.has(k)) seen.set(k, r.row_number);
    }
    bump(status);
    await patch(db, importRows, r, {
      mapped, errors: rowErrors, duplicate_of_id: duplicateOf, created_entity_id: null, previous_values: null, status,
    });
  }

  await patch(db, importJobs, job, {
    counts: {
      total: rows.length, valid: counts.valid ?? 0, invalid: counts.invalid ?? 0, duplicate: counts.duplicate ?? 0,
      existing_duplicates: counts.existing_duplicates ?? 0, file_duplicates: counts.file_duplicates ?? 0,
    },
    status: "validated", validated_at: utcnow(), error: null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "import.validated", entity_type: "import_job", entity_id: job.id, summary: job.filename,
    changes: { counts: job.counts }, ip_address: actor.ip_address,
  });
  await db.commit();
  return job;
}

// --- Commit -----------------------------------------------------------------------------------

/** Previous values for the fields the import would actually change. */
function diffValues(obj: Record<string, any>, values: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) {
    const cur = toJsonable(obj[k] ?? null);
    if (!audit.isEqual(cur, v)) out[k] = cur;
  }
  return out;
}

const digits = (v: string) => v.replace(/\D/g, "");

async function addContactPoints(db: Db, owner: Record<string, string>, mapped: Record<string, any>, source: string): Promise<void> {
  const email = mapped.primary_email;
  const phone = mapped.primary_phone || mapped.phone;
  if (email) {
    await insert(db, contactPoints, {
      ...owner, kind: "email", value: email, normalized_value: String(email).toLowerCase(), label: "Imported",
      is_primary: true, source,
    } as never);
  }
  if (phone) {
    await insert(db, contactPoints, {
      ...owner, kind: "phone", value: phone, normalized_value: digits(String(phone)).slice(-10), label: "Imported",
      is_primary: true, source,
    } as never);
  }
}

async function commitProperty(db: Db, r: ImportRow, prov: ReturnType<typeof provenanceIn.parse>, actor: CurrentUser): Promise<void> {
  if (r.status === "valid") {
    try {
      const p = await propertiesService.create(db, propertyCreate.parse({ ...r.mapped, provenance: prov }), actor);
      await patch(db, importRows, r, { status: "created", created_entity_id: p.id });
    } catch (exc) {
      if (!(exc instanceof HttpError) || exc.status !== 409) throw exc;
      const dupes: Array<{ id: string }> = exc.detail && typeof exc.detail === "object" ? (exc.detail as any).duplicates ?? [] : [];
      await patch(db, importRows, r, {
        status: "skipped", duplicate_of_id: dupes.length ? dupes[0].id : null,
        errors: [{ field: null, message: "Matched an existing record at commit time" }],
      });
    }
    return;
  }

  const p = r.duplicate_of_id ? await get(db, properties, r.duplicate_of_id) : undefined;
  if (!p || p.deleted_at) {
    await patch(db, importRows, r, { status: "skipped", errors: [{ field: null, message: "Matched record no longer exists" }] });
    return;
  }
  const mapped = r.mapped ?? {};
  const prev = diffValues(p, mapped);
  if (!Object.keys(prev).length) {
    await patch(db, importRows, r, { status: "skipped", errors: [{ field: null, message: "No changes against the existing record" }] });
    return;
  }
  const data = propertyUpdate.parse({ ...Object.fromEntries(Object.keys(prev).map((k) => [k, mapped[k]])), provenance: prov });
  await patch(db, importRows, r, { previous_values: prev, status: "updated", created_entity_id: p.id });
  await propertiesService.update(db, p, data, actor);
}

async function commitContact(db: Db, job: ImportJob, r: ImportRow, source: string, actor: CurrentUser): Promise<void> {
  const table = contactTable(job.entity_type);
  const keys = columnKeys(table);
  const mapped = r.mapped ?? {};
  if (r.status === "valid") {
    const values: Record<string, any> = Object.fromEntries(Object.entries(mapped).filter(([k]) => keys.has(k)));
    if (job.entity_type === "organization" && keys.has("normalized_name")) values.normalized_name = normalizeName(values.name);
    const obj = await insert(db, table, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
    const ownerKey = job.entity_type === "person" ? "person_id" : "organization_id";
    await addContactPoints(db, { [ownerKey]: (obj as any).id }, mapped, source);
    await audit.record(db, {
      actor, action: `${job.entity_type}.created`, entity_type: job.entity_type, entity_id: (obj as any).id,
      summary: `Imported from ${job.filename} (${source})`, ip_address: actor.ip_address,
    });
    await patch(db, importRows, r, { status: "created", created_entity_id: (obj as any).id });
    return;
  }

  const obj = r.duplicate_of_id ? await get(db, table as never, r.duplicate_of_id) : undefined;
  if (!obj || (obj as any).deleted_at) {
    await patch(db, importRows, r, { status: "skipped", errors: [{ field: null, message: "Matched record no longer exists" }] });
    return;
  }
  const values: Record<string, any> = Object.fromEntries(Object.entries(mapped).filter(([k]) => keys.has(k)));
  const prev = diffValues(obj as Record<string, any>, values);
  if (!Object.keys(prev).length) {
    await patch(db, importRows, r, { status: "skipped", errors: [{ field: null, message: "No changes against the existing record" }] });
    return;
  }
  await patch(db, table as never, obj as never, { ...Object.fromEntries(Object.keys(prev).map((k) => [k, values[k]])), updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: `${job.entity_type}.updated`, entity_type: job.entity_type, entity_id: (obj as any).id,
    summary: `Updated by import ${job.filename} (${source})`,
    changes: Object.fromEntries(Object.keys(prev).map((k) => [k, { from: prev[k], to: values[k] }])), ip_address: actor.ip_address,
  });
  await patch(db, importRows, r, { previous_values: prev, status: "updated", created_entity_id: (obj as any).id });
}

async function recount(db: Db, job: ImportJob, extra: Record<string, number> = {}): Promise<void> {
  const rows = await db
    .select({ s: importRows.status, c: sql<number>`count(*)::int` })
    .from(importRows)
    .where(eq(importRows.job_id, job.id))
    .groupBy(importRows.status);
  const counts: Record<string, number> = Object.fromEntries(
    Object.entries(job.counts ?? {}).filter(([k]) => k === "existing_duplicates" || k === "file_duplicates"),
  );
  for (const r of rows) counts[r.s] = Number(r.c);
  counts.total = job.row_count;
  await patch(db, importJobs, job, { counts: { ...counts, ...extra } });
}

const errorText = (exc: unknown): string => {
  if (exc instanceof HttpError) return typeof exc.detail === "string" ? exc.detail : JSON.stringify(exc.detail);
  return exc instanceof Error ? exc.message : String(exc);
};

export async function commit(db: Db, job: ImportJob, body: CommitIn, actor: CurrentUser): Promise<ImportJob> {
  if (job.status !== "validated") throw new HttpError(409, "Validate the import (dry run) before committing");
  const src = await requireActiveSource(db, job.data_source_id);
  const sourceName = src.provider.slice(0, 200);
  const prov = provenanceIn.parse({ source: sourceName, observed_on: todayStr(), verified: false });
  const jobId = job.id;

  const rows = await db
    .select()
    .from(importRows)
    .where(and(eq(importRows.job_id, job.id), inArray(importRows.status, ["valid", "duplicate"])))
    .orderBy(asc(importRows.row_number));
  await patch(db, importJobs, job, { options: { on_duplicate: body.on_duplicate } });
  try {
    for (const r of rows) {
      if (r.status === "duplicate" && !(body.on_duplicate === "update" && r.duplicate_of_id)) {
        await patch(db, importRows, r, { status: "skipped" });
        continue;
      }
      if (job.entity_type === "property") await commitProperty(db, r, prov, actor);
      else await commitContact(db, job, r, sourceName, actor);
    }
  } catch (exc) {
    // record the failure on the job; committed rows stay rollback-able
    await db.rollback();
    const failed = await getJob(db, jobId);
    await patch(db, importJobs, failed, { status: "failed", error: errorText(exc).slice(0, 2000) });
    await recount(db, failed);
    await audit.record(db, {
      actor, action: "import.failed", entity_type: "import_job", entity_id: failed.id, summary: failed.filename,
      changes: { error: failed.error }, ip_address: actor.ip_address,
    });
    await db.commit();
    return failed;
  }

  const done = await getJob(db, jobId);
  await recount(db, done);
  await patch(db, importJobs, done, { status: "committed", committed_at: utcnow(), committed_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "import.committed", entity_type: "import_job", entity_id: done.id,
    summary: `${done.filename} · ${sourceName}`, changes: { counts: done.counts, on_duplicate: body.on_duplicate },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return done;
}

// --- Rollback ---------------------------------------------------------------------------------

export async function rollback(db: Db, job: ImportJob, actor: CurrentUser): Promise<ImportJob> {
  if (!["committed", "failed"].includes(job.status)) throw new HttpError(409, "Only committed imports can be rolled back");
  const jobId = job.id;
  const rows = await db
    .select()
    .from(importRows)
    .where(and(eq(importRows.job_id, job.id), inArray(importRows.status, ["created", "updated"])))
    .orderBy(desc(importRows.row_number));
  const now = utcnow();
  let reverted = 0;
  let conflicts = 0;

  const isProperty = job.entity_type === "property";
  const prov = isProperty
    ? provenanceIn.parse({ source: `Import rollback: ${job.filename}`.slice(0, 200), observed_on: todayStr(), verified: false })
    : null;
  const table = (isProperty ? properties : contactTable(job.entity_type)) as any;

  for (const r of rows) {
    const obj = r.created_entity_id ? await get(db, table, r.created_entity_id) : undefined;
    if (!obj || obj.deleted_at) continue;
    if (r.status === "created") {
      await patch(db, table, obj, { deleted_at: now, updated_by_id: actor.id });
      await audit.record(db, {
        actor, action: `${job.entity_type}.archived`, entity_type: job.entity_type, entity_id: obj.id,
        summary: `Import rollback: ${job.filename}`, ip_address: actor.ip_address,
      });
      reverted++;
      continue;
    }
    // Only restore fields that still hold the imported value; later edits are kept and reported.
    const restore: Record<string, any> = {};
    const kept: string[] = [];
    for (const [field, old] of Object.entries(r.previous_values ?? {})) {
      if (audit.isEqual(toJsonable(obj[field] ?? null), (r.mapped ?? {})[field] ?? null)) restore[field] = old;
      else kept.push(field);
    }
    if (kept.length) {
      conflicts++;
      await patch(db, importRows, r, {
        errors: kept.map((f) => ({ field: f, message: "Changed after import; kept current value on rollback" })),
      });
    }
    if (!Object.keys(restore).length) continue;
    if (isProperty) {
      await propertiesService.update(db, obj, propertyUpdate.parse({ ...restore, provenance: prov }), actor);
    } else {
      const changes = audit.diff(obj, restore);
      await patch(db, table, obj, { ...restore, updated_by_id: actor.id });
      await audit.record(db, {
        actor, action: `${job.entity_type}.updated`, entity_type: job.entity_type, entity_id: obj.id,
        summary: `Import rollback: ${job.filename}`, changes, ip_address: actor.ip_address,
      });
    }
    reverted++;
  }

  const done = await getJob(db, jobId);
  await recount(db, done, { reverted, rollback_conflicts: conflicts });
  await patch(db, importJobs, done, { status: "rolled_back", rolled_back_at: utcnow(), rolled_back_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "import.rolled_back", entity_type: "import_job", entity_id: done.id, summary: done.filename,
    changes: { reverted, conflicts }, ip_address: actor.ip_address,
  });
  await db.commit();
  return done;
}

export type { SQL };
