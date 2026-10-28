import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySort, facetCounts, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import {
  AMENDMENT_KINDS, CAP_TYPES, CLAUSE_CATEGORIES, ESCALATION_METHODS, GUARANTY_TYPES, LEASE_STATUSES, LEASE_TYPES,
  leaseAmendments, leaseOptions, leases, OPTION_STATUSES, OPTION_TYPES, OVERRIDABLE_FIELDS, PRICING_METHODS,
  RECOVERY_CATEGORIES, RECOVERY_METHODS, recoveryReconciliations, rentSteps,
} from "./schema";
import {
  amendmentIn, clauseIn, escalationIn, guarantyIn, leaseCreate, leaseUpdate, optionIn, reconRunIn, recoveryIn,
  rentStepIn, unsetDefaults, verifyIn,
} from "./schemas";
import * as service from "./service";
import type { LeaseFilters } from "./service";
import { today } from "./util";

export const router = new Router();

function filters(ctx: Ctx): LeaseFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    lease_type: q.strs("lease_type"),
    verified: q.strs("verified"),
    property_id: q.uuid("property_id"),
    asset_id: q.uuid("asset_id"),
    tenant_organization_id: q.uuid("tenant_organization_id"),
    expiring_within: q.int("expiring_within", { ge: 1, le: 3650 }),
    expires_from: q.date("expires_from"),
    expires_to: q.date("expires_to"),
    min_sf: q.num("min_sf"),
    max_sf: q.num("max_sf"),
  };
}

const needUuid = (ctx: Ctx, name: string): string => ctx.query.uuid(name) ?? ctx.query.need(name);

router.get("/leases", async (ctx) => {
  await ctx.require("leases", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  const sorts = { ...service.SORTS, current_annual_rent: service.currentRentExpr() };
  const order = applySort(p.sort, sorts, desc(leases.updated_at));
  const { rows, total } = await service.listRows(ctx.db, f, order, p);
  return page(service.listItems(rows), total, p);
});

router.get("/leases/facets", async (ctx) => {
  await ctx.require("leases", "view");
  const f = filters(ctx);
  const w = service.buildWhere;
  const verified = await facetCounts(ctx.db, leases, w(f, new Set(["verified"])), leases.verified);
  return {
    status: await facetCounts(ctx.db, leases, w(f, new Set(["status"])), leases.status),
    lease_type: await facetCounts(ctx.db, leases, w(f, new Set(["lease_type"])), leases.lease_type),
    verified: Object.fromEntries(Object.entries(verified).map(([k, v]) => [k.toLowerCase(), v])),
    expiring: await service.expiringCounts(ctx.db, f),
  };
});

router.get("/leases/meta", async (ctx) => {
  await ctx.require("leases", "view");
  return {
    statuses: LEASE_STATUSES, types: LEASE_TYPES, escalation_methods: ESCALATION_METHODS,
    recovery_methods: RECOVERY_METHODS, recovery_categories: RECOVERY_CATEGORIES, cap_types: CAP_TYPES,
    option_types: OPTION_TYPES, option_statuses: OPTION_STATUSES, pricing_methods: PRICING_METHODS,
    clause_categories: CLAUSE_CATEGORIES, amendment_kinds: AMENDMENT_KINDS, guaranty_types: GUARANTY_TYPES,
    overridable_fields: [...OVERRIDABLE_FIELDS].sort(),
  };
});

router.get("/leases/rent-roll", async (ctx) => {
  await ctx.require("leases", "view");
  const q = ctx.query;
  return service.rentRoll(ctx.db, q.uuid("property_id"), q.uuid("asset_id"), q.date("as_of"));
});

router.get("/leases/rollover", async (ctx) => {
  await ctx.require("leases", "view");
  const q = ctx.query;
  return service.rollover(
    ctx.db, q.uuid("property_id"), q.uuid("asset_id"), q.int("years", { ge: 1, le: 30 }) ?? 10, q.date("as_of"),
  );
});

router.get("/leases/for-underwriting", async (ctx) => {
  await ctx.require("leases", "view");
  return service.forUnderwriting(ctx.db, needUuid(ctx, "property_id"));
});

router.get("/leases/space-options", async (ctx) => {
  await ctx.require("leases", "view");
  const rows = await service.spaceOptions(ctx.db, needUuid(ctx, "property_id"));
  return rows.map((s) => ({
    id: s.id, suite: s.suite, area_sf: s.area_sf, occupancy_status: s.occupancy_status, tenant_name: s.tenant_name,
  }));
});

router.get("/leases/documents/{document_id}/open", async (ctx) => {
  const user = await ctx.require("leases", "view");
  const document_id = ctx.uuid("document_id");
  const pg = ctx.query.int("page", { ge: 1 });
  if (!user.can("documents", "view")) throw new HttpError(403, "Missing permission documents:view");
  return { url: await service.documentUrl(ctx.db, document_id, pg, user) };
});

// --------------------------------------------------------------------------- reconciliations

async function reconOut(ctx: Ctx, rows: Recon[]) {
  const ids = [...new Set(rows.map((r) => r.lease_id))];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const l of await ctx.db.select({ id: leases.id, name: leases.tenant_name }).from(leases).where(inArray(leases.id, ids))) {
      names.set(l.id, l.name);
    }
  }
  return rows.map((r) => service.reconciliationOut(r, names.get(r.lease_id) ?? null));
}
type Recon = typeof recoveryReconciliations.$inferSelect;

