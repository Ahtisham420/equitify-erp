import {
  and, arrayOverlaps, asc, count, countDistinct, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, max,
  ne, notInArray, or, sql, type AnyColumn, type SQL,
} from "drizzle-orm";

import * as audit from "../../common/audit";
import { normalizeName } from "../../common/normalize";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch, raw } from "../../db/orm";
import { checkSend } from "../compliance/service";
import { ownershipInterests } from "../ownership/schema";
import { properties } from "../properties/schema";
import { interactionsRef, opportunitiesRef, tasksRef } from "./refs";
import {
  affiliations, contactDuplicateReviews, contactEnrichments, contactMerges, contactPoints, organizations, people,
  type Affiliation, type ContactEnrichment, type ContactPoint, type DuplicateReview, type MergeRecord, type Organization,
  type Person,
} from "./schema";
import type {
  AffiliationIn, AffiliationUpdate, BulkIn, ContactPointIn, ContactPointUpdate, EnrichmentIn, MergeIn,
  OrganizationCreate, OrganizationUpdate, PersonCreate, PersonUpdate,
} from "./schemas";

export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "msn.com",
  "live.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "protonmail.com", "mail.com",
]);
const WON_STAGES = new Set(["closed", "closed_won", "won", "post_close", "owned"]);
const LOST_STAGES = new Set(["dead", "lost", "closed_lost"]);

const today = () => new Date().toISOString().slice(0, 10);
const clean = (o: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- normalization & masking

export function normEmail(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export function normPhone(v: string | null | undefined): string {
  const digits = (v ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function normPoint(kind: string, value: string): string {
  return kind === "email" ? normEmail(value) : normPhone(value);
}

export function emailDomain(v: string | null | undefined): string | null {
  if (!v || !v.includes("@")) return null;
  return v.slice(v.lastIndexOf("@") + 1).trim().toLowerCase() || null;
}

export function normDomain(v: string | null | undefined): string | null {
  if (!v) return null;
  let s = v.trim().toLowerCase().replace(/^[a-z]+:\/\//, "");
  s = s.split("/")[0].split("?")[0];
  s = s.replace(/^www\./, "");
  return s || null;
}

export function maskEmail(v: string | null | undefined): string | null | undefined {
  if (!v) return v;
  const i = v.indexOf("@");
  const local = i === -1 ? v : v.slice(0, i);
  const dom = i === -1 ? "" : v.slice(i + 1);
  return dom ? `${Array.from(local)[0] ?? ""}•••@${dom}` : "•••";
}

export function maskPhone(v: string | null | undefined): string | null | undefined {
  if (!v) return v;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 4 ? `•••-•••-${digits.slice(-4)}` : "•••";
}

export function maskPoint(kind: string, v: string): string {
  return (kind === "email" ? maskEmail(v) : maskPhone(v)) || "";
}

export function canSensitive(user: CurrentUser): boolean {
  return user.can("contacts", "view_sensitive");
}

export function personName(first?: string | null, last?: string | null, full?: string | null): string {
  if (full && full.trim()) return full.trim();
  return [first ?? "", last ?? ""].filter((p) => p && p.trim()).map((p) => p.trim()).join(" ") || "Unnamed";
}

// ---------------------------------------------------------------- shared lookups

export async function getPerson(db: Db, personId: string): Promise<Person> {
  const p = await get(db, people, personId);
  if (!p || p.deleted_at) throw new HttpError(404, "Person not found");
  return p;
}

export async function getOrg(db: Db, orgId: string): Promise<Organization> {
  const o = await get(db, organizations, orgId);
  if (!o || o.deleted_at) throw new HttpError(404, "Organization not found");
  return o;
}

export async function labels(db: Db, kind: string, ids: Set<string>): Promise<Map<string, string>> {
  if (!ids.size) return new Map();
  const list = [...ids];
  const rows =
    kind === "person"
      ? await db.select({ i: people.id, n: people.full_name }).from(people).where(inArray(people.id, list))
      : await db.select({ i: organizations.id, n: organizations.name }).from(organizations).where(inArray(organizations.id, list));
  return new Map(rows.map((r) => [r.i, r.n]));
}

// ---------------------------------------------------------------- people: query

export interface PeopleFilters {
  q?: string;
  state?: string[];
  relationship_strength?: string[];
  responsiveness?: string[];
  role?: string[];
  organization_id?: string;
  owner_id?: string;
  tag?: string[];
  has_next_action?: boolean;
  overdue?: boolean;
  touched_before?: string;
  ids?: string[];
}

export function buildPeopleWhere(
  f: PeopleFilters,
  o: { sensitive: boolean; skip?: Set<string> },
): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const cols: AnyColumn[] = [people.full_name, people.title, people.city];
  if (o.sensitive) cols.push(people.primary_email, people.primary_phone);
  return and(
    isNull(people.deleted_at),
    applySearch(f.q, cols),
    skip.has("state") ? undefined : inFilter(people.state, f.state),
    skip.has("relationship_strength") ? undefined : inFilter(people.relationship_strength, f.relationship_strength),
    skip.has("responsiveness") ? undefined : inFilter(people.responsiveness, f.responsiveness),
    inFilter(people.id, f.ids),
    f.role?.length && !skip.has("role")
      ? sql`exists (select 1 from ${affiliations} where ${affiliations.person_id} = ${people.id}
          and ${inArray(affiliations.role, f.role)} and ${affiliations.is_current} is true
          and ${affiliations.deleted_at} is null)`
      : undefined,
    f.organization_id
      ? sql`exists (select 1 from ${affiliations} where ${affiliations.person_id} = ${people.id}
          and ${affiliations.organization_id} = ${f.organization_id} and ${affiliations.deleted_at} is null)`
      : undefined,
    f.owner_id ? eq(people.owner_id, f.owner_id) : undefined,
    f.tag?.length ? arrayOverlaps(people.tags, f.tag) : undefined,
    f.has_next_action === true ? isNotNull(people.next_action_at) : undefined,
    f.has_next_action === false ? isNull(people.next_action_at) : undefined,
    f.overdue ? lt(people.next_action_at, utcnow()) : undefined,
    f.touched_before
      ? or(isNull(people.last_touch_at), sql`date(${people.last_touch_at}) < ${f.touched_before}::date`)
      : undefined,
  );
}

export async function roleFacets(db: Db, where: SQL | undefined): Promise<Record<string, number>> {
  const rows = await db
    .select({ role: affiliations.role, n: countDistinct(affiliations.person_id) })
    .from(affiliations)
    .where(
      and(
        inArray(affiliations.person_id, db.select({ id: people.id }).from(people).where(where)),
        eq(affiliations.is_current, true),
        isNull(affiliations.deleted_at),
      ),
    )
    .groupBy(affiliations.role);
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.n)]));
}

export async function peopleItems(db: Db, rows: Person[], user: CurrentUser) {
  const sensitive = canSensitive(user);
  const ids = rows.map((p) => p.id);
  const aff = new Map<string, { roles: string[]; org: string | null }>();
  if (ids.length) {
    const res = await db
      .select({ pid: affiliations.person_id, role: affiliations.role, org: organizations.name })
      .from(affiliations)
      .innerJoin(organizations, eq(organizations.id, affiliations.organization_id))
      .where(and(inArray(affiliations.person_id, ids), eq(affiliations.is_current, true), isNull(affiliations.deleted_at)))
      .orderBy(asc(affiliations.created_at));
    for (const r of res) {
      const cur = aff.get(r.pid) ?? { roles: [], org: null };
      if (!cur.roles.includes(r.role)) cur.roles.push(r.role);
      cur.org = cur.org || r.org;
      aff.set(r.pid, cur);
    }
  }
  return rows.map((p) => {
    const a = aff.get(p.id);
    return {
      id: p.id,
      full_name: p.full_name,
      title: p.title,
      primary_email: sensitive ? p.primary_email : maskEmail(p.primary_email),
      primary_phone: sensitive ? p.primary_phone : maskPhone(p.primary_phone),
      city: p.city,
      state: p.state,
      owner_id: p.owner_id,
      last_touch_at: p.last_touch_at,
      next_action_at: p.next_action_at,
      relationship_strength: p.relationship_strength,
      responsiveness: p.responsiveness,
      tags: p.tags,
      organization_name: a?.org ?? null,
      roles: a?.roles ?? [],
      updated_at: p.updated_at,
      masked: !sensitive,
    };
  });
}

