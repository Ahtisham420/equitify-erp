/**
 * KPI registry (spec 34). Each metric has a stable key, label, family, definition text, unit, the SQL
 * builder (model + conditions + aggregation + filter dimensions) and the drill-through link of every record.
 *
 * Metric definitions live here once and are reused by every dashboard, the drill-through pages, exports,
 * schedules and snapshots, so the same number means the same thing across modules.
 */
import { and, between, eq, gt, gte, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";

import {
  asVarchar, caseWhen, coalesce, Col, concat, descNullsLast, descOf, fromAs, inList, isFalse, isTrue, Kpi, load,
  lit, markDateTime, newAlias, notInList, NULL_SQL, nowLit, nullsFirst, nullsLast, propertySource, addDays,
  col as qcol, type Ctx, type Fn, type KpiInit,
} from "./engine";

export const REGISTRY: Record<string, Kpi> = {};

function K(init: KpiInit): void {
  const k = new Kpi(init);
  REGISTRY[k.key] = k;
}

export const get = (key: string): Kpi | undefined => REGISTRY[key];

// ============================================================================ expression helpers

/** A source column by its DB name; a missing column throws (the report block is then omitted, like AttributeError). */
const attr = (name: string) => (M: any) => {
  const column = M[name];
  if (!column) throw new TypeError(`missing column ${name}`);
  return column;
};

const cattr = (name: string) => (M: any, _c?: Ctx) => attr(name)(M);

function propLabel(column: any): SQL {
  const P = load(PROPERTY);
  const a = newAlias();
  return sql`(select coalesce(${qcol(a, "name")}, ${qcol(a, "address_line")}) from ${fromAs(P, a)} where ${qcol(a, "id")} = ${column})`;
}

function userName(column: any): SQL {
  const U = load("auth.models:User");
  const a = newAlias();
  return sql`(select ${qcol(a, "full_name")} from ${fromAs(U, a)} where ${qcol(a, "id")} = ${column})`;
}

/** Scalar subquery: one attribute of the parent record `column` points to. */
function parent(ref: string, column: any, name: string): SQL {
  const X = load(ref);
  if (X === null || !X[name]) throw new TypeError(`missing column ${ref}.${name}`);
  const a = newAlias();
  const s = sql`(select ${qcol(a, name)} from ${fromAs(X, a)} where ${qcol(a, "id")} = ${column})`;
  return /timestamp/i.test(X[name].columnType ?? "") ? markDateTime(s) : s;
}

const opp = (column: any, name: string) => parent("pipeline.models:Opportunity", column, name);

function link(prefix: string, column: any, fallback?: string): SQL {
  return caseWhen([[isNull(column), fallback ? lit(fallback) : NULL_SQL]], concat(lit(prefix), asVarchar(column)));
}

const ROUTES: Record<string, string> = {
  property: "/properties/", opportunity: "/pipeline/", contract: "/contracts/", lease: "/leases/",
  loan: "/loans/", offer: "/offers/", closing: "/closings/", asset: "/assets/", person: "/people/",
  organization: "/organizations/", work_order: "/work-orders/", listing: "/listings/",
  vendor: "/vendors/", capital_project: "/capital-projects/", disposition: "/dispositions/",
  uw_model: "/underwriting/", underwriting: "/underwriting/", document: "/documents/",
};

function relatedHref(typeCol: any, idCol: any, fallback: string): SQL {
  const whens = Object.entries(ROUTES).map(
    ([t, p]) => [and(eq(typeCol, t), isNotNull(idCol)), concat(lit(p), asVarchar(idCol))] as [any, any],
  );
  return caseWhen(whens, lit(fallback));
}

/** Contact values are masked unless the viewer may see sensitive contact data. */
function masked(expr: any, c: Ctx): any {
  if (c.user.can("contacts", "view_sensitive")) return expr;
  return caseWhen([[isNull(expr), NULL_SQL]], concat(lit("•••"), sql`right(${expr}, 4)`));
}

const daysSince = (fn: Fn) => (M: any, c: Ctx) => sql`extract(epoch from ${nowLit(c)} - ${fn(M)}) / 86400.0`;

const C = (key: string, label: string, kind = "text", expr?: Fn): Col => Col(key, label, expr ?? cattr(key), kind);
const P_COL = (name = "property_id"): Col => Col("property", "Property", (M: any) => propLabel(attr(name)(M)));
const U_COL = (name: string, label: string): Col => Col(name, label, (M: any) => userName(attr(name)(M)));
const yearOf = (name: string) => (M: any) => sql`to_char(${M[name]}, 'YYYY')`;

function _const<T>(ref: string, fallback: T): T {
  const value = load(ref);
  return value !== null ? value : fallback;
}

const activeStages = (): string[] =>
  _const("pipeline.models:ACTIVE_STAGES", [
    "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer", "under_contract",
    "due_diligence", "closing",
  ]);

const oppDims = (date?: string): Record<string, Fn> => ({
  user: attr("owner_id"), property: attr("property_id"), source: attr("source"), stage: attr("stage"),
  ...(date ? { date: attr(date) } : {}),
});

const viaOpp = (name = "opportunity_id"): Record<string, Fn> => ({
  source: (M: any) => opp(M[name], "source"),
  stage: (M: any) => opp(M[name], "stage"),
});

const without = (d: Record<string, Fn>, key: string): Record<string, Fn> =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== key));

// ============================================================================ SOURCING

const PROPERTY = "properties.models:Property";
const PROP_COLS = [C("city", "City"), C("state", "State"), C("property_type", "Type", "status"), C("status", "Status", "status")];

const propDims = (date?: string): Record<string, Fn> => ({
  property: attr("id"),
  source: (M: any) => propertySource(M.id),
  ...(date ? { date: attr(date) } : {}),
});

const propTitle = (M: any) => coalesce(M.name, M.address_line);

K({
  key: "sourcing.properties_added", label: "Properties added", family: "sourcing", module: "properties", model: PROPERTY,
  definition: "Property records created in the period (manual entry or import). Source is the data source of the "
    + "import that created the record.",
  title: propTitle, href: (M) => link("/properties/", M.id),
  dims: { ...propDims("created_at"), user: attr("created_by_id") },
  cols: [...PROP_COLS, C("created_at", "Added", "datetime")], module_href: "/properties", better: "up",
});

K({
  key: "sourcing.opportunities_created", label: "Opportunities created", family: "sourcing", module: "pipeline",
  model: "pipeline.models:Opportunity",
  definition: "Acquisition opportunities opened in the period (any stage).",
  title: (M) => M.title, href: (M) => link("/pipeline/", M.id), dims: oppDims("created_at"),
  cols: [P_COL(), C("stage", "Stage", "status"), C("source", "Source"), U_COL("owner_id", "Owner"),
    C("created_at", "Created", "datetime")],
  facets: { priority: cattr("priority") }, module_href: "/pipeline?view=table", better: "up",
});

const SIGNAL = "signals.models:Signal";

const sigLive = (S: any, c: Ctx) => and(eq(S.status, "active"), or(isNull(S.expires_on), gte(S.expires_on, c.today)));

function sigTitle(M: any, c: Ctx) {
  const t = coalesce(M.title, M.signal_type);
  if (c.user.can("signals", "view_sensitive")) return t;
  return caseWhen([[isTrue(M.is_sensitive), lit("Sensitive signal")]], t);
}

function sigSource(M: any, c: Ctx) {
  if (c.user.can("signals", "view_sensitive")) return M.source;
  return caseWhen([[isTrue(M.is_sensitive), lit("Internal")]], M.source);
}

const SIG_COLS = [P_COL(), C("category", "Category", "status"), C("signal_type", "Type", "status"),
  C("severity", "Severity", "number"), C("observed_on", "Observed", "date"), Col("source", "Source", sigSource)];
const SIG_FACETS = { category: cattr("category"), severity: cattr("severity"), signal_type: cattr("signal_type") };
const SIG_DIMS = { property: attr("property_id"), source: attr("source"), user: attr("created_by_id") };

const sigHref = (M: any) => link("/properties/", M.property_id, "/signals");

K({
  key: "sourcing.signals_new", label: "New signals", family: "sourcing", module: "signals", model: SIGNAL,
  definition: "Motivation/market signals observed in the period (by observed date), any status.",
  title: sigTitle, href: sigHref, dims: { ...SIG_DIMS, date: attr("observed_on") }, facets: SIG_FACETS, cols: SIG_COLS,
  sort: (M) => [descOf(M.observed_on)], module_href: "/signals", better: "up",
});

K({
  key: "signals.active", label: "Active signals", family: "sourcing", module: "signals", model: SIGNAL,
  definition: "Signals with status active that have not passed their expiry date.",
  where: (M, c) => [sigLive(M, c)], title: sigTitle, href: sigHref, dims: SIG_DIMS, facets: SIG_FACETS,
  cols: SIG_COLS, sort: (M) => [descOf(M.severity), descOf(M.observed_on)], module_href: "/signals",
});

K({
  key: "signals.high_severity", label: "High-severity signals", family: "sourcing", module: "signals", model: SIGNAL,
  definition: "Active, unexpired signals with severity 4 or 5.",
  where: (M, c) => [sigLive(M, c), gte(M.severity, 4)], title: sigTitle, href: sigHref, dims: SIG_DIMS,
  facets: SIG_FACETS, cols: SIG_COLS, sort: (M) => [descOf(M.severity), descOf(M.observed_on)],
  module_href: "/signals",
});