router.get("/leases/reconciliations", async (ctx) => {
  await ctx.require("leases", "view");
  const q = ctx.query;
  const r = recoveryReconciliations;
  const status = q.strs("status");
  const year = q.int("year");
  const rows = await ctx.db
    .select()
    .from(r)
    .where(and(
      isNull(r.deleted_at),
      q.uuid("property_id") ? eq(r.property_id, q.uuid("property_id")!) : undefined,
      q.uuid("lease_id") ? eq(r.lease_id, q.uuid("lease_id")!) : undefined,
      year ? eq(r.year, year) : undefined,
      status ? inArray(r.status, status) : undefined,
    ))
    .orderBy(desc(r.year))
    .limit(500);
  return reconOut(ctx, rows);
});

router.post("/leases/reconciliations/run", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const body = await ctx.body(reconRunIn);
  const [items, createdN, updated, locked] = await service.runReconciliation(ctx.db, body, user);
  return { created: createdN, updated, skipped_locked: locked, items: await reconOut(ctx, items) };
});

router.post("/leases/reconciliations/{rec_id}/finalize", async (ctx) => {
  const user = await ctx.require("leases", "approve");
  const rec = await service._child(ctx.db, recoveryReconciliations, ctx.uuid("rec_id"), "Reconciliation");
  return (await reconOut(ctx, [await service.finalizeReconciliation(ctx.db, rec, user)]))[0];
});

// --------------------------------------------------------------------------- lease record

router.post("/leases", async (ctx) => {
  const user = await ctx.require("leases", "create");
  const body = await ctx.body(leaseCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user)));
});

router.get("/leases/{lease_id}", async (ctx) => {
  await ctx.require("leases", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("lease_id")));
});

router.patch("/leases/{lease_id}", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const id = ctx.uuid("lease_id");
  const body = await ctx.body(leaseUpdate);
  const lease = await service.update(ctx.db, await service.get(ctx.db, id), body, user);
  return service.toOut(ctx.db, lease);
});

router.delete("/leases/{lease_id}", async (ctx) => {
  const user = await ctx.require("leases", "delete");
  await service.archive(ctx.db, await service.get(ctx.db, ctx.uuid("lease_id")), user);
  return noContent();
});

router.post("/leases/{lease_id}/verify", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const id = ctx.uuid("lease_id");
  const body = await ctx.body(verifyIn);
  const lease = await service.verify(ctx.db, await service.get(ctx.db, id), body.verified, user);
  return service.toOut(ctx.db, lease);
});

