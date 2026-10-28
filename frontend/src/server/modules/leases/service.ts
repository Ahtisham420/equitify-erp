import { randomUUID } from "node:crypto";

import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { provenanceIn } from "../../common/provenance";
import { applySearch, countWhere, inFilter } from "../../common/query";
import type { ListParams } from "../../core/router";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as getById, insert, insertMany, patch, raw } from "../../db/orm";
import { assets } from "../assets/schema";
import { users } from "../auth/schema";
import * as compsService from "../comps/service";
import * as contractsService from "../contracts/service";
import * as docService from "../documents/service";
import { spaces } from "../parcels/schema";
import { getProperty } from "../properties/service";
import { properties } from "../properties/schema";
import { charges } from "../receivables/schema";
import {
  guaranties, leaseAmendments, leaseClauses, leaseOptions, leaseRecoveries, leases, MATERIAL_FIELDS,
  OBLIGATION_CATEGORIES, OVERRIDABLE_FIELDS, recoveryReconciliations, rentSteps,
  type Guaranty, type Lease, type LeaseAmendment, type LeaseClause, type LeaseOption, type LeaseRecovery,
  type RecoveryReconciliation, type RentStep,
} from "./schema";
import type {
  AmendmentIn, ClauseIn, EscalationIn, GuarantyIn, LeaseCreate, LeaseUpdate, OperativeField, OptionEconomics,
  OptionIn, ReconRunIn, RecoveryIn, RentRoll, RentRollRow, RentStepIn, Rollover, RolloverYear,
} from "./schemas";
import {
  addDays, addMonths, asDate, diffDays, fmtG, maxDate, minDate, money, monthEnd, nested,
  num, pick, round, save, titleCase, today, yearOf, ymd,
} from "./util";

export { addMonths, monthEnd };

export const ENTITY = "lease";
const DATE_FIELDS = new Set(["commencement_on", "expiration_on", "rent_commencement_on", "execution_on"]);
const UUID_FIELDS = new Set(["space_id", "tenant_organization_id"]);
export const DEFAULT_RENEWAL_PROBABILITY = 0.65;
export const DEFAULT_DOWNTIME_MONTHS = 6;
const RECOVERY_CHARGE_TYPES = ["recovery", "cam", "tax", "insurance", "utilities", "fixed_cam"];
const SPACE_MATERIAL = new Set(["area_sf", "occupancy_status", "tenant_name"]);

type Rec = Record<string, any>;
/** (step, effective end date) */
export type OpStep = [RentStep, string];

const yearsBetween = (a: string, b: string): number => Math.max(0, diffDays(b, a) / 365.25);

// --------------------------------------------------------------------------- lookups

export async function get(db: Db, lease_id: string): Promise<Lease> {
  const lease = await getById(db, leases, lease_id);
  if (!lease || lease.deleted_at) throw new HttpError(404, "Lease not found");
  return lease;
}
export const getLease = get;

export async function _child(db: Db, table: any, child_id: string, label: string): Promise<any> {
  const row = await getById(db, table, child_id);
  if (!row || (row as Rec).deleted_at) throw new HttpError(404, `${label} not found`);
  return row;
}

async function checkSpace(db: Db, property_id: string, space_id: string | null | undefined): Promise<void> {
  if (!space_id) return;
  const s = await getById(db, spaces, space_id);
  if (!s || s.deleted_at || s.property_id !== property_id) {
    throw new HttpError(422, "Space does not belong to this property");
  }
}

const rentPsf = (annual: number | null | undefined, sf: number | null | undefined): number | null =>
  annual !== null && annual !== undefined && sf ? round(annual / sf, 4) : null;

// --------------------------------------------------------------------------- output mappers

const CITE = ["document_id", "page", "clause_ref", "quoted_text"] as const;
const VERIFY = ["verified", "verified_by_id", "verified_at"] as const;
const EXTRACT = ["ai_extracted", "confidence"] as const;

export const citationOut = (c: Rec | null | undefined) => pick(c ?? {}, CITE);
const normCitations = (c: Rec | null | undefined): Rec =>
  Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [k, citationOut(v)]));

const LEASE_KEYS = [
  "property_id", "space_id", "asset_id", "document_id", "tenant_organization_id", "tenant_name", "landlord_name",
  "premises_description", "status", "lease_type", "execution_on", "commencement_on", "rent_commencement_on",
  "expiration_on", "rentable_sf", "pro_rata_share", "base_rent_annual", "security_deposit", "late_fee_grace_days",
  "late_fee_pct", "late_fee_flat", "market_rent_psf", "renewal_probability", "downtime_months",
  "releasing_cost_psf", "manager_id", "notes", "tags", "id", "escalation", "verified", "ai_extracted", "confidence",
  "verified_by_id", "verified_at", "created_at", "updated_at",
] as const;

export const rentStepOut = (s: RentStep, end?: string) => ({
  ...pick(s, CITE),
  ...pick(s, ["id", "lease_id", "amendment_id", "start_on", "end_on", "annual_rent", "monthly_rent", "rent_psf",
    "charge_type", "source", "note"]),
  ...(end !== undefined ? { end_on: end } : {}),
});

const RECOVERY_KEYS = [
  ...CITE, "method", "category", "pro_rata_share", "base_year", "base_amount", "expense_stop_psf",
  "fixed_amount_annual", "estimated_monthly", "cap_type", "cap_pct", "cap_base_amount", "cap_base_year",
  "admin_fee_pct", "gross_up_pct", "exclusions", "notes", ...EXTRACT, "id", "lease_id", ...VERIFY,
] as const;
export const recoveryOut = (r: LeaseRecovery) => pick(r, RECOVERY_KEYS);

const OPTION_KEYS = [
  ...CITE, "option_type", "sequence", "term_months", "notice_start_on", "notice_end_on", "effective_on",
  "pricing_method", "pricing_params", "option_rent_psf", "increase_pct", "fmv_pct", "fee_amount", "purchase_price",
  "market_rent_psf", "space_description", "conditions", "status", "exercised_on", ...EXTRACT, "id", "lease_id",
  ...VERIFY,
] as const;
export const optionOut = (o: LeaseOption, economics: OptionEconomics | null = null) => ({
  ...pick(o, OPTION_KEYS),
  economics,
});

const CLAUSE_KEYS = [
  ...CITE, "category", "title", "summary", "terms", "obligated_party", "due_on", "recurrence", "response_days",
  "amendment_id", ...EXTRACT, "id", "lease_id", ...VERIFY, "updated_at",
] as const;
export const clauseOut = (c: LeaseClause) => pick(c, CLAUSE_KEYS);

const GUARANTY_KEYS = [
  ...CITE, "guarantor_name", "guarantor_organization_id", "guarantor_person_id", "guaranty_type", "cap_amount",
  "effective_on", "expires_on", "burn_down", "financials_required", "financials_due_on", "estoppel_days", "status",
  "notes", ...EXTRACT, "id", "lease_id", ...VERIFY,
] as const;
export const guarantyOut = (g: Guaranty) => pick(g, GUARANTY_KEYS);

const AMENDMENT_KEYS = [
  "id", "lease_id", "kind", "sequence", "title", "executed_on", "effective_on", "document_id", "page", "clause_ref",
  "overrides", "summary", "verified", "verified_by_id", "verified_at", "created_at",
] as const;
export const amendmentOut = (a: LeaseAmendment) => pick(a, AMENDMENT_KEYS);

const RECON_KEYS = [
  "id", "lease_id", "property_id", "year", "budgeted_pool", "actual_pool", "share_pct", "budgeted_share",
  "actual_share", "cap_reduction", "estimates_billed", "true_up_amount", "details", "status", "finalized_at",
  "billed_charge_id", "updated_at",
] as const;
export const reconciliationOut = (r: RecoveryReconciliation, tenant_name: string | null = null) => ({
  ...pick(r, RECON_KEYS),
  tenant_name,
});

/** `kind` -> table + audit label for the generic child-record endpoints. */
export const CHILDREN = {
  recoveries: { table: leaseRecoveries, label: "recovery", name: "Recovery", out: recoveryOut },
  options: { table: leaseOptions, label: "option", name: "Option", out: optionOut },
  clauses: { table: leaseClauses, label: "clause", name: "Clause", out: clauseOut },
  guaranties: { table: guaranties, label: "guaranty", name: "Guaranty", out: guarantyOut },
} as const;
export type ChildKind = (typeof CHILDREN)[keyof typeof CHILDREN];
type ChildTable = typeof leaseRecoveries | typeof leaseOptions | typeof leaseClauses | typeof guaranties;

// --------------------------------------------------------------------------- list

export interface LeaseFilters {
  q?: string;
  status?: string[];
  lease_type?: string[];
  verified?: string[];
  property_id?: string;
  asset_id?: string;
  tenant_organization_id?: string;
  expiring_within?: number;
  expires_from?: string;
  expires_to?: string;
  min_sf?: number;
  max_sf?: number;
}

/** Correlated subquery: the annual rent of the step in force today (amendment steps win ties). */
export function currentRentExpr(on: string = today()): SQL<number | null> {
  return sql<number | null>`(select rs.annual_rent from rent_steps rs where rs.lease_id = ${leases.id}
    and rs.deleted_at is null and rs.start_on <= ${on} and rs.end_on >= ${on}
    order by (rs.amendment_id is null), rs.start_on desc limit 1)`;
}