K({
  key: "signals.expiring_30", label: "Signals expiring in 30 days", family: "sourcing", module: "signals", model: SIGNAL,
  definition: "Active signals whose expiry date falls within the next 30 days.",
  where: (M, c) => [eq(M.status, "active"), between(M.expires_on, c.today, addDays(c.today, 30))],
  title: sigTitle, href: sigHref, dims: SIG_DIMS, facets: SIG_FACETS,
  cols: [...SIG_COLS, C("expires_on", "Expires", "date")], sort: (M) => [M.expires_on], module_href: "/signals",
});

function stacked(M: any, c: Ctx) {
  const S = load(SIGNAL);
  return [
    sql`${M.id} in (select ${S.property_id} from ${S} where ${and(isNull(S.deleted_at), sigLive(S, c), isNotNull(S.property_id))} group by ${S.property_id} having count(distinct ${S.category}) >= 2)`,
  ];
}

function signalCount(M: any, c: Ctx) {
  const S = load(SIGNAL);
  return sql`(select count(*) from ${S} where ${and(eq(S.property_id, M.id), isNull(S.deleted_at), sigLive(S, c))})`;
}

K({
  key: "sourcing.stacked_signal_properties", label: "Properties with stacked signals", family: "sourcing",
  module: "signals", model: PROPERTY, requires: [["properties", "view"]],
  definition: "Properties with active signals in two or more different categories (stacked motivation).",
  where: stacked, title: propTitle, href: (M) => link("/properties/", M.id), dims: propDims(),
  cols: [...PROP_COLS, Col("signals", "Active signals", signalCount, "number")], module_href: "/signals",
});

K({
  key: "sourcing.high_score_properties", label: "High-band opportunity scores", family: "sourcing", module: "scoring",
  model: "scoring.models:OpportunityScore",
  definition: "Properties whose current opportunity score is in the high band.",
  where: (M) => [isTrue(M.is_current), eq(M.band, "high")], title: (M) => propLabel(M.property_id),
  href: (M) => link("/properties/", M.property_id, "/scoring"), dims: { property: attr("property_id") },
  cols: [C("score", "Score", "number"), C("confidence", "Confidence", "number"), C("computed_at", "Scored", "datetime")],
  sort: (M) => [descOf(M.score)], module_href: "/scoring",
});

// ============================================================================ OUTREACH

const INTERACTION = "outreach.models:Interaction";
const INT_DIMS = {
  date: attr("occurred_at"), user: attr("logged_by_id"), property: attr("property_id"), ...viaOpp(),
};
const INT_FACETS = { channel: cattr("channel"), disposition: cattr("disposition"), direction: cattr("direction") };
const INT_COLS = [C("channel", "Channel", "status"), C("direction", "Direction", "status"),
  C("disposition", "Disposition", "status"), P_COL(), U_COL("logged_by_id", "Logged by"),
  C("occurred_at", "When", "datetime")];

const intTitle = (M: any) =>
  coalesce(M.subject, concat(M.channel, lit(" · "), coalesce(M.disposition, M.direction)));

const intHref = (M: any) =>
  coalesce(link("/people/", M.person_id), link("/organizations/", M.organization_id),
    link("/pipeline/", M.opportunity_id), link("/properties/", M.property_id), lit("/interactions"));

function _int(
  key: string, label: string, definition: string, where?: Fn,
  kw: { family?: string; dims?: Record<string, Fn>; cols?: Col[]; sort?: Fn; unit?: string; agg?: string;
    measure?: Fn; hit_label?: string; better?: string } = {},
) {
  const { family, dims, cols, sort, ...rest } = kw;
  K({
    key, label, family: family ?? "outreach", module: "outreach", model: INTERACTION, definition,
    where: where ?? (() => []), title: intTitle, href: intHref, dims: dims ?? INT_DIMS, facets: INT_FACETS,
    cols: cols ?? INT_COLS, sort: sort ?? ((M) => [descOf(M.occurred_at)]), module_href: "/interactions", ...rest,
  });
}

_int("outreach.interactions", "Interactions logged", "Every logged touchpoint (call, email, SMS, meeting, tour, "
  + "letter, note) by occurrence date.", undefined, { better: "up" });
_int("outreach.meaningful", "Meaningful conversations", "Interactions flagged meaningful (a real conversation or "
  + "meeting).", (M) => [isTrue(M.is_meaningful)], { better: "up" });
_int("outreach.connect_rate", "Call connect rate", "Share of outbound calls with disposition connected.",
  (M) => [eq(M.channel, "call"), eq(M.direction, "outbound")],
  { unit: "percent", agg: "rate", measure: (M) => eq(M.disposition, "connected"), hit_label: "Connected", better: "up" });
_int("outreach.open_loops", "Open loops", "Meaningful interactions with no next action, no follow-up task and "
  + "no recorded loop closure.",
  (M) => [isTrue(M.is_meaningful), isFalse(M.loop_closed), isNull(M.next_action_at), isNull(M.follow_up_task_id)],
  { better: "down" });
_int("outreach.follow_ups_due", "Follow-ups due", "Interactions whose next action is due today or earlier and "
  + "whose loop is not closed.",
  (M, c) => [isFalse(M.loop_closed), lt(M.next_action_at, c.eod)],
  {
    dims: without(INT_DIMS, "date"),
    cols: [...INT_COLS, C("next_action", "Next action"), C("next_action_at", "Due", "datetime")],
    sort: (M) => [M.next_action_at], better: "down",
  });

const TASK = "tasks.models:Task";
const OPEN_TASK = ["open", "in_progress"];
const relatedProperty = (M: any) => caseWhen([[eq(M.related_type, "property"), M.related_id]], NULL_SQL);
const TASK_DIMS = { user: attr("assignee_id"), property: relatedProperty };
const TASK_COLS = [C("task_type", "Type", "status"), C("priority", "Priority", "status"), C("status", "Status", "status"),
  U_COL("assignee_id", "Assignee"), C("related_label", "Related to"), C("due_at", "Due", "datetime")];
const TASK_FACETS = { task_type: cattr("task_type"), priority: cattr("priority") };

function _task(
  key: string, label: string, definition: string, where: Fn,
  kw: { dims?: Record<string, Fn>; sort?: Fn; better?: string } = {},
) {
  K({
    key, label, family: "outreach", module: "tasks", model: TASK, definition, where,
    title: (M) => M.title, href: (M) => relatedHref(M.related_type, M.related_id, "/tasks"),
    dims: kw.dims ?? TASK_DIMS, facets: TASK_FACETS, cols: TASK_COLS,
    sort: kw.sort ?? ((M) => [M.due_at]), module_href: "/tasks", better: kw.better,
  });
}

_task("tasks.overdue", "Overdue tasks", "Open or in-progress tasks whose due time has passed.",
  (M, c) => [inList(M.status, OPEN_TASK), lt(M.due_at, nowLit(c))], { better: "down" });
_task("tasks.due_today", "Tasks due today", "Open or in-progress tasks due between now and the end of today.",
  (M, c) => [inList(M.status, OPEN_TASK), gte(M.due_at, nowLit(c)), lt(M.due_at, c.eod)]);
_task("tasks.completed", "Tasks completed", "Tasks marked done, by completion date.",
  (M) => [eq(M.status, "done")], {
    dims: { ...TASK_DIMS, date: attr("completed_at") }, sort: (M) => [descOf(M.completed_at)], better: "up",
  });

K({
  key: "tasks.alerts_open_high", label: "High-severity alerts", family: "outreach", module: "tasks",
  model: "tasks.models:Alert",
  definition: "Alerts not yet resolved with severity high or critical.",
  where: (M) => [ne(M.status, "resolved"), inList(M.severity, ["high", "critical"])],
  title: (M) => M.title, href: (M) => relatedHref(M.related_type, M.related_id, "/tasks?tab=alerts"),
  dims: { user: attr("owner_id"), property: relatedProperty },
  facets: { severity: cattr("severity"), rule_key: cattr("rule_key") },
  cols: [C("severity", "Severity", "status"), C("status", "Status", "status"), U_COL("owner_id", "Owner"),
    C("related_label", "Related to"), C("created_at", "Raised", "datetime")],
  module_href: "/tasks?tab=alerts", better: "down",
});

// ============================================================================ PIPELINE

const OPPORTUNITY = "pipeline.models:Opportunity";
const OPP_COLS = [P_COL(), C("stage", "Stage", "status"),
  Col("days", "Days in stage", daysSince(attr("stage_entered_at")), "days"),
  U_COL("owner_id", "Owner"), C("next_action_at", "Next action", "datetime")];

function stalled(M: any, c: Ctx) {
  const S = load("pipeline.models:PipelineStageSetting");
  const fallback = _const("pipeline.models:DEFAULT_STALL_DAYS", 14);
  const days = S !== null
    ? sql`coalesce((select ${S.stall_days} from ${S} where ${eq(S.stage, M.stage)}), ${fallback}::int)`
    : sql`${fallback}::int`;
  return lt(M.stage_entered_at, sql`${nowLit(c)} - make_interval(0, 0, 0, ${days})`);
}

function _opp(
  key: string, label: string, definition: string, where: Fn,
  kw: { date?: string; family?: string; cols?: Col[]; sort?: Fn; unit?: string; agg?: string; measure?: Fn;
    measure_label?: string; hit_label?: string; better?: string } = {},
) {
  const { date, family, cols, sort, ...rest } = kw;
  K({
    key, label, family: family ?? "pipeline", module: "pipeline", model: OPPORTUNITY, definition, where,
    title: (M) => M.title, href: (M) => link("/pipeline/", M.id), dims: oppDims(date),
    facets: { priority: cattr("priority"), dead_reason: cattr("dead_reason"), stage: cattr("stage") },
    cols: cols ?? OPP_COLS, sort: sort ?? ((M) => [M.stage_entered_at]), module_href: "/pipeline?view=table", ...rest,
  });
}