// ---------------------------------------------------------------- contact points

export function pointOut(cp: ContactPoint, sensitive: boolean) {
  return {
    id: cp.id,
    person_id: cp.person_id,
    organization_id: cp.organization_id,
    kind: cp.kind,
    value: sensitive ? cp.value : maskPoint(cp.kind, cp.value),
    label: cp.label,
    phone_type: cp.phone_type,
    is_primary: cp.is_primary,
    source: cp.source,
    observed_on: cp.observed_on,
    masked: !sensitive,
    created_at: cp.created_at,
  };
}

async function points(db: Db, o: { person_id?: string | null; org_id?: string | null }): Promise<ContactPoint[]> {
  return db
    .select()
    .from(contactPoints)
    .where(
      and(
        isNull(contactPoints.deleted_at),
        o.person_id ? eq(contactPoints.person_id, o.person_id) : eq(contactPoints.organization_id, o.org_id as string),
      ),
    )
    .orderBy(desc(contactPoints.is_primary), asc(contactPoints.created_at));
}

/** Keep the denormalized primary email/phone columns in step with contact_points. */
export async function syncPrimary(db: Db, o: { person?: Person | null; org?: Organization | null }): Promise<void> {
  const pts = await points(db, { person_id: o.person?.id, org_id: o.org?.id });
  const email = pts.find((c) => c.kind === "email")?.value ?? null;
  const phone = pts.find((c) => c.kind === "phone")?.value ?? null;
  if (o.person) {
    if (o.person.primary_email !== email || o.person.primary_phone !== phone) {
      await patch(db, people, o.person, { primary_email: email, primary_phone: phone });
    }
  } else if (o.org && phone && o.org.phone !== phone) {
    await patch(db, organizations, o.org, { phone });
  }
}

