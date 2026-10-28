import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { properties } from "../properties/schema";
import {
  ADJUSTMENT_FACTORS, bovs, compSets, LEASE_BASES, leaseComps, RECOVERY_TYPES, SALE_BASES, saleComps, TENANT_CREDIT,
  VALUATION_METHODS, valuationDocuments, valuations, VERIFICATION_METHODS, VERIFICATION_STATUSES,
} from "./schema";
import {
  addItemsIn, bovCreate, bovUpdate, compSetCreate, compSetUpdate, fromCompSetIn, gridIn, itemUpdate, leaseCompCreate,
  leaseCompUpdate, saleCompCreate, saleCompUpdate, valuationCreate, valuationDocumentIn, verificationIn,
} from "./schemas";
import * as service from "./service";
import type { CandidateQuery, CompFilters, CompSetFilters, ValuationFilters } from "./service";

export const router = new Router();

const SALE_SORTS = {
  name: saleComps.name, city: saleComps.city, sale_date: saleComps.sale_date, sale_price: saleComps.sale_price,
  price_psf: saleComps.price_psf, cap_rate: saleComps.cap_rate, property_type: saleComps.property_type,
  verification_status: saleComps.verification_status, updated_at: saleComps.updated_at,
};
const LEASE_SORTS = {
  tenant_name: leaseComps.tenant_name, city: leaseComps.city, commencement_on: leaseComps.commencement_on,
  base_rent_psf: leaseComps.base_rent_psf, effective_rent_psf: leaseComps.effective_rent_psf,
  term_months: leaseComps.term_months, area_sf: leaseComps.area_sf,
  verification_status: leaseComps.verification_status, updated_at: leaseComps.updated_at,
};
const SET_SORTS = { name: compSets.name, kind: compSets.kind, status: compSets.status, updated_at: compSets.updated_at };
const VALUATION_SORTS = {
  as_of: valuations.as_of, method: valuations.method, value_point: valuations.value_point, created_at: valuations.created_at,
};

router.get("/comps/meta", async (ctx) => {
  await ctx.require("comps", "view");
  return {
    verification_statuses: VERIFICATION_STATUSES, verification_methods: VERIFICATION_METHODS,
    tenant_credit: TENANT_CREDIT, recovery_types: RECOVERY_TYPES, valuation_methods: VALUATION_METHODS,
    adjustment_factors: ADJUSTMENT_FACTORS, sale_bases: SALE_BASES, lease_bases: LEASE_BASES,
    valuation_material: service.VALUATION_MATERIAL,
  };
});

function candidateParams(ctx: Ctx): CandidateQuery {
  const q = ctx.query;
  return {
    kind: q.str("kind", { pattern: /^(sale|lease)$/ }) ?? "sale",
    subject_property_id: q.uuid("subject_property_id"),
    near_lat: q.num("near_lat", { ge: -90, le: 90 }),
    near_lng: q.num("near_lng", { ge: -180, le: 180 }),
    radius_miles: q.num("radius_miles", { gt: 0, le: 500 }),
    property_type: q.strs("property_type"),
    county: q.str("county"),
    corridor: q.str("corridor"),
    tenant_credit: q.strs("tenant_credit"),
    min_term_years: q.num("min_term_years", { ge: 0 }),
    max_term_years: q.num("max_term_years", { ge: 0 }),
    date_from: q.date("date_from"),
    date_to: q.date("date_to"),
    verified_only: q.bool("verified_only") ?? false,
    exclude_set_id: q.uuid("exclude_set_id"),
    q: q.str("q", { max: 200 }),
    limit: q.int("limit", { ge: 1, le: 200 }) ?? 50,
  };
}

router.get("/comps/candidates", async (ctx) => {
  await ctx.require("comps", "view");
  const cq = candidateParams(ctx);
  return (await service.candidates(ctx.db, cq)).map(service.toCandidate);
});

// --------------------------------------------------------------------------- sale / lease comps

function compFilters(ctx: Ctx): CompFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    property_type: q.strs("property_type"),
    verification_status: q.strs("verification_status"),
    tenant_credit: q.strs("tenant_credit"),
    state: q.strs("state"),
    county: q.str("county"),
    corridor: q.str("corridor"),
    property_id: q.uuid("property_id"),
    date_from: q.date("date_from"),
    date_to: q.date("date_to"),
    min_price: q.num("min_price"),
    max_price: q.num("max_price"),
    min_cap: q.num("min_cap"),
    max_cap: q.num("max_cap"),
    min_rent: q.num("min_rent"),
    max_rent: q.num("max_rent"),
  };
}