_opp("pipeline.active", "Active opportunities", "Opportunities in an active stage (sourced through closing).",
  (M) => [inList(M.stage, activeStages())]);
_opp("pipeline.stalled", "Stalled opportunities", "Active opportunities that have been in their stage longer "
  + "than the stage's stall threshold (default 14 days).",
  (M, c) => [inList(M.stage, activeStages()), stalled(M, c)], { better: "down" });
_opp("pipeline.no_next_action", "No next action", "Active opportunities without a scheduled next action.",
  (M) => [inList(M.stage, activeStages()), isNull(M.next_action_at)], { better: "down" });
_opp("pipeline.avg_days_in_stage", "Avg. days in current stage", "Average days active opportunities have "
  + "spent in their current stage.", (M) => [inList(M.stage, activeStages())],
  { unit: "days", agg: "avg", measure: daysSince(attr("stage_entered_at")), measure_label: "Days in stage", better: "down" });
_opp("pipeline.dead", "Opportunities marked dead", "Opportunities moved to dead in the period (by dead date).",
  (M) => [eq(M.stage, "dead")], {
    date: "dead_at",
    cols: [P_COL(), C("dead_reason", "Reason", "status"), C("price_gap", "Price gap", "currency"),
      U_COL("owner_id", "Owner"), C("dead_at", "Dead on", "datetime")],
    sort: (M) => [descOf(M.dead_at)], better: "down",
  });
_opp("pipeline.conversion", "Created-to-close conversion", "Of the opportunities created in the period, the "
  + "share that have reached closed.", () => [], {
    date: "created_at", unit: "percent", agg: "rate", measure: (M) => eq(M.stage, "closed"), hit_label: "Closed",
    cols: [P_COL(), C("stage", "Stage", "status"), C("source", "Source"), U_COL("owner_id", "Owner"),
      C("created_at", "Created", "datetime")],
    sort: (M) => [descOf(M.created_at)], better: "up",
  });
_opp("queue.next_actions_due", "Next actions due", "Active opportunities whose next action is due today or "
  + "earlier.", (M, c) => [inList(M.stage, activeStages()), lt(M.next_action_at, c.eod)], {
    cols: [...OPP_COLS.slice(0, 4), C("next_action", "Next action"), C("next_action_at", "Due", "datetime")],
    sort: (M) => [M.next_action_at], better: "down",
  });

K({
  key: "pipeline.stage_moves", label: "Stage moves", family: "pipeline", module: "pipeline",
  model: "pipeline.models:OpportunityEvent",
  definition: "Stage transitions recorded in the opportunity history (including overrides), by date moved.",
  title: (M) => opp(M.opportunity_id, "title"), href: (M) => link("/pipeline/", M.opportunity_id),
  dims: {
    date: attr("at"), user: attr("actor_id"),
    property: (M) => opp(M.opportunity_id, "property_id"),
    source: (M) => opp(M.opportunity_id, "source"), stage: attr("to_stage"),
  },
  facets: { to_stage: cattr("to_stage"), from_stage: cattr("from_stage") },
  cols: [C("from_stage", "From", "status"), C("to_stage", "To", "status"), C("actor_name", "By"),
    C("override", "Override", "bool"), C("at", "When", "datetime")],
  sort: (M) => [descOf(M.at)], module_href: "/pipeline?view=table", better: "up",
});

// ============================================================================ OFFERS

const OFFER = "offers.models:Offer";
const OFFER_DIMS = { user: attr("sent_by_id"), property: attr("property_id"), ...viaOpp() };
const OFFER_COLS = [P_COL(), C("version", "Version", "number"), C("status", "Status", "status"), C("price", "Price", "currency"),
  C("sent_at", "Sent", "datetime"), C("response_due_at", "Response due", "datetime")];

const offerTitle = (M: any) => concat(opp(M.opportunity_id, "title"), lit(" · v"), asVarchar(M.version));

function _offer(
  key: string, label: string, definition: string, where: Fn,
  kw: { date?: string; user?: Fn; sort?: Fn; unit?: string; agg?: string; measure?: Fn; measure_label?: string;
    hit_label?: string; better?: string } = {},
) {
  const { date, user, sort, ...rest } = kw;
  const dims: Record<string, Fn> = { ...OFFER_DIMS };
  if (date) dims.date = attr(date);
  if (user) dims.user = user;
  K({
    key, label, family: "offers", module: "offers", model: OFFER, definition, where,
    title: offerTitle, href: (M) => link("/offers/", M.id), dims,
    facets: { status: cattr("status"), structure: cattr("structure") }, cols: OFFER_COLS,
    sort: sort ?? ((M) => [descNullsLast(M.sent_at)]), module_href: "/offers", ...rest,
  });
}

const buyerSent = (M: any) => [eq(M.origin, "buyer"), isNotNull(M.sent_at)];

_offer("offers.sent", "Offers sent", "Buyer offer versions delivered to the seller in the period (each counter "
  + "we send counts).", buyerSent, { date: "sent_at", better: "up" });
_offer("offers.volume_sent", "Offer volume sent", "Total price of buyer offer versions sent in the period.",
  buyerSent, { date: "sent_at", unit: "currency", agg: "sum", measure: cattr("price"), measure_label: "Price" });
_offer("offers.accepted", "Offers accepted", "Offer versions accepted, by response date.",
  (M) => [eq(M.status, "accepted")], { date: "responded_at", better: "up" });
_offer("offers.acceptance_rate", "Offer acceptance rate", "Of buyer offer versions sent in the period, the share "
  + "whose status is accepted.", buyerSent, {
    date: "sent_at", unit: "percent", agg: "rate", measure: (M) => eq(M.status, "accepted"), hit_label: "Accepted",
    better: "up",
  });
_offer("offers.awaiting_response", "Offer responses overdue", "Sent or countered offers whose response due "
  + "time has passed.", (M, c) => [inList(M.status, ["sent", "countered"]), lt(M.response_due_at, nowLit(c))],
  { sort: (M) => [M.response_due_at], better: "down" });
_offer("offers.pending_approval", "Offers pending approval", "Offer versions submitted and awaiting approval.",
  (M) => [eq(M.status, "pending_approval")], { user: attr("submitted_by_id"), sort: (M) => [M.submitted_at] });

// ============================================================================ CONTRACTS

K({
  key: "contracts.executed", label: "Contracts executed", family: "contracts", module: "contracts",
  model: "contracts.models:Contract",
  definition: "Contracts with an execution date in the period (status executed or closed).",
  where: (M) => [inList(M.status, ["executed", "closed"])], title: (M) => M.title,
  href: (M) => link("/contracts/", M.id),
  dims: { date: attr("executed_on"), user: attr("owner_id"), property: attr("property_id"), ...viaOpp() },
  facets: { contract_type: cattr("contract_type") },
  cols: [P_COL(), C("contract_type", "Type", "status"), C("purchase_price", "Price", "currency"),
    C("executed_on", "Executed", "date"), U_COL("owner_id", "Owner")],
  sort: (M) => [descOf(M.executed_on)], module_href: "/contracts", better: "up",
});

const CRIT = "contracts.models:CriticalDate";
const CRIT_COLS = [C("date_type", "Type", "status"), C("related_label", "Record"), P_COL(), C("due_on", "Due", "date"),
  C("status", "Status", "status"), U_COL("owner_id", "Owner"), C("is_blocking", "Blocking", "bool")];

function _crit(key: string, label: string, definition: string, where: Fn, kw: { better?: string } = {}) {
  K({
    key, label, family: "contracts", module: "contracts", model: CRIT, definition, where,
    title: (M) => M.label, href: (M) => relatedHref(M.related_type, M.related_id, "/critical-dates"),
    dims: { user: attr("owner_id"), property: attr("property_id") },
    facets: { date_type: cattr("date_type"), related_type: cattr("related_type") }, cols: CRIT_COLS,
    sort: (M) => [M.due_on], module_href: "/critical-dates", ...kw,
  });
}

const OPEN_DATE = ["proposed", "confirmed"];

_crit("contracts.dates_due_14", "Critical dates in 14 days", "Open (proposed or confirmed) critical dates due "
  + "from today through the next 14 days, across contracts, leases, loans and offers.",
  (M, c) => [inList(M.status, OPEN_DATE), between(M.due_on, c.today, addDays(c.today, 14))]);
_crit("contracts.dates_missed", "Missed critical dates", "Critical dates marked missed, or still open after "
  + "their due date.",
  (M, c) => [or(eq(M.status, "missed"), and(inList(M.status, OPEN_DATE), lt(M.due_on, c.today)))],
  { better: "down" });
_crit("contracts.dates_unconfirmed", "Unconfirmed critical dates", "Rule or AI-proposed dates not yet confirmed "
  + "by a person.", (M) => [eq(M.status, "proposed")], { better: "down" });

K({
  key: "contracts.dd_overdue", label: "Overdue diligence items", family: "contracts", module: "contracts",
  model: "contracts.models:DDItem",
  definition: "Due diligence items not complete or waived whose due date has passed.",
  where: (M, c) => [notInList(M.status, ["complete", "waived"]), lt(M.due_on, c.today)],
  title: (M) => M.title, href: (M) => link("/contracts/", M.contract_id),
  dims: { user: attr("owner_id"), property: attr("property_id") }, facets: { category: cattr("category") },
  cols: [P_COL(), C("category", "Category", "status"), C("status", "Status", "status"), C("due_on", "Due", "date"),
    U_COL("owner_id", "Owner")],
  sort: (M) => [M.due_on], module_href: "/contracts", better: "down",
});

