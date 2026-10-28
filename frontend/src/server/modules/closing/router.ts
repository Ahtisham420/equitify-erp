import { and, eq, isNull, sql } from "drizzle-orm";

import { applySort, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import {
  CHECKLIST_CATEGORIES, CHECKLIST_TEMPLATE, CLOSING_STATUSES, HANDOFF_SECTIONS, ITEM_STATUSES, SOURCE_KINDS, USE_KINDS,
  closingSnapshots, closings, handoffPackages, wireVerifications,
} from "./schema";
import {
  auditCompleteIn, callbackIn, checklistItemIn, checklistItemUpdate, closingCreate, closingUpdate, completeIn,
  handoffUpdate, sourcesUsesIn, wireIn,
} from "./schemas";
import * as service from "./service";
import type { ClosingFilters } from "./service";
import type { Db } from "../../db";

export const router = new Router();

const t = closings;
const SORTS = {
  scheduled_closing_on: t.scheduled_closing_on, closed_on: t.closed_on, status: t.status,
  purchase_price: t.purchase_price, basis: t.basis, created_at: t.created_at, updated_at: t.updated_at,
};

function filters(ctx: Ctx): ClosingFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    coordinator_id: q.uuids("coordinator_id"),
    manager_id: q.uuids("manager_id"),
    opportunity_id: q.uuid("opportunity_id"),
    property_id: q.uuid("property_id"),
    asset_pending: q.bool("asset_pending"),
    scheduled_from: q.date("scheduled_from"),
    scheduled_to: q.date("scheduled_to"),
  };
}

router.get("/closings", async (ctx) => {
  await ctx.require("closing", "view");
  const p = ctx.listParams();
  const where = service.buildWhere(filters(ctx));
  const order = applySort(p.sort, SORTS, sql`${t.scheduled_closing_on} asc nulls last`);
  const total = await service.countClosings(ctx.db, where);
  const rows = await service
    .selectClosings(ctx.db, where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return page(await service.toItems(ctx.db, rows.map((r) => r.c)), total, p);
});

router.get("/closings/facets", async (ctx) => {
  await ctx.require("closing", "view");
  const where = service.buildWhere(filters(ctx), new Set(["status"]));
  return { status: await service.statusFacets(ctx.db, where), wire_status: {} };
});

router.get("/closings/meta", async (ctx) => {
  await ctx.require("closing", "view");
  return {
    statuses: CLOSING_STATUSES, categories: CHECKLIST_CATEGORIES, item_statuses: ITEM_STATUSES,
    source_kinds: SOURCE_KINDS, use_kinds: USE_KINDS, template: CHECKLIST_TEMPLATE, handoff_sections: HANDOFF_SECTIONS,
  };
});

router.patch("/closings/checklist/{item_id}", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const body = await ctx.body(checklistItemUpdate);
  const i = await service.updateItem(ctx.db, await service.getItem(ctx.db, ctx.uuid("item_id")), body, user);
  return (await service.items(ctx.db, await service.get(ctx.db, i.closing_id))).find((x) => x.id === i.id);
});

router.delete("/closings/checklist/{item_id}", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  await service.deleteItem(ctx.db, await service.getItem(ctx.db, ctx.uuid("item_id")), user);
  return noContent();
});

router.post("/closings/wires/{wire_id}/callback", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const body = await ctx.body(callbackIn);
  const w = await service.recordCallback(ctx.db, await service.getWire(ctx.db, ctx.uuid("wire_id")), body, user);
  return service.wireOut(w, user);
});

router.post("/closings", async (ctx) => {
  const user = await ctx.require("closing", "create");
  const body = await ctx.body(closingCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user)));
});

