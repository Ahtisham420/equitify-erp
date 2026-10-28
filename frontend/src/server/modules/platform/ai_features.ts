/**
 * Claude-powered assistive features (Release 6): natural-language property search (spec 33) and
 * conversation intelligence — interaction summaries, commitments, suggested next actions and pre-call
 * talking points (spec 28).
 *
 * Rules: AI output is never authoritative. NL search returns structured records plus the interpreted
 * filters; conversation output is stored as pending `ai_suggestions` that a named user must accept.
 * Every provider call is written to `ai_calls` via documents/ai.loggedCall. Without a configured
 * provider everything degrades to the existing manual behaviour.
 */
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { applySort, paginate } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import type { ListParams } from "../../core/router";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch } from "../../db/orm";
import * as ai from "../documents/ai";
import { PROPERTY_STATUSES, PROPERTY_TYPES, properties } from "../properties/schema";
import { buildWhere } from "../properties/service";
import type { PropertyFilters } from "../properties/service";
import { aiSuggestions, type AISuggestion } from "./schema";
import { nlFilters, type AcceptIn, type NLFilters } from "./schemas";

type Json = Record<string, any>;

const NULL = { type: "null" };
const nullable = (schema: Json): Json => ({ anyOf: [schema, NULL] });
const obj = (props: Json): Json => ({
  type: "object", properties: props, required: Object.keys(props), additionalProperties: false,
});

const errName = (e: unknown) => (e as any)?.constructor?.name ?? "Error";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Python `str.capitalize()`: first character upper, the rest lower. */
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const isoDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

// Same sortable columns as the properties list endpoint (properties/router.ts keeps its map private).
const t = properties;
const SORTS = {
  name: t.name, address_line: t.address_line, city: t.city, property_type: t.property_type, status: t.status,
  building_area_sf: t.building_area_sf, land_area_acres: t.land_area_acres, asking_price: t.asking_price,
  year_built: t.year_built, completeness_score: t.completeness_score, updated_at: t.updated_at, created_at: t.created_at,
};
const LIST_COLUMNS = [
  "id", "name", "address_line", "city", "state", "county", "property_type", "status", "building_area_sf",
  "land_area_acres", "asking_price", "occupancy_pct", "year_built", "completeness_score", "tags", "updated_at",
] as const;
const pickListItem = (row: Record<string, any>) => Object.fromEntries(LIST_COLUMNS.map((c) => [c, row[c]]));

/** The active provider if it supports schema-constrained JSON calls, else null (degraded mode). */
function structuredProvider(): any {
  const p: any = ai.getProvider();
  return p.available && typeof p.structured === "function" ? p : null;
}

export const suggestionOut = (s: AISuggestion) => ({
  id: s.id,
  source_type: s.source_type,
  source_id: s.source_id,
  kind: s.kind,
  content: s.content,
  details: s.details,
  status: s.status,
  provider: s.provider,
  model: s.model,
  decided_by_id: s.decided_by_id,
  decided_at: s.decided_at,
  task_id: s.task_id,
  created_at: s.created_at,
});

// --- Natural-language property query -------------------------------------------------------------

function nlSchema(): Json {
  const num = { type: "number" };
  const integer = { type: "integer" };
  const string = { type: "string" };
  const names = Object.keys(SORTS).sort();
  const sorts = [...names, ...names.map((s) => `-${s}`)];
  const filters = obj({
    q: nullable(string),
    status: nullable({ type: "array", items: { type: "string", enum: [...PROPERTY_STATUSES] } }),
    property_type: nullable({ type: "array", items: { type: "string", enum: [...PROPERTY_TYPES] } }),
    state: nullable({ type: "array", items: string }),
    county: nullable(string),
    city: nullable(string),
    tag: nullable({ type: "array", items: string }),
    min_area: nullable(num), max_area: nullable(num),
    min_acres: nullable(num), max_acres: nullable(num),
    min_price: nullable(num), max_price: nullable(num),
    min_year: nullable(integer), max_year: nullable(integer),
    min_completeness: nullable(num),
    near_lat: nullable(num), near_lng: nullable(num), radius_miles: nullable(num),
    sort: nullable({ type: "string", enum: sorts }),
  });
  return obj({ filters, unmapped: { type: "array", items: string } });
}

