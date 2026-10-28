import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink as rmFile } from "node:fs/promises";
import path from "node:path";

import {
  and, asc, desc, eq, exists, getTableColumns, gte, ilike, inArray, isNull, ne, or, sql, type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import jwt from "jsonwebtoken";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySearch, facetCounts, inFilter } from "../../common/query";
import { settings } from "../../config";
import { loadUser, type CurrentUser as CurrentUserT } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { ListParams } from "../../core/router";
import { utcnow } from "../../core/security";
import { withSession, type Db } from "../../db";
import { get as ormGet, insert, patch, remove } from "../../db/orm";
import { allows } from "../auth/permissions";
import { users } from "../auth/schema";
import { PROPERTY_TYPES, properties } from "../properties/schema";
import { completeness } from "../properties/service";
import { createTask } from "../tasks/service";
import * as ai from "./ai";
import { documentContent, registerAi } from "./claude_provider";
import {
  DOC_CLASSES, aiCalls, documentAccessLog, documentLinks, documents, extractedValues, extractionJobs,
  type Document, type DocumentLink, type ExtractedValue, type ExtractionJob,
} from "./schema";
import {
  citation as citationSchema, type DocumentUpdate, type DraftIn, type DraftSource, type ExtractIn, type LinkOut,
  type ManualValueIn, type SummarizeIn,
} from "./schemas";
import { filePath, storageRoot } from "./storage";

export { filePath, storageRoot };

const ENTITY = "document";
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const DETAIL_TEXT_CHARS = 200_000;
const VIEW_LOG_THROTTLE_MS = 5 * 60 * 1000;
const TEXT_MIME = new Set(["application/json", "application/xml"]);
// Only these types are ever served inline; everything else is forced to download.
export const INLINE_MIME = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown",
]);

// Root of a version chain: links, holds and retention apply to the logical document.
const ROOT = sql`coalesce(${documents.parent_document_id}, ${documents.id})`;

const today = () => new Date().toISOString().slice(0, 10);
/** Python `str.capitalize()`: first character upper-case, the rest lower-case. */
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// --- Extraction schemas ------------------------------------------------------------------------

const f = (field: string, type = "text"): ai.SchemaField => ({
  field,
  label: capitalize(field.replace(/_/g, " ")),
  type,
});

const PURCHASE = [f("purchase_price", "money"), f("earnest_money", "money"), f("feasibility_days", "number"),
  f("closing_days", "number"), f("effective_on", "date"), f("closing_on", "date"), f("buyer_name"), f("seller_name")];
const LEASE = [f("tenant_name"), f("landlord_name"), f("lease_type"), f("commencement_on", "date"),
  f("expiration_on", "date"), f("rentable_sf", "number"), f("base_rent_annual", "money"), f("rent_psf", "money"),
  f("renewal_options"), f("security_deposit", "money"), f("guarantor")];
const DEBT = [f("lender_name"), f("loan_amount", "money"), f("interest_rate", "percent"), f("maturity_on", "date"),
  f("amortization_months", "number"), f("io_months", "number"), f("prepayment"), f("recourse")];

export const CLASS_SCHEMAS: Record<string, ai.SchemaField[]> = {
  lease: LEASE,
  amendment: [f("amendment_on", "date"), f("expiration_on", "date"), f("base_rent_annual", "money"),
    f("rentable_sf", "number"), f("summary_of_changes")],
  estoppel: [f("tenant_name"), f("commencement_on", "date"), f("expiration_on", "date"),
    f("base_rent_monthly", "money"), f("security_deposit", "money"), f("defaults_claimed")],
  snda: [f("lender_name"), f("tenant_name"), f("effective_on", "date")],
  acquisition: PURCHASE,
  contract: PURCHASE,
  loi: PURCHASE,
  debt: DEBT,
  loan_agreement: DEBT,
  tax: [f("tax_year", "number"), f("parcel_apn"), f("assessed_value", "money"), f("tax_amount", "money"),
    f("due_on", "date")],
  insurance: [f("carrier"), f("policy_number"), f("coverage_amount", "money"), f("effective_on", "date"),
    f("expires_on", "date"), f("named_insured")],
  closing: [f("purchase_price", "money"), f("closing_on", "date"), f("buyer_name"), f("seller_name")],
  settlement_statement: [f("purchase_price", "money"), f("closing_on", "date"), f("prorations"),
    f("cash_to_close", "money")],
  survey: [f("legal_description"), f("parcel_apn"), f("land_area_acres", "number"), f("flood_zone"),
    f("encroachments")],
  title: [f("legal_description"), f("parcel_apn"), f("vested_owner"), f("exceptions"), f("effective_on", "date")],
  environmental: [f("report_date", "date"), f("recognized_conditions"), f("recommendations")],
  pca: [f("report_date", "date"), f("immediate_repairs_cost", "money"), f("reserve_recommendation", "money")],
  appraisal: [f("appraised_value", "money"), f("valuation_date", "date"), f("cap_rate", "percent"), f("noi", "money")],
  bov: [f("value_low", "money"), f("value_high", "money"), f("cap_rate", "percent"), f("noi", "money")],
  entity: [f("entity_name"), f("entity_type"), f("formation_state"), f("signatories")],
  correspondence: [f("sender"), f("recipient"), f("sent_on", "date"), f("subject")],
  other: [],
};

// Property fields a confirmed value may be applied to (through provenance, never directly by AI).
export const PROPERTY_FIELDS: ai.SchemaField[] = [
  f("building_area_sf", "number"), f("land_area_acres", "number"), f("year_built", "number"),
  f("year_renovated", "number"), f("parking_spaces", "number"), f("construction_class"),
  f("asking_price", "money"), f("last_sale_price", "money"), f("last_sale_date", "date"),
  f("occupancy_pct", "percent"), f("wale_years", "number"), f("noi", "money"), f("zoning"),
  f("future_land_use"), f("flood_zone"), f("traffic_count", "number"), f("property_type"),
  f("property_subtype"), f("county"), f("postal_code"),
];
export const PROPERTY_APPLICABLE = new Set(PROPERTY_FIELDS.map((x) => x.field));

export function extractionSchema(docClass: string, targetType: string | null | undefined, fields?: string[] | null) {
  let schema = [...(CLASS_SCHEMAS[docClass] ?? [])];
  if (targetType === "property") {
    const have = new Set(schema.map((s) => s.field));
    schema = [...schema, ...PROPERTY_FIELDS.filter((x) => !have.has(x.field))];
  }
  if (fields && fields.length) {
    const known = new Map<string, ai.SchemaField>();
    for (const s of [...schema, ...PROPERTY_FIELDS]) known.set(s.field, s);
    schema = fields.map((name) => known.get(name) ?? f(name));
  }
  return schema;
}

export function fieldType(docClass: string, field: string): string {
  for (const s of [...(CLASS_SCHEMAS[docClass] ?? []), ...PROPERTY_FIELDS]) {
    if (s.field === field) return s.type ?? "text";
  }
  return "text";
}

export function allSchemas(): Record<string, ai.SchemaField[]> {
  return { ...CLASS_SCHEMAS, _property: PROPERTY_FIELDS };
}

// --- Polymorphic record helpers ----------------------------------------------------------------

type Target = { table: PgTable & { id: any }; label: (r: any) => string | null | undefined };

// entity_type -> loader of the table + label getter. Missing modules are tolerated.
const TARGETS: Record<string, () => Promise<Target>> = {
  property: async () => ({ table: properties, label: (r) => r.name || r.address_line }),
  person: async () => ({ table: (await import("../contacts/schema")).people, label: (r) => r.full_name }),
  organization: async () => ({ table: (await import("../contacts/schema")).organizations, label: (r) => r.name }),
  opportunity: async () => ({ table: (await import("../pipeline/schema")).opportunities, label: (r) => r.title }),
  lease: async () => ({ table: (await import("../leases/schema")).leases, label: (r) => r.tenant_name }),
  loan: async () => ({ table: (await import("../debt/schema")).loans, label: (r) => r.lender_name }),
  contract: async () => ({ table: (await import("../contracts/schema")).contracts, label: (r) => r.title }),
  asset: async () => ({ table: (await import("../assets/schema")).assets, label: () => null }),
  uw_model: async () => ({ table: (await import("../underwriting/schema")).uwModels, label: (r) => r.name }),
};
// Linked records are only shown to users who can view the owning module.
const LINK_MODULES: Record<string, string> = {
  property: "properties", person: "contacts", organization: "contacts", opportunity: "pipeline",
  offer: "offers", contract: "contracts", closing: "closing", asset: "assets", lease: "leases",
  loan: "debt", disposition: "dispositions", work_order: "maintenance", vendor: "operations",
  capital_project: "operations", insurance_policy: "operations", capital_partner: "investors",
  listing: "brokerage", brokerage_deal: "brokerage", uw_model: "underwriting",
};

