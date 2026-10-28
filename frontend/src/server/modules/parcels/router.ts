import { desc } from "drizzle-orm";

import * as provenance from "../../common/provenance";
import { applySort, facetCounts, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import * as propertyService from "../properties/service";
import * as territoryService from "../territories/service";
import { OCCUPANCY_STATES, PARCEL_RELATIONSHIPS, SPACE_USE_TYPES, parcels } from "./schema";
import {
  bulkAssociateIn,
  buildingIn,
  buildingUpdate,
  parcelCreate,
  parcelMergeIn,
  parcelUpdate,
  propertyParcelIn,
  propertyParcelUpdate,
  spaceIn,
  spaceUpdate,
} from "./schemas";
import * as service from "./service";
import type { ParcelFilters } from "./service";

// No prefix: this router serves /parcels/* and the property hierarchy under /properties/{id}/...
export const router = new Router();

const t = parcels;
const SORTS = {
  apn: t.apn, county: t.county, state: t.state, acreage: t.acreage, observed_on: t.observed_on,
  updated_at: t.updated_at, created_at: t.created_at,
};

function filters(ctx: Ctx): ParcelFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    county: q.strs("county"),
    state: q.strs("state"),
    min_acres: q.num("min_acres"),
    max_acres: q.num("max_acres"),
    has_geometry: q.bool("has_geometry"),
    property_id: q.uuid("property_id"),
    linked: q.bool("linked"),
    bbox: q.str("bbox", { max: 120 }),
    near_lat: q.num("near_lat", { ge: -90, le: 90 }),
    near_lng: q.num("near_lng", { ge: -180, le: 180 }),
    radius_miles: q.num("radius_miles", { gt: 0, le: 200 }),
    territory_id: q.uuid("territory_id"),
    ids: q.uuids("ids"),
  };
}

/** Spatial filtering by territory only for territories the user may see. */
async function territoryGuard(ctx: Ctx, f: ParcelFilters, user: Awaited<ReturnType<Ctx["authed"]>>) {
  if (f.territory_id) await territoryService.getVisible(ctx.db, f.territory_id, user);
}

// ----------------------------------------------------------------------------- parcels

router.get("/parcels", async (ctx) => {
  const user = await ctx.require("parcels", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  await territoryGuard(ctx, f, user);
  const order = applySort(p.sort, SORTS, desc(t.updated_at));
  const [items, total] = await service.listPage(ctx.db, f, order, p);
  return page(items, total, p);
});

router.get("/parcels/facets", async (ctx) => {
  const user = await ctx.require("parcels", "view");
  const f = filters(ctx);
  await territoryGuard(ctx, f, user);
  return {
    county: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["county"])), t.county),
    state: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["state"])), t.state),
  };
});

router.get("/parcels/meta", async (ctx) => {
  await ctx.require("parcels", "view");
  return { relationships: PARCEL_RELATIONSHIPS, occupancy_states: OCCUPANCY_STATES, space_use_types: SPACE_USE_TYPES };
});

/** FeatureCollection for map layers. Use `bbox=minLng,minLat,maxLng,maxLat` plus any list filter. */
router.get("/parcels/geojson", async (ctx) => {
  const user = await ctx.require("parcels", "view");
  const f = filters(ctx);
  const limit = ctx.query.int("limit", { ge: 1, le: 10_000 }) ?? 2000;
  await territoryGuard(ctx, f, user);
  return service.featureCollection(ctx.db, f, limit);
});

/** Preview (default) or apply: link many parcels to an existing property or a new one. */
router.post("/parcels/bulk-associate", async (ctx) => {
  const user = await ctx.require("parcels", "edit");
  const body = await ctx.body(bulkAssociateIn);
  if (body.new_property && !body.preview && !user.can("properties", "create")) {
    throw new HttpError(403, "Missing permission properties:create");
  }
  return service.bulkAssociate(ctx.db, body, user);
});

