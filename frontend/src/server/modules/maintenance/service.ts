import { and, asc, desc, eq, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as ormGet, insert, patch } from "../../db/orm";
import { users } from "../auth/schema";
import { assets } from "../assets/schema";
import { documentLinks } from "../documents/schema";
import { link as linkDocument } from "../documents/service";
import { leaseClauses, leases } from "../leases/schema";
import { vendors } from "../operations/schema";
import { vendorIsCompliant } from "../operations/service";
import { properties } from "../properties/schema";
import { createCharge } from "../receivables/service";
import { createTask, raiseAlert } from "../tasks/service";
import {
  inspectionFindings, inspections, inspectionTemplates, maintenanceSettings, pmSchedules, PM_FREQUENCIES, SEVERITIES,
  WO_TRANSITIONS, workOrders,
  type Inspection, type InspectionFinding, type InspectionTemplate, type MaintenanceSettings, type PMSchedule,
  type WorkOrder,
} from "./schema";
import type {
  AssignIn, CostIn, FindingIn, FindingUpdate, InspectionCreate, InspectionUpdate, PMScheduleIn, ResponseIn,
  ResponsibilityIn, SettingsIn, TemplateIn, TransitionIn, WorkOrderCreate, WorkOrderUpdate,
} from "./schemas";
import { workOrderCreate } from "./schemas";

export const WO = "work_order";
export const EVIDENCE_ENTITY = "work_order_evidence";

type Actor = CurrentUser | null;

// ------------------------------------------------------------------------------------------- small helpers

const todayStr = () => new Date().toISOString().slice(0, 10);
const r2 = (x: number) => Math.round(x * 100) / 100;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Python's `str(round(x, 2))` for a float: whole numbers keep a trailing ".0" (matters for idempotency keys). */
const pyFloat = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const parseDay = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = parseDay(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDay(d);
};
function addMonths(s: string, months: number): string {
  const d = parseDay(s);
  const total = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmtDay(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
}

function deepEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEq(a[k], b[k]));
  }
  return false;
}

/** audit.diff, but JSONB key order (Postgres reorders keys) must not count as a change (Python dict equality). */
function diff(obj: Record<string, any>, data: Record<string, any>) {
  const changes = audit.diff(obj, data);
  for (const k of Object.keys(changes)) {
    if (deepEq(audit.toJsonable(obj[k] ?? null), audit.toJsonable(data[k]))) delete changes[k];
  }
  return changes;
}

const definedOnly = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const nullify = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));

function delta(before: Record<string, any>, after: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(after)) {
    if ((before[k] ?? null) !== (v ?? null)) out[k] = { from: audit.toJsonable(before[k] ?? null), to: audit.toJsonable(v) };
  }
  return out;
}

const e404 = (what: string) => new HttpError(404, `${what} not found`);
const e422 = (message: string, extra?: Record<string, any>) => new HttpError(422, extra ? { message, ...extra } : message);

const pWo = (db: Db, wo: WorkOrder, values: Record<string, any>) => patch(db, workOrders, wo, values as never);
const pPm = (db: Db, s: PMSchedule, values: Record<string, any>) => patch(db, pmSchedules, s, values as never);
const pInsp = (db: Db, i: Inspection, values: Record<string, any>) => patch(db, inspections, i, values as never);
const pFind = (db: Db, f: InspectionFinding, values: Record<string, any>) => patch(db, inspectionFindings, f, values as never);

// ======================================================================================= cross-module helpers

/** Link uploaded documents to a record through the documents module. */
export async function linkDocuments(db: Db, ids: string[] | null | undefined, entityType: string, entityId: string, actor: CurrentUser) {
  if (!ids || !ids.length) return;
  for (const docId of ids) await linkDocument(db, docId, entityType, entityId, actor);
}

export async function linkedDocumentCount(db: Db, entityType: string, entityId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentLinks)
    .where(and(eq(documentLinks.entity_type, entityType), eq(documentLinks.entity_id, entityId)));
  return Number(r?.n ?? 0);
}

export async function vendorCompliance(db: Db, vendorId: string): Promise<[boolean, string[]]> {
  const [ok, reasons] = await vendorIsCompliant(db, vendorId);
  return [Boolean(ok), reasons ?? []];
}

async function assetForProperty(db: Db, propertyId: string): Promise<string | null> {
  const [r] = await db.select({ id: assets.id }).from(assets).where(eq(assets.property_id, propertyId)).limit(1);
  return r?.id ?? null;
}

async function propertyNames(db: Db, ids: Set<string>): Promise<Map<string, [string, string | null]>> {
  const out = new Map<string, [string, string | null]>();
  if (!ids.size) return out;
  const rows = await db
    .select({ id: properties.id, name: properties.name, address_line: properties.address_line, property_type: properties.property_type })
    .from(properties)
    .where(inArray(properties.id, [...ids]));
  for (const r of rows) out.set(r.id, [r.name || r.address_line, r.property_type]);
  return out;
}

async function userNamesOf(db: Db, ids: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.size) return out;
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, [...ids]));
  for (const r of rows) out.set(r.id, r.full_name);
  return out;
}

async function vendorNames(db: Db, ids: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.size) return out;
  const rows = await db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, [...ids]));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

const ids = (xs: Array<string | null | undefined>) => new Set(xs.filter((x): x is string => !!x));

// ======================================================================================= settings

export async function getSettings(db: Db): Promise<MaintenanceSettings> {
  const [s] = await db.select().from(maintenanceSettings).where(isNull(maintenanceSettings.deleted_at)).limit(1);
  if (s) return s;
  return insert(db, maintenanceSettings, { approval_threshold: 5000, finding_auto_wo_severity: "high", pm_default_lead_days: 14 });
}

export async function updateSettings(db: Db, data: SettingsIn, actor: CurrentUser): Promise<MaintenanceSettings> {
  const s = await getSettings(db);
  const changes = diff(s, data);
  await patch(db, maintenanceSettings, s, { ...data, updated_by_id: actor.id });
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "maintenance_settings.updated", entity_type: "maintenance_settings", entity_id: s.id, changes,
      ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return s;
}

// ======================================================================================= work orders: query

export interface WorkOrderFilters {
  q?: string;
  status?: string[];
  priority?: string[];
  category?: string[];
  source?: string[];
  approval_status?: string[];
  tenant_responsibility?: string[];
  property_id?: string;
  asset_id?: string;
  space_id?: string;
  vendor_id?: string;
  assigned_user_id?: string;
  pm_schedule_id?: string;
  inspection_id?: string;
  due_from?: string;
  due_to?: string;
  min_cost?: number;
  max_cost?: number;
  overdue?: boolean;
  open_only?: boolean;
}

const OPEN_STATES = ["open", "assigned", "in_progress"];

/** WHERE clause for the work-order filters; `skip` leaves a facet's own filter out. */
export function buildQuery(f: WorkOrderFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = workOrders;
  const propCol = (c: any) => sql`(select ${c} from ${properties} where ${properties.id} = ${t.property_id})`;
  const cols: Record<string, any> = {
    status: t.status, priority: t.priority, category: t.category, source: t.source,
    approval_status: t.approval_status, tenant_responsibility: t.tenant_responsibility,
  };
  const eqs: Array<[any, string | undefined]> = [
    [t.property_id, f.property_id], [t.asset_id, f.asset_id], [t.space_id, f.space_id], [t.vendor_id, f.vendor_id],
    [t.assigned_user_id, f.assigned_user_id], [t.pm_schedule_id, f.pm_schedule_id], [t.inspection_id, f.inspection_id],
  ];
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.title, t.description, t.system, t.location_detail, t.requested_by_name, propCol(properties.name), propCol(properties.address_line)]),
    ...["status", "priority", "category", "source", "approval_status", "tenant_responsibility"].map((key) =>
      skip.has(key) ? undefined : inFilter(cols[key], (f as Record<string, any>)[key]),
    ),
    ...eqs.map(([col, v]) => (v ? eq(col, v) : undefined)),
    rangeFilter(t.due_on, f.due_from, f.due_to),
    rangeFilter(sql`coalesce(${t.actual_cost}, ${t.estimate_amount})`, f.min_cost, f.max_cost),
    f.overdue ? and(lt(t.due_on, todayStr()), inArray(t.status, OPEN_STATES)) : undefined,
    f.open_only ? inArray(t.status, OPEN_STATES) : undefined,
  );
}

