/**
 * Tours, deal rooms & brokerage compliance (spec module 26).
 *
 * - Tours: stops are ordered by nearest-neighbour over property coordinates (haversine).
 *   Feedback creates an owned follow-up task and records the showing on the listing.
 * - Deal rooms: counterparties get explicit grants (folders, expiry, download right). When the room requires an NDA
 *   the grant needs an effective signed NDA, checked again on every access. Every document view/download and every
 *   denial is logged. Internal users need dealroom permission plus brokerage view when the room belongs to a
 *   listing/deal (access follows record permissions).
 * - Compliance: license expirations and disclosure deadlines raise alerts and critical dates; disclosures and
 *   transaction-file items can be blocking. `transactionFileComplete` gates commission release.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, insertMany, patch } from "../../db/orm";
import { users } from "../auth/schema";
import {
  brokerageDeals, engagementAgreements, LIVE_LISTING_STATUSES, listings, marketingItems, repAgreements,
} from "../brokerage/schema";
import { recordShowingFromTour } from "../brokerage/service";
import { organizations, people } from "../contacts/schema";
import { upsertCriticalDate } from "../contracts/service";
import { documentLinks, documents } from "../documents/schema";
import { link, signedUrl } from "../documents/service";
import { properties } from "../properties/schema";
import { getProperty } from "../properties/service";
import { createTask, raiseAlert } from "../tasks/service";
import {
  ACK_REQUIRED_TYPES, AD_CHECKLIST, adReviews, agentLicenses, dealRoomAccess, dealRoomAccessLog, dealRoomFolders,
  dealRooms, disclosures, ndas, offerSubmissions, tourFeedback, tourStops, tours, transactionFileItems,
  transactionFiles,
  type AdReview, type AgentLicense, type DealRoom, type DealRoomAccess, type DealRoomFolder, type Disclosure,
  type Nda, type OfferSubmission, type Tour, type TourFeedback, type TourStop, type TransactionFile,
  type TransactionFileItem,
} from "./schema";
import { stopIn } from "./schemas";

const EARTH_RADIUS_MILES = 3958.7613;
export const DEFAULT_FOLDERS = ["Marketing", "Financials", "Leases", "Due diligence", "Legal & title"];
export const LICENSE_WARN_DAYS = 60;

const DAY_MS = 86_400_000;

type Any = Record<string, any>;
type LabelSpec = Record<string, [string, string]>;

export const today = (): string => utcnow().toISOString().slice(0, 10);
const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(a) - Date.parse(b)) / DAY_MS);
const midnightUtc = (d: string): Date => new Date(`${d}T00:00:00Z`);
const uniq = <T>(a: T[]): T[] => [...new Set(a)];
const blank = (s: string | null | undefined) => !(s ?? "").trim();
/** Python float repr for audit summaries (1.0 not 1). */
const pyFloat = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
export const pick = (row: Any, keys: readonly string[]): Any => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

// ============================================================================ helpers

export async function getOr404<T extends PgTable & { id: any }>(
  db: Db, table: T, id: string, label: string,
): Promise<T["$inferSelect"] & Any> {
  const obj = await get(db, table, id);
  if (!obj || (obj as Any).deleted_at) throw new HttpError(404, `${label} not found`);
  return obj as never;
}

export async function createRow<T extends PgTable & { id: any }>(
  db: Db, table: T, entity: string, values: Any, actor: CurrentUser, summary?: string | null,
): Promise<T["$inferSelect"] & Any> {
  const obj = await insert(db, table, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: `${entity}.created`, entity_type: entity, entity_id: (obj as Any).id, summary, ip_address: actor.ip_address,
  });
  return obj as never;
}

export async function patchRow<T extends PgTable & { id: any }>(
  db: Db, table: T, obj: Any, entity: string, values: Any, actor: CurrentUser,
): Promise<Record<string, { from: any; to: any }>> {
  const changes = audit.diff(obj, values);
  const keys = Object.keys(changes);
  if (keys.length) {
    await patch(db, table, obj as never, { ...Object.fromEntries(keys.map((k) => [k, values[k]])), updated_by_id: actor.id } as never);
    await audit.record(db, {
      actor, action: `${entity}.updated`, entity_type: entity, entity_id: obj.id, changes, ip_address: actor.ip_address,
    });
  }
  return changes;
}

export async function archiveRow<T extends PgTable & { id: any }>(
  db: Db, table: T, obj: Any, entity: string, actor: CurrentUser,
): Promise<void> {
  await patch(db, table, obj as never, { deleted_at: utcnow(), updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: `${entity}.archived`, entity_type: entity, entity_id: obj.id, ip_address: actor.ip_address,
  });
  await db.commit();
}

/** Display labels for linked ids: {id: label}. */
export async function names(db: Db, kind: string, ids: Iterable<string | null | undefined>): Promise<Record<string, string>> {
  const list = uniq([...ids].filter((i): i is string => !!i));
  if (!list.length) return {};
  const out: Record<string, string> = {};
  if (kind === "user") {
    for (const r of await db.select({ id: users.id, n: users.full_name }).from(users).where(inArray(users.id, list))) out[r.id] = r.n;
  } else if (kind === "property") {
    const rows = await db
      .select({ id: properties.id, name: properties.name, address_line: properties.address_line, city: properties.city })
      .from(properties)
      .where(inArray(properties.id, list));
    for (const r of rows) out[r.id] = [r.name || r.address_line, r.city].filter(Boolean).join(", ");
  } else if (kind === "person") {
    for (const r of await db.select({ id: people.id, n: people.full_name }).from(people).where(inArray(people.id, list))) out[r.id] = r.n;
  } else if (kind === "organization") {
    for (const r of await db.select({ id: organizations.id, n: organizations.name }).from(organizations).where(inArray(organizations.id, list))) {
      out[r.id] = r.n;
    }
  }
  return out;
}

/** Resolve display labels for linked ids: spec = {id_attr: [kind, label_attr]}; first non-empty label wins. */
export async function enrich<T extends Any>(db: Db, items: T[], spec: LabelSpec): Promise<T[]> {
  const wanted: Record<string, Set<string>> = {};
  for (const it of items) {
    for (const [attr, [kind]] of Object.entries(spec)) if (it[attr]) (wanted[kind] ??= new Set()).add(it[attr]);
  }
  const resolved: Record<string, Record<string, string>> = {};
  for (const [kind, ids] of Object.entries(wanted)) resolved[kind] = await names(db, kind, ids);
  for (const it of items) {
    for (const [attr, [kind, label]] of Object.entries(spec)) {
      const v = it[attr];
      if (v && !(it as Any)[label]) (it as Any)[label] = resolved[kind]?.[v] ?? null;
    }
  }
  return items;
}

/** The four display-label fields every `Labels` out-model carries. */
export const labels = () => ({ property_label: null, agent_name: null, person_label: null, organization_label: null }) as Any;

async function linkDocument(db: Db, documentId: string | null | undefined, entityType: string, entityId: string, actor: CurrentUser) {
  if (!documentId) return;
  await link(db, documentId, entityType, entityId, actor);
}

export async function documentRefs(db: Db, ids: Iterable<string | null | undefined>): Promise<Record<string, Any>> {
  const list = uniq([...ids].filter((i): i is string => !!i));
  if (!list.length) return {};
  const rows = await db.select().from(documents).where(inArray(documents.id, list));
  return Object.fromEntries(
    rows.map((d: Any) => [
      d.id, { id: d.id, title: d.title || d.filename, filename: d.filename, doc_class: d.doc_class, mime_type: d.mime_type ?? null },
    ]),
  );
}

