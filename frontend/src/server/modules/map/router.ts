import { desc } from "drizzle-orm";

import { applySort, page, paginate } from "../../common/query";
import { created, status } from "../../core/http";
import { type Ctx, Router } from "../../core/router";
import { mapFieldObservations } from "./schema";
import {
  bulkExportIn, bulkOpportunitiesIn, bulkSequenceIn, bulkTerritoryIn, observationIn, saveTerritoryIn, selectIn,
} from "./schemas";
import * as service from "./service";
import type { MapFilters } from "./service";

export const router = new Router();

const DEFAULT_LAYERS = "properties,parcels,opportunities,territories";

function mapFilters(ctx: Ctx): MapFilters {
  const q = ctx.query;
  return {
    bbox: q.str("bbox", { max: 200 }), // minLng,minLat,maxLng,maxLat
    status: q.strs("status"),
    property_type: q.strs("property_type"),
    stage: q.strs("stage"),
    signal_category: q.strs("signal_category"),
    near_lat: q.num("near_lat", { ge: -90, le: 90 }),
    near_lng: q.num("near_lng", { ge: -180, le: 180 }),
    radius_miles: q.num("radius_miles", { gt: 0, le: 200 }),
    polygon: q.str("polygon", { max: 60_000 }), // GeoJSON polygon
    corridor_id: q.uuid("corridor_id"),
    buffer_ft: q.num("buffer_ft", { gt: 0, le: 26_400 }),
    adjacent_to: q.uuid("adjacent_to"), // Parcel id: only records on parcels touching it
  };
}

router.get("/map/config", async (ctx) => {
  const user = await ctx.require("map", "view");
  return service.mapConfig(user);
});

/** One GeoJSON FeatureCollection per requested layer (capped). Layers the user cannot view are listed in `hidden`. */
router.get("/map/layers", async (ctx) => {
  const user = await ctx.require("map", "view");
  const layers = ctx.query.str("layers", { max: 300 }) ?? DEFAULT_LAYERS;
  const f = mapFilters(ctx);
  const requested = [...new Set(layers.split(",").map((k) => k.trim()).filter(Boolean))];
  return service.layers(ctx.db, f, requested, user);
});

router.post("/map/select", async (ctx) => {
  const user = await ctx.require("properties", "view");
  const body = await ctx.body(selectIn);
  service.need(user, "map", "view");
  return service.selectRecords(ctx.db, body, user);
});

// --- bulk actions: `apply: false` returns the preview (counts, skips, warnings); `apply: true` executes ---------

router.post("/map/bulk/opportunities", async (ctx) => {
  const user = await ctx.require("pipeline", "create");
  const body = await ctx.body(bulkOpportunitiesIn);
  service.need(user, "map", "view");
  return service.bulkOpportunities(ctx.db, body, user);
});

router.post("/map/bulk/territory", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(bulkTerritoryIn);
  service.need(user, "map", "view");
  return service.bulkTerritory(ctx.db, body, user);
});

router.post("/map/bulk/sequence", async (ctx) => {
  const user = await ctx.require("outreach", "create");
  const body = await ctx.body(bulkSequenceIn);
  service.need(user, "map", "view");
  service.need(user, "ownership", "view");
  return service.bulkSequence(ctx.db, body, user);
});

router.post("/map/bulk/export", async (ctx) => {
  const user = await ctx.require("contacts", "export");
  const body = await ctx.body(bulkExportIn);
  service.need(user, "map", "view");
  service.need(user, "ownership", "view");
  return service.bulkExport(ctx.db, body, user);
});

/** Saves a drawn polygon as a boundary territory (a drawn circle becomes a radius territory). */
router.post("/map/territories", async (ctx) => {
  const user = await ctx.require("territories", "create");
  const body = await ctx.body(saveTerritoryIn);
  service.need(user, "map", "view");
  const t: any = await service.saveTerritory(ctx.db, body, user);
  return created({ id: t.id, name: t.name, rule_type: t.rule_type, member_count: t.member_count });
});

/** Contiguous parcels sharing a current owner with the parcel, plus their union for highlighting. */
router.get("/map/assemblage", async (ctx) => {
  const user = await ctx.require("parcels", "view");
  const parcelId = ctx.query.uuid("parcel_id");
  if (!parcelId) {
    return status(422, { detail: [{ loc: ["query", "parcel_id"], msg: "Field required", type: "missing" }] });
  }
  service.need(user, "map", "view");
  return service.assemblage(ctx.db, parcelId, user);
});

router.get("/map/card", async (ctx) => {
  const user = await ctx.require("map", "view");
  const kind = ctx.query.need("kind");
  const id = ctx.query.uuid("id");
  if (!id) return status(422, { detail: [{ loc: ["query", "id"], msg: "Field required", type: "missing" }] });
  return service.card(ctx.db, kind, id, user);
});

// --- field observations ----------------------------------------------------------------------------------------

const M = mapFieldObservations;

router.get("/map/observations", async (ctx) => {
  const user = await ctx.require("map", "view");
  const p = ctx.listParams();
  const where = service.observationWhere({
    bbox: ctx.query.str("bbox", { max: 200 }), property_id: ctx.query.uuid("property_id"),
    category: ctx.query.strs("category"), mine: ctx.query.bool("mine") ?? false, user, q: p.q,
  });
  const sorts = { observed_at: M.observed_at, category: M.category };
  const [rows, total] = await paginate(ctx.db, M, where, applySort(p.sort, sorts, desc(M.observed_at)), p);
  return page(await service.observationOuts(ctx.db, rows), total, p);
});

/** Idempotent by `client_uuid` so the offline queue can safely re-send (200 when already stored). */
router.post("/map/observations", async (ctx) => {
  const user = await ctx.require("map", "create");
  const body = await ctx.body(observationIn);
  const [o, isNew] = await service.createObservation(ctx.db, body, user);
  const out = (await service.observationOuts(ctx.db, [o]))[0];
  return isNew ? created(out) : out;
});

router.get("/map/observations/{obs_id}", async (ctx) => {
  await ctx.require("map", "view");
  const o = await service.getObservation(ctx.db, ctx.uuid("obs_id"));
  return (await service.observationOuts(ctx.db, [o]))[0];
});