router.post("/parcels", async (ctx) => {
  const user = await ctx.require("parcels", "create");
  const body = await ctx.body(parcelCreate);
  const force = ctx.query.bool("force") ?? false;
  if (force && !user.can("parcels", "approve")) {
    throw new HttpError(403, "Creating a possible duplicate parcel requires approval permission");
  }
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user, { force })));
});

router.get("/parcels/{parcel_id}", async (ctx) => {
  await ctx.require("parcels", "view");
  return service.toOut(ctx.db, await service.getParcel(ctx.db, ctx.uuid("parcel_id")));
});

router.patch("/parcels/{parcel_id}", async (ctx) => {
  const user = await ctx.require("parcels", "edit");
  const body = await ctx.body(parcelUpdate);
  const p = await service.update(ctx.db, await service.getParcel(ctx.db, ctx.uuid("parcel_id")), body, user);
  return service.toOut(ctx.db, p);
});

router.delete("/parcels/{parcel_id}", async (ctx) => {
  const user = await ctx.require("parcels", "delete");
  await service.archive(ctx.db, await service.getParcel(ctx.db, ctx.uuid("parcel_id")), user);
  return noContent();
});

/** Merge a reviewed duplicate (`parcel_id`) into `into_id`. Never automatic. */
router.post("/parcels/{parcel_id}/merge", async (ctx) => {
  const user = await ctx.require("parcels", "approve");
  const body = await ctx.body(parcelMergeIn);
  const source = await service.getParcel(ctx.db, ctx.uuid("parcel_id"));
  const target = await service.getParcel(ctx.db, body.into_id);
  return service.toOut(ctx.db, await service.merge(ctx.db, source, target, user));
});

router.get("/parcels/{parcel_id}/geojson", async (ctx) => {
  await ctx.require("parcels", "view");
  return service.feature(ctx.db, await service.getParcel(ctx.db, ctx.uuid("parcel_id")));
});

router.get("/parcels/{parcel_id}/adjacent", async (ctx) => {
  const user = await ctx.require("parcels", "view");
  const tol = ctx.query.num("tolerance_m", { ge: 0, le: 100 }) ?? service.ADJACENCY_TOLERANCE_M;
  return service.adjacent(ctx.db, await service.getParcel(ctx.db, ctx.uuid("parcel_id")), user, tol);
});

router.get("/parcels/{parcel_id}/assemblage", async (ctx) => {
  const user = await ctx.require("parcels", "view");
  const tol = ctx.query.num("tolerance_m", { ge: 0, le: 100 }) ?? service.ADJACENCY_TOLERANCE_M;
  return service.assemblage(ctx.db, await service.getParcel(ctx.db, ctx.uuid("parcel_id")), user, tol);
});

router.get("/parcels/{parcel_id}/properties", async (ctx) => {
  await ctx.require("parcels", "view");
  const id = ctx.uuid("parcel_id");
  await service.getParcel(ctx.db, id);
  return service.parcelProperties(ctx.db, id);
});

router.get("/parcels/{parcel_id}/versions", async (ctx) => {
  await ctx.require("parcels", "view");
  const id = ctx.uuid("parcel_id");
  await service.getParcel(ctx.db, id);
  return service.versions(ctx.db, id);
});

router.get("/parcels/{parcel_id}/history", async (ctx) => {
  await ctx.require("parcels", "view");
  return provenance.history(ctx.db, service.ENTITY, ctx.uuid("parcel_id"), ctx.query.str("field"));
});

// ----------------------------------------------------------------------------- property hierarchy

router.get("/properties/{property_id}/parcels", async (ctx) => {
  await ctx.require("parcels", "view");
  const id = ctx.uuid("property_id");
  await propertyService.getProperty(ctx.db, id);
  return service.propertyParcelsFor(ctx.db, id);
});

