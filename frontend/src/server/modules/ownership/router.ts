import { desc } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, csvResponse, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import {
  entityLinks, EVIDENCE_TYPES, FINANCING_TYPES, INTEREST_ROLES, LINK_RELATIONSHIPS, NOTE_CATEGORIES, ownershipInterests,
} from "./schema";
import { endInterestIn, interestIn, interestUpdate, linkIn, linkReviewIn, linkUpdate, noteIn, verifyIn } from "./schemas";
import * as service from "./service";
import type { InterestFilters, LinkFilters } from "./service";

export const router = new Router();

const OWNER_KINDS = ["person", "organization"] as const;
const bad = (where: "query" | "path", loc: string, msg: string, type = "value_error") =>
  new HttpError(422, [{ loc: [where, loc], msg, type }]);

function interestFilters(ctx: Ctx): InterestFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    property_id: q.uuid("property_id"),
    owner_kind: q.strs("owner_kind"),
    owner_id: q.uuid("owner_id"),
    role: q.strs("role"),
    verification: q.strs("verification"),
    current: q.bool("current"),
    state: q.strs("state"),
    mismatch: q.bool("mismatch"),
  };
}

function linkFilters(ctx: Ctx): LinkFilters {
  const q = ctx.query;
  return {
    status: q.strs("status"),
    relationship: q.strs("relationship"),
    suggested_by: q.str("suggested_by"),
    node_id: q.uuid("node_id"),
    min_confidence: q.num("min_confidence", { ge: 0, le: 1 }),
  };
}