async function compFacets(ctx: Ctx, kind: "sale" | "lease", f: CompFilters) {
  const M: any = service.COMP_MODELS[kind];
  const w = (skip: string) => service.buildCompWhere(kind, f, new Set([skip]));
  return {
    property_type: await facetCounts(ctx.db, M, w("property_type"), M.property_type),
    verification_status: await facetCounts(ctx.db, M, w("verification_status"), M.verification_status),
    tenant_credit: await facetCounts(ctx.db, M, w("tenant_credit"), M.tenant_credit),
    state: await facetCounts(ctx.db, M, w("state"), M.state),
  };
}

router.get("/sale-comps", async (ctx) => {
  await ctx.require("comps", "view");
  const p = ctx.listParams();
  const f = compFilters(ctx);
  const order = applySort(p.sort, SALE_SORTS, sql`${saleComps.sale_date} desc nulls last`);
  const [rows, total] = await paginate(ctx.db, saleComps, service.buildCompWhere("sale", f), order, p);
  return page(await service.compOut(ctx.db, "sale", rows), total, p);
});

router.get("/sale-comps/facets", async (ctx) => {
  await ctx.require("comps", "view");
  return compFacets(ctx, "sale", compFilters(ctx));
});

router.post("/sale-comps", async (ctx) => {
  const user = await ctx.require("comps", "create");
  const body = await ctx.body(saleCompCreate);
  const c = await service.createComp(ctx.db, "sale", body, user);
  return created((await service.compOut(ctx.db, "sale", [c]))[0]);
});

router.get("/sale-comps/{comp_id}", async (ctx) => {
  await ctx.require("comps", "view");
  return (await service.compOut(ctx.db, "sale", [await service.getComp(ctx.db, "sale", ctx.uuid("comp_id"))]))[0];
});

router.patch("/sale-comps/{comp_id}", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(saleCompUpdate);
  const c = await service.updateComp(ctx.db, "sale", await service.getComp(ctx.db, "sale", ctx.uuid("comp_id")), body, user);
  return (await service.compOut(ctx.db, "sale", [c]))[0];
});

router.post("/sale-comps/{comp_id}/verify", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(verificationIn);
  const c = await service.verifyComp(ctx.db, "sale", await service.getComp(ctx.db, "sale", ctx.uuid("comp_id")), body, user);
  return (await service.compOut(ctx.db, "sale", [c]))[0];
});

router.delete("/sale-comps/{comp_id}", async (ctx) => {
  const user = await ctx.require("comps", "delete");
  await service.archiveComp(ctx.db, "sale", await service.getComp(ctx.db, "sale", ctx.uuid("comp_id")), user);
  return noContent();
});

router.get("/lease-comps", async (ctx) => {
  await ctx.require("comps", "view");
  const p = ctx.listParams();
  const f = compFilters(ctx);
  const order = applySort(p.sort, LEASE_SORTS, sql`${leaseComps.commencement_on} desc nulls last`);
  const [rows, total] = await paginate(ctx.db, leaseComps, service.buildCompWhere("lease", f), order, p);
  return page(await service.compOut(ctx.db, "lease", rows), total, p);
});

router.get("/lease-comps/facets", async (ctx) => {
  await ctx.require("comps", "view");
  return compFacets(ctx, "lease", compFilters(ctx));
});

router.post("/lease-comps", async (ctx) => {
  const user = await ctx.require("comps", "create");
  const body = await ctx.body(leaseCompCreate);
  const c = await service.createComp(ctx.db, "lease", body, user);
  return created((await service.compOut(ctx.db, "lease", [c]))[0]);
});

router.get("/lease-comps/{comp_id}", async (ctx) => {
  await ctx.require("comps", "view");
  return (await service.compOut(ctx.db, "lease", [await service.getComp(ctx.db, "lease", ctx.uuid("comp_id"))]))[0];
});

router.patch("/lease-comps/{comp_id}", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(leaseCompUpdate);
  const c = await service.updateComp(ctx.db, "lease", await service.getComp(ctx.db, "lease", ctx.uuid("comp_id")), body, user);
  return (await service.compOut(ctx.db, "lease", [c]))[0];
});

router.post("/lease-comps/{comp_id}/verify", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(verificationIn);
  const c = await service.verifyComp(ctx.db, "lease", await service.getComp(ctx.db, "lease", ctx.uuid("comp_id")), body, user);
  return (await service.compOut(ctx.db, "lease", [c]))[0];
});

router.delete("/lease-comps/{comp_id}", async (ctx) => {
  const user = await ctx.require("comps", "delete");
  await service.archiveComp(ctx.db, "lease", await service.getComp(ctx.db, "lease", ctx.uuid("comp_id")), user);
  return noContent();
});