router.post("/properties/{property_id}/parcels", async (ctx) => {
  const user = await ctx.require("parcels", "edit");
  const body = await ctx.body(propertyParcelIn);
  const id = ctx.uuid("property_id");
  await propertyService.getProperty(ctx.db, id);
  const link = await service.linkParcel(ctx.db, id, body, user);
  return created({ link_id: link.id });
});

router.patch("/properties/{property_id}/parcels/{link_id}", async (ctx) => {
  const user = await ctx.require("parcels", "edit");
  const body = await ctx.body(propertyParcelUpdate);
  const link = await service.updateLink(ctx.db, await service.getLink(ctx.db, ctx.uuid("property_id"), ctx.uuid("link_id")), body, user);
  return { link_id: link.id, relationship: link.relationship };
});

router.delete("/properties/{property_id}/parcels/{link_id}", async (ctx) => {
  const user = await ctx.require("parcels", "edit");
  await service.unlink(ctx.db, await service.getLink(ctx.db, ctx.uuid("property_id"), ctx.uuid("link_id")), user);
  return noContent();
});

router.get("/properties/{property_id}/buildings", async (ctx) => {
  await ctx.require("parcels", "view");
  const id = ctx.uuid("property_id");
  await propertyService.getProperty(ctx.db, id);
  return service.listBuildings(ctx.db, id);
});

router.post("/properties/{property_id}/buildings", async (ctx) => {
  const user = await ctx.require("parcels", "create");
  const body = await ctx.body(buildingIn);
  const id = ctx.uuid("property_id");
  await propertyService.getProperty(ctx.db, id);
  return created(service.buildingOut(await service.createBuilding(ctx.db, id, body, user)));
});

router.patch("/properties/{property_id}/buildings/{building_id}", async (ctx) => {
  const user = await ctx.require("parcels", "edit");
  const body = await ctx.body(buildingUpdate);
  const b = await service.getBuilding(ctx.db, ctx.uuid("property_id"), ctx.uuid("building_id"));
  return service.buildingOut(await service.updateBuilding(ctx.db, b, body, user));
});

router.delete("/properties/{property_id}/buildings/{building_id}", async (ctx) => {
  const user = await ctx.require("parcels", "delete");
  await service.archiveBuilding(ctx.db, await service.getBuilding(ctx.db, ctx.uuid("property_id"), ctx.uuid("building_id")), user);
  return noContent();
});

router.get("/properties/{property_id}/spaces", async (ctx) => {
  await ctx.require("parcels", "view");
  const id = ctx.uuid("property_id");
  const q = ctx.query.str("q", { max: 200 });
  const building_id = ctx.query.uuid("building_id");
  const occupancy_status = ctx.query.strs("occupancy_status");
  await propertyService.getProperty(ctx.db, id);
  return (await service.listSpaces(ctx.db, id, { q, building_id, occupancy_status })).map(service.spaceOut);
});

router.post("/properties/{property_id}/spaces", async (ctx) => {
  const user = await ctx.require("parcels", "create");
  const body = await ctx.body(spaceIn);
  const id = ctx.uuid("property_id");
  await propertyService.getProperty(ctx.db, id);
  return created(service.spaceOut(await service.createSpace(ctx.db, id, body, user)));
});

router.patch("/properties/{property_id}/spaces/{space_id}", async (ctx) => {
  const user = await ctx.require("parcels", "edit");
  const body = await ctx.body(spaceUpdate);
  const s = await service.getSpace(ctx.db, ctx.uuid("property_id"), ctx.uuid("space_id"));
  return service.spaceOut(await service.updateSpace(ctx.db, s, body, user));
});

router.delete("/properties/{property_id}/spaces/{space_id}", async (ctx) => {
  const user = await ctx.require("parcels", "delete");
  await service.archiveSpace(ctx.db, await service.getSpace(ctx.db, ctx.uuid("property_id"), ctx.uuid("space_id")), user);
  return noContent();
});

router.get("/spaces/{space_id}/history", async (ctx) => {
  await ctx.require("parcels", "view");
  return provenance.history(ctx.db, "space", ctx.uuid("space_id"));
});