function listItem(r: WorkOrder, props: Map<string, [string, string | null]>, usr: Map<string, string>, vnd: Map<string, string>) {
  return {
    id: r.id, number: r.number, title: r.title, source: r.source, category: r.category, priority: r.priority,
    status: r.status, property_id: r.property_id, property_name: props.get(r.property_id)?.[0] ?? null,
    asset_id: r.asset_id, space_id: r.space_id, system: r.system, location_detail: r.location_detail,
    assignee_type: r.assignee_type, vendor_id: r.vendor_id, vendor_name: r.vendor_id ? vnd.get(r.vendor_id) ?? null : null,
    assigned_user_id: r.assigned_user_id, assignee_name: r.assigned_user_id ? usr.get(r.assigned_user_id) ?? null : null,
    estimate_amount: r.estimate_amount, actual_cost: r.actual_cost, approval_status: r.approval_status,
    tenant_responsibility: r.tenant_responsibility, due_on: r.due_on, satisfaction_rating: r.satisfaction_rating,
    created_at: r.created_at, updated_at: r.updated_at, completed_at: r.completed_at, verified_at: r.verified_at,
  };
}

export type WorkOrderListItem = ReturnType<typeof listItem>;

export async function decorate(db: Db, rows: WorkOrder[]): Promise<WorkOrderListItem[]> {
  const props = await propertyNames(db, ids(rows.map((r) => r.property_id)));
  const usr = await userNamesOf(db, ids(rows.map((r) => r.assigned_user_id)));
  const vnd = await vendorNames(db, ids(rows.map((r) => r.vendor_id)));
  return rows.map((r) => listItem(r, props, usr, vnd));
}

export async function get(db: Db, woId: string): Promise<WorkOrder> {
  const wo = await ormGet(db, workOrders, woId);
  if (!wo || wo.deleted_at) throw e404("Work order");
  return wo;
}

export async function evidenceCount(db: Db, wo: WorkOrder): Promise<number> {
  return (wo.evidence_document_ids ?? []).length + (await linkedDocumentCount(db, EVIDENCE_ENTITY, wo.id));
}

export async function toOut(db: Db, wo: WorkOrder) {
  const base = (await decorate(db, [wo]))[0];
  let vendor_compliance: { compliant: boolean; reasons: string[] } | null = null;
  if (wo.vendor_id) {
    const [ok, reasons] = await vendorCompliance(db, wo.vendor_id);
    vendor_compliance = { compliant: ok, reasons };
  }
  return {
    ...base,
    description: wo.description, lease_id: wo.lease_id, requested_by_name: wo.requested_by_name,
    requester_contact: wo.requester_contact, tenant_organization_id: wo.tenant_organization_id,
    reported_at: wo.reported_at, photo_document_ids: wo.photo_document_ids ?? [], status_history: wo.status_history ?? [],
    assigned_at: wo.assigned_at, started_at: wo.started_at, approval_threshold: wo.approval_threshold,
    approved_by_id: wo.approved_by_id, approved_at: wo.approved_at, approval_note: wo.approval_note,
    completed_by_id: wo.completed_by_id, completion_notes: wo.completion_notes,
    evidence_document_ids: wo.evidence_document_ids ?? [], verified_by_id: wo.verified_by_id,
    cancelled_reason: wo.cancelled_reason, satisfaction_comment: wo.satisfaction_comment,
    tenant_share_pct: wo.tenant_share_pct, responsibility_reason: wo.responsibility_reason,
    responsibility_basis: wo.responsibility_basis ?? [], responsibility_method: wo.responsibility_method,
    responsibility_determined_at: wo.responsibility_determined_at, chargeback_status: wo.chargeback_status,
    chargeback_amount: wo.chargeback_amount, chargeback_charge_id: wo.chargeback_charge_id,
    pm_schedule_id: wo.pm_schedule_id, inspection_id: wo.inspection_id, finding_id: wo.finding_id,
    created_by_id: wo.created_by_id,
    // Derived
    evidence_count: await evidenceCount(db, wo),
    vendor_compliance,
    allowed_transitions: [...(WO_TRANSITIONS[wo.status] ?? [])].sort(),
  };
}

// ======================================================================================= work orders: mutations

/** Status + history values for a transition (applied by the caller's patch). */
function historyValues(wo: WorkOrder, to: string, actor: Actor, note: string | null = null) {
  const entry = {
    from: wo.status, to, at: utcnow().toISOString(), by_id: actor ? actor.id : null,
    by_name: actor ? actor.full_name : "System", note,
  };
  return { status_history: [...(wo.status_history ?? []), entry], status: to };
}

async function nextNumber(db: Db): Promise<number> {
  const [r] = await db.select({ m: sql<number>`coalesce(max(${workOrders.number}), 0)::int` }).from(workOrders);
  return Number(r?.m ?? 0) + 1;
}

/** Configured approval: estimates above the threshold need maintenance:approve before work starts. */
async function applyEstimate(db: Db, wo: WorkOrder, next: number | null | undefined, _actor: Actor): Promise<void> {
  const value = next ?? null;
  const previous = wo.estimate_amount;
  await pWo(db, wo, { estimate_amount: value });
  const threshold = Number((await getSettings(db)).approval_threshold || 0);
  if (value === null || value <= threshold) {
    await pWo(db, wo, { approval_threshold: threshold, approval_status: wo.approval_status === "approved" ? "approved" : "not_required" });
    return;
  }
  if (wo.approval_status === "approved" && previous !== null && previous !== undefined && value <= previous) {
    await pWo(db, wo, { approval_threshold: threshold });
    return; // still within the approved amount
  }
  await pWo(db, wo, { approval_threshold: threshold, approval_status: "pending", approved_by_id: null, approved_at: null });
  await raiseAlert(db, {
    title: `Work order #${wo.number} needs cost approval`,
    reason: `Estimate $${money(value)} exceeds the approval threshold of $${money(threshold)}.`,
    severity: "medium", related_type: WO, related_id: wo.id, related_label: wo.title,
    rule_key: "maintenance.cost_approval", idempotency_key: `wo_approval:${wo.id}:${pyFloat(r2(value))}`,
  });
}

/** Returns compliance reasons when a vendor assignment was blocked (enforce=false skips instead of raising). */
async function assign_(
  db: Db, wo: WorkOrder, data: AssignIn, actor: Actor, { enforce = true }: { enforce?: boolean } = {},
): Promise<string[]> {
  const set: Record<string, any> = {};
  if (data.assignee_type === "vendor") {
    if (!data.vendor_id) throw e422("Select a vendor to assign");
    const [ok, reasons] = await vendorCompliance(db, data.vendor_id);
    if (!ok) {
      if (enforce) throw e422("Vendor is not compliant; assignment is blocked", { reasons });
      return reasons;
    }
    Object.assign(set, { assignee_type: "vendor", vendor_id: data.vendor_id, assigned_user_id: null });
  } else {
    if (!data.assigned_user_id) throw e422("Select a staff member to assign");
    const user = await ormGet(db, users, data.assigned_user_id);
    if (!user || user.status !== "active") throw e422("Assignee must be an active user");
    Object.assign(set, { assignee_type: "staff", assigned_user_id: data.assigned_user_id, vendor_id: null });
  }
  set.assigned_at = utcnow();
  if (wo.status === "open") Object.assign(set, historyValues(wo, "assigned", actor, "Assigned"));
  await pWo(db, wo, set);
  return [];
}

