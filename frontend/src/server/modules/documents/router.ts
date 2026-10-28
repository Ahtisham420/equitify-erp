import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { desc } from "drizzle-orm";

import { applySort, page, paginate } from "../../common/query";
import { created, HttpError, noContent, status } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import * as ai from "./ai";
import {
  ACCESS_ACTIONS, DOC_CLASSES, EXTRACTION_STATUSES, LINK_TYPES, VALUE_STATUSES, aiCalls, documents, extractedValues,
} from "./schema";
import {
  confirmIn, documentUpdate, draftIn, editIn, extractIn, linkIn, manualValueIn, rejectIn, summarizeIn, textIn,
} from "./schemas";
import * as service from "./service";
import type { DocFilters, ValueFilters } from "./service";

export const router = new Router();

const SORTS = {
  title: documents.title, doc_class: documents.doc_class, size_bytes: documents.size_bytes,
  created_at: documents.created_at, updated_at: documents.updated_at, version: documents.version,
  retention_until: documents.retention_until, filename: documents.filename,
};
const VALUE_SORTS = {
  created_at: extractedValues.created_at, confidence: extractedValues.confidence, field: extractedValues.field,
  status: extractedValues.status, reviewed_at: extractedValues.reviewed_at, page: extractedValues.page,
};

function filters(ctx: Ctx): DocFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    doc_class: q.strs("doc_class"),
    sensitivity: q.strs("sensitivity"),
    linked_type: q.strs("linked_type"),
    extraction_status: q.strs("extraction_status"),
    entity_type: q.str("entity_type", { max: 40 }),
    entity_id: q.uuid("entity_id"),
    legal_hold: q.bool("legal_hold"),
    uploaded_by_id: q.uuid("uploaded_by_id"),
    created_from: q.date("created_from"),
    created_to: q.date("created_to"),
  };
}

function valueFilters(ctx: Ctx): ValueFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    field: q.strs("field"),
    document_id: q.uuid("document_id"),
    target_entity_type: q.strs("target_entity_type"),
    target_entity_id: q.uuid("target_entity_id"),
    origin: q.strs("origin"),
    min_confidence: q.num("min_confidence", { ge: 0, le: 1 }),
    max_confidence: q.num("max_confidence", { ge: 0, le: 1 }),
  };
}

// --- multipart form helpers (FastAPI `Form(...)`) ----------------------------------------------

const formError = (name: string, msg: string, type = "value_error") =>
  new HttpError(422, [{ loc: ["body", name], msg, type }]);

function fStr(form: FormData, name: string, max?: number): string | undefined {
  const v = form.get(name);
  if (typeof v !== "string") return undefined;
  if (max !== undefined && v.length > max) throw formError(name, `String should have at most ${max} characters`);
  return v;
}
function fBool(form: FormData, name: string, dflt: boolean): boolean {
  const v = fStr(form, name);
  if (v === undefined || v === "") return dflt;
  const l = v.toLowerCase();
  if (["true", "1", "yes", "on", "t", "y"].includes(l)) return true;
  if (["false", "0", "no", "off", "f", "n"].includes(l)) return false;
  throw formError(name, "Input should be a valid boolean");
}
function fDate(form: FormData, name: string): string | undefined {
  const v = fStr(form, name);
  if (v === undefined || v === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw formError(name, "Input should be a valid date");
  return v;
}
function fUuid(form: FormData, name: string): string | undefined {
  const v = fStr(form, name);
  if (v === undefined || v === "") return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw formError(name, "Input should be a valid UUID");
  }
  return v;
}
function fFile(form: FormData): File {
  const v = form.get("file");
  if (v === null || typeof v === "string") throw formError("file", "Field required", "missing");
  return v as File;
}

// --- Library -----------------------------------------------------------------------------------