const keyOf = (type: string, id: string) => `${type}:${id}`;

async function targetSpec(entityType: string | null | undefined): Promise<Target | null> {
  const loader = TARGETS[entityType ?? ""];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    return null;
  }
}

interface Loaded {
  row: Record<string, any>;
  table: PgTable & { id: any };
  label: string | null;
}

async function loadTargets(db: Db, pairs: Array<[string, string]>): Promise<Map<string, Loaded>> {
  const byType = new Map<string, Set<string>>();
  for (const [t, i] of pairs) byType.set(t, (byType.get(t) ?? new Set()).add(i));
  const out = new Map<string, Loaded>();
  for (const [t, ids] of byType) {
    const spec = await targetSpec(t);
    if (!spec) continue;
    try {
      const rows = await db.select().from(spec.table as PgTable).where(inArray(spec.table.id, [...ids]));
      for (const row of rows as Record<string, any>[]) {
        let label: string | null = null;
        try {
          label = spec.label(row) ?? null;
        } catch {
          label = null;
        }
        out.set(keyOf(t, row.id), { row, table: spec.table, label });
      }
    } catch (exc) {
      // a missing table in another module must not break documents
      console.warn(`documents: could not load ${t} targets`, exc);
    }
  }
  return out;
}

async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter((i): i is string => !!i))];
  if (!set.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.full_name }).from(users).where(inArray(users.id, set));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function linkVisible(user: CurrentUserT, entityType: string): boolean {
  const module = LINK_MODULES[entityType];
  return module === undefined || user.can(module, "view");
}

// --- Storage -----------------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
  ".json": "application/json", ".xml": "application/xml", ".rtf": "application/rtf", ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".eml": "message/rfc822", ".mp3": "audio/mpeg", ".wav": "audio/x-wav", ".mp4": "video/mp4",
};

function guessMime(file: File): string {
  let ctype = (file.type || "").split(";")[0].trim().toLowerCase();
  if (!ctype || ctype === "application/octet-stream") {
    ctype = MIME_BY_EXT[path.extname(file.name || "").toLowerCase()] ?? "application/octet-stream";
  }
  return ctype.slice(0, 120);
}

/** Stream the upload to private storage (year/month folders) while hashing. Returns [key, size, sha256]. */
async function store(file: File): Promise<[string, number, string]> {
  const now = utcnow();
  let ext = path.extname(file.name || "").toLowerCase();
  if (!/^\.[a-z0-9]{1,9}$/.test(ext)) ext = "";
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `documents/${yyyy}/${mm}/${randomUUID().replace(/-/g, "")}${ext}`;
  const full = path.join(storageRoot(), key);
  await mkdir(path.dirname(full), { recursive: true });
  const digest = createHash("sha256");
  let size = 0;
  const fh = await open(full, "w");
  try {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let off = 0; off < value.length; off += CHUNK) {
        const chunk = value.subarray(off, off + CHUNK);
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          throw new HttpError(413, `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`);
        }
        digest.update(chunk);
        await fh.write(chunk);
      }
    }
    if (size === 0) throw new HttpError(422, "File is empty");
  } catch (err) {
    await fh.close().catch(() => {});
    await rmFile(full).catch(() => {});
    throw err;
  }
  await fh.close();
  return [key, size, digest.digest("hex")];
}

async function readText(key: string, mime: string, size: number): Promise<string | null> {
  if (!(mime.startsWith("text/") || TEXT_MIME.has(mime)) || size > MAX_TEXT_BYTES) return null;
  try {
    return (await readFile(filePath(key))).toString("utf-8").slice(0, MAX_TEXT_CHARS);
  } catch {
    return null;
  }
}

// --- Queries -----------------------------------------------------------------------------------

export interface DocFilters {
  q?: string;
  doc_class?: string[];
  sensitivity?: string[];
  linked_type?: string[];
  extraction_status?: string[];
  entity_type?: string;
  entity_id?: string;
  legal_hold?: boolean;
  uploaded_by_id?: string;
  created_from?: string;
  created_to?: string;
}

function linkedRoots(entityTypes?: string[], entityId?: string): SQL {
  const where = and(
    entityTypes && entityTypes.length ? inArray(documentLinks.entity_type, entityTypes) : undefined,
    entityId ? eq(documentLinks.entity_id, entityId) : undefined,
  );
  return where
    ? sql`select ${documentLinks.document_id} from ${documentLinks} where ${where}`
    : sql`select ${documentLinks.document_id} from ${documentLinks}`;
}

export function visible(user: CurrentUserT): SQL | undefined {
  return user.can("documents", "view_sensitive") ? undefined : eq(documents.is_sensitive, false);
}

export function buildQuery(fl: DocFilters, user: CurrentUserT, o: { skip?: Set<string> } = {}): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = documents;
  let sensitivity: SQL | undefined;
  if (!skip.has("sensitivity") && fl.sensitivity?.length) {
    const wanted = new Set(fl.sensitivity.map((v) => v === "sensitive"));
    if (wanted.size === 1) sensitivity = eq(t.is_sensitive, [...wanted][0]);
  }
  return and(
    isNull(t.deleted_at),
    eq(t.is_latest, true),
    visible(user),
    applySearch(fl.q, [t.title, t.filename, t.description]),
    skip.has("doc_class") ? undefined : inFilter(t.doc_class, fl.doc_class),
    sensitivity,
    !skip.has("linked_type") && fl.linked_type?.length ? sql`${ROOT} in (${linkedRoots(fl.linked_type)})` : undefined,
    skip.has("extraction_status") ? undefined : inFilter(t.extraction_status, fl.extraction_status),
    fl.entity_type && fl.entity_id ? sql`${ROOT} in (${linkedRoots([fl.entity_type], fl.entity_id)})` : undefined,
    fl.legal_hold !== undefined ? eq(t.legal_hold, fl.legal_hold) : undefined,
    fl.uploaded_by_id ? eq(t.uploaded_by_id, fl.uploaded_by_id) : undefined,
    fl.created_from ? sql`${t.created_at}::date >= ${fl.created_from}::date` : undefined,
    fl.created_to ? sql`${t.created_at}::date <= ${fl.created_to}::date` : undefined,
  );
}

export async function facets(db: Db, fl: DocFilters, user: CurrentUserT) {
  const sens = await facetCounts(db, documents, buildQuery(fl, user, { skip: new Set(["sensitivity"]) }), documents.is_sensitive);
  const linked = await db
    .select({ k: documentLinks.entity_type, n: sql<number>`count(distinct ${documents.id})::int` })
    .from(documentLinks)
    .innerJoin(documents, sql`${documentLinks.document_id} = ${ROOT}`)
    .where(buildQuery(fl, user, { skip: new Set(["linked_type"]) }))
    .groupBy(documentLinks.entity_type);
  return {
    doc_class: await facetCounts(db, documents, buildQuery(fl, user, { skip: new Set(["doc_class"]) }), documents.doc_class),
    sensitivity: { sensitive: sens["true"] ?? 0, standard: sens["false"] ?? 0 },
    linked_type: Object.fromEntries(linked.filter((r) => r.k).map((r) => [String(r.k), Number(r.n)])),
    extraction_status: await facetCounts(
      db, documents, buildQuery(fl, user, { skip: new Set(["extraction_status"]) }), documents.extraction_status,
    ),
  };
}

export async function get(db: Db, documentId: string, user: CurrentUserT): Promise<Document> {
  const d = await ormGet(db, documents, documentId);
  if (!d || d.deleted_at) throw new HttpError(404, "Document not found");
  if (d.is_sensitive && !user.can("documents", "view_sensitive")) {
    throw new HttpError(403, "This document is marked sensitive");
  }
  return d;
}

async function chain(db: Db, d: Document, includeDeleted = false): Promise<Document[]> {
  return db
    .select()
    .from(documents)
    .where(and(sql`${ROOT} = ${rootOf(d)}`, includeDeleted ? undefined : isNull(documents.deleted_at)))
    .orderBy(desc(documents.version));
}

const rootOf = (d: Pick<Document, "id" | "parent_document_id">): string => d.parent_document_id || d.id;