export async function create(
  db: Db,
  data: WorkOrderCreate,
  actor: Actor,
  {
    pm_schedule_id = null, inspection_id = null, finding_id = null, idempotency_key = null, commit = true,
  }: {
    pm_schedule_id?: string | null; inspection_id?: string | null; finding_id?: string | null;
    idempotency_key?: string | null; commit?: boolean;
  } = {},
): Promise<WorkOrder> {
  if (idempotency_key) {
    const [existing] = await db.select().from(workOrders).where(eq(workOrders.idempotency_key, idempotency_key)).limit(1);
    if (existing) return existing;
  }
  const prop = await ormGet(db, properties, data.property_id);
  if (!prop || prop.deleted_at) throw e404("Property");
  const { estimate_amount, reported_at, ...rest } = data;
  const values: Record<string, any> = nullify(rest);
  if (!values.asset_id) values.asset_id = await assetForProperty(db, data.property_id);
  const actorId = actor ? actor.id : null;
  const wo = await insert(db, workOrders, {
    ...values,
    number: await nextNumber(db),
    status: "open",
    reported_at: reported_at ?? utcnow(),
    status_history: [{
      from: null, to: "open", at: utcnow().toISOString(), by_id: actorId, by_name: actor ? actor.full_name : "System",
      note: `Created from ${data.source}`,
    }],
    pm_schedule_id, inspection_id, finding_id, idempotency_key, created_by_id: actorId, updated_by_id: actorId,
    approval_status: "not_required", tenant_responsibility: "undetermined", chargeback_status: "none",
    evidence_document_ids: [],
  } as never);
  await applyEstimate(db, wo, estimate_amount, actor);
  if (actor) await linkDocuments(db, data.photo_document_ids, WO, wo.id, actor);
  await audit.record(db, {
    actor, action: "work_order.created", entity_type: WO, entity_id: wo.id, summary: `#${wo.number} ${wo.title}`,
    changes: { source: data.source, priority: data.priority }, ip_address: actor ? actor.ip_address : null,
  });
  await events.emit(db, "work_order.created", { work_order_id: wo.id, property_id: wo.property_id, actor });
  if (commit) await db.commit();
  return wo;
}