router.get("/documents", async (ctx) => {
  const user = await ctx.require("documents", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  const order = applySort(p.sort, SORTS, desc(documents.updated_at));
  const [items, total] = await paginate(ctx.db, documents, service.buildQuery(f, user), order, p);
  return page(await service.toListItems(ctx.db, items, user), total, p);
});

router.get("/documents/facets", async (ctx) => {
  const user = await ctx.require("documents", "view");
  return service.facets(ctx.db, filters(ctx), user);
});

router.get("/documents/meta", async (ctx) => {
  await ctx.require("documents", "view");
  return {
    doc_classes: DOC_CLASSES, link_types: LINK_TYPES, extraction_statuses: EXTRACTION_STATUSES,
    value_statuses: VALUE_STATUSES, access_actions: ACCESS_ACTIONS,
    max_upload_mb: Math.floor(service.MAX_UPLOAD_BYTES / (1024 * 1024)), inline_types: [...service.INLINE_MIME].sort(),
    schemas: service.allSchemas(), property_fields: [...service.PROPERTY_APPLICABLE].sort(), ai: ai.providerStatus(),
  };
});

router.get("/documents/search", async (ctx) => {
  const user = await ctx.require("documents", "view");
  const q = ctx.query.need("q", { min: 1, max: 300 });
  const limit = ctx.query.int("limit", { ge: 1, le: 50 }) ?? 20;
  return service.search(ctx.db, q, user, limit);
});

/** Signed-URL access: the token is the credential (no bearer header), so browsers can open it directly. */
router.get("/documents/download", async (ctx) => {
  const token = ctx.query.need("token", { max: 4000 });
  const [d, filePath, inline] = await service.resolveDownload(ctx.db, token, ctx.ip);
  const st = await stat(filePath);
  const mediaType = d.mime_type.startsWith("text/") && !d.mime_type.includes("charset") ? `${d.mime_type}; charset=utf-8` : d.mime_type;
  const type = inline ? "inline" : "attachment";
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7e]*$/.test(d.filename);
  const disposition = ascii
    ? `${type}; filename="${d.filename.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : `${type}; filename*=utf-8''${encodeURIComponent(d.filename)}`;
  return new Response(Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream, {
    headers: {
      "Content-Type": mediaType,
      "Content-Disposition": disposition,
      "Content-Length": String(st.size),
      "Last-Modified": st.mtime.toUTCString(),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

router.post("/documents/summarize", async (ctx) => {
  const user = await ctx.require("documents", "view");
  return service.summarize(ctx.db, await ctx.body(summarizeIn), user);
});

router.post("/documents/draft", async (ctx) => {
  const user = await ctx.require("documents", "view");
  return service.draft(ctx.db, await ctx.body(draftIn), user);
});

router.get("/documents/ai-calls", async (ctx) => {
  const user = await ctx.require("documents", "view");
  const p = ctx.listParams();
  const documentId = ctx.query.uuid("document_id");
  const purpose = ctx.query.strs("purpose");
  if (documentId) await service.get(ctx.db, documentId, user);
  else if (!user.can("audit", "view")) throw new HttpError(403, "Viewing all AI calls requires audit:view");
  const order = applySort(p.sort, { created_at: aiCalls.created_at, latency_ms: aiCalls.latency_ms }, desc(aiCalls.created_at));
  const [items, total] = await paginate(ctx.db, aiCalls, service.aiCallsWhere(documentId, purpose), order, p);
  return page(items.map(service.aiCallOut), total, p);
});

// --- Verification queue ------------------------------------------------------------------------

router.get("/documents/extracted-values", async (ctx) => {
  const user = await ctx.require("documents", "view");
  const p = ctx.listParams();
  const f = valueFilters(ctx);
  const order = applySort(p.sort, VALUE_SORTS, desc(extractedValues.created_at));
  const [items, total] = await service.listValueRows(ctx.db, service.valueQuery(f, user), order, p);
  return page(await service.valuesOut(ctx.db, items), total, p);
});

router.get("/documents/extracted-values/facets", async (ctx) => {
  const user = await ctx.require("documents", "view");
  return service.valueFacets(ctx.db, valueFilters(ctx), user);
});

router.post("/documents/extracted-values/{value_id}/confirm", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(confirmIn);
  const [ev0, d] = await service.getValue(ctx.db, ctx.uuid("value_id"), user);
  const ev = await service.confirmValue(ctx.db, ev0, d, user, { accept_conflict: body.accept_conflict, note: body.note });
  return (await service.valuesOut(ctx.db, [ev]))[0];
});

router.post("/documents/extracted-values/{value_id}/edit", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(editIn);
  const [ev0, d] = await service.getValue(ctx.db, ctx.uuid("value_id"), user);
  const ev = await service.confirmValue(ctx.db, ev0, d, user, {
    accept_conflict: body.accept_conflict, note: body.note, edited: true, new_value: body.value,
  });
  return (await service.valuesOut(ctx.db, [ev]))[0];
});

router.post("/documents/extracted-values/{value_id}/reject", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(rejectIn);
  const [ev0, d] = await service.getValue(ctx.db, ctx.uuid("value_id"), user);
  const ev = await service.rejectValue(ctx.db, ev0, d, user, body.note);
  return (await service.valuesOut(ctx.db, [ev]))[0];
});

// --- Upload ------------------------------------------------------------------------------------

router.post("/documents", async (ctx) => {
  const user = await ctx.require("documents", "create");
  const form = await ctx.form();
  const file = fFile(form);
  const [d, job] = await service.upload(ctx.db, {
    file, actor: user, title: fStr(form, "title", 300), doc_class: fStr(form, "doc_class"),
    description: fStr(form, "description"), is_sensitive: fBool(form, "is_sensitive", false),
    retention_until: fDate(form, "retention_until"), tags: fStr(form, "tags"), entity_type: fStr(form, "entity_type"),
    entity_id: fUuid(form, "entity_id"), auto_extract: fBool(form, "auto_extract", true),
  });
  if (job) ctx.background(() => service.runExtraction(job.id));
  return created(await service.toOut(ctx.db, d, user));
});

// --- Single document ---------------------------------------------------------------------------

router.get("/documents/{document_id}", async (ctx) => {
  const user = await ctx.require("documents", "view");
  const d = await service.get(ctx.db, ctx.uuid("document_id"), user);
  await service.logAccess(ctx.db, d, { action: "view", actor: user, ip: ctx.ip, throttle: true });
  await ctx.db.commit();
  return service.toOut(ctx.db, d, user);
});

router.patch("/documents/{document_id}", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(documentUpdate);
  const d = await service.updateDocument(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user), body, user);
  return service.toOut(ctx.db, d, user);
});

router.delete("/documents/{document_id}", async (ctx) => {
  const user = await ctx.require("documents", "delete");
  await service.deleteDocument(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user), user);
  return noContent();
});

router.get("/documents/{document_id}/versions", async (ctx) => {
  const user = await ctx.require("documents", "view");
  return service.versions(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user), user);
});

router.post("/documents/{document_id}/versions", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const documentId = ctx.uuid("document_id");
  const form = await ctx.form();
  const file = fFile(form);
  const autoExtract = fBool(form, "auto_extract", true);
  const base = await service.get(ctx.db, documentId, user);
  const [d, job] = await service.newVersion(ctx.db, base, { file, actor: user, auto_extract: autoExtract });
  if (job) ctx.background(() => service.runExtraction(job.id));
  return created(await service.toOut(ctx.db, d, user));
});

router.put("/documents/{document_id}/text", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(textIn);
  const d = await service.setText(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user), body.text, user);
  return service.toOut(ctx.db, d, user);
});

router.post("/documents/{document_id}/links", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(linkIn);
  const d = await service.get(ctx.db, ctx.uuid("document_id"), user);
  const lnk = await service.link(ctx.db, d.id, body.entity_type, body.entity_id, user);
  await ctx.db.commit();
  return created({
    id: lnk.id, document_id: lnk.document_id, entity_type: lnk.entity_type, entity_id: lnk.entity_id, label: null,
    created_at: lnk.created_at,
  });
});

router.delete("/documents/{document_id}/links/{link_id}", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  await service.unlink(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user), ctx.uuid("link_id"), user);
  return noContent();
});

router.get("/documents/{document_id}/signed-url", async (ctx) => {
  const user = await ctx.require("documents", "view");
  const wantInline = ctx.query.bool("inline") ?? false;
  const minutes = ctx.query.int("minutes", { ge: 1, le: 60 }) ?? 10;
  const d = await service.get(ctx.db, ctx.uuid("document_id"), user);
  const inline = wantInline && service.canInline(d.mime_type);
  return {
    url: service.signedUrl(d.id, minutes, { user_id: user.id, inline }),
    expires_at: new Date(Date.now() + minutes * 60 * 1000),
    inline,
  };
});

router.get("/documents/{document_id}/access-log", async (ctx) => {
  const user = await ctx.require("documents", "view");
  return service.accessLog(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user));
});

router.post("/documents/{document_id}/extract", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(extractIn);
  const d = await service.get(ctx.db, ctx.uuid("document_id"), user);
  const [job, createdJob] = await service.requestExtraction(ctx.db, d, body, user);
  if (createdJob) ctx.background(() => service.runExtraction(job.id));
  return status(202, service.jobOut(job));
});

router.get("/documents/{document_id}/jobs", async (ctx) => {
  const user = await ctx.require("documents", "view");
  const jobs = await service.listJobs(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user));
  return jobs.map(service.jobOut);
});

router.post("/documents/{document_id}/values", async (ctx) => {
  const user = await ctx.require("documents", "edit");
  const body = await ctx.body(manualValueIn);
  const ev = await service.addManualValue(ctx.db, await service.get(ctx.db, ctx.uuid("document_id"), user), body, user);
  return created((await service.valuesOut(ctx.db, [ev]))[0]);
});