K({
  key: "contracts.high_risks", label: "Open high risks", family: "contracts", module: "contracts",
  model: "contracts.models:RiskItem",
  definition: "Risk register entries of high or critical severity that are open or being mitigated.",
  where: (M) => [inList(M.status, ["open", "mitigating"]), inList(M.severity, ["high", "critical"])],
  title: (M) => M.title, href: (M) => link("/contracts/", M.contract_id),
  dims: { user: attr("owner_id"), property: attr("property_id") }, facets: { category: cattr("category") },
  cols: [P_COL(), C("category", "Category", "status"), C("severity", "Severity", "status"),
    C("decision_due_on", "Decision due", "date"), C("cost_impact", "Cost impact", "currency")],
  sort: (M) => [nullsLast(M.decision_due_on)], module_href: "/contracts", better: "down",
});

// ============================================================================ CLOSINGS

const CLOSING = "closing.models:Closing";
const CLOSING_DIMS = { user: attr("coordinator_id"), property: attr("property_id"), ...viaOpp() };
const CLOSING_COLS = [P_COL(), C("status", "Status", "status"), C("purchase_price", "Price", "currency"),
  C("scheduled_closing_on", "Scheduled", "date"), C("closed_on", "Closed", "date"),
  U_COL("coordinator_id", "Coordinator")];

function _closing(
  key: string, label: string, definition: string, where: Fn,
  kw: { date?: string; sort?: Fn; unit?: string; agg?: string; measure?: Fn; measure_label?: string; better?: string } = {},
) {
  const { date, sort, ...rest } = kw;
  K({
    key, label, family: "closings", module: "closing", model: CLOSING, definition, where,
    title: (M) => propLabel(M.property_id), href: (M) => link("/closings/", M.id),
    dims: { ...CLOSING_DIMS, ...(date ? { date: attr(date) } : {}) }, cols: CLOSING_COLS,
    sort: sort ?? ((M) => [descNullsLast(M.closed_on)]), module_href: "/closings", ...rest,
  });
}

_closing("closings.completed", "Closings completed", "Acquisitions closed in the period (closing status "
  + "completed, by closing date).", (M) => [eq(M.status, "completed")], { date: "closed_on", better: "up" });
_closing("closings.volume", "Closed volume", "Total purchase price of closings completed in the period.",
  (M) => [eq(M.status, "completed")], {
    date: "closed_on", unit: "currency", agg: "sum", measure: cattr("purchase_price"),
    measure_label: "Purchase price", better: "up",
  });
_closing("closings.scheduled_30", "Closings in 30 days", "Open closings scheduled from today through the next "
  + "30 days.", (M, c) => [eq(M.status, "open"), between(M.scheduled_closing_on, c.today, addDays(c.today, 30))],
  { sort: (M) => [M.scheduled_closing_on] });

K({
  key: "closings.wires_pending", label: "Wires awaiting verification", family: "closings", module: "closing",
  model: "closing.models:WireVerification",
  definition: "Current wire instructions on open closings whose independent callback verification is still "
    + "pending.",
  where: (M) => {
    const CL = load(CLOSING);
    return [
      isTrue(M.is_current), eq(M.result, "pending"),
      sql`${M.closing_id} in (select ${CL.id} from ${CL} where ${eq(CL.status, "open")})`,
    ];
  },
  title: (M) => propLabel(parent(CLOSING, M.closing_id, "property_id")),
  href: (M) => link("/closings/", M.closing_id),
  dims: {
    property: (M) => parent(CLOSING, M.closing_id, "property_id"),
    user: (M) => parent(CLOSING, M.closing_id, "coordinator_id"),
  },
  cols: [C("amount", "Amount", "currency"), C("received_at", "Received", "datetime"), C("result", "Result", "status")],
  sort: (M) => [M.received_at], module_href: "/closings", better: "down",
});

// ============================================================================ PORTFOLIO — assets

const ASSET = "assets.models:Asset";
const ASSET_COLS = [P_COL(), C("status", "Status", "status"), C("acquired_on", "Acquired", "date"),
  C("basis", "Basis", "currency"), C("current_value", "Current value", "currency"),
  U_COL("manager_id", "Manager")];
const ASSET_DIMS = { user: attr("manager_id"), property: attr("property_id") };

function _asset(
  key: string, label: string, definition: string, where: Fn,
  kw: { date?: string; sort?: Fn; unit?: string; agg?: string; measure?: Fn; measure_label?: string; better?: string } = {},
) {
  const { date, sort, ...rest } = kw;
  K({
    key, label, family: "portfolio", module: "assets", model: ASSET, definition, where,
    title: (M) => propLabel(M.property_id), href: (M) => link("/assets/", M.id),
    dims: { ...ASSET_DIMS, ...(date ? { date: attr(date) } : {}) }, cols: ASSET_COLS,
    sort: sort ?? ((M) => [descNullsLast(M.current_value)]), module_href: "/assets", ...rest,
  });
}

const activeStatus = (M: any) => [eq(M.status, "active")];

_asset("portfolio.active_assets", "Active assets", "Owned assets with status active.", activeStatus);
_asset("portfolio.value", "Portfolio value", "Sum of current value of active assets (latest mark).",
  activeStatus, { unit: "currency", agg: "sum", measure: cattr("current_value"), measure_label: "Current value", better: "up" });
_asset("portfolio.basis", "Cost basis", "Sum of cost basis of active assets.",
  activeStatus, { unit: "currency", agg: "sum", measure: cattr("basis"), measure_label: "Basis" });
_asset("portfolio.acquired", "Assets acquired", "Assets with an acquisition date in the period.",
  () => [], { date: "acquired_on", sort: (M) => [descNullsLast(M.acquired_on)], better: "up" });

K({
  key: "portfolio.watchlist_open", label: "Open watchlist items", family: "portfolio", module: "assets",
  model: "assets.models:WatchlistEntry",
  definition: "Open watchlist episodes (coverage, occupancy, tenant credit, maintenance, covenant, maturity, "
    + "variance).",
  where: (M) => [eq(M.status, "open")],
  title: (M) => concat(propLabel(parent(ASSET, M.asset_id, "property_id")), lit(" · "), M.trigger),
  href: (M) => link("/assets/", M.asset_id),
  dims: {
    property: (M) => parent(ASSET, M.asset_id, "property_id"),
    user: (M) => parent(ASSET, M.asset_id, "manager_id"),
  },
  facets: { trigger: cattr("trigger"), severity: cattr("severity") },
  cols: [C("trigger", "Trigger", "status"), C("severity", "Severity", "status"), C("detail", "Detail"),
    C("first_detected_at", "Since", "datetime")],
  sort: (M) => [M.first_detected_at], module_href: "/assets", better: "down",
});

// ============================================================================ PORTFOLIO — leases

const LEASE = "leases.models:Lease";
const LEASE_COLS = [P_COL(), C("status", "Status", "status"), C("lease_type", "Type", "status"),
  C("rentable_sf", "SF", "number"), C("base_rent_annual", "Annual rent", "currency"),
  C("expiration_on", "Expires", "date")];
const LEASE_DIMS = { user: attr("manager_id"), property: attr("property_id") };
const LEASE_FACETS = { lease_type: cattr("lease_type"), exp_year: yearOf("expiration_on") };

function _lease(
  key: string, label: string, definition: string, where: Fn,
  kw: { sort?: Fn; unit?: string; agg?: string; measure?: Fn; measure_label?: string; better?: string } = {},
) {
  const { sort, ...rest } = kw;
  K({
    key, label, family: "portfolio", module: "leases", model: LEASE, definition, where,
    title: (M) => M.tenant_name, href: (M) => link("/leases/", M.id), dims: LEASE_DIMS,
    facets: LEASE_FACETS, cols: LEASE_COLS, sort: sort ?? ((M) => [nullsLast(M.expiration_on)]),
    module_href: "/leases", ...rest,
  });
}

const expiring = (days: number) => (M: any, c: Ctx) =>
  [eq(M.status, "active"), between(M.expiration_on, c.today, addDays(c.today, days))];

_lease("leases.active", "Active leases", "Leases with status active.", activeStatus);
_lease("leases.expiring_12m", "Leases expiring in 12 months", "Active leases expiring from today through the "
  + "next 12 months.", expiring(365));
_lease("leases.rent_expiring_12m", "Rent expiring in 12 months", "Annual base rent of active leases expiring "
  + "within the next 12 months.", expiring(365), {
    unit: "currency", agg: "sum", measure: cattr("base_rent_annual"), measure_label: "Annual rent", better: "down",
  });
_lease("leases.rent_by_expiration", "Rent rolling (10 years)", "Annual base rent of active leases expiring "
  + "within the next 10 years; break down by expiration year.", expiring(3653), {
    unit: "currency", agg: "sum", measure: cattr("base_rent_annual"), measure_label: "Annual rent",
  });
_lease("leases.holdover", "Active leases past expiration", "Leases still marked active whose expiration date "
  + "has passed (holdover or data to update).", (M, c) => [eq(M.status, "active"), lt(M.expiration_on, c.today)],
  { better: "down" });
_lease("leases.unverified", "Unverified active leases", "Active leases whose abstracted terms have not been "
  + "verified by a person.", (M) => [eq(M.status, "active"), isFalse(M.verified)], { better: "down" });