export function buildWhere(f: LeaseFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = leases;
  const now = today();
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.tenant_name, t.landlord_name, t.premises_description]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("lease_type") ? undefined : inFilter(t.lease_type, f.lease_type),
    !skip.has("verified") && f.verified?.length
      ? inArray(t.verified, f.verified.map((v) => ["true", "1", "yes"].includes(v.toLowerCase())))
      : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.asset_id ? eq(t.asset_id, f.asset_id) : undefined,
    f.tenant_organization_id ? eq(t.tenant_organization_id, f.tenant_organization_id) : undefined,
    !skip.has("expiring") && f.expiring_within
      ? and(gte(t.expiration_on, now), lte(t.expiration_on, addDays(now, f.expiring_within)))
      : undefined,
    f.expires_from ? gte(t.expiration_on, f.expires_from) : undefined,
    f.expires_to ? lte(t.expiration_on, f.expires_to) : undefined,
    f.min_sf !== undefined ? gte(t.rentable_sf, f.min_sf) : undefined,
    f.max_sf !== undefined ? lte(t.rentable_sf, f.max_sf) : undefined,
  );
}

export const SORTS = {
  tenant_name: leases.tenant_name, status: leases.status, lease_type: leases.lease_type,
  commencement_on: leases.commencement_on, expiration_on: leases.expiration_on, rentable_sf: leases.rentable_sf,
  updated_at: leases.updated_at, created_at: leases.created_at,
};

export async function listRows(db: Db, f: LeaseFilters, order: SQL[], p: ListParams) {
  const where = buildWhere(f);
  const total = await countWhere(db, leases, where);
  const rows = await db
    .select({
      lease: leases,
      current_rent: sql<number | null>`coalesce(${currentRentExpr()}, ${leases.base_rent_annual})`,
      property_name: sql<string | null>`coalesce(${properties.name}, ${properties.address_line})`,
      suite: spaces.suite,
    })
    .from(leases)
    .innerJoin(properties, eq(properties.id, leases.property_id))
    .leftJoin(spaces, eq(spaces.id, leases.space_id))
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return { rows, total };
}

export function listItems(rows: Awaited<ReturnType<typeof listRows>>["rows"]) {
  return rows.map(({ lease, current_rent, property_name, suite }) => {
    const rent = current_rent === null || current_rent === undefined ? null : Number(current_rent);
    return {
      ...pick(lease, ["id", "property_id"]),
      property_name,
      space_id: lease.space_id,
      suite,
      ...pick(lease, ["tenant_name", "status", "lease_type", "commencement_on", "expiration_on", "rentable_sf"]),
      current_annual_rent: rent,
      rent_psf: rentPsf(rent, lease.rentable_sf),
      ...pick(lease, ["verified", "ai_extracted", "updated_at"]),
    };
  });
}

export async function expiringCounts(db: Db, f: LeaseFilters): Promise<Record<string, number>> {
  const now = today();
  const out: Record<string, number> = {};
  const base = buildWhere(f, new Set(["expiring"]));
  for (const days of [90, 180, 365, 730]) {
    out[String(days)] = await countWhere(
      db, leases, and(base, gte(leases.expiration_on, now), lte(leases.expiration_on, addDays(now, days))),
    );
  }
  return out;
}

// --------------------------------------------------------------------------- detail

async function unverifiedCount(db: Db, lease_id: string): Promise<number> {
  let total = 0;
  for (const t of [leaseRecoveries, leaseOptions, leaseClauses, guaranties, leaseAmendments]) {
    total += await countWhere(db, t, and(eq(t.lease_id, lease_id), isNull(t.deleted_at), eq(t.verified, false)));
  }
  return total;
}

export async function toOut(db: Db, lease: Lease) {
  const prop = await getById(db, properties, lease.property_id);
  let suite: string | null = null;
  if (lease.space_id) {
    const s = await getById(db, spaces, lease.space_id);
    suite = s ? s.suite : null;
  }
  let manager_name: string | null = null;
  if (lease.manager_id) {
    const u = await getById(db, users, lease.manager_id);
    manager_name = u ? u.full_name : null;
  }
  const [vals, steps] = await _operative(db, lease);
  return {
    ...pick(lease, LEASE_KEYS),
    citations: normCitations(lease.citations),
    property_name: prop ? prop.name || prop.address_line : null,
    suite,
    manager_name,
    current_annual_rent: rentAt(steps, today(), vals.base_rent_annual),
    unverified_items: await unverifiedCount(db, lease.id),
    provenance: await provenance.currentObservations(db, ENTITY, lease.id),
  };
}

// --------------------------------------------------------------------------- side effects

async function linkDocument(db: Db, document_id: string | null | undefined, entity_id: string, actor: CurrentUser) {
  if (!document_id) return;
  await nested(db, async () => {
    await docService.link(db, document_id, "lease", entity_id, actor);
  }, true);
}

/** Verified, active leases mark their space occupied; ended leases release it. Space facts keep provenance. */
async function syncSpace(db: Db, lease: Lease, actor: CurrentUser): Promise<void> {
  if (!lease.space_id || !lease.verified) return;
  const s = await getById(db, spaces, lease.space_id);
  if (!s || s.deleted_at) return;
  let data: Rec;
  if (lease.status === "active") {
    data = {
      occupancy_status: "occupied", tenant_name: lease.tenant_name,
      tenant_organization_id: lease.tenant_organization_id, lease_id: lease.id,
    };
  } else if ((lease.status === "expired" || lease.status === "terminated") && s.lease_id === lease.id) {
    data = { occupancy_status: "vacant", tenant_name: null, tenant_organization_id: null, lease_id: null };
  } else {
    return;
  }
  const prov = provenanceIn.parse({ source: `Lease: ${lease.tenant_name}`, confidence: 1.0, verified: true });
  const changes = await provenance.applyMaterial(db, s, {
    entity_type: "space", data, material_fields: SPACE_MATERIAL, prov, actor_id: actor.id,
  });
  if (Object.keys(changes).length) {
    await patch(db, spaces, s, { ...pick(s, Object.keys(changes)), updated_by_id: actor.id } as never);
    await audit.record(db, {
      actor, action: "property.space_lease_synced", entity_type: "property", entity_id: s.property_id,
      summary: `Suite ${s.suite}`, changes, ip_address: actor.ip_address,
    });
  }
}

// --------------------------------------------------------------------------- lease CRUD

export async function create(db: Db, data: LeaseCreate, actor: CurrentUser): Promise<Lease> {
  await getProperty(db, data.property_id);
  await checkSpace(db, data.property_id, data.space_id);
  const { provenance: prov, ...values } = data;
  const humanVerified = prov.verified && !prov.ai_derived;
  const lease = await insert(db, leases, {
    ...values,
    citations: audit.toJsonable(normCitations(values.citations)),
    escalation: {},
    verified: humanVerified,
    ai_extracted: prov.ai_derived,
    confidence: prov.confidence,
    verified_by_id: humanVerified ? actor.id : null,
    verified_at: humanVerified ? utcnow() : null,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  } as never);
  for (const field of MATERIAL_FIELDS) {
    const value = (lease as Rec)[field];
    if (value !== null && value !== undefined) {
      await provenance.observe(db, { entity_type: ENTITY, entity_id: lease.id, field, value, prov, actor_id: actor.id });
    }
  }
  await linkDocument(db, lease.document_id, lease.id, actor);
  await audit.record(db, {
    actor, action: "lease.created", entity_type: ENTITY, entity_id: lease.id, summary: lease.tenant_name,
    ip_address: actor.ip_address,
  });
  await events.emit(db, "lease.created", { lease_id: lease.id, property_id: lease.property_id, actor });
  if (lease.verified) {
    await generateCriticalDates(db, lease, actor);
    await syncSpace(db, lease, actor);
  }
  await db.commit();
  return lease;
}

export async function update(db: Db, lease: Lease, data: LeaseUpdate, actor: CurrentUser): Promise<Lease> {
  const { provenance: prov, ...rest } = data;
  const values: Rec = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if ("citations" in values) values.citations = audit.toJsonable(normCitations(values.citations ?? {}));
  if ("space_id" in values) await checkSpace(db, lease.property_id, values.space_id);
  // `lease` is mutated in memory by applyMaterial; persisted below with one UPDATE.
  const changes: Rec = await provenance.applyMaterial(db, lease, {
    entity_type: ENTITY, data: values, material_fields: MATERIAL_FIELDS, prov, actor_id: actor.id,
  });
  if (!Object.keys(changes).length) return lease;
  const material = Object.keys(changes).filter((k) => MATERIAL_FIELDS.has(k));
  if (material.length && lease.verified && (prov.ai_derived || !prov.verified)) {
    // A material term changed without human verification: the abstract needs re-verification.
    lease.verified = false;
    lease.verified_by_id = null;
    lease.verified_at = null;
    changes.verified = { from: true, to: false };
  }
  if (prov.ai_derived && material.length) lease.ai_extracted = true;
  lease.updated_by_id = actor.id;
  await save(db, leases, lease);
  if ("document_id" in changes) await linkDocument(db, lease.document_id, lease.id, actor);
  await audit.record(db, {
    actor, action: "lease.updated", entity_type: ENTITY, entity_id: lease.id, changes, summary: lease.tenant_name,
    ip_address: actor.ip_address,
  });
  await events.emit(db, "lease.updated", {
    lease_id: lease.id, property_id: lease.property_id, changed: new Set(Object.keys(changes)), actor,
  });
  if (lease.verified) {
    await generateCriticalDates(db, lease, actor);
    if (["status", "space_id", "tenant_name", "tenant_organization_id"].some((k) => k in changes)) {
      await syncSpace(db, lease, actor);
    }
  }
  await db.commit();
  return lease;
}

