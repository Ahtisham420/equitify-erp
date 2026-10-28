import { asc, desc, sql } from "drizzle-orm";

import { applySort, facetCounts, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import * as propertyService from "../properties/service";
import { properties } from "../properties/schema";
import {
  GROWTH_KINDS,
  ROAD_CLASSES,
  RULE_TYPES,
  TRADE_AREA_MINUTES,
  VISIBILITIES,
  corridors,
  growthRecords,
  nodes,
  tradeAreas,
  trafficCounts,
  territories,
  territoryMembers,
} from "./schema";
import {
  corridorIn,
  corridorUpdate,
  growthIn,
  growthUpdate,
  membersIn,
  nodeIn,
  nodeUpdate,
  tradeAreaIn,
  tradeAreaUpdate,
  trafficCountIn,
  trafficCountUpdate,
  territoryIn,
  territoryUpdate,
} from "./schemas";
import * as service from "./service";

// No prefix: serves /corridors, /nodes, /traffic-counts, /trade-areas, /growth-records, /territories, /geography/*
export const router = new Router();

/** PATCH: ignore explicit nulls for required (non-nullable) fields; absent keys stay absent. */
function clean(values: Record<string, any>, ...required: string[]): Record<string, any> {
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && !(required.includes(k) && v === null)));
}

router.get("/geography/meta", async (ctx) => {
  await ctx.require("territories", "view");
  return {
    rule_types: RULE_TYPES, visibilities: VISIBILITIES, road_classes: ROAD_CLASSES, growth_kinds: GROWTH_KINDS,
    trade_area_minutes: TRADE_AREA_MINUTES,
  };
});

// ============================================================================= corridors

const CORRIDOR_SORTS = {
  name: corridors.name, road_name: corridors.road_name, road_class: corridors.road_class, city: corridors.city,
  county: corridors.county, frontage_length_ft: corridors.frontage_length_ft, updated_at: corridors.updated_at,
};

function corridorFilters(ctx: Ctx): service.CorridorFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    road_class: q.strs("road_class"),
    county: q.str("county"),
    city: q.str("city"),
    has_geometry: q.bool("has_geometry"),
  };
}

router.get("/corridors", async (ctx) => {
  await ctx.require("territories", "view");
  const p = ctx.listParams();
  const order = applySort(p.sort, CORRIDOR_SORTS, asc(corridors.name));
  const { items, total } = await service.listCorridors(ctx.db, corridorFilters(ctx), order, p);
  return page(items, total, p);
});

router.get("/corridors/facets", async (ctx) => {
  await ctx.require("territories", "view");
  const f = corridorFilters(ctx);
  f.road_class = undefined;
  return { road_class: await facetCounts(ctx.db, corridors, service.corridorWhere(f), corridors.road_class) };
});

router.get("/corridors/geojson", async (ctx) => {
  await ctx.require("territories", "view");
  const f = corridorFilters(ctx);
  const limit = ctx.query.int("limit", { ge: 1, le: 5000 }) ?? 1000;
  return service.corridorsGeojson(ctx.db, f, limit);
});

router.post("/corridors", async (ctx) => {
  const user = await ctx.require("territories", "create");
  const { geometry, ...values } = await ctx.body(corridorIn);
  const c = await service.createRecord(ctx.db, corridors, values, user, "corridor", { geometry, kind: "line" });
  return created(await service.corridorOut(ctx.db, c));
});

router.get("/corridors/{corridor_id}", async (ctx) => {
  await ctx.require("territories", "view");
  return service.corridorOut(ctx.db, await service.getObj(ctx.db, corridors, ctx.uuid("corridor_id"), "Corridor"));
});

router.patch("/corridors/{corridor_id}", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(corridorUpdate);
  const c = await service.getObj(ctx.db, corridors, ctx.uuid("corridor_id"), "Corridor");
  const { geometry, clear_geometry, ...rest } = body;
  const values = clean(rest, "name", "road_class");
  const updated = await service.updateRecord(ctx.db, corridors, c, values, user, "corridor", {
    geometry, clear_geometry, kind: "line",
  });
  return service.corridorOut(ctx.db, updated);
});