router.get("/leases/{lease_id}/history", async (ctx) => {
  await ctx.require("leases", "view");
  return provenance.history(ctx.db, service.ENTITY, ctx.uuid("lease_id"), ctx.query.str("field"));
});

router.post("/leases/observations/{obs_id}/verify", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const id = ctx.uuid("obs_id");
  const body = await ctx.body(verifyIn);
  const obs = await provenance.setVerification(ctx.db, id, body.verified ? "verified" : "rejected", user.id);
  if (!obs || obs.entity_type !== service.ENTITY) throw new HttpError(404, "Observation not found");
  await audit.record(ctx.db, {
    actor: user, action: `lease.field_${obs.verification}`, entity_type: service.ENTITY, entity_id: obs.entity_id,
    summary: obs.field, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return obs;
});

router.get("/leases/{lease_id}/operative-terms", async (ctx) => {
  await ctx.require("leases", "view");
  const id = ctx.uuid("lease_id");
  const as_of = ctx.query.date("as_of");
  return service.operativeTerms(ctx.db, await service.get(ctx.db, id), as_of);
});

router.get("/leases/{lease_id}/schedule", async (ctx) => {
  await ctx.require("leases", "view");
  const id = ctx.uuid("lease_id");
  const verifiedOnly = ctx.query.bool("verified_only") ?? false;
  await service.get(ctx.db, id);
  return service.rentSchedule(ctx.db, id, verifiedOnly);
});

router.post("/leases/{lease_id}/critical-dates/generate", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const lease = await service.get(ctx.db, ctx.uuid("lease_id"));
  const [generated, skipped, available] = await service.generateCriticalDates(ctx.db, lease, user);
  if (!available) return { generated: 0, skipped_unverified: 0, available: false };
  if (!lease.verified) throw new HttpError(409, "Verify the lease abstract before generating critical dates");
  await audit.record(ctx.db, {
    actor: user, action: "lease.critical_dates_generated", entity_type: service.ENTITY, entity_id: lease.id,
    summary: `${generated} dates, ${skipped} unverified terms skipped`, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return { generated, skipped_unverified: skipped, available: true };
});

router.post("/leases/{lease_id}/import-extractions", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  return service.importExtractions(ctx.db, await service.get(ctx.db, ctx.uuid("lease_id")), user);
});

// --------------------------------------------------------------------------- rent steps

router.get("/leases/{lease_id}/rent-steps", async (ctx) => {
  await ctx.require("leases", "view");
  const id = ctx.uuid("lease_id");
  await service.get(ctx.db, id);
  return (await service.allSteps(ctx.db, id)).map((s) => service.rentStepOut(s));
});

router.post("/leases/{lease_id}/rent-steps", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const id = ctx.uuid("lease_id");
  const body = await ctx.body(rentStepIn);
  return created(service.rentStepOut(await service.addStep(ctx.db, await service.get(ctx.db, id), body, user)));
});

router.post("/leases/{lease_id}/rent-steps/generate", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const id = ctx.uuid("lease_id");
  const body = await ctx.body(escalationIn);
  await service.generateSteps(ctx.db, await service.get(ctx.db, id), body, user);
  return (await service.allSteps(ctx.db, id)).map((s) => service.rentStepOut(s));
});

router.delete("/leases/{lease_id}/rent-steps/{step_id}", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const lease = await service.get(ctx.db, ctx.uuid("lease_id"));
  const step = await service._child(ctx.db, rentSteps, ctx.uuid("step_id"), "Rent step");
  if (step.lease_id !== lease.id) throw new HttpError(404, "Rent step not found");
  await service.removeChild(ctx.db, rentSteps, step, lease, user);
  return noContent();
});

// --------------------------------------------------------------------------- recoveries / options / clauses / guaranties

router.get("/leases/{lease_id}/options", async (ctx) => {
  await ctx.require("leases", "view");
  const lease = await service.get(ctx.db, ctx.uuid("lease_id"));
  const [vals, steps] = await service._operative(ctx.db, lease);
  const out = [];
  for (const o of await service.listChildren(ctx.db, leaseOptions, lease.id)) {
    out.push(service.optionOut(o, await service.optionEconomics(ctx.db, lease, o, vals, steps)));
  }
  return out;
});