const NL_GUIDE = `Translate the user's question into a structured property search. Use ONLY these filters:
- q: free-text keywords matched against name, address, city, county and corridor (use sparingly, only for names/streets)
- status: tracked | pursued | rejected | owned | managed | listed | sold
- property_type: retail | stnl (single-tenant net lease) | multi_tenant_retail | gas_convenience | medical | office | industrial | multifamily | hospitality | ground_lease | land | mixed_use | other
- state: two-letter US state codes (e.g. TX); county / city: names
- tag: record tags
- min_area / max_area: building area in square feet; min_acres / max_acres: land area in acres
- min_price / max_price: asking price in US dollars (expand "2.5M" to 2500000)
- min_year / max_year: year built; min_completeness: data completeness 0-100
- near_lat / near_lng / radius_miles: only when the question gives explicit coordinates
- sort: a field name, prefix with "-" for descending (e.g. "-asking_price")
Set every filter you do not need to null. Never invent values. List each part of the question that these
filters cannot express (owner names, signals, debt, lease terms, etc.) in \`unmapped\`, verbatim and short.`;

function cleanFilters(raw: Json | null | undefined): [NLFilters, string[]] {
  const data: Json = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)),
  );
  const dropped: string[] = [];
  for (const [key, allowed] of [["status", PROPERTY_STATUSES], ["property_type", PROPERTY_TYPES]] as const) {
    if (key in data) {
      const allowedList = allowed as readonly string[];
      const values: string[] = data[key];
      const kept = values.filter((v) => allowedList.includes(v));
      dropped.push(...values.filter((v) => !allowedList.includes(v)).map((v) => `${key}=${v}`));
      if (kept.length) data[key] = kept;
      else data[key] = null;
    }
  }
  if ("state" in data) data.state = (data.state as unknown[]).map((s) => String(s).toUpperCase().slice(0, 2));
  if (data.sort && !(String(data.sort).replace(/^-+/, "") in SORTS)) {
    dropped.push(`sort=${data.sort}`);
    delete data.sort;
  }
  for (let i = 0; i <= Object.keys(data).length; i++) {
    const r = nlFilters.safeParse(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)));
    if (r.success) return [r.data, dropped];
    const bad = new Set(r.error.issues.filter((e) => e.path.length).map((e) => String(e.path[0])));
    if (!bad.size) break;
    dropped.push(...[...bad].map((b) => `${b}=${data[b]}`));
    for (const b of bad) delete data[b];
  }
  return [{}, dropped];
}

export async function nlQuery(db: Db, question: string, page: number, page_size: number, user: CurrentUser) {
  const provider = structuredProvider();
  let message: string | null = null;
  let unmapped: string[] = [];
  let aiUsed = false;
  let filters: NLFilters = {};
  if (provider === null) {
    filters = { q: question };
    message = "AI search is not configured on this workspace; ran a keyword search instead.";
  } else {
    const prompt = `${NL_GUIDE}\n\nQuestion: ${question}`;
    await db.commit(); // no DB transaction held open across the provider call
    try {
      const result: Json = await ai.loggedCall(db, provider, {
        purpose: "nl_query",
        prompt_parts: ["nl_query", question],
        call: () => provider.structured({ prompt, schema: nlSchema(), effort: "low" }),
        actor_id: user.id,
        summarize_output: (r: Json) => ({ filters: r.filters, unmapped: r.unmapped }),
      });
      let dropped: string[];
      [filters, dropped] = cleanFilters(result.filters ?? {});
      unmapped = [...((result.unmapped ?? []) as unknown[]).map((u) => String(u).slice(0, 200)).slice(0, 10), ...dropped];
      aiUsed = true;
    } catch (exc) {
      // AI never blocks the user path
      filters = { q: question };
      message = `AI search is unavailable right now (${errName(exc)}); ran a keyword search instead.`;
    }
    await db.commit();
  }

  const values: Json = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== null && v !== undefined));
  const sort: string | undefined = values.sort;
  delete values.sort;
  const params: ListParams = { q: undefined, page, page_size, sort: undefined };
  const [rows, total] = await paginate(
    db, properties, buildWhere(values as PropertyFilters), applySort(sort, SORTS, desc(t.updated_at)), params,
  );
  return {
    question,
    ai_used: aiUsed,
    provider: ai.getProvider().name,
    message,
    filters: toJsonable({ ...values, ...(sort ? { sort } : {}) }),
    unmapped,
    items: rows.map(pickListItem),
    total,
    page,
    page_size,
  };
}