K({
  key: "leases.option_notices_90", label: "Option notice deadlines in 90 days", family: "portfolio", module: "leases",
  model: "leases.models:LeaseOption",
  definition: "Open lease options (renewal, termination, expansion, purchase, ROFR/ROFO) whose notice window "
    + "closes within the next 90 days.",
  where: (M, c) => [eq(M.status, "open"), between(M.notice_end_on, c.today, addDays(c.today, 90))],
  title: (M) => concat(parent(LEASE, M.lease_id, "tenant_name"), lit(" · "), M.option_type),
  href: (M) => link("/leases/", M.lease_id),
  dims: {
    property: (M) => parent(LEASE, M.lease_id, "property_id"),
    user: (M) => parent(LEASE, M.lease_id, "manager_id"),
  },
  facets: { option_type: cattr("option_type") },
  cols: [C("option_type", "Option", "status"), C("notice_start_on", "Notice opens", "date"),
    C("notice_end_on", "Notice deadline", "date"), C("verified", "Verified", "bool")],
  sort: (M) => [M.notice_end_on], module_href: "/leases",
});

function aging(M: any, c: Ctx) {
  return caseWhen([
    [gte(M.due_on, addDays(c.today, -30)), lit("d1_30")],
    [gte(M.due_on, addDays(c.today, -60)), lit("d31_60")],
    [gte(M.due_on, addDays(c.today, -90)), lit("d61_90")],
  ], lit("d90_plus"));
}

K({
  key: "receivables.delinquent", label: "Delinquent balance", family: "portfolio", module: "receivables",
  model: "receivables.models:Charge",
  definition: "Unpaid balance (amount less amount paid) of open or partially paid charges past their due date.",
  where: (M, c) => [inList(M.status, ["open", "partial"]), lt(M.due_on, c.today)],
  title: (M) => coalesce(M.tenant_name, M.charge_type),
  href: (M) => link("/receivables/tenants/", M.lease_id, "/receivables"),
  dims: { property: attr("property_id"), user: (M) => parent(LEASE, M.lease_id, "manager_id") },
  facets: { aging, charge_type: cattr("charge_type") }, unit: "currency", agg: "sum",
  measure: (M) => sql`(${M.amount} - ${M.amount_paid})`, measure_label: "Balance",
  cols: [P_COL(), C("charge_type", "Charge", "status"), C("due_on", "Due", "date"), C("amount", "Amount", "currency"),
    C("amount_paid", "Paid", "currency")],
  sort: (M) => [M.due_on], module_href: "/receivables", better: "down",
});

K({
  key: "receivables.collected", label: "Rent collected", family: "portfolio", module: "receivables",
  model: "receivables.models:Payment",
  definition: "Tenant payments received in the period (excluding reversed payments).",
  where: (M) => [eq(M.status, "received")], title: (M) => coalesce(M.tenant_name, M.reference),
  href: (M) => link("/receivables/tenants/", M.lease_id, "/receivables"),
  dims: {
    date: attr("received_on"), property: attr("property_id"),
    user: (M) => parent(LEASE, M.lease_id, "manager_id"),
  },
  facets: { method: cattr("method") }, unit: "currency", agg: "sum", measure: cattr("amount"), measure_label: "Amount",
  cols: [P_COL(), C("method", "Method", "status"), C("received_on", "Received", "date")],
  sort: (M) => [descOf(M.received_on)], module_href: "/receivables", better: "up",
});

// ============================================================================ PORTFOLIO — debt

const LOAN = "debt.models:Loan";
const LOAN_COLS = [P_COL(), C("lender_name", "Lender"), C("loan_type", "Type", "status"), C("rate_type", "Rate type", "status"),
  C("rate", "Rate %", "number"), C("current_balance", "Balance", "currency"),
  C("maturity_on", "Maturity", "date"), C("covenant_state", "Covenants", "status")];
const LOAN_FACETS = {
  rate_type: cattr("rate_type"), loan_type: cattr("loan_type"), lender: cattr("lender_name"),
  maturity_year: yearOf("maturity_on"), covenant_state: cattr("covenant_state"),
};

function _loan(
  key: string, label: string, definition: string, where: Fn,
  kw: { sort?: Fn; unit?: string; agg?: string; measure?: Fn; weight?: Fn; measure_label?: string;
    weight_label?: string; better?: string } = {},
) {
  const { sort, ...rest } = kw;
  K({
    key, label, family: "portfolio", module: "debt", model: LOAN, definition, where,
    title: (M) => coalesce(M.name, M.loan_number, M.lender_name), href: (M) => link("/loans/", M.id),
    dims: { user: attr("owner_id"), property: attr("property_id") }, facets: LOAN_FACETS, cols: LOAN_COLS,
    sort: sort ?? ((M) => [nullsLast(M.maturity_on)]), module_href: "/loans", ...rest,
  });
}

const maturing = (days: number) => (M: any, c: Ctx) =>
  [eq(M.status, "active"), between(M.maturity_on, c.today, addDays(c.today, days))];

_loan("debt.total_balance", "Debt outstanding", "Current balance of active loans.",
  activeStatus, { unit: "currency", agg: "sum", measure: cattr("current_balance"), measure_label: "Balance" });
_loan("debt.weighted_rate", "Weighted avg. rate", "Balance-weighted average all-in rate of active loans.",
  activeStatus, {
    unit: "percent", agg: "wavg", measure: cattr("rate"), weight: cattr("current_balance"),
    measure_label: "Rate %", weight_label: "Balance", better: "down",
  });
_loan("debt.floating_balance", "Floating-rate balance", "Current balance of active floating-rate loans.",
  (M) => [eq(M.status, "active"), eq(M.rate_type, "floating")],
  { unit: "currency", agg: "sum", measure: cattr("current_balance"), measure_label: "Balance" });
_loan("debt.maturing_12m", "Loans maturing in 12 months", "Active loans maturing from today through the next "
  + "12 months.", maturing(365), { better: "down" });
_loan("debt.maturing_12m_balance", "Debt maturing in 12 months", "Balance of active loans maturing within the "
  + "next 12 months.", maturing(365), {
    unit: "currency", agg: "sum", measure: cattr("current_balance"), measure_label: "Balance", better: "down",
  });
_loan("debt.balance_by_maturity", "Debt by maturity year", "Balance of active loans with a maturity date; break "
  + "down by maturity year.", (M) => [eq(M.status, "active"), isNotNull(M.maturity_on)], {
    unit: "currency", agg: "sum", measure: cattr("current_balance"), measure_label: "Balance",
  });
_loan("debt.covenant_breach", "Loans in covenant breach", "Active loans whose worst covenant state is breach or "
  + "projected breach.", (M) => [eq(M.status, "active"), inList(M.covenant_state, ["breach", "projected_breach"])],
  { better: "down" });
_loan("debt.covenant_watch", "Loans on covenant watch", "Active loans whose worst covenant state is watch.",
  (M) => [eq(M.status, "active"), eq(M.covenant_state, "watch")], { better: "down" });
_loan("debt.caps_expiring_180", "Rate caps expiring in 180 days", "Active floating-rate loans whose rate cap "
  + "expires within the next 180 days.",
  (M, c) => [eq(M.status, "active"), eq(M.rate_type, "floating"),
    between(M.cap_expires_on, c.today, addDays(c.today, 180))],
  { sort: (M) => [M.cap_expires_on], better: "down" });
_loan("debt.floating_uncapped", "Uncapped floating loans", "Active floating-rate loans with no rate cap or an "
  + "expired cap.", (M, c) => [eq(M.status, "active"), eq(M.rate_type, "floating"),
    or(isNull(M.cap_expires_on), lt(M.cap_expires_on, c.today))], { better: "down" });

K({
  key: "debt.reports_overdue", label: "Lender reports overdue", family: "portfolio", module: "debt",
  model: "debt.models:LenderReportingObligation",
  definition: "Active lender reporting obligations whose next due date has passed.",
  where: (M, c) => [isTrue(M.is_active), lt(M.next_due_on, c.today)],
  title: (M) => concat(coalesce(M.label, M.report_type), lit(" · "), parent(LOAN, M.loan_id, "lender_name")),
  href: (M) => link("/loans/", M.loan_id),
  dims: { user: attr("owner_id"), property: (M) => parent(LOAN, M.loan_id, "property_id") },
  facets: { report_type: cattr("report_type") },
  cols: [C("report_type", "Report", "status"), C("frequency", "Frequency", "status"), C("next_due_on", "Due", "date"),
    U_COL("owner_id", "Owner")],
  sort: (M) => [M.next_due_on], module_href: "/loans", better: "down",
});

// ============================================================================ OPERATIONS

const WO = "maintenance.models:WorkOrder";
const WO_OPEN = ["open", "assigned", "in_progress"];
const WO_COLS = [P_COL(), C("category", "Category", "status"), C("priority", "Priority", "status"),
  C("status", "Status", "status"), U_COL("assigned_user_id", "Assignee"), C("due_on", "Due", "date")];

function _wo(
  key: string, label: string, definition: string, where: Fn,
  kw: { date?: string; cols?: Col[]; sort?: Fn; unit?: string; agg?: string; measure?: Fn; measure_label?: string;
    better?: string } = {},
) {
  const { date, cols, sort, ...rest } = kw;
  K({
    key, label, family: "operations", module: "maintenance", model: WO, definition, where,
    title: (M) => concat(lit("#"), asVarchar(M.number), lit(" "), M.title),
    href: (M) => link("/work-orders/", M.id),
    dims: { user: attr("assigned_user_id"), property: attr("property_id"), ...(date ? { date: attr(date) } : {}) },
    facets: { priority: cattr("priority"), category: cattr("category"), status: cattr("status") },
    cols: cols ?? WO_COLS, sort: sort ?? ((M) => [nullsLast(M.due_on)]), module_href: "/work-orders", ...rest,
  });
}