// ============================================================================ tours & routing

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dp = p2 - p1;
  const dl = rad(lng2 - lng1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Greedy route: from `start` (or the first located point) always visit the closest unvisited point.
 *  Points without coordinates keep their relative order at the end. */
export function nearestNeighbourOrder<K>(
  points: Array<[K, number | null | undefined, number | null | undefined]>,
  start?: [number, number] | null,
): K[] {
  const located = points.filter(([, la, ln]) => la !== null && la !== undefined && ln !== null && ln !== undefined) as Array<[K, number, number]>;
  const unlocated = points.filter(([, la, ln]) => la === null || la === undefined || ln === null || ln === undefined).map(([k]) => k);
  if (!located.length) return points.map(([k]) => k);
  const remaining = [...located];
  const route: K[] = [];
  let cur: [number, number];
  if (!start) {
    const first = remaining.shift()!;
    route.push(first[0]);
    cur = [first[1], first[2]];
  } else {
    cur = start;
  }
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((r, j) => {
      const d = haversineMiles(cur[0], cur[1], r[1], r[2]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    });
    const [k, la, ln] = remaining.splice(best, 1)[0];
    route.push(k);
    cur = [la, ln];
  }
  return [...route, ...unlocated];
}

interface StopRow {
  stop: TourStop;
  lat: number | null;
  lng: number | null;
  name: string | null;
  addr: string;
  city: string | null;
}

async function stopRows(db: Db, tourId: string): Promise<StopRow[]> {
  const rows = await db
    .select({
      stop: tourStops, lat: properties.latitude, lng: properties.longitude, name: properties.name,
      addr: properties.address_line, city: properties.city,
    })
    .from(tourStops)
    .innerJoin(properties, eq(properties.id, tourStops.property_id))
    .where(and(eq(tourStops.tour_id, tourId), isNull(tourStops.deleted_at)))
    .orderBy(asc(tourStops.sequence), asc(tourStops.created_at));
  return rows as StopRow[];
}

const hasStart = (t: Tour) => t.start_lat !== null && t.start_lat !== undefined && t.start_lng !== null && t.start_lng !== undefined;

/** Renumber the stops, recompute leg distances and the tour total (persisted). */
async function recompute(db: Db, tour: Tour, ordered: StopRow[], extra: Any = {}): Promise<void> {
  let prev: [number, number] | null = hasStart(tour) ? [tour.start_lat!, tour.start_lng!] : null;
  let total = 0;
  for (let i = 0; i < ordered.length; i++) {
    const { stop, lat, lng } = ordered[i];
    const located = lat !== null && lat !== undefined && lng !== null && lng !== undefined;
    let dist: number | null = null;
    if (located && prev !== null) {
      dist = Math.round(haversineMiles(prev[0], prev[1], lat!, lng!) * 100) / 100;
      total += dist;
    }
    if (located) prev = [lat!, lng!];
    if (stop.sequence !== i + 1 || stop.distance_from_prev_miles !== dist) {
      await patch(db, tourStops, stop, { sequence: i + 1, distance_from_prev_miles: dist });
    }
  }
  const rounded = Math.round(total * 100) / 100;
  if (tour.total_distance_miles !== rounded || Object.keys(extra).length) {
    await patch(db, tours, tour, { total_distance_miles: rounded, ...extra });
  }
}

export async function recomputeDistances(db: Db, tour: Tour): Promise<void> {
  await recompute(db, tour, await stopRows(db, tour.id));
}

export async function optimizeRoute(db: Db, tour: Tour, actor: CurrentUser): Promise<number> {
  const rows = await stopRows(db, tour.id);
  const byId = new Map(rows.map((r) => [r.stop.id, r]));
  const start: [number, number] | null = hasStart(tour) ? [tour.start_lat!, tour.start_lng!] : null;
  const order = nearestNeighbourOrder(rows.map((r) => [r.stop.id, r.lat, r.lng] as [string, number | null, number | null]), start);
  await recompute(db, tour, order.map((i) => byId.get(i)!), { optimized_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "tour.route_optimized", entity_type: "tour", entity_id: tour.id,
    summary: `${rows.length} stops, ${pyFloat(tour.total_distance_miles ?? 0)} mi`, ip_address: actor.ip_address,
  });
  return rows.filter((r) => r.lat === null || r.lat === undefined || r.lng === null || r.lng === undefined).length;
}

export async function stopOuts(db: Db, tourId: string) {
  return (await stopRows(db, tourId)).map(({ stop, lat, lng, name, addr, city }) => ({
    ...pick(stop, [
      "id", "tour_id", "property_id", "listing_id", "sequence", "arrive_time", "duration_minutes",
      "distance_from_prev_miles", "status", "access_notes",
    ]),
    property_label: name || addr,
    address: [addr, city].filter(Boolean).join(", "),
    latitude: lat,
    longitude: lng,
    has_location: lat !== null && lat !== undefined && lng !== null && lng !== undefined,
  }));
}

async function liveListing(db: Db, propertyId: string): Promise<string | null> {
  const [r] = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.property_id, propertyId), isNull(listings.deleted_at), inArray(listings.status, [...LIVE_LISTING_STATUSES])))
    .limit(1);
  return r?.id ?? null;
}

export async function addStop(
  db: Db, tour: Tour, data: Any, actor: CurrentUser, { commit = true }: { commit?: boolean } = {},
): Promise<TourStop> {
  const values: Any = { ...data };
  await getProperty(db, values.property_id);
  values.listing_id = values.listing_id || (await liveListing(db, values.property_id));
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tourStops)
    .where(and(eq(tourStops.tour_id, tour.id), isNull(tourStops.deleted_at)));
  const stop = await createRow(db, tourStops, "tour_stop", { ...values, tour_id: tour.id, sequence: Number(n || 0) + 1 }, actor);
  await audit.record(db, { actor, action: "tour.stop_added", entity_type: "tour", entity_id: tour.id, ip_address: actor.ip_address });
  if (commit) {
    await recomputeDistances(db, tour);
    await db.commit();
  }
  return stop;
}

export async function createTour(db: Db, data: Any, actor: CurrentUser): Promise<Tour> {
  const { property_ids, ...rest } = data;
  const values: Any = { ...rest };
  values.agent_id = values.agent_id || actor.id;
  values.participants = audit.toJsonable(values.participants || []);
  if (!values.title) {
    let client: string | undefined;
    for (const [kind, key] of [["organization", "client_organization_id"], ["person", "client_person_id"]]) {
      if (values[key]) {
        client = (await names(db, kind, [values[key]]))[values[key]];
        break;
      }
    }
    values.title = `Tour ${values.scheduled_on}` + (client ? ` · ${client}` : "");
  }
  const tour = await createRow(db, tours, "tour", values, actor, values.title);
  for (const pid of uniq<string>(property_ids || [])) {
    await addStop(db, tour, stopIn.parse({ property_id: pid }), actor, { commit: false });
  }
  if (property_ids?.length) await optimizeRoute(db, tour, actor);
  await db.commit();
  return tour;
}

export async function updateTour(db: Db, tour: Tour, data: Any, actor: CurrentUser): Promise<Tour> {
  const values: Any = Object.fromEntries(
    Object.entries(data).filter(([k, v]) => v !== undefined && !(v === null && ["title", "status", "scheduled_on"].includes(k))),
  );
  if ("participants" in values) values.participants = audit.toJsonable(values.participants || []);
  const changes = await patchRow(db, tours, tour, "tour", values, actor);
  if ("start_lat" in changes || "start_lng" in changes) await recomputeDistances(db, tour);
  await db.commit();
  return tour;
}

export async function updateStop(db: Db, stop: TourStop, data: Any, actor: CurrentUser): Promise<TourStop> {
  const tour = await getOr404(db, tours, stop.tour_id, "Tour");
  const values: Any = Object.fromEntries(
    Object.entries(data).filter(([k, v]) => v !== undefined && !(v === null && ["status", "duration_minutes", "sequence"].includes(k))),
  );
  const newSeq = values.sequence as number | undefined;
  delete values.sequence;
  await patchRow(db, tourStops, stop, "tour_stop", values, actor);
  if (newSeq !== undefined && newSeq !== null) {
    const rows = await stopRows(db, tour.id);
    const others = rows.filter((r) => r.stop.id !== stop.id);
    const mine = rows.find((r) => r.stop.id === stop.id)!;
    const idx = Math.max(0, Math.min(others.length, newSeq - 1));
    await recompute(db, tour, [...others.slice(0, idx), mine, ...others.slice(idx)], { optimized_at: null });
  }
  await db.commit();
  return stop;
}

export async function removeStop(db: Db, stop: TourStop, actor: CurrentUser): Promise<void> {
  const tour = await getOr404(db, tours, stop.tour_id, "Tour");
  await patch(db, tourStops, stop, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, { actor, action: "tour.stop_removed", entity_type: "tour", entity_id: tour.id, ip_address: actor.ip_address });
  await recomputeDistances(db, tour);
  await db.commit();
}

export async function addFeedback(db: Db, tour: Tour, data: Any, actor: CurrentUser): Promise<TourFeedback> {
  const values: Any = { ...data };
  let stop: TourStop | null = null;
  if (values.stop_id) {
    stop = await getOr404(db, tourStops, values.stop_id, "Stop");
    if (stop!.tour_id !== tour.id) throw new HttpError(422, "Stop belongs to another tour");
    values.property_id = values.property_id || stop!.property_id;
    values.listing_id = stop!.listing_id;
  }
  if (!values.property_id) throw new HttpError(422, "Choose the stop or property the feedback is about");
  values.person_id = values.person_id || tour.client_person_id;
  const fb = await createRow(db, tourFeedback, "tour_feedback", { ...values, tour_id: tour.id }, actor);
  if (stop && stop.status === "planned") await patch(db, tourStops, stop, { status: "visited" });

  const plabel = fb.property_id ? (await names(db, "property", [fb.property_id]))[fb.property_id] : undefined;
  let who: string | undefined;
  if (fb.person_id) who = (await names(db, "person", [fb.person_id]))[fb.person_id];
  else if (tour.client_organization_id) who = (await names(db, "organization", [tour.client_organization_id]))[tour.client_organization_id];
  const due = fb.next_action_at || new Date(utcnow().getTime() + 2 * DAY_MS);
  const task = await createTask(db, {
    title: fb.next_action || `Follow up with ${who || "client"} on ${plabel || "toured property"}`,
    assignee_id: tour.agent_id || actor.id,
    due_at: due,
    task_type: "follow_up",
    description: [fb.feedback, fb.objections ? `Objections: ${fb.objections}` : null].filter(Boolean).join("\n") || null,
    related_type: "tour",
    related_id: tour.id,
    related_label: tour.title,
    source: "dealroom.tour_feedback",
    idempotency_key: `dealroom:tour_feedback:${fb.id}`,
    actor_id: actor.id,
  });
  await patch(db, tourFeedback, fb, { follow_up_task_id: task.id });

  const showing = await recordShowingFromTour(db, {
    listing_id: fb.listing_id, property_id: fb.property_id!, tour_id: tour.id, scheduled_at: midnightUtc(tour.scheduled_on),
    person_id: fb.person_id, organization_id: tour.client_organization_id, interest_level: fb.interest_level,
    feedback: fb.feedback, actor,
  });
  await patch(db, tourFeedback, fb, { showing_id: showing.id });
  await db.commit();
  return fb;
}

