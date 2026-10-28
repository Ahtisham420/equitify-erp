import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch, raw } from "../../db/orm";
import { users } from "../auth/schema";
import * as compliance from "../compliance/service";
import { contactPoints, organizations, people } from "../contacts/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { strftime } from "../tasks/fmt";
import { tasks } from "../tasks/schema";
import { createTask, dayBounds, recordRuleRun, ruleConfig, userNames } from "../tasks/service";
import {
  COMPLIANCE_CHANNEL,
  EXIT_DISPOSITIONS,
  MEANINGFUL_CHANNELS,
  MEANINGFUL_DISPOSITIONS,
  interactions,
  sequenceEnrollments,
  sequences,
  type Interaction,
  type Sequence,
  type SequenceEnrollment,
} from "./schema";
import type { InteractionCreate, InteractionUpdate, SequenceIn } from "./schemas";

export const OPEN_TASK = ["open", "in_progress"];
const STALLED_STAGES = ["negotiation", "offer"];
const DAY = 24 * 3600 * 1000;

const label = (value: string | null | undefined): string => (value || "").replace(/_/g, " ");
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const plural = (n: number) => (n !== 1 ? "s" : "");
const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

// --------------------------------------------------------------------------- record labels

type PersonLike = { full_name?: string | null; first_name?: string | null; last_name?: string | null };
function personName(p: PersonLike): string {
  return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed contact";
}

const present = (ids: Iterable<string | null | undefined>): string[] => [...new Set([...ids].filter((i): i is string => !!i))];

export async function personNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = present(ids);
  if (!set.length) return new Map();
  const rows = await db.select().from(people).where(inArray(people.id, set));
  return new Map(rows.map((p) => [p.id, personName(p)]));
}

async function orgNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = present(ids);
  if (!set.length) return new Map();
  const rows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, set));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function propertyLabels(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = present(ids);
  if (!set.length) return new Map();
  const rows = await db
    .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
    .from(properties)
    .where(inArray(properties.id, set));
  return new Map(rows.map((r) => [r.id, r.name || r.address_line]));
}

async function opportunityTitles(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = present(ids);
  if (!set.length) return new Map();
  const rows = await db
    .select({ id: opportunities.id, title: opportunities.title })
    .from(opportunities)
    .where(inArray(opportunities.id, set));
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** InteractionOut with resolved record labels. */
export async function interactionOuts(db: Db, rows: Interaction[]) {
  const ppl = await personNames(db, rows.map((r) => r.person_id));
  const orgs = await orgNames(db, rows.map((r) => r.organization_id));
  const props = await propertyLabels(db, rows.map((r) => r.property_id));
  const opps = await opportunityTitles(db, rows.map((r) => r.opportunity_id));
  const usr = await userNames(db, rows.map((r) => r.logged_by_id));
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    direction: r.direction,
    occurred_at: r.occurred_at,
    person_id: r.person_id,
    person_name: (r.person_id && ppl.get(r.person_id)) || null,
    organization_id: r.organization_id,
    organization_name: (r.organization_id && orgs.get(r.organization_id)) || null,
    property_id: r.property_id,
    property_label: (r.property_id && props.get(r.property_id)) || null,
    opportunity_id: r.opportunity_id,
    opportunity_title: (r.opportunity_id && opps.get(r.opportunity_id)) || null,
    contact_value: r.contact_value,
    disposition: r.disposition,
    subject: r.subject,
    summary: r.summary,
    duration_seconds: r.duration_seconds,
    is_meaningful: r.is_meaningful,
    next_action: r.next_action,
    next_action_at: r.next_action_at,
    follow_up_task_id: r.follow_up_task_id,
    loop_closed: r.loop_closed,
    closed_reason: r.closed_reason,
    logged_by_id: r.logged_by_id,
    logged_by_name: (r.logged_by_id && usr.get(r.logged_by_id)) || null,
    sequence_enrollment_id: r.sequence_enrollment_id,
    created_at: r.created_at,
  }));
}

async function primaryRelated(db: Db, it: Interaction): Promise<[string | null, string | null, string | null]> {
  if (it.opportunity_id) return ["opportunity", it.opportunity_id, (await opportunityTitles(db, [it.opportunity_id])).get(it.opportunity_id) ?? null];
  if (it.person_id) return ["person", it.person_id, (await personNames(db, [it.person_id])).get(it.person_id) ?? null];
  if (it.organization_id) return ["organization", it.organization_id, (await orgNames(db, [it.organization_id])).get(it.organization_id) ?? null];
  if (it.property_id) return ["property", it.property_id, (await propertyLabels(db, [it.property_id])).get(it.property_id) ?? null];
  return [null, null, null];
}

// --------------------------------------------------------------------------- interaction rules

export function isMeaningful(channel: string, disposition: string | null | undefined): boolean {
  return MEANINGFUL_CHANNELS.has(channel) || (!!disposition && MEANINGFUL_DISPOSITIONS.has(disposition));
}

/** No meaningful interaction may remain without a next action or an explicit closure. */
export function checkLoop(
  meaningful: boolean,
  nextAction: string | null | undefined,
  nextActionAt: Date | null | undefined,
  loopClosed: boolean,
  closedReason: string | null | undefined,
): void {
  const hasAction = Boolean((nextAction || "").trim());
  if (nextActionAt && !hasAction) throw new HttpError(422, "Describe the next action for the chosen date");
  if (hasAction && !nextActionAt) throw new HttpError(422, "Choose a date for the next action");
  if (loopClosed && !(closedReason || "").trim()) throw new HttpError(422, "Give a reason for closing the loop");
  if (meaningful && !hasAction && !loopClosed) {
    throw new HttpError(422, {
      message:
        "A meaningful conversation needs a next action with a date, or an explicit loop closure with a reason",
      code: "next_action_required",
    });
  }
}