_wo("operations.wo_open", "Open work orders", "Work orders open, assigned or in progress.",
  (M) => [inList(M.status, WO_OPEN)]);
_wo("operations.wo_overdue", "Overdue work orders", "Open work orders whose due date has passed.",
  (M, c) => [inList(M.status, WO_OPEN), lt(M.due_on, c.today)], { better: "down" });
_wo("operations.wo_completed", "Work orders completed", "Work orders completed or verified, by completion date.",
  (M) => [inList(M.status, ["completed", "verified"])], {
    date: "completed_at",
    cols: [...WO_COLS.slice(0, 5), C("completed_at", "Completed", "datetime"), C("actual_cost", "Cost", "currency")],
    sort: (M) => [descOf(M.completed_at)], better: "up",
  });
_wo("operations.wo_avg_days", "Avg. days to complete", "Average days from report (or creation) to completion "
  + "for work orders completed in the period.",
  (M) => [inList(M.status, ["completed", "verified"]), isNotNull(M.completed_at)], {
    date: "completed_at", unit: "days", agg: "avg",
    measure: (M) => sql`extract(epoch from ${M.completed_at} - coalesce(${M.reported_at}, ${M.created_at})) / 86400.0`,
    measure_label: "Days to complete", sort: (M) => [descOf(M.completed_at)], better: "down",
  });

K({
  key: "operations.pm_due_14", label: "Preventive maintenance due in 14 days", family: "operations",
  module: "maintenance", model: "maintenance.models:PMSchedule",
  definition: "Active preventive-maintenance schedules whose next service date is within 14 days or past.",
  where: (M, c) => [isTrue(M.is_active), lte(M.next_service_on, addDays(c.today, 14))],
  title: (M) => M.title, href: () => lit("/work-orders"),
  dims: { user: attr("default_assignee_id"), property: attr("property_id") },
  facets: { frequency: cattr("frequency") },
  cols: [P_COL(), C("system", "System"), C("frequency", "Frequency", "status"), C("next_service_on", "Next service", "date")],
  sort: (M) => [M.next_service_on], module_href: "/work-orders",
});

K({
  key: "operations.findings_open", label: "Open high-severity findings", family: "operations", module: "maintenance",
  model: "maintenance.models:InspectionFinding",
  definition: "Inspection findings of high or critical severity still open.",
  where: (M) => [eq(M.status, "open"), inList(M.severity, ["high", "critical"])],
  title: (M) => M.title,
  href: (M) => link("/work-orders/", M.work_order_id, "/inspections"),
  dims: {
    property: attr("property_id"),
    user: (M) => parent("maintenance.models:Inspection", M.inspection_id, "inspector_id"),
  },
  facets: { severity: cattr("severity"), category: cattr("category") },
  cols: [P_COL(), C("category", "Category", "status"), C("severity", "Severity", "status"),
    C("created_at", "Found", "datetime")], module_href: "/inspections", better: "down",
});

const VENDOR = "operations.models:Vendor";
K({
  key: "operations.vendor_credentials", label: "Vendor credentials expired or expiring", family: "operations",
  module: "operations", model: "operations.models:VendorCredential",
  definition: "Required vendor credentials (license, COI, W-9) that are expired or expire within 30 days.",
  where: (M, c) => [isTrue(M.is_required), ne(M.status, "rejected"),
    or(eq(M.status, "expired"), lte(M.expires_on, addDays(c.today, 30)))],
  title: (M) => concat(parent(VENDOR, M.vendor_id, "name"), lit(" · "), M.name),
  href: (M) => link("/vendors/", M.vendor_id), facets: { kind: cattr("kind") },
  cols: [C("kind", "Credential", "status"), C("status", "Status", "status"), C("expires_on", "Expires", "date")],
  sort: (M) => [nullsFirst(M.expires_on)], module_href: "/vendors", better: "down",
});

K({
  key: "operations.insurance_expiring_60", label: "Insurance policies expiring in 60 days", family: "operations",
  module: "operations", model: "operations.models:InsurancePolicy",
  definition: "Active or pending-renewal insurance policies expiring within the next 60 days (or already past).",
  where: (M, c) => [inList(M.status, ["active", "pending_renewal"]), lte(M.expires_on, addDays(c.today, 60))],
  title: (M) => concat(M.carrier, lit(" · "), M.coverage_type), href: () => lit("/insurance"),
  dims: { property: attr("property_id") }, facets: { coverage_type: cattr("coverage_type") },
  cols: [P_COL(), C("coverage_type", "Coverage", "status"), C("premium", "Premium", "currency"),
    C("expires_on", "Expires", "date")],
  sort: (M) => [M.expires_on], module_href: "/insurance", better: "down",
});

K({
  key: "operations.coi_deficient", label: "Deficient or expired certificates", family: "operations",
  module: "operations", model: "operations.models:InsuranceCertificate",
  definition: "Tenant and vendor certificates of insurance marked deficient or expired.",
  where: (M) => [inList(M.status, ["deficient", "expired"])],
  title: (M) => coalesce(M.tenant_name, parent(VENDOR, M.vendor_id, "name"), M.carrier),
  href: (M) => link("/vendors/", M.vendor_id, "/insurance"),
  dims: { property: attr("property_id") }, facets: { holder_kind: cattr("holder_kind") },
  cols: [P_COL(), C("holder_kind", "Holder", "status"), C("status", "Status", "status"), C("expires_on", "Expires", "date")],
  module_href: "/insurance", better: "down",
});

const PROJECT = "operations.models:CapitalProject";
const PROJECT_ACTIVE = ["approved", "bidding", "awarded", "in_progress"];
const PROJECT_COLS = [P_COL(), C("status", "Status", "status"), C("original_budget", "Original budget", "currency"),
  C("current_budget", "Current budget", "currency"), C("target_completion_on", "Target", "date"),
  U_COL("manager_id", "Manager")];
for (const [key, label, definition, where, extra] of [
  ["operations.capex_active", "Active capital projects", "Capital projects approved, bidding, awarded or in "
    + "progress.", (M: any) => [inList(M.status, PROJECT_ACTIVE)], {}],
  ["operations.capex_budget", "Active capex budget", "Current budget of active capital projects.",
    (M: any) => [inList(M.status, PROJECT_ACTIVE)],
    { unit: "currency", agg: "sum", measure: cattr("current_budget"), measure_label: "Current budget" }],
  ["operations.capex_over_budget", "Capital projects over budget", "Active capital projects whose current "
    + "budget exceeds the original approved budget.",
    (M: any) => [inList(M.status, PROJECT_ACTIVE), gt(M.current_budget, M.original_budget)], { better: "down" }],
] as Array<[string, string, string, Fn, Partial<KpiInit>]>) {
  K({
    key, label, family: "operations", module: "operations", model: PROJECT, definition, where,
    title: (M) => M.name, href: (M) => link("/capital-projects/", M.id),
    dims: { user: attr("manager_id"), property: attr("property_id") }, facets: { category: cattr("category") },
    cols: PROJECT_COLS, sort: (M) => [nullsLast(M.target_completion_on)], module_href: "/capital-projects",
    ...extra,
  });
}

K({
  key: "operations.tax_due_30", label: "Property tax payments due in 30 days", family: "operations",
  module: "operations", model: "operations.models:TaxPayment",
  definition: "Scheduled or late property tax installments due within the next 30 days (or past due).",
  where: (M, c) => [inList(M.status, ["scheduled", "late"]), lte(M.due_on, addDays(c.today, 30))],
  title: (M) => concat(propLabel(M.property_id), lit(" · "), asVarchar(M.tax_year)),
  href: () => lit("/insurance"), dims: { property: attr("property_id") },
  unit: "currency", agg: "sum", measure: cattr("amount_due"), measure_label: "Amount due",
  cols: [C("installment", "Installment"), C("status", "Status", "status"), C("due_on", "Due", "date")],
  sort: (M) => [M.due_on], module_href: "/insurance",
});

// ============================================================================ BROKERAGE

const LISTING = "brokerage.models:Listing";
const LIVE_LISTINGS = ["coming_soon", "active", "under_contract"];
const LISTING_COLS = [P_COL(), C("listing_type", "Type", "status"), C("status", "Status", "status"),
  C("asking_price", "Asking", "currency"), C("listed_on", "Listed", "date"),
  C("expires_on", "Expires", "date"), U_COL("agent_id", "Agent")];

function _listing(key: string, label: string, definition: string, where: Fn, kw: { sort?: Fn; better?: string } = {}) {
  K({
    key, label, family: "brokerage", module: "brokerage", model: LISTING, definition, where,
    title: (M) => coalesce(M.headline, propLabel(M.property_id)),
    href: (M) => link("/listings/", M.id), dims: { user: attr("agent_id"), property: attr("property_id") },
    facets: { listing_type: cattr("listing_type"), status: cattr("status") }, cols: LISTING_COLS,
    sort: kw.sort ?? ((M) => [nullsLast(M.expires_on)]), module_href: "/listings", better: kw.better,
  });
}

_listing("brokerage.active_listings", "Live listings", "Listings coming soon, active or under contract.",
  (M) => [inList(M.status, LIVE_LISTINGS)]);
_listing("brokerage.listings_expiring_30", "Listings expiring in 30 days", "Live listings whose listing "
  + "agreement expires within the next 30 days.",
  (M, c) => [inList(M.status, LIVE_LISTINGS), between(M.expires_on, c.today, addDays(c.today, 30))],
  { better: "down" });

