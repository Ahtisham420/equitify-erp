import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { applySearch, applySort, facetCounts, inFilter, page, paginate } from "../../common/query";
import { created, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { utcnow } from "../../core/security";
import type { CurrentUser } from "../../core/deps";
import {
  CHANNELS,
  DIRECTIONS,
  DISPOSITIONS,
  ENROLLMENT_STATUSES,
  MEANINGFUL_CHANNELS,
  MEANINGFUL_DISPOSITIONS,
  SEQUENCE_STATUSES,
  interactions,
  sequenceEnrollments,
  sequences,
} from "./schema";
import { enrollIn, exitIn, interactionCreate, interactionUpdate, sequenceIn } from "./schemas";
import * as service from "./service";

export const router = new Router();

const SORTS = {
  occurred_at: interactions.occurred_at, channel: interactions.channel, disposition: interactions.disposition,
  next_action_at: interactions.next_action_at,
};

const startOfDay = (d: string) => new Date(`${d}T00:00:00.000Z`);
const endOfDay = (d: string) => new Date(`${d}T23:59:59.999Z`);

function interactionFilters(ctx: Ctx, user: CurrentUser, skip?: string): service.InteractionFilters {
  const q = ctx.query;
  const from = q.date("date_from");
  const to = q.date("date_to");
  return {
    actor_id: user.id,
    q: q.str("q", { max: 200 }),
    channel: q.strs("channel"),
    direction: q.strs("direction"),
    disposition: q.strs("disposition"),
    person_id: q.uuid("person_id"),
    organization_id: q.uuid("organization_id"),
    property_id: q.uuid("property_id"),
    opportunity_id: q.uuid("opportunity_id"),
    logged_by: q.strs("logged_by"),
    date_from: from ? startOfDay(from) : undefined,
    date_to: to ? endOfDay(to) : undefined,
    meaningful: q.bool("meaningful"),
    skip: skip ? new Set([skip]) : undefined,
  };
}

// --------------------------------------------------------------------------- interactions

router.get("/interactions", async (ctx) => {
  const user = await ctx.require("outreach", "view");
  const p = ctx.listParams();
  const [items, total] = await paginate(
    ctx.db, interactions, service.interactionWhere(interactionFilters(ctx, user)),
    applySort(p.sort, SORTS, desc(interactions.occurred_at)), p,
  );
  return page(await service.interactionOuts(ctx.db, items), total, p);
});

router.get("/interactions/facets", async (ctx) => {
  const user = await ctx.require("outreach", "view");
  const w = (skip: string) => service.interactionWhere(interactionFilters(ctx, user, skip));
  return {
    channel: await facetCounts(ctx.db, interactions, w("channel"), interactions.channel),
    direction: await facetCounts(ctx.db, interactions, w("direction"), interactions.direction),
    disposition: await facetCounts(ctx.db, interactions, w("disposition"), interactions.disposition),
  };
});

router.get("/interactions/meta", async (ctx) => {
  await ctx.require("outreach", "view");
  return {
    channels: CHANNELS, directions: DIRECTIONS, dispositions: DISPOSITIONS,
    meaningful_dispositions: [...MEANINGFUL_DISPOSITIONS].sort(), meaningful_channels: [...MEANINGFUL_CHANNELS].sort(),
    sequence_statuses: SEQUENCE_STATUSES, enrollment_statuses: ENROLLMENT_STATUSES,
  };
});

/** Logs a touchpoint. Outbound calls/texts/emails are checked against compliance first (422 with reasons). */
router.post("/interactions", async (ctx) => {
  const user = await ctx.require("outreach", "create");
  const it = await service.logInteraction(ctx.db, await ctx.body(interactionCreate), user);
  return created((await service.interactionOuts(ctx.db, [it]))[0]);
});

router.get("/interactions/{interaction_id}", async (ctx) => {
  await ctx.require("outreach", "view");
  return (await service.interactionOuts(ctx.db, [await service.getInteraction(ctx.db, ctx.uuid("interaction_id"))]))[0];
});

router.patch("/interactions/{interaction_id}", async (ctx) => {
  const user = await ctx.require("outreach", "edit");
  const body = await ctx.body(interactionUpdate);
  const it = await service.updateInteraction(ctx.db, await service.getInteraction(ctx.db, ctx.uuid("interaction_id")), body, user);
  return (await service.interactionOuts(ctx.db, [it]))[0];
});

router.delete("/interactions/{interaction_id}", async (ctx) => {
  const user = await ctx.require("outreach", "delete");
  await service.archiveInteraction(ctx.db, await service.getInteraction(ctx.db, ctx.uuid("interaction_id")), user);
  return noContent();
});

// --------------------------------------------------------------------------- daily queue

/** The current user's capped, prioritized action list; each item explains why it is here. */
router.get("/queue", async (ctx) => {
  const user = await ctx.require("outreach", "view");
  return service.buildQueue(ctx.db, user.id, ctx.query.int("limit", { ge: 5, le: 100 }) ?? 40);
});

router.get("/queue/context/{person_id}", async (ctx) => {
  await ctx.require("outreach", "view");
  const out = await service.personContext(ctx.db, ctx.uuid("person_id"));
  await ctx.db.commit(); // compliance settings may be initialised lazily
  return out;
});

/** Manager view: activity per user, overdue follow-ups and stale/untouched records. */
router.get("/outreach/team-activity", async (ctx) => {
  await ctx.require("outreach", "approve");
  const from = ctx.query.date("date_from");
  const to = ctx.query.date("date_to");
  const teamId = ctx.query.uuid("team_id");
  const end = to ? endOfDay(to) : utcnow();
  const start = from ? startOfDay(from) : new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  return service.teamActivity(ctx.db, start, end, teamId);
});

// --------------------------------------------------------------------------- sequences

router.get("/sequences", async (ctx) => {
  await ctx.require("outreach", "view");
  const rows = await ctx.db
    .select()
    .from(sequences)
    .where(
      and(
        isNull(sequences.deleted_at),
        applySearch(ctx.query.str("q"), [sequences.name, sequences.description]),
        inFilter(sequences.status, ctx.query.strs("status")),
      ),
    )
    .orderBy(asc(sequences.name));
  return service.sequenceOuts(ctx.db, rows);
});

router.post("/sequences", async (ctx) => {
  const user = await ctx.require("outreach", "create");
  const body = await ctx.body(sequenceIn);
  return created((await service.sequenceOuts(ctx.db, [await service.saveSequence(ctx.db, null, body, user)]))[0]);
});

router.get("/sequences/{sequence_id}", async (ctx) => {
  await ctx.require("outreach", "view");
  return (await service.sequenceOuts(ctx.db, [await service.getSequence(ctx.db, ctx.uuid("sequence_id"))]))[0];
});

router.patch("/sequences/{sequence_id}", async (ctx) => {
  const user = await ctx.require("outreach", "edit");
  const body = await ctx.body(sequenceIn);
  const s = await service.saveSequence(ctx.db, await service.getSequence(ctx.db, ctx.uuid("sequence_id")), body, user);
  return (await service.sequenceOuts(ctx.db, [s]))[0];
});

/** Enrolls people, respecting the sequence's enrollment cap and each person's suppression state. */
router.post("/sequences/{sequence_id}/enroll", async (ctx) => {
  const user = await ctx.require("outreach", "create");
  const body = await ctx.body(enrollIn);
  const s = await service.getSequence(ctx.db, ctx.uuid("sequence_id"));
  return service.enroll(ctx.db, s, body.person_ids, body.owner_id, user);
});

router.get("/sequence-enrollments", async (ctx) => {
  await ctx.require("outreach", "view");
  const p = ctx.listParams();
  const t = sequenceEnrollments;
  const sequence_id = ctx.query.uuid("sequence_id");
  const person_id = ctx.query.uuid("person_id");
  const where = and(
    isNull(t.deleted_at),
    sequence_id ? eq(t.sequence_id, sequence_id) : undefined,
    person_id ? eq(t.person_id, person_id) : undefined,
    inFilter(t.status, ctx.query.strs("status")),
  );
  const sorts = { enrolled_at: t.enrolled_at, next_step_at: t.next_step_at, status: t.status };
  const [items, total] = await paginate(ctx.db, t, where, applySort(p.sort, sorts, desc(t.enrolled_at)), p);
  return page(await service.enrollmentOuts(ctx.db, items), total, p);
});

router.post("/sequence-enrollments/{enrollment_id}/exit", async (ctx) => {
  const user = await ctx.require("outreach", "edit");
  const body = await ctx.body(exitIn);
  const e = await service.exitEnrollment(ctx.db, await service.getEnrollment(ctx.db, ctx.uuid("enrollment_id")), body.reason, user);
  return (await service.enrollmentOuts(ctx.db, [e]))[0];
});

/** Marks the current step done (without logging an interaction) and schedules the next one. */
router.post("/sequence-enrollments/{enrollment_id}/advance", async (ctx) => {
  const user = await ctx.require("outreach", "edit");
  const e = await service.advanceEnrollment(ctx.db, await service.getEnrollment(ctx.db, ctx.uuid("enrollment_id")), user);
  return (await service.enrollmentOuts(ctx.db, [e]))[0];
});