router.delete("/corridors/{corridor_id}", async (ctx) => {
  const user = await ctx.require("territories", "delete");
  await service.archiveRecord(
    ctx.db, corridors, await service.getObj(ctx.db, corridors, ctx.uuid("corridor_id"), "Corridor"), user, "corridor",
  );
  return noContent();
});

// ============================================================================= nodes

const NODE_SORTS = { name: nodes.name, city: nodes.city, county: nodes.county, updated_at: nodes.updated_at };

function nodeFilters(ctx: Ctx): service.NodeFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    corridor_id: q.uuid("corridor_id"),
    county: q.str("county"),
    city: q.str("city"),
    signalized: q.bool("signalized"),
  };
}

router.get("/nodes", async (ctx) => {
  await ctx.require("territories", "view");
  const p = ctx.listParams();
  const order = applySort(p.sort, NODE_SORTS, asc(nodes.name));
  const { items, total } = await service.listNodes(ctx.db, nodeFilters(ctx), order, p);
  return page(items, total, p);
});

router.post("/nodes", async (ctx) => {
  const user = await ctx.require("territories", "create");
  const body = await ctx.body(nodeIn);
  if (body.corridor_id) await service.getObj(ctx.db, corridors, body.corridor_id, "Corridor");
  const n = await service.createRecord(ctx.db, nodes, body, user, "node");
  return created(await service.nodeDetail(ctx.db, n.id));
});

router.get("/nodes/{node_id}", async (ctx) => {
  await ctx.require("territories", "view");
  return service.nodeDetail(ctx.db, ctx.uuid("node_id"));
});

router.patch("/nodes/{node_id}", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(nodeUpdate);
  const id = ctx.uuid("node_id");
  const n = await service.getObj(ctx.db, nodes, id, "Node");
  if (body.corridor_id) await service.getObj(ctx.db, corridors, body.corridor_id, "Corridor");
  await service.updateRecord(ctx.db, nodes, n, clean(body, "name", "approach_traffic", "quadrants"), user, "node");
  return service.nodeDetail(ctx.db, id);
});

router.delete("/nodes/{node_id}", async (ctx) => {
  const user = await ctx.require("territories", "delete");
  await service.archiveRecord(ctx.db, nodes, await service.getObj(ctx.db, nodes, ctx.uuid("node_id"), "Node"), user, "node");
  return noContent();
});

// ============================================================================= traffic counts

const TRAFFIC_SORTS = {
  count: trafficCounts.count, count_year: trafficCounts.count_year, segment: trafficCounts.segment,
  source: trafficCounts.source, observed_on: trafficCounts.observed_on, updated_at: trafficCounts.updated_at,
};

function trafficFilters(ctx: Ctx): service.TrafficFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    corridor_id: q.uuid("corridor_id"),
    node_id: q.uuid("node_id"),
    min_year: q.int("min_year"),
    max_year: q.int("max_year"),
    min_count: q.int("min_count"),
    max_count: q.int("max_count"),
    source: q.str("source"),
  };
}

router.get("/traffic-counts", async (ctx) => {
  await ctx.require("territories", "view");
  const p = ctx.listParams();
  const order = applySort(p.sort, TRAFFIC_SORTS, desc(trafficCounts.count_year));
  const { items, total } = await service.listTraffic(ctx.db, trafficFilters(ctx), order, p);
  return page(items, total, p);
});

router.get("/traffic-counts/trend", async (ctx) => {
  await ctx.require("territories", "view");
  const q = ctx.query;
  return service.trafficTrend(ctx.db, {
    corridor_id: q.uuid("corridor_id"), node_id: q.uuid("node_id"), segment: q.str("segment"), approach: q.str("approach"),
  });
});

async function checkTrafficLinks(ctx: Ctx, corridorId?: string | null, nodeId?: string | null) {
  if (corridorId) await service.getObj(ctx.db, corridors, corridorId, "Corridor");
  if (nodeId) await service.getObj(ctx.db, nodes, nodeId, "Node");
}

router.post("/traffic-counts", async (ctx) => {
  const user = await ctx.require("territories", "create");
  const body = await ctx.body(trafficCountIn);
  await checkTrafficLinks(ctx, body.corridor_id, body.node_id);
  const t = await service.createRecord(ctx.db, trafficCounts, body, user, "traffic_count", {
    summary: `${body.count.toLocaleString("en-US")} (${body.count_year}) — ${body.segment || body.approach || ""}`,
  });
  return created(await service.trafficDetail(ctx.db, t.id));
});