async function linksFor(db: Db, roots: Set<string>, user: CurrentUserT): Promise<Map<string, LinkOut[]>> {
  if (!roots.size) return new Map();
  const rows = await db
    .select()
    .from(documentLinks)
    .where(inArray(documentLinks.document_id, [...roots]))
    .orderBy(asc(documentLinks.created_at));
  const links = rows.filter((l) => linkVisible(user, l.entity_type));
  const loaded = await loadTargets(db, links.map((l) => [l.entity_type, l.entity_id]));
  const out = new Map<string, LinkOut[]>();
  for (const l of links) {
    const list = out.get(l.document_id) ?? [];
    list.push({
      id: l.id, document_id: l.document_id, entity_type: l.entity_type, entity_id: l.entity_id,
      label: loaded.get(keyOf(l.entity_type, l.entity_id))?.label ?? null, created_at: l.created_at,
    });
    out.set(l.document_id, list);
  }
  return out;
}

export async function toListItems(db: Db, docs: Document[], user: CurrentUserT) {
  if (!docs.length) return [];
  const links = await linksFor(db, new Set(docs.map(rootOf)), user);
  const names = await userNames(db, docs.map((d) => d.uploaded_by_id));
  const pendingRows = await db
    .select({ id: extractedValues.document_id, n: sql<number>`count(*)::int` })
    .from(extractedValues)
    .where(and(
      inArray(extractedValues.document_id, docs.map((d) => d.id)), eq(extractedValues.status, "pending"),
      isNull(extractedValues.deleted_at),
    ))
    .groupBy(extractedValues.document_id);
  const pending = new Map(pendingRows.map((r) => [r.id, Number(r.n)]));
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    doc_class: d.doc_class,
    classification_source: d.classification_source,
    filename: d.filename,
    mime_type: d.mime_type,
    size_bytes: d.size_bytes,
    version: d.version,
    is_sensitive: d.is_sensitive,
    legal_hold: d.legal_hold,
    retention_until: d.retention_until,
    extraction_status: d.extraction_status,
    uploaded_by_id: d.uploaded_by_id,
    uploaded_by_name: d.uploaded_by_id ? names.get(d.uploaded_by_id) ?? null : null,
    pending_values: pending.get(d.id) ?? 0,
    links: links.get(rootOf(d)) ?? [],
    tags: d.tags || [],
    created_at: d.created_at,
    updated_at: d.updated_at,
  }));
}

export function deleteBlockReason(d: Document): string | null {
  if (d.legal_hold) return "Document is on legal hold";
  if (d.retention_until && d.retention_until > today()) return `Retention period runs until ${d.retention_until}`;
  return null;
}

async function duplicates(db: Db, d: Document, user: CurrentUserT) {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.sha256, d.sha256), ne(documents.id, d.id), isNull(documents.deleted_at), visible(user)))
    .orderBy(asc(documents.created_at))
    .limit(5);
  return rows.map((x) => ({ id: x.id, title: x.title, filename: x.filename, version: x.version, created_at: x.created_at }));
}

export async function toOut(db: Db, d: Document, user: CurrentUserT) {
  const item = (await toListItems(db, [d], user))[0];
  const reason = deleteBlockReason(d);
  return {
    ...item,
    description: d.description,
    classification_confidence: d.classification_confidence,
    sha256: d.sha256,
    parent_document_id: d.parent_document_id,
    is_latest: d.is_latest,
    has_text: Boolean(d.text_content),
    text_content: d.text_content ? d.text_content.slice(0, DETAIL_TEXT_CHARS) : null,
    text_source: d.text_source,
    can_delete: reason === null && user.can("documents", "delete"),
    delete_blocked_reason: reason,
    duplicates: await duplicates(db, d, user),
  };
}

// --- Access logging & signed URLs --------------------------------------------------------------

/** Writes document_access_log + audit. Does not commit. */
export async function logAccess(
  db: Db,
  d: Document,
  o: { action: string; actor: audit.Actor | null; ip: string | null; throttle?: boolean },
): Promise<void> {
  const userId = o.actor?.id ?? null;
  if (o.throttle && userId) {
    const [recent] = await db
      .select({ id: documentAccessLog.id })
      .from(documentAccessLog)
      .where(and(
        eq(documentAccessLog.document_id, d.id), eq(documentAccessLog.user_id, userId),
        eq(documentAccessLog.action, o.action), gte(documentAccessLog.occurred_at, new Date(Date.now() - VIEW_LOG_THROTTLE_MS)),
      ))
      .limit(1);
    if (recent) return;
  }
  await insert(db, documentAccessLog, { document_id: d.id, user_id: userId, action: o.action, ip_address: o.ip } as never);
  await audit.record(db, {
    actor: o.actor, action: `document.${o.action}`, entity_type: ENTITY, entity_id: d.id, summary: d.title, ip_address: o.ip,
  });
}

/** Short-lived download link. The token is the credential, so browsers can open it directly. */
export function signedUrl(documentId: string, minutes = 10, o: { user_id?: string | null; inline?: boolean } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    purpose: "doc",
    doc: documentId,
    disp: o.inline ? "inline" : "attachment",
    iat: now,
    exp: now + minutes * 60,
  };
  if (o.user_id) payload.sub = o.user_id;
  const token = jwt.sign(payload, settings.JWT_SECRET, { algorithm: settings.JWT_ALGORITHM });
  return `${settings.API_PREFIX}/documents/download?token=${token}`;
}

export function canInline(mime: string): boolean {
  return INLINE_MIME.has(mime);
}

export async function resolveDownload(db: Db, token: string, ip: string | null): Promise<[Document, string, boolean]> {
  const denied = () => new HttpError(403, "This link is invalid or has expired");
  let payload: Record<string, any>;
  try {
    payload = jwt.verify(token, settings.JWT_SECRET, { algorithms: [settings.JWT_ALGORITHM] }) as Record<string, any>;
  } catch {
    throw denied();
  }
  if (payload.purpose !== "doc" || !payload.doc) throw denied();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(payload.doc))) throw denied();
  const d = await ormGet(db, documents, payload.doc);
  if (!d || d.deleted_at) throw new HttpError(404, "Document not found");

  let actor: audit.Actor | null = null;
  if (payload.sub) {
    const user = await loadUser(db, payload.sub);
    if (!user || user.status !== "active" || user.deleted_at) throw denied();
    const perms = ((user.role.permissions as Record<string, string[]>) ?? {});
    if (!allows(perms, "documents", "view") || (d.is_sensitive && !allows(perms, "documents", "view_sensitive"))) {
      throw denied();
    }
    actor = user;
  }

  const inline = payload.disp === "inline" && canInline(d.mime_type);
  const p = filePath(d.storage_key);
  const ok = await stat(p).then((st) => st.isFile()).catch(() => false);
  if (!ok) throw new HttpError(404, "File is missing from storage");
  await logAccess(db, d, { action: inline ? "preview" : "download", actor, ip });
  await db.commit();
  return [d, p, inline];
}

// --- Mutations ---------------------------------------------------------------------------------