K({
  key: "brokerage.inquiries", label: "New inquiries", family: "brokerage", module: "brokerage",
  model: "brokerage.models:Inquiry",
  definition: "Buyer/tenant inquiries received in the period.",
  title: (M) => coalesce(M.contact_name, lit("Inquiry")),
  href: (M) => link("/listings/", M.listing_id, "/brokerage"),
  dims: {
    date: attr("received_at"), user: attr("assigned_to_id"), property: attr("property_id"),
    source: attr("source"),
  },
  facets: { status: cattr("status") },
  cols: [P_COL(), C("source", "Source", "status"), C("status", "Status", "status"), U_COL("assigned_to_id", "Assigned"),
    C("received_at", "Received", "datetime")],
  sort: (M) => [descOf(M.received_at)], module_href: "/brokerage", better: "up",
});

K({
  key: "brokerage.showings", label: "Showings completed", family: "brokerage", module: "brokerage",
  model: "brokerage.models:Showing",
  definition: "Showings with status completed, by scheduled date.",
  where: (M) => [eq(M.status, "completed")], title: (M) => coalesce(M.contact_name, propLabel(M.property_id)),
  href: (M) => link("/listings/", M.listing_id, "/brokerage"),
  dims: { date: attr("scheduled_at"), user: attr("shown_by_id"), property: attr("property_id") },
  facets: { interest_level: cattr("interest_level") },
  cols: [P_COL(), C("interest_level", "Interest", "status"), U_COL("shown_by_id", "Shown by"),
    C("scheduled_at", "When", "datetime")],
  sort: (M) => [descOf(M.scheduled_at)], module_href: "/brokerage", better: "up",
});

const DEAL = "brokerage.models:BrokerageDeal";

function dealProb(M: any) {
  const probs = _const<Record<string, number>>("brokerage.models:STAGE_PROBABILITY", {});
  const entries = Object.entries(probs);
  const fallback = entries.length
    ? caseWhen(entries.map(([s, p]) => [eq(M.stage, s), sql`${Number(p)}::float8`] as [any, any]), sql`0.0::float8`)
    : sql`0.0::float8`;
  const norm = caseWhen([
    [isNull(M.probability), NULL_SQL],
    [lte(M.probability, 1), sql`${M.probability} * 100`],
  ], sql`least(${M.probability}, 100)`);
  return coalesce(norm, fallback);
}

const DEAL_COLS = [P_COL(), C("side", "Side", "status"), C("stage", "Stage", "status"), C("deal_value", "Deal value", "currency"),
  C("gross_commission_estimate", "GCI est.", "currency"), C("expected_close_on", "Expected close", "date"),
  U_COL("agent_id", "Agent")];

function _deal(
  key: string, label: string, definition: string, where: Fn,
  kw: { date?: string; sort?: Fn; unit?: string; agg?: string; measure?: Fn; measure_label?: string;
    better?: string } = {},
) {
  const { date, sort, ...rest } = kw;
  K({
    key, label, family: "brokerage", module: "brokerage", model: DEAL, definition, where,
    title: (M) => M.title, href: () => lit("/brokerage"),
    dims: {
      user: attr("agent_id"), property: attr("property_id"), stage: attr("stage"),
      ...(date ? { date: attr(date) } : {}),
    },
    facets: { side: cattr("side") }, cols: DEAL_COLS,
    sort: sort ?? ((M) => [nullsLast(M.expected_close_on)]), module_href: "/brokerage", ...rest,
  });
}

const activeDeal = (M: any) => [inList(M.stage, _const<string[]>("brokerage.models:ACTIVE_DEAL_STAGES", []))];

_deal("brokerage.active_deals", "Active brokerage deals", "Brokerage deals in an active stage (lead through "
  + "closing).", activeDeal);
_deal("brokerage.pipeline_gci", "GCI pipeline", "Estimated gross commission of active brokerage deals.",
  activeDeal, { unit: "currency", agg: "sum", measure: cattr("gross_commission_estimate"), measure_label: "GCI est." });
_deal("brokerage.weighted_gci", "Weighted GCI pipeline", "Estimated gross commission of active deals weighted by "
  + "win probability (deal override, else the stage default).", activeDeal, {
    unit: "currency", agg: "sum",
    measure: (M) => sql`(${M.gross_commission_estimate} * ${dealProb(M)} / 100.0)`,
    measure_label: "Weighted GCI", better: "up",
  });
_deal("brokerage.deals_closed", "Brokerage deals closed", "Brokerage deals closed in the period.",
  (M) => [eq(M.stage, "closed")], { date: "closed_on", sort: (M) => [descOf(M.closed_on)], better: "up" });

const COMMISSION = "commissions.models:Commission";

/** Agents without commissions:view_sensitive only see commissions they hold or have a split on. */
function commissionScope(M: any, c: Ctx) {
  if (c.user.can("commissions", "view_sensitive")) return [];
  const S = load("commissions.models:CommissionSplit");
  const mine = sql`(select ${S.commission_id} from ${S} where ${and(eq(S.agent_id, c.user.id), isNull(S.deleted_at))})`;
  return [or(eq(M.agent_id, c.user.id), sql`${M.id} in ${mine}`)];
}

const COMM_DIMS: Record<string, Fn> = {
  date: attr("earned_on"), user: attr("agent_id"), property: attr("property_id"), source: attr("source"),
};
const COMM_COLS = [P_COL(), C("side", "Side", "status"), C("status", "Status", "status"), U_COL("agent_id", "Agent"),
  C("earned_on", "Earned", "date")];
for (const [key, label, definition, where, extra] of [
  ["commissions.earned_count", "Commissions earned", "Commissions earned, invoiced or paid with an earned date in "
    + "the period (only those visible to you).", (M: any) => [inList(M.status, ["earned", "invoiced", "paid"])], {}],
  ["commissions.earned", "Gross commission earned", "Gross commission of commissions earned in the period.",
    (M: any) => [inList(M.status, ["earned", "invoiced", "paid"])],
    {
      unit: "currency", agg: "sum", measure: cattr("gross"), measure_label: "Gross",
      requires: [["commissions", "view_sensitive"]],
    }],
  ["commissions.receivable", "Commission receivable", "Gross less amounts paid for commissions earned or "
    + "invoiced but not fully paid.", (M: any) => [inList(M.status, ["earned", "invoiced"])],
    {
      unit: "currency", agg: "sum", measure: (M: any) => sql`(${M.gross} - ${M.paid_total})`,
      measure_label: "Outstanding", requires: [["commissions", "view_sensitive"]], dims: without(COMM_DIMS, "date"),
    }],
] as Array<[string, string, string, Fn, Partial<KpiInit>]>) {
  const { dims, ...rest } = extra;
  K({
    key, label, family: "brokerage", module: "commissions", model: COMMISSION, definition, where,
    title: (M) => M.title, href: () => lit("/commissions"), dims: dims ?? COMM_DIMS,
    facets: { side: cattr("side"), status: cattr("status") }, cols: COMM_COLS, scope: commissionScope,
    sort: (M) => [descNullsLast(M.earned_on)], module_href: "/commissions", better: "up", ...rest,
  });
}

// ============================================================================ DATA

function band(M: any) {
  const s = M.completeness_score;
  return caseWhen([[lt(s, 25), lit("0-24")], [lt(s, 50), lit("25-49")], [lt(s, 75), lit("50-74")]], lit("75-100"));
}

const DATA_PROP = {
  family: "data", module: "properties", model: PROPERTY, title: propTitle,
  href: (M: any) => link("/properties/", M.id), module_href: "/data-quality",
  facets: { band, property_type: cattr("property_type") },
  cols: [...PROP_COLS, C("completeness_score", "Completeness %", "percent")],
  sort: (M: any) => [M.completeness_score],
};

K({
  key: "data.avg_completeness", label: "Avg. data completeness", definition: "Average completeness score (0–100) "
    + "of property records.", dims: propDims(), unit: "percent", agg: "avg", measure: cattr("completeness_score"),
  measure_label: "Completeness %", better: "up", ...DATA_PROP,
});
K({
  key: "data.properties_total", label: "Properties tracked", definition: "All live property records; break down by "
    + "completeness band.", dims: propDims(), ...DATA_PROP,
});
K({
  key: "data.low_completeness", label: "Low-completeness properties", definition: "Properties with a completeness "
    + "score below 50.", where: (M) => [lt(M.completeness_score, 50)], dims: propDims(), better: "down", ...DATA_PROP,
});
K({
  key: "data.missing_location", label: "Properties without location", definition: "Properties with no geocoded "
    + "point (cannot appear on the map or in radius/territory rules).", where: (M) => [isNull(M.location)],
  dims: propDims(), better: "down", ...DATA_PROP,
});

const OBS = "app.common.provenance:FieldObservation";
const OBS_COLS = [Col("property", "Property", (M: any) => propLabel(M.entity_id)), C("field", "Field"),
  C("source", "Source"), C("confidence", "Confidence", "number"), C("ai_derived", "AI", "bool"),
  C("recorded_at", "Recorded", "datetime")];
for (const [key, label, definition, where] of [
  ["data.unverified_observations", "Unverified property facts", "Current property field values (material facts) "
    + "not yet verified by a person.",
    (M: any) => [eq(M.entity_type, "property"), isTrue(M.is_current), eq(M.verification, "unverified")]],
  ["data.ai_unverified", "AI-derived facts awaiting review", "Current AI-derived property values that remain "
    + "unverified.", (M: any) => [eq(M.entity_type, "property"), isTrue(M.is_current), isTrue(M.ai_derived),
    eq(M.verification, "unverified")]],
] as Array<[string, string, string, Fn]>) {
  K({
    key, label, family: "data", module: "properties", model: OBS, definition, where,
    title: (M) => concat(propLabel(M.entity_id), lit(" · "), M.field),
    href: (M) => link("/properties/", M.entity_id),
    dims: {
      date: attr("recorded_at"), user: attr("recorded_by_id"), property: attr("entity_id"),
      source: attr("source"),
    },
    facets: { field: cattr("field") }, cols: OBS_COLS, sort: (M) => [descOf(M.recorded_at)],
    module_href: "/data-quality", better: "down",
  });
}