function childRoutes(
  path: string, kind: service.ChildKind, schemaIn: typeof recoveryIn | typeof optionIn | typeof clauseIn | typeof guarantyIn,
  withList = true,
) {
  const label = kind.name;
  const patchSchema = unsetDefaults(schemaIn as never);
  const load = async (ctx: Ctx) => {
    const lease = await service.get(ctx.db, ctx.uuid("lease_id"));
    const row = await service._child(ctx.db, kind.table, ctx.uuid("child_id"), label);
    if (row.lease_id !== lease.id) throw new HttpError(404, `${label} not found`);
    return { lease, row };
  };

  if (withList) {
    router.get(`/leases/{lease_id}/${path}`, async (ctx) => {
      await ctx.require("leases", "view");
      const id = ctx.uuid("lease_id");
      await service.get(ctx.db, id);
      return (await service.listChildren(ctx.db, kind.table, id)).map((r) => (kind.out as (x: any) => unknown)(r));
    });
  }

  router.post(`/leases/{lease_id}/${path}`, async (ctx) => {
    const user = await ctx.require("leases", "edit");
    const id = ctx.uuid("lease_id");
    const body = await ctx.body(schemaIn);
    const row = await service.addChild(ctx.db, kind, await service.get(ctx.db, id), body as never, user);
    return created((kind.out as (x: any) => unknown)(row));
  });

  router.patch(`/leases/{lease_id}/${path}/{child_id}`, async (ctx) => {
    const user = await ctx.require("leases", "edit");
    const body = await ctx.body(patchSchema);
    const { lease, row } = await load(ctx);
    return (kind.out as (x: any) => unknown)(await service.updateChild(ctx.db, kind, row, lease, body, user));
  });

  router.post(`/leases/{lease_id}/${path}/{child_id}/verify`, async (ctx) => {
    const user = await ctx.require("leases", "edit");
    const body = await ctx.body(verifyIn);
    const { lease, row } = await load(ctx);
    return (kind.out as (x: any) => unknown)(await service.verifyChild(ctx.db, kind, row, lease, body.verified, user));
  });

  router.delete(`/leases/{lease_id}/${path}/{child_id}`, async (ctx) => {
    const user = await ctx.require("leases", "edit");
    const { lease, row } = await load(ctx);
    await service.removeChild(ctx.db, kind.table, row, lease, user, kind.label);
    return noContent();
  });
}

childRoutes("recoveries", service.CHILDREN.recoveries, recoveryIn);
childRoutes("options", service.CHILDREN.options, optionIn, false);
childRoutes("clauses", service.CHILDREN.clauses, clauseIn);
childRoutes("guaranties", service.CHILDREN.guaranties, guarantyIn);

// --------------------------------------------------------------------------- amendment chain

router.get("/leases/{lease_id}/amendments", async (ctx) => {
  await ctx.require("leases", "view");
  const id = ctx.uuid("lease_id");
  await service.get(ctx.db, id);
  return (await service.amendments(ctx.db, id)).map(service.amendmentOut);
});

router.post("/leases/{lease_id}/amendments", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const id = ctx.uuid("lease_id");
  const body = await ctx.body(amendmentIn);
  return created(service.amendmentOut(await service.addAmendment(ctx.db, await service.get(ctx.db, id), body, user)));
});

router.post("/leases/{lease_id}/amendments/{amendment_id}/verify", async (ctx) => {
  const user = await ctx.require("leases", "edit");
  const body = await ctx.body(verifyIn);
  const lease = await service.get(ctx.db, ctx.uuid("lease_id"));
  const a = await service._child(ctx.db, leaseAmendments, ctx.uuid("amendment_id"), "Amendment");
  if (a.lease_id !== lease.id) throw new HttpError(404, "Amendment not found");
  return service.amendmentOut(await service.verifyAmendment(ctx.db, a, lease, body.verified, user));
});