router.get("/traffic-counts/{count_id}", async (ctx) => {
  await ctx.require("territories", "view");
  return service.trafficDetail(ctx.db, ctx.uuid("count_id"));
});

router.patch("/traffic-counts/{count_id}", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(trafficCountUpdate);
  const id = ctx.uuid("count_id");
  const t = await service.getObj(ctx.db, trafficCounts, id, "Traffic count");
  await checkTrafficLinks(ctx, body.corridor_id, body.node_id);
  await service.updateRecord(ctx.db, trafficCounts, t, clean(body, "count", "count_year", "count_type", "source"), user, "traffic_count");
  return service.trafficDetail(ctx.db, id);
});

router.delete("/traffic-counts/{count_id}", async (ctx) => {
  const user = await ctx.require("territories", "delete");
  await service.archiveRecord(
    ctx.db, trafficCounts, await service.getObj(ctx.db, trafficCounts, ctx.uuid("count_id"), "Traffic count"), user, "traffic_count",
  );
  return noContent();
});

// ============================================================================= trade areas

async function checkTradeLinks(ctx: Ctx, nodeId?: string | null, propertyId?: string | null) {
  if (nodeId) await service.getObj(ctx.db, nodes, nodeId, "Node");
  if (propertyId) await propertyService.getProperty(ctx.db, propertyId);
}

router.get("/trade-areas", async (ctx) => {
  await ctx.require("territories", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const order = applySort(
    p.sort,
    { minutes: tradeAreas.minutes, observed_on: tradeAreas.observed_on, updated_at: tradeAreas.updated_at },
    desc(tradeAreas.updated_at),
  );
  const { items, total } = await service.listTradeAreas(
    ctx.db, { node_id: q.uuid("node_id"), property_id: q.uuid("property_id"), minutes: q.ints("minutes"), q: p.q }, order, p,
  );
  return page(items, total, p);
});

router.post("/trade-areas", async (ctx) => {
  const user = await ctx.require("territories", "create");
  const { geometry, ...values } = await ctx.body(tradeAreaIn);
  if (!values.node_id && !values.property_id) throw new HttpError(422, "Link the trade area to a node or a property");
  await checkTradeLinks(ctx, values.node_id, values.property_id);
  const t = await service.createRecord(ctx.db, tradeAreas, values, user, "trade_area", {
    geometry, kind: "polygon", summary: values.name || `${values.minutes}-minute drive time`,
  });
  return created(await service.tradeDetail(ctx.db, t.id));
});

router.get("/trade-areas/{trade_area_id}", async (ctx) => {
  await ctx.require("territories", "view");
  return service.tradeDetail(ctx.db, ctx.uuid("trade_area_id"));
});

router.patch("/trade-areas/{trade_area_id}", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(tradeAreaUpdate);
  const id = ctx.uuid("trade_area_id");
  const t = await service.getObj(ctx.db, tradeAreas, id, "Trade area");
  await checkTradeLinks(ctx, body.node_id, body.property_id);
  const { geometry, ...rest } = body;
  const values = clean(rest, "minutes", "source", "demographics", "competitors", "anchors");
  await service.updateRecord(ctx.db, tradeAreas, t, values, user, "trade_area", { geometry, kind: "polygon" });
  return service.tradeDetail(ctx.db, id);
});

router.delete("/trade-areas/{trade_area_id}", async (ctx) => {
  const user = await ctx.require("territories", "delete");
  await service.archiveRecord(
    ctx.db, tradeAreas, await service.getObj(ctx.db, tradeAreas, ctx.uuid("trade_area_id"), "Trade area"), user, "trade_area",
  );
  return noContent();
});

// ============================================================================= growth context

const GROWTH_SORTS = {
  name: growthRecords.name, kind: growthRecords.kind, event_date: growthRecords.event_date, units: growthRecords.units,
  value: growthRecords.value, observed_on: growthRecords.observed_on, updated_at: growthRecords.updated_at,
};

