/**
 * Opportunity scoring & prioritization (spec module 9).
 *
 * Only properties whose current Buy Box evaluation is pass / pass_with_exception are scored and ranked.
 * `score` (0-100) is the weighted value of five value components minus a negative-risk penalty.
 * `confidence` (0-1) is a separate certainty measure built from completeness, source quality, observation
 * age and verification state - it never adds value; it sets the band (High/Medium/Low) and ranking happens
 * within a band. Every score stores each component with its inputs and positive/negative drivers.
 */
import { createHash } from "node:crypto";

import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch, raw } from "../../db/orm";
import { organizations, people } from "../contacts/schema";
import { latestValue } from "../comps/service";
import { interactions } from "../outreach/schema";
import { ownershipInterests } from "../ownership/schema";
import { ACTIVE_STAGES, opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { motivationBreakdown, propertySignalRows } from "../signals/service";
import { automationRules } from "../tasks/schema";
import { raiseAlert, recordRuleRun, ruleConfig } from "../tasks/service";
import {
  COMPONENT_LABELS,
  COMPONENTS,
  DEFAULT_BANDS,
  DEFAULT_WEIGHTS,
  opportunityScores,
  scoreConfigs,
  scoreOutcomes,
  type OpportunityScore,
  type ScoreConfig,
  type ScoreOutcome,
} from "./schema";
import type { ConfigIn, OutcomeIn } from "./schemas";

export const RULE_KEY = "scoring.threshold_crossed";
export const ELIGIBLE = ["pass", "pass_with_exception"];
const VALUE_COMPONENTS = COMPONENTS.filter((c) => c !== "negative_risk");
const KEY_FACTS = ["asking_price", "noi", "occupancy_pct", "building_area_sf"];
const STRENGTH_POINTS: Record<string, number> = { none: 0, weak: 35, moderate: 65, strong: 90 };
const DISPOSITION_POINTS: Record<string, number> = { offer_requested: 15, information_requested: 8, callback: 6, connected: 4 };
export const MIN_OUTCOMES = { total: 10, won: 3, lost: 3 };
export const PURSUE_STAGES = new Set(["contact", "offer", "under_contract"]);

const DAY_MS = 86_400_000;
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysBetween = (later: string, earlier: string) => Math.floor((Date.parse(later) - Date.parse(earlier)) / DAY_MS);
const round = (v: number, n = 0) => {
  const f = 10 ** n;
  return Math.round(v * f) / f;
};
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const money = (v: number | null | undefined) =>
  v !== null && v !== undefined ? `$${Math.round(v).toLocaleString("en-US")}` : "—";
const commas = (v: number) => Math.round(v).toLocaleString("en-US");
/** Python `str(float)`: whole floats keep their ".0". */
const pyFloat = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const humanize = (s: string) => s.replace(/_/g, " ");

type Component = {
  key: string; label: string; value: number; weight: number; contribution: number;
  inputs: Record<string, any>; positive: string[]; negative: string[]; missing: string[];
};

function component(
  key: string, value: number, inputs: Record<string, any>, positive: string[], negative: string[], missing: string[] = [],
): Component {
  return {
    key, label: COMPONENT_LABELS[key], value: round(clamp(value), 1), weight: 0, contribution: 0,
    inputs: audit.toJsonable(inputs), positive, negative, missing,
  };
}

// ----------------------------------------------------------------------------- configuration

export async function ensureRule(db: Db): Promise<void> {
  const [existing] = await db.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.key, RULE_KEY)).limit(1);
  if (!existing) {
    await insert(db, automationRules, {
      key: RULE_KEY, name: "Score threshold crossing", event: "score.computed", enabled: true,
      description: "Alerts the opportunity owner when a property's score crosses the active configuration's " +
        "alert threshold (upward or downward).",
      thresholds: {}, run_count: 0, error_count: 0,
    } as never);
  }
}

async function maxVersion(db: Db): Promise<number> {
  const [r] = await db.select({ m: sql<number | null>`max(${scoreConfigs.version})` }).from(scoreConfigs);
  return Number(r?.m ?? 0);
}

export async function activeConfig(db: Db): Promise<ScoreConfig> {
  const [cfg] = await db
    .select()
    .from(scoreConfigs)
    .where(and(eq(scoreConfigs.status, "active"), isNull(scoreConfigs.deleted_at)))
    .orderBy(desc(scoreConfigs.version))
    .limit(1);
  if (cfg) return cfg;
  return insert(db, scoreConfigs, {
    version: (await maxVersion(db)) + 1, name: "Default weights", status: "active", weights: { ...DEFAULT_WEIGHTS },
    band_thresholds: { ...DEFAULT_BANDS }, alert_threshold: 75, high_dollar_threshold: 5_000_000,
    source: "default", basis: {}, activated_at: utcnow(),
  });
}

function validateConfig(data: ConfigIn): void {
  const keys = Object.keys(data.weights);
  if (keys.length !== COMPONENTS.length || !COMPONENTS.every((c) => keys.includes(c))) {
    throw new HttpError(422, `Weights must define exactly: ${COMPONENTS.join(", ")}`);
  }
  if (Object.values(data.weights).some((w) => !(w >= 0 && w <= 1))) {
    throw new HttpError(422, "Each weight must be between 0 and 1");
  }
  if (VALUE_COMPONENTS.reduce((a, k) => a + data.weights[k], 0) <= 0) {
    throw new HttpError(422, "At least one value component needs a positive weight");
  }
  const hi = data.band_thresholds.high;
  const med = data.band_thresholds.medium;
  if (hi === undefined || med === undefined || !(med > 0 && med < hi && hi <= 1)) {
    throw new HttpError(422, "Band thresholds need 0 < medium < high ≤ 1");
  }
}

export async function getConfig(db: Db, configId: string): Promise<ScoreConfig> {
  const cfg = await get(db, scoreConfigs, configId);
  if (!cfg || cfg.deleted_at) throw new HttpError(404, "Score configuration not found");
  return cfg;
}