export async function update(db: Db, wo: WorkOrder, data: WorkOrderUpdate, actor: CurrentUser): Promise<WorkOrder> {
  if (wo.status === "verified" || wo.status === "cancelled") throw e422(`A ${wo.status} work order cannot be edited`);
  const values = definedOnly(data);
  const changes = diff(wo, values);
  if (!Object.keys(changes).length) return wo;
  const have = new Set(wo.photo_document_ids ?? []);
  const newPhotos = [...new Set<string>(values.photo_document_ids ?? [])].filter((x) => !have.has(x));
  const set: Record<string, any> = { ...values };
  if ("photo_document_ids" in values) set.photo_document_ids = values.photo_document_ids ?? [];
  set.updated_by_id = actor.id;
  await pWo(db, wo, set);
  await linkDocuments(db, newPhotos, WO, wo.id, actor);
  await audit.record(db, {
    actor, action: "work_order.updated", entity_type: WO, entity_id: wo.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

export async function assign(db: Db, wo: WorkOrder, data: AssignIn, actor: CurrentUser): Promise<WorkOrder> {
  if (["completed", "verified", "cancelled"].includes(wo.status)) throw e422(`Cannot reassign a ${wo.status} work order`);
  const before = { assignee_type: wo.assignee_type, vendor_id: wo.vendor_id, assigned_user_id: wo.assigned_user_id };
  await assign_(db, wo, data, actor);
  await pWo(db, wo, { updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "work_order.assigned", entity_type: WO, entity_id: wo.id,
    changes: delta(before, { assignee_type: wo.assignee_type, vendor_id: wo.vendor_id, assigned_user_id: wo.assigned_user_id }),
    ip_address: actor.ip_address,
  });
  if (wo.assigned_user_id && wo.assigned_user_id !== actor.id) {
    await createTask(db, {
      title: `Work order #${wo.number}: ${wo.title}`, assignee_id: wo.assigned_user_id, task_type: "general",
      priority: ["high", "urgent"].includes(wo.priority) ? "high" : "normal", related_type: WO, related_id: wo.id,
      related_label: wo.title, source: "maintenance", idempotency_key: `wo_assign:${wo.id}:${wo.assigned_user_id}`,
      actor_id: actor.id,
    });
  }
  await db.commit();
  return wo;
}

async function advancePm(db: Db, wo: WorkOrder, servicedOn: string | null): Promise<void> {
  if (!wo.pm_schedule_id) return;
  const s = await ormGet(db, pmSchedules, wo.pm_schedule_id);
  if (!s) return;
  const set: Record<string, any> = {};
  if (servicedOn) set.last_service_on = servicedOn;
  // Cadence is kept from the scheduled date; never move backwards.
  if (wo.due_on && s.next_service_on <= wo.due_on) set.next_service_on = nextOccurrence(wo.due_on, s.frequency, s.interval_days);
  if (Object.keys(set).length) await pPm(db, s, set);
}

export async function transition(db: Db, wo: WorkOrder, data: TransitionIn, actor: CurrentUser): Promise<WorkOrder> {
  const to = data.status;
  if (to === wo.status) return wo;
  if (!(WO_TRANSITIONS[wo.status] ?? new Set<string>()).has(to)) throw e422(`Cannot move a work order from ${wo.status} to ${to}`);
  let note = data.note ?? null;
  // Mutations are applied in memory immediately (later checks read them) and persisted with one UPDATE at the end.
  const set: Record<string, any> = {};
  const apply = (v: Record<string, any>) => {
    Object.assign(set, v);
    Object.assign(wo, v);
  };

  if (to === "assigned" && !(wo.vendor_id || wo.assigned_user_id)) throw e422("Assign a vendor or staff member first");
  if (to === "in_progress") {
    if (wo.approval_status === "pending") throw e422("The estimate exceeds the approval threshold and is awaiting approval");
    if (wo.approval_status === "rejected") throw e422("The estimate was rejected; revise the estimate before starting work");
    if (wo.vendor_id) {
      const [ok, reasons] = await vendorCompliance(db, wo.vendor_id);
      if (!ok) throw e422("Vendor is not compliant; work cannot start", { reasons });
    }
    apply({ started_at: wo.started_at || utcnow() });
  }
  if (to === "completed") {
    const notes = (data.completion_notes || wo.completion_notes || "").trim();
    if (!notes) throw e422("Completion notes are required");
    apply({ completion_notes: notes });
    if (data.actual_cost !== null && data.actual_cost !== undefined) apply({ actual_cost: data.actual_cost });
    if (data.evidence_document_ids.length) {
      apply({ evidence_document_ids: [...new Set([...(wo.evidence_document_ids ?? []), ...data.evidence_document_ids])] });
      await linkDocuments(db, data.evidence_document_ids, EVIDENCE_ENTITY, wo.id, actor);
    }
    apply({ completed_at: utcnow(), completed_by_id: actor.id });
    await advancePm(db, wo, todayStr());
  }
  if (to === "verified") {
    if (data.evidence_document_ids.length) {
      apply({ evidence_document_ids: [...new Set([...(wo.evidence_document_ids ?? []), ...data.evidence_document_ids])] });
      await linkDocuments(db, data.evidence_document_ids, EVIDENCE_ENTITY, wo.id, actor);
    }
    if ((await evidenceCount(db, wo)) === 0) throw e422("Completion evidence (photo or document) is required before verifying");
    if (wo.actual_cost === null || wo.actual_cost === undefined) throw e422("Record the actual cost before verifying");
    apply({ verified_at: utcnow(), verified_by_id: actor.id });
    if (wo.finding_id) {
      const finding = await ormGet(db, inspectionFindings, wo.finding_id);
      if (finding && finding.status !== "resolved") await pFind(db, finding, { status: "resolved" });
    }
  }
  if (to === "cancelled") {
    const reason = (data.cancelled_reason || note || "").trim();
    if (!reason) throw e422("A cancellation reason is required");
    apply({ cancelled_reason: reason });
    note = reason;
    await advancePm(db, wo, null);
  }
  if (to === "open") apply({ cancelled_reason: wo.status === "cancelled" ? null : wo.cancelled_reason });
  if (to === "in_progress" && wo.status === "completed") apply({ completed_at: null }); // reopened for rework

  const previous = wo.status;
  apply(historyValues(wo, to, actor, note));
  apply({ updated_by_id: actor.id });
  await pWo(db, wo, set);
  await audit.record(db, {
    actor, action: `work_order.${to}`, entity_type: WO, entity_id: wo.id, changes: { status: { from: previous, to } },
    summary: note, ip_address: actor.ip_address,
  });
  await events.emit(db, "work_order.status_changed", {
    work_order_id: wo.id, property_id: wo.property_id, from_status: previous, to_status: to, actor,
  });
  await db.commit();
  return wo;
}

export async function setCosts(db: Db, wo: WorkOrder, data: CostIn, actor: CurrentUser): Promise<WorkOrder> {
  if (wo.status === "verified" || wo.status === "cancelled") throw e422(`Costs of a ${wo.status} work order are locked`);
  const { note, ...rest } = data;
  const values = definedOnly(rest);
  const changes = diff(wo, values);
  if (!Object.keys(changes).length) return wo;
  if ("estimate_amount" in values) await applyEstimate(db, wo, values.estimate_amount, actor);
  if ("actual_cost" in values) await pWo(db, wo, { actual_cost: values.actual_cost });
  await pWo(db, wo, { updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "work_order.costs_updated", entity_type: WO, entity_id: wo.id,
    changes: { ...changes, approval_status: wo.approval_status }, summary: note, ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

export async function decideApproval(db: Db, wo: WorkOrder, decision: string, note: string | null | undefined, actor: CurrentUser) {
  if (wo.approval_status !== "pending") throw e422("This work order is not awaiting approval");
  if (decision === "rejected" && !(note || "").trim()) throw e422("A note is required when rejecting an estimate");
  await pWo(db, wo, {
    approval_status: decision, approved_by_id: actor.id, approved_at: utcnow(), approval_note: note ?? null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `work_order.estimate_${decision}`, entity_type: WO, entity_id: wo.id,
    changes: { approval_status: { from: "pending", to: decision }, estimate_amount: wo.estimate_amount },
    summary: note, ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

export async function addEvidence(db: Db, wo: WorkOrder, docIds: string[], actor: CurrentUser): Promise<WorkOrder> {
  const have = wo.evidence_document_ids ?? [];
  const added = docIds.filter((i) => !have.includes(i));
  if (!added.length) return wo;
  await pWo(db, wo, { evidence_document_ids: [...have, ...added] });
  await linkDocuments(db, added, EVIDENCE_ENTITY, wo.id, actor);
  await audit.record(db, {
    actor, action: "work_order.evidence_added", entity_type: WO, entity_id: wo.id,
    changes: { evidence_document_ids: added }, ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

export async function rate(db: Db, wo: WorkOrder, rating: number, comment: string | null | undefined, actor: CurrentUser) {
  if (!["completed", "verified"].includes(wo.status)) throw e422("Satisfaction can be recorded once the work is completed");
  const values = { satisfaction_rating: rating, satisfaction_comment: comment ?? null };
  const changes = diff(wo, values);
  await pWo(db, wo, values);
  await audit.record(db, {
    actor, action: "work_order.rated", entity_type: WO, entity_id: wo.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

export async function archive(db: Db, wo: WorkOrder, actor: CurrentUser): Promise<void> {
  await pWo(db, wo, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "work_order.archived", entity_type: WO, entity_id: wo.id, summary: `#${wo.number} ${wo.title}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function bulkUpdate(
  db: Db, idList: string[], priority: string | null | undefined, assignedUserId: string | null | undefined, actor: CurrentUser,
): Promise<number> {
  const rows = await db.select().from(workOrders).where(and(inArray(workOrders.id, idList), isNull(workOrders.deleted_at)));
  let updated = 0;
  for (const wo of rows) {
    const changes: Record<string, any> = {};
    if (priority && wo.priority !== priority) {
      changes.priority = { from: wo.priority, to: priority };
      await pWo(db, wo, { priority });
    }
    if (assignedUserId && ["open", "assigned"].includes(wo.status) && wo.assigned_user_id !== assignedUserId) {
      await assign_(db, wo, { assignee_type: "staff", assigned_user_id: assignedUserId }, actor);
      changes.assigned_user_id = { to: String(assignedUserId) };
    }
    if (Object.keys(changes).length) {
      updated += 1;
      await pWo(db, wo, { updated_by_id: actor.id });
      await audit.record(db, {
        actor, action: "work_order.bulk_updated", entity_type: WO, entity_id: wo.id, changes, ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return updated;
}

// ======================================================================================= tenant responsibility

const CATEGORY_TERMS: Record<string, string[]> = {
  hvac: ["hvac", "heating", "air condition", "mechanical system", "rooftop unit"],
  plumbing: ["plumbing", "sewer", "water line", "drain", "fixtures"],
  electrical: ["electrical", "lighting", "wiring"],
  roof: ["roof"],
  structural: ["structural", "foundation", "exterior wall", "load-bearing", "slab"],
  parking_lot: ["parking", "paving", "asphalt", "common area"],
  landscaping: ["landscap", "common area", "grounds"],
  life_safety: ["fire", "sprinkler", "life safety", "alarm"],
  janitorial: ["janitorial", "cleaning", "trash"],
  pest_control: ["pest"],
  doors_locks: ["door", "lock", "storefront", "glass"],
  signage: ["sign"],
  elevator: ["elevator"],
};
const TENANT_RE = new RegExp(
  "\\btenant(?:'s)?\\s+(?:shall|will|must|is\\s+responsible|agrees|at\\s+its\\s+(?:sole\\s+)?(?:cost|expense))|" +
    "at\\s+tenant'?s\\s+(?:sole\\s+)?(?:cost|expense)|tenant\\s+responsib",
  "i",
);
const LANDLORD_RE = new RegExp(
  "\\blandlord(?:'s)?\\s+(?:shall|will|must|is\\s+responsible|agrees|at\\s+its\\s+(?:sole\\s+)?(?:cost|expense))|" +
    "at\\s+landlord'?s\\s+(?:sole\\s+)?(?:cost|expense)|landlord\\s+responsib",
  "i",
);
const RELEVANT_TYPES = new Set(["maintenance", "repair", "repairs", "replacement", "maintenance_repair", "capital_repairs"]);
const NET_TYPES = new Set(["nnn", "triple_net", "absolute_net", "net", "bondable", "stnl"]);
const CAPITAL_CATEGORIES = new Set(["roof", "structural"]);

const clauseText = (c: Record<string, any>) => String(c.text || c.summary || c.body || "").replace(/’/g, "'");
const clauseType = (c: Record<string, any>) => String(c.clause_type || c.category || c.kind || "").toLowerCase();

async function applicableLease(db: Db, wo: WorkOrder) {
  if (wo.lease_id) {
    const lease = await ormGet(db, leases, wo.lease_id);
    if (lease) return { lease, problem: null as string | null };
  }
  const base = and(eq(leases.property_id, wo.property_id), eq(leases.status, "active"), isNull(leases.deleted_at));
  if (wo.space_id) {
    const [lease] = await db.select().from(leases).where(and(base, eq(leases.space_id, wo.space_id))).limit(1);
    if (lease) return { lease, problem: null };
  }
  if (wo.tenant_organization_id) {
    const [lease] = await db.select().from(leases).where(and(base, eq(leases.tenant_organization_id, wo.tenant_organization_id))).limit(1);
    if (lease) return { lease, problem: null };
  }
  const rows = await db.select().from(leases).where(base).limit(2);
  if (rows.length === 1) return { lease: rows[0], problem: null };
  if (!rows.length) return { lease: null, problem: "No active lease covers this property" };
  return { lease: null, problem: "Several active leases cover this property; link the work order to a space or lease" };
}

async function leaseClausesOf(db: Db, leaseId: string): Promise<Record<string, any>[]> {
  return db.select().from(leaseClauses).where(and(eq(leaseClauses.lease_id, leaseId), isNull(leaseClauses.deleted_at)));
}

/** Pure rule set: category-specific clauses outrank general maintenance clauses, which outrank lease type. */
export function determineFromClauses(
  category: string, leaseType: string | null | undefined, clauses: Record<string, any>[],
): [string, number | null, string, Record<string, any>[]] {
  const terms = CATEGORY_TERMS[category] ?? [];
  const specific: Array<[string, Record<string, any>]> = [];
  const general: Array<[string, Record<string, any>]> = [];
  for (const c of clauses) {
    const text = clauseText(c);
    const ctype = clauseType(c);
    const low = text.toLowerCase();
    if (!RELEVANT_TYPES.has(ctype) && !["repair", "maint", "replace"].some((w) => low.includes(w))) continue;
    const t = TENANT_RE.test(text);
    const l = LANDLORD_RE.test(text);
    if (!(t || l)) continue;
    const party = t && l ? "shared" : t ? "tenant" : "landlord";
    const basis = {
      clause_id: String(c.id ?? "") || null, clause_type: ctype || null,
      document_id: c.document_id ? String(c.document_id) : null,
      page: c.page ?? null, clause_ref: c.clause_ref ?? null,
      excerpt: text.slice(0, 400), party,
    };
    (terms.some((term) => low.includes(term)) ? specific : general).push([party, basis]);
  }

  for (const [level, found] of [["category-specific", specific], ["general maintenance", general]] as const) {
    if (!found.length) continue;
    const tenant = found.filter(([p]) => p === "tenant").length;
    const landlord = found.filter(([p]) => p === "landlord").length;
    const shared = found.filter(([p]) => p === "shared").length;
    const basis = found.map(([, b]) => b);
    if (tenant && !landlord && !shared) return ["tenant", 100.0, `Lease ${level} clause(s) assign this work to the tenant.`, basis];
    if (landlord && !tenant && !shared) return ["landlord", 0.0, `Lease ${level} clause(s) assign this work to the landlord.`, basis];
    return ["shared", 50.0, `Lease ${level} clauses allocate obligations to both parties; review the split.`, basis];
  }

  const lt = (leaseType || "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (NET_TYPES.has(lt)) {
    if (CAPITAL_CATEGORIES.has(category) && lt !== "absolute_net") {
      return ["landlord", 0.0, `No maintenance clause found; ${leaseType} lease keeps roof/structure with the landlord.`, []];
    }
    return ["tenant", 100.0, `No maintenance clause found; ${leaseType} lease places repairs on the tenant.`, []];
  }
  if (lt) return ["landlord", 0.0, `No maintenance clause found; ${leaseType} lease keeps repairs with the landlord.`, []];
  return ["undetermined", null, "No maintenance clause or lease type available to determine responsibility.", []];
}

export async function determineResponsibility(db: Db, wo: WorkOrder, data: ResponsibilityIn, actor: CurrentUser): Promise<WorkOrder> {
  const before = { tenant_responsibility: wo.tenant_responsibility, tenant_share_pct: wo.tenant_share_pct };
  const set: Record<string, any> = {};
  let result: string;
  let pct: number | null;
  let reason: string;
  let basis: Record<string, any>[];
  let method: string;
  if (data.responsibility) {
    if (!(data.reason || "").trim()) throw e422("A reason is required for a manual determination");
    result = data.responsibility;
    pct = data.tenant_share_pct ?? null;
    reason = data.reason as string;
    basis = [];
    method = "manual";
    if (pct === null) pct = ({ tenant: 100.0, landlord: 0.0, shared: 50.0 } as Record<string, number>)[result] ?? null;
  } else {
    const { lease, problem } = await applicableLease(db, wo);
    if (lease === null) {
      [result, pct, reason, basis] = ["undetermined", null, problem || "No applicable lease", []];
    } else {
      const clauses = await leaseClausesOf(db, lease.id);
      [result, pct, reason, basis] = determineFromClauses(wo.category, (lease as Record<string, any>).lease_type, clauses);
      set.lease_id = lease.id;
      const tenant = (lease as Record<string, any>).tenant_name;
      if (tenant) reason = `${reason} (lease: ${tenant})`;
    }
    method = "lease_rules";
  }
  Object.assign(set, {
    tenant_responsibility: result, tenant_share_pct: pct, responsibility_reason: reason, responsibility_basis: basis,
    responsibility_method: method, responsibility_determined_at: utcnow(), responsibility_determined_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await pWo(db, wo, set);
  await audit.record(db, {
    actor, action: "work_order.responsibility_determined", entity_type: WO, entity_id: wo.id,
    changes: { ...delta(before, { tenant_responsibility: result, tenant_share_pct: pct }), method },
    summary: reason, ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

export async function createChargeback(db: Db, wo: WorkOrder, actor: CurrentUser): Promise<WorkOrder> {
  if (!["tenant", "shared"].includes(wo.tenant_responsibility)) throw e422("Chargeback requires a tenant or shared responsibility determination");
  if (!["completed", "verified"].includes(wo.status)) throw e422("Chargeback is available once the work is completed");
  if (!wo.actual_cost) throw e422("Record the actual cost first");
  if (wo.chargeback_status === "created") throw new HttpError(409, "A chargeback was already created");
  const share = wo.tenant_share_pct !== null && wo.tenant_share_pct !== undefined
    ? wo.tenant_share_pct
    : wo.tenant_responsibility === "tenant" ? 100.0 : 50.0;
  const amount = r2((Number(wo.actual_cost) * share) / 100);
  let chargeId: string | null = null;
  if (wo.lease_id) {
    try {
      const charge = await createCharge(db, {
        lease_id: wo.lease_id, amount, charge_type: "maintenance_chargeback",
        description: `Work order #${wo.number}: ${wo.title}`, due_on: todayStr(), source_type: WO, source_id: wo.id, actor,
      });
      chargeId = (charge as { id?: string } | null)?.id ?? null;
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      chargeId = null;
    }
  }
  const status = chargeId ? "created" : "pending_manual";
  await pWo(db, wo, { chargeback_amount: amount, chargeback_charge_id: chargeId, chargeback_status: status });
  if (!chargeId) {
    await createTask(db, {
      title: `Bill tenant $${money(amount)} for work order #${wo.number}`, task_type: "general", priority: "normal",
      related_type: WO, related_id: wo.id, related_label: wo.title, description: wo.responsibility_reason,
      source: "maintenance.chargeback", idempotency_key: `wo_chargeback:${wo.id}`, actor_id: actor.id,
    });
  }
  await audit.record(db, {
    actor, action: "work_order.chargeback_created", entity_type: WO, entity_id: wo.id,
    changes: { chargeback_amount: amount, chargeback_status: wo.chargeback_status, charge_id: chargeId },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

// ======================================================================================= service history

export async function serviceHistory(
  db: Db, { asset_id, property_id, system }: { asset_id?: string | null; property_id?: string | null; system?: string | null },
) {
  if (!asset_id && !property_id) throw e422("asset_id or property_id is required");
  const wc: Array<SQL | undefined> = [isNull(workOrders.deleted_at)];
  const pc: Array<SQL | undefined> = [isNull(pmSchedules.deleted_at)];
  if (asset_id) {
    wc.push(eq(workOrders.asset_id, asset_id));
    pc.push(eq(pmSchedules.asset_id, asset_id));
  }
  if (property_id) {
    wc.push(eq(workOrders.property_id, property_id));
    pc.push(eq(pmSchedules.property_id, property_id));
  }
  if (system) {
    wc.push(sql`${workOrders.system} ilike ${`%${system}%`}`);
    pc.push(sql`${pmSchedules.system} ilike ${`%${system}%`}`);
  }
  const rows = await db.select().from(workOrders).where(and(...wc)).orderBy(desc(workOrders.created_at)).limit(500);
  const schedules = await db.select().from(pmSchedules).where(and(...pc)).orderBy(asc(pmSchedules.next_service_on));
  const done = rows.filter((r) => ["completed", "verified"].includes(r.status));
  return {
    work_orders: await decorate(db, rows),
    pm_schedules: await pmOut(db, schedules),
    total_cost: r2(done.reduce((a, r) => a + Number(r.actual_cost || 0), 0)),
    completed_count: done.length,
    open_count: rows.filter((r) => OPEN_STATES.includes(r.status)).length,
  };
}

// ======================================================================================= preventive maintenance

export function nextOccurrence(d: string, frequency: string, intervalDays: number | null | undefined): string {
  const months = ({ monthly: 1, quarterly: 3, semiannual: 6, annual: 12 } as Record<string, number>)[frequency];
  if (months) return addMonths(d, months);
  if (frequency === "custom") return addDays(d, Math.max(1, intervalDays || 30));
  return addDays(d, PM_FREQUENCIES[frequency] ?? 30);
}

export async function pmOut(db: Db, rows: PMSchedule[]) {
  const props = await propertyNames(db, ids(rows.map((r) => r.property_id)));
  const vnd = await vendorNames(db, ids(rows.map((r) => r.default_vendor_id)));
  const today = todayStr();
  return rows.map((r) => ({
    property_id: r.property_id, asset_id: r.asset_id, system: r.system, title: r.title, description: r.description,
    category: r.category, priority: r.priority, frequency: r.frequency, interval_days: r.interval_days,
    lead_days: r.lead_days, last_service_on: r.last_service_on, next_service_on: r.next_service_on,
    default_vendor_id: r.default_vendor_id, default_assignee_id: r.default_assignee_id,
    estimate_amount: r.estimate_amount, is_active: r.is_active,
    id: r.id,
    property_name: props.get(r.property_id)?.[0] ?? null,
    vendor_name: r.default_vendor_id ? vnd.get(r.default_vendor_id) ?? null : null,
    last_generated_on: r.last_generated_on, last_work_order_id: r.last_work_order_id,
    is_due: Boolean(r.is_active && addDays(r.next_service_on, -(r.lead_days || 0)) <= today),
    updated_at: r.updated_at,
  }));
}

export function pmQuery(
  q: string | undefined, propertyId: string | undefined, assetId: string | undefined, active: boolean | undefined,
  frequency: string[] | undefined, dueWithinDays: number | undefined,
): SQL | undefined {
  const t = pmSchedules;
  return and(
    isNull(t.deleted_at),
    applySearch(q, [t.title, t.system, t.description]),
    propertyId ? eq(t.property_id, propertyId) : undefined,
    assetId ? eq(t.asset_id, assetId) : undefined,
    active !== undefined ? eq(t.is_active, active) : undefined,
    inFilter(t.frequency, frequency),
    dueWithinDays !== undefined ? lte(t.next_service_on, addDays(todayStr(), dueWithinDays)) : undefined,
  );
}

export async function getPm(db: Db, pmId: string): Promise<PMSchedule> {
  const s = await ormGet(db, pmSchedules, pmId);
  if (!s || s.deleted_at) throw e404("Schedule");
  return s;
}

export async function savePm(db: Db, data: PMScheduleIn, actor: CurrentUser, s: PMSchedule | null = null): Promise<PMSchedule> {
  if (data.frequency === "custom" && !data.interval_days) throw e422("Custom frequency requires an interval in days");
  const values: Record<string, any> = nullify(data);
  if (!values.asset_id) values.asset_id = await assetForProperty(db, data.property_id);
  if (s === null) {
    s = await insert(db, pmSchedules, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
    await audit.record(db, {
      actor, action: "pm_schedule.created", entity_type: "pm_schedule", entity_id: s.id, summary: `${s.system}: ${s.title}`,
      ip_address: actor.ip_address,
    });
  } else {
    const changes = diff(s, values);
    await pPm(db, s, { ...values, updated_by_id: actor.id });
    if (Object.keys(changes).length) {
      await audit.record(db, {
        actor, action: "pm_schedule.updated", entity_type: "pm_schedule", entity_id: s.id, changes, ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return s;
}

export async function archivePm(db: Db, s: PMSchedule, actor: CurrentUser): Promise<void> {
  await pPm(db, s, { deleted_at: utcnow(), is_active: false });
  await audit.record(db, {
    actor, action: "pm_schedule.archived", entity_type: "pm_schedule", entity_id: s.id, summary: s.title,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

/** Idempotent: one work order per schedule per scheduled date (key pm:<schedule>:<date>).
 *  The schedule advances to its next occurrence when that work order is completed or cancelled. */
export async function generatePmWorkOrders(
  db: Db, actor: Actor, { property_id = null }: { property_id?: string | null } = {},
): Promise<{ scanned: number; generated: number; work_order_ids: string[] }> {
  const today = todayStr();
  const schedules = await db
    .select()
    .from(pmSchedules)
    .where(and(isNull(pmSchedules.deleted_at), eq(pmSchedules.is_active, true), property_id ? eq(pmSchedules.property_id, property_id) : undefined));
  const generated: string[] = [];
  for (const s of schedules) {
    if (addDays(s.next_service_on, -(s.lead_days || 0)) > today) continue;
    const key = `pm:${s.id}:${s.next_service_on}`;
    const [dupe] = await db.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.idempotency_key, key)).limit(1);
    if (dupe) continue;
    const wo = await create(
      db,
      workOrderCreate.parse({
        title: s.title, description: s.description, source: "preventive", category: s.category, priority: s.priority,
        property_id: s.property_id, asset_id: s.asset_id, system: s.system, due_on: s.next_service_on,
        estimate_amount: s.estimate_amount,
      }),
      actor,
      { pm_schedule_id: s.id, idempotency_key: key, commit: false },
    );
    if (s.default_vendor_id) {
      const blocked = await assign_(db, wo, { assignee_type: "vendor", vendor_id: s.default_vendor_id }, actor, { enforce: false });
      if (blocked.length) {
        await raiseAlert(db, {
          title: `PM work order #${wo.number} left unassigned`, severity: "medium",
          reason: "Default vendor is not compliant: " + blocked.join("; "),
          related_type: WO, related_id: wo.id, related_label: wo.title, rule_key: "maintenance.vendor_compliance",
          idempotency_key: `pm_vendor_blocked:${wo.id}`,
        });
      }
    } else if (s.default_assignee_id) {
      await assign_(db, wo, { assignee_type: "staff", assigned_user_id: s.default_assignee_id }, actor, { enforce: false });
    }
    await pPm(db, s, { last_generated_on: today, last_work_order_id: wo.id });
    generated.push(wo.id);
  }
  if (actor && generated.length) {
    await audit.record(db, {
      actor, action: "pm_schedule.scan", entity_type: "pm_schedule", summary: `${generated.length} work orders generated`,
      ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return { scanned: schedules.length, generated: generated.length, work_order_ids: generated };
}

// ======================================================================================= inspection templates

export function templateOut(t: InspectionTemplate) {
  return {
    id: t.id, name: t.name, property_type: t.property_type, description: t.description, sections: t.sections ?? [],
    version: t.version, is_active: t.is_active,
    item_count: (t.sections ?? []).reduce((n, s) => n + (s.items ?? []).length, 0),
    updated_at: t.updated_at,
  };
}

function validateSections(sections: any[]): void {
  const keys = new Set<string>();
  for (const s of sections) {
    for (const i of s.items ?? []) {
      if (keys.has(i.key)) throw e422(`Duplicate checklist item key: ${i.key}`);
      keys.add(i.key);
    }
  }
}

export async function getTemplate(db: Db, templateId: string): Promise<InspectionTemplate> {
  const t = await ormGet(db, inspectionTemplates, templateId);
  if (!t || t.deleted_at) throw e404("Template");
  return t;
}

export async function saveTemplate(
  db: Db, data: TemplateIn, actor: CurrentUser, t: InspectionTemplate | null = null,
): Promise<InspectionTemplate> {
  const values: Record<string, any> = nullify(data);
  validateSections(values.sections);
  if (t === null) {
    t = await insert(db, inspectionTemplates, { ...values, version: 1, created_by_id: actor.id, updated_by_id: actor.id } as never);
    await audit.record(db, {
      actor, action: "inspection_template.created", entity_type: "inspection_template", entity_id: t.id, summary: t.name,
      ip_address: actor.ip_address,
    });
  } else {
    const changes = diff(t, values);
    const set: Record<string, any> = { ...values, updated_by_id: actor.id };
    if ("sections" in changes) set.version = (t.version || 1) + 1; // inspections keep their own snapshot
    await patch(db, inspectionTemplates, t, set as never);
    if (Object.keys(changes).length) {
      const { sections: _s, ...others } = changes;
      await audit.record(db, {
        actor, action: "inspection_template.updated", entity_type: "inspection_template", entity_id: t.id,
        changes: { ...others, ...("sections" in changes ? { sections: "revised", version: t.version } : {}) },
        ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return t;
}

export async function archiveTemplate(db: Db, t: InspectionTemplate, actor: CurrentUser): Promise<void> {
  await patch(db, inspectionTemplates, t, { deleted_at: utcnow(), is_active: false } as never);
  await audit.record(db, {
    actor, action: "inspection_template.archived", entity_type: "inspection_template", entity_id: t.id, summary: t.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// ======================================================================================= inspections

function itemsOf(sections: any[] | null | undefined): Map<string, [any, any]> {
  const out = new Map<string, [any, any]>();
  for (const s of sections ?? []) for (const i of s.items ?? []) out.set(i.key, [s, i]);
  return out;
}

function progress(insp: Pick<Inspection, "sections" | "responses">) {
  const items = itemsOf(insp.sections);
  const answered = Object.entries(insp.responses ?? {}).filter(([k, v]) => items.has(k) && v && v.result);
  const count = (r: string) => answered.filter(([, v]) => v.result === r).length;
  return { total: items.size, answered: answered.length, pass: count("pass"), fail: count("fail"), na: count("na") };
}

function scoreOf(insp: Pick<Inspection, "sections" | "responses">): number | null {
  const p = progress(insp);
  const graded = p.pass + p.fail;
  return graded ? Math.round((1000 * p.pass) / graded) / 10 : null;
}

export interface InspectionFilters {
  q?: string;
  status?: string[];
  property_id?: string;
  asset_id?: string;
  inspector_id?: string;
  template_id?: string;
  scheduled_from?: string;
  scheduled_to?: string;
}

export function inspectionQuery(f: InspectionFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = inspections;
  const propCol = (c: any) => sql`(select ${c} from ${properties} where ${properties.id} = ${t.property_id})`;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.template_name, t.summary, propCol(properties.name), propCol(properties.address_line)]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.asset_id ? eq(t.asset_id, f.asset_id) : undefined,
    f.inspector_id ? eq(t.inspector_id, f.inspector_id) : undefined,
    f.template_id ? eq(t.template_id, f.template_id) : undefined,
    rangeFilter(t.scheduled_on, f.scheduled_from, f.scheduled_to),
  );
}

export async function inspectionItems(db: Db, rows: Inspection[]) {
  const props = await propertyNames(db, ids(rows.map((r) => r.property_id)));
  const usr = await userNamesOf(db, ids(rows.map((r) => r.inspector_id)));
  const counts = new Map<string, [number, number]>();
  if (rows.length) {
    const res = await db
      .select({
        inspection_id: inspectionFindings.inspection_id,
        total: sql<number>`count(*)::int`,
        open: sql<number>`(count(*) filter (where ${inspectionFindings.status} = 'open'))::int`,
      })
      .from(inspectionFindings)
      .where(and(inArray(inspectionFindings.inspection_id, rows.map((r) => r.id)), isNull(inspectionFindings.deleted_at)))
      .groupBy(inspectionFindings.inspection_id);
    for (const r of res) counts.set(r.inspection_id, [Number(r.total), Number(r.open)]);
  }
  return rows.map((r) => {
    const [finding_count, open_finding_count] = counts.get(r.id) ?? [0, 0];
    return {
      id: r.id, template_id: r.template_id, template_name: r.template_name, property_id: r.property_id,
      property_name: props.get(r.property_id)?.[0] ?? null, property_type: props.get(r.property_id)?.[1] ?? null,
      asset_id: r.asset_id, inspector_id: r.inspector_id,
      inspector_name: r.inspector_id ? usr.get(r.inspector_id) ?? null : null,
      status: r.status, scheduled_on: r.scheduled_on, completed_at: r.completed_at, score: r.score,
      finding_count, open_finding_count, updated_at: r.updated_at,
    };
  });
}

export async function getInspection(db: Db, inspectionId: string): Promise<Inspection> {
  const i = await ormGet(db, inspections, inspectionId);
  if (!i || i.deleted_at) throw e404("Inspection");
  return i;
}

export function findingOut(f: InspectionFinding) {
  return {
    id: f.id, inspection_id: f.inspection_id, property_id: f.property_id, item_key: f.item_key, item_label: f.item_label,
    section_title: f.section_title, title: f.title, description: f.description, category: f.category,
    severity: f.severity, status: f.status, latitude: f.latitude, longitude: f.longitude,
    location_accuracy_m: f.location_accuracy_m, captured_at: f.captured_at, photo_document_ids: f.photo_document_ids ?? [],
    work_order_id: f.work_order_id, created_at: f.created_at,
  };
}

export async function inspectionOut(db: Db, insp: Inspection) {
  const base = (await inspectionItems(db, [insp]))[0];
  const findings = await db
    .select()
    .from(inspectionFindings)
    .where(and(eq(inspectionFindings.inspection_id, insp.id), isNull(inspectionFindings.deleted_at)))
    .orderBy(asc(inspectionFindings.created_at));
  return {
    ...base,
    template_version: insp.template_version, sections: insp.sections ?? [], responses: insp.responses ?? {},
    started_at: insp.started_at, latitude: insp.latitude, longitude: insp.longitude, summary: insp.summary,
    findings: findings.map(findingOut), progress: progress(insp), created_at: insp.created_at,
  };
}

export async function createInspection(db: Db, data: InspectionCreate, actor: CurrentUser): Promise<Inspection> {
  const t = await getTemplate(db, data.template_id);
  const prop = await ormGet(db, properties, data.property_id);
  if (!prop || prop.deleted_at) throw e404("Property");
  if (t.property_type && t.property_type !== prop.property_type) {
    throw e422(`Template is for ${t.property_type} properties; this property is ${prop.property_type}`);
  }
  const insp = await insert(db, inspections, {
    template_id: t.id, template_name: t.name, template_version: t.version, sections: t.sections, responses: {},
    property_id: prop.id, asset_id: data.asset_id || (await assetForProperty(db, prop.id)),
    inspector_id: data.inspector_id || actor.id, scheduled_on: data.scheduled_on || todayStr(),
    status: "scheduled", created_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "inspection.created", entity_type: "inspection", entity_id: insp.id, summary: `${t.name} v${t.version}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return insp;
}

export async function updateInspection(db: Db, insp: Inspection, data: InspectionUpdate, actor: CurrentUser): Promise<Inspection> {
  const values = definedOnly(data);
  const changes = diff(insp, values);
  if (!Object.keys(changes).length) return insp;
  await pInsp(db, insp, { ...values, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "inspection.updated", entity_type: "inspection", entity_id: insp.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return insp;
}

export async function recordResponses(db: Db, insp: Inspection, responses: ResponseIn[], actor: CurrentUser): Promise<Inspection> {
  if (insp.status === "completed" || insp.status === "cancelled") throw e422(`This inspection is ${insp.status}`);
  const items = itemsOf(insp.sections);
  const current: Record<string, any> = { ...(insp.responses ?? {}) };
  for (const r of responses) {
    if (!items.has(r.item_key)) throw e422(`Unknown checklist item: ${r.item_key}`);
    current[r.item_key] = {
      result: r.result ?? null, note: r.note ?? null, answered_at: utcnow().toISOString(), by_id: String(actor.id),
    };
  }
  const set: Record<string, any> = { responses: current };
  if (insp.status === "scheduled") Object.assign(set, { status: "in_progress", started_at: utcnow() });
  set.score = scoreOf({ sections: insp.sections, responses: current });
  set.updated_by_id = actor.id;
  await pInsp(db, insp, set);
  await db.commit();
  return insp;
}

async function findingWorkOrder(db: Db, insp: Inspection, f: InspectionFinding, actor: Actor): Promise<WorkOrder> {
  const priority = ({ critical: "urgent", high: "high", medium: "normal", low: "low" } as Record<string, string>)[f.severity] ?? "normal";
  const loc = f.section_title && f.item_label ? `${f.section_title} · ${f.item_label}` : f.item_label || null;
  const wo = await create(
    db,
    workOrderCreate.parse({
      title: f.title, description: f.description, source: "inspection", category: f.category, priority,
      property_id: insp.property_id, asset_id: insp.asset_id, location_detail: loc,
      photo_document_ids: [...(f.photo_document_ids ?? [])],
    }),
    actor,
    { inspection_id: insp.id, finding_id: f.id, idempotency_key: `finding:${f.id}`, commit: false },
  );
  await pFind(db, f, { work_order_id: wo.id, status: "work_order_created" });
  return wo;
}

export async function addFinding(db: Db, insp: Inspection, data: FindingIn, actor: CurrentUser) {
  if (insp.status === "cancelled") throw e422("This inspection is cancelled");
  let section: any = null;
  let item: any = null;
  if (data.item_key) {
    const found = itemsOf(insp.sections).get(data.item_key);
    if (!found) throw e422(`Unknown checklist item: ${data.item_key}`);
    [section, item] = found;
  }
  const f = await insert(db, inspectionFindings, {
    inspection_id: insp.id, property_id: insp.property_id, item_key: data.item_key ?? null,
    item_label: item ? item.label : null, section_title: section ? section.title : null,
    title: data.title, description: data.description ?? null,
    category: data.category === "general" ? (item?.category || data.category) : data.category,
    severity: data.severity, status: "open", latitude: data.latitude ?? null, longitude: data.longitude ?? null,
    location_accuracy_m: data.location_accuracy_m ?? null, captured_at: data.captured_at ?? utcnow(),
    photo_document_ids: data.photo_document_ids, created_by_id: actor.id, updated_by_id: actor.id,
  });
  await linkDocuments(db, data.photo_document_ids, "inspection_finding", f.id, actor);
  if (data.item_key) {
    const responses: Record<string, any> = { ...(insp.responses ?? {}) };
    const prev = responses[data.item_key] ?? {};
    if (prev.result !== "fail") {
      responses[data.item_key] = { ...prev, result: "fail", answered_at: utcnow().toISOString(), by_id: String(actor.id) };
      await pInsp(db, insp, { responses, score: scoreOf({ sections: insp.sections, responses }) });
    }
  }
  const threshold = (await getSettings(db)).finding_auto_wo_severity;
  let wo: WorkOrder | null = null;
  if (SEVERITIES.indexOf(f.severity as never) >= SEVERITIES.indexOf((SEVERITIES as readonly string[]).includes(threshold) ? (threshold as never) : "high")) {
    wo = await findingWorkOrder(db, insp, f, actor);
  }
  await audit.record(db, {
    actor, action: "inspection.finding_added", entity_type: "inspection", entity_id: insp.id,
    summary: `${f.severity}: ${f.title}`, changes: { work_order_id: wo ? wo.id : null, lat: f.latitude, lng: f.longitude },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return { finding: findingOut(f), work_order_id: wo ? wo.id : null, auto_created: wo !== null };
}

export async function getFinding(db: Db, findingId: string): Promise<InspectionFinding> {
  const f = await ormGet(db, inspectionFindings, findingId);
  if (!f || f.deleted_at) throw e404("Finding");
  return f;
}

export async function updateFinding(db: Db, f: InspectionFinding, data: FindingUpdate, actor: CurrentUser): Promise<InspectionFinding> {
  const values = definedOnly(data);
  const changes = diff(f, values);
  if (!Object.keys(changes).length) return f;
  const have = new Set(f.photo_document_ids ?? []);
  const newPhotos = [...new Set<string>(values.photo_document_ids ?? [])].filter((x) => !have.has(x));
  const set: Record<string, any> = { ...values, updated_by_id: actor.id };
  if ("photo_document_ids" in values) set.photo_document_ids = values.photo_document_ids ?? [];
  await pFind(db, f, set);
  await linkDocuments(db, newPhotos, "inspection_finding", f.id, actor);
  await audit.record(db, {
    actor, action: "inspection.finding_updated", entity_type: "inspection", entity_id: f.inspection_id, summary: f.title,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return f;
}

export async function findingToWorkOrder(db: Db, f: InspectionFinding, actor: CurrentUser): Promise<WorkOrder> {
  if (f.work_order_id) {
    const existing = await ormGet(db, workOrders, f.work_order_id);
    if (existing && !existing.deleted_at) return existing;
  }
  const insp = await getInspection(db, f.inspection_id);
  const wo = await findingWorkOrder(db, insp, f, actor);
  await audit.record(db, {
    actor, action: "inspection.work_order_created", entity_type: "inspection", entity_id: insp.id,
    summary: `#${wo.number} from finding ${f.title}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return wo;
}

export async function setInspectionStatus(
  db: Db, insp: Inspection, to: string, summary: string | null | undefined, actor: CurrentUser,
): Promise<Inspection> {
  if (insp.status === "completed" || insp.status === "cancelled") throw e422(`This inspection is already ${insp.status}`);
  const created: string[] = [];
  const set: Record<string, any> = {};
  if (to === "in_progress") set.started_at = insp.started_at || utcnow();
  if (to === "completed") {
    const p = progress(insp);
    if (p.answered < p.total) throw e422(`${p.total - p.answered} checklist items are unanswered`);
    // Every failed item must be captured as a deficiency so nothing is lost.
    const existing = new Set(
      (
        await db
          .select({ k: inspectionFindings.item_key })
          .from(inspectionFindings)
          .where(and(eq(inspectionFindings.inspection_id, insp.id), isNull(inspectionFindings.deleted_at)))
      ).map((r) => r.k),
    );
    const items = itemsOf(insp.sections);
    for (const [key, resp] of Object.entries(insp.responses ?? {})) {
      if (resp.result === "fail" && !existing.has(key) && items.has(key)) {
        const [section, item] = items.get(key) as [any, any];
        await insert(db, inspectionFindings, {
          inspection_id: insp.id, property_id: insp.property_id, item_key: key, item_label: item.label,
          section_title: section.title, title: `Failed: ${item.label}`, description: resp.note ?? null,
          category: item.category || "general", severity: "medium", status: "open",
          latitude: insp.latitude, longitude: insp.longitude, captured_at: utcnow(), photo_document_ids: [],
          created_by_id: actor.id, updated_by_id: actor.id,
        });
      }
    }
    const threshold = (await getSettings(db)).finding_auto_wo_severity;
    const floor = SEVERITIES.indexOf((SEVERITIES as readonly string[]).includes(threshold) ? (threshold as never) : "high");
    const pending = await db
      .select()
      .from(inspectionFindings)
      .where(and(
        eq(inspectionFindings.inspection_id, insp.id), isNull(inspectionFindings.deleted_at),
        isNull(inspectionFindings.work_order_id), eq(inspectionFindings.status, "open"),
      ));
    for (const f of pending) {
      if (SEVERITIES.indexOf(f.severity as never) >= floor) created.push((await findingWorkOrder(db, insp, f, actor)).id);
    }
    set.completed_at = utcnow();
    set.score = scoreOf(insp);
  }
  if (summary !== null && summary !== undefined) set.summary = summary;
  const previous = insp.status;
  set.status = to;
  set.updated_by_id = actor.id;
  await pInsp(db, insp, set);
  await audit.record(db, {
    actor, action: `inspection.${to}`, entity_type: "inspection", entity_id: insp.id,
    changes: { status: { from: previous, to }, work_orders_created: created }, ip_address: actor.ip_address,
  });
  await db.commit();
  return insp;
}

export async function archiveInspection(db: Db, insp: Inspection, actor: CurrentUser): Promise<void> {
  await pInsp(db, insp, { deleted_at: utcnow() });
  await audit.record(db, {
    actor, action: "inspection.archived", entity_type: "inspection", entity_id: insp.id, summary: insp.template_name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}
