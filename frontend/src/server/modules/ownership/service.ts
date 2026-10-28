import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, not, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { normalizeAddress, normalizeName } from "../../common/normalize";
import * as provenance from "../../common/provenance";
import type { ProvenanceIn } from "../../common/provenance";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch } from "../../db/orm";
import {
  affiliations, contactPoints, organizations, people,
} from "../contacts/schema";
import {
  backfillNormalized, context as contactContext, emailDomain, normDomain, normPhone,
} from "../contacts/service";
import { properties } from "../properties/schema";
import {
  CONTROL_RELATIONSHIPS, entityLinks, ownerNotes, ownershipInterests,
  type EntityLink, type OwnerNote, type OwnershipInterest,
} from "./schema";
import { evidenceJson } from "./schemas";
import type {
  EndInterestIn, InterestIn, InterestUpdate, LinkIn, LinkReviewIn, LinkUpdate, NoteIn,
} from "./schemas";

export { CONTROL_RELATIONSHIPS };

export const ENTITY = "ownership_interest";
const MATERIAL = new Set(["interest_pct", "role", "effective_from", "effective_to", "acquired_price", "disposed_price"]);
export type Node = [string, string];
const nk = (n: Node) => `${n[0]}:${n[1]}`;

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "msn.com",
  "live.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "protonmail.com", "mail.com",
]);
const EVIDENCE_WEIGHTS: Record<string, number> = {
  shared_mailing_address: 0.35, shared_phone: 0.45, shared_email_domain: 0.4, registered_agent: 0.3,
};
const MAX_GROUP = 15; // larger groups are shared infrastructure (agent services, office towers), not relationships

const oi = ownershipInterests;
const today = () => new Date().toISOString().slice(0, 10);
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const clean = (o: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---------------------------------------------------------------- small helpers

export function isCurrent(i: Pick<OwnershipInterest, "effective_to">, t: string = today()): boolean {
  return i.effective_to === null || i.effective_to > t;
}

export function holdYears(start: string | null | undefined, end?: string | null): number | null {
  if (!start) return null;
  const days = Math.max(0, Math.round((Date.parse(end ?? today()) - Date.parse(start)) / 86_400_000));
  return round(days / 365.25, 1);
}

export const ownerIdOf = (i: Pick<OwnershipInterest, "owner_person_id" | "owner_organization_id">): string | null =>
  i.owner_person_id || i.owner_organization_id;

const normState = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

export function stateMismatch(ownerState: string | null | undefined, propertyState: string | null | undefined): boolean {
  return Boolean(ownerState && propertyState && normState(ownerState) !== normState(propertyState));
}

export function visibleEvidence(items: any[] | null | undefined, showSensitive: boolean): [any[], number] {
  const all = items ?? [];
  if (showSensitive) return [[...all], 0];
  const shown = all.filter((e) => !e.sensitive);
  return [shown, all.length - shown.length];
}

/** Evidence safe to leave the system: sensitive entries are dropped entirely. */
export function outboundEvidence(items: any[] | null | undefined): any[] {
  return (items ?? []).filter((e) => !e.sensitive).map(({ sensitive: _s, ...rest }) => rest);
}

export function signature(a: Node, b: Node): string {
  const [x, y] = [`${a[0]}:${a[1]}`, `${b[0]}:${b[1]}`].sort();
  return `${x}|${y}`;
}

export const canSeeSensitive = (user: CurrentUser): boolean => user.can("ownership", "view_sensitive");

export interface NodeInfo {
  label: string;
  subtitle: string | null;
  city: string | null;
  state: string | null;
  mailing_address?: string | null;
  deleted: boolean;
  relationship_strength?: string;
  last_touch_at?: Date | null;
  preferences?: Record<string, any>;
  property_type?: string;
}

/** Label + location for people, organizations and properties. Keys are `kind:id`. */
export async function nodeInfo(db: Db, nodes: Node[]): Promise<Map<string, NodeInfo>> {
  const out = new Map<string, NodeInfo>();
  const byKind: Record<string, Set<string>> = {};
  for (const [k, i] of nodes) (byKind[k] ??= new Set()).add(i);
  if (byKind.person?.size) {
    for (const p of await db.select().from(people).where(inArray(people.id, [...byKind.person]))) {
      out.set(`person:${p.id}`, {
        label: p.full_name, subtitle: p.title, city: p.city, state: p.state, mailing_address: p.mailing_address,
        deleted: p.deleted_at !== null, relationship_strength: p.relationship_strength, last_touch_at: p.last_touch_at,
        preferences: p.preferences || {},
      });
    }
  }
  if (byKind.organization?.size) {
    for (const o of await db.select().from(organizations).where(inArray(organizations.id, [...byKind.organization]))) {
      out.set(`organization:${o.id}`, {
        label: o.name, subtitle: o.legal_name || o.org_type, city: o.city, state: o.state,
        mailing_address: o.mailing_address, deleted: o.deleted_at !== null,
        relationship_strength: o.relationship_strength, last_touch_at: o.last_touch_at, preferences: o.preferences || {},
      });
    }
  }
  if (byKind.property?.size) {
    const rows = await db
      .select({
        id: properties.id, name: properties.name, address_line: properties.address_line, city: properties.city,
        state: properties.state, property_type: properties.property_type, deleted_at: properties.deleted_at,
      })
      .from(properties)
      .where(inArray(properties.id, [...byKind.property]));
    for (const p of rows) {
      out.set(`property:${p.id}`, {
        label: p.name || p.address_line, subtitle: p.address_line, city: p.city, state: p.state,
        property_type: p.property_type, deleted: p.deleted_at !== null,
      });
    }
  }
  return out;
}

export async function ensureOwner(db: Db, kind: string, ownerId: string): Promise<void> {
  const info = (await nodeInfo(db, [[kind, ownerId]])).get(`${kind}:${ownerId}`);
  if (!info || info.deleted) throw new HttpError(404, `${title(kind)} not found`);
}

// ---------------------------------------------------------------- interests

export interface InterestFilters {
  q?: string;
  property_id?: string;
  owner_kind?: string[];
  owner_id?: string;
  role?: string[];
  verification?: string[];
  current?: boolean;
  state?: string[];
  mismatch?: boolean;
}

const ownerState = sql<string | null>`coalesce(${people.state}, ${organizations.state})`;
const ownerLabel = sql<string | null>`coalesce(${people.full_name}, ${organizations.name})`;

export function buildInterestWhere(f: InterestFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = today();
  const current = or(isNull(oi.effective_to), sql`${oi.effective_to} > ${t}`) as SQL;
  return and(
    isNull(oi.deleted_at),
    isNull(properties.deleted_at),
    applySearch(f.q, [
      people.full_name, organizations.name, organizations.legal_name, properties.name, properties.address_line,
      properties.city,
    ]),
    f.property_id ? eq(oi.property_id, f.property_id) : undefined,
    f.owner_id ? or(eq(oi.owner_person_id, f.owner_id), eq(oi.owner_organization_id, f.owner_id)) : undefined,
    skip.has("owner_kind") ? undefined : inFilter(oi.owner_kind, f.owner_kind),
    skip.has("role") ? undefined : inFilter(oi.role, f.role),
    skip.has("verification") ? undefined : inFilter(oi.verification, f.verification),
    inFilter(properties.state, f.state),
    f.current === true ? current : undefined,
    f.current === false ? not(current) : undefined,
    f.mismatch
      ? and(
          sql`${ownerState} is not null`,
          isNotNull(properties.state),
          sql`upper(trim(${ownerState})) != upper(trim(${properties.state}))`,
        )
      : undefined,
  );
}

export function interestSorts(): Record<string, SQL | any> {
  return {
    effective_from: oi.effective_from, effective_to: oi.effective_to, interest_pct: oi.interest_pct,
    acquired_price: oi.acquired_price, confidence: oi.confidence, role: oi.role,
    owner: sql`coalesce(${people.full_name}, ${organizations.name})`, property: properties.address_line,
    updated_at: oi.updated_at,
  };
}

/** Interest rows joined with property + owner labels (`with_labels(build_interest_query(...))`). */
export function interestSelect(db: Db) {
  return db
    .select({
      oi,
      pname: properties.name, paddr: properties.address_line, pcity: properties.city, pstate: properties.state,
      olabel: ownerLabel, ostate: ownerState,
    })
    .from(oi)
    .innerJoin(properties, eq(properties.id, oi.property_id))
    .leftJoin(people, eq(people.id, oi.owner_person_id))
    .leftJoin(organizations, eq(organizations.id, oi.owner_organization_id));
}
export interface InterestRow {
  oi: OwnershipInterest;
  pname: string | null;
  paddr: string;
  pcity: string | null;
  pstate: string | null;
  olabel: string | null;
  ostate: string | null;
}

export async function interestCount(db: Db, where: SQL | undefined): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(oi)
    .innerJoin(properties, eq(properties.id, oi.property_id))
    .leftJoin(people, eq(people.id, oi.owner_person_id))
    .leftJoin(organizations, eq(organizations.id, oi.owner_organization_id))
    .where(where);
  return Number(r?.n ?? 0);
}