async function resolveContactValue(
  db: Db,
  channel: string,
  contactValue: string | null | undefined,
  contactPointId: string | null | undefined,
  personId: string | null | undefined,
): Promise<string | null> {
  if (contactValue && contactValue.trim()) return contactValue.trim();
  if (contactPointId) {
    const cp = await get(db, contactPoints, contactPointId);
    if (cp && cp.value) return cp.value;
  }
  if (personId) {
    const p = await get(db, people, personId);
    if (p) return (channel === "email" ? p.primary_email : p.primary_phone) ?? null;
  }
  return null;
}

async function invalidateContactPoint(db: Db, it: Interaction, actor: CurrentUser): Promise<void> {
  let cp = it.contact_point_id ? await get(db, contactPoints, it.contact_point_id) : undefined;
  if (!cp && it.person_id && it.contact_value) {
    const norm = compliance.normalizeValue("phone", it.contact_value);
    const rows = await db
      .select()
      .from(contactPoints)
      .where(and(eq(contactPoints.person_id, it.person_id), eq(contactPoints.kind, "phone")));
    cp = rows.find((r) => compliance.normalizeValue("phone", r.value) === norm);
  }
  if (!cp) return;
  // Mark invalid, keeping the value for history.
  await patch(db, contactPoints, cp, {
    is_valid: false, invalid_reason: "Wrong number", invalid_at: utcnow(), is_primary: false, updated_by_id: actor.id,
  });
  if (cp.person_id) {
    await audit.record(db, {
      actor, action: "person.contact_point_invalidated", entity_type: "person", entity_id: cp.person_id,
      summary: `${cp.value} marked as wrong number`, ip_address: actor.ip_address,
    });
  }
}

async function applyDispositionEffects(db: Db, it: Interaction, actor: CurrentUser): Promise<void> {
  if (it.disposition === "wrong_number" && it.contact_value && ["call", "sms"].includes(it.channel)) {
    await invalidateContactPoint(db, it, actor);
    await compliance.suppressValue(db, {
      channel: "phone", value: it.contact_value, actor, reason: "Wrong number reported on outreach", source: "outreach",
    });
  } else if (it.disposition === "not_interested" && it.person_id) {
    const settings = await compliance.getSettings(db);
    const days = settings.not_interested_suppression_days || 0;
    if (days > 0) {
      const until = new Date(it.occurred_at.getTime() + days * DAY);
      for (const [kind, value] of await compliance.personContactValues(db, it.person_id)) {
        await compliance.suppressValue(db, {
          channel: kind === "email" ? "email" : "phone", value, actor, person_id: it.person_id, until,
          source: "outreach",
          reason: `Not interested (logged ${strftime(it.occurred_at, "%b %d, %Y")}); suppressed for ${days} days`,
        });
      }
    }
  }
}

async function touchPerson(db: Db, it: Interaction): Promise<void> {
  if (!it.person_id) return;
  const p = await get(db, people, it.person_id);
  if (!p) return;
  const set: Record<string, any> = {};
  if (it.channel !== "note" && it.direction !== "internal") {
    if (!p.last_touch_at || p.last_touch_at < it.occurred_at) set.last_touch_at = it.occurred_at;
  }
  if (it.next_action_at && !it.loop_closed) set.next_action_at = it.next_action_at;
  else if (it.loop_closed && it.is_meaningful) set.next_action_at = null;
  if (Object.keys(set).length) await patch(db, people, p, set as never);
}

/** Automatic sequence exit on reply, on a conversation disposition, or forced (opt-out). Does not commit. */
export async function exitEnrollments(
  db: Db,
  personId: string,
  reason: string,
  o: { disposition?: string | null; inbound?: boolean; force?: boolean } = {},
): Promise<number> {
  const rows = await db
    .select({ e: sequenceEnrollments, s: sequences })
    .from(sequenceEnrollments)
    .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequence_id))
    .where(
      and(
        eq(sequenceEnrollments.person_id, personId),
        inArray(sequenceEnrollments.status, ["active", "paused"]),
        isNull(sequenceEnrollments.deleted_at),
      ),
    );
  let n = 0;
  const now = utcnow();
  for (const { e, s } of rows) {
    if (
      o.force || o.inbound ||
      (o.disposition && (EXIT_DISPOSITIONS.has(o.disposition) || (s.exit_dispositions ?? []).includes(o.disposition)))
    ) {
      await patch(db, sequenceEnrollments, e, { status: "exited", exited_at: now, exit_reason: reason.slice(0, 200), next_step_at: null });
      n += 1;
    }
  }
  return n;
}

async function advance(db: Db, e: SequenceEnrollment, s: Sequence, now: Date): Promise<void> {
  const steps = s.steps ?? [];
  const current = (e.current_step || 0) + 1;
  const set: Record<string, any> = { current_step: current, last_step_at: now };
  if (current >= steps.length) {
    Object.assign(set, { status: "completed", next_step_at: null, exited_at: now, exit_reason: "Completed all steps" });
  } else {
    set.next_step_at = new Date(now.getTime() + Math.trunc(Number(steps[current].delay_days || 0)) * DAY);
  }
  await patch(db, sequenceEnrollments, e, set as never);
}

// --------------------------------------------------------------------------- log / update interactions