router.get("/closings/{closing_id}", async (ctx) => {
  await ctx.require("closing", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")));
});

router.patch("/closings/{closing_id}", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const body = await ctx.body(closingUpdate);
  return service.toOut(ctx.db, await service.update(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")), body, user));
});

router.get("/closings/{closing_id}/checklist", async (ctx) => {
  await ctx.require("closing", "view");
  return service.items(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")));
});

router.post("/closings/{closing_id}/checklist", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const body = await ctx.body(checklistItemIn);
  const c = await service.get(ctx.db, ctx.uuid("closing_id"));
  const i = await service.addItem(ctx.db, c, body, user);
  return created((await service.items(ctx.db, c)).find((x) => x.id === i.id));
});

router.post("/closings/{closing_id}/checklist/apply-template", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  return { added: await service.applyTemplate(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")), user) };
});

router.get("/closings/{closing_id}/wires", async (ctx) => {
  const user = await ctx.require("closing", "view");
  const closing_id = ctx.uuid("closing_id");
  await service.get(ctx.db, closing_id);
  const w = wireVerifications;
  const rows = await ctx.db
    .select()
    .from(w)
    .where(and(eq(w.closing_id, closing_id), isNull(w.deleted_at)))
    .orderBy(sql`${w.created_at} desc`);
  return rows.map((r) => service.wireOut(r, user));
});

router.post("/closings/{closing_id}/wires", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const body = await ctx.body(wireIn);
  const w = await service.addWire(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")), body, user);
  return created(service.wireOut(w, user));
});

router.put("/closings/{closing_id}/sources-uses", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const body = await ctx.body(sourcesUsesIn);
  const c = await service.setSourcesUses(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")), body, user);
  return service.toOut(ctx.db, c);
});

router.post("/closings/{closing_id}/complete", async (ctx) => {
  const user = await ctx.require("closing", "approve");
  const body = await ctx.body(completeIn);
  const c = await service.complete(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")), body, user);
  return service.toOut(ctx.db, c);
});

router.post("/closings/{closing_id}/retry-asset", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const c = await service.retryAsset(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")), user);
  return service.toOut(ctx.db, c);
});

router.get("/closings/{closing_id}/snapshot", async (ctx) => {
  await ctx.require("closing", "view");
  const closing_id = ctx.uuid("closing_id");
  await service.get(ctx.db, closing_id);
  const [snap] = await ctx.db.select().from(closingSnapshots).where(eq(closingSnapshots.closing_id, closing_id)).limit(1);
  if (!snap) throw new HttpError(404, "No snapshot yet: it is written when the closing completes");
  return snap;
});

const HANDOFF_OUT = [
  "id", "closing_id", "asset_id", "property_id", "sections", "open_dd_items", "carry_forward", "generated_at",
  "recipient_id", "acknowledged_at", "acknowledged_by_id", "updated_at",
] as const;
const handoffOut = (pkg: Record<string, any>) => Object.fromEntries(HANDOFF_OUT.map((k) => [k, pkg[k]]));

async function loadPackage(db: Db, closing_id: string) {
  await service.get(db, closing_id);
  const [pkg] = await db
    .select()
    .from(handoffPackages)
    .where(and(eq(handoffPackages.closing_id, closing_id), isNull(handoffPackages.deleted_at)))
    .limit(1);
  if (!pkg) throw new HttpError(404, "The handoff package is generated when the closing completes");
  return pkg;
}

router.get("/closings/{closing_id}/handoff", async (ctx) => {
  await ctx.require("closing", "view");
  return handoffOut(await loadPackage(ctx.db, ctx.uuid("closing_id")));
});

router.patch("/closings/{closing_id}/handoff", async (ctx) => {
  const user = await ctx.require("closing", "edit");
  const body = await ctx.body(handoffUpdate);
  return handoffOut(await service.updateHandoff(ctx.db, await loadPackage(ctx.db, ctx.uuid("closing_id")), body, user));
});

router.post("/closings/{closing_id}/handoff/acknowledge", async (ctx) => {
  const user = await ctx.require("closing", "view");
  // Operations (asset managers) acknowledge receipt; they may hold assets rights without closing edit.
  if (!(user.can("closing", "edit") || user.can("assets", "edit"))) {
    throw new HttpError(403, "Missing permission closing:edit or assets:edit");
  }
  return handoffOut(await service.acknowledgeHandoff(ctx.db, await loadPackage(ctx.db, ctx.uuid("closing_id")), user));
});

router.get("/closings/{closing_id}/post-close-audit", async (ctx) => {
  await ctx.require("closing", "view");
  return service.postCloseAudit(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")));
});

router.post("/closings/{closing_id}/post-close-audit/complete", async (ctx) => {
  const user = await ctx.require("closing", "view");
  const body = await ctx.body(auditCompleteIn);
  if (!(user.can("closing", "edit") || user.can("assets", "edit"))) {
    throw new HttpError(403, "Missing permission closing:edit or assets:edit");
  }
  const c = await service.completeAudit(ctx.db, await service.get(ctx.db, ctx.uuid("closing_id")), body, user);
  return service.toOut(ctx.db, c);
});