async function addPoint(
  db: Db,
  data: Pick<ContactPointIn, "kind" | "value" | "is_primary"> & Partial<ContactPointIn>,
  actor: CurrentUser,
  o: { person_id: string | null; org_id: string | null },
): Promise<ContactPoint> {
  const normalized = normPoint(data.kind, data.value);
  if (!normalized) throw new HttpError(422, `Invalid ${data.kind}`);
  const existing = await points(db, { person_id: o.person_id, org_id: o.org_id });
  if (existing.some((c) => c.kind === data.kind && c.normalized_value === normalized)) {
    throw new HttpError(409, `This ${data.kind} is already on the record`);
  }
  const makePrimary = data.is_primary || !existing.some((c) => c.kind === data.kind);
  if (makePrimary) {
    for (const c of existing) if (c.kind === data.kind && c.is_primary) await patch(db, contactPoints, c, { is_primary: false });
  }
  return insert(db, contactPoints, {
    person_id: o.person_id,
    organization_id: o.org_id,
    kind: data.kind,
    value: data.value.trim(),
    normalized_value: normalized,
    label: data.label,
    phone_type: data.kind === "phone" ? data.phone_type || "unknown" : null,
    is_primary: makePrimary,
    source: data.source,
    observed_on: data.observed_on,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
}

export async function addContactPoint(
  db: Db, kind: string, ownerId: string, data: ContactPointIn, actor: CurrentUser,
): Promise<ContactPoint> {
  let cp: ContactPoint;
  if (kind === "person") {
    const owner = await getPerson(db, ownerId);
    cp = await addPoint(db, data, actor, { person_id: owner.id, org_id: null });
    await syncPrimary(db, { person: owner });
  } else {
    const org = await getOrg(db, ownerId);
    cp = await addPoint(db, data, actor, { person_id: null, org_id: org.id });
    await syncPrimary(db, { org });
  }
  await audit.record(db, {
    actor, action: `${kind}.contact_point_added`, entity_type: kind, entity_id: ownerId,
    summary: `${data.kind}: ${maskPoint(data.kind, data.value)}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return cp;
}

async function pointOwner(db: Db, cp: ContactPoint): Promise<["person" | "organization", Person | Organization]> {
  if (cp.person_id) return ["person", await getPerson(db, cp.person_id)];
  return ["organization", await getOrg(db, cp.organization_id as string)];
}

export async function getPoint(db: Db, cpId: string): Promise<ContactPoint> {
  const cp = await get(db, contactPoints, cpId);
  if (!cp || cp.deleted_at) throw new HttpError(404, "Contact point not found");
  return cp;
}

export async function updateContactPoint(
  db: Db, cp: ContactPoint, data: ContactPointUpdate, actor: CurrentUser,
): Promise<ContactPoint> {
  const [kind, owner] = await pointOwner(db, cp);
  const values = clean(data);
  const set: Record<string, any> = {};
  if ("value" in values && values.value) {
    values.value = String(values.value).trim();
    set.normalized_value = normPoint(cp.kind, values.value);
  }
  if (values.is_primary) {
    for (const c of await points(db, { person_id: cp.person_id, org_id: cp.organization_id })) {
      if (c.kind === cp.kind && c.id !== cp.id && c.is_primary) await patch(db, contactPoints, c, { is_primary: false });
    }
  }
  const changes: Record<string, any> = audit.diff(cp, values);
  await patch(db, contactPoints, cp, { ...values, ...set, updated_by_id: actor.id } as never);
  await syncPrimary(db, { person: kind === "person" ? (owner as Person) : null, org: kind === "organization" ? (owner as Organization) : null });
  if ("value" in changes) { // never write raw contact values into the audit trail
    changes.value = { from: maskPoint(cp.kind, String(changes.value.from)), to: maskPoint(cp.kind, cp.value) };
  }
  await audit.record(db, {
    actor, action: `${kind}.contact_point_updated`, entity_type: kind, entity_id: owner.id, changes,
    summary: `${cp.kind}: ${maskPoint(cp.kind, cp.value)}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return cp;
}

export async function removeContactPoint(db: Db, cp: ContactPoint, actor: CurrentUser): Promise<void> {
  const [kind, owner] = await pointOwner(db, cp);
  const wasPrimary = cp.is_primary;
  await patch(db, contactPoints, cp, { deleted_at: utcnow(), updated_by_id: actor.id, ...(wasPrimary ? { is_primary: false } : {}) });
  if (wasPrimary) {
    const nxt = (await points(db, { person_id: cp.person_id, org_id: cp.organization_id })).find(
      (c) => c.kind === cp.kind && c.id !== cp.id,
    );
    if (nxt) await patch(db, contactPoints, nxt, { is_primary: true });
  }
  await syncPrimary(db, { person: kind === "person" ? (owner as Person) : null, org: kind === "organization" ? (owner as Organization) : null });
  await audit.record(db, {
    actor, action: `${kind}.contact_point_removed`, entity_type: kind, entity_id: owner.id,
    summary: `${cp.kind}: ${maskPoint(cp.kind, cp.value)}`, ip_address: actor.ip_address,
  });
  await db.commit();
}

// ---------------------------------------------------------------- affiliations

export function affiliationOut(a: Affiliation, personName: string | null, organizationName: string | null) {
  return {
    id: a.id,
    person_id: a.person_id,
    organization_id: a.organization_id,
    person_name: personName,
    organization_name: organizationName,
    role: a.role,
    title: a.title,
    is_current: a.is_current,
    started_on: a.started_on,
    ended_on: a.ended_on,
    source: a.source,
    notes: a.notes,
  };
}

export async function affiliationsFor(db: Db, o: { person_id?: string | null; org_id?: string | null }) {
  const rows = await db
    .select({ a: affiliations, pname: people.full_name, oname: organizations.name })
    .from(affiliations)
    .innerJoin(people, eq(people.id, affiliations.person_id))
    .innerJoin(organizations, eq(organizations.id, affiliations.organization_id))
    .where(
      and(
        isNull(affiliations.deleted_at), isNull(people.deleted_at), isNull(organizations.deleted_at),
        o.person_id ? eq(affiliations.person_id, o.person_id) : eq(affiliations.organization_id, o.org_id as string),
      ),
    )
    .orderBy(desc(affiliations.is_current), asc(affiliations.created_at));
  return rows.map((r) => affiliationOut(r.a, r.pname, r.oname));
}

export async function createAffiliation(db: Db, data: AffiliationIn, actor: CurrentUser): Promise<Affiliation> {
  const person = await getPerson(db, data.person_id);
  const org = await getOrg(db, data.organization_id);
  const [dup] = await db
    .select({ id: affiliations.id })
    .from(affiliations)
    .where(
      and(
        eq(affiliations.person_id, person.id), eq(affiliations.organization_id, org.id), eq(affiliations.role, data.role),
        eq(affiliations.is_current, true), isNull(affiliations.deleted_at),
      ),
    )
    .limit(1);
  if (dup) throw new HttpError(409, "This person already has a current affiliation with that role");
  const a = await insert(db, affiliations, { ...data, created_by_id: actor.id, updated_by_id: actor.id });
  const summary = `${person.full_name} · ${a.role.replace(/_/g, " ")} · ${org.name}`;
  for (const [kind, eid] of [["person", person.id], ["organization", org.id]] as const) {
    await audit.record(db, {
      actor, action: `${kind}.affiliation_added`, entity_type: kind, entity_id: eid, summary, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return a;
}

export async function updateAffiliation(
  db: Db, affId: string, data: AffiliationUpdate, actor: CurrentUser,
): Promise<Affiliation> {
  const a = await get(db, affiliations, affId);
  if (!a || a.deleted_at) throw new HttpError(404, "Affiliation not found");
  const values = clean(data);
  if (values.is_current === false && !values.ended_on && !a.ended_on) values.ended_on = today();
  const changes = audit.diff(a, values);
  await patch(db, affiliations, a, { ...values, updated_by_id: actor.id } as never);
  if (Object.keys(changes).length) {
    for (const [kind, eid] of [["person", a.person_id], ["organization", a.organization_id]] as const) {
      await audit.record(db, {
        actor, action: `${kind}.affiliation_updated`, entity_type: kind, entity_id: eid, changes, ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return a;
}

// ---------------------------------------------------------------- enrichment

export function enrichmentOut(e: ContactEnrichment) {
  return {
    id: e.id,
    person_id: e.person_id,
    organization_id: e.organization_id,
    provider: e.provider,
    enriched_at: e.enriched_at,
    cost: e.cost,
    reliability: e.reliability,
    fields: e.fields,
    restrictions: e.restrictions,
    notes: e.notes,
    created_by_id: e.created_by_id,
  };
}

export async function enrichments(db: Db, kind: string, eid: string): Promise<ContactEnrichment[]> {
  const col = kind === "person" ? contactEnrichments.person_id : contactEnrichments.organization_id;
  return db
    .select()
    .from(contactEnrichments)
    .where(and(eq(col, eid), isNull(contactEnrichments.deleted_at)))
    .orderBy(desc(contactEnrichments.enriched_at));
}

export async function addEnrichment(
  db: Db, kind: string, eid: string, data: EnrichmentIn, actor: CurrentUser,
): Promise<ContactEnrichment> {
  if (kind === "person") await getPerson(db, eid);
  else await getOrg(db, eid);
  const rec = await insert(db, contactEnrichments, {
    ...data,
    enriched_at: data.enriched_at || utcnow(),
    person_id: kind === "person" ? eid : null,
    organization_id: kind === "organization" ? eid : null,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  const cost =
    data.cost !== null && data.cost !== undefined
      ? ` · $${data.cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "";
  await audit.record(db, {
    actor, action: `${kind}.enriched`, entity_type: kind, entity_id: eid, summary: `${data.provider}${cost}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return rec;
}

// ---------------------------------------------------------------- compliance (inherited from outreach compliance)

export async function complianceFor(db: Db, pts: ContactPoint[], sensitive: boolean) {
  const out = [];
  for (const cp of pts) {
    const [allowed, reasons] = await checkSend(db, { channel: cp.kind, value: cp.value });
    out.push({
      channel: cp.kind,
      value: sensitive ? cp.value : maskPoint(cp.kind, cp.value),
      allowed,
      reasons: [...reasons],
    });
  }
  return out;
}

// ---------------------------------------------------------------- people: CRUD

export async function personOut(db: Db, p: Person, user: CurrentUser) {
  const sensitive = canSensitive(user);
  const pts = await points(db, { person_id: p.id });
  return {
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    full_name: p.full_name,
    title: p.title,
    mailing_address: sensitive ? p.mailing_address : null,
    city: p.city,
    state: p.state,
    postal_code: sensitive ? p.postal_code : null,
    contact_preferences: p.contact_preferences,
    owner_id: p.owner_id,
    next_action: p.next_action,
    next_action_at: p.next_action_at,
    responsiveness: p.responsiveness,
    relationship_strength: p.relationship_strength,
    preferences: p.preferences,
    source: p.source,
    notes: p.notes,
    tags: p.tags,
    primary_email: sensitive ? p.primary_email : maskEmail(p.primary_email),
    primary_phone: sensitive ? p.primary_phone : maskPhone(p.primary_phone),
    last_touch_at: p.last_touch_at,
    contact_points: pts.map((c) => pointOut(c, sensitive)),
    affiliations: await affiliationsFor(db, { person_id: p.id }),
    compliance: await complianceFor(db, pts, sensitive),
    masked: !sensitive,
    merged_into_id: p.merged_into_id,
    created_at: p.created_at,
    updated_at: p.updated_at,
    created_by_id: p.created_by_id,
  };
}

export async function findPersonDuplicates(
  db: Db, normalized: string, emails: string[], phones: string[], exclude?: string,
): Promise<Person[]> {
  const conds: SQL[] = [];
  if (normalized) conds.push(eq(people.normalized_name, normalized));
  const keys = [...emails.filter(Boolean).map(normEmail), ...phones.filter(Boolean).map(normPhone)].filter(Boolean);
  if (keys.length) {
    conds.push(
      inArray(
        people.id,
        db
          .select({ id: contactPoints.person_id })
          .from(contactPoints)
          .where(and(inArray(contactPoints.normalized_value, keys), isNull(contactPoints.deleted_at))) as never,
      ),
    );
  }
  if (!conds.length) return [];
  return db
    .select()
    .from(people)
    .where(and(isNull(people.deleted_at), or(...conds), exclude ? ne(people.id, exclude) : undefined))
    .limit(5);
}

async function enqueuePairs(db: Db, entityType: string, newId: string, others: string[], reason: string): Promise<void> {
  for (const other of others) {
    const [a, b] = [newId, other].sort();
    const [found] = await db
      .select({ id: contactDuplicateReviews.id })
      .from(contactDuplicateReviews)
      .where(
        and(
          eq(contactDuplicateReviews.entity_type, entityType), eq(contactDuplicateReviews.a_id, a),
          eq(contactDuplicateReviews.b_id, b),
        ),
      )
      .limit(1);
    if (!found) {
      await insert(db, contactDuplicateReviews, { entity_type: entityType, a_id: a, b_id: b, reasons: [{ type: reason }], score: 0.6 });
    }
  }
}

export async function createPerson(db: Db, data: PersonCreate, actor: CurrentUser, force = false): Promise<Person> {
  const full = personName(data.first_name, data.last_name, data.full_name);
  const normalized = normalizeName(full);
  const dupes = await findPersonDuplicates(db, normalized, data.emails, data.phones);
  if (dupes.length && !force) {
    throw new HttpError(409, {
      message: "A similar person already exists",
      duplicates: dupes.map((d) => ({ id: d.id, label: d.full_name, sublabel: d.title || d.city })),
    });
  }
  const { emails, phones, full_name: _fn, ...values } = data;
  const p = await insert(db, people, {
    ...values, full_name: full, normalized_name: normalized, created_by_id: actor.id, updated_by_id: actor.id,
  });
  for (const [i, e] of emails.filter((x) => x.trim()).entries()) {
    await addPoint(db, { kind: "email", value: e, is_primary: i === 0, source: data.source }, actor, { person_id: p.id, org_id: null });
  }
  for (const [i, ph] of phones.filter((x) => x.trim()).entries()) {
    await addPoint(db, { kind: "phone", value: ph, is_primary: i === 0, source: data.source }, actor, { person_id: p.id, org_id: null });
  }
  await syncPrimary(db, { person: p });
  if (dupes.length) { // created anyway: the pair goes to the review queue, never auto-merged
    await enqueuePairs(db, "person", p.id, dupes.map((d) => d.id), "created_despite_match");
  }
  await audit.record(db, {
    actor, action: "person.created", entity_type: "person", entity_id: p.id, summary: p.full_name, ip_address: actor.ip_address,
  });
  await events.emit(db, "person.created", { person_id: p.id, actor });
  await db.commit();
  return p;
}

const SENSITIVE_PERSON_FIELDS = new Set(["mailing_address", "postal_code"]);

export async function updatePerson(db: Db, p: Person, data: PersonUpdate, actor: CurrentUser): Promise<Person> {
  const values = clean(data);
  if (!canSensitive(actor)) for (const f of SENSITIVE_PERSON_FIELDS) delete values[f];
  if ("first_name" in values || "last_name" in values || "full_name" in values) {
    values.full_name = personName(
      "first_name" in values ? values.first_name : p.first_name,
      "last_name" in values ? values.last_name : p.last_name,
      "full_name" in values ? values.full_name : null,
    );
    values.normalized_name = normalizeName(values.full_name);
  }
  const changes = audit.diff(p, values);
  if (!Object.keys(changes).length) return p;
  await patch(db, people, p, { ...values, updated_by_id: actor.id } as never);
  const keys = Object.keys(changes);
  const shown = Object.fromEntries(
    Object.entries(changes).filter(([k]) => !SENSITIVE_PERSON_FIELDS.has(k) && k !== "normalized_name"),
  );
  await audit.record(db, {
    actor, action: "person.updated", entity_type: "person", entity_id: p.id,
    changes: { ...shown, ...(keys.some((k) => SENSITIVE_PERSON_FIELDS.has(k)) ? { mailing_address: "changed" } : {}) },
    ip_address: actor.ip_address,
  });
  await events.emit(db, "person.updated", { person_id: p.id, changed: new Set(keys), actor });
  await db.commit();
  return p;
}

export async function archivePerson(db: Db, p: Person, actor: CurrentUser): Promise<void> {
  await patch(db, people, p, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "person.archived", entity_type: "person", entity_id: p.id, summary: p.full_name, ip_address: actor.ip_address,
  });
  await db.commit();
}

// ---------------------------------------------------------------- organizations: query & CRUD

export interface OrgFilters {
  q?: string;
  org_type?: string[];
  state?: string[];
  relationship_strength?: string[];
  owner_id?: string;
  tag?: string[];
  has_next_action?: boolean;
  ids?: string[];
}

export function buildOrgWhere(f: OrgFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = organizations;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name, t.legal_name, t.domain, t.city, t.registered_agent]),
    skip.has("org_type") ? undefined : inFilter(t.org_type, f.org_type),
    skip.has("state") ? undefined : inFilter(t.state, f.state),
    skip.has("relationship_strength") ? undefined : inFilter(t.relationship_strength, f.relationship_strength),
    inFilter(t.id, f.ids),
    f.owner_id ? eq(t.owner_id, f.owner_id) : undefined,
    f.tag?.length ? arrayOverlaps(t.tags, f.tag) : undefined,
    f.has_next_action === true ? isNotNull(t.next_action_at) : undefined,
    f.has_next_action === false ? isNull(t.next_action_at) : undefined,
  );
}

export async function orgItems(db: Db, rows: Organization[], user: CurrentUser) {
  const sensitive = canSensitive(user);
  const ids = rows.map((o) => o.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const res = await db
      .select({ oid: affiliations.organization_id, n: countDistinct(affiliations.person_id) })
      .from(affiliations)
      .where(and(inArray(affiliations.organization_id, ids), eq(affiliations.is_current, true), isNull(affiliations.deleted_at)))
      .groupBy(affiliations.organization_id);
    for (const r of res) counts.set(r.oid, Number(r.n));
  }
  return rows.map((o) => ({
    id: o.id,
    name: o.name,
    legal_name: o.legal_name,
    org_type: o.org_type,
    domain: o.domain,
    phone: sensitive ? o.phone : maskPhone(o.phone),
    city: o.city,
    state: o.state,
    owner_id: o.owner_id,
    last_touch_at: o.last_touch_at,
    next_action_at: o.next_action_at,
    relationship_strength: o.relationship_strength,
    tags: o.tags,
    member_count: counts.get(o.id) ?? 0,
    updated_at: o.updated_at,
    masked: !sensitive,
  }));
}

export async function orgOut(db: Db, o: Organization, user: CurrentUser) {
  const sensitive = canSensitive(user);
  return {
    id: o.id,
    name: o.name,
    legal_name: o.legal_name,
    org_type: o.org_type,
    website: o.website,
    domain: o.domain,
    phone: sensitive ? o.phone : maskPhone(o.phone),
    mailing_address: sensitive ? o.mailing_address : null,
    city: o.city,
    state: o.state,
    postal_code: o.postal_code,
    state_of_formation: o.state_of_formation,
    registered_agent: o.registered_agent,
    owner_id: o.owner_id,
    next_action: o.next_action,
    next_action_at: o.next_action_at,
    responsiveness: o.responsiveness,
    relationship_strength: o.relationship_strength,
    preferences: o.preferences,
    source: o.source,
    notes: o.notes,
    tags: o.tags,
    last_touch_at: o.last_touch_at,
    contact_points: (await points(db, { org_id: o.id })).map((c) => pointOut(c, sensitive)),
    members: await affiliationsFor(db, { org_id: o.id }),
    masked: !sensitive,
    merged_into_id: o.merged_into_id,
    created_at: o.created_at,
    updated_at: o.updated_at,
    created_by_id: o.created_by_id,
  };
}

function orgValues(values: Record<string, any>): Record<string, any> {
  if (values.website && !values.domain) values.domain = normDomain(values.website);
  else if ("domain" in values) values.domain = normDomain(values.domain);
  if ("name" in values && values.name) values.normalized_name = normalizeName(values.name);
  return values;
}

export async function findOrgDuplicates(
  db: Db, normalized: string, domain: string | null | undefined, exclude?: string,
): Promise<Organization[]> {
  const conds: SQL[] = normalized ? [eq(organizations.normalized_name, normalized)] : [];
  if (domain && !FREE_EMAIL_DOMAINS.has(domain)) conds.push(eq(organizations.domain, domain));
  if (!conds.length) return [];
  return db
    .select()
    .from(organizations)
    .where(and(isNull(organizations.deleted_at), or(...conds), exclude ? ne(organizations.id, exclude) : undefined))
    .limit(5);
}

export async function createOrg(db: Db, data: OrganizationCreate, actor: CurrentUser, force = false): Promise<Organization> {
  const values = orgValues(clean(data));
  const dupes = await findOrgDuplicates(db, values.normalized_name, values.domain);
  if (dupes.length && !force) {
    throw new HttpError(409, {
      message: "A similar organization already exists",
      duplicates: dupes.map((d) => ({ id: d.id, label: d.name, sublabel: d.domain || d.city })),
    });
  }
  const o = await insert(db, organizations, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
  if (data.phone) {
    await addPoint(db, { kind: "phone", value: data.phone, is_primary: true, label: "Main", source: data.source }, actor, {
      person_id: null, org_id: o.id,
    });
  }
  if (dupes.length) await enqueuePairs(db, "organization", o.id, dupes.map((d) => d.id), "created_despite_match");
  await audit.record(db, {
    actor, action: "organization.created", entity_type: "organization", entity_id: o.id, summary: o.name,
    ip_address: actor.ip_address,
  });
  await events.emit(db, "organization.created", { organization_id: o.id, actor });
  await db.commit();
  return o;
}

const SENSITIVE_ORG_FIELDS = new Set(["mailing_address", "phone", "postal_code"]);

export async function updateOrg(db: Db, o: Organization, data: OrganizationUpdate, actor: CurrentUser): Promise<Organization> {
  let values = clean(data);
  if (!canSensitive(actor)) for (const f of SENSITIVE_ORG_FIELDS) delete values[f];
  values = orgValues(values);
  const changes = audit.diff(o, values);
  const keys = Object.keys(changes);
  if (!keys.length) return o;
  await patch(db, organizations, o, { ...values, updated_by_id: actor.id } as never);
  const safe: Record<string, any> = Object.fromEntries(
    Object.entries(changes).filter(([k]) => !SENSITIVE_ORG_FIELDS.has(k) && k !== "normalized_name"),
  );
  if (keys.some((k) => SENSITIVE_ORG_FIELDS.has(k))) safe.contact_details = "changed";
  await audit.record(db, {
    actor, action: "organization.updated", entity_type: "organization", entity_id: o.id, changes: safe,
    ip_address: actor.ip_address,
  });
  await events.emit(db, "organization.updated", { organization_id: o.id, changed: new Set(keys), actor });
  await db.commit();
  return o;
}

export async function archiveOrg(db: Db, o: Organization, actor: CurrentUser): Promise<void> {
  await patch(db, organizations, o, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "organization.archived", entity_type: "organization", entity_id: o.id, summary: o.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function bulkUpdate(db: Db, kind: string, data: BulkIn, actor: CurrentUser): Promise<number> {
  const table = (kind === "person" ? people : organizations) as typeof people;
  const rows = await db.select().from(table).where(and(inArray(table.id, data.ids), isNull(table.deleted_at)));
  for (const r of rows) {
    const changes: Record<string, any> = {};
    const set: Record<string, any> = {};
    if (data.owner_id && r.owner_id !== data.owner_id) {
      changes.owner_id = { from: r.owner_id, to: data.owner_id };
      set.owner_id = data.owner_id;
    }
    if (data.relationship_strength && r.relationship_strength !== data.relationship_strength) {
      changes.relationship_strength = { from: r.relationship_strength, to: data.relationship_strength };
      set.relationship_strength = data.relationship_strength;
    }
    if (data.add_tags.length || data.remove_tags.length) {
      const tags = (r.tags ?? []).filter((t) => !data.remove_tags.includes(t));
      for (const t of data.add_tags) if (!tags.includes(t)) tags.push(t);
      if (JSON.stringify(tags) !== JSON.stringify(r.tags)) {
        changes.tags = { from: r.tags, to: tags };
        set.tags = tags;
      }
    }
    if (Object.keys(changes).length) {
      await patch(db, table, r, { ...set, updated_by_id: actor.id });
      await audit.record(db, {
        actor, action: `${kind}.bulk_updated`, entity_type: kind, entity_id: r.id, changes, ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return rows.length;
}

// ---------------------------------------------------------------- portfolio & deal context

async function linkedOrgIds(db: Db, personId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ i: organizations.id, n: organizations.name })
    .from(organizations)
    .innerJoin(affiliations, eq(affiliations.organization_id, organizations.id))
    .where(
      and(
        eq(affiliations.person_id, personId), eq(affiliations.is_current, true), isNull(affiliations.deleted_at),
        isNull(organizations.deleted_at),
      ),
    );
  return new Map(rows.map((r) => [r.i, r.n]));
}

/** Last touch, responsiveness, close rate and deal-flow source attribution for a counterparty. */
export async function relationshipMetrics(db: Db, kind: string, eid: string) {
  const rec = kind === "person" ? await get(db, people, eid) : await get(db, organizations, eid);
  const m = {
    last_touch_at: (rec?.last_touch_at ?? null) as Date | null,
    next_action_at: rec?.next_action_at ?? null,
    interactions: 0,
    meaningful_interactions: 0,
    outbound: 0,
    inbound: 0,
    response_rate: null as number | null,
    opportunities: 0,
    won: 0,
    lost: 0,
    close_rate: null as number | null,
    source_attribution: {} as Record<string, number>,
  };
  const icol = kind === "person" ? interactionsRef.person_id : interactionsRef.organization_id;
  const rows = await db
    .select({
      direction: interactionsRef.direction,
      meaningful: interactionsRef.is_meaningful,
      n: count(),
      last: max(interactionsRef.occurred_at).mapWith(interactionsRef.occurred_at),
    })
    .from(interactionsRef)
    .where(and(eq(icol, eid), isNull(interactionsRef.deleted_at)))
    .groupBy(interactionsRef.direction, interactionsRef.is_meaningful);
  for (const r of rows) {
    const n = Number(r.n);
    m.interactions += n;
    if (r.meaningful) m.meaningful_interactions += n;
    if (r.direction === "outbound") m.outbound += n;
    else if (r.direction === "inbound") m.inbound += n;
    const last = r.last ? new Date(r.last as never) : null;
    if (last && (m.last_touch_at === null || last > m.last_touch_at)) m.last_touch_at = last;
  }
  if (m.outbound) m.response_rate = round(Math.min(1.0, m.inbound / m.outbound), 3);

  const ocol = kind === "person" ? opportunitiesRef.primary_person_id : opportunitiesRef.primary_organization_id;
  const opps = await db
    .select({ stage: opportunitiesRef.stage, source: opportunitiesRef.source })
    .from(opportunitiesRef)
    .where(and(eq(ocol, eid), isNull(opportunitiesRef.deleted_at)));
  for (const o of opps) {
    m.opportunities += 1;
    if (o.stage && WON_STAGES.has(o.stage)) m.won += 1;
    else if (o.stage && LOST_STAGES.has(o.stage)) m.lost += 1;
    const key = o.source || "unknown";
    m.source_attribution[key] = (m.source_attribution[key] ?? 0) + 1;
  }
  if (m.won + m.lost) m.close_rate = round(m.won / (m.won + m.lost), 3);
  return m;
}

export async function context(db: Db, kind: string, eid: string) {
  const via = kind === "person" ? await linkedOrgIds(db, eid) : new Map<string, string>();
  const oi = ownershipInterests;
  let ownerCond: SQL | undefined;
  if (kind === "person") {
    ownerCond = eq(oi.owner_person_id, eid);
    if (via.size) ownerCond = or(ownerCond, inArray(oi.owner_organization_id, [...via.keys()]));
  } else {
    ownerCond = eq(oi.owner_organization_id, eid);
  }
  const t = today();
  const rows = await db
    .select({
      oi,
      pid: properties.id, pname: properties.name, paddr: properties.address_line, pcity: properties.city,
      pstate: properties.state, ptype: properties.property_type,
    })
    .from(oi)
    .innerJoin(properties, eq(properties.id, oi.property_id))
    .where(and(ownerCond, isNull(oi.deleted_at), isNull(properties.deleted_at)))
    .orderBy(sql`${oi.effective_to} is null desc`, sql`${oi.effective_from} desc nulls last`);
  const props = rows.map((r) => {
    const viaId = kind === "person" && r.oi.owner_organization_id ? r.oi.owner_organization_id : null;
    return {
      interest_id: r.oi.id,
      property_id: r.pid,
      property_label: r.pname || r.paddr,
      city: r.pcity,
      state: r.pstate,
      property_type: r.ptype,
      role: r.oi.role,
      interest_pct: r.oi.interest_pct,
      effective_from: r.oi.effective_from,
      effective_to: r.oi.effective_to,
      is_current: r.oi.effective_to === null || r.oi.effective_to > t,
      via_organization_id: viaId,
      via_organization_name: viaId ? (via.get(viaId) ?? null) : null,
    };
  });

  let ocond: SQL | undefined;
  if (kind === "person") {
    ocond = eq(opportunitiesRef.primary_person_id, eid);
    if (via.size) ocond = or(ocond, inArray(opportunitiesRef.primary_organization_id, [...via.keys()]));
  } else {
    ocond = eq(opportunitiesRef.primary_organization_id, eid);
  }
  const opps = (
    await db.select().from(opportunitiesRef).where(and(ocond, isNull(opportunitiesRef.deleted_at))).limit(200)
  ).map((o) => ({
    id: o.id, title: o.title, stage: o.stage, property_id: o.property_id, next_action_at: o.next_action_at, source: o.source,
  }));

  const icol = kind === "person" ? interactionsRef.person_id : interactionsRef.organization_id;
  const inters = (
    await db
      .select()
      .from(interactionsRef)
      .where(and(eq(icol, eid), isNull(interactionsRef.deleted_at)))
      .orderBy(desc(interactionsRef.occurred_at))
      .limit(50)
  ).map((i) => ({
    id: i.id, channel: i.channel, direction: i.direction, occurred_at: i.occurred_at, summary: i.summary,
    disposition: i.disposition, property_id: i.property_id, opportunity_id: i.opportunity_id,
    next_action_at: i.next_action_at, loop_closed: i.loop_closed,
  }));

  const tasks = (
    await db
      .select()
      .from(tasksRef)
      .where(and(eq(tasksRef.related_type, kind), eq(tasksRef.related_id, eid), isNull(tasksRef.deleted_at)))
      .orderBy(sql`${tasksRef.status} in ('done', 'cancelled')`, sql`${tasksRef.due_at} asc nulls last`)
      .limit(50)
  ).map((k) => ({
    id: k.id, title: k.title, status: k.status, priority: k.priority, due_at: k.due_at, assignee_id: k.assignee_id,
  }));

  return { properties: props, opportunities: opps, interactions: inters, tasks, metrics: await relationshipMetrics(db, kind, eid) };
}

// ---------------------------------------------------------------- duplicate review

const WEIGHTS: Record<string, number> = { name: 0.5, email: 0.45, phone: 0.35, domain: 0.4, created_despite_match: 0.6 };

function score(reasons: Array<{ type: string }>): number {
  let miss = 1.0;
  for (const t of new Set(reasons.map((r) => r.type))) miss *= 1 - (WEIGHTS[t] ?? 0.2);
  return round(1 - miss, 3);
}

type Reason = { type: string; value: string };

function pairs(groups: Array<[string, string, string[]]>, acc: Map<string, { a: string; b: string; reasons: Reason[] }>): void {
  for (const [rtype, value, ids] of groups) {
    const uniq = [...new Set(ids.filter(Boolean))].sort();
    if (uniq.length < 2 || uniq.length > 25) continue; // very large groups are shared infrastructure, not duplicates
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = `${uniq[i]}|${uniq[j]}`;
        const e = acc.get(key) ?? { a: uniq[i], b: uniq[j], reasons: [] };
        e.reasons.push({ type: rtype, value });
        acc.set(key, e);
      }
    }
  }
}

/** Records created outside this module (e.g. imports) may lack the normalized name key. */
export async function backfillNormalized(db: Db): Promise<void> {
  for (const p of await db.select().from(people).where(and(isNull(people.deleted_at), eq(people.normalized_name, "")))) {
    await patch(db, people, p, { normalized_name: normalizeName(p.full_name) });
  }
  for (const o of await db
    .select()
    .from(organizations)
    .where(and(isNull(organizations.deleted_at), eq(organizations.normalized_name, "")))) {
    await patch(db, organizations, o, { normalized_name: normalizeName(o.name) });
  }
}

export async function scanDuplicates(db: Db, entityType: string, actor: CurrentUser): Promise<[number, number]> {
  await backfillNormalized(db);
  const acc = new Map<string, { a: string; b: string; reasons: Reason[] }>();
  let scanned: number;
  if (entityType === "person") {
    const [c] = await db.select({ n: count() }).from(people).where(isNull(people.deleted_at));
    scanned = Number(c?.n ?? 0);
    const rows = await db
      .select({ n: people.normalized_name, ids: sql<string[]>`array_agg(${people.id}::text)` })
      .from(people)
      .where(and(isNull(people.deleted_at), ne(people.normalized_name, "")))
      .groupBy(people.normalized_name)
      .having(sql`count(*) > 1`);
    pairs(rows.map((r) => ["name", r.n, r.ids]), acc);
    const cps = await db
      .select({
        k: contactPoints.kind, v: contactPoints.normalized_value,
        ids: sql<string[]>`array_agg(distinct ${contactPoints.person_id}::text)`,
      })
      .from(contactPoints)
      .innerJoin(people, eq(people.id, contactPoints.person_id))
      .where(and(isNull(contactPoints.deleted_at), isNull(people.deleted_at)))
      .groupBy(contactPoints.kind, contactPoints.normalized_value)
      .having(sql`count(distinct ${contactPoints.person_id}) > 1`);
    pairs(cps.map((r) => [r.k, r.v, r.ids]), acc);
  } else {
    const [c] = await db.select({ n: count() }).from(organizations).where(isNull(organizations.deleted_at));
    scanned = Number(c?.n ?? 0);
    const names = await db
      .select({ n: organizations.normalized_name, ids: sql<string[]>`array_agg(${organizations.id}::text)` })
      .from(organizations)
      .where(and(isNull(organizations.deleted_at), ne(organizations.normalized_name, "")))
      .groupBy(organizations.normalized_name)
      .having(sql`count(*) > 1`);
    pairs(names.map((r) => ["name", r.n, r.ids]), acc);
    const domains = await db
      .select({ d: organizations.domain, ids: sql<string[]>`array_agg(${organizations.id}::text)` })
      .from(organizations)
      .where(
        and(
          isNull(organizations.deleted_at), isNotNull(organizations.domain),
          notInArray(organizations.domain, [...FREE_EMAIL_DOMAINS]),
        ),
      )
      .groupBy(organizations.domain)
      .having(sql`count(*) > 1`);
    pairs(domains.map((r) => ["domain", r.d as string, r.ids]), acc);
    const cps = await db
      .select({
        k: contactPoints.kind, v: contactPoints.normalized_value,
        ids: sql<string[]>`array_agg(distinct ${contactPoints.organization_id}::text)`,
      })
      .from(contactPoints)
      .innerJoin(organizations, eq(organizations.id, contactPoints.organization_id))
      .where(and(isNull(contactPoints.deleted_at), isNull(organizations.deleted_at)))
      .groupBy(contactPoints.kind, contactPoints.normalized_value)
      .having(sql`count(distinct ${contactPoints.organization_id}) > 1`);
    pairs(cps.map((r) => [r.k, r.v, r.ids]), acc);
  }

  const existing = new Map<string, DuplicateReview>();
  for (const r of await db.select().from(contactDuplicateReviews).where(eq(contactDuplicateReviews.entity_type, entityType))) {
    existing.set(`${r.a_id}|${r.b_id}`, r);
  }
  let created = 0;
  for (const [key, { a, b, reasons }] of acc) {
    const r = existing.get(key);
    if (!r) {
      await insert(db, contactDuplicateReviews, {
        entity_type: entityType, a_id: a, b_id: b, reasons, score: score(reasons), created_by_id: actor.id,
      });
      created += 1;
    } else if (r.status === "open") {
      await patch(db, contactDuplicateReviews, r, { reasons, score: score(reasons) });
    }
  }
  await audit.record(db, {
    actor, action: "duplicates.scanned", entity_type: entityType, summary: `${created} new candidate pairs`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return [scanned, created];
}

export function duplicateOut(r: DuplicateReview, aLabel: string | null = null, bLabel: string | null = null, reasons?: any[]) {
  return {
    id: r.id,
    entity_type: r.entity_type,
    a_id: r.a_id,
    b_id: r.b_id,
    a_label: aLabel,
    b_label: bLabel,
    reasons: reasons ?? r.reasons,
    score: r.score,
    status: r.status,
    reviewed_at: r.reviewed_at,
    created_at: r.created_at,
  };
}

export async function duplicateQueue(db: Db, entityType: string | undefined, status: string, user: CurrentUser) {
  const rows = await db
    .select()
    .from(contactDuplicateReviews)
    .where(
      and(
        isNull(contactDuplicateReviews.deleted_at), eq(contactDuplicateReviews.status, status),
        entityType ? eq(contactDuplicateReviews.entity_type, entityType) : undefined,
      ),
    )
    .orderBy(desc(contactDuplicateReviews.score), desc(contactDuplicateReviews.created_at))
    .limit(300);
  const idsOf = (kind: string) => new Set(rows.filter((r) => r.entity_type === kind).flatMap((r) => [r.a_id, r.b_id]));
  const names: Record<string, Map<string, string>> = {
    person: await labels(db, "person", idsOf("person")),
    organization: await labels(db, "organization", idsOf("organization")),
  };
  const alive = new Set<string>();
  for (const [kind, table] of [["person", people], ["organization", organizations]] as const) {
    const ids = [...names[kind].keys()];
    if (ids.length) {
      for (const r of await db.select({ id: table.id }).from(table).where(and(inArray(table.id, ids), isNull(table.deleted_at)))) {
        alive.add(r.id);
      }
    }
  }
  const sensitive = canSensitive(user);
  const out = [];
  for (const r of rows) {
    if (status === "open" && !(alive.has(r.a_id) && alive.has(r.b_id))) continue;
    const reasons = sensitive
      ? undefined
      : (r.reasons ?? []).map((x: any) =>
          x.type === "email" || x.type === "phone" ? { ...x, value: maskPoint(x.type, String(x.value ?? "")) } : x,
        );
    out.push(duplicateOut(r, names[r.entity_type]?.get(r.a_id) ?? null, names[r.entity_type]?.get(r.b_id) ?? null, reasons));
  }
  return out;
}

export async function dismissDuplicate(db: Db, reviewId: string, actor: CurrentUser): Promise<DuplicateReview> {
  const r = await get(db, contactDuplicateReviews, reviewId);
  if (!r) throw new HttpError(404, "Review item not found");
  await patch(db, contactDuplicateReviews, r, { status: "dismissed", reviewed_by_id: actor.id, reviewed_at: utcnow() });
  await audit.record(db, {
    actor, action: "duplicates.dismissed", entity_type: r.entity_type, entity_id: r.a_id,
    summary: `Not a duplicate of ${r.b_id}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

// ---------------------------------------------------------------- reversible merge

// [table, fk column, optional [kind column, kind value]] for every row that can point at a person/organization.
type Ref = [string, string, [string, string] | null];
const PERSON_REFS: Ref[] = [
  ["contact_points", "person_id", null], ["affiliations", "person_id", null],
  ["contact_enrichments", "person_id", null], ["ownership_interests", "owner_person_id", null],
  ["opportunities", "primary_person_id", null], ["interactions", "person_id", null],
  ["entity_links", "from_id", ["from_kind", "person"]], ["entity_links", "to_id", ["to_kind", "person"]],
  ["owner_notes", "owner_id", ["owner_kind", "person"]],
];
const ORG_REFS: Ref[] = [
  ["contact_points", "organization_id", null], ["affiliations", "organization_id", null],
  ["contact_enrichments", "organization_id", null], ["ownership_interests", "owner_organization_id", null],
  ["opportunities", "primary_organization_id", null], ["interactions", "organization_id", null],
  ["spaces", "tenant_organization_id", null],
  ["entity_links", "from_id", ["from_kind", "organization"]], ["entity_links", "to_id", ["to_kind", "organization"]],
  ["owner_notes", "owner_id", ["owner_kind", "organization"]],
];
export const MERGEABLE: Record<string, Set<string>> = {
  person: new Set([
    "first_name", "last_name", "full_name", "title", "mailing_address", "city", "state", "postal_code",
    "contact_preferences", "owner_id", "responsiveness", "relationship_strength", "preferences", "notes",
    "tags", "next_action", "next_action_at", "last_touch_at",
  ]),
  organization: new Set([
    "name", "legal_name", "org_type", "website", "domain", "phone", "mailing_address", "city", "state",
    "postal_code", "state_of_formation", "registered_agent", "owner_id", "responsiveness",
    "relationship_strength", "preferences", "notes", "tags", "next_action", "next_action_at", "last_touch_at",
  ]),
};

/** Tables/columns that actually exist (other modules may not be installed), keyed `table.column`. */
async function existingColumns(db: Db, tables: string[]): Promise<Set<string>> {
  const rows = await raw<{ table_name: string; column_name: string }>(
    db,
    sql`select table_name, column_name from information_schema.columns
        where table_schema = current_schema() and table_name in (${sql.join(tables.map((t) => sql`${t}`), sql`, `)})`,
  );
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

async function repoint(db: Db, refs: Ref[], old: string, next: string) {
  const cols = await existingColumns(db, [...new Set(refs.map((r) => r[0]))]);
  const moved: Array<{ table: string; column: string; row_id: string }> = [];
  for (const [table, column, kind] of refs) {
    if (!cols.has(`${table}.id`) || !cols.has(`${table}.${column}`) || (kind && !cols.has(`${table}.${kind[0]}`))) continue;
    const t = sql.identifier(table);
    const found = await raw<{ id: string }>(
      db,
      sql`select id from ${t} where ${sql.identifier(column)} = ${old}::uuid
          ${kind ? sql`and ${sql.identifier(kind[0])} = ${kind[1]}` : sql``}`,
    );
    const ids = found.map((r) => r.id);
    if (!ids.length) continue;
    await db.execute(
      sql`update ${t} set ${sql.identifier(column)} = ${next}::uuid
          where id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`,
    );
    for (const i of ids) moved.push({ table, column, row_id: String(i) });
  }
  return moved;
}

export async function merge(db: Db, data: MergeIn, actor: CurrentUser): Promise<MergeRecord> {
  if (data.survivor_id === data.merged_id) throw new HttpError(400, "Choose two different records");
  const kind = data.entity_type;
  const table = (kind === "person" ? people : organizations) as typeof people;
  const getter = kind === "person" ? getPerson : getOrg;
  const survivor = (await getter(db, data.survivor_id)) as Person;
  const merged = (await getter(db, data.merged_id)) as Person;
  const take = data.take_from_merged.filter((f) => MERGEABLE[kind].has(f));

  const snapshot = audit.toJsonable(merged);
  const survivorBefore: Record<string, any> = {};
  const set: Record<string, any> = {};
  for (const f of take) {
    survivorBefore[f] = audit.toJsonable((survivor as Record<string, any>)[f]);
    set[f] = (merged as Record<string, any>)[f];
  }
  const next = { ...survivor, ...set } as Record<string, any>;
  if (kind === "person" && take.some((f) => ["first_name", "last_name", "full_name"].includes(f))) {
    set.full_name = personName(next.first_name, next.last_name, next.full_name);
    set.normalized_name = normalizeName(set.full_name);
  }
  if (kind === "organization" && take.includes("name")) set.normalized_name = normalizeName(next.name);
  await patch(db, table, survivor, { ...set, updated_by_id: actor.id });

  const repointed = await repoint(db, kind === "person" ? PERSON_REFS : ORG_REFS, merged.id, survivor.id);
  await patch(db, table, merged, { merged_into_id: survivor.id, deleted_at: utcnow(), updated_by_id: actor.id });
  if (kind === "person") await syncPrimary(db, { person: survivor });
  else await syncPrimary(db, { org: survivor as unknown as Organization });

  const rec = await insert(db, contactMerges, {
    entity_type: kind, survivor_id: survivor.id, merged_id: merged.id, snapshot, survivor_before: survivorBefore,
    repointed, review_id: data.review_id, reason: data.reason, merged_at: utcnow(), created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  if (data.review_id) {
    const review = await get(db, contactDuplicateReviews, data.review_id);
    if (review) await patch(db, contactDuplicateReviews, review, { status: "merged", reviewed_by_id: actor.id, reviewed_at: utcnow() });
  }
  const label = (o: any) => (kind === "person" ? o.full_name : o.name);
  await audit.record(db, {
    actor, action: `${kind}.merged`, entity_type: kind, entity_id: survivor.id,
    summary: `Merged ${label(merged)} into this record (${repointed.length} linked rows moved)`,
    changes: { merge_id: rec.id, fields_taken: take }, ip_address: actor.ip_address,
  });
  await audit.record(db, {
    actor, action: `${kind}.merged_away`, entity_type: kind, entity_id: merged.id,
    summary: `Merged into ${label(survivor)}`, changes: { merge_id: rec.id }, ip_address: actor.ip_address,
  });
  await events.emit(db, "contact.merged", { entity_type: kind, survivor_id: survivor.id, merged_id: merged.id, actor });
  await db.commit();
  return rec;
}

/** Turn a JSON snapshot value back into the column's runtime type. */
function fromJson(col: { columnType: string }, value: any): any {
  if (value === null || value === undefined) return null;
  if (col.columnType === "PgTimestamp") return new Date(value);
  return value;
}

export async function unmerge(db: Db, mergeId: string, actor: CurrentUser): Promise<MergeRecord> {
  const rec = await get(db, contactMerges, mergeId);
  if (!rec) throw new HttpError(404, "Merge record not found");
  if (rec.status !== "merged") throw new HttpError(409, "This merge has already been reversed");
  const kind = rec.entity_type;
  const table = (kind === "person" ? people : organizations) as typeof people;
  const merged = await get(db, table, rec.merged_id);
  const survivor = await get(db, table, rec.survivor_id);
  if (!merged || !survivor) throw new HttpError(409, "Records involved in this merge no longer exist");
  if (survivor.deleted_at) throw new HttpError(409, "The surviving record was later merged or archived; reverse that first");

  const cols = await existingColumns(db, [...new Set((rec.repointed ?? []).map((r: any) => r.table as string))]);
  for (const row of rec.repointed ?? []) {
    if (!cols.has(`${row.table}.id`) || !cols.has(`${row.table}.${row.column}`)) continue;
    const col = sql.identifier(row.column);
    await db.execute(
      sql`update ${sql.identifier(row.table)} set ${col} = ${merged.id}::uuid
          where id = ${row.row_id}::uuid and ${col} = ${survivor.id}::uuid`,
    );
  }
  const snapFields = getTableColumns(table) as Record<string, { columnType: string }>;
  const restore: Record<string, any> = {};
  for (const [f, v] of Object.entries(rec.survivor_before ?? {})) {
    if (snapFields[f]) restore[f] = fromJson(snapFields[f], v);
  }
  const after = { ...survivor, ...restore } as Record<string, any>;
  restore.normalized_name = normalizeName(kind === "person" ? after.full_name : after.name);
  await patch(db, table, survivor, { ...restore, updated_by_id: actor.id });
  await patch(db, table, merged, { deleted_at: null, merged_into_id: null, updated_by_id: actor.id });
  if (kind === "person") {
    await syncPrimary(db, { person: survivor });
    await syncPrimary(db, { person: merged });
  } else {
    await syncPrimary(db, { org: survivor as unknown as Organization });
    await syncPrimary(db, { org: merged as unknown as Organization });
  }

  await patch(db, contactMerges, rec, { status: "reversed", reversed_at: utcnow(), reversed_by_id: actor.id });
  if (rec.review_id) {
    const review = await get(db, contactDuplicateReviews, rec.review_id);
    if (review) await patch(db, contactDuplicateReviews, review, { status: "open" });
  }
  for (const [eid, summary] of [[survivor.id, "Merge reversed"], [merged.id, "Restored from merge"]] as const) {
    await audit.record(db, {
      actor, action: `${kind}.unmerged`, entity_type: kind, entity_id: eid, summary, changes: { merge_id: rec.id },
      ip_address: actor.ip_address,
    });
  }
  await events.emit(db, "contact.unmerged", { entity_type: kind, survivor_id: survivor.id, merged_id: merged.id, actor });
  await db.commit();
  return rec;
}

export async function mergeHistory(db: Db, entityType?: string, recordId?: string) {
  const rows = await db
    .select()
    .from(contactMerges)
    .where(
      and(
        entityType ? eq(contactMerges.entity_type, entityType) : undefined,
        recordId ? or(eq(contactMerges.survivor_id, recordId), eq(contactMerges.merged_id, recordId)) : undefined,
      ),
    )
    .orderBy(desc(contactMerges.merged_at))
    .limit(200);
  const out = [];
  for (const kind of ["person", "organization"]) {
    const names = await labels(
      db, kind, new Set(rows.filter((r) => r.entity_type === kind).flatMap((r) => [r.survivor_id, r.merged_id])),
    );
    for (const r of rows) {
      if (r.entity_type !== kind) continue;
      out.push({
        id: r.id,
        entity_type: r.entity_type,
        survivor_id: r.survivor_id,
        merged_id: r.merged_id,
        survivor_label: names.get(r.survivor_id) ?? null,
        merged_label: names.get(r.merged_id) || r.snapshot?.full_name || r.snapshot?.name || null,
        repointed_count: (r.repointed ?? []).length,
        reason: r.reason,
        status: r.status,
        merged_at: r.merged_at,
        created_by_id: r.created_by_id,
        reversed_at: r.reversed_at,
        reversed_by_id: r.reversed_by_id,
      });
    }
  }
  out.sort((a, b) => b.merged_at.getTime() - a.merged_at.getTime());
  return out;
}
