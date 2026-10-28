import { desc } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySort, facetCounts, page, paginate } from "../../common/query";
import { csvResponse, created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { PROPERTY_STATUSES, PROPERTY_TYPES, properties } from "./schema";
import { bulkIn, propertyCreate, propertyUpdate, verifyIn } from "./schemas";
import * as service from "./service";
import type { PropertyFilters } from "./service";

export const router = new Router();

const t = properties;
const SORTS = {
  name: t.name, address_line: t.address_line, city: t.city, property_type: t.property_type, status: t.status,
  building_area_sf: t.building_area_sf, land_area_acres: t.land_area_acres, asking_price: t.asking_price,
  year_built: t.year_built, completeness_score: t.completeness_score, updated_at: t.updated_at, created_at: t.created_at,
};

function filters(ctx: Ctx): PropertyFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    property_type: q.strs("property_type"),
    state: q.strs("state"),
    county: q.str("county"),
    city: q.str("city"),
    tag: q.strs("tag"),
    min_area: q.num("min_area"),
    max_area: q.num("max_area"),
    min_acres: q.num("min_acres"),
    max_acres: q.num("max_acres"),
    min_price: q.num("min_price"),
    max_price: q.num("max_price"),
    min_year: q.int("min_year"),
    max_year: q.int("max_year"),
    min_completeness: q.num("min_completeness"),
    near_lat: q.num("near_lat"),
    near_lng: q.num("near_lng"),
    radius_miles: q.num("radius_miles", { gt: 0, le: 200 }),
    ids: q.uuids("ids"),
  };
}

const LIST_COLUMNS = [
  "id", "name", "address_line", "city", "state", "county", "property_type", "status", "building_area_sf",
  "land_area_acres", "asking_price", "occupancy_pct", "year_built", "completeness_score", "tags", "updated_at",
] as const;
const pick = (row: Record<string, any>) => Object.fromEntries(LIST_COLUMNS.map((c) => [c, row[c]]));

router.get("/properties", async (ctx) => {
  await ctx.require("properties", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  const order = applySort(p.sort, SORTS, desc(t.updated_at));
  const [items, total] = await paginate(ctx.db, t, service.buildWhere(f), order, p);
  return page(items.map(pick), total, p);
});

router.get("/properties/facets", async (ctx) => {
  await ctx.require("properties", "view");
  const f = filters(ctx);
  return {
    status: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["status"])), t.status),
    property_type: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["property_type"])), t.property_type),
    state: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["state"])), t.state),
  };
});

router.get("/properties/meta", async (ctx) => {
  await ctx.require("properties", "view");
  return { statuses: PROPERTY_STATUSES, types: PROPERTY_TYPES };
});

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get("/properties/export", async (ctx) => {
  const user = await ctx.require("properties", "export");
  const p = ctx.listParams();
  const f = filters(ctx);
  const order = applySort(p.sort, SORTS, desc(t.updated_at));
  const rows = await ctx.db.select().from(t).where(service.buildWhere(f)).orderBy(...order).limit(50_000);
  const cols = [
    "id", "name", "address_line", "city", "state", "postal_code", "county", "property_type", "status",
    "building_area_sf", "land_area_acres", "year_built", "asking_price", "occupancy_pct", "noi", "zoning", "completeness_score",
  ];
  const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell((r as Record<string, any>)[c])).join(","))];
  await audit.record(ctx.db, {
    actor: user, action: "property.exported", entity_type: "property", summary: `${rows.length} rows`,
    changes: { filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== "")) },
    ip_address: user.ip_address,
  });
  return csvResponse(lines.join("\r\n") + "\r\n", "properties.csv");
});

router.post("/properties", async (ctx) => {
  const user = await ctx.require("properties", "create");
  const body = await ctx.body(propertyCreate);
  const force = ctx.query.bool("force") ?? false;
  if (force && !user.can("properties", "approve")) {
    throw new HttpError(403, "Creating a possible duplicate requires approval permission");
  }
  const p = await service.create(ctx.db, body, user, force);
  return created(await service.toOut(ctx.db, p));
});

router.post("/properties/bulk", async (ctx) => {
  const user = await ctx.require("properties", "edit");
  return { updated: await service.bulkUpdate(ctx.db, await ctx.body(bulkIn), user) };
});

router.get("/properties/{property_id}", async (ctx) => {
  await ctx.require("properties", "view");
  return service.toOut(ctx.db, await service.getProperty(ctx.db, ctx.uuid("property_id")));
});

router.patch("/properties/{property_id}", async (ctx) => {
  const user = await ctx.require("properties", "edit");
  const body = await ctx.body(propertyUpdate);
  const p = await service.update(ctx.db, await service.getProperty(ctx.db, ctx.uuid("property_id")), body, user);
  return service.toOut(ctx.db, p);
});

router.delete("/properties/{property_id}", async (ctx) => {
  const user = await ctx.require("properties", "delete");
  await service.archive(ctx.db, await service.getProperty(ctx.db, ctx.uuid("property_id")), user);
  return noContent();
});

router.get("/properties/{property_id}/history", async (ctx) => {
  await ctx.require("properties", "view");
  return provenance.history(ctx.db, service.ENTITY, ctx.uuid("property_id"), ctx.query.str("field"));
});

router.post("/properties/observations/{obs_id}/verify", async (ctx) => {
  const user = await ctx.require("properties", "edit");
  const body = await ctx.body(verifyIn);
  return service.verifyObservation(ctx.db, ctx.uuid("obs_id"), body.state, user);
});