// ============================================================================ NDAs

export function ndaEffective(n: Nda): boolean {
  return n.status === "signed" && !n.deleted_at && (n.expires_on === null || n.expires_on >= today());
}

export async function ndaOuts(db: Db, rows: Nda[]) {
  const outs = rows.map((r) => ({
    ...pick(r, [
      "counterparty_kind", "person_id", "organization_id", "deal_room_id", "listing_id", "brokerage_deal_id", "status",
      "sent_at", "signed_at", "expires_on", "signer_name", "signer_email", "document_id", "notes",
    ]),
    ...labels(),
    id: r.id,
    is_effective: ndaEffective(r),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  return enrich(db, outs, { person_id: ["person", "person_label"], organization_id: ["organization", "organization_label"] });
}

export async function saveNda(db: Db, data: Any, actor: CurrentUser, n: Nda | null = null): Promise<Nda> {
  let values: Any = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  values = Object.fromEntries(
    Object.entries(values).filter(([k, v]) => !(n !== null && v === null && ["status", "counterparty_kind"].includes(k))),
  );
  const merged: Any = { ...(n ? { person_id: n.person_id, organization_id: n.organization_id } : {}), ...values };
  if (!(merged.person_id || merged.organization_id)) throw new HttpError(422, "An NDA needs a counterparty (person or organization)");
  const st = values.status;
  if (st === "sent" && !values.sent_at && !(n && n.sent_at)) values.sent_at = utcnow();
  if (st === "signed" && !values.signed_at && !(n && n.signed_at)) values.signed_at = utcnow();
  if (values.deal_room_id && !values.listing_id) {
    const room = await get(db, dealRooms, values.deal_room_id);
    if (room) values.listing_id = room.listing_id;
  }
  if (n === null) n = await createRow(db, ndas, "nda", values, actor);
  else await patchRow(db, ndas, n, "nda", values, actor);
  await linkDocument(db, n.document_id, "nda", n.id, actor);
  await db.commit();
  return n;
}

export async function findEffectiveNda(
  db: Db, room: DealRoom, personId: string | null | undefined, organizationId: string | null | undefined,
): Promise<Nda | null> {
  if (!(personId || organizationId)) return null;
  const who: SQL[] = [];
  if (personId) who.push(eq(ndas.person_id, personId));
  if (organizationId) who.push(eq(ndas.organization_id, organizationId));
  const scope: SQL[] = [eq(ndas.deal_room_id, room.id)];
  if (room.listing_id) scope.push(eq(ndas.listing_id, room.listing_id));
  if (room.brokerage_deal_id) scope.push(eq(ndas.brokerage_deal_id, room.brokerage_deal_id));
  const rows = await db
    .select()
    .from(ndas)
    .where(and(isNull(ndas.deleted_at), eq(ndas.status, "signed"), or(...who), or(...scope)))
    .orderBy(sql`${ndas.signed_at} desc nulls last`);
  return rows.find((n) => ndaEffective(n)) ?? null;
}

// ============================================================================ deal rooms: access control

export function canUseRoomInternally(user: CurrentUser, room: DealRoom): boolean {
  if (!user.can("dealroom", "view")) return false;
  if ((room.listing_id || room.brokerage_deal_id) && !user.can("brokerage", "view")) return false;
  return true;
}

export async function internalRoom(db: Db, roomId: string, user: CurrentUser): Promise<DealRoom> {
  const room = await getOr404(db, dealRooms, roomId, "Deal room");
  if (!canUseRoomInternally(user, room)) throw new HttpError(403, "You do not have access to this deal room's record");
  return room;
}

export async function grantProblem(db: Db, room: DealRoom, g: DealRoomAccess): Promise<string | null> {
  if (g.deleted_at || g.status === "revoked") return "Access has been revoked";
  if (g.expires_at && g.expires_at < utcnow()) return "Access has expired";
  if (room.status !== "open") return "This deal room is not open";
  if (room.requires_nda) {
    let nda = g.nda_id ? ((await get(db, ndas, g.nda_id)) ?? null) : null;
    if (!(nda && ndaEffective(nda))) nda = await findEffectiveNda(db, room, g.person_id, g.organization_id);
    if (!nda) return "A signed confidentiality agreement is required";
  }
  return null;
}

/** Active grant for a counterparty user, or 403 (denial is logged). */
export async function portalGrant(db: Db, room: DealRoom, user: CurrentUser): Promise<DealRoomAccess> {
  const grants = await db
    .select()
    .from(dealRoomAccess)
    .where(and(eq(dealRoomAccess.room_id, room.id), eq(dealRoomAccess.user_id, user.id), isNull(dealRoomAccess.deleted_at)))
    .orderBy(desc(dealRoomAccess.created_at));
  let problem = "No access grant for this deal room";
  for (const g of grants) {
    problem = (await grantProblem(db, room, g)) || "";
    if (!problem) {
      await patch(db, dealRoomAccess, g, { last_accessed_at: utcnow() });
      return g;
    }
  }
  await logAccess(db, room, null, user, "denied", { detail: problem, is_internal: false });
  await db.commit();
  throw new HttpError(403, problem);
}

export function folderVisible(folder: DealRoomFolder, grant: DealRoomAccess | null): boolean {
  if (grant === null) return true;
  if (grant.folder_ids && grant.folder_ids.length) return grant.folder_ids.includes(folder.id);
  return !folder.is_restricted;
}

export async function logAccess(
  db: Db, room: DealRoom, grant: DealRoomAccess | null, user: CurrentUser | null, action: string,
  o: { document_id?: string | null; folder_id?: string | null; detail?: string | null; is_internal: boolean },
): Promise<void> {
  await insert(db, dealRoomAccessLog, {
    room_id: room.id, access_id: grant?.id ?? null, folder_id: o.folder_id ?? null, document_id: o.document_id ?? null,
    action, user_id: user?.id ?? null, person_id: grant?.person_id ?? null, organization_id: grant?.organization_id ?? null,
    actor_name: user?.full_name ?? null, is_internal: o.is_internal, detail: o.detail ?? null,
    ip_address: user?.ip_address ?? null,
  });
}

/** Documents uploaded against a folder through the documents module (document_links). */
async function linkedFolderDocs(db: Db, folderIds: string[]): Promise<Record<string, string[]>> {
  if (!folderIds.length) return {};
  const out: Record<string, string[]> = {};
  const rows = await db
    .select({ document_id: documentLinks.document_id, entity_id: documentLinks.entity_id })
    .from(documentLinks)
    .where(and(eq(documentLinks.entity_type, "deal_room_folder"), inArray(documentLinks.entity_id, folderIds)));
  for (const r of rows) (out[r.entity_id] ??= []).push(r.document_id);
  return out;
}

export async function folderOuts(db: Db, room: DealRoom, grant: DealRoomAccess | null = null) {
  const all = await db
    .select()
    .from(dealRoomFolders)
    .where(and(eq(dealRoomFolders.room_id, room.id), isNull(dealRoomFolders.deleted_at)))
    .orderBy(asc(dealRoomFolders.sort_order), asc(dealRoomFolders.name));
  const folders = all.filter((f) => folderVisible(f, grant));
  const linked = await linkedFolderDocs(db, folders.map((f) => f.id));
  const allIds: Record<string, string[]> = {};
  for (const f of folders) allIds[f.id] = uniq([...(f.document_ids || []), ...(linked[f.id] || [])]);
  const refs = await documentRefs(db, Object.values(allIds).flat());
  return folders.map((f) => ({
    id: f.id, room_id: f.room_id, name: f.name, sort_order: f.sort_order, is_restricted: f.is_restricted,
    document_ids: allIds[f.id],
    documents: allIds[f.id].map((d) => ({
      id: d, title: null, filename: null, doc_class: null, mime_type: null, ...(refs[d] ?? {}),
    })),
  }));
}

/** Authorise, log and return a short-lived URL for a document in the room. */
export async function openDocument(
  db: Db, room: DealRoom, documentId: string, action: string, user: CurrentUser, grant: DealRoomAccess | null,
): Promise<string | null> {
  const folders = await folderOuts(db, room, grant);
  const folder = folders.find((f) => f.document_ids.includes(documentId));
  const internal = grant === null;
  let problem: string | null = null;
  if (!folder) problem = "Document is not shared in a folder you can access";
  else if (action === "download" && grant !== null && !grant.can_download) problem = "Download is not permitted for this grant";
  if (problem) {
    await logAccess(db, room, grant, user, "denied", {
      document_id: documentId, folder_id: folder?.id ?? null, detail: problem, is_internal: internal,
    });
    await db.commit();
    throw new HttpError(403, problem);
  }
  await logAccess(db, room, grant, user, action, { document_id: documentId, folder_id: folder!.id, is_internal: internal });
  const url = signedUrl(documentId, 10);
  await db.commit();
  return url;
}

// ============================================================================ deal rooms: CRUD

export async function roomOuts(db: Db, rows: DealRoom[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const grants = new Map(
    (
      await db
        .select({ k: dealRoomAccess.room_id, n: sql<number>`count(*)::int` })
        .from(dealRoomAccess)
        .where(and(inArray(dealRoomAccess.room_id, ids), isNull(dealRoomAccess.deleted_at), eq(dealRoomAccess.status, "active")))
        .groupBy(dealRoomAccess.room_id)
    ).map((r) => [r.k, Number(r.n)]),
  );
  const docs = new Map(
    (
      await db
        .select({ k: dealRoomFolders.room_id, n: sql<number>`sum(coalesce(cardinality(${dealRoomFolders.document_ids}), 0))` })
        .from(dealRoomFolders)
        .where(and(inArray(dealRoomFolders.room_id, ids), isNull(dealRoomFolders.deleted_at)))
        .groupBy(dealRoomFolders.room_id)
    ).map((r) => [r.k, Number(r.n || 0)]),
  );
  const views = new Map(
    (
      await db
        .select({ k: dealRoomAccessLog.room_id, n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${dealRoomAccessLog.at})` })
        .from(dealRoomAccessLog)
        .where(and(inArray(dealRoomAccessLog.room_id, ids), inArray(dealRoomAccessLog.action, ["view", "download"])))
        .groupBy(dealRoomAccessLog.room_id)
    ).map((r) => [r.k, [Number(r.n), r.last ? new Date(r.last) : null] as const]),
  );
  const offers = new Map(
    (
      await db
        .select({ k: offerSubmissions.room_id, n: sql<number>`count(*)::int` })
        .from(offerSubmissions)
        .where(and(inArray(offerSubmissions.room_id, ids), isNull(offerSubmissions.deleted_at)))
        .groupBy(offerSubmissions.room_id)
    ).map((r) => [r.k, Number(r.n)]),
  );
  const outs = rows.map((r) => {
    const [view_count, last_activity_at] = views.get(r.id) ?? [0, null];
    return {
      ...pick(r, [
        "name", "listing_id", "brokerage_deal_id", "property_id", "owner_id", "status", "requires_nda", "allow_offers",
        "offer_deadline", "description",
      ]),
      id: r.id,
      opened_at: r.opened_at,
      closed_at: r.closed_at,
      property_label: null as string | null,
      owner_name: null as string | null,
      grant_count: grants.get(r.id) ?? 0,
      document_count: docs.get(r.id) ?? 0,
      view_count,
      offer_count: offers.get(r.id) ?? 0,
      last_activity_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
  return enrich(db, outs, { property_id: ["property", "property_label"], owner_id: ["user", "owner_name"] });
}

export async function createRoom(db: Db, data: Any, actor: CurrentUser): Promise<DealRoom> {
  const { default_folders, ...rest } = data;
  const values: Any = { ...rest };
  let listing: Any | null = null;
  if (values.listing_id) {
    listing = await getOr404(db, listings, values.listing_id, "Listing");
    values.property_id = values.property_id || listing.property_id;
  }
  if (values.brokerage_deal_id) {
    const deal = await getOr404(db, brokerageDeals, values.brokerage_deal_id, "Deal");
    values.property_id = values.property_id || deal.property_id;
    values.listing_id = values.listing_id || deal.listing_id;
  }
  if ((values.listing_id || values.brokerage_deal_id) && !actor.can("brokerage", "view")) {
    throw new HttpError(403, "Brokerage access is required to open a room for this record");
  }
  if (!values.name) {
    const label = values.property_id ? (await names(db, "property", [values.property_id]))[values.property_id] : undefined;
    values.name = `${label || "Deal"} deal room`;
  }
  values.owner_id = values.owner_id || actor.id;
  if (values.status === "open") values.opened_at = utcnow();
  const room = await createRow(db, dealRooms, "deal_room", values, actor, values.name);
  if (default_folders) {
    await insertMany(
      db, dealRoomFolders,
      DEFAULT_FOLDERS.map((name, i) => ({ room_id: room.id, name, sort_order: i, created_by_id: actor.id, updated_by_id: actor.id })) as never,
    );
  }
  if (listing !== null && !listing.deal_room_id) await patch(db, listings, listing as never, { deal_room_id: room.id } as never);
  await db.commit();
  return room;
}

export async function updateRoom(db: Db, room: DealRoom, data: Any, actor: CurrentUser): Promise<DealRoom> {
  const values: Any = Object.fromEntries(
    Object.entries(data).filter(([k, v]) => v !== undefined && !(v === null && ["name", "status", "requires_nda", "allow_offers"].includes(k))),
  );
  if (values.status === "open" && room.status !== "open") values.opened_at = utcnow();
  if (["closed", "archived"].includes(values.status) && !["closed", "archived"].includes(room.status)) values.closed_at = utcnow();
  await patchRow(db, dealRooms, room, "deal_room", values, actor);
  await db.commit();
  return room;
}

export async function saveFolder(
  db: Db, room: DealRoom, data: Any, actor: CurrentUser, folder: DealRoomFolder | null = null,
): Promise<DealRoomFolder> {
  let values: Any = Object.fromEntries(
    Object.entries(data).filter(([k, v]) => v !== undefined && !(v === null && ["name", "sort_order", "is_restricted"].includes(k))),
  );
  if ("document_ids" in values) values.document_ids = uniq<string>(values.document_ids || []);
  if (folder === null) {
    folder = await createRow(db, dealRoomFolders, "deal_room_folder", { ...values, room_id: room.id }, actor, values.name);
  } else {
    await patchRow(db, dealRoomFolders, folder, "deal_room_folder", values, actor);
  }
  for (const docId of folder.document_ids || []) await linkDocument(db, docId, "deal_room", room.id, actor);
  await db.commit();
  return folder;
}

export async function grantAccess(db: Db, room: DealRoom, data: Any, actor: CurrentUser): Promise<DealRoomAccess> {
  const values: Any = { ...data };
  const kind = values.grantee_kind;
  if (kind === "person" && !values.person_id) throw new HttpError(422, "Choose the person to grant access to");
  if (kind === "organization" && !values.organization_id) throw new HttpError(422, "Choose the organization to grant access to");
  if (kind === "user" && !values.user_id) throw new HttpError(422, "Choose the portal user to grant access to");
  const folderIds = new Set(
    (
      await db
        .select({ id: dealRoomFolders.id })
        .from(dealRoomFolders)
        .where(and(eq(dealRoomFolders.room_id, room.id), isNull(dealRoomFolders.deleted_at)))
    ).map((r) => r.id),
  );
  if ((values.folder_ids || []).some((f: string) => !folderIds.has(f))) throw new HttpError(422, "Folders must belong to this deal room");
  if (room.requires_nda) {
    let nda: Nda | null = null;
    if (values.nda_id) nda = await getOr404(db, ndas, values.nda_id, "NDA");
    if (!(nda && ndaEffective(nda))) nda = await findEffectiveNda(db, room, values.person_id, values.organization_id);
    if (!nda) {
      throw new HttpError(
        422, "This room requires a signed confidentiality agreement from the counterparty before access can be granted",
      );
    }
    values.nda_id = nda.id;
  }
  const g = await createRow(db, dealRoomAccess, "deal_room_access", { ...values, room_id: room.id, status: "active" }, actor);
  await audit.record(db, {
    actor, action: "deal_room.access_granted", entity_type: "deal_room", entity_id: room.id,
    changes: { access_id: { from: null, to: String(g.id) } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return g;
}

export async function revokeAccess(db: Db, g: DealRoomAccess, actor: CurrentUser): Promise<DealRoomAccess> {
  if (g.status === "revoked") return g;
  await patch(db, dealRoomAccess, g, { status: "revoked", revoked_at: utcnow(), revoked_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "deal_room.access_revoked", entity_type: "deal_room", entity_id: g.room_id,
    changes: { access_id: { from: String(g.id), to: null } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return g;
}

export async function accessOuts(db: Db, room: DealRoom, rows: DealRoomAccess[]) {
  const ndaIds = uniq(rows.map((r) => r.nda_id).filter((i): i is string => !!i));
  const ndaMap = new Map<string, Nda>();
  if (rows.length && ndaIds.length) {
    for (const n of await db.select().from(ndas).where(inArray(ndas.id, ndaIds))) ndaMap.set(n.id, n);
  }
  const outs = rows.map((r) => {
    const nda = r.nda_id ? ndaMap.get(r.nda_id) : undefined;
    let effective: string;
    if (r.status === "revoked") effective = "revoked";
    else if (r.expires_at && r.expires_at < utcnow()) effective = "expired";
    else if (room.requires_nda && !(nda && ndaEffective(nda))) effective = "nda_required";
    else effective = "active";
    return {
      ...pick(r, [
        "grantee_kind", "person_id", "organization_id", "user_id", "email", "folder_ids", "can_download",
        "can_submit_offers", "expires_at", "nda_id",
      ]),
      ...labels(),
      id: r.id,
      room_id: r.room_id,
      status: r.status,
      effective_status: effective,
      nda_status: nda ? (ndaEffective(nda) ? "signed" : nda.status) : null,
      revoked_at: r.revoked_at,
      last_accessed_at: r.last_accessed_at,
      user_name: null as string | null,
      created_at: r.created_at,
    };
  });
  return enrich(db, outs, {
    person_id: ["person", "person_label"], organization_id: ["organization", "organization_label"], user_id: ["user", "user_name"],
  });
}

export async function analytics(db: Db, room: DealRoom) {
  const logs = await db
    .select()
    .from(dealRoomAccessLog)
    .where(eq(dealRoomAccessLog.room_id, room.id))
    .orderBy(desc(dealRoomAccessLog.at))
    .limit(5000);
  const refs = await documentRefs(db, logs.map((l) => l.document_id));
  const personNames = await names(db, "person", logs.map((l) => l.person_id));
  const orgNames = await names(db, "organization", logs.map((l) => l.organization_id));
  const lookup = (m: Record<string, string>, id: string | null) => (id ? m[id] : undefined);

  const viewers = new Map<string, Any>();
  const docs = new Map<string, Any>();
  for (const lg of logs) {
    const key = String(lg.access_id || lg.user_id || "unknown");
    const label = lookup(personNames, lg.person_id) || lookup(orgNames, lg.organization_id) || lg.actor_name || "Unknown";
    if (!viewers.has(key)) {
      viewers.set(key, {
        viewer: label, internal: lg.is_internal, views: 0, downloads: 0, denied: 0, documents: new Set<string>(), last_at: lg.at,
      });
    }
    const v = viewers.get(key)!;
    if (lg.action === "view" || lg.action === "download" || lg.action === "denied") {
      v[{ view: "views", download: "downloads", denied: "denied" }[lg.action]] += 1;
    }
    if (lg.document_id && (lg.action === "view" || lg.action === "download")) {
      v.documents.add(lg.document_id);
      if (!docs.has(lg.document_id)) {
        docs.set(lg.document_id, {
          document_id: String(lg.document_id), title: refs[lg.document_id]?.title ?? null, views: 0, downloads: 0,
          viewers: new Set<string>(), last_at: lg.at,
        });
      }
      const d = docs.get(lg.document_id)!;
      d[lg.action === "view" ? "views" : "downloads"] += 1;
      d.viewers.add(key);
    }
  }
  const byViewer: Any[] = [...viewers.values()].map(({ documents, ...rest }) => ({ ...rest, documents: documents.size }));
  const byDocument: Any[] = [...docs.values()].map(({ viewers: vs, ...rest }) => ({ ...rest, unique_viewers: vs.size }));
  const recent = logs.slice(0, 200).map((lg) => {
    let actor_name = lg.actor_name;
    if (!lg.is_internal && (lg.person_id || lg.organization_id)) {
      actor_name = lookup(personNames, lg.person_id) || lookup(orgNames, lg.organization_id) || lg.actor_name;
    }
    return {
      ...pick(lg, ["id", "room_id", "access_id", "folder_id", "document_id"]),
      document_title: lg.document_id ? (refs[lg.document_id]?.title ?? null) : null,
      action: lg.action, user_id: lg.user_id, person_id: lg.person_id, organization_id: lg.organization_id,
      actor_name, is_internal: lg.is_internal, detail: lg.detail, at: lg.at,
    };
  });
  return {
    total_views: logs.filter((l) => l.action === "view").length,
    total_downloads: logs.filter((l) => l.action === "download").length,
    denied: logs.filter((l) => l.action === "denied").length,
    unique_viewers: [...viewers.values()].filter((v) => v.views || v.downloads).length,
    by_viewer: byViewer.sort((a, b) => b.last_at.getTime() - a.last_at.getTime()),
    by_document: byDocument.sort((a, b) => b.views + b.downloads - (a.views + a.downloads)),
    recent,
  };
}

// ============================================================================ offers

export async function submitOffer(
  db: Db, room: DealRoom, data: Any, actor: CurrentUser, grant: DealRoomAccess | null,
): Promise<OfferSubmission> {
  if (!room.allow_offers) throw new HttpError(422, "This deal room is not accepting offers");
  if (grant !== null) {
    if (room.status !== "open") throw new HttpError(422, "This deal room is not open");
    if (!grant.can_submit_offers) throw new HttpError(403, "Offer submission is not permitted for this grant");
    if (room.offer_deadline && room.offer_deadline < utcnow()) throw new HttpError(422, "The offer deadline has passed");
  } else if (room.status === "archived") {
    throw new HttpError(422, "This deal room is archived");
  }
  const values: Any = { ...data };
  if (grant !== null) {
    values.submitter_person_id = grant.person_id || values.submitter_person_id;
    values.submitter_organization_id = grant.organization_id || values.submitter_organization_id;
    values.submitter_name = values.submitter_name || actor.full_name;
    values.submitter_user_id = actor.id;
  }
  if (!(values.submitter_person_id || values.submitter_organization_id || values.submitter_name)) {
    throw new HttpError(422, "Identify who is submitting the offer");
  }
  let version = 1;
  if (values.parent_submission_id) {
    const parent = await getOr404(db, offerSubmissions, values.parent_submission_id, "Offer");
    if (parent.room_id !== room.id) throw new HttpError(422, "The previous offer belongs to another deal room");
    version = parent.version + 1;
  }
  const offer = await createRow(
    db, offerSubmissions, "offer_submission",
    {
      ...values, room_id: room.id, listing_id: room.listing_id, brokerage_deal_id: room.brokerage_deal_id,
      property_id: room.property_id, access_id: grant?.id ?? null, version, status: "submitted", submitted_at: utcnow(),
    },
    actor, `Offer ${Number(values.price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  );
  await logAccess(db, room, grant, actor, "submit_offer", { detail: `Offer v${version}`, is_internal: grant === null });
  await linkDocument(db, offer.document_id, "deal_room", room.id, actor);
  const who = values.submitter_name || values.buyer_entity || "counterparty";
  await createTask(db, {
    title: `Review offer from ${who}`, assignee_id: room.owner_id, task_type: "review", priority: "high",
    due_at: new Date(utcnow().getTime() + DAY_MS), related_type: "deal_room", related_id: room.id, related_label: room.name,
    source: "dealroom.offer_submission", idempotency_key: `dealroom:offer:${offer.id}`, actor_id: actor.id,
  });
  await events.emit(db, "offer_submission.received", {
    offer_submission_id: offer.id, room_id: room.id, listing_id: room.listing_id, actor,
  });
  await db.commit();
  return offer;
}

export async function reviewOffer(
  db: Db, offer: OfferSubmission, newStatus: string, notes: string | null | undefined, actor: CurrentUser,
): Promise<OfferSubmission> {
  if (["accepted", "rejected", "withdrawn"].includes(offer.status) && newStatus !== offer.status) {
    throw new HttpError(409, `This offer is already ${offer.status}`);
  }
  const old = offer.status;
  await patch(db, offerSubmissions, offer, {
    status: newStatus, review_notes: notes !== null && notes !== undefined ? notes : offer.review_notes,
    reviewed_by_id: actor.id, reviewed_at: utcnow(), updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "offer_submission.reviewed", entity_type: "offer_submission", entity_id: offer.id,
    changes: { status: { from: old, to: newStatus } }, summary: notes, ip_address: actor.ip_address,
  });
  if (newStatus === "accepted") {
    await events.emit(db, "offer_submission.accepted", {
      offer_submission_id: offer.id, listing_id: offer.listing_id, brokerage_deal_id: offer.brokerage_deal_id, actor,
    });
  }
  await db.commit();
  return offer;
}

// ============================================================================ licenses

export function licenseAlertLevel(lic: AgentLicense): string | null {
  if (lic.status === "expired" || (lic.expires_on && lic.expires_on < today())) return "expired";
  if (lic.expires_on) {
    const days = daysBetween(lic.expires_on, today());
    if (days <= 14) return "critical";
    if (days <= LICENSE_WARN_DAYS) return "warning";
  }
  return null;
}

export async function licenseOuts(db: Db, rows: AgentLicense[]) {
  const userNames = await names(db, "user", rows.map((r) => r.user_id));
  return rows.map((r) => ({
    ...pick(r, [
      "user_id", "holder_name", "license_type", "license_number", "state", "issued_on", "expires_on", "status",
      "ce_hours_required", "ce_hours_completed", "sponsoring_broker", "document_id", "notes",
    ]),
    id: r.id,
    critical_date_id: r.critical_date_id,
    days_to_expiry: r.expires_on ? daysBetween(r.expires_on, today()) : null,
    alert_level: licenseAlertLevel(r),
    user_name: r.user_id ? (userNames[r.user_id] ?? null) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export async function saveLicense(db: Db, data: Any, actor: CurrentUser, lic: AgentLicense | null = null): Promise<AgentLicense> {
  const values: Any = Object.fromEntries(
    Object.entries(data).filter(
      ([k, v]) =>
        v !== undefined &&
        !(lic !== null && v === null && ["license_type", "license_number", "state", "status", "holder_name"].includes(k)),
    ),
  );
  if (!values.holder_name && lic === null) {
    if (values.user_id) values.holder_name = (await names(db, "user", [values.user_id]))[values.user_id];
    if (!values.holder_name) throw new HttpError(422, "Holder name or user is required");
  }
  if (lic === null) {
    lic = await createRow(db, agentLicenses, "agent_license", values, actor, `${values.state} ${values.license_number}`);
  } else {
    await patchRow(db, agentLicenses, lic, "agent_license", values, actor);
  }
  if (lic.expires_on) {
    const cd = await upsertCriticalDate(db, {
      related_type: "agent_license", related_id: lic.id, date_type: "license_expiration",
      label: `License ${lic.license_number} (${lic.state}) expires`, due_on: lic.expires_on, owner_id: lic.user_id,
      lead_days: LICENSE_WARN_DAYS, is_blocking: false, source: "rule", status: "confirmed", key: "license_expiration", actor,
    });
    const cdId = cd?.id ?? null;
    if ((cdId || lic.critical_date_id) !== lic.critical_date_id) await patch(db, agentLicenses, lic, { critical_date_id: cdId });
  }
  await linkDocument(db, lic.document_id, "agent_license", lic.id, actor);
  await db.commit();
  return lic;
}

/** Expire lapsed licenses and raise alerts for upcoming license / disclosure deadlines (idempotent). */
export async function scanCompliance(db: Db, actor: CurrentUser | null) {
  let licAlerts = 0;
  let expired = 0;
  let discAlerts = 0;
  const licenses = await db
    .select()
    .from(agentLicenses)
    .where(and(isNull(agentLicenses.deleted_at), notInArray(agentLicenses.status, ["inactive"])));
  for (const lic of licenses) {
    const level = licenseAlertLevel(lic);
    if (!level) continue;
    if (level === "expired" && lic.status !== "expired") {
      const old = lic.status;
      await patch(db, agentLicenses, lic, { status: "expired" });
      expired += 1;
      if (actor !== null) {
        await audit.record(db, {
          actor, action: "agent_license.expired", entity_type: "agent_license", entity_id: lic.id,
          changes: { status: { from: old, to: "expired" } }, ip_address: actor.ip_address,
        });
      }
    }
    const days = lic.expires_on ? daysBetween(lic.expires_on, today()) : null;
    const ceGap = (lic.ce_hours_required || 0) - (lic.ce_hours_completed || 0);
    const reason =
      (level === "expired" ? "License has expired" : `License expires in ${days} days`) +
      (ceGap > 0 ? `; ${+ceGap.toPrecision(6)} CE hours outstanding` : "") +
      ". Agents cannot represent clients or be paid on transactions with a lapsed license.";
    await raiseAlert(db, {
      title: `${lic.holder_name}: ${lic.state} license ${lic.license_number}`, reason,
      severity: ({ expired: "critical", critical: "high", warning: "medium" } as Record<string, string>)[level],
      owner_id: lic.user_id, related_type: "agent_license", related_id: lic.id, related_label: lic.holder_name,
      rule_key: "dealroom.license_expiration", due_at: lic.expires_on ? midnightUtc(lic.expires_on) : null,
      idempotency_key: `dealroom:license:${lic.id}:${lic.expires_on ?? "None"}:${level}`,
    });
    await patch(db, agentLicenses, lic, { last_alerted_at: utcnow() });
    licAlerts += 1;
  }

  const horizon = addDays(today(), 3);
  const due = await db
    .select()
    .from(disclosures)
    .where(
      and(
        isNull(disclosures.deleted_at), isNotNull(disclosures.due_on), lte(disclosures.due_on, horizon),
        notInArray(disclosures.status, ["waived", "acknowledged"]),
      ),
    );
  for (const d of due) {
    if (disclosureSatisfied(d)) continue;
    const overdue = d.due_on! < today();
    await raiseAlert(db, {
      title: `Disclosure ${overdue ? "overdue" : "due"}: ${d.title}`,
      reason:
        (overdue ? "Required disclosure was not delivered by its deadline" : `Required disclosure is due ${d.due_on}`) +
        (d.is_blocking ? " and blocks commission release." : "."),
      severity: overdue ? "high" : "medium", owner_id: d.owner_id,
      related_type: d.brokerage_deal_id ? "brokerage_deal" : "disclosure", related_id: d.brokerage_deal_id || d.id,
      related_label: d.title, rule_key: "dealroom.disclosure_deadline",
      idempotency_key: `dealroom:disclosure:${d.id}:${overdue ? "overdue" : "due"}`,
    });
    discAlerts += 1;
  }
  if (actor !== null) {
    await audit.record(db, {
      actor, action: "dealroom.compliance_scanned", entity_type: "dealroom",
      summary: `${licAlerts} license alerts, ${discAlerts} disclosure alerts`, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return { licenses_checked: licenses.length, license_alerts: licAlerts, licenses_expired: expired, disclosure_alerts: discAlerts };
}

// ============================================================================ disclosures

export function disclosureSatisfied(d: Disclosure): boolean {
  if (d.status === "waived") return true;
  if (d.requires_acknowledgement) return d.status === "acknowledged";
  return ["delivered", "acknowledged"].includes(d.status);
}

async function disclosureCriticalDate(db: Db, d: Disclosure, actor: CurrentUser): Promise<void> {
  if (!d.due_on) return;
  const cd = await upsertCriticalDate(db, {
    related_type: "disclosure", related_id: d.id, date_type: "disclosure_due", label: `Disclosure: ${d.title}`,
    due_on: d.due_on, property_id: d.property_id, owner_id: d.owner_id, lead_days: 3, is_blocking: d.is_blocking,
    source: "rule", status: disclosureSatisfied(d) ? "completed" : "confirmed", key: "disclosure_due", actor,
  });
  const cdId = cd?.id ?? null;
  if ((cdId || d.critical_date_id) !== d.critical_date_id) await patch(db, disclosures, d, { critical_date_id: cdId });
}

export async function createDisclosure(db: Db, data: Any, actor: CurrentUser): Promise<Disclosure> {
  const values: Any = { ...data };
  const dtype: string = values.disclosure_type;
  if (values.requires_acknowledgement === null || values.requires_acknowledgement === undefined) {
    values.requires_acknowledgement = ACK_REQUIRED_TYPES.has(dtype);
  }
  if (!values.title) {
    const s = dtype.replace(/_/g, " ");
    values.title = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() + " disclosure";
  }
  if (values.brokerage_deal_id) {
    const deal = await getOr404(db, brokerageDeals, values.brokerage_deal_id, "Deal");
    values.property_id = values.property_id || deal.property_id;
    values.listing_id = values.listing_id || deal.listing_id;
    values.owner_id = values.owner_id || deal.agent_id;
  } else if (values.listing_id) {
    const listing = await getOr404(db, listings, values.listing_id, "Listing");
    values.property_id = values.property_id || listing.property_id;
    values.owner_id = values.owner_id || listing.agent_id;
  }
  values.owner_id = values.owner_id || actor.id;
  const d = await createRow(db, disclosures, "disclosure", { ...values, status: "required" }, actor, values.title);
  await disclosureCriticalDate(db, d, actor);
  await db.commit();
  return d;
}

export async function updateDisclosure(db: Db, d: Disclosure, data: Any, actor: CurrentUser): Promise<Disclosure> {
  const values: Any = Object.fromEntries(
    Object.entries(data).filter(
      ([k, v]) => v !== undefined && !(v === null && ["disclosure_type", "title", "is_blocking", "requires_acknowledgement"].includes(k)),
    ),
  );
  await patchRow(db, disclosures, d, "disclosure", values, actor);
  await disclosureCriticalDate(db, d, actor);
  await db.commit();
  return d;
}

export async function deliverDisclosure(db: Db, d: Disclosure, data: Any, actor: CurrentUser): Promise<Disclosure> {
  const values: Any = data;
  if (!(values.evidence_document_id || (values.evidence_note || "").trim())) {
    throw new HttpError(422, "Delivery evidence (document or note) is required");
  }
  if (d.status === "waived") throw new HttpError(409, "This disclosure was waived");
  await patchRow(db, disclosures, d, "disclosure", {
    delivered_at: values.delivered_at || utcnow(), delivery_method: values.delivery_method,
    evidence_document_id: values.evidence_document_id || d.evidence_document_id,
    evidence_note: values.evidence_note || d.evidence_note,
    status: d.status === "acknowledged" ? "acknowledged" : "delivered",
  }, actor);
  await linkDocument(db, d.evidence_document_id, "disclosure", d.id, actor);
  await disclosureCriticalDate(db, d, actor);
  await db.commit();
  return d;
}

export async function acknowledgeDisclosure(db: Db, d: Disclosure, data: Any, actor: CurrentUser): Promise<Disclosure> {
  const values: Any = data;
  if (d.status === "waived") throw new HttpError(409, "This disclosure was waived");
  if (!d.delivered_at) throw new HttpError(422, "Record delivery (with evidence) before the acknowledgement");
  await patchRow(db, disclosures, d, "disclosure", {
    acknowledged_at: values.acknowledged_at || utcnow(), acknowledged_by_name: values.acknowledged_by_name,
    acknowledgement_document_id: values.acknowledgement_document_id || d.acknowledgement_document_id,
    status: "acknowledged",
  }, actor);
  await linkDocument(db, d.acknowledgement_document_id, "disclosure", d.id, actor);
  await disclosureCriticalDate(db, d, actor);
  await db.commit();
  return d;
}

export async function waiveDisclosure(db: Db, d: Disclosure, reason: string, actor: CurrentUser): Promise<Disclosure> {
  await patchRow(db, disclosures, d, "disclosure", { status: "waived", waived_reason: reason }, actor);
  await disclosureCriticalDate(db, d, actor);
  await db.commit();
  return d;
}

// ============================================================================ advertising review

export async function submitAdReview(db: Db, data: Any, actor: CurrentUser): Promise<AdReview> {
  const values: Any = { ...data };
  if (values.marketing_item_id) {
    const item = await getOr404(db, marketingItems, values.marketing_item_id, "Marketing item");
    values.listing_id = values.listing_id || item.listing_id;
    values.document_id = values.document_id || (item.document_ids?.[0] ?? null);
    if (["draft", "approved"].includes(item.status)) await patch(db, marketingItems, item, { status: "in_review" } as never);
  }
  const checklist = AD_CHECKLIST.map(([key, label]) => ({ key, label, checked: false }));
  const r = await createRow(
    db, adReviews, "ad_review",
    { ...values, submitted_by_id: actor.id, submitted_at: utcnow(), status: "pending", checklist },
    actor, values.title,
  );
  await db.commit();
  return r;
}

export async function decideAdReview(db: Db, r: AdReview, data: Any, actor: CurrentUser): Promise<AdReview> {
  const values: Any = data;
  if (r.status !== "pending") throw new HttpError(409, `This review was already ${r.status.replace(/_/g, " ")}`);
  if (r.submitted_by_id === actor.id && !actor.is_admin) {
    throw new HttpError(403, "Advertising must be reviewed by someone other than the submitter");
  }
  const checked = new Map<any, boolean>((values.checklist || []).map((c: Any) => [c.key, Boolean(c.checked)]));
  const checklist = (r.checklist || []).map((c: Any) => ({
    ...c, checked: checked.has(c.key) ? checked.get(c.key) : (c.checked ?? false),
  }));
  if (values.status === "approved" && !checklist.every((c: Any) => c.checked)) {
    throw new HttpError(422, "Every review checklist item must be confirmed before approval");
  }
  if (values.status !== "approved" && blank(values.review_notes)) throw new HttpError(422, "Explain what needs to change");
  const old = r.status;
  await patch(db, adReviews, r, {
    status: values.status, checklist, review_notes: values.review_notes ?? null, reviewer_id: actor.id,
    reviewed_at: utcnow(), updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `ad_review.${values.status}`, entity_type: "ad_review", entity_id: r.id,
    changes: { status: { from: old, to: r.status } }, summary: r.review_notes, ip_address: actor.ip_address,
  });
  if (r.marketing_item_id) {
    const item = await get(db, marketingItems, r.marketing_item_id);
    if (item && item.status === "in_review") {
      await patch(db, marketingItems, item, { status: values.status === "approved" ? "approved" : "draft" } as never);
    }
  }
  await db.commit();
  return r;
}

// ============================================================================ transaction files

function template(side: string, isDual: boolean): Array<[string, string, string]> {
  const items: Array<[string, string, string]> = [
    ["agreement", "Engagement or representation agreement", "agreement"],
    ["agency_disclosure", "Agency relationship disclosure delivered", "disclosure"],
    ["executed_contract", "Executed purchase or lease agreement", "contract"],
    ["license_current", "Agent license current", "compliance"],
  ];
  if (["listing", "landlord", "dual"].includes(side)) {
    items.push(
      ["seller_disclosures", "Seller / landlord property disclosures", "disclosure"],
      ["ad_approvals", "Advertising reviewed and approved", "compliance"],
    );
  }
  if (isDual || side === "dual") items.push(["dual_rep_ack", "Dual representation / intermediary acknowledgement", "disclosure"]);
  items.push(
    ["closing_statement", "Settlement or closing statement", "closing"],
    ["commission_agreement", "Commission agreement or invoice", "financial"],
  );
  return items;
}

const AUTO_KEYS = new Set(["agreement", "agency_disclosure", "license_current", "ad_approvals", "dual_rep_ack"]);

/** Create the deal's transaction file from the template if missing. Does not commit. */
export async function ensureTransactionFile(db: Db, deal: Any, actor: CurrentUser | null): Promise<TransactionFile> {
  const [existing] = await db.select().from(transactionFiles).where(eq(transactionFiles.brokerage_deal_id, deal.id)).limit(1);
  if (existing) {
    if (deal.is_dual_rep) {
      const have = (await db.select({ k: transactionFileItems.key }).from(transactionFileItems).where(eq(transactionFileItems.file_id, existing.id))).map((r) => r.k);
      if (!have.includes("dual_rep_ack")) {
        await insert(db, transactionFileItems, {
          file_id: existing.id, key: "dual_rep_ack", category: "disclosure", sort_order: 50,
          label: "Dual representation / intermediary acknowledgement",
        } as never);
      }
    }
    return existing;
  }
  const actorId = actor?.id ?? null;
  const f = await insert(db, transactionFiles, {
    brokerage_deal_id: deal.id, template_key: deal.side, status: "open", created_by_id: actorId, updated_by_id: actorId,
  } as never);
  await insertMany(
    db, transactionFileItems,
    template(deal.side, deal.is_dual_rep).map(([key, label, cat], i) => ({
      file_id: f.id, key, label, category: cat, is_required: true, sort_order: i * 10, created_by_id: actorId, updated_by_id: actorId,
    })) as never,
  );
  if (actor !== null) {
    await audit.record(db, {
      actor, action: "transaction_file.created", entity_type: "brokerage_deal", entity_id: deal.id, ip_address: actor.ip_address,
    });
  }
  return f;
}

export function itemManuallySatisfied(i: TransactionFileItem): boolean {
  if (["approved", "waived"].includes(i.status)) return true;
  return i.status === "provided" && Boolean(i.document_id || (i.evidence_note || "").trim());
}

/** System-evaluated evidence for template items: {key: [met, detail]}. */
async function autoChecks(db: Db, deal: Any): Promise<Record<string, [boolean, string]>> {
  const out: Record<string, [boolean, string]> = {};
  let agreementOk = false;
  let detail = "No signed agreement linked";
  if (deal.rep_agreement_id) {
    const ra = await get(db, repAgreements, deal.rep_agreement_id);
    if (ra && !ra.deleted_at && ra.signed_on) [agreementOk, detail] = [true, `Representation agreement signed ${ra.signed_on}`];
  }
  const listing = deal.listing_id ? await get(db, listings, deal.listing_id) : undefined;
  if (!agreementOk && listing && listing.engagement_agreement_id) {
    const ea = await get(db, engagementAgreements, listing.engagement_agreement_id);
    if (ea && !ea.deleted_at && ea.signed_on) [agreementOk, detail] = [true, `Engagement agreement signed ${ea.signed_on}`];
  }
  out.agreement = [agreementOk, detail];

  const discs = await db
    .select()
    .from(disclosures)
    .where(and(eq(disclosures.brokerage_deal_id, deal.id), isNull(disclosures.deleted_at)));
  const agency = discs.filter((d) => d.disclosure_type === "agency");
  const agencyOk = agency.length > 0 && agency.every(disclosureSatisfied);
  out.agency_disclosure = [agencyOk, agencyOk ? "Agency disclosure delivered" : "Record and deliver the agency disclosure"];
  const dual = discs.filter((d) => ACK_REQUIRED_TYPES.has(d.disclosure_type));
  const dualOk = dual.length > 0 && dual.every(disclosureSatisfied);
  out.dual_rep_ack = [dualOk, dualOk ? "Acknowledged" : "Dual representation acknowledgement not signed"];

  let licOk = false;
  let licDetail = "No license on file for the agent";
  if (deal.agent_id) {
    const lics = await db
      .select()
      .from(agentLicenses)
      .where(and(eq(agentLicenses.user_id, deal.agent_id), isNull(agentLicenses.deleted_at)));
    for (const lic of lics) {
      if (["active", "pending_renewal"].includes(lic.status) && (lic.expires_on === null || lic.expires_on >= today())) {
        [licOk, licDetail] = [true, `${lic.state} ${lic.license_number} current`];
        break;
      }
      licDetail = `${lic.state} ${lic.license_number} is ${licenseAlertLevel(lic) || lic.status}`;
    }
  }
  out.license_current = [licOk, licDetail];

  let adOk = true;
  let adDetail = "No published marketing";
  if (listing) {
    const published = (
      await db
        .select({ id: marketingItems.id })
        .from(marketingItems)
        .where(
          and(
            eq(marketingItems.listing_id, listing.id), isNull(marketingItems.deleted_at),
            or(eq(marketingItems.status, "published"), eq(marketingItems.syndication_status, "live")),
          ),
        )
    ).map((r) => r.id);
    if (published.length) {
      const approved = new Set(
        (
          await db
            .select({ m: adReviews.marketing_item_id })
            .from(adReviews)
            .where(and(inArray(adReviews.marketing_item_id, published), eq(adReviews.status, "approved"), isNull(adReviews.deleted_at)))
        ).map((r) => r.m),
      );
      const missing = published.filter((m) => !approved.has(m));
      adOk = missing.length === 0;
      adDetail = adOk ? "All published marketing approved" : `${missing.length} published item(s) unapproved`;
    }
  }
  out.ad_approvals = [adOk, adDetail];
  return out;
}

/** Items with satisfaction state, and the list of blockers (required items + blocking disclosures). */
export async function evaluateFile(
  db: Db, f: TransactionFile,
): Promise<[Array<[TransactionFileItem, boolean, string | null]>, string[]]> {
  const deal = await get(db, brokerageDeals, f.brokerage_deal_id);
  const items = await db
    .select()
    .from(transactionFileItems)
    .where(and(eq(transactionFileItems.file_id, f.id), isNull(transactionFileItems.deleted_at)))
    .orderBy(asc(transactionFileItems.sort_order), asc(transactionFileItems.created_at));
  const auto = deal ? await autoChecks(db, deal) : {};
  const evaluated: Array<[TransactionFileItem, boolean, string | null]> = [];
  const blockers: string[] = [];
  for (const i of items) {
    let met = itemManuallySatisfied(i);
    let detail: string | null = null;
    if (AUTO_KEYS.has(i.key) && i.key in auto && i.status !== "rejected") {
      const [autoMet, d] = auto[i.key];
      detail = d;
      met = met || autoMet;
    }
    evaluated.push([i, met, detail]);
    if (i.is_required && !met) blockers.push(i.label + (detail ? ` (${detail})` : ""));
  }
  const blocking = await db
    .select()
    .from(disclosures)
    .where(and(eq(disclosures.brokerage_deal_id, f.brokerage_deal_id), isNull(disclosures.deleted_at), eq(disclosures.is_blocking, true)));
  for (const d of blocking) if (!disclosureSatisfied(d)) blockers.push(`Blocking disclosure: ${d.title}`);
  return [evaluated, uniq(blockers)];
}

/** Public contract: true when every required compliance item is satisfied (commission release gate). */
export async function transactionFileComplete(db: Db, brokerageDealId: string): Promise<[boolean, string[]]> {
  const [f] = await db
    .select()
    .from(transactionFiles)
    .where(and(eq(transactionFiles.brokerage_deal_id, brokerageDealId), isNull(transactionFiles.deleted_at)))
    .limit(1);
  if (!f) return [false, ["Transaction file has not been started"]];
  const [, blockers] = await evaluateFile(db, f);
  return [blockers.length === 0, blockers];
}

export async function fileOut(db: Db, f: TransactionFile, { with_items = true }: { with_items?: boolean } = {}) {
  const [evaluated, blockers] = await evaluateFile(db, f);
  const deal = await get(db, brokerageDeals, f.brokerage_deal_id);
  const required = evaluated.filter(([i]) => i.is_required);
  const requiredTotal = required.length;
  const requiredDone = required.filter(([, m]) => m).length;
  const o: Any = {
    ...pick(f, ["id", "brokerage_deal_id", "template_key", "status", "approved_by_id", "approved_at", "notes"]),
    deal_title: null, deal_stage: null, agent_name: null,
    completeness_pct: requiredTotal ? Math.round((1000 * requiredDone) / requiredTotal) / 10 : 100,
    required_total: requiredTotal, required_done: requiredDone, complete: blockers.length === 0, blockers, items: [],
    updated_at: f.updated_at,
  };
  if (deal) {
    o.deal_title = deal.title;
    o.deal_stage = deal.stage;
    o.agent_name = deal.agent_id ? ((await names(db, "user", [deal.agent_id]))[deal.agent_id] ?? null) : null;
  }
  if (with_items) {
    const refs = await documentRefs(db, evaluated.map(([i]) => i.document_id));
    for (const [i, met, detail] of evaluated) {
      o.items.push({
        ...pick(i, [
          "id", "file_id", "key", "label", "category", "is_required", "sort_order", "status", "document_id", "evidence_note",
          "linked_type", "linked_id", "reviewed_by_id", "reviewed_at", "waived_reason",
        ]),
        ...(detail && !i.evidence_note ? { evidence_note: detail } : {}),
        is_satisfied: met,
        document_title: i.document_id ? (refs[i.document_id]?.title ?? null) : null,
      });
    }
  }
  return o;
}

export async function updateFileItem(db: Db, item: TransactionFileItem, data: Any, actor: CurrentUser): Promise<TransactionFileItem> {
  const values: Any = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const st = values.status;
  if (["approved", "waived", "rejected"].includes(st) && !actor.can("dealroom", "approve")) {
    throw new HttpError(403, "Approving, waiving or rejecting compliance items requires dealroom approval");
  }
  if (st === "waived" && blank(values.waived_reason)) throw new HttpError(422, "A reason is required to waive a compliance item");
  if (st === "provided" && !(values.document_id || item.document_id || (values.evidence_note || item.evidence_note || "").trim())) {
    throw new HttpError(422, "Attach a document or describe the evidence");
  }
  if ("is_required" in values && values.is_required === null) delete values.is_required;
  if ("is_required" in values && values.is_required === false && !actor.can("dealroom", "approve")) {
    throw new HttpError(403, "Only approvers can make a compliance item optional");
  }
  if (st === null || st === undefined) delete values.status;
  if (["approved", "waived", "rejected"].includes(st)) {
    values.reviewed_by_id = actor.id;
    values.reviewed_at = utcnow();
  }
  await patchRow(db, transactionFileItems, item, "transaction_file_item", values, actor);
  const f = await get(db, transactionFiles, item.file_id);
  if (item.document_id && f) await linkDocument(db, item.document_id, "brokerage_deal", f.brokerage_deal_id, actor);
  if (f) {
    const [, blockers] = await evaluateFile(db, f);
    if (f.status !== "approved") await patch(db, transactionFiles, f, { status: blockers.length ? "open" : "complete" });
  }
  await db.commit();
  return item;
}

export async function approveFile(db: Db, f: TransactionFile, actor: CurrentUser): Promise<TransactionFile> {
  const [ok, blockers] = await transactionFileComplete(db, f.brokerage_deal_id);
  if (!ok) throw new HttpError(422, { message: "Transaction file is incomplete", unmet: blockers });
  const old = f.status;
  await patch(db, transactionFiles, f, { status: "approved", approved_by_id: actor.id, approved_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "transaction_file.approved", entity_type: "brokerage_deal", entity_id: f.brokerage_deal_id,
    changes: { status: { from: old, to: "approved" } }, ip_address: actor.ip_address,
  });
  await events.emit(db, "transaction_file.approved", { brokerage_deal_id: f.brokerage_deal_id, actor });
  await db.commit();
  return f;
}

// ============================================================================ reassignment

export async function reassignUser(db: Db, userId: string, toId: string): Promise<void> {
  await db.update(tours).set({ agent_id: toId }).where(and(eq(tours.agent_id, userId), isNull(tours.deleted_at)));
  await db.update(dealRooms).set({ owner_id: toId }).where(and(eq(dealRooms.owner_id, userId), isNull(dealRooms.deleted_at)));
  await db.update(disclosures).set({ owner_id: toId }).where(and(eq(disclosures.owner_id, userId), isNull(disclosures.deleted_at)));
}