// --------------------------------------------------------------------------- comp sets

function setFilters(ctx: Ctx): CompSetFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    kind: q.strs("kind"),
    status: q.strs("status"),
    purpose: q.strs("purpose"),
    subject_property_id: q.uuid("subject_property_id"),
  };
}

router.get("/comp-sets", async (ctx) => {
  await ctx.require("comps", "view");
  const p = ctx.listParams();
  const f = setFilters(ctx);
  const order = applySort(p.sort, SET_SORTS, desc(compSets.updated_at));
  const [rows, total] = await paginate(ctx.db, compSets, service.buildSetWhere(f), order, p);
  return page(await service.setsOut(ctx.db, rows), total, p);
});

router.get("/comp-sets/facets", async (ctx) => {
  await ctx.require("comps", "view");
  const f = setFilters(ctx);
  const w = (skip: string) => service.buildSetWhere(f, new Set([skip]));
  return {
    kind: await facetCounts(ctx.db, compSets, w("kind"), compSets.kind),
    status: await facetCounts(ctx.db, compSets, w("status"), compSets.status),
    purpose: await facetCounts(ctx.db, compSets, w("purpose"), compSets.purpose),
  };
});

router.post("/comp-sets", async (ctx) => {
  const user = await ctx.require("comps", "create");
  const body = await ctx.body(compSetCreate);
  return created(await service.setOut(ctx.db, await service.createSet(ctx.db, body, user)));
});