function growthFilters(ctx: Ctx): service.GrowthFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    kind: q.strs("kind"),
    county: q.str("county"),
    city: q.str("city"),
    from_date: q.date("from_date"),
    to_date: q.date("to_date"),
    near_lat: q.num("near_lat", { ge: -90, le: 90 }),
    near_lng: q.num("near_lng", { ge: -180, le: 180 }),
    property_id: q.uuid("property_id"),
    node_id: q.uuid("node_id"),
    radius_miles: q.num("radius_miles", { gt: 0, le: 100 }),
  };
}

router.get("/growth-records", async (ctx) => {
  await ctx.require("territories", "view");
  const p = ctx.listParams();
  const f = growthFilters(ctx);
  const { items, total } = await service.listGrowth(
    ctx.db,
    f,
    (distance) =>
      applySort(p.sort, { ...GROWTH_SORTS, distance_miles: distance }, sql`${growthRecords.event_date} desc nulls last`),
    p,
  );
  return page(items, total, p);
});

router.get("/growth-records/facets", async (ctx) => {
  await ctx.require("territories", "view");
  const { where } = await service.growthParts(ctx.db, growthFilters(ctx), new Set(["kind"]));
  return { kind: await facetCounts(ctx.db, growthRecords, where, growthRecords.kind) };
});

router.post("/growth-records", async (ctx) => {
  const user = await ctx.require("territories", "create");
  const g = await service.createRecord(ctx.db, growthRecords, await ctx.body(growthIn), user, "growth_record");
  return created(service.growthOut(g, null));
});

router.get("/growth-records/{record_id}", async (ctx) => {
  await ctx.require("territories", "view");
  return service.growthOut(await service.getObj(ctx.db, growthRecords, ctx.uuid("record_id"), "Growth record"), null);
});

router.patch("/growth-records/{record_id}", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(growthUpdate);
  const g = await service.getObj(ctx.db, growthRecords, ctx.uuid("record_id"), "Growth record");
  const updated = await service.updateRecord(
    ctx.db, growthRecords, g, clean(body, "kind", "name", "latitude", "longitude", "source"), user, "growth_record",
  );
  return service.growthOut(updated, null);
});

router.delete("/growth-records/{record_id}", async (ctx) => {
  const user = await ctx.require("territories", "delete");
  await service.archiveRecord(
    ctx.db, growthRecords, await service.getObj(ctx.db, growthRecords, ctx.uuid("record_id"), "Growth record"), user, "growth_record",
  );
  return noContent();
});

// ============================================================================= geography-driven property search

/** Query properties by corridor buffer, node radius, traffic and growth conditions. */
router.get("/geography/properties", async (ctx) => {
  const user = await ctx.require("territories", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const f: service.GeoPropertyFilters = {
    q: q.str("q", { max: 200 }),
    corridor_id: q.uuid("corridor_id"),
    buffer_ft: q.num("buffer_ft", { gt: 0, le: 26_400 }),
    node_id: q.uuid("node_id"),
    radius_miles: q.num("radius_miles", { gt: 0, le: 100 }),
    min_traffic: q.int("min_traffic", { ge: 0 }),
    traffic_radius_miles: q.num("traffic_radius_miles", { gt: 0, le: 10 }),
    growth_kind: q.strs("growth_kind"),
    growth_radius_miles: q.num("growth_radius_miles", { gt: 0, le: 50 }),
    territory_id: q.uuid("territory_id"),
  };
  if (!user.can("properties", "view")) throw new HttpError(403, "Missing permission properties:view");
  if (f.territory_id) await service.getVisible(ctx.db, f.territory_id, user);
  const { items, total } = await service.geoProperties(ctx.db, f, p.sort, p);
  return page(items, total, p);
});

// ============================================================================= territories

const TERRITORY_SORTS = {
  name: territories.name, rule_type: territories.rule_type, visibility: territories.visibility,
  member_count: territories.member_count, updated_at: territories.updated_at, last_computed_at: territories.last_computed_at,
};

function territoryFilters(ctx: Ctx): service.TerritoryFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    rule_type: q.strs("rule_type"),
    visibility: q.strs("visibility"),
    parent_id: q.uuid("parent_id"),
    top_level: q.bool("top_level"),
    mine: q.bool("mine"),
  };
}

router.get("/territories", async (ctx) => {
  const user = await ctx.require("territories", "view");
  const p = ctx.listParams();
  const order = applySort(p.sort, TERRITORY_SORTS, asc(territories.name));
  const { items, total } = await service.listTerritories(ctx.db, territoryFilters(ctx), user, order, p);
  return page(items, total, p);
});