/** `{kind}` path param: person | organization. */
function kindParam(ctx: Ctx): "person" | "organization" {
  const k = ctx.param("kind");
  if (k !== "person" && k !== "organization") throw bad("path", "kind", "Input should be 'person' or 'organization'", "enum");
  return k;
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLines = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

router.get("/ownership/meta", async (ctx) => {
  await ctx.require("ownership", "view");
  return {
    roles: INTEREST_ROLES, financing_types: FINANCING_TYPES, relationships: LINK_RELATIONSHIPS,
    control_relationships: [...service.CONTROL_RELATIONSHIPS].sort(), evidence_types: EVIDENCE_TYPES,
    note_categories: NOTE_CATEGORIES,
  };
});

// ---------------------------------------------------------------- interests

router.get("/ownership/interests", async (ctx) => {
  const user = await ctx.require("ownership", "view");
  const p = ctx.listParams();
  const where = service.buildInterestWhere(interestFilters(ctx));
  const order = applySort(p.sort, service.interestSorts(), desc(ownershipInterests.updated_at));
  const total = await service.interestCount(ctx.db, where);
  const rows = await service
    .interestSelect(ctx.db)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  const show = service.canSeeSensitive(user);
  return page(rows.map((r) => service.rowToOut(r, show)), total, p);
});

router.get("/ownership/interests/facets", async (ctx) => {
  await ctx.require("ownership", "view");
  const f = interestFilters(ctx);
  const w = (skip: string) => service.buildInterestWhere(f, new Set([skip]));
  return {
    role: await service.interestFacet(ctx.db, w("role"), ownershipInterests.role),
    verification: await service.interestFacet(ctx.db, w("verification"), ownershipInterests.verification),
    owner_kind: await service.interestFacet(ctx.db, w("owner_kind"), ownershipInterests.owner_kind),
  };
});

router.get("/ownership/interests/export", async (ctx) => {
  const user = await ctx.require("ownership", "export");
  const p = ctx.listParams();
  const order = applySort(p.sort, service.interestSorts(), desc(ownershipInterests.updated_at));
  const rows = await service
    .interestSelect(ctx.db)
    .where(service.buildInterestWhere(interestFilters(ctx)))
    .orderBy(...order)
    .limit(50_000);
  const out: unknown[][] = [[
    "id", "property_id", "property", "property_state", "owner_kind", "owner_id", "owner", "owner_state", "role",
    "interest_pct", "effective_from", "effective_to", "acquired_price", "disposed_price", "financing_type",
    "source", "confidence", "verification", "evidence_types",
  ]];
  for (const r of rows) {
    const o = service.rowToOut(r, false);
    // Export is an outbound payload: sensitive evidence is never included.
    out.push([
      o.id, o.property_id, o.property_label, o.property_state, o.owner_kind, o.owner_id, o.owner_label, o.owner_state,
      o.role, o.interest_pct, o.effective_from, o.effective_to, o.acquired_price, o.disposed_price, o.financing_type,
      o.source, o.confidence, o.verification,
      service.outboundEvidence(r.oi.evidence).map((e) => e.type ?? "").join("; "),
    ]);
  }
  await audit.record(ctx.db, {
    actor: user, action: "ownership_interest.exported", entity_type: "ownership_interest", summary: `${rows.length} rows`,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csvResponse(csvLines(out), "ownership-interests.csv");
});

router.post("/ownership/interests", async (ctx) => {
  const user = await ctx.require("ownership", "create");
  const body = await ctx.body(interestIn);
  const row = await service.createInterest(ctx.db, body, user);
  return created(await service.interestFull(ctx.db, row.id, user));
});

router.get("/ownership/interests/{interest_id}", async (ctx) => {
  const user = await ctx.require("ownership", "view");
  return service.interestFull(ctx.db, ctx.uuid("interest_id"), user);
});

router.patch("/ownership/interests/{interest_id}", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  const id = ctx.uuid("interest_id");
  const body = await ctx.body(interestUpdate);
  await service.updateInterest(ctx.db, await service.getInterest(ctx.db, id), body, user);
  return service.interestFull(ctx.db, id, user);
});

router.post("/ownership/interests/{interest_id}/end", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  const id = ctx.uuid("interest_id");
  const body = await ctx.body(endInterestIn);
  await service.endInterest(ctx.db, await service.getInterest(ctx.db, id), body, user);
  return service.interestFull(ctx.db, id, user);
});

router.post("/ownership/interests/{interest_id}/verify", async (ctx) => {
  const user = await ctx.require("ownership", "approve");
  const id = ctx.uuid("interest_id");
  const body = await ctx.body(verifyIn);
  await service.verifyInterest(ctx.db, await service.getInterest(ctx.db, id), body.state, user);
  return service.interestFull(ctx.db, id, user);
});

router.get("/ownership/interests/{interest_id}/history", async (ctx) => {
  await ctx.require("ownership", "view");
  return provenance.history(ctx.db, service.ENTITY, ctx.uuid("interest_id"));
});

router.get("/ownership/properties/{property_id}/panel", async (ctx) => {
  const user = await ctx.require("ownership", "view");
  return service.propertyPanel(ctx.db, ctx.uuid("property_id"), user);
});

// ---------------------------------------------------------------- entity links

const LINK_SORTS = {
  confidence: entityLinks.confidence, created_at: entityLinks.created_at, relationship: entityLinks.relationship,
  status: entityLinks.status,
};

router.get("/ownership/links", async (ctx) => {
  const user = await ctx.require("ownership", "view");
  const p = ctx.listParams();
  const where = service.buildLinkWhere(linkFilters(ctx));
  const [rows, total] = await paginate(ctx.db, entityLinks, where, applySort(p.sort, LINK_SORTS, desc(entityLinks.confidence)), p);
  return page(await service.linksOut(ctx.db, rows, user), total, p);
});

router.get("/ownership/links/facets", async (ctx) => {
  await ctx.require("ownership", "view");
  const f = linkFilters(ctx);
  return {
    status: await facetCounts(ctx.db, entityLinks, service.buildLinkWhere(f, new Set(["status"])), entityLinks.status),
    relationship: await facetCounts(
      ctx.db, entityLinks, service.buildLinkWhere(f, new Set(["relationship"])), entityLinks.relationship,
    ),
  };
});

router.get("/ownership/links/export", async (ctx) => {
  const user = await ctx.require("ownership", "export");
  const rows = await ctx.db
    .select()
    .from(entityLinks)
    .where(service.buildLinkWhere(linkFilters(ctx)))
    .orderBy(desc(entityLinks.created_at))
    .limit(50_000);
  const info = await service.nodeInfo(
    ctx.db, rows.flatMap((l): service.Node[] => [[l.from_kind, l.from_id], [l.to_kind, l.to_id]]),
  );
  const out: unknown[][] = [[
    "id", "from_kind", "from_id", "from", "relationship", "to_kind", "to_id", "to", "status", "confidence", "evidence",
    "source", "reviewed_at",
  ]];
  for (const l of rows) {
    const ev = service.outboundEvidence(l.evidence).map((e) => `${e.type}: ${e.detail || ""}`.trim()).join("; ");
    out.push([
      l.id, l.from_kind, l.from_id, info.get(`${l.from_kind}:${l.from_id}`)?.label, l.relationship, l.to_kind, l.to_id,
      info.get(`${l.to_kind}:${l.to_id}`)?.label, l.status, l.confidence, ev, l.source, l.reviewed_at,
    ]);
  }
  await audit.record(ctx.db, {
    actor: user, action: "entity_link.exported", entity_type: "entity_link", summary: `${rows.length} rows`,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csvResponse(csvLines(out), "entity-relationships.csv");
});

router.post("/ownership/links/suggest", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  const [createdN, updated] = await service.suggestLinks(ctx.db, user);
  return { created: createdN, updated };
});

router.post("/ownership/links", async (ctx) => {
  const user = await ctx.require("ownership", "create");
  const body = await ctx.body(linkIn);
  const link = await service.createLink(ctx.db, body, user);
  return created((await service.linksOut(ctx.db, [link], user))[0]);
});

router.patch("/ownership/links/{link_id}", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  const body = await ctx.body(linkUpdate);
  const link = await service.updateLink(ctx.db, await service.getLink(ctx.db, ctx.uuid("link_id")), body, user);
  return (await service.linksOut(ctx.db, [link], user))[0];
});

router.post("/ownership/links/{link_id}/confirm", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  const id = ctx.uuid("link_id");
  const body = await ctx.body(linkReviewIn);
  const link = await service.reviewLink(ctx.db, await service.getLink(ctx.db, id), "confirmed", body, user);
  return (await service.linksOut(ctx.db, [link], user))[0];
});