export async function verify(db: Db, lease: Lease, verified: boolean, actor: CurrentUser): Promise<Lease> {
  if (lease.verified === verified) return lease;
  await patch(db, leases, lease, {
    verified,
    verified_by_id: verified ? actor.id : null,
    verified_at: verified ? utcnow() : null,
    updated_by_id: actor.id,
  });
  if (verified) {
    for (const obs of Object.values(await provenance.currentObservations(db, ENTITY, lease.id))) {
      if (obs.verification === "unverified") await provenance.setVerification(db, obs.id, "verified", actor.id);
    }
  }
  await audit.record(db, {
    actor, action: verified ? "lease.verified" : "lease.unverified", entity_type: ENTITY, entity_id: lease.id,
    summary: lease.tenant_name, ip_address: actor.ip_address,
  });
  if (verified) {
    await events.emit(db, "lease.verified", { lease_id: lease.id, property_id: lease.property_id, actor });
    await generateCriticalDates(db, lease, actor);
    await syncSpace(db, lease, actor);
  }
  await db.commit();
  return lease;
}

export async function archive(db: Db, lease: Lease, actor: CurrentUser): Promise<void> {
  await patch(db, leases, lease, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "lease.archived", entity_type: ENTITY, entity_id: lease.id, summary: lease.tenant_name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- generic child records

export async function listChildren(db: Db, table: ChildTable, lease_id: string): Promise<any[]> {
  const t = table as any;
  const order =
    table === leaseRecoveries ? [leaseRecoveries.category]
    : table === leaseOptions ? [leaseOptions.option_type, leaseOptions.sequence]
    : table === leaseClauses ? [leaseClauses.category, leaseClauses.created_at]
    : [guaranties.created_at];
  return db
    .select()
    .from(t)
    .where(and(eq(t.lease_id, lease_id), isNull(t.deleted_at)))
    .orderBy(...order.map((c) => asc(c as any)));
}

export async function addChild(
  db: Db, kind: ChildKind, lease: Lease, data: RecoveryIn | OptionIn | ClauseIn | GuarantyIn, actor: CurrentUser,
) {
  const { table, label } = kind;
  // Every abstracted term starts unverified; a named human verifies it explicitly.
  const row: Rec = await insert(db, table, {
    ...data, lease_id: lease.id, verified: false, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await linkDocument(db, row.document_id, lease.id, actor);
  await audit.record(db, {
    actor, action: `lease.${label}_added`, entity_type: ENTITY, entity_id: lease.id,
    summary: row.title || row.option_type || label, changes: { [`${label}_id`]: row.id },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return row;
}

export async function updateChild(db: Db, kind: ChildKind, row: Rec, lease: Lease, data: Rec, actor: CurrentUser) {
  const { table, label } = kind;
  const values: Rec = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const changes: Rec = audit.diff(row, values);
  if (!Object.keys(changes).length) return row;
  Object.assign(row, values);
  // Any change to a verified term sends it back for human verification; prior values stay in history.
  for (const field of [
    "summary", "terms", "quoted_text", "option_rent_psf", "notice_end_on", "cap_pct", "method", "base_amount",
    "fixed_amount_annual", "cap_amount", "expires_on", "due_on",
  ]) {
    if (field in changes && field in row) {
      await provenance.observe(db, {
        entity_type: `lease_${label}`, entity_id: row.id, field, value: row[field],
        prov: provenanceIn.parse({
          source: row.ai_extracted ? "AI extraction" : "Manual edit", confidence: row.confidence || 0.8,
          ai_derived: Boolean(row.ai_extracted),
        }),
        actor_id: actor.id,
      });
    }
  }
  if (row.verified) {
    row.verified = false;
    row.verified_by_id = null;
    row.verified_at = null;
    changes.verified = { from: true, to: false };
  }
  row.updated_by_id = actor.id;
  await save(db, table, row as never);
  await audit.record(db, {
    actor, action: `lease.${label}_updated`, entity_type: ENTITY, entity_id: lease.id,
    changes: { [`${label}_id`]: row.id, ...changes }, ip_address: actor.ip_address,
  });
  await db.commit();
  return row;
}

export async function verifyChild(db: Db, kind: ChildKind, row: Rec, lease: Lease, verified: boolean, actor: CurrentUser) {
  const { table, label } = kind;
  await patch(db, table as any, row as never, {
    verified, verified_by_id: verified ? actor.id : null, verified_at: verified ? utcnow() : null,
    updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: `lease.${label}_${verified ? "verified" : "unverified"}`, entity_type: ENTITY, entity_id: lease.id,
    changes: { [`${label}_id`]: row.id }, ip_address: actor.ip_address,
  });
  if (lease.verified) await generateCriticalDates(db, lease, actor);
  await db.commit();
  return row;
}

/** Soft-removes a child record. `label` defaults to "rent_step" (the only child not in CHILDREN). */
export async function removeChild(
  db: Db, table: typeof rentSteps | ChildTable, row: Rec, lease: Lease, actor: CurrentUser, label = "rent_step",
): Promise<void> {
  await patch(db, table as any, row as never, { deleted_at: utcnow(), updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: `lease.${label}_removed`, entity_type: ENTITY, entity_id: lease.id,
    changes: { [`${label}_id`]: row.id }, ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- rent steps & escalations

export async function allSteps(db: Db, lease_id: string): Promise<RentStep[]> {
  return db
    .select()
    .from(rentSteps)
    .where(and(eq(rentSteps.lease_id, lease_id), isNull(rentSteps.deleted_at)))
    .orderBy(asc(rentSteps.start_on), asc(rentSteps.created_at));
}

function newStep(
  lease: Lease,
  o: {
    start_on: string; end_on: string; annual: number; sf: number | null | undefined; source: string; actor: CurrentUser;
    rent_psf?: number | null; amendment_id?: string | null; note?: string | null; charge_type?: string;
    citation?: Rec;
  },
): Rec {
  if (o.end_on < o.start_on) throw new HttpError(422, "Rent step ends before it starts");
  const annual = round(o.annual, 2);
  return {
    lease_id: lease.id, amendment_id: o.amendment_id ?? null, start_on: o.start_on, end_on: o.end_on,
    annual_rent: annual, monthly_rent: round(annual / 12, 2),
    rent_psf: o.rent_psf !== null && o.rent_psf !== undefined ? o.rent_psf : rentPsf(annual, o.sf),
    charge_type: o.charge_type ?? "base_rent", source: o.source, note: o.note ?? null,
    created_by_id: o.actor.id, updated_by_id: o.actor.id,
    ...(o.citation ?? {}),
  };
}

export async function addStep(db: Db, lease: Lease, data: RentStepIn, actor: CurrentUser) {
  if (data.amendment_id) {
    const a = await _child(db, leaseAmendments, data.amendment_id, "Amendment");
    if (a.lease_id !== lease.id) throw new HttpError(422, "Amendment belongs to another lease");
  }
  const step = await insert(db, rentSteps, newStep(lease, {
    start_on: data.start_on, end_on: data.end_on, annual: data.annual_rent, sf: lease.rentable_sf,
    rent_psf: data.rent_psf, source: data.amendment_id ? "amendment" : "manual", amendment_id: data.amendment_id,
    note: data.note, charge_type: data.charge_type, actor, citation: pick(data, CITE),
  }) as never);
  await audit.record(db, {
    actor, action: "lease.rent_step_added", entity_type: ENTITY, entity_id: lease.id,
    changes: { start_on: step.start_on, end_on: step.end_on, annual_rent: step.annual_rent },
    ip_address: actor.ip_address,
  });
  if (lease.verified) await generateCriticalDates(db, lease, actor);
  await db.commit();
  return step;
}

type Period = [string, string, number, string | null];

/** Pure escalation engine: returns (start, end, annual_rent, note) periods. */
export function buildSteps(
  esc: EscalationIn,
  o: { start: string; end: string; sf: number | null; fallback_base: number | null },
): Period[] {
  const { start, end, sf } = o;
  if (end < start) throw new HttpError(422, "End date is before start date");
  if (esc.method === "step_table") {
    if (!esc.steps.length) throw new HttpError(422, "Step table needs at least one row");
    const rows = [...esc.steps].sort((a, b) => (a.start_on < b.start_on ? -1 : a.start_on > b.start_on ? 1 : 0));
    const out: Period[] = [];
    rows.forEach((r, i) => {
      const e = r.end_on || (i + 1 < rows.length ? addDays(rows[i + 1].start_on, -1) : end);
      let annual: number;
      if (r.annual_rent !== null && r.annual_rent !== undefined) annual = r.annual_rent;
      else if (r.rent_psf !== null && r.rent_psf !== undefined && sf) annual = r.rent_psf * sf;
      else throw new HttpError(422, "Each step needs annual rent or rent PSF (with SF)");
      out.push([r.start_on, e, annual, null]);
    });
    return out;
  }

  let base: number | null | undefined = esc.base_annual_rent;
  if ((base === null || base === undefined) && esc.base_rent_psf !== null && esc.base_rent_psf !== undefined && sf) {
    base = esc.base_rent_psf * sf;
  }
  if (base === null || base === undefined) base = o.fallback_base;
  if (base === null || base === undefined) throw new HttpError(422, "Provide a base annual rent or rent PSF");

  const escalate = (rent: number): [number, string | null] => {
    if (esc.method === "fixed_pct") return [rent * (1 + (esc.pct || 0) / 100), null];
    if (esc.method === "fixed_amount") return [rent + (esc.amount || 0), null];
    if (esc.method === "cpi") {
      let rate = esc.cpi_assumed_pct !== null && esc.cpi_assumed_pct !== undefined ? esc.cpi_assumed_pct : 0.0;
      if (esc.cpi_floor_pct !== null && esc.cpi_floor_pct !== undefined) rate = Math.max(rate, esc.cpi_floor_pct);
      if (esc.cpi_cap_pct !== null && esc.cpi_cap_pct !== undefined) rate = Math.min(rate, esc.cpi_cap_pct);
      return [rent * (1 + rate / 100), `CPI ${fmtG(rate)}% (assumed; floor/cap applied)`];
    }
    return [rent, null];
  };

  let periods: Period[] = [];
  let rent: number = base;
  let note: string | null = null;
  let s = start;
  while (s <= end && periods.length < 600) {
    const e = minDate(addDays(addMonths(s, esc.frequency_months), -1), end);
    periods.push([s, e, rent, note]);
    s = addDays(e, 1);
    [rent, note] = escalate(rent);
  }

  if (esc.free_rent_months) {
    const freeEnd = addDays(addMonths(start, esc.free_rent_months), -1);
    const split: Period[] = [];
    for (const [ps, pe, r, n] of periods) {
      if (pe <= freeEnd) split.push([ps, pe, 0.0, "Free rent"]);
      else if (ps <= freeEnd) {
        split.push([ps, freeEnd, 0.0, "Free rent"]);
        split.push([addDays(freeEnd, 1), pe, r, n]);
      } else split.push([ps, pe, r, n]);
    }
    periods = split;
  }
  return periods;
}

/** `esc.model_dump(mode="json", exclude={"replace"})` */
function escalationDump(esc: EscalationIn): Rec {
  const { replace: _replace, steps, ...rest } = esc;
  const full = Object.fromEntries(
    ["base_annual_rent", "base_rent_psf", "start_on", "end_on", "pct", "amount", "cpi_assumed_pct", "cpi_floor_pct",
      "cpi_cap_pct"].map((k) => [k, (rest as Rec)[k] ?? null]),
  );
  return {
    method: rest.method,
    ...full,
    frequency_months: rest.frequency_months,
    free_rent_months: rest.free_rent_months,
    steps: steps.map((r) => pick(r, ["start_on", "end_on", "annual_rent", "rent_psf"])),
  };
}

export async function generateSteps(db: Db, lease: Lease, esc: EscalationIn, actor: CurrentUser): Promise<RentStep[]> {
  const [vals] = await _operative(db, lease);
  const start = esc.start_on || asDate(vals.rent_commencement_on) || asDate(vals.commencement_on);
  const end = esc.end_on || asDate(vals.expiration_on);
  if (!start || !end) throw new HttpError(422, "Lease needs commencement and expiration dates");
  const sf = num(vals.rentable_sf);
  const periods = buildSteps(esc, { start, end, sf, fallback_base: num(vals.base_rent_annual) });
  let removed = 0;
  if (esc.replace) {
    for (const s of await allSteps(db, lease.id)) {
      if (s.amendment_id === null) {
        await patch(db, rentSteps, s, { deleted_at: utcnow(), updated_by_id: actor.id });
        removed += 1;
      }
    }
  }
  const created = await insertMany(
    db, rentSteps,
    periods.map(([s, e, annual, note]) =>
      newStep(lease, { start_on: s, end_on: e, annual, sf, source: "generated", note, actor }) as never),
  );
  const old = lease.escalation;
  await patch(db, leases, lease, { escalation: escalationDump(esc), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "lease.rent_schedule_generated", entity_type: ENTITY, entity_id: lease.id,
    summary: `${created.length} steps (${esc.method})`,
    changes: { escalation: { from: old, to: lease.escalation }, replaced_steps: removed },
    ip_address: actor.ip_address,
  });
  if (lease.verified) await generateCriticalDates(db, lease, actor);
  await db.commit();
  return created;
}

// --------------------------------------------------------------------------- amendment chain / operative terms

export async function amendments(db: Db, lease_id: string): Promise<LeaseAmendment[]> {
  return db
    .select()
    .from(leaseAmendments)
    .where(and(eq(leaseAmendments.lease_id, lease_id), isNull(leaseAmendments.deleted_at)))
    .orderBy(asc(leaseAmendments.effective_on), asc(leaseAmendments.sequence));
}

function coerceOverride(field: string, value: any): any {
  if (DATE_FIELDS.has(field)) return asDate(value);
  if (UUID_FIELDS.has(field) && value) return String(value).toLowerCase();
  return value;
}

/** Original steps, then each amendment's steps replace everything from its effective date onward. */
function operativeSteps(steps: RentStep[], chain: LeaseAmendment[]): OpStep[] {
  let current: OpStep[] = steps.filter((s) => s.amendment_id === null).map((s) => [s, s.end_on]);
  for (const a of chain) {
    const aSteps = steps.filter((s) => s.amendment_id === a.id);
    if (!aSteps.length) continue;
    const cut = minDate(a.effective_on, ...aSteps.map((s) => s.start_on));
    const kept: OpStep[] = [];
    for (const [s, end] of current) {
      if (s.start_on >= cut) continue;
      kept.push([s, minDate(end, addDays(cut, -1))]);
    }
    current = [...kept, ...aSteps.map((s): OpStep => [s, s.end_on])];
  }
  return current.sort((a, b) => (a[0].start_on < b[0].start_on ? -1 : a[0].start_on > b[0].start_on ? 1 : 0));
}

export async function _operative(
  db: Db, lease: Lease, as_of: string | null = null, verified_only = false,
): Promise<[Rec, OpStep[]]> {
  const asOf = as_of || today();
  const vals: Rec = {};
  for (const f of [...OVERRIDABLE_FIELDS, "rent_commencement_on"]) vals[f] = (lease as Rec)[f];
  const chain = (await amendments(db, lease.id)).filter((a) => a.verified || !verified_only);
  for (const a of chain) {
    if (a.effective_on > asOf) continue;
    for (const [k, v] of Object.entries(a.overrides ?? {})) {
      if (OVERRIDABLE_FIELDS.has(k)) vals[k] = coerceOverride(k, v);
    }
  }
  const steps = operativeSteps(await allSteps(db, lease.id), chain);
  return [vals, steps];
}

export function rentAt(steps: OpStep[], on: string, fallback: any = null): number | null {
  const base = steps.filter(([s]) => s.charge_type === "base_rent");
  for (const [s, end] of base) {
    if (s.start_on <= on && on <= end) return Number(s.annual_rent);
  }
  // No schedule yet -> the abstracted base rent; a schedule that does not cover the date -> no rent.
  return base.length ? null : num(fallback);
}

export async function operativeTerms(db: Db, lease: Lease, as_of: string | null = null) {
  const asOf = as_of || today();
  const chain = await amendments(db, lease.id);
  const fields: Record<string, OperativeField> = {};
  for (const f of [...OVERRIDABLE_FIELDS].sort()) {
    fields[f] = {
      original: (lease as Rec)[f], operative: (lease as Rec)[f], changed: false, amendment_id: null,
      amendment_title: null, effective_on: null, verified: true,
    };
  }
  const applied: string[] = [];
  const pending: string[] = [];
  for (const a of chain) {
    if (a.effective_on > asOf) {
      pending.push(a.id);
      continue;
    }
    applied.push(a.id);
    for (const [k, v] of Object.entries(a.overrides ?? {})) {
      if (!OVERRIDABLE_FIELDS.has(k)) continue;
      const val = coerceOverride(k, v);
      fields[k] = {
        original: fields[k].original, operative: val, changed: !audit.isEqual(val, fields[k].original),
        amendment_id: a.id, amendment_title: a.title, effective_on: a.effective_on, verified: a.verified,
      };
    }
  }
  const steps = operativeSteps(await allSteps(db, lease.id), chain);
  return {
    as_of: asOf, fields, rent_steps: steps.map(([s, e]) => rentStepOut(s, e)), amendments_applied: applied,
    pending_amendments: pending,
  };
}

export async function addAmendment(db: Db, lease: Lease, data: AmendmentIn, actor: CurrentUser) {
  const bad = Object.keys(data.overrides).filter((k) => !OVERRIDABLE_FIELDS.has(k));
  if (bad.length) throw new HttpError(422, `Fields cannot be amended: ${bad.sort().join(", ")}`);
  if ("space_id" in data.overrides && data.overrides.space_id) {
    await checkSpace(db, lease.property_id, String(data.overrides.space_id).toLowerCase());
  }
  const seq = (await countWhere(db, leaseAmendments, eq(leaseAmendments.lease_id, lease.id))) + 1;
  const { rent_steps, overrides, ...fields } = data;
  const a = await insert(db, leaseAmendments, {
    ...fields, overrides: audit.toJsonable(overrides), lease_id: lease.id, sequence: seq, verified: false,
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  for (const st of rent_steps) {
    await insert(db, rentSteps, newStep(lease, {
      start_on: st.start_on, end_on: st.end_on, annual: st.annual_rent, sf: lease.rentable_sf, rent_psf: st.rent_psf,
      source: "amendment", amendment_id: a.id, note: st.note, actor,
      citation: {
        document_id: st.document_id || a.document_id, page: st.page || a.page,
        clause_ref: st.clause_ref || a.clause_ref, quoted_text: st.quoted_text ?? null,
      },
    }) as never);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (MATERIAL_FIELDS.has(k)) {
      await provenance.observe(db, {
        entity_type: ENTITY, entity_id: lease.id, field: `amended.${k}`, value: v,
        prov: provenanceIn.parse({
          source: `${titleCase(a.kind.replace(/_/g, " "))}: ${a.title}`, observed_on: a.effective_on, confidence: 0.9,
        }),
        actor_id: actor.id,
      });
    }
  }
  await linkDocument(db, a.document_id, lease.id, actor);
  await audit.record(db, {
    actor, action: "lease.amendment_added", entity_type: ENTITY, entity_id: lease.id, summary: `${a.kind}: ${a.title}`,
    changes: { amendment_id: a.id, overrides: a.overrides, rent_steps: rent_steps.length }, ip_address: actor.ip_address,
  });
  await events.emit(db, "lease.updated", {
    lease_id: lease.id, property_id: lease.property_id,
    changed: new Set(Object.keys(overrides).map((k) => `amendment.${k}`)), actor,
  });
  await db.commit();
  return a;
}

export async function verifyAmendment(db: Db, a: LeaseAmendment, lease: Lease, verified: boolean, actor: CurrentUser) {
  await patch(db, leaseAmendments, a, {
    verified, verified_by_id: verified ? actor.id : null, verified_at: verified ? utcnow() : null,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `lease.amendment_${verified ? "verified" : "unverified"}`, entity_type: ENTITY, entity_id: lease.id,
    summary: a.title, changes: { amendment_id: a.id }, ip_address: actor.ip_address,
  });
  if (lease.verified) {
    await generateCriticalDates(db, lease, actor);
    await syncSpace(db, lease, actor);
  }
  await db.commit();
  return a;
}

// --------------------------------------------------------------------------- public schedule (receivables)

function* iterMonths(start: string, end: string): Generator<[string, string]> {
  let cur = `${start.slice(0, 7)}-01`;
  while (cur <= end) {
    yield [cur, monthEnd(cur)];
    cur = addMonths(cur, 1);
  }
}

function prorated(monthly: number, m_start: string, m_end: string, p_start: string, p_end: string): number {
  const daysInMonth = diffDays(m_end, m_start) + 1;
  const days = diffDays(p_end, p_start) + 1;
  return days === daysInMonth ? monthly : (monthly * days) / daysInMonth;
}

export interface ScheduleRow {
  period_start: string;
  period_end: string;
  amount: number;
  charge_type: string;
  lease_id: string;
  source_ref: Rec;
}

/** Monthly expected charges for a lease from its operative rent steps and recovery estimates.
 *  With verified_only, only verified amendments and recoveries are used (what receivables bills from). */
export async function rentSchedule(db: Db, lease_id: string, verified_only = false): Promise<ScheduleRow[]> {
  const lease = await getById(db, leases, lease_id);
  if (!lease || lease.deleted_at) return [];
  const [vals, steps] = await _operative(db, lease, null, verified_only);
  const expiration = asDate(vals.expiration_on);
  const rows: ScheduleRow[] = [];
  for (const [s, endRaw] of steps) {
    const end = expiration ? minDate(endRaw, expiration) : endRaw;
    for (const [m_start, m_end] of iterMonths(s.start_on, end)) {
      const p_start = maxDate(m_start, s.start_on);
      const p_end = minDate(m_end, end);
      const amount = round(prorated(Number(s.monthly_rent), m_start, m_end, p_start, p_end), 2);
      if (amount === 0) continue;
      rows.push({
        period_start: p_start, period_end: p_end, amount, charge_type: s.charge_type, lease_id: lease.id,
        source_ref: { rent_step_id: String(s.id), amendment_id: s.amendment_id ? String(s.amendment_id) : null },
      });
    }
  }
  const start = asDate(vals.rent_commencement_on) || asDate(vals.commencement_on);
  if (start && expiration) {
    const recs = await db
      .select()
      .from(leaseRecoveries)
      .where(and(
        eq(leaseRecoveries.lease_id, lease.id), isNull(leaseRecoveries.deleted_at),
        verified_only ? eq(leaseRecoveries.verified, true) : undefined,
      ));
    for (const r of recs) {
      let monthly: number;
      let ctype: string;
      if (r.method === "fixed_cam" && r.fixed_amount_annual) {
        monthly = Number(r.fixed_amount_annual) / 12;
        ctype = "fixed_cam";
      } else if (r.estimated_monthly) {
        monthly = Number(r.estimated_monthly);
        ctype = r.category === "all" ? "recovery" : r.category;
      } else continue;
      for (const [m_start, m_end] of iterMonths(start, expiration)) {
        const p_start = maxDate(m_start, start);
        const p_end = minDate(m_end, expiration);
        rows.push({
          period_start: p_start, period_end: p_end, amount: round(prorated(monthly, m_start, m_end, p_start, p_end), 2),
          charge_type: ctype, lease_id: lease.id, source_ref: { recovery_id: String(r.id), method: r.method },
        });
      }
    }
  }
  rows.sort((a, b) =>
    a.period_start !== b.period_start ? (a.period_start < b.period_start ? -1 : 1)
      : a.charge_type < b.charge_type ? -1 : a.charge_type > b.charge_type ? 1 : 0);
  return rows;
}

// --------------------------------------------------------------------------- critical dates (verified terms only)

/** Upserts critical dates from VERIFIED terms only. Returns [generated, skipped_unverified, engine_available].
 *  Does not commit. */
export async function generateCriticalDates(db: Db, lease: Lease, actor: CurrentUser): Promise<[number, number, boolean]> {
  if (!lease.verified) return [0, 1, true];
  const [vals, steps] = await _operative(db, lease, null, true);
  const tenant = vals.tenant_name || lease.tenant_name;
  const now = today();
  let generated = 0;
  let skipped = 0;

  const put = async (
    date_type: string, label: string, due_on: string | null | undefined, key: string, lead_days = 14,
    blocking = false, cite: Rec | null = null,
  ) => {
    if (!due_on) return;
    let citation: Rec | null = null;
    if (cite && (cite.document_id || cite.page || cite.clause_ref)) {
      citation = pick(cite, CITE);
    }
    await contractsService.upsertCriticalDate(db, {
      related_type: "lease", related_id: lease.id, date_type, label: label.slice(0, 200), due_on,
      property_id: lease.property_id, owner_id: lease.manager_id, lead_days, is_blocking: blocking, source: "rule",
      status: "confirmed", key, actor, related_label: tenant, citation,
    });
    generated += 1;
  };

  await put("lease_expiration", `${tenant} lease expiration`, asDate(vals.expiration_on), "expiration", 180);
  let prev: number | null = null;
  for (const [s] of steps) {
    if (s.charge_type !== "base_rent") continue;
    if (prev !== null && s.start_on >= now && Number(s.annual_rent) !== prev) {
      await put("rent_escalation", `${tenant} rent step to $${money(Number(s.annual_rent), 0)}/yr`, s.start_on,
        `escalation:${s.start_on}`, 30);
    }
    prev = Number(s.annual_rent);
  }

  for (const o of (await listChildren(db, leaseOptions, lease.id)) as LeaseOption[]) {
    if (o.status !== "open") continue;
    if (!o.verified) {
      skipped += 1;
      continue;
    }
    const name = o.option_type === "rofr" || o.option_type === "rofo" ? o.option_type.toUpperCase() : o.option_type;
    await put("option_notice_deadline", `${tenant} ${name} option #${o.sequence} notice deadline`, o.notice_end_on,
      `option:${o.id}:deadline`, 60, true, o);
    if (o.notice_start_on && o.notice_start_on >= now) {
      await put("option_notice_window", `${tenant} ${name} option #${o.sequence} notice window opens`,
        o.notice_start_on, `option:${o.id}:opens`, 30, false, o);
    }
  }

  for (const c of (await listChildren(db, leaseClauses, lease.id)) as LeaseClause[]) {
    if (!OBLIGATION_CATEGORIES.has(c.category) || !c.due_on) continue;
    if (!c.verified) {
      skipped += 1;
      continue;
    }
    await put(c.category, `${tenant}: ${c.title}`, c.due_on, `clause:${c.id}`, Math.max(c.response_days || 14, 7), false, c);
  }

  for (const g of (await listChildren(db, guaranties, lease.id)) as Guaranty[]) {
    if (g.status !== "active") continue;
    if (!g.verified) {
      skipped += 1;
      continue;
    }
    await put("guaranty_expiration", `${tenant} guaranty (${g.guarantor_name}) expires`, g.expires_on,
      `guaranty:${g.id}:expires`, 60, false, g);
    if (g.financials_required) {
      await put("guarantor_financials", `${g.guarantor_name} financial statements due`, g.financials_due_on,
        `guaranty:${g.id}:financials`, 14);
    }
  }
  return [generated, skipped, true];
}

// --------------------------------------------------------------------------- option economics

export async function optionEconomics(
  db: Db, lease: Lease, o: LeaseOption, vals: Rec, steps: OpStep[],
): Promise<OptionEconomics> {
  const now = today();
  const sf = num(o.pricing_params ? o.pricing_params.sf : null) || num(vals.rentable_sf);
  const current = rentAt(steps, now, vals.base_rent_annual);
  const cur_psf = rentPsf(current, sf);
  const market = num(o.market_rent_psf) || num(lease.market_rent_psf);
  const eco: OptionEconomics = {
    current_rent_psf: cur_psf, option_rent_psf: null, market_rent_psf: market, delta_psf: null, annual_delta: null,
    term_value: null, favors: null, remaining_rent: null, fee_amount: null, purchase_price: null, market_value: null,
    note: null,
  };

  if (o.option_type === "renewal" || o.option_type === "expansion") {
    let opt_psf: number | null = null;
    if (o.pricing_method === "fixed_rent") opt_psf = num(o.option_rent_psf);
    else if (o.pricing_method === "fixed_increase" && cur_psf !== null) opt_psf = cur_psf * (1 + (o.increase_pct || 0) / 100);
    else if (o.pricing_method === "fmv") opt_psf = market;
    else if (o.pricing_method === "pct_of_fmv" && market !== null) opt_psf = (market * (o.fmv_pct || 100)) / 100;
    eco.option_rent_psf = opt_psf !== null ? round(opt_psf, 2) : null;
    if (opt_psf !== null && market !== null) {
      const delta = market - opt_psf;
      eco.delta_psf = round(delta, 2);
      if (sf) {
        eco.annual_delta = round(delta * sf, 2);
        eco.term_value = round((delta * sf * (o.term_months || 12)) / 12, 2);
      }
      eco.favors = delta > 0.005 ? "tenant" : delta < -0.005 ? "landlord" : "neutral";
      eco.note = eco.favors === "tenant"
        ? "Option rent is below market: renewal value accrues to the tenant"
        : "Option rent is at or above market";
    } else {
      eco.note = "Add market rent (PSF) and option pricing to compute economics";
    }
  } else if (o.option_type === "termination") {
    const start = o.effective_on || now;
    const expiration = asDate(vals.expiration_on);
    let remaining = 0.0;
    if (expiration) {
      for (const [s, end] of steps) {
        if (s.charge_type !== "base_rent") continue;
        const a = maxDate(s.start_on, start);
        const b = minDate(end, expiration);
        if (b >= a) remaining += (Number(s.annual_rent) * (diffDays(b, a) + 1)) / 365.25;
      }
    }
    eco.remaining_rent = round(remaining, 2);
    eco.fee_amount = num(o.fee_amount);
    if (eco.fee_amount !== null && remaining) {
      eco.note = `Termination fee covers ${((eco.fee_amount / remaining) * 100).toFixed(0)}% of remaining base rent`;
      eco.favors = eco.fee_amount < remaining ? "tenant" : "landlord";
    }
  } else if (o.option_type === "purchase") {
    eco.purchase_price = num(o.purchase_price);
    const v = await compsService.latestValue(db, lease.property_id);
    eco.market_value = v ? num(v.value_point) : null;
    if (eco.purchase_price !== null && eco.market_value) {
      eco.favors = eco.purchase_price < eco.market_value ? "tenant" : "landlord";
      eco.note = `Option price is ${((eco.purchase_price / eco.market_value) * 100).toFixed(0)}% of the current mark`;
    }
  } else {
    eco.note = "Right of first refusal / offer: priced at third-party or landlord terms; no fixed economics";
  }
  return eco;
}

// --------------------------------------------------------------------------- rent roll & rollover

async function propertyIdsFor(db: Db, property_id: string | null | undefined, asset_id: string | null | undefined) {
  if (property_id) return [property_id];
  if (asset_id) {
    const a = await getById(db, assets, asset_id);
    if (a) return [a.property_id as string];
    const ids = await db.selectDistinct({ id: leases.property_id }).from(leases).where(eq(leases.asset_id, asset_id));
    return ids.length ? ids.map((r) => r.id) : [randomUUID()];
  }
  return null;
}

export type InPlace = [Lease, Rec, OpStep[]];

/** (lease, operative values, operative steps) for leases in place on `as_of`. */
export async function inPlaceLeases(db: Db, property_ids: string[] | null, as_of: string): Promise<InPlace[]> {
  const rows = await db
    .select()
    .from(leases)
    .where(and(
      isNull(leases.deleted_at), eq(leases.status, "active"),
      property_ids !== null ? inArray(leases.property_id, property_ids) : undefined,
    ));
  const out: InPlace[] = [];
  for (const lease of rows) {
    const [vals, steps] = await _operative(db, lease, as_of);
    const start = asDate(vals.commencement_on);
    const end = asDate(vals.expiration_on);
    if (vals.status !== null && vals.status !== undefined && vals.status !== "active") continue;
    if ((start && start > as_of) || (end && end < as_of)) continue;
    out.push([lease, vals, steps]);
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function rentRoll(
  db: Db, property_id: string | null | undefined, asset_id: string | null | undefined, as_of: string | null | undefined,
): Promise<RentRoll> {
  const asOf = as_of || today();
  const pids = await propertyIdsFor(db, property_id, asset_id);
  const inPlace = await inPlaceLeases(db, pids, asOf);
  const propIds = [...new Set([...(pids ?? []), ...inPlace.map(([l]) => l.property_id)])];
  const props = new Map(
    (propIds.length ? await db.select().from(properties).where(inArray(properties.id, propIds)) : []).map((p) => [p.id, p]),
  );
  const spaceRows = propIds.length
    ? await db.select().from(spaces).where(and(inArray(spaces.property_id, propIds), isNull(spaces.deleted_at)))
    : [];
  const spaceById = new Map(spaceRows.map((s) => [s.id, s]));
  const pname = (pid: string) => {
    const p = props.get(pid);
    return p ? p.name || p.address_line : null;
  };

  const rows: RentRollRow[] = [];
  const usedSpaces = new Set<string>();
  let leasedSf = 0;
  let annualTotal = 0;
  let waleNum = 0;
  let waleSfNum = 0;
  for (const [lease, vals, steps] of inPlace) {
    const sf = num(vals.rentable_sf) || 0.0;
    const rent = rentAt(steps, asOf, vals.base_rent_annual) || 0.0;
    const end = asDate(vals.expiration_on);
    const remaining = end ? yearsBetween(asOf, end) : null;
    const space_id: string | null = vals.space_id || null;
    if (space_id) usedSpaces.add(space_id);
    const s = space_id ? spaceById.get(space_id) : undefined;
    rows.push({
      id: String(lease.id), lease_id: lease.id, property_id: lease.property_id, property_name: pname(lease.property_id),
      space_id, suite: s ? s.suite : null, tenant_name: vals.tenant_name ?? null, lease_type: vals.lease_type ?? null,
      status: "occupied", sf: sf || null, annual_rent: round(rent, 2), monthly_rent: round(rent / 12, 2),
      rent_psf: rentPsf(rent, sf), commencement_on: asDate(vals.commencement_on), expiration_on: end,
      remaining_years: remaining !== null ? round(remaining, 2) : null, verified: lease.verified,
    });
    leasedSf += sf;
    annualTotal += rent;
    if (remaining !== null) {
      waleNum += rent * remaining;
      waleSfNum += sf * remaining;
    }
  }
  for (const s of spaceRows) {
    if (usedSpaces.has(s.id)) continue;
    rows.push({
      id: `space:${s.id}`, lease_id: null, property_id: s.property_id as string, property_name: pname(s.property_id as string),
      space_id: s.id, suite: s.suite, tenant_name: null, lease_type: null, status: "vacant", sf: num(s.area_sf),
      annual_rent: null, monthly_rent: null, rent_psf: null, commencement_on: null, expiration_on: null,
      remaining_years: null, verified: null,
    });
  }
  const vacantSpaceSf = spaceRows.filter((s) => !usedSpaces.has(s.id)).reduce((a, s) => a + (num(s.area_sf) || 0), 0);
  let totalSf: number;
  if (spaceRows.length) totalSf = leasedSf + vacantSpaceSf;
  else totalSf = [...props.values()].reduce((a, p) => a + (num(p.building_area_sf) || 0), 0) || leasedSf;
  totalSf = Math.max(totalSf, leasedSf);
  rows.sort((a, b) =>
    cmp(a.property_name || "", b.property_name || "") || cmp(a.suite || "~", b.suite || "~")
    || cmp(a.tenant_name || "", b.tenant_name || ""));
  const wale = annualTotal ? waleNum / annualTotal : leasedSf ? waleSfNum / leasedSf : null;
  return {
    property_id: property_id ?? null, as_of: asOf, rows,
    totals: {
      leased_sf: round(leasedSf, 2), vacant_sf: round(Math.max(totalSf - leasedSf, 0), 2), total_sf: round(totalSf, 2),
      occupancy_pct: totalSf ? round((leasedSf / totalSf) * 100, 2) : null, annual_rent: round(annualTotal, 2),
      monthly_rent: round(annualTotal / 12, 2), avg_rent_psf: rentPsf(annualTotal, leasedSf),
      wale_years: wale !== null ? round(wale, 2) : null, tenant_count: inPlace.length,
    },
  };
}

export async function rollover(
  db: Db, property_id: string | null | undefined, asset_id: string | null | undefined, years: number,
  as_of: string | null | undefined,
): Promise<Rollover> {
  const asOf = as_of || today();
  const inPlace = await inPlaceLeases(db, await propertyIdsFor(db, property_id, asset_id), asOf);
  let totalRent = 0.0;
  const buckets = new Map<number, { n: number; sf: number; rent: number; p_rent: number; down: number; re: number; ids: string[] }>();
  const asOfYear = yearOf(asOf);
  for (const [lease, vals, steps] of inPlace) {
    const rent = rentAt(steps, asOf, vals.base_rent_annual) || 0.0;
    totalRent += rent;
    const end = asDate(vals.expiration_on);
    if (!end || yearOf(end) > asOfYear + years - 1) continue;
    const sf = num(vals.rentable_sf) || 0.0;
    const p = lease.renewal_probability !== null ? lease.renewal_probability : DEFAULT_RENEWAL_PROBABILITY;
    const downtime = lease.downtime_months !== null ? lease.downtime_months : DEFAULT_DOWNTIME_MONTHS;
    const y = yearOf(end);
    let b = buckets.get(y);
    if (!b) {
      b = { n: 0, sf: 0.0, rent: 0.0, p_rent: 0.0, down: 0.0, re: 0.0, ids: [] };
      buckets.set(y, b);
    }
    b.n += 1;
    b.sf += sf;
    b.rent += rent;
    b.p_rent += p * rent;
    b.down += (rent * (1 - p) * downtime) / 12;
    b.re += sf * (num(lease.releasing_cost_psf) || 0) * (1 - p);
    b.ids.push(lease.id);
  }
  const out: RolloverYear[] = [];
  for (let y = asOfYear; y < asOfYear + years; y++) {
    const b = buckets.get(y);
    if (!b) {
      out.push({
        year: y, lease_count: 0, sf: 0, rent_at_risk: 0, pct_of_rent: 0, renewal_probability: null,
        expected_downtime_cost: 0, expected_releasing_cost: 0, lease_ids: [],
      });
      continue;
    }
    out.push({
      year: y, lease_count: b.n, sf: round(b.sf, 2), rent_at_risk: round(b.rent, 2),
      pct_of_rent: totalRent ? round((b.rent / totalRent) * 100, 2) : 0,
      renewal_probability: b.rent ? round(b.p_rent / b.rent, 3) : null,
      expected_downtime_cost: round(b.down, 2), expected_releasing_cost: round(b.re, 2), lease_ids: b.ids,
    });
  }
  return { property_id: property_id ?? null, as_of: asOf, total_rent: round(totalRent, 2), years: out };
}

/** Compact, verified-aware lease payload for underwriting / valuation / reporting. */
export async function forUnderwriting(db: Db, property_id: string) {
  const roll = await rentRoll(db, property_id, null, null);
  const tenants: Rec[] = [];
  const now = today();
  for (const [lease, vals, steps] of await inPlaceLeases(db, [property_id], now)) {
    const rec = (await listChildren(db, leaseRecoveries, lease.id)) as LeaseRecovery[];
    const opts = (await listChildren(db, leaseOptions, lease.id)) as LeaseOption[];
    const rent = rentAt(steps, now, vals.base_rent_annual);
    tenants.push({
      lease_id: String(lease.id), tenant_name: vals.tenant_name ?? null, lease_type: vals.lease_type ?? null,
      sf: num(vals.rentable_sf), commencement_on: asDate(vals.commencement_on), expiration_on: asDate(vals.expiration_on),
      current_annual_rent: rent, rent_psf: rentPsf(rent, num(vals.rentable_sf)), verified: lease.verified,
      steps: steps.filter(([s]) => s.charge_type === "base_rent")
        .map(([s, e]) => ({ start_on: s.start_on, end_on: e, annual_rent: Number(s.annual_rent) })),
      escalation: lease.escalation || {},
      recoveries: rec.map((r) => ({
        method: r.method, category: r.category, pro_rata_share: r.pro_rata_share, base_amount: r.base_amount,
        cap_type: r.cap_type, cap_pct: r.cap_pct, verified: r.verified,
      })),
      options: opts.map((o) => ({
        type: o.option_type, term_months: o.term_months, notice_end_on: o.notice_end_on,
        pricing_method: o.pricing_method, option_rent_psf: o.option_rent_psf, status: o.status, verified: o.verified,
      })),
      market_rent_psf: lease.market_rent_psf,
      renewal_probability: lease.renewal_probability !== null ? lease.renewal_probability : DEFAULT_RENEWAL_PROBABILITY,
      downtime_months: lease.downtime_months !== null ? lease.downtime_months : DEFAULT_DOWNTIME_MONTHS,
      releasing_cost_psf: lease.releasing_cost_psf,
    });
  }
  const t = roll.totals;
  return {
    property_id: String(property_id), as_of: roll.as_of, rentable_sf: t.total_sf, leased_sf: t.leased_sf,
    occupancy_pct: t.occupancy_pct, wale_years: t.wale_years, in_place_rent: t.annual_rent,
    avg_rent_psf: t.avg_rent_psf, all_verified: tenants.every((x) => x.verified), tenants,
  };
}

// --------------------------------------------------------------------------- recovery reconciliation

function poolFor(pool: Record<string, number>, category: string, exclusions: string[]): [number, Record<string, number>] {
  const excluded: Record<string, number> = {};
  let total = 0.0;
  for (const [key, amount] of Object.entries(pool)) {
    const top = key.split(":", 1)[0];
    if (category !== "all" && top !== category) continue;
    if (exclusions.includes(key) || exclusions.includes(top)) {
      excluded[key] = amount;
      continue;
    }
    total += Number(amount || 0);
  }
  return [total, excluded];
}

function tenantAmount(r: LeaseRecovery, pool: number, share: number, sf: number, total_sf: number): number {
  if (r.method === "fixed_cam") return Number(r.fixed_amount_annual || 0);
  if (r.method === "base_year" || r.method === "modified_gross") {
    return (Math.max(0.0, pool - Number(r.base_amount || 0)) * share) / 100;
  }
  if (r.method === "expense_stop") {
    const poolPsf = total_sf ? pool / total_sf : 0;
    return Math.max(0.0, poolPsf - Number(r.expense_stop_psf || 0)) * sf;
  }
  return (pool * share) / 100;
}

async function billedRecoveries(db: Db, lease_id: string, year: number): Promise<number | null> {
  const [r] = await db
    .select({ total: sql<number>`coalesce(sum(${charges.amount}), 0)` })
    .from(charges)
    .where(and(
      eq(charges.lease_id, lease_id), isNull(charges.deleted_at),
      sql`${charges.status} not in ('void', 'pending_approval')`,
      inArray(charges.charge_type, RECOVERY_CHARGE_TYPES),
      gte(charges.period_start, ymd(year, 1, 1)), lte(charges.period_start, ymd(year, 12, 31)),
    ));
  return Number(r?.total ?? 0);
}

export async function runReconciliation(
  db: Db, data: ReconRunIn, actor: CurrentUser,
): Promise<[RecoveryReconciliation[], number, number, number]> {
  const prop = await getProperty(db, data.property_id);
  const y0 = ymd(data.year, 1, 1);
  const y1 = ymd(data.year, 12, 31);
  let totalSf: number = data.total_sf ?? 0;
  if (!totalSf) {
    const [r] = await db
      .select({ total: sql<number>`coalesce(sum(${spaces.area_sf}), 0)` })
      .from(spaces)
      .where(and(eq(spaces.property_id, prop.id), isNull(spaces.deleted_at)));
    totalSf = Number(r?.total ?? 0) || num(prop.building_area_sf) || 0;
  }
  const leaseRows = await db
    .select()
    .from(leases)
    .where(and(
      eq(leases.property_id, prop.id), isNull(leases.deleted_at),
      inArray(leases.status, ["active", "expired", "terminated"]),
      or(isNull(leases.commencement_on), lte(leases.commencement_on, y1)),
      or(isNull(leases.expiration_on), gte(leases.expiration_on, y0)),
      data.lease_ids?.length ? inArray(leases.id, data.lease_ids) : undefined,
    ));
  const items: RecoveryReconciliation[] = [];
  let created = 0;
  let updated = 0;
  let locked = 0;
  const reconOf = async (lease_id: string, year: number) => {
    const [r] = await db
      .select()
      .from(recoveryReconciliations)
      .where(and(
        eq(recoveryReconciliations.lease_id, lease_id), eq(recoveryReconciliations.year, year),
        isNull(recoveryReconciliations.deleted_at),
      ))
      .limit(1);
    return r;
  };
  for (const lease of leaseRows) {
    let rec = await reconOf(lease.id, data.year);
    if (rec && rec.status !== "draft") {
      locked += 1;
      items.push(rec);
      continue;
    }
    const [vals] = await _operative(db, lease, y1);
    const sf = num(vals.rentable_sf) || 0.0;
    const start = maxDate(asDate(vals.commencement_on) || y0, y0);
    const end = minDate(asDate(vals.expiration_on) || y1, y1);
    const occupancyFactor = Math.max(0.0, (diffDays(end, start) + 1) / (diffDays(y1, y0) + 1));
    const details: Rec[] = [];
    let actualTotal = 0.0;
    let budgetTotal = 0.0;
    let capTotal = 0.0;
    const prior = await reconOf(lease.id, data.year - 1);
    const priorCaps: Record<string, any> = Object.fromEntries(
      (prior ? prior.details : []).map((d: Rec) => [d.recovery_id, d.capped_amount]),
    );
    let shareUsed: number | null = null;
    const recoveries = (await listChildren(db, leaseRecoveries, lease.id)) as LeaseRecovery[];
    for (const r of recoveries) {
      if (!r.verified) {
        details.push({ recovery_id: String(r.id), method: r.method, category: r.category, skipped: "Recovery terms are not verified" });
        continue;
      }
      const share = r.pro_rata_share || num(vals.pro_rata_share) || (totalSf ? (sf / totalSf) * 100 : 0);
      shareUsed = share;
      const [pool, excluded] = poolFor(data.actual, r.category, r.exclusions || []);
      const [bpool] = poolFor(data.budgeted, r.category, r.exclusions || []);
      let gross = tenantAmount(r, pool, share, sf, totalSf);
      let budget = tenantAmount(r, bpool, share, sf, totalSf);
      const admin = (r.admin_fee_pct || 0) / 100;
      gross *= 1 + admin;
      budget *= 1 + admin;
      let allowed: number | null = null;
      let reduction = 0.0;
      if (r.cap_type !== "none" && r.cap_pct !== null) {
        const cap = r.cap_pct / 100;
        const n = data.year - (r.cap_base_year || data.year);
        const priorCap = priorCaps[String(r.id)];
        if (r.cap_type === "non_cumulative" && priorCap !== null && priorCap !== undefined) {
          // Non-cumulative: capped against last year's (capped) recoverable amount.
          allowed = Number(priorCap) * (1 + cap);
        } else if (r.cap_base_amount !== null) {
          allowed = Number(r.cap_base_amount) * (1 + cap) ** Math.max(n, 0);
        }
        if (allowed !== null && gross > allowed) {
          reduction = gross - allowed;
          gross = allowed;
        }
        if (allowed !== null) budget = Math.min(budget, allowed);
      }
      const amount = gross * occupancyFactor;
      const budgetAmt = budget * occupancyFactor;
      details.push({
        recovery_id: String(r.id), method: r.method, category: r.category, pool: round(pool, 2), excluded,
        share_pct: round(share, 4), admin_fee_pct: r.admin_fee_pct, cap_type: r.cap_type, cap_pct: r.cap_pct,
        cap_allowed: allowed !== null ? round(allowed, 2) : null, cap_reduction: round(reduction * occupancyFactor, 2),
        capped_amount: round(gross, 2), occupancy_factor: round(occupancyFactor, 4), tenant_amount: round(amount, 2),
        budget_amount: round(budgetAmt, 2),
      });
      actualTotal += amount;
      budgetTotal += budgetAmt;
      capTotal += reduction * occupancyFactor;
    }
    let billed = await billedRecoveries(db, lease.id, data.year);
    if (billed === null || billed === 0) {
      billed = recoveries.filter((r) => r.verified)
        .reduce((a, r) => a + Number(r.estimated_monthly || 0) * 12 * occupancyFactor, 0);
    }
    const values = {
      budgeted_pool: data.budgeted, actual_pool: data.actual, share_pct: shareUsed,
      budgeted_share: round(budgetTotal, 2), actual_share: round(actualTotal, 2), cap_reduction: round(capTotal, 2),
      estimates_billed: round(billed, 2), true_up_amount: round(actualTotal - billed, 2), details,
    };
    let changes: Rec;
    if (rec) {
      changes = audit.diff(rec, values);
      rec = await patch(db, recoveryReconciliations, rec, { ...values, updated_by_id: actor.id } as never);
      updated += 1;
    } else {
      rec = await insert(db, recoveryReconciliations, {
        lease_id: lease.id, property_id: prop.id, year: data.year, status: "draft", created_by_id: actor.id,
        updated_by_id: actor.id, ...values,
      } as never);
      changes = { true_up_amount: { from: null, to: rec.true_up_amount } };
      created += 1;
    }
    await audit.record(db, {
      actor, action: "lease.reconciliation_computed", entity_type: ENTITY, entity_id: lease.id,
      summary: `${data.year} true-up ${money(rec.true_up_amount)}`,
      changes: { reconciliation_id: rec.id, ...changes }, ip_address: actor.ip_address,
    });
    items.push(rec);
  }
  await db.commit();
  return [items, created, updated, locked];
}

export async function finalizeReconciliation(db: Db, rec: RecoveryReconciliation, actor: CurrentUser) {
  if (rec.status !== "draft") throw new HttpError(409, "Only draft reconciliations can be finalized");
  await patch(db, recoveryReconciliations, rec, {
    status: "final", finalized_by_id: actor.id, finalized_at: utcnow(), updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "lease.reconciliation_finalized", entity_type: ENTITY, entity_id: rec.lease_id,
    summary: `${rec.year} true-up ${money(rec.true_up_amount)}`, changes: { reconciliation_id: rec.id },
    ip_address: actor.ip_address,
  });
  await events.emit(db, "lease.reconciliation_finalized", {
    reconciliation_id: rec.id, lease_id: rec.lease_id, year: rec.year, true_up_amount: rec.true_up_amount, actor,
  });
  await db.commit();
  return rec;
}

/** Called by receivables when the true-up charge is created. Does not commit.
 *  (Python mutated `rec` in place; here the UPDATE is issued explicitly, hence the extra `db` first argument.) */
export async function markReconciliationBilled(
  db: Db, rec: RecoveryReconciliation, charge_id: string, actor: { id?: string | null } | null,
): Promise<void> {
  await patch(db, recoveryReconciliations, rec, {
    status: "billed", billed_charge_id: charge_id, updated_by_id: actor?.id ?? null,
  });
}

// --------------------------------------------------------------------------- documents / AI extraction

/** Short-lived link to the cited page. Access rules (sensitivity) are enforced by the documents module. */
export async function documentUrl(db: Db, document_id: string, page: number | null | undefined, user: CurrentUser) {
  const d = await docService.get(db, document_id, user);
  const url = await docService.signedUrl(d.id, 10, { user_id: user.id, inline: docService.canInline(d.mime_type) });
  return page ? `${url}#page=${page}` : String(url);
}

export async function importExtractions(db: Db, lease: Lease, actor: CurrentUser) {
  let rows: Rec[];
  try {
    rows = (await nested(db, () => raw(db, sql`
      select id, document_id, target_entity_type, target_entity_id, field, value, page, clause, citation_text,
             confidence, status, deleted_at
      from extracted_values
      where target_entity_type = 'lease' and target_entity_id = ${lease.id}
        and status in ('pending', 'confirmed', 'edited') and deleted_at is null`))) ?? [];
  } catch {
    // documents module/table not present yet
    throw new HttpError(501, "Document extraction is not available");
  }
  let fieldsSet = 0;
  let clausesAdded = 0;
  const citations: Rec = { ...(lease.citations ?? {}) };
  const existing = new Set(
    ((await listChildren(db, leaseClauses, lease.id)) as LeaseClause[]).map(
      (c) => `${c.category}\u0000${(c.quoted_text || "").slice(0, 200)}`,
    ),
  );
  for (const r of rows) {
    const rawValue = r.value;
    let value: any = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) && "value" in rawValue
      ? rawValue.value
      : rawValue;
    const cite = {
      document_id: r.document_id ? String(r.document_id) : null, page: r.page ?? null,
      clause_ref: r.clause ? String(r.clause).slice(0, 80) : null, quoted_text: r.citation_text ?? null,
    };
    const field = String(r.field);
    const conf = r.confidence !== null && r.confidence !== undefined ? Number(r.confidence) : 0.5;
    if (MATERIAL_FIELDS.has(field) && field !== "status") {
      if (DATE_FIELDS.has(field)) value = asDate(value);
      const prov = provenanceIn.parse({ source: "AI extraction", confidence: conf, ai_derived: true });
      const ch = await provenance.applyMaterial(db, lease, {
        entity_type: ENTITY, data: { [field]: value }, material_fields: MATERIAL_FIELDS, prov, actor_id: actor.id,
      });
      if (Object.keys(ch).length) fieldsSet += 1;
      citations[field] = cite;
    } else if (field.startsWith("clause.")) {
      const category = field.split(".").slice(1).join(".") || "other";
      if (existing.has(`${category}\u0000${(r.citation_text || "").slice(0, 200)}`)) continue;
      await insert(db, leaseClauses, {
        lease_id: lease.id, category: category.slice(0, 30), title: titleCase(category.replace(/_/g, " ")),
        summary: value !== null && value !== undefined ? String(value) : null, ai_extracted: true, confidence: conf,
        verified: false, document_id: r.document_id, page: r.page, clause_ref: cite.clause_ref,
        quoted_text: r.citation_text, created_by_id: actor.id, updated_by_id: actor.id,
      } as never);
      clausesAdded += 1;
    }
  }
  if (fieldsSet || clausesAdded) {
    lease.citations = citations;
    lease.ai_extracted = true;
    if (fieldsSet) {
      lease.verified = false;
      lease.verified_by_id = null;
      lease.verified_at = null;
    }
    lease.updated_by_id = actor.id;
    await save(db, leases, lease);
    await audit.record(db, {
      actor, action: "lease.extractions_imported", entity_type: ENTITY, entity_id: lease.id,
      summary: `${fieldsSet} terms, ${clausesAdded} clauses (unverified)`, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return { fields: fieldsSet, clauses: clausesAdded };
}

export async function spaceOptions(db: Db, property_id: string) {
  return db
    .select()
    .from(spaces)
    .where(and(eq(spaces.property_id, property_id), isNull(spaces.deleted_at)))
    .orderBy(asc(spaces.suite));
}