// --- Conversation intelligence -------------------------------------------------------------------

async function loadInteraction(db: Db, interactionId: string): Promise<any> {
  const { interactions } = await import("../outreach/schema");
  const it: any = await get(db, interactions, interactionId);
  if (!it || it.deleted_at) throw new HttpError(404, "Interaction not found");
  return it;
}

export async function listSuggestions(db: Db, sourceType: string, sourceId: string, includeClosed = true): Promise<AISuggestion[]> {
  const s = aiSuggestions;
  return db
    .select()
    .from(s)
    .where(and(
      eq(s.source_type, sourceType), eq(s.source_id, sourceId), isNull(s.deleted_at), ne(s.status, "superseded"),
      includeClosed ? undefined : eq(s.status, "pending"),
    ))
    .orderBy(desc(s.created_at), asc(s.kind));
}

const SUMMARY_SCHEMA = obj({
  summary: { type: "string" },
  commitments: {
    type: "array",
    items: obj({
      text: { type: "string" },
      party: { type: "string", enum: ["us", "them", "both", "unclear"] },
      due_hint: nullable({ type: "string" }),
    }),
  },
  next_actions: {
    type: "array",
    items: obj({
      title: { type: "string" },
      due_in_days: nullable({ type: "integer" }),
      rationale: { type: "string" },
    }),
  },
});