export async function logInteraction(db: Db, data: InteractionCreate, actor: CurrentUser): Promise<Interaction> {
  const meaningful = isMeaningful(data.channel, data.disposition);
  checkLoop(meaningful, data.next_action, data.next_action_at, data.loop_closed, data.closed_reason);
  if (![data.person_id, data.organization_id, data.property_id, data.opportunity_id].some(Boolean)) {
    throw new HttpError(422, "Link the interaction to a person, organization, property or opportunity");
  }
  const now = utcnow();
  const occurredAt = data.occurred_at ?? now;
  if (occurredAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new HttpError(422, "An interaction cannot be logged in the future");
  }

  let value: string | null = null;
  let reasons: string[] = [];
  const compChannel = COMPLIANCE_CHANNEL[data.channel];
  if (data.direction === "outbound" && compChannel) {
    value = await resolveContactValue(db, data.channel, data.contact_value, data.contact_point_id, data.person_id);
    if (value) {
      const [allowed, why] = await compliance.checkSend(db, { channel: compChannel, value, at: occurredAt });
      reasons = why;
      if (!allowed) {
        await compliance.logOutbound(db, {
          channel: compChannel, value, content: data.summary ?? null, subject: data.subject ?? null, actor, allowed: false,
          reasons, person_id: data.person_id ?? null,
        });
        await audit.record(db, {
          actor, action: "interaction.blocked", entity_type: data.person_id ? "person" : "interaction",
          entity_id: data.person_id, summary: `${data.channel} to ${value} blocked by compliance`,
          changes: { reasons }, ip_address: actor.ip_address,
        });
        await db.commit();
        throw new HttpError(422, { message: "Blocked by communication compliance", reasons, code: "compliance_blocked" });
      }
    }
  }

  const loopClosed = data.loop_closed;
  let it = await insert(db, interactions, {
    channel: data.channel, direction: data.direction, occurred_at: occurredAt, person_id: data.person_id ?? null,
    organization_id: data.organization_id ?? null, property_id: data.property_id ?? null,
    opportunity_id: data.opportunity_id ?? null, contact_point_id: data.contact_point_id ?? null,
    contact_value: (value || data.contact_value) ?? null, disposition: data.disposition ?? null,
    subject: data.subject ?? null, summary: data.summary ?? null, duration_seconds: data.duration_seconds ?? null,
    is_meaningful: meaningful,
    next_action: loopClosed ? null : (data.next_action || "").trim() || null,
    next_action_at: loopClosed ? null : (data.next_action_at ?? null),
    loop_closed: loopClosed, closed_reason: (data.closed_reason || "").trim() || null, logged_by_id: actor.id,
    sequence_enrollment_id: data.sequence_enrollment_id ?? null, compliance_reasons: reasons,
    created_by_id: actor.id, updated_by_id: actor.id,
  });

  if (value && compChannel) {
    await compliance.logOutbound(db, {
      channel: compChannel, value, content: data.summary ?? null, subject: data.subject ?? null, actor, allowed: true,
      interaction_id: it.id, person_id: data.person_id ?? null,
    });
  }

  if (it.next_action && it.next_action_at) {
    const [enabled] = await ruleConfig(db, "outreach.next_action_required");
    if (enabled) {
      const [rtype, rid, rlabel] = await primaryRelated(db, it);
      const task = await createTask(db, {
        title: it.next_action, assignee_id: actor.id, due_at: it.next_action_at, task_type: "follow_up",
        priority: it.disposition === "offer_requested" ? "high" : "normal",
        description:
          `Follow-up from ${label(it.channel)} on ${strftime(occurredAt, "%b %d, %Y")}` +
          (it.disposition ? ` (${label(it.disposition)})` : "") +
          (it.summary ? `: ${it.summary.slice(0, 500)}` : ""),
        related_type: rtype, related_id: rid, related_label: rlabel, source: "outreach",
        idempotency_key: `interaction:${it.id}:follow_up`, actor_id: actor.id,
      });
      it = await patch(db, interactions, it, { follow_up_task_id: task.id });
      await recordRuleRun(db, "outreach.next_action_required");
    }
  }

  if (data.complete_task_id) await completeQueueTask(db, data.complete_task_id, it, actor);

  await applyDispositionEffects(db, it, actor);
  await touchPerson(db, it);

  if (it.person_id) {
    const inbound = it.direction === "inbound";
    const reason = inbound ? "Replied" : `Disposition: ${label(it.disposition)}`;
    await exitEnrollments(db, it.person_id, reason, { disposition: it.disposition, inbound });
  }
  if (it.sequence_enrollment_id && it.direction === "outbound") {
    const [row] = await db
      .select({ e: sequenceEnrollments, s: sequences })
      .from(sequenceEnrollments)
      .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequence_id))
      .where(eq(sequenceEnrollments.id, it.sequence_enrollment_id))
      .limit(1);
    if (row && row.e.status === "active") await advance(db, row.e, row.s, occurredAt);
  }

  const summary = `${label(it.channel)}` + (it.disposition ? ` · ${label(it.disposition)}` : "");
  await audit.record(db, {
    actor, action: "interaction.logged", entity_type: "interaction", entity_id: it.id, summary,
    ip_address: actor.ip_address,
  });
  for (const [etype, eid] of [
    ["person", it.person_id], ["organization", it.organization_id], ["property", it.property_id],
    ["opportunity", it.opportunity_id],
  ] as const) {
    if (eid) {
      await audit.record(db, {
        actor, action: `${etype}.interaction_logged`, entity_type: etype, entity_id: eid,
        summary: summary + (it.summary ? `: ${it.summary.slice(0, 200)}` : ""), ip_address: actor.ip_address,
      });
    }
  }
  await events.emit(db, "interaction.logged", {
    interaction_id: it.id, person_id: it.person_id, organization_id: it.organization_id,
    property_id: it.property_id, opportunity_id: it.opportunity_id, channel: it.channel, direction: it.direction,
    disposition: it.disposition, meaningful: it.is_meaningful, next_action_at: it.next_action_at, actor,
  });
  await db.commit();
  return it;
}

async function completeQueueTask(db: Db, taskId: string, it: Interaction, actor: CurrentUser): Promise<void> {
  const t = await get(db, tasks, taskId);
  if (!t || t.deleted_at || !OPEN_TASK.includes(t.status)) return;
  if (t.depends_on?.length) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(inArray(tasks.id, t.depends_on), inArray(tasks.status, OPEN_TASK)));
    if (r?.n) return;
  }
  await patch(db, tasks, t, {
    status: "done", completed_at: utcnow(), completed_by_id: actor.id,
    resolution_note: `Logged ${label(it.channel)}` + (it.disposition ? ` (${label(it.disposition)})` : ""),
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "task.completed", entity_type: "task", entity_id: t.id, summary: t.title, ip_address: actor.ip_address,
  });
}

export async function getInteraction(db: Db, interactionId: string): Promise<Interaction> {
  const it = await get(db, interactions, interactionId);
  if (!it || it.deleted_at) throw new HttpError(404, "Interaction not found");
  return it;
}