export async function createConfig(
  db: Db,
  data: ConfigIn,
  actor: CurrentUser,
  o: { status_?: string; source?: string; basis?: Record<string, any> | null; based_on?: number | null } = {},
): Promise<ScoreConfig> {
  const { status_ = "draft", source = "manual", basis, based_on } = o;
  validateConfig(data);
  const cfg = await insert(db, scoreConfigs, {
    version: (await maxVersion(db)) + 1, name: data.name, status: status_, weights: data.weights,
    band_thresholds: data.band_thresholds, alert_threshold: data.alert_threshold,
    high_dollar_threshold: data.high_dollar_threshold, notes: data.notes ?? null, source,
    basis: basis ?? {}, based_on_version: based_on ?? null, created_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "score_config.created", entity_type: "score_config", entity_id: cfg.id,
    summary: `v${cfg.version} ${cfg.name} (${status_})`, ip_address: actor.ip_address,
  });
  await db.commit();
  return cfg;
}

export async function updateConfig(db: Db, cfg: ScoreConfig, data: ConfigIn, actor: CurrentUser): Promise<ScoreConfig> {
  if (!["draft", "proposed"].includes(cfg.status)) {
    throw new HttpError(409, "Only draft or proposed configurations can be edited; active and retired versions are kept as they were");
  }
  validateConfig(data);
  const values = {
    name: data.name, weights: data.weights, band_thresholds: data.band_thresholds,
    alert_threshold: data.alert_threshold, high_dollar_threshold: data.high_dollar_threshold, notes: data.notes ?? null,
  };
  const changes = audit.diff(cfg, values);
  if (Object.keys(changes).length) {
    await patch(db, scoreConfigs, cfg, { ...values, updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "score_config.updated", entity_type: "score_config", entity_id: cfg.id,
      summary: `v${cfg.version}`, changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return cfg;
}

export async function activateConfig(db: Db, cfg: ScoreConfig, actor: CurrentUser): Promise<ScoreConfig> {
  if (!["draft", "proposed"].includes(cfg.status)) throw new HttpError(409, `A ${cfg.status} configuration cannot be activated`);
  const now = utcnow();
  const [current] = await db
    .select()
    .from(scoreConfigs)
    .where(and(eq(scoreConfigs.status, "active"), isNull(scoreConfigs.deleted_at)))
    .limit(1);
  if (current) await patch(db, scoreConfigs, current, { status: "retired", retired_at: now, updated_by_id: actor.id });
  await patch(db, scoreConfigs, cfg, {
    status: "active", approved_by_id: actor.id, approved_at: now, activated_at: now, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "score_config.activated", entity_type: "score_config", entity_id: cfg.id,
    summary: `v${cfg.version} activated` + (current ? `; v${current.version} retired` : ""), ip_address: actor.ip_address,
  });
  await rescoreAll(db, { actor, trigger: "config_activated", alerts: false });
  await db.commit();
  return cfg;
}

export async function rejectConfig(db: Db, cfg: ScoreConfig, reason: string, actor: CurrentUser): Promise<ScoreConfig> {
  if (!["draft", "proposed"].includes(cfg.status)) throw new HttpError(409, `A ${cfg.status} configuration cannot be rejected`);
  await patch(db, scoreConfigs, cfg, { status: "rejected", rejected_reason: reason.trim(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "score_config.rejected", entity_type: "score_config", entity_id: cfg.id,
    summary: reason.trim(), ip_address: actor.ip_address,
  });
  await db.commit();
  return cfg;
}

// ----------------------------------------------------------------------------- inputs

export async function eligibility(db: Db, propertyId: string): Promise<[boolean, any[]]> {
  const rows = await raw<{ buy_box_id: string; name: string; buy_box_version: number; result: string }>(
    db,
    sql`select e.buy_box_id, b.name, e.buy_box_version, e.result
        from buybox_evaluations e join buy_boxes b on b.id = e.buy_box_id
        where e.property_id = ${propertyId} and e.is_current = true`,
  );
  const details = rows.map((r) => ({
    buy_box_id: String(r.buy_box_id), buy_box_name: r.name, version: r.buy_box_version, result: r.result,
  }));
  return [details.some((d) => ELIGIBLE.includes(d.result)), details];
}

type Opportunity = typeof opportunities.$inferSelect;
type OwnerRow = typeof ownershipInterests.$inferSelect;

async function opportunityFor(db: Db, propertyId: string): Promise<Opportunity | null> {
  const [o] = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.property_id, propertyId), isNull(opportunities.deleted_at)))
    .orderBy(desc(opportunities.updated_at))
    .limit(1);
  return o ?? null;
}

async function ownerRows(db: Db, propertyId: string): Promise<OwnerRow[]> {
  const today = todayStr();
  return db
    .select()
    .from(ownershipInterests)
    .where(
      and(
        eq(ownershipInterests.property_id, propertyId),
        isNull(ownershipInterests.deleted_at),
        or(isNull(ownershipInterests.effective_to), sql`${ownershipInterests.effective_to} > ${today}`),
      ),
    );
}

async function economics(db: Db, p: Record<string, any>, opp: Opportunity | null): Promise<Component> {
  const inputs: Record<string, any> = { asking_price: p.asking_price, noi: p.noi };
  const pos: string[] = [];
  const neg: string[] = [];
  const missing: string[] = [];
  let valuePoint: number | null = null;
  const lv = await latestValue(db, p.id);
  if (lv && lv.value_point) {
    valuePoint = Number(lv.value_point);
    Object.assign(inputs, { valuation: valuePoint, valuation_method: lv.method, valuation_as_of: lv.as_of });
  }
  if (valuePoint === null && opp && opp.estimated_value) {
    valuePoint = Number(opp.estimated_value);
    inputs.estimated_value = valuePoint;
  }
  const asking = p.asking_price || (opp ? opp.price_expectation : null);
  if (opp && opp.price_expectation) inputs.owner_price_expectation = opp.price_expectation;
  let value: number;
  if (asking && valuePoint) {
    const gap = (valuePoint - asking) / valuePoint;
    inputs.pricing_gap_pct = round(gap * 100, 1);
    value = 50 + gap * 250;
    const text = `Price ${money(asking)} is ${(Math.abs(gap) * 100).toFixed(1)}% ${gap >= 0 ? "below" : "above"} value ${money(valuePoint)}`;
    (gap >= 0 ? pos : neg).push(text);
  } else if (asking && p.noi) {
    const cap = (p.noi / asking) * 100;
    inputs.implied_cap_rate = round(cap, 2);
    value = (cap - 3) * 15;
    (cap >= 6.5 ? pos : neg).push(`Implied cap rate ${cap.toFixed(2)}% on ${money(asking)}`);
    missing.push("valuation");
  } else {
    value = 50;
    for (const [m, v] of [["asking_price", asking], ["noi", p.noi], ["valuation", valuePoint]] as const) if (!v) missing.push(m);
    neg.push("Pricing inputs incomplete; neutral economics assumed");
  }
  return component("economics", value, inputs, pos, neg, missing);
}

async function location(db: Db, p: Record<string, any>): Promise<Component> {
  const inputs: Record<string, any> = { traffic_count: p.traffic_count, corridor: p.corridor };
  const pos: string[] = [];
  const neg: string[] = [];
  const missing: string[] = [];
  let traffic: number | null | undefined = p.traffic_count;
  let growth: number | null = null;
  if (p.latitude !== null && p.latitude !== undefined && p.longitude !== null && p.longitude !== undefined) {
    const point = sql`ST_SetSRID(ST_MakePoint(${p.longitude}::float8, ${p.latitude}::float8), 4326)::geography`;
    const since = new Date(Date.now() - 3 * 365 * DAY_MS).toISOString().slice(0, 10);
    const [g] = await raw<{ n: number }>(
      db,
      sql`select count(*)::int as n from growth_records
          where deleted_at is null and location is not null
            and (event_date is null or event_date >= ${since})
            and ST_DWithin(location::geography, ${point}, ${3 * 1609.344}::float8)`,
    );
    growth = Number(g?.n ?? 0);
    inputs.growth_records_3mi = growth;
    if (traffic === null || traffic === undefined) {
      const [t] = await raw<{ count: number }>(
        db,
        sql`select count from traffic_counts
            where deleted_at is null and location is not null
              and ST_DWithin(location::geography, ${point}, ${0.5 * 1609.344}::float8)
            order by count_year desc, count desc limit 1`,
      );
      traffic = t ? Number(t.count) : null;
      if (traffic !== null) inputs.nearest_traffic_count = traffic;
    }
  } else {
    missing.push("coordinates");
  }
  const tPts = traffic ? Math.min(50, (traffic / 40000) * 50) : null;
  const gPts = growth !== null ? Math.min(50, growth * 10) : null;
  if (tPts === null && gPts === null) {
    missing.push("traffic / growth context");
    neg.push("No traffic or growth context; neutral location assumed");
    return component("location", 50, inputs, pos, neg, missing);
  }
  if (traffic) (traffic >= 20000 ? pos : neg).push(`Traffic ${commas(traffic)} vehicles/day`);
  else missing.push("traffic_count");
  if (growth !== null) {
    (growth >= 2 ? pos : neg).push(`${growth} growth record${growth !== 1 ? "s" : ""} within 3 miles (3 yrs)`);
  }
  return component("location", (tPts ?? 25) + (gPts ?? 25), inputs, pos, neg, missing);
}

async function motivation(db: Db, p: Record<string, any>): Promise<[Component, any[]]> {
  const m = await motivationBreakdown(db, p.id);
  const rows = await propertySignalRows(db, p.id, { live_only: true });
  const pos: string[] = [];
  const neg: string[] = [];
  for (const c of (m.contributions as any[]).slice(0, 3)) {
    pos.push(
      `${capitalize(humanize(c.signal_type))} (severity ${c.severity}, weight ${Number(c.weight).toFixed(2)}) +${c.contribution}`,
    );
  }
  if (m.stacked) {
    pos.unshift(`${m.stack_count} independent signals stacked within ${m.window_days} days (x${m.stack_multiplier})`);
  }
  if (!m.active_signals) neg.push("No active motivation signals");
  const inputs = { motivation_index: m.index, active_signals: m.active_signals, stacked: m.stacked };
  return [component("motivation", m.index, inputs, pos, neg), rows];
}

async function transactionProbability(db: Db, p: Record<string, any>, opp: Opportunity | null, owners: OwnerRow[]): Promise<Component> {
  let value = 40;
  const inputs: Record<string, any> = { property_status: p.status };
  const pos: string[] = [];
  const neg: string[] = [];
  if (opp) {
    inputs.opportunity_stage = opp.stage;
    const stages = ACTIVE_STAGES as readonly string[];
    if (stages.includes(opp.stage)) {
      const idx = stages.indexOf(opp.stage);
      value += idx * 4;
      if (idx) pos.push(`Active opportunity in ${humanize(opp.stage)}`);
    } else if (opp.stage === "dead") {
      value -= 15;
      neg.push(`Previously dead (${humanize(opp.dead_reason || "no reason")})`);
    } else if (opp.stage === "nurture") {
      value -= 5;
      neg.push("Opportunity in nurture");
    }
  }
  if (p.status === "listed") {
    value += 20;
    pos.push("Listed for sale");
  }
  const since = new Date(utcnow().getTime() - 180 * DAY_MS);
  const conds: SQL[] = [eq(interactions.property_id, p.id)];
  if (opp) conds.push(eq(interactions.opportunity_id, opp.id));
  const dispRows = await db
    .select({ d: interactions.disposition, n: sql<number>`count(*)::int` })
    .from(interactions)
    .where(and(isNull(interactions.deleted_at), gte(interactions.occurred_at, since), or(...conds), isNotNull(interactions.disposition)))
    .groupBy(interactions.disposition);
  const disp: Record<string, number> = Object.fromEntries(dispRows.map((r) => [r.d as string, Number(r.n)]));
  inputs.dispositions_180d = disp;
  const bonus = Math.min(25, Object.entries(disp).reduce((a, [k, n]) => a + (DISPOSITION_POINTS[k] ?? 0) * n, 0));
  if (bonus) {
    value += bonus;
    pos.push(`Positive owner responses in the last 180 days (+${bonus})`);
  }
  if (disp.not_interested) {
    value -= 20;
    neg.push("Owner said not interested in the last 180 days");
  }
  const starts = owners.map((o) => o.effective_from).filter((d): d is string => !!d);
  if (starts.length) {
    const years = daysBetween(todayStr(), starts.reduce((a, b) => (a < b ? a : b))) / 365.25;
    inputs.hold_years = round(years, 1);
    if (years >= 7) {
      value += 10;
      pos.push(`Held ${years.toFixed(0)} years`);
    }
  }
  return component("transaction_probability", value, inputs, pos, neg);
}

async function relationship(db: Db, opp: Opportunity | null, owners: OwnerRow[]): Promise<Component> {
  const peopleIds = new Set(owners.map((o) => o.owner_person_id).filter((x): x is string => !!x));
  const orgIds = new Set(owners.map((o) => o.owner_organization_id).filter((x): x is string => !!x));
  if (opp) {
    if (opp.primary_person_id) peopleIds.add(opp.primary_person_id);
    if (opp.primary_organization_id) orgIds.add(opp.primary_organization_id);
  }
  if (!peopleIds.size && !orgIds.size) return component("relationship", 0, {}, [], ["No known owner or contact"], ["owner contact"]);
  type R = [string, string | null, Date | null];
  const rows: R[] = [];
  if (peopleIds.size) {
    const r = await db
      .select({ n: people.full_name, s: people.relationship_strength, t: people.last_touch_at })
      .from(people)
      .where(inArray(people.id, [...peopleIds]));
    rows.push(...r.map((x) => [x.n, x.s, x.t] as R));
  }
  if (orgIds.size) {
    const r = await db
      .select({ n: organizations.name, s: organizations.relationship_strength, t: organizations.last_touch_at })
      .from(organizations)
      .where(inArray(organizations.id, [...orgIds]));
    rows.push(...r.map((x) => [x.n, x.s, x.t] as R));
  }
  if (!rows.length) return component("relationship", 0, {}, [], ["No known owner or contact"], ["owner contact"]);
  const pts = (r: R) => STRENGTH_POINTS[r[1] || "none"] ?? 0;
  const best = rows.reduce((a, b) => (pts(b) > pts(a) ? b : a));
  let value = pts(best);
  const pos: string[] = [];
  const neg: string[] = [];
  if (value >= 65) pos.push(`${capitalize(best[1] || "none")} relationship with ${best[0]}`);
  else neg.push(`Best relationship is ${best[1] || "none"} (${best[0]})`);
  const cutoff = utcnow().getTime() - 90 * DAY_MS;
  if (rows.some(([, , t]) => t && t.getTime() >= cutoff)) {
    value += 10;
    pos.push("Touched within the last 90 days");
  }
  const inputs = { contacts: rows.map(([n, s, t]) => ({ name: n, strength: s, last_touch_at: t })).slice(0, 10) };
  return component("relationship", value, inputs, pos, neg);
}

function negativeRisk(p: Record<string, any>, signals: any[], eligibilityRows: any[]): Component {
  let risk = 0;
  const pos: string[] = [];
  const neg: string[] = [];
  const inputs = { flood_zone: p.flood_zone, occupancy_pct: p.occupancy_pct, year_built: p.year_built };
  if (p.flood_zone && ["A", "V"].includes(p.flood_zone.trim().toUpperCase().slice(0, 1))) {
    risk += 30;
    neg.push(`Flood zone ${p.flood_zone}`);
  }
  if (p.occupancy_pct !== null && p.occupancy_pct !== undefined && p.occupancy_pct < 70 && p.property_type !== "land") {
    risk += 15;
    neg.push(`Occupancy ${p.occupancy_pct.toFixed(0)}%`);
  }
  if (p.year_built && p.year_built < 1970) {
    risk += 10;
    neg.push(`Built ${p.year_built}`);
  }
  const results = new Set(eligibilityRows.map((e) => e.result));
  if (!results.has("pass") && results.has("pass_with_exception")) {
    risk += 10;
    neg.push("Eligible only by an approved buy box exception");
  }
  const severe = signals.filter((s) => ["legal", "physical"].includes(s.category) && s.severity >= 4);
  if (severe.length) {
    risk += Math.min(30, 15 * severe.length);
    neg.push(`${severe.length} severe legal/physical signal${severe.length !== 1 ? "s" : ""}`);
  }
  if (risk === 0) pos.push("No material risk flags");
  return component("negative_risk", risk, inputs, pos, neg);
}

function freshness(ageDays: number): number {
  if (ageDays <= 180) return 1.0;
  if (ageDays >= 1095) return 0.3;
  return round(1.0 - (0.7 * (ageDays - 180)) / (1095 - 180), 3);
}

async function confidenceOf(db: Db, p: Record<string, any>): Promise<[number, any[]]> {
  const obs = await provenance.currentObservations(db, "property", p.id);
  const list = Object.values(obs);
  const completeness = Number(p.completeness_score || 0) / 100;
  const today = todayStr();
  let sourceQuality: number;
  let fresh: number;
  let verified: number;
  if (list.length) {
    sourceQuality = list.reduce((a, o) => a + Number(o.confidence || 0), 0) / list.length;
    const ages = list.filter((o) => o.observed_on).map((o) => daysBetween(today, o.observed_on as string));
    fresh = ages.length ? ages.reduce((a, d) => a + freshness(d), 0) / ages.length : 0.5;
    verified = list.filter((o) => o.verification === "verified").length / list.length;
  } else {
    [sourceQuality, fresh, verified] = [0.4, 0.4, 0.0];
  }
  const unverifiedKey = KEY_FACTS.filter((f) => f in obs && obs[f].verification !== "verified");
  const penalty = 0.05 * unverifiedKey.length;
  const factors: any[] = [
    {
      key: "completeness", label: "Data completeness", value: round(completeness, 3), weight: 0.35,
      detail: `${Number(p.completeness_score ?? 0).toFixed(0)}% of required fields present`,
    },
    {
      key: "source_quality", label: "Source quality", value: round(sourceQuality, 3), weight: 0.25,
      detail: list.length ? `Average confidence of ${list.length} sourced facts` : "No sourced observations",
    },
    {
      key: "observation_age", label: "Observation age", value: round(fresh, 3), weight: 0.2,
      detail: "Recency of observed dates (full credit within 6 months)",
    },
    {
      key: "verification", label: "Verification state", value: round(verified, 3), weight: 0.2,
      detail: `${Math.round(verified * 100)}% of facts verified by a named person`,
    },
  ];
  if (unverifiedKey.length) {
    factors.push({
      key: "unverified_material", label: "Unverified material facts", value: -round(penalty, 3), weight: 1.0,
      detail: "Unverified: " + unverifiedKey.join(", "),
    });
  }
  const conf = 0.35 * completeness + 0.25 * sourceQuality + 0.2 * fresh + 0.2 * verified - penalty;
  return [round(clamp(conf, 0.05, 1.0), 3), factors];
}

export function bandFor(confidence: number, thresholds: Record<string, number>): string {
  if (confidence >= Number(thresholds.high ?? DEFAULT_BANDS.high)) return "high";
  if (confidence >= Number(thresholds.medium ?? DEFAULT_BANDS.medium)) return "medium";
  return "low";
}

/** Weighted average of value components minus the negative-risk penalty; fills each contribution. */
export function combine(components: Record<string, Component>, weights: Record<string, number>): number {
  const w = (k: string) => Number(weights[k] ?? 0);
  const wsum = VALUE_COMPONENTS.reduce((a, k) => a + w(k), 0) || 1.0;
  let total = 0;
  for (const k of VALUE_COMPONENTS) {
    const c = components[k];
    c.weight = round(w(k), 4);
    c.contribution = round((c.value * w(k)) / wsum, 2);
    total += c.contribution;
  }
  const risk = components.negative_risk;
  risk.weight = round(w("negative_risk"), 4);
  risk.contribution = -round(risk.value * w("negative_risk"), 2);
  return round(clamp(total + risk.contribution), 1);
}

// ----------------------------------------------------------------------------- scoring

export async function currentScore(db: Db, propertyId: string): Promise<OpportunityScore | null> {
  const [row] = await db
    .select()
    .from(opportunityScores)
    .where(and(eq(opportunityScores.property_id, propertyId), eq(opportunityScores.is_current, true)))
    .orderBy(desc(opportunityScores.computed_at))
    .limit(1);
  return row ?? null;
}

type ComputeResult = {
  score: number; confidence: number; adjusted_score: number; band: string; components: Component[];
  confidence_factors: any[]; drivers: Record<string, any>; needs_research: boolean; value_basis: number | null;
  requires_human_approval: boolean;
};

export async function compute(db: Db, p: Record<string, any>, cfg: ScoreConfig, eligRows: any[]): Promise<ComputeResult> {
  const opp = await opportunityFor(db, p.id);
  const owners = await ownerRows(db, p.id);
  const [motivationComp, signals] = await motivation(db, p);
  const comps: Record<string, Component> = {
    economics: await economics(db, p, opp),
    location: await location(db, p),
    motivation: motivationComp,
    transaction_probability: await transactionProbability(db, p, opp, owners),
    relationship: await relationship(db, opp, owners),
    negative_risk: negativeRisk(p, signals, eligRows),
  };
  const score = combine(comps, Object.keys(cfg.weights ?? {}).length ? cfg.weights : DEFAULT_WEIGHTS);
  const [confidence, factors] = await confidenceOf(db, p);
  const band = bandFor(confidence, Object.keys(cfg.band_thresholds ?? {}).length ? cfg.band_thresholds : DEFAULT_BANDS);
  const ordered = COMPONENTS.map((k) => comps[k]);
  // Stable sorts, like Python's sorted().
  const positives = ordered
    .filter((c) => c.key !== "negative_risk")
    .flatMap((c) => c.positive.map((d) => [c.contribution, d] as [number, string]))
    .sort((a, b) => b[0] - a[0]);
  const negatives = [...ordered].sort((a, b) => a.contribution - b.contribution).flatMap((c) => c.negative);
  const valueBasis = p.asking_price || (opp ? opp.price_expectation : null) || (opp ? opp.estimated_value : null) || null;
  const needsResearch = score >= 60 && band === "low";
  const drivers: Record<string, any> = { positive: positives.map(([, d]) => d).slice(0, 6), negative: negatives.slice(0, 6) };
  if (needsResearch) drivers.note = "High value score on weak evidence: surface for research before treating as verified.";
  return {
    score, confidence, adjusted_score: round(score * confidence, 1), band, components: ordered,
    confidence_factors: factors, drivers, needs_research: needsResearch, value_basis: valueBasis,
    // High-dollar automation can never act on a score alone; unknown value is treated as high-dollar.
    requires_human_approval: valueBasis === null || Number(valueBasis) >= Number(cfg.high_dollar_threshold || 0),
  };
}

/** Python `json.dumps(key, sort_keys=True)` for the signature payload (so existing signatures keep matching). */
function pyJson(v: any, asFloat = false): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return asFloat ? pyFloat(v) : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => pyJson(x)).join(", ") + "]";
  return "{" + Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${pyJson(v[k], ["s", "c"].includes(k))}`).join(", ") + "}";
}

function signature(cfgVersion: number, result: ComputeResult): string {
  const key = {
    v: cfgVersion, s: result.score, c: result.confidence,
    k: result.components.map((c) => [c.key, c.value]),
  };
  return createHash("sha256").update(pyJson(key)).digest("hex");
}

/** Recompute the score for one property (does not commit). Ineligible properties lose their current score. */
export async function rescoreProperty(
  db: Db,
  propertyId: string | null | undefined,
  actor: CurrentUser | null = null,
  o: { trigger?: string; alerts?: boolean } = {},
): Promise<OpportunityScore | null> {
  const { trigger = "manual", alerts = true } = o;
  if (!propertyId) return null;
  const p = await get(db, properties, propertyId);
  if (!p || p.deleted_at) return null;
  const cfg = await activeConfig(db);
  const [eligible, eligRows] = await eligibility(db, propertyId);
  const prev = await currentScore(db, propertyId);
  if (!eligible) {
    if (prev) await patch(db, opportunityScores, prev, { is_current: false }); // history kept; the property leaves the rankings
    return null;
  }
  const result = await compute(db, p, cfg, eligRows);
  const sig = signature(cfg.version, result);
  if (prev && prev.signature === sig) {
    await patch(db, opportunityScores, prev, { computed_at: utcnow() });
    return prev;
  }
  if (prev) await patch(db, opportunityScores, prev, { is_current: false });
  const row = await insert(db, opportunityScores, {
    property_id: propertyId, config_id: cfg.id, config_version: cfg.version, eligibility: eligRows, signature: sig,
    trigger: trigger.slice(0, 40), computed_at: utcnow(), computed_by_id: actor?.id ?? null, is_current: true, ...result,
  });
  if (alerts) await thresholdCheck(db, p, prev, row, cfg, actor);
  return row;
}

async function thresholdCheck(
  db: Db, p: Record<string, any>, prev: OpportunityScore | null, row: OpportunityScore, cfg: ScoreConfig, actor: CurrentUser | null,
): Promise<void> {
  const t = Number(cfg.alert_threshold);
  const before = prev ? prev.score : null;
  const up = row.score >= t && (before === null || before < t);
  const down = before !== null && before >= t && row.score < t;
  if (!(up || down)) return;
  await ensureRule(db);
  const [enabled] = await ruleConfig(db, RULE_KEY);
  if (!enabled) return;
  const opp = await opportunityFor(db, p.id);
  const label = p.name || p.address_line;
  const direction = up ? "up" : "down";
  let reason = `Score ${before !== null ? pyFloat(before) : "—"} → ${pyFloat(row.score)} (threshold ${t}); confidence ` +
    `${row.confidence.toFixed(2)}, ${row.band} band.`;
  if (row.needs_research) reason += " High score on weak evidence: research before acting.";
  if (row.requires_human_approval) reason += " High-dollar: automated action requires human approval.";
  await raiseAlert(db, {
    title: `Score ${up ? "crossed above" : "fell below"} ${t}: ${label}`, reason,
    severity: up ? (row.band === "high" ? "high" : "medium") : "low",
    owner_id: opp && !["closed", "dead"].includes(opp.stage) ? opp.owner_id : null,
    related_type: "property", related_id: p.id, related_label: label, rule_key: RULE_KEY,
    idempotency_key: `scoring.threshold:${p.id}:${row.id}`,
  });
  await recordRuleRun(db, RULE_KEY);
  await events.emit(db, "score.threshold_crossed", {
    property_id: p.id, score: row.score, actor, direction, threshold: t, score_id: row.id,
  });
}

/** Rescores every property with a current eligible buy box result (bounded). Does not commit. */
export async function rescoreAll(
  db: Db,
  o: { actor?: CurrentUser | null; trigger?: string; alerts?: boolean; limit?: number } = {},
): Promise<number> {
  const { actor = null, trigger = "bulk", alerts = false, limit = 2000 } = o;
  const first = await raw<{ property_id: string }>(
    db,
    sql`select distinct property_id from buybox_evaluations
        where is_current = true and result in ('pass', 'pass_with_exception') limit ${limit}`,
  );
  const ids = first.map((r) => r.property_id);
  const have = new Set(ids);
  const second = await db
    .select({ id: opportunityScores.property_id })
    .from(opportunityScores)
    .where(eq(opportunityScores.is_current, true))
    .limit(limit);
  ids.push(...second.map((r) => r.id).filter((i) => !have.has(i)));
  for (const pid of ids) await rescoreProperty(db, pid, actor, { trigger, alerts });
  return ids.length;
}

/** Guard for any automation acting on a score: high-dollar actions need a recorded human approval. */
export function automationAllowed(score: OpportunityScore | null, o: { human_approved?: boolean } = {}): boolean {
  if (score === null) return false;
  return !!o.human_approved || !score.requires_human_approval;
}

// ----------------------------------------------------------------------------- rankings

export interface RankingFilters {
  q?: string;
  band?: string[];
  property_type?: string[];
  min_score?: number;
  max_score?: number;
  min_confidence?: number;
  territory_id?: string;
  needs_research?: boolean;
}

export const BAND_ORDER = sql`case ${opportunityScores.band} when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end`;

/** WHERE clause for the rankings join (opportunity_scores x properties). */
export function rankingsWhere(f: RankingFilters, skip: Set<string> = new Set()): SQL | undefined {
  const eligible = sql`exists (select 1 from buybox_evaluations be where be.property_id = ${opportunityScores.property_id}
    and be.is_current = true and be.result in ('pass', 'pass_with_exception'))`;
  return and(
    eq(opportunityScores.is_current, true),
    isNull(properties.deleted_at),
    eligible,
    applySearch(f.q, [properties.name, properties.address_line, properties.city, properties.county]),
    skip.has("band") ? undefined : inFilter(opportunityScores.band, f.band),
    skip.has("property_type") ? undefined : inFilter(properties.property_type, f.property_type),
    rangeFilter(opportunityScores.score, f.min_score, f.max_score),
    rangeFilter(opportunityScores.confidence, f.min_confidence, undefined),
    f.needs_research !== undefined && f.needs_research !== null ? eq(opportunityScores.needs_research, f.needs_research) : undefined,
    f.territory_id
      ? sql`${opportunityScores.property_id} in (select property_id from territory_members where territory_id = ${f.territory_id})`
      : undefined,
  );
}

export async function rankingItems(db: Db, rows: OpportunityScore[], offset: number): Promise<any[]> {
  if (!rows.length) return [];
  const pids = [...new Set(rows.map((r) => r.property_id))];
  const props = new Map(
    (
      await db
        .select({
          id: properties.id, name: properties.name, address_line: properties.address_line, city: properties.city,
          state: properties.state, property_type: properties.property_type, asking_price: properties.asking_price,
        })
        .from(properties)
        .where(inArray(properties.id, pids))
    ).map((r) => [r.id, r]),
  );
  // Previous score per property = latest non-current row.
  const prevRows = await raw<{ property_id: string; score: number }>(
    db,
    sql`select property_id, score from (
          select property_id, score,
                 row_number() over (partition by property_id order by computed_at desc) as rn
          from opportunity_scores
          where property_id in (${sql.join(pids.map((i) => sql`${i}`), sql`, `)}) and is_current = false
        ) s where rn = 1`,
  );
  const prev = new Map(prevRows.map((r) => [r.property_id, Number(r.score)]));
  return rows.map((r, i) => {
    const p = props.get(r.property_id);
    return {
      id: r.id,
      property_id: r.property_id,
      property_label: p ? p.name || p.address_line : null,
      property_city: p ? p.city : null,
      property_state: p ? p.state : null,
      property_type: p ? p.property_type : null,
      asking_price: p ? p.asking_price : null,
      position: offset + i + 1,
      score: r.score,
      confidence: r.confidence,
      adjusted_score: r.adjusted_score,
      band: r.band,
      config_version: r.config_version,
      needs_research: r.needs_research,
      requires_human_approval: r.requires_human_approval,
      component_values: Object.fromEntries((r.components ?? []).map((c: any) => [c.key, c.value])),
      top_positive: ((r.drivers ?? {}).positive ?? [null])[0] ?? null,
      top_negative: ((r.drivers ?? {}).negative ?? [null])[0] ?? null,
      previous_score: prev.get(r.property_id) ?? null,
      computed_at: r.computed_at,
    };
  });
}

export async function propertyHistory(db: Db, propertyId: string, limit = 100): Promise<OpportunityScore[]> {
  const rows = await db
    .select()
    .from(opportunityScores)
    .where(eq(opportunityScores.property_id, propertyId))
    .orderBy(desc(opportunityScores.computed_at))
    .limit(limit);
  return rows.reverse();
}

// ----------------------------------------------------------------------------- outcomes

/** Records a decision with the score at that moment; a final result closes earlier open outcomes. No commit. */
export async function logOutcome(
  db: Db,
  o: {
    property_id: string; opportunity_id?: string | null; disposition: string; result?: string;
    actor?: CurrentUser | null; notes?: string | null; source?: string;
  },
): Promise<ScoreOutcome> {
  const { property_id, opportunity_id = null, disposition, result = "open", actor = null, notes = null, source = "event" } = o;
  const now = utcnow();
  const [opp] = opportunity_id ? await db.select().from(opportunities).where(eq(opportunities.id, opportunity_id)).limit(1) : [];
  if (source === "event" && opportunity_id) {
    const [existing] = await db
      .select()
      .from(scoreOutcomes)
      .where(
        and(
          eq(scoreOutcomes.opportunity_id, opportunity_id),
          eq(scoreOutcomes.disposition, disposition),
          isNull(scoreOutcomes.deleted_at),
          result !== "won" ? gte(scoreOutcomes.decided_at, new Date(now.getTime() - 2 * 60_000)) : undefined,
        ),
      )
      .limit(1);
    if (existing) return existing;
  }
  const cur = await currentScore(db, property_id);
  const row = await insert(db, scoreOutcomes, {
    property_id, opportunity_id, disposition: disposition.slice(0, 40), decided_at: now,
    score_at_decision: cur ? cur.score : null, confidence_at_decision: cur ? cur.confidence : null,
    band_at_decision: cur ? cur.band : null, config_version: cur ? cur.config_version : null,
    components_at_decision: cur ? Object.fromEntries((cur.components ?? []).map((c: any) => [c.key, c.value])) : {},
    result, result_at: result !== "open" ? now : null,
    elapsed_days: opp ? round((now.getTime() - opp.created_at.getTime()) / DAY_MS, 1) : null,
    source, notes, created_by_id: actor?.id ?? null, updated_by_id: actor?.id ?? null,
  });
  if ((result === "won" || result === "lost") && opportunity_id) {
    await db
      .update(scoreOutcomes)
      .set({ result, result_at: now })
      .where(and(eq(scoreOutcomes.opportunity_id, opportunity_id), eq(scoreOutcomes.result, "open"), ne(scoreOutcomes.id, row.id)));
  }
  await audit.record(db, {
    actor, action: "score_outcome.logged", entity_type: "property", entity_id: property_id,
    summary: `${humanize(disposition)} · ${result}` + (cur ? ` · score ${pyFloat(cur.score)}` : " · unscored"),
  });
  return row;
}

export async function outcomeSummary(db: Db) {
  const rows = await db
    .select({ result: scoreOutcomes.result, band: scoreOutcomes.band_at_decision, score: scoreOutcomes.score_at_decision })
    .from(scoreOutcomes)
    .where(isNull(scoreOutcomes.deleted_at));
  const counts: Record<string, number> = { won: 0, lost: 0, open: 0 };
  const byBand: Record<string, Record<string, number>> = {};
  const scores: Record<string, number[]> = { won: [], lost: [] };
  for (const { result, band, score } of rows) {
    counts[result] = (counts[result] ?? 0) + 1;
    const b = (byBand[band || "unscored"] ??= { won: 0, lost: 0, open: 0 });
    b[result] = (b[result] ?? 0) + 1;
    if (score !== null && score !== undefined && result in scores) scores[result].push(score);
  }
  const decided = await decidedOutcomes(db);
  const won = decided.filter((o) => o.result === "won").length;
  const lost = decided.length - won;
  const avg = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null);
  return {
    total: rows.length, won: counts.won, lost: counts.lost, open: counts.open,
    avg_score_won: avg(scores.won), avg_score_lost: avg(scores.lost), by_band: byBand,
    recalibration_ready: decided.length >= MIN_OUTCOMES.total && won >= MIN_OUTCOMES.won && lost >= MIN_OUTCOMES.lost,
    min_required: MIN_OUTCOMES,
  };
}

/** Latest decided outcome per opportunity (or per manual row) with recorded component values. */
async function decidedOutcomes(db: Db): Promise<ScoreOutcome[]> {
  const rows = await db
    .select()
    .from(scoreOutcomes)
    .where(and(isNull(scoreOutcomes.deleted_at), inArray(scoreOutcomes.result, ["won", "lost"])))
    .orderBy(desc(scoreOutcomes.decided_at));
  const seen = new Set<string>();
  const out: ScoreOutcome[] = [];
  for (const r of rows) {
    if (!r.components_at_decision || !Object.keys(r.components_at_decision).length) continue;
    const key = r.opportunity_id ?? r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Explainable recalibration: shift each weight by how well the component separated won from lost deals. */
export async function proposeRecalibration(db: Db, actor: CurrentUser): Promise<ScoreConfig> {
  const decided = await decidedOutcomes(db);
  const won = decided.filter((o) => o.result === "won");
  const lost = decided.filter((o) => o.result === "lost");
  if (decided.length < MIN_OUTCOMES.total || won.length < MIN_OUTCOMES.won || lost.length < MIN_OUTCOMES.lost) {
    throw new HttpError(
      422,
      `Recalibration needs at least ${MIN_OUTCOMES.total} decided outcomes with ${MIN_OUTCOMES.won} won and ` +
        `${MIN_OUTCOMES.lost} lost; have ${decided.length} (${won.length} won, ${lost.length} lost)`,
    );
  }
  const base = await activeConfig(db);
  const baseWeights = Object.keys(base.weights ?? {}).length ? base.weights : DEFAULT_WEIGHTS;
  const old: Record<string, number> = Object.fromEntries(COMPONENTS.map((k) => [k, Number(baseWeights[k] ?? DEFAULT_WEIGHTS[k])]));

  const mean = (rows: ScoreOutcome[], key: string) => {
    const vals = rows.map((r) => r.components_at_decision[key]).filter((v) => v !== null && v !== undefined).map(Number);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const basis: Record<string, any> = { samples: decided.length, won: won.length, lost: lost.length, components: {} };
  const next: Record<string, number> = {};
  for (const k of COMPONENTS) {
    const mw = mean(won, k);
    const ml = mean(lost, k);
    const separation = k === "negative_risk" ? ml - mw : mw - ml;
    const factor = 1 + clamp(separation / 50, -0.5, 0.5);
    next[k] = old[k] * factor;
    basis.components[k] = {
      won_mean: round(mw, 1), lost_mean: round(ml, 1), separation: round(separation, 1), factor: round(factor, 3),
      old_weight: round(old[k], 4),
    };
  }
  const oldSum = VALUE_COMPONENTS.reduce((a, k) => a + old[k], 0) || 1.0;
  const newSum = VALUE_COMPONENTS.reduce((a, k) => a + next[k], 0) || 1.0;
  for (const k of VALUE_COMPONENTS) next[k] = round((next[k] * oldSum) / newSum, 4);
  next.negative_risk = round(clamp(next.negative_risk, 0, 0.5), 4);
  for (const k of COMPONENTS) basis.components[k].new_weight = next[k];
  const data: ConfigIn = {
    name: `Recalibration of v${base.version}`, weights: next, band_thresholds: base.band_thresholds,
    alert_threshold: base.alert_threshold, high_dollar_threshold: base.high_dollar_threshold,
    notes: "Proposed from won vs lost component averages. Requires approval to activate.",
  };
  return createConfig(db, data, actor, { status_: "proposed", source: "recalibration", basis, based_on: base.version });
}

export async function createManualOutcome(db: Db, data: OutcomeIn, actor: CurrentUser): Promise<ScoreOutcome> {
  const p = await get(db, properties, data.property_id);
  if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  const row = await logOutcome(db, {
    property_id: p.id, opportunity_id: data.opportunity_id ?? null, disposition: data.disposition, result: data.result,
    actor, notes: data.notes ?? null, source: "manual",
  });
  await db.commit();
  return row;
}

// ----------------------------------------------------------------------------- response mappers

export const scoreOut = (r: OpportunityScore) => ({
  id: r.id, property_id: r.property_id, score: r.score, confidence: r.confidence, adjusted_score: r.adjusted_score,
  band: r.band, components: r.components, confidence_factors: r.confidence_factors, drivers: r.drivers,
  eligibility: r.eligibility, config_version: r.config_version, needs_research: r.needs_research,
  requires_human_approval: r.requires_human_approval, value_basis: r.value_basis, trigger: r.trigger,
  computed_at: r.computed_at, is_current: r.is_current,
});

export const historyPoint = (r: OpportunityScore) => ({
  id: r.id, score: r.score, confidence: r.confidence, band: r.band, config_version: r.config_version,
  trigger: r.trigger, computed_at: r.computed_at,
});

export const configOut = (c: ScoreConfig) => ({
  id: c.id, version: c.version, name: c.name, status: c.status, weights: c.weights, band_thresholds: c.band_thresholds,
  alert_threshold: c.alert_threshold, high_dollar_threshold: c.high_dollar_threshold, notes: c.notes, source: c.source,
  basis: c.basis, based_on_version: c.based_on_version, approved_by_id: c.approved_by_id, approved_at: c.approved_at,
  activated_at: c.activated_at, retired_at: c.retired_at, rejected_reason: c.rejected_reason, created_at: c.created_at,
  created_by_id: c.created_by_id,
});

export const outcomeOut = (r: ScoreOutcome, propertyLabel: string | null = null) => ({
  id: r.id, property_id: r.property_id, property_label: propertyLabel, opportunity_id: r.opportunity_id,
  disposition: r.disposition, decided_at: r.decided_at, score_at_decision: r.score_at_decision,
  confidence_at_decision: r.confidence_at_decision, band_at_decision: r.band_at_decision, config_version: r.config_version,
  components_at_decision: r.components_at_decision, result: r.result, result_at: r.result_at,
  elapsed_days: r.elapsed_days, source: r.source, notes: r.notes,
});