function cleanTags(raw: string[] | string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const items = typeof raw === "string" ? raw.split(",") : raw;
  const out: string[] = [];
  for (const t of items.map((i) => i.trim().slice(0, 60))) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function checkClass(docClass: string | null | undefined): void {
  if (docClass !== null && docClass !== undefined && !DOC_CLASSES.includes(docClass)) {
    throw new HttpError(422, `Unknown document class '${docClass}'`);
  }
}

async function queueJob(
  db: Db,
  d: Document,
  actorId: string | null,
  o: { target_type?: string | null; target_id?: string | null; fields?: string[] | null } = {},
): Promise<ExtractionJob> {
  let { target_type: targetType, target_id: targetId } = o;
  if (!(targetType && targetId)) {
    const links = await db
      .select()
      .from(documentLinks)
      .where(eq(documentLinks.document_id, rootOf(d)))
      .orderBy(asc(documentLinks.created_at));
    const pick = links.find((l) => l.entity_type === "property") ?? links[0];
    if (pick) [targetType, targetId] = [pick.entity_type, pick.entity_id];
  }
  const job = await insert(db, extractionJobs, {
    document_id: d.id, status: "queued", target_entity_type: targetType ?? null, target_entity_id: targetId ?? null,
    fields: o.fields || [], created_by_id: actorId, updated_by_id: actorId,
  } as never);
  await patch(db, documents, d, { extraction_status: "queued" });
  return job;
}

export async function upload(
  db: Db,
  o: {
    file: File;
    actor: CurrentUserT;
    title?: string | null;
    doc_class?: string | null;
    description?: string | null;
    is_sensitive?: boolean;
    retention_until?: string | null;
    tags?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    auto_extract?: boolean;
  },
): Promise<[Document, ExtractionJob | null]> {
  const { file, actor, doc_class, entity_type, entity_id } = o;
  const isSensitive = o.is_sensitive ?? false;
  checkClass(doc_class);
  if (isSensitive && !actor.can("documents", "view_sensitive")) {
    throw new HttpError(403, "Marking a document sensitive requires documents:view_sensitive");
  }
  if (Boolean(entity_type) !== Boolean(entity_id)) {
    throw new HttpError(422, "entity_type and entity_id must be sent together");
  }
  const filename = (path.basename(file.name || "upload") || "upload").slice(0, 300);
  const mime = guessMime(file);
  const [key, size, sha] = await store(file);
  try {
    const text = await readText(key, mime, size);
    const d = await insert(db, documents, {
      title: (o.title || path.parse(filename).name || filename).slice(0, 300),
      description: o.description ?? null,
      doc_class: doc_class || "other",
      classification_source: doc_class ? "manual" : "default",
      filename, mime_type: mime, size_bytes: size, sha256: sha, storage_key: key, version: 1,
      is_latest: true, retention_until: o.retention_until ?? null, is_sensitive: isSensitive,
      uploaded_by_id: actor.id, tags: cleanTags(o.tags), created_by_id: actor.id, updated_by_id: actor.id,
      text_content: text, text_source: text ? "file" : null,
    } as never);
    if (entity_type && entity_id) await link(db, d.id, entity_type, entity_id, actor);
    const job = (o.auto_extract ?? true) ? await queueJob(db, d, actor.id) : null;
    await audit.record(db, {
      actor, action: "document.uploaded", entity_type: ENTITY, entity_id: d.id, summary: `${d.title} (${filename})`,
      ip_address: actor.ip_address, changes: { doc_class: d.doc_class, size_bytes: size, sha256: sha },
    });
    await events.emit(db, "document.uploaded", { document_id: d.id, actor });
    await db.commit();
    return [d, job];
  } catch (err) {
    await db.rollback();
    await rmFile(filePath(key)).catch(() => {});
    throw err;
  }
}

export async function newVersion(
  db: Db,
  base: Document,
  o: { file: File; actor: CurrentUserT; auto_extract?: boolean },
): Promise<[Document, ExtractionJob | null]> {
  const { file, actor } = o;
  const ch = await chain(db, base);
  const latest = ch.find((c) => c.is_latest) ?? ch[0] ?? base;
  const filename = (path.basename(file.name || latest.filename) || latest.filename).slice(0, 300);
  const mime = guessMime(file);
  const [key, size, sha] = await store(file);
  try {
    await db.update(documents).set({ is_latest: false }).where(sql`${ROOT} = ${rootOf(base)}`);
    const text = await readText(key, mime, size);
    const d = await insert(db, documents, {
      title: latest.title, description: latest.description, doc_class: latest.doc_class,
      classification_source: latest.classification_source,
      classification_confidence: latest.classification_confidence,
      filename, mime_type: mime, size_bytes: size, sha256: sha, storage_key: key,
      version: ch.length ? Math.max(...ch.map((c) => c.version)) + 1 : base.version + 1,
      parent_document_id: rootOf(base), is_latest: true, retention_until: latest.retention_until,
      legal_hold: latest.legal_hold, is_sensitive: latest.is_sensitive, uploaded_by_id: actor.id,
      tags: [...(latest.tags || [])], created_by_id: actor.id, updated_by_id: actor.id,
      text_content: text, text_source: text ? "file" : null,
    } as never);
    const job = (o.auto_extract ?? true) ? await queueJob(db, d, actor.id) : null;
    await audit.record(db, {
      actor, action: "document.versioned", entity_type: ENTITY, entity_id: d.id, summary: `${d.title} v${d.version}`,
      ip_address: actor.ip_address, changes: { previous_version_id: latest.id, version: d.version, sha256: sha },
    });
    await events.emit(db, "document.uploaded", { document_id: d.id, actor });
    await db.commit();
    return [d, job];
  } catch (err) {
    await db.rollback();
    await rmFile(filePath(key)).catch(() => {});
    throw err;
  }
}

export async function updateDocument(db: Db, d: Document, data: DocumentUpdate, actor: CurrentUserT): Promise<Document> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  checkClass(values.doc_class);
  for (const key of ["title", "doc_class", "is_sensitive", "legal_hold"]) {
    if (key in values && values[key] === null) delete values[key];
  }
  if ("tags" in values) values.tags = cleanTags(values.tags);
  if (values.legal_hold === false && d.legal_hold && !actor.can("documents", "approve")) {
    throw new HttpError(403, "Releasing a legal hold requires documents:approve");
  }
  if ("retention_until" in values && d.retention_until && !actor.can("documents", "approve")) {
    const next = values.retention_until;
    if (next === null || next < d.retention_until) {
      throw new HttpError(403, "Shortening retention requires documents:approve");
    }
  }
  if (values.is_sensitive && !actor.can("documents", "view_sensitive")) {
    throw new HttpError(403, "Marking a document sensitive requires documents:view_sensitive");
  }
  if ("doc_class" in values && values.doc_class !== d.doc_class) {
    values.classification_source = "manual";
    values.classification_confidence = null;
  }

  const changes = audit.diff(d, values);
  if (!Object.keys(changes).length) return d;
  // Metadata, holds and retention belong to the logical document: apply to every version.
  const ids = (await chain(db, d, true)).map((c) => c.id);
  await db.update(documents).set({ ...values, updated_by_id: actor.id } as never).where(inArray(documents.id, ids));
  Object.assign(d, values, { updated_by_id: actor.id });
  let action = "document.updated";
  if ("legal_hold" in changes) action = values.legal_hold ? "document.legal_hold_placed" : "document.legal_hold_released";
  await audit.record(db, {
    actor, action, entity_type: ENTITY, entity_id: d.id, changes, summary: d.title, ip_address: actor.ip_address,
  });
  await db.commit();
  return d;
}