router.get("/territories/facets", async (ctx) => {
  const user = await ctx.require("territories", "view");
  const f = territoryFilters(ctx);
  return {
    rule_type: await facetCounts(ctx.db, territories, service.territoryWhere(f, user, new Set(["rule_type"])), territories.rule_type),
    visibility: await facetCounts(ctx.db, territories, service.territoryWhere(f, user, new Set(["visibility"])), territories.visibility),
  };
});

router.get("/territories/options", async (ctx) => {
  const user = await ctx.require("territories", "view");
  return (await service.listTerritories(ctx.db, {}, user, [asc(territories.name)])).items;
});

router.get("/territories/for-property/{property_id}", async (ctx) => {
  const user = await ctx.require("territories", "view");
  return service.forProperty(ctx.db, ctx.uuid("property_id"), user);
});

router.post("/territories", async (ctx) => {
  const user = await ctx.require("territories", "create");
  const body = await ctx.body(territoryIn);
  const t = await service.createTerritory(ctx.db, body, user);
  return created(await service.territoryOut(ctx.db, t, user));
});

router.get("/territories/{territory_id}", async (ctx) => {
  const user = await ctx.require("territories", "view");
  return service.territoryOut(ctx.db, await service.getVisible(ctx.db, ctx.uuid("territory_id"), user), user);
});

router.patch("/territories/{territory_id}", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(territoryUpdate);
  let t = await service.getVisible(ctx.db, ctx.uuid("territory_id"), user);
  service.requireEdit(t, user);
  t = await service.updateTerritory(ctx.db, t, body, user);
  return service.territoryOut(ctx.db, t, user);
});

router.delete("/territories/{territory_id}", async (ctx) => {
  const user = await ctx.require("territories", "delete");
  const t = await service.getVisible(ctx.db, ctx.uuid("territory_id"), user);
  service.requireEdit(t, user);
  await service.archiveTerritory(ctx.db, t, user);
  return noContent();
});

router.post("/territories/{territory_id}/recompute", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const t = await service.getVisible(ctx.db, ctx.uuid("territory_id"), user);
  return service.recomputeAndCommit(ctx.db, t, user);
});

router.get("/territories/{territory_id}/geojson", async (ctx) => {
  const user = await ctx.require("territories", "view");
  const t = await service.getVisible(ctx.db, ctx.uuid("territory_id"), user);
  return {
    type: "Feature",
    id: t.id,
    geometry: await service.geojsonOf(ctx.db, territories, t.id),
    properties: { id: t.id, name: t.name, rule_type: t.rule_type, member_count: t.member_count },
  };
});

router.get("/territories/{territory_id}/members", async (ctx) => {
  const user = await ctx.require("territories", "view");
  const p = ctx.listParams();
  const source = ctx.query.strs("source");
  const id = ctx.uuid("territory_id");
  await service.getVisible(ctx.db, id, user);
  const order = applySort(
    p.sort,
    {
      address_line: properties.address_line, city: properties.city, status: properties.status,
      added_at: territoryMembers.added_at, source: territoryMembers.source,
    },
    asc(properties.address_line),
  );
  const { items, total } = await service.listMembers(ctx.db, id, { q: p.q, source }, order, p);
  return page(items, total, p);
});

router.post("/territories/{territory_id}/members", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const body = await ctx.body(membersIn);
  const t = await service.getVisible(ctx.db, ctx.uuid("territory_id"), user);
  service.requireEdit(t, user);
  return { added: await service.addMembers(ctx.db, t, body, user) };
});

router.delete("/territories/{territory_id}/members/{property_id}", async (ctx) => {
  const user = await ctx.require("territories", "edit");
  const t = await service.getVisible(ctx.db, ctx.uuid("territory_id"), user);
  service.requireEdit(t, user);
  await service.removeMember(ctx.db, t, ctx.uuid("property_id"), user);
  return noContent();
});

router.get("/territories/{territory_id}/overlaps", async (ctx) => {
  const user = await ctx.require("territories", "view");
  return service.overlaps(ctx.db, await service.getVisible(ctx.db, ctx.uuid("territory_id"), user), user);
});