router.post("/ownership/links/{link_id}/reject", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  const id = ctx.uuid("link_id");
  const body = await ctx.body(linkReviewIn);
  const link = await service.reviewLink(ctx.db, await service.getLink(ctx.db, id), "rejected", body, user);
  return (await service.linksOut(ctx.db, [link], user))[0];
});

// ---------------------------------------------------------------- owners

router.get("/ownership/owners/{kind}/{owner_id}", async (ctx) => {
  const user = await ctx.require("ownership", "view");
  const kind = kindParam(ctx);
  return service.ownerProfile(ctx.db, kind, ctx.uuid("owner_id"), user);
});

router.get("/ownership/owners/{kind}/{owner_id}/notes", async (ctx) => {
  const user = await ctx.require("ownership", "view");
  const kind = kindParam(ctx);
  const [notes] = await service.notesFor(ctx.db, kind, ctx.uuid("owner_id"), user);
  return notes.map(service.noteOut);
});

router.post("/ownership/owners/{kind}/{owner_id}/notes", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  const kind = kindParam(ctx);
  const body = await ctx.body(noteIn);
  return created(service.noteOut(await service.addNote(ctx.db, kind, ctx.uuid("owner_id"), body, user)));
});

router.delete("/ownership/notes/{note_id}", async (ctx) => {
  const user = await ctx.require("ownership", "edit");
  await service.removeNote(ctx.db, ctx.uuid("note_id"), user);
  return noContent();
});

router.get("/ownership/owners/{kind}/{owner_id}/outbound-context", async (ctx) => {
  await ctx.require("ownership", "view");
  const kind = kindParam(ctx);
  return service.outboundContext(ctx.db, kind, ctx.uuid("owner_id"));
});

router.get("/ownership/paths", async (ctx) => {
  await ctx.require("ownership", "view");
  const q = ctx.query;
  const targetKind = q.enum("target_kind", ["person", "organization", "property"] as const);
  if (!targetKind) throw bad("query", "target_kind", "Field required", "missing");
  const targetId = q.uuid("target_id");
  if (!targetId) throw bad("query", "target_id", "Field required", "missing");
  const fromKind = q.enum("from_kind", OWNER_KINDS);
  const fromId = q.uuid("from_id");
  const maxDepth = q.int("max_depth", { ge: 1, le: 4 }) ?? 3;
  const limit = q.int("limit", { ge: 1, le: 20 }) ?? 5;
  const start: service.Node | null = fromKind && fromId ? [fromKind, fromId] : null;
  return service.warmPaths(ctx.db, [targetKind, targetId], start, maxDepth, limit);
});