router.get("/comp-sets/{set_id}", async (ctx) => {
  await ctx.require("comps", "view");
  return service.setOut(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")));
});

router.patch("/comp-sets/{set_id}", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(compSetUpdate);
  return service.setOut(ctx.db, await service.updateSet(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")), body, user));
});

router.delete("/comp-sets/{set_id}", async (ctx) => {
  const user = await ctx.require("comps", "delete");
  await service.archiveSet(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")), user);
  return noContent();
});

router.get("/comp-sets/{set_id}/candidates", async (ctx) => {
  await ctx.require("comps", "view");
  const cq = candidateParams(ctx);
  const cs = await service.getSet(ctx.db, ctx.uuid("set_id"));
  cq.kind = cs.kind;
  cq.subject_property_id = cq.subject_property_id || cs.subject_property_id || undefined;
  cq.exclude_set_id = cs.id;
  return (await service.candidates(ctx.db, cq)).map(service.toCandidate);
});

router.post("/comp-sets/{set_id}/items", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(addItemsIn);
  return service.setOut(ctx.db, await service.addItems(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")), body, user));
});

router.patch("/comp-sets/{set_id}/items/{item_id}", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(itemUpdate);
  const cs = await service.updateItem(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")), ctx.uuid("item_id"), body, user);
  return service.setOut(ctx.db, cs);
});

router.put("/comp-sets/{set_id}/grid", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(gridIn);
  return service.setOut(ctx.db, await service.saveGrid(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")), body, user));
});

router.post("/comp-sets/{set_id}/valuation", async (ctx) => {
  const user = await ctx.require("comps", "create");
  const body = await ctx.body(fromCompSetIn);
  const v = await service.valuationFromSet(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")), body, user);
  return created((await service.valuationsOut(ctx.db, [v]))[0]);
});

router.post("/comp-sets/{set_id}/bov", async (ctx) => {
  const user = await ctx.require("comps", "create");
  const body = await ctx.body(bovCreate);
  const b = await service.createBov(ctx.db, await service.getSet(ctx.db, ctx.uuid("set_id")), body, user);
  return created((await service.bovsOut(ctx.db, [b]))[0]);
});

// --------------------------------------------------------------------------- valuations & marks

function valuationFilters(ctx: Ctx): ValuationFilters {
  const q = ctx.query;
  return {
    property_id: q.uuid("property_id"),
    method: q.strs("method"),
    is_mark: q.bool("is_mark"),
    latest_only: q.bool("latest_only") ?? false,
    as_of_from: q.date("as_of_from"),
    as_of_to: q.date("as_of_to"),
    comp_set_id: q.uuid("comp_set_id"),
  };
}

router.get("/valuations", async (ctx) => {
  await ctx.require("comps", "view");
  const p = ctx.listParams();
  const f = valuationFilters(ctx);
  const order = applySort(p.sort, VALUATION_SORTS, desc(valuations.as_of));
  const where = and(
    service.buildValuationWhere(f),
    p.q
      ? inArray(
          valuations.property_id,
          ctx.db
            .select({ id: properties.id })
            .from(properties)
            .where(or(ilike(properties.name, `%${p.q}%`), ilike(properties.address_line, `%${p.q}%`))),
        )
      : undefined,
  );
  const [rows, total] = await paginate(ctx.db, valuations, where, order, p);
  return page(await service.valuationsOut(ctx.db, rows), total, p);
});

router.get("/valuations/facets", async (ctx) => {
  await ctx.require("comps", "view");
  const f = valuationFilters(ctx);
  const w = (skip: string) => service.buildValuationWhere(f, new Set([skip]));
  return {
    method: await facetCounts(ctx.db, valuations, w("method"), valuations.method),
    is_mark: await facetCounts(ctx.db, valuations, w("is_mark"), valuations.is_mark),
  };
});

router.post("/valuations/preview", async (ctx) => {
  await ctx.require("comps", "view");
  const body = await ctx.body(valuationCreate);
  const [result, , unsourced] = await service.computeValuation(ctx.db, body);
  await ctx.db.rollback(); // preview never persists (sales comparison may have refreshed a comp set's cached range)
  return {
    value_low: result.value_low ?? null, value_high: result.value_high ?? null, value_point: result.value_point ?? null,
    calculation: result.calculation, unsourced,
  };
});

router.post("/valuations", async (ctx) => {
  const user = await ctx.require("comps", "create");
  const body = await ctx.body(valuationCreate);
  const v = await service.createValuation(ctx.db, body, user);
  return created((await service.valuationsOut(ctx.db, [v]))[0]);
});

router.get("/valuations/documents", async (ctx) => {
  await ctx.require("comps", "view");
  ctx.query.need("property_id");
  const property_id = ctx.query.uuid("property_id")!;
  const rows = await ctx.db
    .select()
    .from(valuationDocuments)
    .where(and(eq(valuationDocuments.property_id, property_id), isNull(valuationDocuments.deleted_at)))
    .orderBy(desc(valuationDocuments.created_at));
  return rows.map(service.valuationDocumentOut);
});

router.post("/valuations/documents", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(valuationDocumentIn);
  return created(service.valuationDocumentOut(await service.addDocument(ctx.db, body, user)));
});

router.delete("/valuations/documents/{link_id}", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  await service.removeDocument(ctx.db, ctx.uuid("link_id"), user);
  return noContent();
});

router.get("/valuations/{valuation_id}", async (ctx) => {
  await ctx.require("comps", "view");
  return (await service.valuationsOut(ctx.db, [await service.getValuation(ctx.db, ctx.uuid("valuation_id"))]))[0];
});

router.delete("/valuations/{valuation_id}", async (ctx) => {
  const user = await ctx.require("comps", "delete");
  await service.archiveValuation(ctx.db, await service.getValuation(ctx.db, ctx.uuid("valuation_id")), user);
  return noContent();
});

// --------------------------------------------------------------------------- BOVs

router.get("/bovs", async (ctx) => {
  await ctx.require("comps", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const property_id = q.uuid("property_id");
  const comp_set_id = q.uuid("comp_set_id");
  const status = q.strs("status");
  const where = and(
    isNull(bovs.deleted_at),
    property_id ? eq(bovs.property_id, property_id) : undefined,
    comp_set_id ? eq(bovs.comp_set_id, comp_set_id) : undefined,
    status ? inArray(bovs.status, status) : undefined,
    p.q ? ilike(bovs.title, `%${p.q}%`) : undefined,
  );
  const order = applySort(p.sort, { title: bovs.title, created_at: bovs.created_at, status: bovs.status }, desc(bovs.created_at));
  const [rows, total] = await paginate(ctx.db, bovs, where, order, p);
  return page(await service.bovsOut(ctx.db, rows), total, p);
});

router.get("/bovs/{bov_id}", async (ctx) => {
  await ctx.require("comps", "view");
  return (await service.bovsOut(ctx.db, [await service.getBov(ctx.db, ctx.uuid("bov_id"))]))[0];
});

router.patch("/bovs/{bov_id}", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const body = await ctx.body(bovUpdate);
  const b = await service.updateBov(ctx.db, await service.getBov(ctx.db, ctx.uuid("bov_id")), body, user);
  return (await service.bovsOut(ctx.db, [b]))[0];
});

router.post("/bovs/{bov_id}/regenerate", async (ctx) => {
  const user = await ctx.require("comps", "edit");
  const b = await service.regenerateBov(ctx.db, await service.getBov(ctx.db, ctx.uuid("bov_id")), user);
  return (await service.bovsOut(ctx.db, [b]))[0];
});