export async function setText(db: Db, d: Document, text: string, actor: CurrentUserT): Promise<Document> {
  const oldLen = (d.text_content || "").length;
  const content = text.slice(0, MAX_TEXT_CHARS) || null;
  await patch(db, documents, d, {
    text_content: content, text_source: content ? "manual" : null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "document.text_set", entity_type: ENTITY, entity_id: d.id,
    changes: { text_length: { from: oldLen, to: (d.text_content || "").length } }, summary: d.title,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return d;
}

export async function deleteDocument(db: Db, d: Document, actor: CurrentUserT): Promise<void> {
  const reason = deleteBlockReason(d);
  if (reason) throw new HttpError(409, `Cannot delete: ${reason.toLowerCase()}`);
  const wasLatest = d.is_latest;
  await patch(db, documents, d, { deleted_at: utcnow(), updated_by_id: actor.id, ...(wasLatest ? { is_latest: false } : {}) });
  if (wasLatest) {
    const [prev] = await db
      .select()
      .from(documents)
      .where(and(sql`${ROOT} = ${rootOf(d)}`, ne(documents.id, d.id), isNull(documents.deleted_at)))
      .orderBy(desc(documents.version))
      .limit(1);
    if (prev) await patch(db, documents, prev, { is_latest: true });
  }
  await audit.record(db, {
    actor, action: "document.deleted", entity_type: ENTITY, entity_id: d.id, summary: `${d.title} v${d.version}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

/** Public contract: link a document (any version) to a record. Idempotent. Does not commit. */
export async function link(
  db: Db,
  documentId: string,
  entityType: string,
  entityId: string,
  actor: (audit.Actor & { ip_address?: string | null }) | null,
): Promise<DocumentLink> {
  const d = await ormGet(db, documents, documentId);
  if (!d || d.deleted_at) throw new HttpError(404, "Document not found");
  if (!/^[a-z][a-z_]{1,39}$/.test(entityType || "")) throw new HttpError(422, "Invalid entity type");
  const root = rootOf(d);
  const [existing] = await db
    .select()
    .from(documentLinks)
    .where(and(eq(documentLinks.document_id, root), eq(documentLinks.entity_type, entityType), eq(documentLinks.entity_id, entityId)))
    .limit(1);
  if (existing) return existing;
  const lnk = await insert(db, documentLinks, {
    document_id: root, entity_type: entityType, entity_id: entityId, created_by_id: actor?.id ?? null,
  } as never);
  await audit.record(db, {
    actor, action: "document.linked", entity_type: ENTITY, entity_id: d.id,
    changes: { entity_type: entityType, entity_id: entityId }, summary: d.title, ip_address: actor?.ip_address ?? null,
  });
  return lnk;
}

export async function unlink(db: Db, d: Document, linkId: string, actor: CurrentUserT): Promise<void> {
  const lnk = await ormGet(db, documentLinks, linkId);
  if (!lnk || lnk.document_id !== rootOf(d)) throw new HttpError(404, "Link not found");
  await audit.record(db, {
    actor, action: "document.unlinked", entity_type: ENTITY, entity_id: d.id,
    changes: { entity_type: lnk.entity_type, entity_id: lnk.entity_id }, summary: d.title, ip_address: actor.ip_address,
  });
  await remove(db, documentLinks, lnk);
  await db.commit();
}

export async function versions(db: Db, d: Document, user: CurrentUserT) {
  return toListItems(db, await chain(db, d), user);
}

export async function accessLog(db: Db, d: Document) {
  const ids = (await chain(db, d, true)).map((c) => c.id);
  const rows = await db
    .select()
    .from(documentAccessLog)
    .where(inArray(documentAccessLog.document_id, ids))
    .orderBy(desc(documentAccessLog.occurred_at))
    .limit(200);
  const names = await userNames(db, rows.map((r) => r.user_id));
  return rows.map((r) => ({
    id: r.id, action: r.action, occurred_at: r.occurred_at, user_id: r.user_id,
    user_name: r.user_id ? names.get(r.user_id) ?? null : null, ip_address: r.ip_address,
  }));
}

// --- Extraction workflow -----------------------------------------------------------------------

export const jobOut = (j: ExtractionJob) => ({
  id: j.id, document_id: j.document_id, status: j.status, target_entity_type: j.target_entity_type,
  target_entity_id: j.target_entity_id, fields: j.fields, provider: j.provider, model: j.model,
  values_count: j.values_count, message: j.message, started_at: j.started_at, finished_at: j.finished_at,
  created_at: j.created_at,
});

/** Returns [job, created]. An already queued/running job is returned instead of starting another. */
export async function requestExtraction(
  db: Db,
  d: Document,
  body: ExtractIn,
  actor: CurrentUserT,
): Promise<[ExtractionJob, boolean]> {
  if (Boolean(body.target_entity_type) !== Boolean(body.target_entity_id)) {
    throw new HttpError(422, "Target type and id must be sent together");
  }
  // Jobs older than 15 minutes are treated as abandoned (e.g. the worker restarted) and do not block a re-run.
  const [running] = await db
    .select()
    .from(extractionJobs)
    .where(and(
      eq(extractionJobs.document_id, d.id), inArray(extractionJobs.status, ["queued", "running"]),
      gte(extractionJobs.created_at, new Date(Date.now() - 15 * 60 * 1000)),
    ))
    .limit(1);
  if (running) return [running, false];
  const job = await queueJob(db, d, actor.id, {
    target_type: body.target_entity_type, target_id: body.target_entity_id, fields: body.fields,
  });
  await audit.record(db, {
    actor, action: "document.extraction_requested", entity_type: ENTITY, entity_id: d.id,
    changes: { target_entity_type: job.target_entity_type, target_entity_id: job.target_entity_id },
    summary: d.title, ip_address: actor.ip_address,
  });
  await db.commit();
  return [job, true];
}

async function finish(db: Db, job: ExtractionJob, d: Document, state: string, message: string): Promise<void> {
  await patch(db, extractionJobs, job, { status: state, message, finished_at: utcnow() });
  await patch(db, documents, d, { extraction_status: state });
}

const clamp = (v: unknown): number => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || Number.isNaN(n) ? 0 : Math.max(0, Math.min(1, n));
};

const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Math.trunc(Number(v));
  return Number.isNaN(n) ? null : n;
};

/** The provider, registering Claude on first use when a key is configured (graceful NullProvider otherwise). */
function provider(): ai.AIProvider {
  if (ai.getProvider().name === "none") registerAi();
  return ai.getProvider();
}

/** Background task entry point. Uses its own session; never raises into the request path. */
export async function runExtraction(jobId: string): Promise<void> {
  try {
    await withSession(async (db) => {
      try {
        await runExtractionInner(db, jobId);
      } catch (exc) {
        console.error(`documents: extraction job ${jobId} failed`, exc);
        await db.rollback();
        const job = await ormGet(db, extractionJobs, jobId);
        if (job) {
          const d = await ormGet(db, documents, job.document_id);
          await patch(db, extractionJobs, job, {
            status: "failed", message: (exc instanceof Error ? exc.message : String(exc)).slice(0, 2000),
            finished_at: utcnow(),
          });
          if (d) await patch(db, documents, d, { extraction_status: "failed" });
          await db.commit();
        }
      }
    });
  } catch (err) {
    console.error(`documents: extraction job ${jobId} could not be recorded`, err);
  }
}

async function runExtractionInner(db: Db, jobId: string): Promise<void> {
  const job = await ormGet(db, extractionJobs, jobId);
  if (!job || job.status !== "queued") return;
  const d = await ormGet(db, documents, job.document_id);
  if (!d || d.deleted_at) {
    await patch(db, extractionJobs, job, { status: "failed", message: "Document is no longer available", finished_at: utcnow() });
    await db.commit();
    return;
  }

  const prov = provider();
  await patch(db, extractionJobs, job, { provider: prov.name, model: prov.model });
  if (!prov.available) {
    await finish(db, job, d, "skipped", "No AI provider is configured. Values can be entered manually with citations.");
    await db.commit();
    return;
  }
  let [text, pdfPath] = [d.text_content || "", null as string | null];
  if ((d.mime_type || "").toLowerCase() === "application/pdf") {
    // providers that read PDFs natively (Claude) get the stored file
    [text, pdfPath] = documentContent(d);
  }
  if (!text && !pdfPath) {
    await finish(db, job, d, "skipped", "No document text is available. Add the text, then run extraction again.");
    await db.commit();
    return;
  }
  const pdfKw = pdfPath ? { pdf_path: pdfPath } : {};

  await patch(db, extractionJobs, job, { status: "running", started_at: utcnow() });
  await patch(db, documents, d, { extraction_status: "running" });
  await db.commit();
  const actorId = job.created_by_id;
  let schema: ai.SchemaField[];
  let items: Record<string, any>[];
  try {
    if (d.classification_source === "default" || d.classification_source === "ai") {
      const filename = d.filename;
      const result = await ai.loggedCall(db, prov, {
        purpose: "classify", prompt_parts: [filename, d.sha256], call: () => prov.classify(text, filename, pdfKw),
        document_id: d.id, actor_id: actorId,
        summarize_output: (r) => ({ doc_class: r.doc_class, confidence: r.confidence }),
      });
      if (result.doc_class && DOC_CLASSES.includes(result.doc_class)) {
        await patch(db, documents, d, {
          doc_class: result.doc_class, classification_source: "ai", classification_confidence: clamp(result.confidence),
        });
      }
    }
    const docClass = d.doc_class;
    schema = extractionSchema(docClass, job.target_entity_type, job.fields?.length ? job.fields : null);
    items = await ai.loggedCall(db, prov, {
      purpose: "extract", prompt_parts: [d.sha256, docClass, schema],
      call: () => prov.extract(text, docClass, schema, pdfKw), document_id: d.id, actor_id: actorId,
      summarize_output: (r) => ({ count: (r || []).length }),
    });
  } catch (exc) {
    // provider failure: log call (already added) and mark failed
    await finish(db, job, d, "failed", `AI provider error: ${exc instanceof Error ? exc.message : String(exc)}`.slice(0, 2000));
    await db.commit();
    return;
  }

  const types = Object.fromEntries(schema.map((s) => [s.field, s.type ?? "text"]));
  let count = 0;
  for (const item of items || []) {
    const name = String(item.field ?? "").trim().slice(0, 80);
    const value = item.value;
    if (!name || value === null || value === undefined || value === "") continue;
    await insert(db, extractedValues, {
      document_id: d.id, job_id: job.id, origin: "ai", target_entity_type: job.target_entity_type,
      target_entity_id: job.target_entity_id, field: name, value_type: types[name] ?? "text",
      value: toJsonable(value), original_value: toJsonable(value), page: intOrNull(item.page),
      clause: item.clause ? String(item.clause).slice(0, 200) : null,
      citation_text: item.citation_text ? String(item.citation_text) : null,
      confidence: clamp(item.confidence), status: "pending", ai_model: prov.model,
      created_by_id: actorId, updated_by_id: actorId,
    } as never);
    count += 1;
  }
  await patch(db, extractionJobs, job, { values_count: count });
  await finish(db, job, d, "completed", `${count} values extracted for review`);
  if (count) {
    await createTask(db, {
      title: `Review ${count} extracted values: ${d.title}`, assignee_id: actorId, task_type: "review",
      related_type: ENTITY, related_id: d.id, related_label: d.title, source: "documents.extraction",
      idempotency_key: `doc-extract:${job.id}`, actor_id: actorId,
    });
  }
  await audit.record(db, {
    actor: null, action: "document.extracted", entity_type: ENTITY, entity_id: d.id,
    summary: `${count} values extracted by ${prov.name}/${prov.model}`,
  });
  await db.commit();
}

export async function listJobs(db: Db, d: Document): Promise<ExtractionJob[]> {
  return db
    .select()
    .from(extractionJobs)
    .where(eq(extractionJobs.document_id, d.id))
    .orderBy(desc(extractionJobs.created_at))
    .limit(50);
}

export async function addManualValue(db: Db, d: Document, body: ManualValueIn, actor: CurrentUserT): Promise<ExtractedValue> {
  if (Boolean(body.target_entity_type) !== Boolean(body.target_entity_id)) {
    throw new HttpError(422, "Target type and id must be sent together");
  }
  const ev = await insert(db, extractedValues, {
    document_id: d.id, origin: "manual", target_entity_type: body.target_entity_type ?? null,
    target_entity_id: body.target_entity_id ?? null, field: body.field.trim(), value_type: body.value_type,
    value: toJsonable(body.value), original_value: toJsonable(body.value), page: body.page ?? null,
    clause: body.clause ?? null, citation_text: body.citation_text ?? null, confidence: body.confidence,
    status: "pending", created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "document.value_added", entity_type: ENTITY, entity_id: d.id,
    changes: { field: ev.field, value: ev.value, page: ev.page }, summary: d.title, ip_address: actor.ip_address,
  });
  await db.commit();
  return ev;
}

// --- Verification queue ------------------------------------------------------------------------

export interface ValueFilters {
  q?: string;
  status?: string[];
  field?: string[];
  document_id?: string;
  target_entity_type?: string[];
  target_entity_id?: string;
  origin?: string[];
  min_confidence?: number;
  max_confidence?: number;
}

/** WHERE for `extracted_values JOIN documents` (use {@link valueFrom} for the FROM clause). */
export function valueQuery(fl: ValueFilters, user: CurrentUserT, o: { skip?: Set<string> } = {}): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const v = extractedValues;
  return and(
    isNull(v.deleted_at),
    isNull(documents.deleted_at),
    visible(user),
    applySearch(fl.q, [v.field, v.citation_text, v.clause, documents.title]),
    skip.has("status") ? undefined : inFilter(v.status, fl.status),
    skip.has("field") ? undefined : inFilter(v.field, fl.field),
    skip.has("target_entity_type") ? undefined : inFilter(v.target_entity_type, fl.target_entity_type),
    inFilter(v.origin, fl.origin),
    fl.document_id ? eq(v.document_id, fl.document_id) : undefined,
    fl.target_entity_id ? eq(v.target_entity_id, fl.target_entity_id) : undefined,
    fl.min_confidence !== undefined ? sql`${v.confidence} >= ${fl.min_confidence}` : undefined,
    fl.max_confidence !== undefined ? sql`${v.confidence} <= ${fl.max_confidence}` : undefined,
  );
}

/** One page of extracted values (joined to documents for the visibility/search filters). */
export async function listValueRows(db: Db, where: SQL | undefined, orderBy: SQL[], p: ListParams) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(extractedValues)
    .innerJoin(documents, eq(documents.id, extractedValues.document_id))
    .where(where);
  const rows = await db
    .select({ v: extractedValues })
    .from(extractedValues)
    .innerJoin(documents, eq(documents.id, extractedValues.document_id))
    .where(where)
    .orderBy(...orderBy)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return [rows.map((r) => r.v), Number(n)] as [ExtractedValue[], number];
}

async function valueFacet(db: Db, where: SQL | undefined, column: PgColumn): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(extractedValues)
    .innerJoin(documents, eq(documents.id, extractedValues.document_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export async function valueFacets(db: Db, fl: ValueFilters, user: CurrentUserT) {
  return {
    status: await valueFacet(db, valueQuery(fl, user, { skip: new Set(["status"]) }), extractedValues.status),
    field: await valueFacet(db, valueQuery(fl, user, { skip: new Set(["field"]) }), extractedValues.field),
    target_entity_type: await valueFacet(
      db, valueQuery(fl, user, { skip: new Set(["target_entity_type"]) }), extractedValues.target_entity_type,
    ),
  };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

function norm(value: any, valueType: string): any {
  if (value === null || value === undefined) return null;
  if (["number", "money", "percent"].includes(valueType) || typeof value === "number") {
    const s = String(value).replace(/,/g, "").replace(/\$/g, "").replace(/%/g, "").trim();
    const n = Number(s);
    if (s !== "" && !Number.isNaN(n)) return round4(n);
  }
  if (valueType === "date" || value instanceof Date) return String(toJsonable(value)).slice(0, 10);
  return String(value).trim().toLowerCase();
}

export async function valuesOut(db: Db, values: ExtractedValue[]) {
  if (!values.length) return [];
  const docRows = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(inArray(documents.id, [...new Set(values.map((v) => v.document_id))]));
  const titles = new Map(docRows.map((r) => [r.id, r.title]));
  const names = await userNames(db, values.map((v) => v.reviewer_id));
  const pairs = values
    .filter((v) => v.target_entity_type && v.target_entity_id)
    .map((v) => [v.target_entity_type!, v.target_entity_id!] as [string, string]);
  const targets = pairs.length ? await loadTargets(db, pairs) : new Map<string, Loaded>();
  return values.map((v) => {
    const t = v.target_entity_type && v.target_entity_id ? targets.get(keyOf(v.target_entity_type, v.target_entity_id)) : undefined;
    let current: any = null;
    let conflict: boolean | null = null;
    if (t && v.field in getTableColumns(t.table as PgTable)) {
      current = toJsonable(t.row[v.field] ?? null);
      conflict = current !== null && norm(current, v.value_type) !== norm(v.value, v.value_type);
    }
    return {
      id: v.id,
      document_id: v.document_id,
      document_title: titles.get(v.document_id) ?? null,
      job_id: v.job_id,
      origin: v.origin,
      target_entity_type: v.target_entity_type,
      target_entity_id: v.target_entity_id,
      target_label: t?.label ?? null,
      field: v.field,
      value_type: v.value_type,
      value: v.value,
      original_value: v.original_value,
      page: v.page,
      clause: v.clause,
      citation_text: v.citation_text,
      confidence: v.confidence,
      status: v.status,
      reviewer_id: v.reviewer_id,
      reviewer_name: v.reviewer_id ? names.get(v.reviewer_id) ?? null : null,
      reviewed_at: v.reviewed_at,
      review_note: v.review_note,
      ai_model: v.ai_model,
      applied_observation_id: v.applied_observation_id,
      is_date: v.value_type === "date",
      applicable: v.target_entity_type === "property" && Boolean(v.target_entity_id) && PROPERTY_APPLICABLE.has(v.field),
      current_value: current,
      conflict,
      created_at: v.created_at,
    };
  });
}

export async function getValue(db: Db, valueId: string, user: CurrentUserT): Promise<[ExtractedValue, Document]> {
  const ev = await ormGet(db, extractedValues, valueId);
  if (!ev || ev.deleted_at) throw new HttpError(404, "Extracted value not found");
  return [ev, await get(db, ev.document_id, user)];
}

/** Coerce a reviewed value to the target column's type (Python `_coerce`). */
function coerceToColumn(table: PgTable, field: string, value: any): any {
  const col = getTableColumns(table)[field] as PgColumn | undefined;
  if (!col) throw new HttpError(422, `'${field}' is not a field on the target record`);
  if (value === null || value === undefined || value === "") throw new HttpError(422, "A value is required");
  const raw = String(value).trim();
  const bad = () => new HttpError(422, `'${value}' is not a valid value for ${field}`);
  const sqlType = col.getSQLType().toLowerCase();
  const num = (s: string) => {
    const n = Number(s);
    if (s === "" || Number.isNaN(n)) throw bad();
    return n;
  };
  if (/^(integer|bigint|smallint|serial|bigserial|int)/.test(sqlType)) return Math.round(num(raw.replace(/,/g, "").replace(/\$/g, "")));
  if (/^(numeric|decimal|double|real|float)/.test(sqlType)) return num(raw.replace(/,/g, "").replace(/\$/g, "").replace(/%/g, ""));
  if (sqlType === "date") {
    const s = raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad();
    return s;
  }
  if (sqlType.startsWith("timestamp")) {
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) throw bad();
    return dt;
  }
  const length = (col as any).length as number | undefined;
  return length ? raw.slice(0, length) : raw;
}

/** Apply a human-confirmed value to a property through provenance. Returns [observation id, coerced value]. */
async function applyToProperty(
  db: Db, ev: ExtractedValue, d: Document, value: any, actor: CurrentUserT, acceptConflict: boolean,
): Promise<[string, any]> {
  if (!actor.can("properties", "edit")) throw new HttpError(403, "Applying values to a property requires properties:edit");
  const p = await ormGet(db, properties, ev.target_entity_id!);
  if (!p || p.deleted_at) throw new HttpError(404, "Target property not found");
  const coerced = coerceToColumn(properties, ev.field, value);
  if (ev.field === "property_type" && !(PROPERTY_TYPES as readonly string[]).includes(coerced)) {
    throw new HttpError(422, `'${coerced}' is not a valid property type`);
  }
  const current = (p as Record<string, any>)[ev.field];
  const changed = current !== coerced;
  if (changed && current !== null && current !== undefined && !acceptConflict) {
    throw new HttpError(409, {
      message: `The property already has ${ev.field.replace(/_/g, " ")} = ${toJsonable(current)}. ` +
        "Review the conflict and confirm replacing it explicitly.",
      current_value: toJsonable(current),
      extracted_value: toJsonable(coerced),
    });
  }
  if (changed) {
    (p as Record<string, any>)[ev.field] = coerced;
    await patch(db, properties, p, {
      [ev.field]: coerced, completeness_score: completeness(p), updated_by_id: actor.id,
    } as never);
  }

  let cite = ev.page ? ` p.${ev.page}` : "";
  cite += ev.clause ? ` §${ev.clause}` : "";
  const obs = await provenance.observe(db, {
    entity_type: "property", entity_id: p.id, field: ev.field, value: coerced,
    prov: {
      source: `Document: ${d.title}${cite}`.slice(0, 200), observed_on: today(), confidence: ev.confidence,
      verified: false, ai_derived: ev.origin === "ai",
    },
    actor_id: actor.id,
  });
  // The named reviewer verifies; the AI-derived flag stays on the observation permanently.
  await provenance.setVerification(db, obs.id, "verified", actor.id);
  if (changed) {
    await audit.record(db, {
      actor, action: "property.updated", entity_type: "property", entity_id: p.id,
      changes: { [ev.field]: { from: toJsonable(current), to: toJsonable(coerced) } },
      summary: `Confirmed from document ${d.title}`, ip_address: actor.ip_address,
    });
    await events.emit(db, "property.updated", { property_id: p.id, changed: new Set([ev.field]), actor });
  }
  return [obs.id, coerced];
}

export async function confirmValue(
  db: Db,
  ev: ExtractedValue,
  d: Document,
  actor: CurrentUserT,
  o: { accept_conflict?: boolean; note?: string | null; edited?: boolean; new_value?: any } = {},
): Promise<ExtractedValue> {
  const edited = o.edited ?? false;
  if (ev.status !== "pending") throw new HttpError(409, `This value was already ${ev.status}`);
  let value = edited ? o.new_value : ev.value;
  if (edited && (value === null || value === undefined || value === "")) throw new HttpError(422, "A value is required");
  let appliedObservationId: string | undefined;
  if (ev.target_entity_type === "property" && ev.target_entity_id && PROPERTY_APPLICABLE.has(ev.field)) {
    [appliedObservationId, value] = await applyToProperty(db, ev, d, value, actor, o.accept_conflict ?? false);
  }
  await patch(db, extractedValues, ev, {
    ...(appliedObservationId ? { applied_observation_id: appliedObservationId } : {}),
    value: toJsonable(value), status: edited ? "edited" : "confirmed", reviewer_id: actor.id, reviewed_at: utcnow(),
    review_note: o.note ?? null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `document.value_${ev.status}`, entity_type: ENTITY, entity_id: d.id,
    changes: {
      field: ev.field, original_value: ev.original_value, value: ev.value,
      target_entity_type: ev.target_entity_type, target_entity_id: ev.target_entity_id,
    },
    summary: `${ev.field} on ${d.title}`, ip_address: actor.ip_address,
  });
  // Consumers (leases, contracts, ...) may pick up confirmed values. Dates stay proposals in those modules.
  await events.emit(db, "document.value_confirmed", {
    extracted_value_id: ev.id, document_id: d.id, target_entity_type: ev.target_entity_type,
    target_entity_id: ev.target_entity_id, field: ev.field, value: ev.value, value_type: ev.value_type, actor,
  });
  await db.commit();
  return ev;
}

export async function rejectValue(
  db: Db, ev: ExtractedValue, d: Document, actor: CurrentUserT, note: string | null | undefined,
): Promise<ExtractedValue> {
  if (ev.status !== "pending") throw new HttpError(409, `This value was already ${ev.status}`);
  await patch(db, extractedValues, ev, {
    status: "rejected", reviewer_id: actor.id, reviewed_at: utcnow(), review_note: note ?? null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "document.value_rejected", entity_type: ENTITY, entity_id: d.id,
    changes: { field: ev.field, value: ev.value }, summary: note || ev.field, ip_address: actor.ip_address,
  });
  await db.commit();
  return ev;
}

// --- Retrieval, summaries, drafting ------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "has", "have", "how", "in", "is",
  "it", "of", "on", "or", "show", "me", "the", "this", "that", "to", "was", "what", "when", "where", "which",
  "who", "with", "find", "all", "any", "our", "we", "documents", "document", "docs",
]);

export function searchTerms(q: string): string[] {
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}_$.%/-]+/gu) ?? []).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  return [...new Set(terms)].slice(0, 8);
}

function snippet(text: string | null | undefined, terms: string[], width = 140): string | null {
  if (!text) return null;
  const low = text.toLowerCase();
  for (const t of terms) {
    const idx = low.indexOf(t);
    if (idx >= 0) {
      const start = Math.max(0, idx - width);
      const end = Math.min(text.length, idx + t.length + width);
      const body = text.slice(start, end).replace(/\s+/g, " ").trim();
      return `${start ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
    }
  }
  return null;
}

export async function search(db: Db, q: string, user: CurrentUserT, limit = 20) {
  const terms = searchTerms(q);
  if (!terms.length) return [];
  const conds = terms.map((t) => {
    const pattern = `%${t}%`;
    const evMatch = exists(
      db
        .select({ one: sql`1` })
        .from(extractedValues)
        .where(and(
          eq(extractedValues.document_id, documents.id), isNull(extractedValues.deleted_at),
          ne(extractedValues.status, "rejected"),
          or(ilike(extractedValues.citation_text, pattern), ilike(extractedValues.field, pattern)),
        )),
    );
    return or(
      ilike(documents.title, pattern), ilike(documents.filename, pattern), ilike(documents.description, pattern),
      ilike(documents.text_content, pattern), evMatch,
    );
  });
  let docs = await db
    .select()
    .from(documents)
    .where(and(isNull(documents.deleted_at), eq(documents.is_latest, true), or(...conds), visible(user)))
    .orderBy(desc(documents.updated_at))
    .limit(200);

  const score = (d: Document): [number, number] => {
    const meta = `${d.title} ${d.filename} ${d.description || ""}`.toLowerCase();
    const body = (d.text_content || "").toLowerCase();
    return [
      terms.filter((t) => meta.includes(t)).length * 3 + terms.filter((t) => body.includes(t)).length,
      Math.floor(d.updated_at.getTime() / 1000),
    ];
  };
  docs = docs
    .map((d) => ({ d, s: score(d) }))
    .sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1])
    .map((x) => x.d)
    .slice(0, limit);
  if (!docs.length) return [];
  const ids = docs.map((d) => d.id);
  const cites = await db
    .select()
    .from(extractedValues)
    .where(and(
      inArray(extractedValues.document_id, ids), isNull(extractedValues.deleted_at), ne(extractedValues.status, "rejected"),
      or(...terms.flatMap((t) => [ilike(extractedValues.citation_text, `%${t}%`), ilike(extractedValues.field, `%${t}%`)])),
    ))
    .orderBy(desc(extractedValues.confidence))
    .limit(100);
  const links = await linksFor(db, new Set(docs.map(rootOf)), user);
  return docs.map((d) => {
    const meta = `${d.title} ${d.filename} ${d.description || ""}`.toLowerCase();
    const matched: string[] = [];
    if (terms.some((t) => meta.includes(t))) matched.push("metadata");
    if (terms.some((t) => (d.text_content || "").toLowerCase().includes(t))) matched.push("text");
    const docCites = cites
      .filter((c) => c.document_id === d.id)
      .slice(0, 3)
      .map((c) => ({
        document_id: c.document_id, page: c.page, clause: c.clause,
        text: (c.citation_text || `${c.field}: ${c.value}`).slice(0, 300),
      }));
    if (docCites.length) matched.push("citations");
    return {
      document_id: d.id, title: d.title, doc_class: d.doc_class, filename: d.filename, is_sensitive: d.is_sensitive,
      matched_in: matched, snippet: snippet(d.text_content, terms) ?? snippet(d.description, terms),
      citations: docCites, links: links.get(rootOf(d)) ?? [],
    };
  });
}

export async function summarize(db: Db, body: SummarizeIn, user: CurrentUserT) {
  const ids = [...new Set(body.document_ids)];
  if (body.entity_type && body.entity_id) {
    const found = await db
      .select()
      .from(documents)
      .where(buildQuery({ entity_type: body.entity_type, entity_id: body.entity_id }, user))
      .limit(50);
    ids.push(...found.filter((d) => !ids.includes(d.id)).map((d) => d.id));
  }
  if (!ids.length) throw new HttpError(422, "Select at least one document");
  const docs: Document[] = [];
  for (const i of ids.slice(0, 50)) docs.push(await get(db, i, user));
  const prov = provider();
  if (!prov.available) {
    return {
      ai_used: false, provider: prov.name, summary: null, citations: [], document_ids: ids,
      message: "AI summaries are not enabled on this workspace yet.",
    };
  }
  const texts: ai.SourceText[] = docs
    .filter((d) => d.text_content)
    .map((d) => ({ document_id: d.id, title: d.title, text: d.text_content || "" }));
  if (!texts.length) {
    return {
      ai_used: false, provider: prov.name, summary: null, citations: [], document_ids: ids,
      message: "None of the selected documents have text to summarize.",
    };
  }
  const purpose = body.purpose;
  let result: { summary: string; citations: Record<string, any>[] };
  try {
    result = await ai.loggedCall(db, prov, {
      purpose: `summarize:${purpose}`, prompt_parts: [purpose, docs.map((d) => d.sha256)],
      call: () => prov.summarize(texts, purpose), document_id: docs.length === 1 ? docs[0].id : null,
      actor_id: user.id, summarize_output: (r) => ({ chars: (r.summary || "").length }),
    });
  } catch (exc) {
    // never block the user path on AI
    await db.commit();
    return {
      ai_used: false, provider: prov.name, summary: null, citations: [], document_ids: ids,
      message: `The AI provider could not produce a summary (${exc instanceof Error ? exc.name : "Error"}).`,
    };
  }
  await audit.record(db, {
    actor: user, action: "document.summarized", entity_type: ENTITY, entity_id: docs.length === 1 ? docs[0].id : null,
    changes: { document_ids: ids, purpose }, ip_address: user.ip_address,
  });
  await db.commit();
  const citations = [];
  for (const c of result.citations || []) {
    const r = citationSchema.safeParse(c);
    if (r.success) {
      citations.push({
        document_id: r.data.document_id ?? null, page: r.data.page ?? null, clause: r.data.clause ?? null,
        text: r.data.text ?? null,
      });
    }
  }
  return {
    ai_used: true, provider: prov.name, summary: result.summary || "", citations, document_ids: ids, message: null,
  };
}

function fmt(value: any): string {
  value = toJsonable(value);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString("en-US");
    return value
      .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .replace(/0+$/, "")
      .replace(/\.$/, "");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const DRAFT_INTROS: Record<string, string> = {
  outreach: "Hello [Name],\n\nI am reaching out about {title}. We follow this market closely and would welcome " +
    "a brief conversation about the property and whether you would consider an offer.",
  offer: "Re: Non-binding letter of intent — {title}\n\nThis letter outlines the principal terms under which " +
    "[Buyer] proposes to acquire the property described below.",
  proposal: "Proposal for {title}\n\nThank you for the opportunity to present our approach to marketing and " +
    "advising on the property described below.",
  report: "Property report — {title}\n\nSummary of verified information on file.",
};

/** Drafting from verified data only: verified observations and human-confirmed extracted values. */
export async function draft(db: Db, body: DraftIn, user: CurrentUserT) {
  if (!user.can("properties", "view")) throw new HttpError(403, "Missing permission properties:view");
  const p = await ormGet(db, properties, body.entity_id);
  if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  const title = p.name || p.address_line;
  const sources: DraftSource[] = [
    {
      field: "address", value: [p.address_line, p.city, p.state].filter((x) => x).join(", "), source: "Property record",
    },
    { field: "property_type", value: p.property_type, source: "Property record" },
  ];
  const observations = await provenance.currentObservations(db, "property", p.id);
  for (const field of Object.keys(observations).sort()) {
    const obs = observations[field];
    if (obs.verification === "verified" && field !== "property_type") {
      sources.push({ field, value: obs.value, source: obs.source });
    }
  }
  const confirmed = await db
    .select({ v: extractedValues })
    .from(extractedValues)
    .innerJoin(documents, eq(documents.id, extractedValues.document_id))
    .where(and(
      eq(extractedValues.target_entity_type, "property"), eq(extractedValues.target_entity_id, p.id),
      inArray(extractedValues.status, ["confirmed", "edited"]), isNull(extractedValues.deleted_at),
      isNull(documents.deleted_at), visible(user),
    ))
    .orderBy(desc(extractedValues.reviewed_at))
    .limit(40);
  const seen = new Set(sources.map((s) => s.field));
  for (const { v: ev } of confirmed) {
    if (!seen.has(ev.field)) {
      seen.add(ev.field);
      sources.push({ field: ev.field, value: ev.value, source: `Confirmed document value${ev.page ? ` p.${ev.page}` : ""}` });
    }
  }

  const facts = sources
    .map((s) => `- ${capitalize(s.field.replace(/_/g, " "))}: ${fmt(s.value)}`)
    .join("\n");
  const intro = DRAFT_INTROS[body.kind].replace("{title}", () => title);
  const template =
    `${intro}\n\nVerified facts:\n${facts}\n\n` +
    `${body.instructions ? `Notes: ${body.instructions.trim()}\n\n` : ""}` +
    `Regards,\n${user.full_name}`;
  const prov = provider();
  if (!prov.available) return { ai_used: false, provider: prov.name, draft: template, sources };
  const kind = body.kind;
  const texts: ai.SourceText[] = [{ document_id: "", title: "Verified facts and template", text: template }];
  let text = "";
  try {
    const result = await ai.loggedCall(db, prov, {
      purpose: `draft:${kind}`, prompt_parts: [kind, template], call: () => prov.summarize(texts, `draft:${kind}`),
      actor_id: user.id, summarize_output: (r) => ({ chars: (r.summary || "").length }),
    });
    text = (result.summary || "").trim();
  } catch {
    text = "";
  }
  await db.commit();
  return { ai_used: Boolean(text), provider: prov.name, draft: text || template, sources };
}

export function aiCallsWhere(documentId: string | undefined, purpose: string[] | undefined): SQL | undefined {
  return and(documentId ? eq(aiCalls.document_id, documentId) : undefined, inFilter(aiCalls.purpose, purpose));
}

export const aiCallOut = (c: typeof aiCalls.$inferSelect) => ({
  id: c.id, provider: c.provider, model: c.model, purpose: c.purpose, prompt_hash: c.prompt_hash,
  input_tokens: c.input_tokens, output_tokens: c.output_tokens, latency_ms: c.latency_ms, status: c.status,
  error: c.error, document_id: c.document_id, created_by_id: c.created_by_id, created_at: c.created_at,
});