export async function summarizeInteraction(db: Db, interactionId: string, user: CurrentUser) {
  const { people } = await import("../contacts/schema");
  const it = await loadInteraction(db, interactionId);
  const provider = structuredProvider();
  const existing = await listSuggestions(db, "interaction", it.id);
  if (provider === null) {
    return {
      ai_used: false, provider: ai.getProvider().name, suggestions: existing.map(suggestionOut),
      message: "AI summaries are not configured on this workspace. Log commitments and next actions manually.",
    };
  }
  const notes = [it.subject, it.summary].filter(Boolean).join("\n");
  if (!notes.trim()) {
    return {
      ai_used: false, provider: provider.name, suggestions: existing.map(suggestionOut),
      message: "This interaction has no notes to summarize.",
    };
  }

  const person: any = it.person_id ? await get(db, people, it.person_id) : null;
  const prop = it.property_id ? await get(db, properties, it.property_id) : null;
  const context = {
    channel: it.channel, direction: it.direction, occurred_at: (it.occurred_at as Date).toISOString(),
    disposition: it.disposition, contact: person ? person.full_name : null,
    property: prop ? prop.name || prop.address_line : null,
    logged_next_action: it.next_action,
  };
  const prompt =
    "Summarize this logged CRE outreach interaction for the deal team. Then list the explicit commitments " +
    "made (who committed: us = our team, them = the contact) and suggest concrete next actions with a due " +
    "date offset in days when the notes imply one. Use only what the notes say; if there are no commitments " +
    "or actions, return empty lists. Suggestions will be reviewed by a person before anything happens.\n\n" +
    `Context: ${JSON.stringify(context)}\n\n<notes>\n${notes.slice(0, 50_000)}\n</notes>`;
  await db.commit(); // no DB transaction held open across the provider call
  let result: Json;
  try {
    result = await ai.loggedCall(db, provider, {
      purpose: "interaction_summary",
      prompt_parts: ["interaction_summary", String(it.id), notes],
      call: () => provider.structured({ prompt, schema: SUMMARY_SCHEMA, effort: "medium" }),
      actor_id: user.id,
      summarize_output: (r: Json) => ({
        commitments: (r.commitments ?? []).length, next_actions: (r.next_actions ?? []).length,
      }),
    });
  } catch (exc) {
    await db.commit();
    return {
      ai_used: false, provider: provider.name, suggestions: existing.map(suggestionOut),
      message: `The AI provider could not summarize this interaction (${errName(exc)}).`,
    };
  }

  for (const s of existing) {
    if (s.status === "pending") await patch(db, aiSuggestions, s, { status: "superseded", updated_by_id: user.id });
  }
  const common = {
    source_type: "interaction", source_id: it.id as string, status: "pending", provider: provider.name as string,
    model: provider.model as string, created_by_id: user.id, updated_by_id: user.id,
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (str(result.summary).trim()) {
    await insert(db, aiSuggestions, { kind: "summary", content: result.summary.trim(), details: {}, ...common });
  }
  for (const c of ((result.commitments ?? []) as unknown[]).slice(0, 20) as Json[]) {
    if (c && typeof c === "object" && str(c.text).trim()) {
      await insert(db, aiSuggestions, {
        kind: "commitment", content: c.text.trim(), details: { party: c.party ?? null, due_hint: c.due_hint ?? null }, ...common,
      });
    }
  }
  for (const a of ((result.next_actions ?? []) as unknown[]).slice(0, 10) as Json[]) {
    if (a && typeof a === "object" && str(a.title).trim()) {
      const days = a.due_in_days;
      await insert(db, aiSuggestions, {
        kind: "next_action",
        content: a.title.trim().slice(0, 300),
        details: {
          due_in_days: Number.isInteger(days) && days >= 0 && days <= 365 ? days : null,
          rationale: a.rationale ?? null,
        },
        ...common,
      });
    }
  }
  await audit.record(db, {
    actor: user, action: "interaction.ai_summarized", entity_type: "interaction", entity_id: it.id,
    summary: `AI suggestions by ${provider.name}/${provider.model}`, ip_address: user.ip_address,
  });
  await db.commit();
  return {
    ai_used: true, provider: provider.name, message: null,
    suggestions: (await listSuggestions(db, "interaction", it.id)).map(suggestionOut),
  };
}

async function loadSuggestion(db: Db, suggestionId: string): Promise<AISuggestion> {
  const s = await get(db, aiSuggestions, suggestionId);
  if (!s || s.deleted_at) throw new HttpError(404, "Suggestion not found");
  if (s.status !== "pending") throw new HttpError(409, `Suggestion is already ${s.status}`);
  return s;
}

/** Explicit human confirmation. Only an accepted next action creates anything (a task). */
export async function acceptSuggestion(db: Db, suggestionId: string, data: AcceptIn, user: CurrentUser): Promise<AISuggestion> {
  const s = await loadSuggestion(db, suggestionId);
  const now = utcnow();
  const values: Partial<typeof aiSuggestions.$inferInsert> = {};
  let taskId: string | null = null;
  if (s.kind === "next_action") {
    if (!user.can("tasks", "create") && !user.can("outreach", "edit")) throw new HttpError(403, "Missing permission to create tasks");
    const { createTask } = await import("../tasks/service");
    const { people } = await import("../contacts/schema");
    const it = s.source_type === "interaction" ? await loadInteraction(db, s.source_id) : null;
    let rtype: string | null = null;
    let rid: string | null = null;
    let rlabel: string | null = null;
    if (it !== null) {
      if (it.opportunity_id) {
        [rtype, rid] = ["opportunity", it.opportunity_id];
      } else if (it.person_id) {
        const person: any = await get(db, people, it.person_id);
        [rtype, rid, rlabel] = ["person", it.person_id, person ? person.full_name : null];
      } else if (it.property_id) {
        [rtype, rid] = ["property", it.property_id];
      }
    }
    const days = (s.details ?? {}).due_in_days;
    const due = data.due_at || (Number.isInteger(days) ? new Date(now.getTime() + days * 86_400_000) : null);
    const task = await createTask(db, {
      title: (data.title || s.content).slice(0, 300),
      assignee_id: data.assignee_id || user.id,
      due_at: due,
      task_type: "follow_up",
      description: `Accepted AI-suggested next action. ${(s.details ?? {}).rationale || ""}`.trim(),
      related_type: rtype,
      related_id: rid,
      related_label: rlabel,
      source: "ai_suggestion",
      idempotency_key: `ai-suggestion:${s.id}`,
      actor_id: user.id,
    });
    taskId = task.id;
    values.task_id = taskId;
  }
  let content = s.content;
  if (data.title && s.kind !== "next_action") {
    values.details = { ...(s.details ?? {}), original: s.content };
    content = data.title;
    values.content = content;
  }
  Object.assign(values, { status: "accepted", decided_by_id: user.id, decided_at: now, updated_by_id: user.id });
  await patch(db, aiSuggestions, s, values);
  await audit.record(db, {
    actor: user, action: "ai_suggestion.accepted", entity_type: "ai_suggestion", entity_id: s.id,
    summary: `${s.kind}: ${s.content}`.slice(0, 500),
    changes: s.task_id ? { task_id: { from: null, to: s.task_id } } : null,
    ip_address: user.ip_address,
  });
  await db.commit();
  return s;
}

export async function rejectSuggestion(db: Db, suggestionId: string, user: CurrentUser): Promise<AISuggestion> {
  const s = await loadSuggestion(db, suggestionId);
  await patch(db, aiSuggestions, s, { status: "rejected", decided_by_id: user.id, decided_at: utcnow(), updated_by_id: user.id });
  await audit.record(db, {
    actor: user, action: "ai_suggestion.rejected", entity_type: "ai_suggestion", entity_id: s.id,
    summary: `${s.kind}: ${s.content}`.slice(0, 500), ip_address: user.ip_address,
  });
  await db.commit();
  return s;
}

// --- Pre-call talking points ---------------------------------------------------------------------

function money(v: unknown): string {
  if (v === null || v === undefined || v === "" || typeof v === "object") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

async function talkingContext(db: Db, person: any, user: CurrentUser) {
  const { ownershipInterests } = await import("../ownership/schema");
  const { opportunities } = await import("../pipeline/schema");
  const { interactions: interactionsTable } = await import("../outreach/schema");

  const relation = new Map<string, string>();
  const setdefault = (id: string, v: string) => {
    if (!relation.has(id)) relation.set(id, v);
  };
  const owned: any[] = await db
    .select({ property_id: ownershipInterests.property_id })
    .from(ownershipInterests)
    .where(and(
      eq(ownershipInterests.owner_person_id, person.id), isNull(ownershipInterests.deleted_at),
      isNull(ownershipInterests.effective_to),
    ))
    .limit(20);
  for (const r of owned) setdefault(r.property_id, "owner");
  const oppStage = new Map<string, string>();
  const opps: any[] = await db
    .select({ property_id: opportunities.property_id, stage: opportunities.stage })
    .from(opportunities)
    .where(and(eq(opportunities.primary_person_id, person.id), isNull(opportunities.deleted_at)))
    .limit(20);
  for (const r of opps) {
    if (r.property_id) {
      setdefault(r.property_id, "opportunity contact");
      oppStage.set(r.property_id, r.stage);
    }
  }

  const interactions: Json[] = [];
  if (user.can("outreach", "view")) {
    const rows: any[] = await db
      .select()
      .from(interactionsTable)
      .where(and(eq(interactionsTable.person_id, person.id), isNull(interactionsTable.deleted_at)))
      .orderBy(desc(interactionsTable.occurred_at))
      .limit(8);
    for (const it of rows) {
      if (it.property_id) setdefault(it.property_id, "discussed");
      interactions.push({
        id: String(it.id), occurred_at: (it.occurred_at as Date).toISOString(), channel: it.channel,
        direction: it.direction, disposition: it.disposition, summary: (it.summary || it.subject || "").slice(0, 400),
        next_action: it.next_action,
      });
    }
  }

  const props: Json[] = [];
  const signals: Json[] = [];
  const valuations: Json[] = [];
  if (user.can("properties", "view") && relation.size) {
    const rows = await db
      .select()
      .from(properties)
      .where(and(inArray(properties.id, [...relation.keys()].slice(0, 8)), isNull(properties.deleted_at)));
    for (const p of rows) {
      const label = p.name || p.address_line;
      props.push({
        id: String(p.id), label, relationship: relation.get(p.id), property_type: p.property_type, status: p.status,
        city: p.city, state: p.state, asking_price: p.asking_price, opportunity_stage: oppStage.get(p.id) ?? null,
      });
      if (user.can("signals", "view")) {
        let mod: any = null;
        try {
          mod = await import("../signals/service");
        } catch {
          mod = null; // module not installed (Python ImportError)
        }
        if (mod) {
          for (const s of ((await mod.outboundSignals(db, p.id)) as any[]).slice(0, 5)) { // never sensitive signals
            signals.push({
              property_id: String(p.id), property: label, title: s.title || String(s.signal_type).replace(/_/g, " "),
              category: s.category, observed_on: isoDate(s.observed_on), severity: s.severity, source: s.source,
            });
          }
        }
      }
      if (user.can("comps", "view")) {
        let mod: any = null;
        try {
          mod = await import("../comps/service");
        } catch {
          mod = null;
        }
        if (mod) {
          const v = await mod.latestValue(db, p.id);
          if (v) valuations.push({ property_id: String(p.id), property: label, ...toJsonable(v) });
        }
      }
    }
  }
  return { properties: props, recent_interactions: interactions, signals, valuations };
}

function fallbackPoints(person: any, ctx: Awaited<ReturnType<typeof talkingContext>>) {
  const points: { text: string; basis: string }[] = [];
  if (ctx.recent_interactions.length) {
    const last = ctx.recent_interactions[0];
    points.push({
      text:
        `Last touch ${String(last.occurred_at).slice(0, 10)} by ${last.channel}` +
        `${last.disposition ? " (" + String(last.disposition).replace(/_/g, " ") + ")" : ""}` +
        `${last.summary ? ": " + String(last.summary).slice(0, 160) : ""}`,
      basis: "Most recent logged interaction",
    });
  }
  if (person.next_action) points.push({ text: `Open next step: ${person.next_action}`, basis: "Contact next action" });
  for (const p of ctx.properties.slice(0, 4)) {
    const stage = p.opportunity_stage ? `, opportunity at ${String(p.opportunity_stage).replace(/_/g, " ")}` : "";
    points.push({
      text:
        `${capitalize(p.relationship)} — ${p.label} (${String(p.property_type).replace(/_/g, " ")}` +
        `${p.city ? ", " + p.city : ""})${stage}`,
      basis: "Property and ownership records",
    });
  }
  for (const s of ctx.signals.slice(0, 4)) {
    points.push({
      text: `${capitalize(s.title)} at ${s.property} observed ${s.observed_on}`,
      basis: `Signal · source: ${s.source}`,
    });
  }
  for (const v of ctx.valuations.slice(0, 2)) {
    points.push({
      text:
        `Latest value view on ${v.property}: ${money(v.value_point)}` +
        ` (${v.method || "valuation"}, as of ${String(v.as_of).slice(0, 10)})`,
      basis: "Comps & valuation",
    });
  }
  return points;
}

const TALKING_SCHEMA = obj({ points: { type: "array", items: obj({ text: { type: "string" }, basis: { type: "string" } }) } });

export async function talkingPoints(db: Db, personId: string, user: CurrentUser) {
  const { people } = await import("../contacts/schema");
  const person: any = await get(db, people, personId);
  if (!person || person.deleted_at) throw new HttpError(404, "Person not found");
  const ctx = await talkingContext(db, person, user);
  const base = { person_id: person.id as string, person_name: person.full_name as string, ...ctx };
  const provider = structuredProvider();
  const fallback = fallbackPoints(person, ctx);
  if (provider === null) {
    return {
      ...base, ai_used: false, provider: ai.getProvider().name, points: fallback,
      message: "Generated from records (AI not configured).",
    };
  }
  const facts = {
    contact: {
      name: person.full_name, title: person.title, relationship_strength: person.relationship_strength,
      next_action: person.next_action,
    },
    ...ctx,
  };
  const prompt =
    "Prepare 3-7 short pre-call talking points for a commercial real estate acquisitions call with this " +
    "contact. Ground every point in the facts below and name the fact in `basis` (e.g. 'Interaction 2026-09-02', " +
    "'Signal: tax delinquency', 'Valuation'). Do not speculate about personal circumstances, do not mention " +
    "anything not in the facts, and keep the tone respectful.\n\n" +
    `<facts>\n${JSON.stringify(facts).slice(0, 60_000)}\n</facts>`;
  await db.commit(); // no DB transaction held open across the provider call
  try {
    const result: Json = await ai.loggedCall(db, provider, {
      purpose: "talking_points",
      prompt_parts: ["talking_points", String(person.id), facts],
      call: () => provider.structured({ prompt, schema: TALKING_SCHEMA, effort: "medium" }),
      actor_id: user.id,
      summarize_output: (r: Json) => ({ points: (r.points ?? []).length }),
    });
    const points = ((result.points ?? []) as Json[])
      .filter((p) => p && typeof p === "object" && p.text)
      .map((p) => ({ text: String(p.text).slice(0, 500), basis: String(p.basis || "").slice(0, 200) }))
      .slice(0, 10);
    await db.commit();
    if (points.length) return { ...base, ai_used: true, provider: provider.name as string, points, message: null };
    return {
      ...base, ai_used: false, provider: provider.name as string, points: fallback,
      message: "AI returned no talking points; showing record-based points.",
    };
  } catch (exc) {
    await db.commit();
    return {
      ...base, ai_used: false, provider: provider.name as string, points: fallback,
      message: `AI unavailable (${errName(exc)}); showing record-based points.`,
    };
  }
}