export async function interestFacet(db: Db, where: SQL | undefined, column: any): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column as SQL<string | null>, n: count() })
    .from(oi)
    .innerJoin(properties, eq(properties.id, oi.property_id))
    .leftJoin(people, eq(people.id, oi.owner_person_id))
    .leftJoin(organizations, eq(organizations.id, oi.owner_organization_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export function interestOut(
  i: OwnershipInterest,
  o: { show_sensitive: boolean; owner_label?: string | null; owner_state?: string | null; prop_label?: string | null;
       prop_city?: string | null; prop_state?: string | null },
) {
  const [evidence, hidden] = visibleEvidence(i.evidence, o.show_sensitive);
  const current = isCurrent(i);
  return {
    id: i.id,
    property_id: i.property_id,
    owner_kind: i.owner_kind,
    owner_person_id: i.owner_person_id,
    owner_organization_id: i.owner_organization_id,
    interest_pct: i.interest_pct,
    role: i.role,
    effective_from: i.effective_from,
    effective_to: i.effective_to,
    acquired_price: i.acquired_price,
    disposed_price: i.disposed_price,
    financing_type: i.financing_type,
    deed_reference: i.deed_reference,
    end_reason: i.end_reason,
    evidence,
    hidden_evidence: hidden,
    source: i.source,
    observed_on: i.observed_on,
    confidence: i.confidence,
    verification: i.verification,
    verified_by_id: i.verified_by_id,
    verified_at: i.verified_at,
    notes: i.notes,
    created_at: i.created_at,
    updated_at: i.updated_at,
    // derived
    owner_id: ownerIdOf(i),
    owner_label: o.owner_label ?? null,
    owner_state: o.owner_state ?? null,
    property_label: o.prop_label ?? null,
    property_city: o.prop_city ?? null,
    property_state: o.prop_state ?? null,
    is_current: current,
    hold_years: holdYears(i.effective_from, current ? null : i.effective_to),
    mismatch: stateMismatch(o.owner_state, o.prop_state),
  };
}
export type InterestOut = ReturnType<typeof interestOut>;

export function rowToOut(row: InterestRow, showSensitive: boolean): InterestOut {
  return interestOut(row.oi, {
    show_sensitive: showSensitive, owner_label: row.olabel, owner_state: row.ostate, prop_label: row.pname || row.paddr,
    prop_city: row.pcity, prop_state: row.pstate,
  });
}

export async function getInterest(db: Db, interestId: string): Promise<OwnershipInterest> {
  const i = await get(db, oi, interestId);
  if (!i || i.deleted_at) throw new HttpError(404, "Ownership interest not found");
  return i;
}

export async function interestFull(db: Db, interestId: string, user: CurrentUser): Promise<InterestOut> {
  const [row] = await interestSelect(db)
    .where(and(buildInterestWhere({}), eq(oi.id, interestId)))
    .limit(1);
  if (!row) throw new HttpError(404, "Ownership interest not found");
  return rowToOut(row, canSeeSensitive(user));
}

function prov(source: string | null | undefined, observedOn: string | null | undefined, confidence: number | null | undefined,
  verified = false): ProvenanceIn {
  return {
    source: source || "Manual entry", observed_on: observedOn, confidence: confidence ?? 0.8, verified, ai_derived: false,
  };
}

async function auditInterest(
  db: Db, actor: CurrentUser, i: OwnershipInterest, verb: string, summary?: string | null, changes?: Record<string, any> | null,
): Promise<void> {
  await audit.record(db, {
    actor, action: `ownership_interest.${verb}`, entity_type: ENTITY, entity_id: i.id, summary, changes,
    ip_address: actor.ip_address,
  });
  await audit.record(db, {
    actor, action: `property.ownership_${verb}`, entity_type: "property", entity_id: i.property_id, summary, changes,
    ip_address: actor.ip_address,
  });
}

export async function createInterest(db: Db, data: InterestIn, actor: CurrentUser): Promise<OwnershipInterest> {
  const [prop] = await db
    .select({ id: properties.id, deleted_at: properties.deleted_at })
    .from(properties)
    .where(eq(properties.id, data.property_id))
    .limit(1);
  if (!prop || prop.deleted_at) throw new HttpError(404, "Property not found");
  await ensureOwner(db, data.owner_kind, data.owner_id);
  if (data.effective_from && data.effective_to && data.effective_to < data.effective_from) {
    throw new HttpError(422, "Effective to must be on or after effective from");
  }
  const verified = data.verified;
  const row = await insert(db, oi, {
    property_id: data.property_id,
    owner_kind: data.owner_kind,
    owner_person_id: data.owner_kind === "person" ? data.owner_id : null,
    owner_organization_id: data.owner_kind === "organization" ? data.owner_id : null,
    interest_pct: data.interest_pct,
    role: data.role,
    effective_from: data.effective_from,
    effective_to: data.effective_to,
    acquired_price: data.acquired_price,
    financing_type: data.financing_type,
    deed_reference: data.deed_reference,
    evidence: data.evidence.map(evidenceJson),
    source: data.source,
    observed_on: data.observed_on || today(),
    confidence: data.confidence,
    verification: verified ? "verified" : "unverified",
    verified_by_id: verified ? actor.id : null,
    verified_at: verified ? utcnow() : null,
    notes: data.notes,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  const p = prov(data.source, data.observed_on, data.confidence, verified);
  for (const field of MATERIAL) {
    const value = (row as Record<string, any>)[field];
    if (value !== null && value !== undefined) {
      await provenance.observe(db, { entity_type: ENTITY, entity_id: row.id, field, value, prov: p, actor_id: actor.id });
    }
  }
  const info = (await nodeInfo(db, [[data.owner_kind, data.owner_id]])).get(`${data.owner_kind}:${data.owner_id}`);
  await auditInterest(db, actor, row, "added", `${info?.label} · ${row.role.replace(/_/g, " ")}`);
  await events.emit(db, "ownership.changed", { property_id: row.property_id, interest_id: row.id, actor });
  await db.commit();
  return row;
}

export async function updateInterest(
  db: Db, row: OwnershipInterest, data: InterestUpdate, actor: CurrentUser,
): Promise<OwnershipInterest> {
  const { evidence, source, observed_on, confidence, ...rest } = data;
  const values = clean(rest);
  if (evidence !== null && evidence !== undefined) {
    const next: any[] = evidence.map(evidenceJson);
    if (!canSeeSensitive(actor)) next.push(...(row.evidence || []).filter((e) => e.sensitive)); // keep what the user could not see
    values.evidence = next;
  }
  if (values.effective_from && row.effective_to && row.effective_to < values.effective_from) {
    throw new HttpError(422, "Effective from must be before the end date");
  }
  const p = prov(source || row.source, observed_on, confidence ?? row.confidence);
  const changes = await provenance.applyMaterial(db, row, {
    entity_type: ENTITY, data: values, material_fields: MATERIAL, prov: p, actor_id: actor.id,
  });
  const set: Record<string, any> = Object.fromEntries(Object.keys(changes).map((k) => [k, (row as Record<string, any>)[k]]));
  for (const [f, v] of [["source", source], ["observed_on", observed_on], ["confidence", confidence]] as const) {
    if (v !== null && v !== undefined && (row as Record<string, any>)[f] !== v) {
      changes[f] = { from: audit.toJsonable((row as Record<string, any>)[f]), to: audit.toJsonable(v) };
      set[f] = v;
    }
  }
  if (!Object.keys(changes).length) return row;
  if (Object.keys(changes).some((k) => MATERIAL.has(k)) && row.verification === "verified") {
    Object.assign(set, { verification: "unverified", verified_by_id: null, verified_at: null });
  }
  set.updated_by_id = actor.id;
  await patch(db, oi, row, set as never);
  if ("evidence" in changes) (changes as Record<string, any>).evidence = "updated";
  await auditInterest(db, actor, row, "updated", null, changes);
  await events.emit(db, "ownership.changed", { property_id: row.property_id, interest_id: row.id, actor });
  await db.commit();
  return row;
}

export async function endInterest(
  db: Db, row: OwnershipInterest, data: EndInterestIn, actor: CurrentUser,
): Promise<OwnershipInterest> {
  if (row.effective_to && row.effective_to <= today()) throw new HttpError(409, "This interest has already ended");
  if (row.effective_from && data.effective_to < row.effective_from) throw new HttpError(422, "End date is before the interest began");
  const values: Record<string, any> = { effective_to: data.effective_to };
  if (data.disposed_price !== null && data.disposed_price !== undefined) values.disposed_price = data.disposed_price;
  const changes = await provenance.applyMaterial(db, row, {
    entity_type: ENTITY, data: values, material_fields: MATERIAL, prov: prov(data.source, data.effective_to, 0.9),
    actor_id: actor.id,
  });
  const set: Record<string, any> = Object.fromEntries(Object.keys(changes).map((k) => [k, (row as Record<string, any>)[k]]));
  set.end_reason = data.reason ?? null;
  set.updated_by_id = actor.id;
  await patch(db, oi, row, set as never);
  await auditInterest(db, actor, row, "ended", data.reason, changes);
  await events.emit(db, "ownership.changed", { property_id: row.property_id, interest_id: row.id, actor });
  await db.commit();
  return row;
}

export async function verifyInterest(
  db: Db, row: OwnershipInterest, state: string, actor: CurrentUser,
): Promise<OwnershipInterest> {
  const before = row.verification;
  await patch(db, oi, row, {
    verification: state,
    verified_by_id: state !== "unverified" ? actor.id : null,
    verified_at: state !== "unverified" ? utcnow() : null,
    updated_by_id: actor.id,
  });
  await auditInterest(db, actor, row, state, null, { verification: { from: before, to: state } });
  await db.commit();
  return row;
}

// ---------------------------------------------------------------- property ownership panel

async function controllers(db: Db, owners: Node[]): Promise<Map<string, EntityLink[]>> {
  const out = new Map<string, EntityLink[]>();
  if (!owners.length) return out;
  const rows = await db
    .select()
    .from(entityLinks)
    .where(
      and(
        isNull(entityLinks.deleted_at),
        inArray(entityLinks.to_id, owners.map(([, i]) => i)),
        ne(entityLinks.status, "rejected"),
        inArray(entityLinks.relationship, [...CONTROL_RELATIONSHIPS].sort()),
        or(isNull(entityLinks.effective_to), sql`${entityLinks.effective_to} > ${today()}`),
      ),
    );
  const wanted = new Set(owners.map(nk));
  for (const link of rows) {
    const key = `${link.to_kind}:${link.to_id}`;
    if (wanted.has(key)) out.set(key, [...(out.get(key) ?? []), link]);
  }
  return out;
}

export async function propertyPanel(db: Db, propertyId: string, user: CurrentUser) {
  const [prop] = await db
    .select({ id: properties.id, state: properties.state, deleted_at: properties.deleted_at })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);
  if (!prop || prop.deleted_at) throw new HttpError(404, "Property not found");
  const show = canSeeSensitive(user);
  const contactSensitive = user.can("contacts", "view_sensitive");
  const rows = await interestSelect(db)
    .where(buildInterestWhere({ property_id: propertyId }))
    .orderBy(sql`${oi.effective_from} desc nulls last`, desc(oi.created_at));
  const history = rows.map((r) => rowToOut(r, show));
  const current = history.filter((h) => h.is_current && h.verification !== "rejected");
  const ownerNodes: Node[] = current.filter((h) => h.owner_id).map((h) => [h.owner_kind, h.owner_id as string]);
  const info = await nodeInfo(db, ownerNodes);
  const ctrls = await controllers(db, ownerNodes);
  const ctrlLabels = await nodeInfo(
    db, [...ctrls.values()].flatMap((ls) => ls.map((l): Node => [l.from_kind, l.from_id])),
  );

  const owners = [];
  const confirmedConf: number[] = [];
  let pending = 0;
  for (const h of current) {
    const key = `${h.owner_kind}:${h.owner_id}`;
    const i = info.get(key);
    const cs = [];
    for (const link of ctrls.get(key) ?? []) {
      if (link.status === "confirmed") confirmedConf.push(link.confidence);
      else pending += 1;
      cs.push({
        link_id: link.id,
        controller_kind: link.from_kind,
        controller_id: link.from_id,
        controller_label: ctrlLabels.get(`${link.from_kind}:${link.from_id}`)?.label ?? null,
        relationship: link.relationship,
        confidence: link.confidence,
        status: link.status,
      });
    }
    owners.push({
      interest: h,
      mailing_address: contactSensitive ? (i?.mailing_address ?? null) : null,
      mailing_city: i?.city ?? null,
      mailing_state: i?.state ?? null,
      controllers: cs,
    });
  }
  const starts = current.map((h) => h.effective_from).filter((d): d is string => Boolean(d));
  let latest: InterestOut | null = null;
  for (const h of current) if (!latest || (h.effective_from ?? "0001-01-01") > (latest.effective_from ?? "0001-01-01")) latest = h;
  return {
    property_id: prop.id,
    property_state: prop.state,
    current_owners: owners,
    history,
    hold_years: starts.length ? holdYears(starts.reduce((a, b) => (b < a ? b : a))) : null,
    acquired_on: latest?.effective_from ?? null,
    acquired_price: latest?.acquired_price ?? null,
    mismatch: current.some((h) => h.mismatch),
    controlling_confidence: confirmedConf.length ? Math.max(...confirmedConf) : null,
    pending_suggestions: pending,
    masked: !contactSensitive,
  };
}

// ---------------------------------------------------------------- entity links

export interface LinkFilters {
  status?: string[];
  relationship?: string[];
  suggested_by?: string;
  node_id?: string;
  min_confidence?: number;
}

export function buildLinkWhere(f: LinkFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = entityLinks;
  return and(
    isNull(t.deleted_at),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("relationship") ? undefined : inFilter(t.relationship, f.relationship),
    f.suggested_by ? eq(t.suggested_by, f.suggested_by) : undefined,
    f.node_id ? or(eq(t.from_id, f.node_id), eq(t.to_id, f.node_id)) : undefined,
    f.min_confidence !== undefined && f.min_confidence !== null ? sql`${t.confidence} >= ${f.min_confidence}` : undefined,
  );
}

export async function linksOut(db: Db, links: EntityLink[], user: CurrentUser) {
  const show = canSeeSensitive(user);
  const info = await nodeInfo(db, links.flatMap((l): Node[] => [[l.from_kind, l.from_id], [l.to_kind, l.to_id]]));
  return links.map((link) => {
    const [evidence, hidden] = visibleEvidence(link.evidence, show);
    return {
      id: link.id,
      from_kind: link.from_kind,
      from_id: link.from_id,
      to_kind: link.to_kind,
      to_id: link.to_id,
      from_label: info.get(`${link.from_kind}:${link.from_id}`)?.label ?? null,
      to_label: info.get(`${link.to_kind}:${link.to_id}`)?.label ?? null,
      relationship: link.relationship,
      confidence: link.confidence,
      status: link.status,
      evidence,
      hidden_evidence: hidden,
      source: link.source,
      suggested_by: link.suggested_by,
      reviewed_by_id: link.reviewed_by_id,
      reviewed_at: link.reviewed_at,
      review_note: link.review_note,
      effective_from: link.effective_from,
      effective_to: link.effective_to,
      notes: link.notes,
      created_at: link.created_at,
    };
  });
}

export async function getLink(db: Db, linkId: string): Promise<EntityLink> {
  const link = await get(db, entityLinks, linkId);
  if (!link || link.deleted_at) throw new HttpError(404, "Relationship not found");
  return link;
}

async function auditLink(
  db: Db, actor: CurrentUser, link: EntityLink, verb: string, changes?: Record<string, any> | null, summary?: string | null,
): Promise<void> {
  await audit.record(db, {
    actor, action: `entity_link.${verb}`, entity_type: "entity_link", entity_id: link.id, changes, summary,
    ip_address: actor.ip_address,
  });
  for (const [kind, eid] of [[link.from_kind, link.from_id], [link.to_kind, link.to_id]] as const) {
    await audit.record(db, {
      actor, action: `${kind}.relationship_${verb}`, entity_type: kind, entity_id: eid, changes,
      summary: summary || link.relationship, ip_address: actor.ip_address,
    });
  }
}

export async function createLink(db: Db, data: LinkIn, actor: CurrentUser): Promise<EntityLink> {
  const a: Node = [data.from_kind, data.from_id];
  const b: Node = [data.to_kind, data.to_id];
  if (nk(a) === nk(b)) throw new HttpError(422, "A record cannot be linked to itself");
  if (data.from_kind === "person" && data.to_kind === "person" && !["family", "advisor"].includes(data.relationship)) {
    throw new HttpError(422, "Person-to-person links are limited to family or advisor relationships");
  }
  await ensureOwner(db, ...a);
  await ensureOwner(db, ...b);
  const sig = signature(a, b);
  const [dup] = await db
    .select({ id: entityLinks.id })
    .from(entityLinks)
    .where(
      and(
        eq(entityLinks.signature, sig), eq(entityLinks.relationship, data.relationship), isNull(entityLinks.deleted_at),
        ne(entityLinks.status, "rejected"),
      ),
    )
    .limit(1);
  if (dup) throw new HttpError(409, "This relationship already exists");
  const link = await insert(db, entityLinks, {
    from_kind: data.from_kind, from_id: data.from_id, to_kind: data.to_kind, to_id: data.to_id,
    relationship: data.relationship, confidence: data.confidence, evidence: data.evidence.map(evidenceJson),
    source: data.source, suggested_by: "user", signature: sig, status: data.confirmed ? "confirmed" : "suggested",
    reviewed_by_id: data.confirmed ? actor.id : null, reviewed_at: data.confirmed ? utcnow() : null,
    effective_from: data.effective_from, notes: data.notes, created_by_id: actor.id, updated_by_id: actor.id,
  });
  await auditLink(db, actor, link, "added");
  await db.commit();
  return link;
}

export async function updateLink(db: Db, link: EntityLink, data: LinkUpdate, actor: CurrentUser): Promise<EntityLink> {
  const { evidence, ...rest } = data;
  const values = clean(rest);
  if (evidence !== null && evidence !== undefined) {
    const next: any[] = evidence.map(evidenceJson);
    if (!canSeeSensitive(actor)) next.push(...(link.evidence || []).filter((e) => e.sensitive));
    values.evidence = next;
  }
  const changes: Record<string, any> = audit.diff(link, values);
  if (!Object.keys(changes).length) return link;
  await patch(db, entityLinks, link, { ...values, updated_by_id: actor.id } as never);
  if ("evidence" in changes) changes.evidence = "updated";
  await auditLink(db, actor, link, "updated", changes);
  await db.commit();
  return link;
}

export async function reviewLink(
  db: Db, link: EntityLink, decision: "confirmed" | "rejected", data: LinkReviewIn, actor: CurrentUser,
): Promise<EntityLink> {
  if (link.status !== "suggested") throw new HttpError(409, `This relationship is already ${link.status}`);
  const changes: Record<string, any> = { status: { from: link.status, to: decision } };
  const set: Record<string, any> = {};
  if (decision === "confirmed") {
    if (data.reverse) {
      Object.assign(set, { from_kind: link.to_kind, from_id: link.to_id, to_kind: link.from_kind, to_id: link.from_id });
      changes.direction = "reversed";
    }
    if (data.relationship && data.relationship !== link.relationship) {
      changes.relationship = { from: link.relationship, to: data.relationship };
      set.relationship = data.relationship;
    }
  }
  await patch(db, entityLinks, link, {
    ...set, status: decision, reviewed_by_id: actor.id, reviewed_at: utcnow(), review_note: data.note ?? null,
    updated_by_id: actor.id,
  } as never);
  await auditLink(db, actor, link, decision, changes, data.note);
  await events.emit(db, `entity_link.${decision}`, { link_id: link.id, actor });
  await db.commit();
  return link;
}

// ---------------------------------------------------------------- suggestion engine

function combine(evidence: Array<{ type: string }>): number {
  let miss = 1.0;
  for (const t of new Set(evidence.map((e) => e.type))) miss *= 1 - (EVIDENCE_WEIGHTS[t] ?? 0.25);
  return round(1 - miss, 3);
}

/**
 * Propose relationships from shared mailing address / phone / email domain / registered agent.
 * Suggestions land as status 'suggested' for human review; nothing is merged or confirmed automatically.
 */
export async function suggestLinks(db: Db, actor: CurrentUser): Promise<[number, number]> {
  await backfillNormalized(db);
  const groups = new Map<string, { etype: string; value: string; nodes: Map<string, Node> }>();
  const group = (etype: string, value: string, node: Node) => {
    const key = `${etype}\u0000${value}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { etype, value, nodes: new Map() }));
    g.nodes.set(nk(node), node);
    return g;
  };
  const agentPeople = new Map<string, Node[]>();

  const prows = await db
    .select({
      id: people.id, name: people.normalized_name, addr: people.mailing_address, city: people.city, st: people.state,
      postal: people.postal_code, phone: people.primary_phone, email: people.primary_email,
    })
    .from(people)
    .where(isNull(people.deleted_at));
  for (const r of prows) {
    const node: Node = ["person", r.id];
    if (r.addr) group("shared_mailing_address", normalizeAddress(r.addr, r.city, r.st, r.postal), node);
    if (r.phone && normPhone(r.phone)) group("shared_phone", normPhone(r.phone), node);
    const d = emailDomain(r.email);
    if (d && !FREE_EMAIL_DOMAINS.has(d)) group("shared_email_domain", d, node);
    if (r.name) agentPeople.set(r.name, [...(agentPeople.get(r.name) ?? []), node]);
  }

  const orows = await db
    .select({
      id: organizations.id, addr: organizations.mailing_address, city: organizations.city, st: organizations.state,
      postal: organizations.postal_code, phone: organizations.phone, domain: organizations.domain,
      website: organizations.website, agent: organizations.registered_agent,
    })
    .from(organizations)
    .where(isNull(organizations.deleted_at));
  for (const r of orows) {
    const node: Node = ["organization", r.id];
    if (r.addr) group("shared_mailing_address", normalizeAddress(r.addr, r.city, r.st, r.postal), node);
    if (r.phone && normPhone(r.phone)) group("shared_phone", normPhone(r.phone), node);
    const d = normDomain(r.domain || r.website);
    if (d && !FREE_EMAIL_DOMAINS.has(d)) group("shared_email_domain", d, node);
    if (r.agent && normalizeName(r.agent)) {
      const key = normalizeName(r.agent);
      const g = group("registered_agent", key, node);
      for (const n of agentPeople.get(key) ?? []) g.nodes.set(nk(n), n);
    }
  }

  const crows = await db
    .select({
      kind: contactPoints.kind, value: contactPoints.normalized_value, pid: contactPoints.person_id,
      oid: contactPoints.organization_id,
    })
    .from(contactPoints)
    .where(isNull(contactPoints.deleted_at));
  for (const r of crows) {
    if (!r.pid && !r.oid) continue;
    const node: Node = r.pid ? ["person", r.pid] : ["organization", r.oid as string];
    if (r.kind === "phone" && r.value) group("shared_phone", r.value, node);
    else if (r.kind === "email") {
      const d = emailDomain(r.value);
      if (d && !FREE_EMAIL_DOMAINS.has(d)) group("shared_email_domain", d, node);
    }
  }

  const day = today();
  const pairs = new Map<string, { a: Node; b: Node; evidence: any[] }>();
  for (const { etype, value, nodes } of groups.values()) {
    if (nodes.size < 2 || nodes.size > MAX_GROUP) continue;
    const sorted = [...nodes.values()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (a[0] === "person" && b[0] === "person") continue; // person<->person ties (family) are never inferred automatically
        const key = `${nk(a)}||${nk(b)}`;
        const p = pairs.get(key) ?? { a, b, evidence: [] };
        p.evidence.push({ type: etype, detail: value, source: "Suggestion engine", observed_on: day, sensitive: false });
        pairs.set(key, p);
      }
    }
  }
  if (!pairs.size) return [0, 0];

  const affiliated = new Set<string>();
  for (const r of await db
    .select({ p: affiliations.person_id, o: affiliations.organization_id })
    .from(affiliations)
    .where(isNull(affiliations.deleted_at))) {
    affiliated.add(`organization:${r.o}||person:${r.p}`);
  }
  const existing = new Map<string, EntityLink[]>();
  for (const link of await db.select().from(entityLinks).where(isNull(entityLinks.deleted_at))) {
    existing.set(link.signature, [...(existing.get(link.signature) ?? []), link]);
  }

  let created = 0;
  let updated = 0;
  for (const { a, b, evidence } of pairs.values()) {
    if (affiliated.has(`${nk(a)}||${nk(b)}`) || affiliated.has(`${nk(b)}||${nk(a)}`)) continue;
    const sig = signature(a, b);
    const prior = existing.get(sig) ?? [];
    if (prior.some((l) => l.status === "confirmed" || l.status === "rejected")) continue;
    const person = a[0] === "person" ? a : b[0] === "person" ? b : null;
    const isAgent = person !== null && evidence.some((e) => e.type === "registered_agent");
    const relationship = isAgent ? "registered_agent" : "affiliate";
    const [frm, to] = person ? [person, nk(person) === nk(a) ? b : a] : [a, b];
    const conf = isAgent ? 0.6 : combine(evidence);
    const openLink = prior.find((l) => l.status === "suggested");
    if (openLink) {
      if (openLink.suggested_by === "engine") {
        await patch(db, entityLinks, openLink, { evidence, confidence: conf });
        updated += 1;
      }
      continue;
    }
    await insert(db, entityLinks, {
      from_kind: frm[0], from_id: frm[1], to_kind: to[0], to_id: to[1], relationship, confidence: conf,
      status: "suggested", evidence, source: "Suggestion engine", suggested_by: "engine", signature: sig,
      created_by_id: actor.id, updated_by_id: actor.id,
    });
    created += 1;
  }
  await audit.record(db, {
    actor, action: "entity_link.suggestions_run", entity_type: "entity_link", summary: `${created} new, ${updated} refreshed`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return [created, updated];
}

// ---------------------------------------------------------------- owner notes

export function noteOut(n: OwnerNote) {
  return {
    id: n.id,
    owner_kind: n.owner_kind,
    owner_id: n.owner_id,
    category: n.category,
    body: n.body,
    sensitive: n.sensitive,
    source: n.source,
    observed_on: n.observed_on,
    created_at: n.created_at,
    created_by_id: n.created_by_id,
  };
}

export async function notesFor(db: Db, kind: string, ownerId: string, user: CurrentUser): Promise<[OwnerNote[], number]> {
  const rows = await db
    .select()
    .from(ownerNotes)
    .where(and(eq(ownerNotes.owner_kind, kind), eq(ownerNotes.owner_id, ownerId), isNull(ownerNotes.deleted_at)))
    .orderBy(desc(ownerNotes.created_at));
  if (canSeeSensitive(user)) return [rows, 0];
  const shown = rows.filter((n) => !n.sensitive);
  return [shown, rows.length - shown.length];
}

export async function addNote(db: Db, kind: string, ownerId: string, data: NoteIn, actor: CurrentUser): Promise<OwnerNote> {
  await ensureOwner(db, kind, ownerId);
  const note = await insert(db, ownerNotes, {
    owner_kind: kind, owner_id: ownerId, ...data, created_by_id: actor.id, updated_by_id: actor.id,
  });
  // The audit trail never carries the text of a sensitive note.
  await audit.record(db, {
    actor, action: `${kind}.owner_note_added`, entity_type: kind, entity_id: ownerId,
    summary: `${data.category.replace(/_/g, " ")} note${data.sensitive ? " (sensitive)" : ""}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return note;
}

export async function removeNote(db: Db, noteId: string, actor: CurrentUser): Promise<void> {
  const note = await get(db, ownerNotes, noteId);
  if (!note || note.deleted_at) throw new HttpError(404, "Note not found");
  if (note.sensitive && !canSeeSensitive(actor)) throw new HttpError(403, "Missing permission ownership:view_sensitive");
  await patch(db, ownerNotes, note, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: `${note.owner_kind}.owner_note_removed`, entity_type: note.owner_kind, entity_id: note.owner_id,
    summary: `${note.category.replace(/_/g, " ")} note`, ip_address: actor.ip_address,
  });
  await db.commit();
}

// ---------------------------------------------------------------- owner portfolio / profile

interface PortfolioItem {
  interest_id: string;
  property_id: string;
  property_label: string;
  city: string | null;
  state: string | null;
  property_type: string | null;
  role: string;
  interest_pct: number | null;
  effective_from: string | null;
  effective_to: string | null;
  acquired_price: number | null;
  disposed_price: number | null;
  financing_type: string | null;
  hold_years: number | null;
  is_current: boolean;
  verification: string;
  via_label: string | null;
  via_kind: string | null;
  via_id: string | null;
}

async function portfolio(db: Db, owners: Node[]): Promise<Array<[Node, PortfolioItem]>> {
  if (!owners.length) return [];
  const pids = owners.filter(([k]) => k === "person").map(([, i]) => i);
  const oids = owners.filter(([k]) => k === "organization").map(([, i]) => i);
  const ownerConds: SQL[] = [];
  if (pids.length) ownerConds.push(inArray(oi.owner_person_id, pids));
  if (oids.length) ownerConds.push(inArray(oi.owner_organization_id, oids));
  if (!ownerConds.length) return [];
  const rows = await db
    .select({
      oi,
      pid: properties.id, pname: properties.name, paddr: properties.address_line, pcity: properties.city,
      pstate: properties.state, ptype: properties.property_type,
    })
    .from(oi)
    .innerJoin(properties, eq(properties.id, oi.property_id))
    .where(
      and(isNull(oi.deleted_at), isNull(properties.deleted_at), ne(oi.verification, "rejected"), or(...ownerConds)),
    )
    .orderBy(sql`${oi.effective_from} desc nulls last`);
  return rows.map((r): [Node, PortfolioItem] => {
    const cur = isCurrent(r.oi);
    return [
      [r.oi.owner_kind, ownerIdOf(r.oi) as string],
      {
        interest_id: r.oi.id,
        property_id: r.pid,
        property_label: (r.pname || r.paddr) as string,
        city: r.pcity,
        state: r.pstate,
        property_type: r.ptype,
        role: r.oi.role,
        interest_pct: r.oi.interest_pct,
        effective_from: r.oi.effective_from,
        effective_to: r.oi.effective_to,
        acquired_price: r.oi.acquired_price,
        disposed_price: r.oi.disposed_price,
        financing_type: r.oi.financing_type,
        hold_years: holdYears(r.oi.effective_from, cur ? null : r.oi.effective_to),
        is_current: cur,
        verification: r.oi.verification,
        via_label: null,
        via_kind: null,
        via_id: null,
      },
    ];
  });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export async function ownerProfile(db: Db, kind: string, ownerId: string, user: CurrentUser) {
  const node: Node = [kind, ownerId];
  const info = (await nodeInfo(db, [node])).get(nk(node));
  if (!info || info.deleted) throw new HttpError(404, `${title(kind)} not found`);

  const own = (await portfolio(db, [node])).map(([, item]) => item);
  const current = own.filter((i) => i.is_current);
  const prior = own.filter((i) => !i.is_current);

  const linkRows = await db
    .select()
    .from(entityLinks)
    .where(
      and(
        isNull(entityLinks.deleted_at), ne(entityLinks.status, "rejected"),
        or(eq(entityLinks.from_id, ownerId), eq(entityLinks.to_id, ownerId)),
      ),
    )
    .orderBy(asc(entityLinks.status), desc(entityLinks.confidence));
  const day = today();
  const controlledNodes = linkRows
    .filter(
      (l) =>
        l.status === "confirmed" && l.from_id === ownerId && CONTROL_RELATIONSHIPS.has(l.relationship) &&
        (l.effective_to === null || l.effective_to > day),
    )
    .map((l): Node => [l.to_kind, l.to_id]);
  const controlledInfo = await nodeInfo(db, controlledNodes);
  const controlled: PortfolioItem[] = [];
  for (const [via, item] of await portfolio(db, controlledNodes)) {
    if (item.is_current) {
      item.via_kind = via[0];
      item.via_id = via[1];
      item.via_label = controlledInfo.get(nk(via))?.label ?? null;
      controlled.push(item);
    }
  }

  const completed = prior.map((i) => i.hold_years).filter((h): h is number => h !== null);
  const running = current.map((i) => i.hold_years).filter((h): h is number => h !== null);
  const financing: Record<string, number> = {};
  for (const i of own) {
    const k = i.financing_type || "unknown";
    financing[k] = (financing[k] ?? 0) + 1;
  }
  const acquired = own.map((i) => i.acquired_price).filter((p): p is number => p !== null);

  const [notes, hidden] = await notesFor(db, kind, ownerId, user);
  const ctx = await contactContext(db, kind, ownerId);
  const contactSensitive = user.can("contacts", "view_sensitive");
  return {
    kind,
    id: ownerId,
    label: info.label,
    subtitle: info.subtitle ?? null,
    city: info.city ?? null,
    state: info.state ?? null,
    mailing_address: contactSensitive ? (info.mailing_address ?? null) : null,
    masked: !contactSensitive,
    relationship_strength: info.relationship_strength ?? null,
    preferences: info.preferences || {},
    current,
    prior,
    controlled,
    typical_hold_years: completed.length ? round(median(completed), 1) : null,
    average_current_hold_years: running.length ? round(mean(running), 1) : null,
    total_acquired_value: acquired.length ? acquired.reduce((a, b) => a + b, 0) : null,
    financing_patterns: financing,
    links: await linksOut(db, linkRows, user),
    notes: notes.map(noteOut),
    hidden_notes: hidden,
    performance: ctx.metrics,
    opportunities: ctx.opportunities,
    recent_interactions: ctx.interactions.slice(0, 10),
  };
}

/** Merge fields for outbound messaging. Sensitive notes/evidence are never included. */
export async function outboundContext(db: Db, kind: string, ownerId: string) {
  const node: Node = [kind, ownerId];
  const info = (await nodeInfo(db, [node])).get(nk(node));
  if (!info || info.deleted) throw new HttpError(404, `${title(kind)} not found`);
  const items = (await portfolio(db, [node])).map(([, i]) => i).filter((i) => i.is_current);
  const notes = await db
    .select()
    .from(ownerNotes)
    .where(
      and(
        eq(ownerNotes.owner_kind, kind), eq(ownerNotes.owner_id, ownerId), isNull(ownerNotes.deleted_at),
        eq(ownerNotes.sensitive, false), inArray(ownerNotes.category, ["preference", "hold_strategy", "financing"]),
      ),
    );
  return {
    owner_name: info.label,
    properties: items.map((i) => ({
      property_id: String(i.property_id), label: i.property_label, city: i.city, state: i.state,
      owned_since: i.effective_from ?? null, hold_years: i.hold_years,
    })),
    notes: notes.map((n) => ({ category: n.category, body: n.body })),
  };
}

// ---------------------------------------------------------------- warm introduction paths

async function neighbors(db: Db, frontier: Node[]): Promise<Map<string, Array<[Node, string]>>> {
  const out = new Map<string, Array<[Node, string]>>();
  const push = (from: Node, to: Node, rel: string) => out.set(nk(from), [...(out.get(nk(from)) ?? []), [to, rel]]);
  const inFrontier = new Set(frontier.map(nk));
  const day = today();
  const pids = frontier.filter(([k]) => k === "person").map(([, i]) => i);
  const oids = frontier.filter(([k]) => k === "organization").map(([, i]) => i);
  const propIds = frontier.filter(([k]) => k === "property").map(([, i]) => i);

  if (pids.length || oids.length) {
    const ids = [...pids, ...oids];
    const links = await db
      .select()
      .from(entityLinks)
      .where(
        and(
          isNull(entityLinks.deleted_at), eq(entityLinks.status, "confirmed"),
          or(isNull(entityLinks.effective_to), sql`${entityLinks.effective_to} > ${day}`),
          or(inArray(entityLinks.from_id, ids), inArray(entityLinks.to_id, ids)),
        ),
      );
    for (const link of links) {
      const a: Node = [link.from_kind, link.from_id];
      const b: Node = [link.to_kind, link.to_id];
      const rel = link.relationship.replace(/_/g, " ");
      if (inFrontier.has(nk(a))) push(a, b, rel);
      if (inFrontier.has(nk(b))) push(b, a, rel);
    }
    const affConds: SQL[] = [];
    if (pids.length) affConds.push(inArray(affiliations.person_id, pids));
    if (oids.length) affConds.push(inArray(affiliations.organization_id, oids));
    for (const aff of await db.select().from(affiliations).where(and(isNull(affiliations.deleted_at), or(...affConds)))) {
      const p: Node = ["person", aff.person_id];
      const o: Node = ["organization", aff.organization_id];
      const rel = aff.role.replace(/_/g, " ") + (aff.is_current ? "" : " (former)");
      if (inFrontier.has(nk(p))) push(p, o, rel);
      if (inFrontier.has(nk(o))) push(o, p, rel);
    }
  }
  const conds: SQL[] = [];
  if (pids.length) conds.push(inArray(oi.owner_person_id, pids));
  if (oids.length) conds.push(inArray(oi.owner_organization_id, oids));
  if (propIds.length) conds.push(inArray(oi.property_id, propIds));
  if (conds.length) {
    const rows = await db
      .select()
      .from(oi)
      .where(and(isNull(oi.deleted_at), ne(oi.verification, "rejected"), or(...conds)));
    for (const i of rows) {
      const owner: Node = [i.owner_kind, ownerIdOf(i) as string];
      const prop: Node = ["property", i.property_id];
      const rel = isCurrent(i, day) ? "owner" : "former owner";
      if (inFrontier.has(nk(owner))) push(owner, prop, rel);
      if (inFrontier.has(nk(prop))) push(prop, owner, rel);
    }
  }
  return out;
}

function warmReason(info: NodeInfo): string | null {
  if (info.relationship_strength === "moderate" || info.relationship_strength === "strong") {
    return `${title(info.relationship_strength)} relationship`;
  }
  if (info.last_touch_at) return `Last touched ${info.last_touch_at.toISOString().slice(0, 10)}`;
  return null;
}

/** BFS outward from the target over confirmed links, affiliations and shared ownership. */
export async function warmPaths(db: Db, target: Node, start: Node | null = null, maxDepth = 3, limit = 5) {
  if (start && nk(start) === nk(target)) return [];
  const parent = new Map<string, { node: Node; rel: string } | null>([[nk(target), null]]);
  const nodes = new Map<string, Node>([[nk(target), target]]);
  let frontier: Node[] = [target];
  const found: Array<[Node, string | null]> = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    const nbrs = await neighbors(db, frontier);
    const nxt: Node[] = [];
    for (const node of frontier) {
      for (const [nb, rel] of nbrs.get(nk(node)) ?? []) {
        if (nb[1] === null || nb[1] === undefined || parent.has(nk(nb))) continue;
        parent.set(nk(nb), { node, rel });
        nodes.set(nk(nb), nb);
        nxt.push(nb);
      }
    }
    if (!nxt.length) break;
    if (start) {
      if (nxt.some((n) => nk(n) === nk(start))) {
        found.push([start, null]);
        break;
      }
    } else {
      const info = await nodeInfo(db, nxt.filter((n) => n[0] !== "property"));
      const warm: Array<[Node, string | null]> = [];
      for (const [key, i] of info) {
        const reason = warmReason(i);
        if (!i.deleted && reason) warm.push([nodes.get(key) as Node, reason]);
      }
      warm.sort((a, b) => {
        const ka = [a[1]?.includes("Strong") ? 0 : 1, a[1] ?? ""] as const;
        const kb = [b[1]?.includes("Strong") ? 0 : 1, b[1] ?? ""] as const;
        return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
      });
      found.push(...warm.slice(0, limit - found.length));
      if (found.length >= limit) break;
    }
    frontier = nxt;
  }

  const chains: Array<[Array<[Node, string | null]>, string | null]> = [];
  for (const [node, reason] of found) {
    const chain: Array<[Node, string | null]> = [];
    let cur = node;
    for (;;) {
      const step = parent.get(nk(cur)) ?? null;
      if (step === null) {
        chain.push([cur, null]);
        break;
      }
      chain.push([cur, step.rel]);
      cur = step.node;
    }
    chains.push([chain, reason]);
  }
  const labels = await nodeInfo(db, chains.flatMap(([chain]) => chain.map(([n]) => n)));
  return chains.map(([chain, reason]) => ({
    steps: chain.map(([n, rel]) => ({
      kind: n[0], id: n[1], label: labels.get(nk(n))?.label || "Unknown", relation_to_next: rel,
    })),
    length: chain.length - 1,
    start_reason: reason,
  }));
}