export async function updateInteraction(db: Db, it: Interaction, data: InteractionUpdate, actor: CurrentUser): Promise<Interaction> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if ("loop_closed" in values && values.loop_closed === null) values.loop_closed = false; // column is NOT NULL
  const pick = (k: "next_action" | "next_action_at" | "loop_closed" | "closed_reason") => (k in values ? values[k] : it[k]);
  const merged = {
    next_action: pick("next_action"), next_action_at: pick("next_action_at"), loop_closed: Boolean(pick("loop_closed")),
    closed_reason: pick("closed_reason"),
  };
  checkLoop(it.is_meaningful, merged.next_action, merged.next_action_at, merged.loop_closed, merged.closed_reason);
  if (merged.loop_closed) {
    values.next_action = null;
    values.next_action_at = null;
  }
  const changes = audit.diff(it, values);
  if (!Object.keys(changes).length) return it;
  it = await patch(db, interactions, it, { ...values, updated_by_id: actor.id } as never);

  let task = it.follow_up_task_id ? await get(db, tasks, it.follow_up_task_id) : undefined;
  if (it.loop_closed && task && OPEN_TASK.includes(task.status)) {
    await patch(db, tasks, task, {
      status: "cancelled", completed_at: utcnow(), completed_by_id: actor.id,
      resolution_note: `Loop closed: ${it.closed_reason}`,
    });
  } else if (it.next_action && it.next_action_at && ("next_action" in changes || "next_action_at" in changes)) {
    if (task && OPEN_TASK.includes(task.status)) {
      await patch(db, tasks, task, { title: it.next_action.slice(0, 300), due_at: it.next_action_at, escalation_level: 0 });
    } else {
      const [rtype, rid, rlabel] = await primaryRelated(db, it);
      task = await createTask(db, {
        title: it.next_action, assignee_id: actor.id, due_at: it.next_action_at, task_type: "follow_up",
        related_type: rtype, related_id: rid, related_label: rlabel, source: "outreach",
        idempotency_key: `interaction:${it.id}:follow_up:${strftime(utcnow(), "%Y%m%d%H%M%S")}`, actor_id: actor.id,
      });
      it = await patch(db, interactions, it, { follow_up_task_id: task.id });
    }
  }
  await touchPerson(db, it);
  await audit.record(db, {
    actor, action: "interaction.updated", entity_type: "interaction", entity_id: it.id, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return it;
}

export async function archiveInteraction(db: Db, it: Interaction, actor: CurrentUser): Promise<void> {
  await patch(db, interactions, it, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "interaction.archived", entity_type: "interaction", entity_id: it.id, ip_address: actor.ip_address,
  });
  await db.commit();
}

export interface InteractionFilters {
  actor_id: string;
  q?: string;
  channel?: string[];
  direction?: string[];
  disposition?: string[];
  person_id?: string;
  organization_id?: string;
  property_id?: string;
  opportunity_id?: string;
  logged_by?: string[];
  date_from?: Date;
  date_to?: Date;
  meaningful?: boolean;
  skip?: Set<string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function interactionWhere(f: InteractionFilters): SQL | undefined {
  const t = interactions;
  const skip = f.skip ?? new Set<string>();
  const conds: Array<SQL | undefined> = [
    isNull(t.deleted_at),
    applySearch(f.q, [t.summary, t.subject, t.contact_value, t.next_action]),
    skip.has("channel") ? undefined : inFilter(t.channel, f.channel),
    skip.has("direction") ? undefined : inFilter(t.direction, f.direction),
    skip.has("disposition") ? undefined : inFilter(t.disposition, f.disposition),
  ];
  for (const [col, val] of [
    [t.person_id, f.person_id], [t.organization_id, f.organization_id], [t.property_id, f.property_id],
    [t.opportunity_id, f.opportunity_id],
  ] as const) {
    if (val) conds.push(eq(col, val));
  }
  if (f.logged_by?.length) {
    const ids: string[] = [];
    for (const v of f.logged_by) {
      if (v === "me") ids.push(f.actor_id);
      else if (UUID_RE.test(v)) ids.push(v);
    }
    if (ids.length) conds.push(inArray(t.logged_by_id, ids));
  }
  if (f.date_from) conds.push(gte(t.occurred_at, f.date_from));
  if (f.date_to) conds.push(lte(t.occurred_at, f.date_to));
  if (f.meaningful !== undefined) conds.push(eq(t.is_meaningful, f.meaningful));
  return and(...conds);
}

// --------------------------------------------------------------------------- sequences

export async function getSequence(db: Db, sequenceId: string): Promise<Sequence> {
  const s = await get(db, sequences, sequenceId);
  if (!s || s.deleted_at) throw new HttpError(404, "Sequence not found");
  return s;
}

/** SequenceOut with enrollment counts. */
export async function sequenceOuts(db: Db, rows: Sequence[]) {
  const counts = new Map<string, { active: number; total: number }>();
  if (rows.length) {
    const res = await db
      .select({ sid: sequenceEnrollments.sequence_id, status: sequenceEnrollments.status, n: sql<number>`count(*)::int` })
      .from(sequenceEnrollments)
      .where(and(inArray(sequenceEnrollments.sequence_id, rows.map((s) => s.id)), isNull(sequenceEnrollments.deleted_at)))
      .groupBy(sequenceEnrollments.sequence_id, sequenceEnrollments.status);
    for (const r of res) {
      const c = counts.get(r.sid!) ?? { active: 0, total: 0 };
      counts.set(r.sid!, c);
      c.total += Number(r.n);
      if (r.status === "active") c.active += Number(r.n);
    }
  }
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    status: s.status,
    steps: s.steps,
    enrollment_cap: s.enrollment_cap,
    exit_dispositions: s.exit_dispositions,
    owner_id: s.owner_id,
    active_enrollments: counts.get(s.id)?.active ?? 0,
    total_enrollments: counts.get(s.id)?.total ?? 0,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));
}