const IMPORT_JOB = "imports.models:ImportJob";

function jobProvider(M: any): SQL {
  const J = load(IMPORT_JOB);
  const S = load("imports.models:DataSource");
  const [j, s] = [newAlias(), newAlias()];
  return sql`(select ${qcol(s, "provider")} from ${fromAs(J, j)} join ${fromAs(S, s)} on ${qcol(s, "id")} = ${qcol(j, "data_source_id")} where ${qcol(j, "id")} = ${M.job_id})`;
}

for (const [key, label, status] of [
  ["data.import_invalid", "Invalid import rows", "invalid"],
  ["data.import_duplicates", "Duplicate import rows", "duplicate"],
]) {
  K({
    key, label, family: "data", module: "imports", model: "imports.models:ImportRow",
    definition: `Staged import rows with status ${status}, by import date.`,
    where: (M) => [eq(M.status, status)],
    title: (M) => concat(parent(IMPORT_JOB, M.job_id, "filename"), lit(" · row "), asVarchar(M.row_number)),
    href: (M) => link("/imports/", M.job_id),
    dims: {
      date: (M) => parent(IMPORT_JOB, M.job_id, "created_at"),
      user: (M) => parent(IMPORT_JOB, M.job_id, "created_by_id"), source: jobProvider,
    },
    cols: [Col("source", "Source", (M: any) => jobProvider(M)), C("status", "Status", "status")],
    sort: (M) => [M.job_id, M.row_number], module_href: "/imports", better: "down",
  });
}

const DATA_SOURCE = "imports.models:DataSource";
const DS_COLS = [C("cadence", "Cadence", "status"), C("cost", "Cost", "currency"), C("renewal_date", "Renewal", "date"),
  C("redistribution_allowed", "Redistribution", "bool")];
K({
  key: "data.sources_active", label: "Active data sources", family: "data", module: "imports", model: DATA_SOURCE,
  definition: "Data sources/licenses registered as active, with their cost where known.",
  where: (M) => [isTrue(M.is_active)], title: (M) => M.provider, href: () => lit("/imports"),
  dims: { source: attr("provider") }, cols: DS_COLS, sort: (M) => [M.provider], module_href: "/imports",
});
K({
  key: "data.sources_renewing", label: "Data licenses renewing in 60 days", family: "data", module: "imports",
  model: DATA_SOURCE, definition: "Active data sources whose license renews within the next 60 days.",
  where: (M, c) => [isTrue(M.is_active), between(M.renewal_date, c.today, addDays(c.today, 60))],
  title: (M) => M.provider, href: () => lit("/imports"), dims: { source: attr("provider") },
  cols: DS_COLS, sort: (M) => [M.renewal_date], module_href: "/imports",
});

// ============================================================================ REACTIVATION

const REACT = "reactivation.models:ReactivationItem";
const REACT_COLS = [P_COL(), C("trigger_type", "Trigger", "status"), C("status", "Status", "status"),
  C("what_changed", "What changed"), U_COL("owner_id", "Owner"), C("fired_at", "Fired", "datetime")];

function _react(
  key: string, label: string, definition: string, where: Fn,
  kw: { date?: string; sort?: Fn; unit?: string; agg?: string; measure?: Fn; hit_label?: string; better?: string } = {},
) {
  const { date, sort, ...rest } = kw;
  K({
    key, label, family: "reactivation", module: "reactivation", model: REACT, definition, where,
    title: (M) => opp(M.opportunity_id, "title"),
    href: (M) => link("/pipeline/", M.opportunity_id, "/reactivation"),
    dims: {
      user: attr("owner_id"), property: attr("property_id"),
      source: (M) => opp(M.opportunity_id, "source"), ...(date ? { date: attr(date) } : {}),
    },
    facets: { trigger_type: cattr("trigger_type") }, cols: REACT_COLS,
    sort: sort ?? ((M) => [descOf(M.fired_at)]), module_href: "/reactivation", ...rest,
  });
}

_react("reactivation.pending", "Reactivation queue", "Dead opportunities returned by a trigger and awaiting a "
  + "decision (pending, or snoozed past their snooze date).",
  (M, c) => [or(eq(M.status, "pending"), and(eq(M.status, "snoozed"), lte(M.snoozed_until, c.today)))]);
_react("reactivation.fired", "Reactivations triggered", "Reactivation items created in the period (trigger fired).",
  () => [], { date: "fired_at" });
_react("reactivation.converted", "Reactivations converted", "Reactivated opportunities that converted, by "
  + "conversion date.", (M) => [isTrue(M.converted)], { date: "converted_at", better: "up" });
_react("reactivation.conversion_rate", "Reactivation conversion rate", "Of reactivation items fired in the period, "
  + "the share that converted.", () => [], {
    date: "fired_at", unit: "percent", agg: "rate", measure: (M) => isTrue(M.converted), hit_label: "Converted",
    better: "up",
  });

K({
  key: "reactivation.armed", label: "Armed reactivation triggers", family: "reactivation", module: "reactivation",
  model: "reactivation.models:ReactivationTrigger",
  definition: "Watches armed on dead opportunities that have not fired or been cancelled.",
  where: (M) => [eq(M.status, "armed")], title: (M) => opp(M.opportunity_id, "title"),
  href: (M) => link("/pipeline/", M.opportunity_id, "/reactivation"),
  dims: { property: attr("property_id"), user: (M) => opp(M.opportunity_id, "owner_id") },
  facets: { trigger_type: cattr("trigger_type") },
  cols: [P_COL(), C("trigger_type", "Trigger", "status"), C("fire_on", "Fires on", "date"), C("dead_reason", "Dead reason", "status")],
  sort: (M) => [nullsLast(M.fire_on)], module_href: "/reactivation",
});

// ============================================================================ COMPLIANCE (outreach family)

const OUTBOUND = "compliance.models:OutboundMessage";

const msgHref = (M: any) => link("/people/", M.person_id, "/compliance");

for (const [key, label, definition, where, extra] of [
  ["compliance.sends", "Outbound attempts", "Outbound calls/SMS/emails attempted, including those blocked at send "
    + "time.", () => [], {}],
  ["compliance.blocked", "Blocked sends", "Outbound attempts blocked by consent, DNC, suppression, quiet-hours or "
    + "frequency rules.", (M: any) => [isFalse(M.allowed)], { better: "down" }],
] as Array<[string, string, string, Fn, Partial<KpiInit>]>) {
  K({
    key, label, family: "outreach", module: "compliance", model: OUTBOUND, definition, where,
    title: (M, c) => masked(M.to_value, c), href: msgHref,
    dims: { date: attr("sent_at"), user: attr("actor_id") }, facets: { channel: cattr("channel") },
    cols: [C("channel", "Channel", "status"), C("allowed", "Allowed", "bool"), C("actor_name", "By"),
      Col("reasons", "Block reasons", (M: any) => asVarchar(M.block_reasons)),
      C("sent_at", "When", "datetime")],
    sort: (M) => [descOf(M.sent_at)], module_href: "/compliance", ...extra,
  });
}

for (const [key, label, event] of [
  ["compliance.opt_outs", "Opt-outs", "opt_out"],
  ["compliance.consent_revoked", "Consent revocations", "consent_revoked"],
]) {
  K({
    key, label, family: "outreach", module: "compliance", model: "compliance.models:ConsentEvent",
    definition: `Consent events of type ${event.replace(/_/g, " ")} recorded in the period.`,
    where: (M) => [eq(M.event_type, event)], title: (M, c) => masked(M.normalized_value, c),
    href: msgHref, dims: { date: attr("occurred_at"), user: attr("actor_id") },
    cols: [C("channel", "Channel", "status"), C("source", "Source"), C("actor_name", "By"),
      C("occurred_at", "When", "datetime")],
    sort: (M) => [descOf(M.occurred_at)], module_href: "/compliance",
  });
}

const CREC = "compliance.models:ComplianceRecord";
const CREC_COLS = [C("channel", "Channel", "status"), C("dnc_status", "DNC", "status"), C("consent_state", "Consent", "status"),
  C("scrub_expires_on", "Scrub expires", "date"), C("internal_suppression", "Suppressed", "bool")];
for (const [key, label, definition, where] of [
  ["compliance.dnc_listed", "Numbers on DNC", "Phone/SMS contact values whose last scrub found them on a "
    + "do-not-call list.", (M: any) => [eq(M.dnc_status, "listed")]],
  ["compliance.scrub_expired", "Phones without a valid DNC scrub", "Phone records never scrubbed or whose scrub "
    + "has expired.", (M: any, c: Ctx) => [eq(M.channel, "phone"),
    or(isNull(M.scrub_expires_on), lt(M.scrub_expires_on, c.today))]],
  ["compliance.suppressed", "Internally suppressed contacts", "Contact values on the internal suppression list.",
    (M: any) => [isTrue(M.internal_suppression)]],
] as Array<[string, string, string, Fn]>) {
  K({
    key, label, family: "outreach", module: "compliance", model: CREC, definition, where,
    title: (M, c) => masked(M.value, c), href: (M) => link("/people/", M.person_id, "/compliance"),
    facets: { channel: cattr("channel") }, cols: CREC_COLS, sort: (M) => [descOf(M.updated_at)],
    module_href: "/compliance", better: "down",
  });
}