export async function saveSequence(db: Db, s: Sequence | null, data: SequenceIn, actor: CurrentUser): Promise<Sequence> {
  const values = {
    name: data.name,
    description: data.description ?? null,
    status: data.status,
    steps: data.steps.map((st) => ({ channel: st.channel, delay_days: st.delay_days, template: st.template ?? null })),
    enrollment_cap: data.enrollment_cap ?? null,
    exit_dispositions: data.exit_dispositions,
  };
  if (s === null) {
    s = await insert(db, sequences, { ...values, owner_id: actor.id, created_by_id: actor.id, updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "sequence.created", entity_type: "sequence", entity_id: s.id, summary: s.name,
      ip_address: actor.ip_address,
    });
  } else {
    const changes = audit.diff(s, values);
    s = await patch(db, sequences, s, { ...values, updated_by_id: actor.id });
    if (Object.keys(changes).length) {
      await audit.record(db, {
        actor, action: "sequence.updated", entity_type: "sequence", entity_id: s.id, changes,
        ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return s;
}

export async function enroll(
  db: Db,
  s: Sequence,
  personIds: string[],
  ownerId: string | null | undefined,
  actor: CurrentUser,
) {
  if (s.status !== "active") throw new HttpError(409, "Only active sequences accept enrollments");
  const steps = s.steps ?? [];
  if (!steps.length) throw new HttpError(422, "Add at least one step before enrolling people");
  const activeRows = await db
    .select({ person_id: sequenceEnrollments.person_id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.sequence_id, s.id),
        inArray(sequenceEnrollments.status, ["active", "paused"]),
        isNull(sequenceEnrollments.deleted_at),
      ),
    );
  const already = new Set(activeRows.map((r) => r.person_id));
  let active = activeRows.length;
  const ids = [...new Set(personIds.map((p) => p.toLowerCase()))];
  const known = await personNames(db, ids);
  const now = utcnow();
  const skipped: Array<{ person_id: string; reason: string }> = [];
  let enrolled = 0;
  for (const pid of ids) {
    if (already.has(pid)) {
      skipped.push({ person_id: pid, reason: "Already enrolled" });
      continue;
    }
    if (s.enrollment_cap && active >= s.enrollment_cap) {
      skipped.push({ person_id: pid, reason: `Enrollment cap of ${s.enrollment_cap} reached` });
      continue;
    }
    if (!known.has(pid)) {
      skipped.push({ person_id: pid, reason: "Person not found" });
      continue;
    }
    const blocked = await compliance.personSuppressionReasons(db, pid);
    if (blocked.length) {
      skipped.push({ person_id: pid, reason: blocked.slice(0, 2).join("; ") });
      continue;
    }
    await insert(db, sequenceEnrollments, {
      sequence_id: s.id, person_id: pid, owner_id: ownerId || actor.id, status: "active", current_step: 0,
      next_step_at: new Date(now.getTime() + Math.trunc(Number(steps[0].delay_days || 0)) * DAY), enrolled_at: now,
      created_by_id: actor.id, updated_by_id: actor.id,
    });
    active += 1;
    enrolled += 1;
  }
  await audit.record(db, {
    actor, action: "sequence.enrolled", entity_type: "sequence", entity_id: s.id,
    summary: `${enrolled} enrolled, ${skipped.length} skipped`, ip_address: actor.ip_address,
  });
  await db.commit();
  return { enrolled, skipped };
}

/** EnrollmentOut with sequence/person labels and the next step's channel. */
export async function enrollmentOuts(db: Db, rows: SequenceEnrollment[]) {
  const seqs = new Map<string, Sequence>();
  if (rows.length) {
    const found = await db.select().from(sequences).where(inArray(sequences.id, [...new Set(rows.map((r) => r.sequence_id!))]));
    for (const s of found) seqs.set(s.id, s);
  }
  const names = await personNames(db, rows.map((r) => r.person_id));
  return rows.map((r) => {
    const s = seqs.get(r.sequence_id!);
    const steps = s?.steps ?? [];
    return {
      id: r.id,
      sequence_id: r.sequence_id,
      sequence_name: s ? s.name : null,
      person_id: r.person_id,
      person_name: names.get(r.person_id!) ?? null,
      owner_id: r.owner_id,
      status: r.status,
      current_step: r.current_step,
      total_steps: steps.length,
      next_step_at: r.next_step_at,
      next_step_channel: r.status === "active" && r.current_step < steps.length ? (steps[r.current_step].channel ?? null) : null,
      enrolled_at: r.enrolled_at,
      exited_at: r.exited_at,
      exit_reason: r.exit_reason,
      last_step_at: r.last_step_at,
    };
  });
}

export async function getEnrollment(db: Db, enrollmentId: string): Promise<SequenceEnrollment> {
  const e = await get(db, sequenceEnrollments, enrollmentId);
  if (!e || e.deleted_at) throw new HttpError(404, "Enrollment not found");
  return e;
}

export async function exitEnrollment(db: Db, e: SequenceEnrollment, reason: string, actor: CurrentUser): Promise<SequenceEnrollment> {
  if (!["active", "paused"].includes(e.status)) throw new HttpError(409, `Enrollment is already ${e.status}`);
  await patch(db, sequenceEnrollments, e, {
    status: "exited", exited_at: utcnow(), exit_reason: reason, next_step_at: null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "sequence.enrollment_exited", entity_type: "sequence", entity_id: e.sequence_id, summary: reason,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

export async function advanceEnrollment(db: Db, e: SequenceEnrollment, actor: CurrentUser): Promise<SequenceEnrollment> {
  if (e.status !== "active") throw new HttpError(409, "Only active enrollments can advance");
  await advance(db, e, await getSequence(db, e.sequence_id!), utcnow());
  await patch(db, sequenceEnrollments, e, { updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "sequence.step_completed", entity_type: "sequence", entity_id: e.sequence_id,
    summary: `Step ${e.current_step}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

// --------------------------------------------------------------------------- daily queue

const days = (ms: number) => Math.max(0, Math.trunc(Math.floor(ms / DAY)));

interface QueueItemData {
  key: string;
  kind: string;
  title: string;
  subtitle: string | null;
  score: number;
  reasons: string[];
  due_at: Date | null;
  person_id: string | null;
  organization_id: string | null;
  property_id: string | null;
  opportunity_id: string | null;
  task_id: string | null;
  enrollment_id: string | null;
}

/** Finite, explainable daily action list. Every item carries the reasons it was prioritized. */
export async function buildQueue(db: Db, userId: string, limit: number) {
  const now = utcnow();
  const [start, end] = dayBounds(now);
  const items = new Map<string, QueueItemData>();
  const peopleInQueue = new Set<string>();

  const add = (key: string, item: Partial<QueueItemData> & { kind: string; title: string; score: number; reasons: string[] }) => {
    items.set(key, {
      subtitle: null, due_at: null, person_id: null, organization_id: null, property_id: null, opportunity_id: null,
      task_id: null, enrollment_id: null, ...item, key, score: Math.round(item.score * 10) / 10,
    });
    if (item.person_id) peopleInQueue.add(item.person_id);
  };

  // Tasks and follow-ups due today or overdue
  const due = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.deleted_at), eq(tasks.assignee_id, userId), inArray(tasks.status, OPEN_TASK),
        isNotNull(tasks.due_at), lt(tasks.due_at, end),
      ),
    )
    .orderBy(asc(tasks.due_at))
    .limit(200);
  for (const t of due) {
    const followUp = t.task_type === "follow_up";
    let score = 40.0 + (followUp ? 8 : 0);
    const reasons = followUp ? ["Follow-up you committed to"] : [];
    const dueAt = t.due_at!;
    if (dueAt < now) {
      const d = days(now.getTime() - dueAt.getTime());
      reasons.push(d ? `Overdue by ${d} day${plural(d)}` : "Overdue today");
      score += 25 + Math.min(20, ((now.getTime() - dueAt.getTime()) / 1000 / 86400) * 3);
    } else {
      reasons.push("Due today");
      score += 10;
    }
    if (t.priority === "urgent") {
      reasons.push("Urgent priority");
      score += 25;
    } else if (t.priority === "high") {
      reasons.push("High priority");
      score += 12;
    }
    if (t.escalation_level) {
      reasons.push(`Escalated (level ${t.escalation_level})`);
      score += 10;
    }
    const rel: Partial<QueueItemData> =
      t.related_type && ["person", "organization", "property", "opportunity"].includes(t.related_type)
        ? { [`${t.related_type}_id`]: t.related_id }
        : {};
    add(`task:${t.id}`, {
      kind: followUp ? "follow_up" : "task", title: t.title, subtitle: t.related_label, score, reasons, due_at: dueAt,
      task_id: t.id, ...rel,
    });
  }

  // Sequence steps due
  const seqRows = await db
    .select({ e: sequenceEnrollments, s: sequences })
    .from(sequenceEnrollments)
    .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequence_id))
    .where(
      and(
        eq(sequenceEnrollments.status, "active"), isNull(sequenceEnrollments.deleted_at), eq(sequences.status, "active"),
        lt(sequenceEnrollments.next_step_at, end),
        or(
          eq(sequenceEnrollments.owner_id, userId),
          and(isNull(sequenceEnrollments.owner_id), eq(sequences.owner_id, userId)),
        ),
      ),
    )
    .orderBy(asc(sequenceEnrollments.next_step_at))
    .limit(200);
  for (const { e, s } of seqRows) {
    const steps = s.steps ?? [];
    if (e.current_step >= steps.length) continue;
    const step = steps[e.current_step];
    let score = 35.0;
    const reasons = [`Step ${e.current_step + 1} of ${steps.length} in sequence “${s.name}” (${label(step.channel)})`];
    if (e.next_step_at && e.next_step_at < start) {
      reasons.push(`Step was due ${strftime(e.next_step_at, "%b %d")}`);
      score += 15;
    }
    add(`seq:${e.id}`, {
      kind: "sequence_step", title: `${capitalize(label(step.channel))} step`, subtitle: s.name, score, reasons,
      due_at: e.next_step_at, person_id: e.person_id, enrollment_id: e.id,
    });
  }

  // Stalled negotiations
  const stalled = await db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.owner_id, userId), inArray(opportunities.stage, STALLED_STAGES),
        or(lt(opportunities.next_action_at, now), lt(opportunities.stage_entered_at, new Date(now.getTime() - 14 * DAY))),
        isNull(opportunities.deleted_at),
      ),
    )
    .limit(100);
  for (const o of stalled) {
    let score = 50.0;
    const reasons: string[] = [];
    if (o.stage_entered_at && o.stage_entered_at < new Date(now.getTime() - 14 * DAY)) {
      const d = days(now.getTime() - o.stage_entered_at.getTime());
      reasons.push(`In ${label(o.stage)} for ${d} days without moving forward`);
      score += Math.min(25, d - 14);
    }
    if (o.next_action_at && o.next_action_at < now) {
      reasons.push(
        `Next action overdue since ${strftime(o.next_action_at, "%b %d")}` + (o.next_action ? `: ${o.next_action}` : ""),
      );
      score += 15;
    }
    if (["high", "urgent"].includes(o.priority || "")) {
      reasons.push("High-priority deal");
      score += 10;
    }
    add(`opp:${o.id}`, {
      kind: "stalled_deal", title: o.title, subtitle: capitalize(label(o.stage)), score, reasons, due_at: o.next_action_at,
      opportunity_id: o.id, property_id: o.property_id, person_id: o.primary_person_id,
      organization_id: o.primary_organization_id,
    });
  }

  // People with a due next action, then relationship recency
  const pbase = and(eq(people.owner_id, userId), isNull(people.deleted_at));
  const dueNext = await db
    .select()
    .from(people)
    .where(and(pbase, lt(people.next_action_at, end)))
    .orderBy(asc(people.next_action_at))
    .limit(100);
  for (const p of dueNext) {
    if (peopleInQueue.has(p.id)) continue;
    let score = 45.0;
    let reasons: string[];
    const nextAt = p.next_action_at!;
    if (nextAt < start) {
      const d = Math.max(1, days(now.getTime() - nextAt.getTime()));
      reasons = [`Next action overdue by ${d} day${plural(d)}`];
      score += 15 + Math.min(15, d * 2);
    } else {
      reasons = ["Next action due today"];
    }
    add(`person:${p.id}`, {
      kind: "person_due", title: personName(p), subtitle: p.title, score, reasons, due_at: nextAt, person_id: p.id,
    });
  }
  const cutoff = new Date(now.getTime() - 90 * DAY);
  const cold = await db
    .select()
    .from(people)
    .where(and(pbase, lt(people.last_touch_at, cutoff)))
    .orderBy(asc(people.last_touch_at))
    .limit(60);
  for (const p of cold) {
    if (peopleInQueue.has(p.id)) continue;
    const d = days(now.getTime() - p.last_touch_at!.getTime());
    let score = 25.0 + Math.min(15, ((d - 90) / 30) * 3);
    const reasons = [`No touch in ${d} days`];
    if (["strong", "high", "5", "4"].includes(String(p.relationship_strength ?? "").toLowerCase())) {
      reasons.push("Strong relationship going cold");
      score += 10;
    }
    add(`recency:${p.id}`, {
      kind: "relationship", title: personName(p), subtitle: p.title, score, reasons, due_at: null, person_id: p.id,
    });
  }

  // Fill person names for sequence steps
  const names = await personNames(db, [...items.values()].filter((i) => i.kind === "sequence_step").map((i) => i.person_id));
  for (const i of items.values()) {
    if (i.kind === "sequence_step" && i.person_id && names.has(i.person_id)) i.title = `${i.title}: ${names.get(i.person_id)}`;
  }

  const ordered = [...items.values()].sort((a, b) => b.score - a.score);
  const [ia] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(interactions)
    .where(and(eq(interactions.logged_by_id, userId), gte(interactions.created_at, start), isNull(interactions.deleted_at)));
  const [ta] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.completed_by_id, userId), eq(tasks.status, "done"), gte(tasks.completed_at, start)));
  const doneToday = Number(ia?.n ?? 0) + Number(ta?.n ?? 0);
  return { items: ordered.slice(0, limit), cap: limit, total_candidates: ordered.length, done_today: Math.trunc(doneToday) };
}

// --------------------------------------------------------------------------- pre-call context

export async function personContext(db: Db, personId: string) {
  const now = utcnow();
  const p = await get(db, people, personId);
  if (!p || p.deleted_at) throw new HttpError(404, "Person not found");
  const person: Record<string, any> = {
    id: p.id, first_name: p.first_name, last_name: p.last_name, full_name: personName(p), title: p.title,
    primary_email: p.primary_email, primary_phone: p.primary_phone, mailing_address: p.mailing_address, city: p.city,
    state: p.state, contact_preferences: p.contact_preferences, owner_id: p.owner_id, last_touch_at: p.last_touch_at,
    next_action_at: p.next_action_at, relationship_strength: p.relationship_strength, tags: p.tags,
  };

  const organizations_ = await raw<Record<string, any>>(
    db,
    sql`select o.id, o.name, a.role, a.title, a.is_current
        from affiliations a join organizations o on o.id = a.organization_id
        where a.person_id = ${personId} limit 25`,
  );

  const orgIds = organizations_.map((o) => o.id as string);
  const ownerCond = orgIds.length
    ? sql`((oi.owner_kind = 'person' and oi.owner_person_id = ${personId}) or
           (oi.owner_kind = 'organization' and oi.owner_organization_id in (${idList(orgIds)})))`
    : sql`(oi.owner_kind = 'person' and oi.owner_person_id = ${personId})`;
  const propRows = await raw<Record<string, any>>(
    db,
    sql`select p.id, p.name, p.address_line, p.city, p.state, p.property_type, p.status, oi.role, oi.interest_pct
        from properties p join ownership_interests oi on oi.property_id = p.id
        where ${ownerCond} and p.deleted_at is null limit 25`,
  );
  const properties_: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const r of propRows) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      properties_.push({ ...r, interest_pct: r.interest_pct === null || r.interest_pct === undefined ? null : Number(r.interest_pct) });
    }
  }

  const opps = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.primary_person_id, personId), isNull(opportunities.deleted_at)))
    .limit(10);
  const opportunities_ = opps.map((o) => ({
    id: o.id, title: o.title, stage: o.stage, stage_entered_at: o.stage_entered_at, next_action: o.next_action,
    next_action_at: o.next_action_at, property_id: o.property_id, price_expectation: o.price_expectation,
    priority: o.priority,
  }));

  const recent = await db
    .select()
    .from(interactions)
    .where(and(eq(interactions.person_id, personId), isNull(interactions.deleted_at)))
    .orderBy(desc(interactions.occurred_at))
    .limit(10);

  const relatedIds = [personId, ...opportunities_.map((o) => o.id)];
  const openTasks = await db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deleted_at), inArray(tasks.status, OPEN_TASK), inArray(tasks.related_id, relatedIds)))
    .orderBy(sql`${tasks.due_at} asc nulls last`)
    .limit(20);
  const open_tasks = openTasks.map((t) => ({
    id: t.id, title: t.title, due_at: t.due_at, priority: t.priority, status: t.status, task_type: t.task_type,
  }));

  const enrollments = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.person_id, personId),
        inArray(sequenceEnrollments.status, ["active", "paused"]),
        isNull(sequenceEnrollments.deleted_at),
      ),
    );

  const contacts: Array<{ kind: string; label: string | null; value: string; channels: any[] }> = [];
  for (const [kind, value, lbl] of await compliance.personContactValues(db, personId)) {
    const chans = kind === "email" ? ["email"] : ["phone", "sms"];
    const channels = [];
    for (const ch of chans) channels.push(await compliance.statusFor(db, ch, value));
    contacts.push({ kind, label: lbl, value, channels });
  }
  const suppression = await compliance.personSuppressionReasons(db, personId);

  const points: string[] = [];
  if (recent.length) {
    const last = recent[0];
    points.push(
      `Last touch ${strftime(last.occurred_at, "%b %d, %Y")} by ${label(last.channel)}` +
        (last.disposition ? ` (${label(last.disposition)})` : "") +
        (last.summary ? `: ${last.summary.slice(0, 160)}` : ""),
    );
    const committed = recent.find((i) => i.next_action && !i.loop_closed);
    if (committed) {
      points.push(
        `Committed next step: ${committed.next_action}` +
          (committed.next_action_at ? ` (due ${strftime(committed.next_action_at, "%b %d")})` : ""),
      );
    }
  } else {
    points.push("No logged interactions yet — introduce yourself and confirm the best contact channel");
  }
  for (const o of opportunities_.slice(0, 3)) {
    const since = o.stage_entered_at ? ` since ${strftime(o.stage_entered_at, "%b %d")}` : "";
    const price = o.price_expectation
      ? `; price expectation $${Math.round(o.price_expectation).toLocaleString("en-US")}`
      : "";
    points.push(`Deal “${o.title}” is in ${label(o.stage)}${since}${price}`);
  }
  if (properties_.length) {
    const nm = properties_.slice(0, 3).map((pp) => pp.name || pp.address_line || "").join(", ");
    points.push(`Linked to ${properties_.length} propert${properties_.length !== 1 ? "ies" : "y"}: ${nm}`);
  }
  if (person.last_touch_at && person.last_touch_at < new Date(now.getTime() - 90 * DAY)) {
    points.push(`Relationship has gone ${days(now.getTime() - person.last_touch_at.getTime())} days without a touch`);
  }
  if (contacts.length && !contacts.some((c) => c.channels.some((ch) => ch.allowed))) {
    points.push("Every phone and email is currently blocked by compliance — do not contact");
  }

  return {
    person,
    organizations: organizations_,
    properties: properties_,
    opportunities: opportunities_,
    interactions: await interactionOuts(db, recent),
    open_tasks,
    enrollments: await enrollmentOuts(db, enrollments),
    contacts,
    suppression_reasons: suppression,
    talking_points: points,
  };
}

// --------------------------------------------------------------------------- manager view

export async function teamActivity(db: Db, dateFrom: Date, dateTo: Date, teamId?: string | null) {
  const now = utcnow();
  const usrs = await db
    .select()
    .from(users)
    .where(and(isNull(users.deleted_at), eq(users.status, "active"), eq(users.is_service, false), teamId ? eq(users.team_id, teamId) : undefined));
  const byId = new Map(usrs.map((u) => [u.id, u]));
  const uids = usrs.map((u) => u.id);

  const rows = new Map<string, any>();
  const row = (uid: string) => {
    let r = rows.get(uid);
    if (!r) {
      r = {
        user_id: uid, user_name: byId.get(uid)!.full_name, total: 0, meaningful: 0, by_channel: {}, by_disposition: {},
        overdue_follow_ups: 0, stale_records: 0, untouched_records: 0,
      };
      rows.set(uid, r);
    }
    return r;
  };

  const overdueCond = and(
    isNull(tasks.deleted_at), inArray(tasks.status, OPEN_TASK), lt(tasks.due_at, now),
    or(eq(tasks.task_type, "follow_up"), eq(tasks.source, "outreach")),
    uids.length ? inArray(tasks.assignee_id, uids) : sql`false`,
  );

  if (uids.length) {
    const res = await db
      .select({
        uid: interactions.logged_by_id, channel: interactions.channel, disposition: interactions.disposition,
        meaningful: interactions.is_meaningful, n: sql<number>`count(*)::int`,
      })
      .from(interactions)
      .where(
        and(
          isNull(interactions.deleted_at), gte(interactions.occurred_at, dateFrom), lte(interactions.occurred_at, dateTo),
          inArray(interactions.logged_by_id, uids),
        ),
      )
      .groupBy(interactions.logged_by_id, interactions.channel, interactions.disposition, interactions.is_meaningful);
    for (const r of res) {
      const out = row(r.uid!);
      const n = Number(r.n);
      out.total += n;
      out.meaningful += r.meaningful ? n : 0;
      out.by_channel[r.channel] = (out.by_channel[r.channel] ?? 0) + n;
      if (r.disposition) out.by_disposition[r.disposition] = (out.by_disposition[r.disposition] ?? 0) + n;
    }

    const od = await db
      .select({ uid: tasks.assignee_id, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(overdueCond)
      .groupBy(tasks.assignee_id);
    for (const r of od) row(r.uid!).overdue_follow_ups = Number(r.n);

    const pbase = [inArray(people.owner_id, uids), isNull(people.deleted_at)];
    const stale = await db
      .select({ uid: people.owner_id, n: sql<number>`count(*)::int` })
      .from(people)
      .where(and(...pbase, lt(people.last_touch_at, new Date(now.getTime() - 90 * DAY))))
      .groupBy(people.owner_id);
    for (const r of stale) row(r.uid!).stale_records = Number(r.n);
    const untouched = await db
      .select({ uid: people.owner_id, n: sql<number>`count(*)::int` })
      .from(people)
      .where(and(...pbase, isNull(people.last_touch_at)))
      .groupBy(people.owner_id);
    for (const r of untouched) row(r.uid!).untouched_records = Number(r.n);
  }

  const overdue = uids.length
    ? await db.select().from(tasks).where(overdueCond).orderBy(asc(tasks.due_at)).limit(50)
    : [];
  const overdueItems = overdue.map((t) => ({
    id: t.id, title: t.title, due_at: t.due_at, assignee_id: t.assignee_id,
    assignee_name: t.assignee_id && byId.has(t.assignee_id) ? byId.get(t.assignee_id)!.full_name : null,
    related_type: t.related_type, related_id: t.related_id, related_label: t.related_label,
  }));
  return {
    date_from: dateFrom,
    date_to: dateTo,
    rows: [...rows.values()].sort((a, b) => b.total - a.total || (a.user_name < b.user_name ? -1 : a.user_name > b.user_name ? 1 : 0)),
    overdue: overdueItems,
  };
}
