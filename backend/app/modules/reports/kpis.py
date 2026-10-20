"""KPI registry (spec 34). Each metric has a stable key, label, family, definition text, unit, the SQL
builder (model + conditions + aggregation + filter dimensions) and the drill-through link of every record.

Metric definitions live here once and are reused by every dashboard, the drill-through pages, exports,
schedules and snapshots, so the same number means the same thing across modules.
"""
from datetime import timedelta

from sqlalchemy import DateTime, Interval, String, and_, case, cast, func, literal, null, or_, select
from sqlalchemy.orm import aliased

from app.modules.reports.engine import Col, Kpi, load, property_source

REGISTRY: dict[str, Kpi] = {}


def K(**kw) -> None:
    k = Kpi(**kw)
    REGISTRY[k.key] = k


def get(key: str) -> Kpi | None:
    return REGISTRY.get(key)


# ============================================================================ expression helpers


def attr(name: str):
    return lambda M: getattr(M, name)


def cattr(name: str):
    return lambda M, c: getattr(M, name)


def prop_label(col):
    P = aliased(load("properties.models:Property"))
    return select(func.coalesce(P.name, P.address_line)).where(P.id == col).scalar_subquery()


def user_name(col):
    U = aliased(load("auth.models:User"))
    return select(U.full_name).where(U.id == col).scalar_subquery()


def parent(ref: str, col, name: str):
    X = aliased(load(ref))
    return select(getattr(X, name)).where(X.id == col).scalar_subquery()


def opp(col, name: str):
    return parent("pipeline.models:Opportunity", col, name)


def link(prefix: str, col, fallback: str | None = None):
    return case((col.is_(None), literal(fallback) if fallback else null()),
                else_=func.concat(prefix, cast(col, String)))


ROUTES = {
    "property": "/properties/", "opportunity": "/pipeline/", "contract": "/contracts/", "lease": "/leases/",
    "loan": "/loans/", "offer": "/offers/", "closing": "/closings/", "asset": "/assets/", "person": "/people/",
    "organization": "/organizations/", "work_order": "/work-orders/", "listing": "/listings/",
    "vendor": "/vendors/", "capital_project": "/capital-projects/", "disposition": "/dispositions/",
    "uw_model": "/underwriting/", "underwriting": "/underwriting/", "document": "/documents/",
}


def related_href(type_col, id_col, fallback: str):
    whens = [(and_(type_col == t, id_col.is_not(None)), func.concat(p, cast(id_col, String))) for t, p in ROUTES.items()]
    return case(*whens, else_=literal(fallback))


def masked(expr, c):
    """Contact values are masked unless the viewer may see sensitive contact data."""
    if c.user.can("contacts", "view_sensitive"):
        return expr
    return case((expr.is_(None), null()), else_=func.concat("•••", func.right(expr, 4)))


def now_lit(c):
    return literal(c.now, DateTime(timezone=True))


def days_since(fn):
    return lambda M, c: func.extract("epoch", now_lit(c) - fn(M)) / 86400.0


def C(key: str, label: str, kind: str = "text", expr=None) -> Col:
    return Col(key, label, expr or cattr(key), kind)


def P_COL(name: str = "property_id") -> Col:
    return Col("property", "Property", lambda M, c: prop_label(getattr(M, name)))


def U_COL(name: str, label: str) -> Col:
    return Col(name, label, lambda M, c: user_name(getattr(M, name)))


def year_of(name: str):
    return lambda M, c: func.to_char(getattr(M, name), "YYYY")


def _const(ref: str, default):
    value = load(ref)
    return value if value is not None else default


def active_stages() -> list[str]:
    return _const("pipeline.models:ACTIVE_STAGES", ["sourced", "screening", "research", "underwriting", "contact",
                                                    "negotiation", "offer", "under_contract", "due_diligence",
                                                    "closing"])


def opp_dims(date: str | None = None) -> dict:
    d = {"user": attr("owner_id"), "property": attr("property_id"), "source": attr("source"), "stage": attr("stage")}
    if date:
        d["date"] = attr(date)
    return d


def via_opp(name: str = "opportunity_id") -> dict:
    return {"source": lambda M: opp(getattr(M, name), "source"), "stage": lambda M: opp(getattr(M, name), "stage")}


# ============================================================================ SOURCING

PROPERTY = "properties.models:Property"
PROP_COLS = [C("city", "City"), C("state", "State"), C("property_type", "Type", "status"), C("status", "Status", "status")]


def _prop_dims(date: str | None = None) -> dict:
    d = {"property": attr("id"), "source": lambda M: property_source(M.id)}
    if date:
        d["date"] = attr(date)
    return d


def _prop_title(M, c):
    return func.coalesce(M.name, M.address_line)


K(key="sourcing.properties_added", label="Properties added", family="sourcing", module="properties", model=PROPERTY,
  definition="Property records created in the period (manual entry or import). Source is the data source of the "
             "import that created the record.",
  title=_prop_title, href=lambda M, c: link("/properties/", M.id), dims={**_prop_dims("created_at"), "user": attr("created_by_id")},
  cols=PROP_COLS + [C("created_at", "Added", "datetime")], module_href="/properties", better="up")

K(key="sourcing.opportunities_created", label="Opportunities created", family="sourcing", module="pipeline",
  model="pipeline.models:Opportunity",
  definition="Acquisition opportunities opened in the period (any stage).",
  title=lambda M, c: M.title, href=lambda M, c: link("/pipeline/", M.id), dims=opp_dims("created_at"),
  cols=[P_COL(), C("stage", "Stage", "status"), C("source", "Source"), U_COL("owner_id", "Owner"),
        C("created_at", "Created", "datetime")],
  facets={"priority": cattr("priority")}, module_href="/pipeline?view=table", better="up")

SIGNAL = "signals.models:Signal"


def _sig_live(S, c):
    return and_(S.status == "active", or_(S.expires_on.is_(None), S.expires_on >= c.today))


def _sig_title(M, c):
    t = func.coalesce(M.title, M.signal_type)
    if c.user.can("signals", "view_sensitive"):
        return t
    return case((M.is_sensitive.is_(True), literal("Sensitive signal")), else_=t)


def _sig_source(M, c):
    if c.user.can("signals", "view_sensitive"):
        return M.source
    return case((M.is_sensitive.is_(True), literal("Internal")), else_=M.source)


SIG_COLS = [P_COL(), C("category", "Category", "status"), C("signal_type", "Type", "status"),
            C("severity", "Severity", "number"), C("observed_on", "Observed", "date"),
            Col("source", "Source", _sig_source)]
SIG_FACETS = {"category": cattr("category"), "severity": cattr("severity"), "signal_type": cattr("signal_type")}
SIG_DIMS = {"property": attr("property_id"), "source": attr("source"), "user": attr("created_by_id")}


def _sig_href(M, c):
    return link("/properties/", M.property_id, "/signals")


K(key="sourcing.signals_new", label="New signals", family="sourcing", module="signals", model=SIGNAL,
  definition="Motivation/market signals observed in the period (by observed date), any status.",
  title=_sig_title, href=_sig_href, dims={**SIG_DIMS, "date": attr("observed_on")}, facets=SIG_FACETS, cols=SIG_COLS,
  sort=lambda M, c: [M.observed_on.desc()], module_href="/signals", better="up")

K(key="signals.active", label="Active signals", family="sourcing", module="signals", model=SIGNAL,
  definition="Signals with status active that have not passed their expiry date.",
  where=lambda M, c: [_sig_live(M, c)], title=_sig_title, href=_sig_href, dims=SIG_DIMS, facets=SIG_FACETS,
  cols=SIG_COLS, sort=lambda M, c: [M.severity.desc(), M.observed_on.desc()], module_href="/signals")

K(key="signals.high_severity", label="High-severity signals", family="sourcing", module="signals", model=SIGNAL,
  definition="Active, unexpired signals with severity 4 or 5.",
  where=lambda M, c: [_sig_live(M, c), M.severity >= 4], title=_sig_title, href=_sig_href, dims=SIG_DIMS,
  facets=SIG_FACETS, cols=SIG_COLS, sort=lambda M, c: [M.severity.desc(), M.observed_on.desc()],
  module_href="/signals")

K(key="signals.expiring_30", label="Signals expiring in 30 days", family="sourcing", module="signals", model=SIGNAL,
  definition="Active signals whose expiry date falls within the next 30 days.",
  where=lambda M, c: [M.status == "active", M.expires_on.between(c.today, c.today + timedelta(days=30))],
  title=_sig_title, href=_sig_href, dims=SIG_DIMS, facets=SIG_FACETS,
  cols=SIG_COLS + [C("expires_on", "Expires", "date")], sort=lambda M, c: [M.expires_on], module_href="/signals")


def _stacked(M, c):
    S = load(SIGNAL)
    sub = (select(S.property_id).where(S.deleted_at.is_(None), _sig_live(S, c), S.property_id.is_not(None))
           .group_by(S.property_id).having(func.count(func.distinct(S.category)) >= 2))
    return [M.id.in_(sub)]


def _signal_count(M, c):
    S = load(SIGNAL)
    return (select(func.count()).select_from(S)
            .where(S.property_id == M.id, S.deleted_at.is_(None), _sig_live(S, c)).scalar_subquery())


K(key="sourcing.stacked_signal_properties", label="Properties with stacked signals", family="sourcing",
  module="signals", model=PROPERTY, requires=(("properties", "view"),),
  definition="Properties with active signals in two or more different categories (stacked motivation).",
  where=_stacked, title=_prop_title, href=lambda M, c: link("/properties/", M.id), dims=_prop_dims(),
  cols=PROP_COLS + [Col("signals", "Active signals", _signal_count, "number")], module_href="/signals")

K(key="sourcing.high_score_properties", label="High-band opportunity scores", family="sourcing", module="scoring",
  model="scoring.models:OpportunityScore",
  definition="Properties whose current opportunity score is in the high band.",
  where=lambda M, c: [M.is_current.is_(True), M.band == "high"], title=lambda M, c: prop_label(M.property_id),
  href=lambda M, c: link("/properties/", M.property_id, "/scoring"), dims={"property": attr("property_id")},
  cols=[C("score", "Score", "number"), C("confidence", "Confidence", "number"), C("computed_at", "Scored", "datetime")],
  sort=lambda M, c: [M.score.desc()], module_href="/scoring")

# ============================================================================ OUTREACH

INTERACTION = "outreach.models:Interaction"
INT_DIMS = {"date": attr("occurred_at"), "user": attr("logged_by_id"), "property": attr("property_id"),
            **via_opp()}
INT_FACETS = {"channel": cattr("channel"), "disposition": cattr("disposition"), "direction": cattr("direction")}
INT_COLS = [C("channel", "Channel", "status"), C("direction", "Direction", "status"),
            C("disposition", "Disposition", "status"), P_COL(), U_COL("logged_by_id", "Logged by"),
            C("occurred_at", "When", "datetime")]


def _int_title(M, c):
    return func.coalesce(M.subject, func.concat(M.channel, " · ", func.coalesce(M.disposition, M.direction)))


def _int_href(M, c):
    return func.coalesce(link("/people/", M.person_id), link("/organizations/", M.organization_id),
                         link("/pipeline/", M.opportunity_id), link("/properties/", M.property_id),
                         literal("/interactions"))


def _int(key, label, definition, where=None, **kw):
    K(key=key, label=label, family=kw.pop("family", "outreach"), module="outreach", model=INTERACTION,
      definition=definition, where=where or (lambda M, c: []), title=_int_title, href=_int_href,
      dims=kw.pop("dims", INT_DIMS), facets=INT_FACETS, cols=kw.pop("cols", INT_COLS),
      sort=kw.pop("sort", lambda M, c: [M.occurred_at.desc()]), module_href="/interactions", **kw)


_int("outreach.interactions", "Interactions logged", "Every logged touchpoint (call, email, SMS, meeting, tour, "
     "letter, note) by occurrence date.", better="up")
_int("outreach.meaningful", "Meaningful conversations", "Interactions flagged meaningful (a real conversation or "
     "meeting).", where=lambda M, c: [M.is_meaningful.is_(True)], better="up")
_int("outreach.connect_rate", "Call connect rate", "Share of outbound calls with disposition connected.",
     where=lambda M, c: [M.channel == "call", M.direction == "outbound"], unit="percent", agg="rate",
     measure=lambda M, c: M.disposition == "connected", hit_label="Connected", better="up")
_int("outreach.open_loops", "Open loops", "Meaningful interactions with no next action, no follow-up task and "
     "no recorded loop closure.",
     where=lambda M, c: [M.is_meaningful.is_(True), M.loop_closed.is_(False), M.next_action_at.is_(None),
                         M.follow_up_task_id.is_(None)], better="down")
_int("outreach.follow_ups_due", "Follow-ups due", "Interactions whose next action is due today or earlier and "
     "whose loop is not closed.",
     where=lambda M, c: [M.loop_closed.is_(False), M.next_action_at < c.eod],
     dims={k: v for k, v in INT_DIMS.items() if k != "date"},
     cols=INT_COLS + [C("next_action", "Next action"), C("next_action_at", "Due", "datetime")],
     sort=lambda M, c: [M.next_action_at], better="down")

TASK = "tasks.models:Task"
OPEN_TASK = ("open", "in_progress")
TASK_DIMS = {"user": attr("assignee_id"),
             "property": lambda M: case((M.related_type == "property", M.related_id), else_=null())}
TASK_COLS = [C("task_type", "Type", "status"), C("priority", "Priority", "status"), C("status", "Status", "status"),
             U_COL("assignee_id", "Assignee"), C("related_label", "Related to"), C("due_at", "Due", "datetime")]
TASK_FACETS = {"task_type": cattr("task_type"), "priority": cattr("priority")}


def _task(key, label, definition, where, **kw):
    K(key=key, label=label, family="outreach", module="tasks", model=TASK, definition=definition, where=where,
      title=lambda M, c: M.title, href=lambda M, c: related_href(M.related_type, M.related_id, "/tasks"),
      dims=kw.pop("dims", TASK_DIMS), facets=TASK_FACETS, cols=TASK_COLS,
      sort=kw.pop("sort", lambda M, c: [M.due_at]), module_href="/tasks", **kw)


_task("tasks.overdue", "Overdue tasks", "Open or in-progress tasks whose due time has passed.",
      lambda M, c: [M.status.in_(OPEN_TASK), M.due_at < now_lit(c)], better="down")
_task("tasks.due_today", "Tasks due today", "Open or in-progress tasks due between now and the end of today.",
      lambda M, c: [M.status.in_(OPEN_TASK), M.due_at >= now_lit(c), M.due_at < c.eod])
_task("tasks.completed", "Tasks completed", "Tasks marked done, by completion date.",
      lambda M, c: [M.status == "done"], dims={**TASK_DIMS, "date": attr("completed_at")},
      sort=lambda M, c: [M.completed_at.desc()], better="up")

K(key="tasks.alerts_open_high", label="High-severity alerts", family="outreach", module="tasks",
  model="tasks.models:Alert",
  definition="Alerts not yet resolved with severity high or critical.",
  where=lambda M, c: [M.status != "resolved", M.severity.in_(["high", "critical"])],
  title=lambda M, c: M.title, href=lambda M, c: related_href(M.related_type, M.related_id, "/tasks?tab=alerts"),
  dims={"user": attr("owner_id"),
        "property": lambda M: case((M.related_type == "property", M.related_id), else_=null())},
  facets={"severity": cattr("severity"), "rule_key": cattr("rule_key")},
  cols=[C("severity", "Severity", "status"), C("status", "Status", "status"), U_COL("owner_id", "Owner"),
        C("related_label", "Related to"), C("created_at", "Raised", "datetime")],
  module_href="/tasks?tab=alerts", better="down")

# ============================================================================ PIPELINE

OPPORTUNITY = "pipeline.models:Opportunity"
OPP_COLS = [P_COL(), C("stage", "Stage", "status"), Col("days", "Days in stage", days_since(attr("stage_entered_at")), "days"),
            U_COL("owner_id", "Owner"), C("next_action_at", "Next action", "datetime")]


def _stalled(M, c):
    S = load("pipeline.models:PipelineStageSetting")
    default = _const("pipeline.models:DEFAULT_STALL_DAYS", 14)
    days = (func.coalesce(select(S.stall_days).where(S.stage == M.stage).scalar_subquery(), default)
            if S is not None else literal(default))
    return M.stage_entered_at < now_lit(c) - func.make_interval(0, 0, 0, days, type_=Interval)


def _opp(key, label, definition, where, date=None, **kw):
    K(key=key, label=label, family=kw.pop("family", "pipeline"), module="pipeline", model=OPPORTUNITY,
      definition=definition, where=where, title=lambda M, c: M.title, href=lambda M, c: link("/pipeline/", M.id),
      dims=opp_dims(date), facets={"priority": cattr("priority"), "dead_reason": cattr("dead_reason"),
                                   "stage": cattr("stage")},
      cols=kw.pop("cols", OPP_COLS), sort=kw.pop("sort", lambda M, c: [M.stage_entered_at]),
      module_href="/pipeline?view=table", **kw)


_opp("pipeline.active", "Active opportunities", "Opportunities in an active stage (sourced through closing).",
     lambda M, c: [M.stage.in_(active_stages())])
_opp("pipeline.stalled", "Stalled opportunities", "Active opportunities that have been in their stage longer "
     "than the stage's stall threshold (default 14 days).",
     lambda M, c: [M.stage.in_(active_stages()), _stalled(M, c)], better="down")
_opp("pipeline.no_next_action", "No next action", "Active opportunities without a scheduled next action.",
     lambda M, c: [M.stage.in_(active_stages()), M.next_action_at.is_(None)], better="down")
_opp("pipeline.avg_days_in_stage", "Avg. days in current stage", "Average days active opportunities have "
     "spent in their current stage.", lambda M, c: [M.stage.in_(active_stages())], unit="days", agg="avg",
     measure=days_since(attr("stage_entered_at")), measure_label="Days in stage", better="down")
_opp("pipeline.dead", "Opportunities marked dead", "Opportunities moved to dead in the period (by dead date).",
     lambda M, c: [M.stage == "dead"], date="dead_at",
     cols=[P_COL(), C("dead_reason", "Reason", "status"), C("price_gap", "Price gap", "currency"),
           U_COL("owner_id", "Owner"), C("dead_at", "Dead on", "datetime")],
     sort=lambda M, c: [M.dead_at.desc()], better="down")
_opp("pipeline.conversion", "Created-to-close conversion", "Of the opportunities created in the period, the "
     "share that have reached closed.", lambda M, c: [], date="created_at", unit="percent", agg="rate",
     measure=lambda M, c: M.stage == "closed", hit_label="Closed",
     cols=[P_COL(), C("stage", "Stage", "status"), C("source", "Source"), U_COL("owner_id", "Owner"),
           C("created_at", "Created", "datetime")], sort=lambda M, c: [M.created_at.desc()], better="up")
_opp("queue.next_actions_due", "Next actions due", "Active opportunities whose next action is due today or "
     "earlier.", lambda M, c: [M.stage.in_(active_stages()), M.next_action_at < c.eod],
     cols=OPP_COLS[:4] + [C("next_action", "Next action"), C("next_action_at", "Due", "datetime")],
     sort=lambda M, c: [M.next_action_at], better="down")

K(key="pipeline.stage_moves", label="Stage moves", family="pipeline", module="pipeline",
  model="pipeline.models:OpportunityEvent",
  definition="Stage transitions recorded in the opportunity history (including overrides), by date moved.",
  title=lambda M, c: opp(M.opportunity_id, "title"), href=lambda M, c: link("/pipeline/", M.opportunity_id),
  dims={"date": attr("at"), "user": attr("actor_id"),
        "property": lambda M: opp(M.opportunity_id, "property_id"),
        "source": lambda M: opp(M.opportunity_id, "source"), "stage": attr("to_stage")},
  facets={"to_stage": cattr("to_stage"), "from_stage": cattr("from_stage")},
  cols=[C("from_stage", "From", "status"), C("to_stage", "To", "status"), C("actor_name", "By"),
        C("override", "Override", "bool"), C("at", "When", "datetime")],
  sort=lambda M, c: [M.at.desc()], module_href="/pipeline?view=table", better="up")

# ============================================================================ OFFERS

OFFER = "offers.models:Offer"
OFFER_DIMS = {"user": attr("sent_by_id"), "property": attr("property_id"), **via_opp()}
OFFER_COLS = [P_COL(), C("version", "Version", "number"), C("status", "Status", "status"), C("price", "Price", "currency"),
              C("sent_at", "Sent", "datetime"), C("response_due_at", "Response due", "datetime")]


def _offer_title(M, c):
    return func.concat(opp(M.opportunity_id, "title"), " · v", cast(M.version, String))


def _offer(key, label, definition, where, date=None, **kw):
    dims = dict(OFFER_DIMS)
    if date:
        dims["date"] = attr(date)
    if "user" in kw:
        dims["user"] = kw.pop("user")
    K(key=key, label=label, family="offers", module="offers", model=OFFER, definition=definition, where=where,
      title=_offer_title, href=lambda M, c: link("/offers/", M.id), dims=dims,
      facets={"status": cattr("status"), "structure": cattr("structure")}, cols=OFFER_COLS,
      sort=kw.pop("sort", lambda M, c: [M.sent_at.desc().nulls_last()]), module_href="/offers", **kw)


_offer("offers.sent", "Offers sent", "Buyer offer versions delivered to the seller in the period (each counter "
       "we send counts).", lambda M, c: [M.origin == "buyer", M.sent_at.is_not(None)], date="sent_at", better="up")
_offer("offers.volume_sent", "Offer volume sent", "Total price of buyer offer versions sent in the period.",
       lambda M, c: [M.origin == "buyer", M.sent_at.is_not(None)], date="sent_at", unit="currency", agg="sum",
       measure=cattr("price"), measure_label="Price")
_offer("offers.accepted", "Offers accepted", "Offer versions accepted, by response date.",
       lambda M, c: [M.status == "accepted"], date="responded_at", better="up")
_offer("offers.acceptance_rate", "Offer acceptance rate", "Of buyer offer versions sent in the period, the share "
       "whose status is accepted.", lambda M, c: [M.origin == "buyer", M.sent_at.is_not(None)], date="sent_at",
       unit="percent", agg="rate", measure=lambda M, c: M.status == "accepted", hit_label="Accepted", better="up")
_offer("offers.awaiting_response", "Offer responses overdue", "Sent or countered offers whose response due "
       "time has passed.", lambda M, c: [M.status.in_(["sent", "countered"]), M.response_due_at < now_lit(c)],
       sort=lambda M, c: [M.response_due_at], better="down")
_offer("offers.pending_approval", "Offers pending approval", "Offer versions submitted and awaiting approval.",
       lambda M, c: [M.status == "pending_approval"], user=attr("submitted_by_id"),
       sort=lambda M, c: [M.submitted_at])

# ============================================================================ CONTRACTS

K(key="contracts.executed", label="Contracts executed", family="contracts", module="contracts",
  model="contracts.models:Contract",
  definition="Contracts with an execution date in the period (status executed or closed).",
  where=lambda M, c: [M.status.in_(["executed", "closed"])], title=lambda M, c: M.title,
  href=lambda M, c: link("/contracts/", M.id),
  dims={"date": attr("executed_on"), "user": attr("owner_id"), "property": attr("property_id"), **via_opp()},
  facets={"contract_type": cattr("contract_type")},
  cols=[P_COL(), C("contract_type", "Type", "status"), C("purchase_price", "Price", "currency"),
        C("executed_on", "Executed", "date"), U_COL("owner_id", "Owner")],
  sort=lambda M, c: [M.executed_on.desc()], module_href="/contracts", better="up")

CRIT = "contracts.models:CriticalDate"
CRIT_COLS = [C("date_type", "Type", "status"), C("related_label", "Record"), P_COL(), C("due_on", "Due", "date"),
             C("status", "Status", "status"), U_COL("owner_id", "Owner"), C("is_blocking", "Blocking", "bool")]


def _crit(key, label, definition, where, **kw):
    K(key=key, label=label, family="contracts", module="contracts", model=CRIT, definition=definition, where=where,
      title=lambda M, c: M.label, href=lambda M, c: related_href(M.related_type, M.related_id, "/critical-dates"),
      dims={"user": attr("owner_id"), "property": attr("property_id")},
      facets={"date_type": cattr("date_type"), "related_type": cattr("related_type")}, cols=CRIT_COLS,
      sort=lambda M, c: [M.due_on], module_href="/critical-dates", **kw)


_crit("contracts.dates_due_14", "Critical dates in 14 days", "Open (proposed or confirmed) critical dates due "
      "from today through the next 14 days, across contracts, leases, loans and offers.",
      lambda M, c: [M.status.in_(["proposed", "confirmed"]), M.due_on.between(c.today, c.today + timedelta(days=14))])
_crit("contracts.dates_missed", "Missed critical dates", "Critical dates marked missed, or still open after "
      "their due date.",
      lambda M, c: [or_(M.status == "missed", and_(M.status.in_(["proposed", "confirmed"]), M.due_on < c.today))],
      better="down")
_crit("contracts.dates_unconfirmed", "Unconfirmed critical dates", "Rule or AI-proposed dates not yet confirmed "
      "by a person.", lambda M, c: [M.status == "proposed"], better="down")

K(key="contracts.dd_overdue", label="Overdue diligence items", family="contracts", module="contracts",
  model="contracts.models:DDItem",
  definition="Due diligence items not complete or waived whose due date has passed.",
  where=lambda M, c: [M.status.notin_(["complete", "waived"]), M.due_on < c.today],
  title=lambda M, c: M.title, href=lambda M, c: link("/contracts/", M.contract_id),
  dims={"user": attr("owner_id"), "property": attr("property_id")}, facets={"category": cattr("category")},
  cols=[P_COL(), C("category", "Category", "status"), C("status", "Status", "status"), C("due_on", "Due", "date"),
        U_COL("owner_id", "Owner")],
  sort=lambda M, c: [M.due_on], module_href="/contracts", better="down")

K(key="contracts.high_risks", label="Open high risks", family="contracts", module="contracts",
  model="contracts.models:RiskItem",
  definition="Risk register entries of high or critical severity that are open or being mitigated.",
  where=lambda M, c: [M.status.in_(["open", "mitigating"]), M.severity.in_(["high", "critical"])],
  title=lambda M, c: M.title, href=lambda M, c: link("/contracts/", M.contract_id),
  dims={"user": attr("owner_id"), "property": attr("property_id")}, facets={"category": cattr("category")},
  cols=[P_COL(), C("category", "Category", "status"), C("severity", "Severity", "status"),
        C("decision_due_on", "Decision due", "date"), C("cost_impact", "Cost impact", "currency")],
  sort=lambda M, c: [M.decision_due_on.nulls_last()], module_href="/contracts", better="down")

# ============================================================================ CLOSINGS

CLOSING = "closing.models:Closing"
CLOSING_DIMS = {"user": attr("coordinator_id"), "property": attr("property_id"), **via_opp()}
CLOSING_COLS = [P_COL(), C("status", "Status", "status"), C("purchase_price", "Price", "currency"),
                C("scheduled_closing_on", "Scheduled", "date"), C("closed_on", "Closed", "date"),
                U_COL("coordinator_id", "Coordinator")]


def _closing(key, label, definition, where, date=None, **kw):
    dims = {**CLOSING_DIMS, **({"date": attr(date)} if date else {})}
    K(key=key, label=label, family="closings", module="closing", model=CLOSING, definition=definition, where=where,
      title=lambda M, c: prop_label(M.property_id), href=lambda M, c: link("/closings/", M.id), dims=dims,
      cols=CLOSING_COLS, sort=kw.pop("sort", lambda M, c: [M.closed_on.desc().nulls_last()]),
      module_href="/closings", **kw)


_closing("closings.completed", "Closings completed", "Acquisitions closed in the period (closing status "
         "completed, by closing date).", lambda M, c: [M.status == "completed"], date="closed_on", better="up")
_closing("closings.volume", "Closed volume", "Total purchase price of closings completed in the period.",
         lambda M, c: [M.status == "completed"], date="closed_on", unit="currency", agg="sum",
         measure=cattr("purchase_price"), measure_label="Purchase price", better="up")
_closing("closings.scheduled_30", "Closings in 30 days", "Open closings scheduled from today through the next "
         "30 days.", lambda M, c: [M.status == "open",
                                    M.scheduled_closing_on.between(c.today, c.today + timedelta(days=30))],
         sort=lambda M, c: [M.scheduled_closing_on])

K(key="closings.wires_pending", label="Wires awaiting verification", family="closings", module="closing",
  model="closing.models:WireVerification",
  definition="Current wire instructions on open closings whose independent callback verification is still "
             "pending.",
  where=lambda M, c: [M.is_current.is_(True), M.result == "pending",
                      M.closing_id.in_(select(load(CLOSING).id).where(load(CLOSING).status == "open"))],
  title=lambda M, c: prop_label(parent(CLOSING, M.closing_id, "property_id")),
  href=lambda M, c: link("/closings/", M.closing_id),
  dims={"property": lambda M: parent(CLOSING, M.closing_id, "property_id"),
        "user": lambda M: parent(CLOSING, M.closing_id, "coordinator_id")},
  cols=[C("amount", "Amount", "currency"), C("received_at", "Received", "datetime"), C("result", "Result", "status")],
  sort=lambda M, c: [M.received_at], module_href="/closings", better="down")

# ============================================================================ PORTFOLIO — assets

ASSET = "assets.models:Asset"
ASSET_COLS = [P_COL(), C("status", "Status", "status"), C("acquired_on", "Acquired", "date"),
              C("basis", "Basis", "currency"), C("current_value", "Current value", "currency"),
              U_COL("manager_id", "Manager")]
ASSET_DIMS = {"user": attr("manager_id"), "property": attr("property_id")}


def _asset(key, label, definition, where, date=None, **kw):
    K(key=key, label=label, family="portfolio", module="assets", model=ASSET, definition=definition, where=where,
      title=lambda M, c: prop_label(M.property_id), href=lambda M, c: link("/assets/", M.id),
      dims={**ASSET_DIMS, **({"date": attr(date)} if date else {})}, cols=ASSET_COLS,
      sort=kw.pop("sort", lambda M, c: [M.current_value.desc().nulls_last()]), module_href="/assets", **kw)


_asset("portfolio.active_assets", "Active assets", "Owned assets with status active.",
       lambda M, c: [M.status == "active"])
_asset("portfolio.value", "Portfolio value", "Sum of current value of active assets (latest mark).",
       lambda M, c: [M.status == "active"], unit="currency", agg="sum", measure=cattr("current_value"),
       measure_label="Current value", better="up")
_asset("portfolio.basis", "Cost basis", "Sum of cost basis of active assets.",
       lambda M, c: [M.status == "active"], unit="currency", agg="sum", measure=cattr("basis"),
       measure_label="Basis")
_asset("portfolio.acquired", "Assets acquired", "Assets with an acquisition date in the period.",
       lambda M, c: [], date="acquired_on", sort=lambda M, c: [M.acquired_on.desc().nulls_last()], better="up")

K(key="portfolio.watchlist_open", label="Open watchlist items", family="portfolio", module="assets",
  model="assets.models:WatchlistEntry",
  definition="Open watchlist episodes (coverage, occupancy, tenant credit, maintenance, covenant, maturity, "
             "variance).",
  where=lambda M, c: [M.status == "open"], title=lambda M, c: func.concat(
      prop_label(parent(ASSET, M.asset_id, "property_id")), " · ", M.trigger),
  href=lambda M, c: link("/assets/", M.asset_id),
  dims={"property": lambda M: parent(ASSET, M.asset_id, "property_id"),
        "user": lambda M: parent(ASSET, M.asset_id, "manager_id")},
  facets={"trigger": cattr("trigger"), "severity": cattr("severity")},
  cols=[C("trigger", "Trigger", "status"), C("severity", "Severity", "status"), C("detail", "Detail"),
        C("first_detected_at", "Since", "datetime")],
  sort=lambda M, c: [M.first_detected_at], module_href="/assets", better="down")

# ============================================================================ PORTFOLIO — leases

LEASE = "leases.models:Lease"
LEASE_COLS = [P_COL(), C("status", "Status", "status"), C("lease_type", "Type", "status"),
              C("rentable_sf", "SF", "number"), C("base_rent_annual", "Annual rent", "currency"),
              C("expiration_on", "Expires", "date")]
LEASE_DIMS = {"user": attr("manager_id"), "property": attr("property_id")}
LEASE_FACETS = {"lease_type": cattr("lease_type"), "exp_year": year_of("expiration_on")}


def _lease(key, label, definition, where, **kw):
    K(key=key, label=label, family="portfolio", module="leases", model=LEASE, definition=definition, where=where,
      title=lambda M, c: M.tenant_name, href=lambda M, c: link("/leases/", M.id), dims=LEASE_DIMS,
      facets=LEASE_FACETS, cols=LEASE_COLS, sort=kw.pop("sort", lambda M, c: [M.expiration_on.nulls_last()]),
      module_href="/leases", **kw)


def _expiring(days: int):
    return lambda M, c: [M.status == "active", M.expiration_on.between(c.today, c.today + timedelta(days=days))]


_lease("leases.active", "Active leases", "Leases with status active.", lambda M, c: [M.status == "active"])
_lease("leases.expiring_12m", "Leases expiring in 12 months", "Active leases expiring from today through the "
       "next 12 months.", _expiring(365))
_lease("leases.rent_expiring_12m", "Rent expiring in 12 months", "Annual base rent of active leases expiring "
       "within the next 12 months.", _expiring(365), unit="currency", agg="sum",
       measure=cattr("base_rent_annual"), measure_label="Annual rent", better="down")
_lease("leases.rent_by_expiration", "Rent rolling (10 years)", "Annual base rent of active leases expiring "
       "within the next 10 years; break down by expiration year.", _expiring(3653), unit="currency", agg="sum",
       measure=cattr("base_rent_annual"), measure_label="Annual rent")
_lease("leases.holdover", "Active leases past expiration", "Leases still marked active whose expiration date "
       "has passed (holdover or data to update).", lambda M, c: [M.status == "active", M.expiration_on < c.today],
       better="down")
_lease("leases.unverified", "Unverified active leases", "Active leases whose abstracted terms have not been "
       "verified by a person.", lambda M, c: [M.status == "active", M.verified.is_(False)], better="down")

K(key="leases.option_notices_90", label="Option notice deadlines in 90 days", family="portfolio", module="leases",
  model="leases.models:LeaseOption",
  definition="Open lease options (renewal, termination, expansion, purchase, ROFR/ROFO) whose notice window "
             "closes within the next 90 days.",
  where=lambda M, c: [M.status == "open", M.notice_end_on.between(c.today, c.today + timedelta(days=90))],
  title=lambda M, c: func.concat(parent(LEASE, M.lease_id, "tenant_name"), " · ", M.option_type),
  href=lambda M, c: link("/leases/", M.lease_id),
  dims={"property": lambda M: parent(LEASE, M.lease_id, "property_id"),
        "user": lambda M: parent(LEASE, M.lease_id, "manager_id")},
  facets={"option_type": cattr("option_type")},
  cols=[C("option_type", "Option", "status"), C("notice_start_on", "Notice opens", "date"),
        C("notice_end_on", "Notice deadline", "date"), C("verified", "Verified", "bool")],
  sort=lambda M, c: [M.notice_end_on], module_href="/leases")


def _aging(M, c):
    return case((M.due_on >= c.today - timedelta(days=30), literal("d1_30")),
                (M.due_on >= c.today - timedelta(days=60), literal("d31_60")),
                (M.due_on >= c.today - timedelta(days=90), literal("d61_90")), else_=literal("d90_plus"))


K(key="receivables.delinquent", label="Delinquent balance", family="portfolio", module="receivables",
  model="receivables.models:Charge",
  definition="Unpaid balance (amount less amount paid) of open or partially paid charges past their due date.",
  where=lambda M, c: [M.status.in_(["open", "partial"]), M.due_on < c.today],
  title=lambda M, c: func.coalesce(M.tenant_name, M.charge_type),
  href=lambda M, c: link("/receivables/tenants/", M.lease_id, "/receivables"),
  dims={"property": attr("property_id"), "user": lambda M: parent(LEASE, M.lease_id, "manager_id")},
  facets={"aging": _aging, "charge_type": cattr("charge_type")}, unit="currency", agg="sum",
  measure=lambda M, c: M.amount - M.amount_paid, measure_label="Balance",
  cols=[P_COL(), C("charge_type", "Charge", "status"), C("due_on", "Due", "date"), C("amount", "Amount", "currency"),
        C("amount_paid", "Paid", "currency")],
  sort=lambda M, c: [M.due_on], module_href="/receivables", better="down")

K(key="receivables.collected", label="Rent collected", family="portfolio", module="receivables",
  model="receivables.models:Payment",
  definition="Tenant payments received in the period (excluding reversed payments).",
  where=lambda M, c: [M.status == "received"], title=lambda M, c: func.coalesce(M.tenant_name, M.reference),
  href=lambda M, c: link("/receivables/tenants/", M.lease_id, "/receivables"),
  dims={"date": attr("received_on"), "property": attr("property_id"),
        "user": lambda M: parent(LEASE, M.lease_id, "manager_id")},
  facets={"method": cattr("method")}, unit="currency", agg="sum", measure=cattr("amount"), measure_label="Amount",
  cols=[P_COL(), C("method", "Method", "status"), C("received_on", "Received", "date")],
  sort=lambda M, c: [M.received_on.desc()], module_href="/receivables", better="up")

# ============================================================================ PORTFOLIO — debt

LOAN = "debt.models:Loan"
LOAN_COLS = [P_COL(), C("lender_name", "Lender"), C("loan_type", "Type", "status"), C("rate_type", "Rate type", "status"),
             C("rate", "Rate %", "number"), C("current_balance", "Balance", "currency"),
             C("maturity_on", "Maturity", "date"), C("covenant_state", "Covenants", "status")]
LOAN_FACETS = {"rate_type": cattr("rate_type"), "loan_type": cattr("loan_type"), "lender": cattr("lender_name"),
               "maturity_year": year_of("maturity_on"), "covenant_state": cattr("covenant_state")}


def _loan(key, label, definition, where, **kw):
    K(key=key, label=label, family="portfolio", module="debt", model=LOAN, definition=definition, where=where,
      title=lambda M, c: func.coalesce(M.name, M.loan_number, M.lender_name), href=lambda M, c: link("/loans/", M.id),
      dims={"user": attr("owner_id"), "property": attr("property_id")}, facets=LOAN_FACETS, cols=LOAN_COLS,
      sort=kw.pop("sort", lambda M, c: [M.maturity_on.nulls_last()]), module_href="/loans", **kw)


def _maturing(days: int):
    return lambda M, c: [M.status == "active", M.maturity_on.between(c.today, c.today + timedelta(days=days))]


_loan("debt.total_balance", "Debt outstanding", "Current balance of active loans.",
      lambda M, c: [M.status == "active"], unit="currency", agg="sum", measure=cattr("current_balance"),
      measure_label="Balance")
_loan("debt.weighted_rate", "Weighted avg. rate", "Balance-weighted average all-in rate of active loans.",
      lambda M, c: [M.status == "active"], unit="percent", agg="wavg", measure=cattr("rate"),
      weight=cattr("current_balance"), measure_label="Rate %", weight_label="Balance", better="down")
_loan("debt.floating_balance", "Floating-rate balance", "Current balance of active floating-rate loans.",
      lambda M, c: [M.status == "active", M.rate_type == "floating"], unit="currency", agg="sum",
      measure=cattr("current_balance"), measure_label="Balance")
_loan("debt.maturing_12m", "Loans maturing in 12 months", "Active loans maturing from today through the next "
      "12 months.", _maturing(365), better="down")
_loan("debt.maturing_12m_balance", "Debt maturing in 12 months", "Balance of active loans maturing within the "
      "next 12 months.", _maturing(365), unit="currency", agg="sum", measure=cattr("current_balance"),
      measure_label="Balance", better="down")
_loan("debt.balance_by_maturity", "Debt by maturity year", "Balance of active loans with a maturity date; break "
      "down by maturity year.", lambda M, c: [M.status == "active", M.maturity_on.is_not(None)], unit="currency",
      agg="sum", measure=cattr("current_balance"), measure_label="Balance")
_loan("debt.covenant_breach", "Loans in covenant breach", "Active loans whose worst covenant state is breach or "
      "projected breach.", lambda M, c: [M.status == "active", M.covenant_state.in_(["breach", "projected_breach"])],
      better="down")
_loan("debt.covenant_watch", "Loans on covenant watch", "Active loans whose worst covenant state is watch.",
      lambda M, c: [M.status == "active", M.covenant_state == "watch"], better="down")
_loan("debt.caps_expiring_180", "Rate caps expiring in 180 days", "Active floating-rate loans whose rate cap "
      "expires within the next 180 days.",
      lambda M, c: [M.status == "active", M.rate_type == "floating",
                    M.cap_expires_on.between(c.today, c.today + timedelta(days=180))],
      sort=lambda M, c: [M.cap_expires_on], better="down")
_loan("debt.floating_uncapped", "Uncapped floating loans", "Active floating-rate loans with no rate cap or an "
      "expired cap.", lambda M, c: [M.status == "active", M.rate_type == "floating",
                                     or_(M.cap_expires_on.is_(None), M.cap_expires_on < c.today)], better="down")

K(key="debt.reports_overdue", label="Lender reports overdue", family="portfolio", module="debt",
  model="debt.models:LenderReportingObligation",
  definition="Active lender reporting obligations whose next due date has passed.",
  where=lambda M, c: [M.is_active.is_(True), M.next_due_on < c.today],
  title=lambda M, c: func.concat(func.coalesce(M.label, M.report_type), " · ",
                                 parent(LOAN, M.loan_id, "lender_name")),
  href=lambda M, c: link("/loans/", M.loan_id),
  dims={"user": attr("owner_id"), "property": lambda M: parent(LOAN, M.loan_id, "property_id")},
  facets={"report_type": cattr("report_type")},
  cols=[C("report_type", "Report", "status"), C("frequency", "Frequency", "status"), C("next_due_on", "Due", "date"),
        U_COL("owner_id", "Owner")],
  sort=lambda M, c: [M.next_due_on], module_href="/loans", better="down")

# ============================================================================ OPERATIONS

WO = "maintenance.models:WorkOrder"
WO_OPEN = ["open", "assigned", "in_progress"]
WO_COLS = [P_COL(), C("category", "Category", "status"), C("priority", "Priority", "status"),
           C("status", "Status", "status"), U_COL("assigned_user_id", "Assignee"), C("due_on", "Due", "date")]


def _wo(key, label, definition, where, date=None, **kw):
    K(key=key, label=label, family="operations", module="maintenance", model=WO, definition=definition, where=where,
      title=lambda M, c: func.concat("#", cast(M.number, String), " ", M.title),
      href=lambda M, c: link("/work-orders/", M.id),
      dims={"user": attr("assigned_user_id"), "property": attr("property_id"), **({"date": attr(date)} if date else {})},
      facets={"priority": cattr("priority"), "category": cattr("category"), "status": cattr("status")},
      cols=kw.pop("cols", WO_COLS), sort=kw.pop("sort", lambda M, c: [M.due_on.nulls_last()]),
      module_href="/work-orders", **kw)


_wo("operations.wo_open", "Open work orders", "Work orders open, assigned or in progress.",
    lambda M, c: [M.status.in_(WO_OPEN)])
_wo("operations.wo_overdue", "Overdue work orders", "Open work orders whose due date has passed.",
    lambda M, c: [M.status.in_(WO_OPEN), M.due_on < c.today], better="down")
_wo("operations.wo_completed", "Work orders completed", "Work orders completed or verified, by completion date.",
    lambda M, c: [M.status.in_(["completed", "verified"])], date="completed_at",
    cols=WO_COLS[:5] + [C("completed_at", "Completed", "datetime"), C("actual_cost", "Cost", "currency")],
    sort=lambda M, c: [M.completed_at.desc()], better="up")
_wo("operations.wo_avg_days", "Avg. days to complete", "Average days from report (or creation) to completion "
    "for work orders completed in the period.", lambda M, c: [M.status.in_(["completed", "verified"]),
                                                              M.completed_at.is_not(None)],
    date="completed_at", unit="days", agg="avg",
    measure=lambda M, c: func.extract("epoch", M.completed_at - func.coalesce(M.reported_at, M.created_at)) / 86400.0,
    measure_label="Days to complete", sort=lambda M, c: [M.completed_at.desc()], better="down")

K(key="operations.pm_due_14", label="Preventive maintenance due in 14 days", family="operations",
  module="maintenance", model="maintenance.models:PMSchedule",
  definition="Active preventive-maintenance schedules whose next service date is within 14 days or past.",
  where=lambda M, c: [M.is_active.is_(True), M.next_service_on <= c.today + timedelta(days=14)],
  title=lambda M, c: M.title, href=lambda M, c: literal("/work-orders"),
  dims={"user": attr("default_assignee_id"), "property": attr("property_id")},
  facets={"frequency": cattr("frequency")},
  cols=[P_COL(), C("system", "System"), C("frequency", "Frequency", "status"), C("next_service_on", "Next service", "date")],
  sort=lambda M, c: [M.next_service_on], module_href="/work-orders")

K(key="operations.findings_open", label="Open high-severity findings", family="operations", module="maintenance",
  model="maintenance.models:InspectionFinding",
  definition="Inspection findings of high or critical severity still open.",
  where=lambda M, c: [M.status == "open", M.severity.in_(["high", "critical"])],
  title=lambda M, c: M.title,
  href=lambda M, c: link("/work-orders/", M.work_order_id, "/inspections"),
  dims={"property": attr("property_id"),
        "user": lambda M: parent("maintenance.models:Inspection", M.inspection_id, "inspector_id")},
  facets={"severity": cattr("severity"), "category": cattr("category")},
  cols=[P_COL(), C("category", "Category", "status"), C("severity", "Severity", "status"),
        C("created_at", "Found", "datetime")], module_href="/inspections", better="down")

VENDOR = "operations.models:Vendor"
K(key="operations.vendor_credentials", label="Vendor credentials expired or expiring", family="operations",
  module="operations", model="operations.models:VendorCredential",
  definition="Required vendor credentials (license, COI, W-9) that are expired or expire within 30 days.",
  where=lambda M, c: [M.is_required.is_(True), M.status != "rejected",
                      or_(M.status == "expired", M.expires_on <= c.today + timedelta(days=30))],
  title=lambda M, c: func.concat(parent(VENDOR, M.vendor_id, "name"), " · ", M.name),
  href=lambda M, c: link("/vendors/", M.vendor_id), facets={"kind": cattr("kind")},
  cols=[C("kind", "Credential", "status"), C("status", "Status", "status"), C("expires_on", "Expires", "date")],
  sort=lambda M, c: [M.expires_on.nulls_first()], module_href="/vendors", better="down")

K(key="operations.insurance_expiring_60", label="Insurance policies expiring in 60 days", family="operations",
  module="operations", model="operations.models:InsurancePolicy",
  definition="Active or pending-renewal insurance policies expiring within the next 60 days (or already past).",
  where=lambda M, c: [M.status.in_(["active", "pending_renewal"]), M.expires_on <= c.today + timedelta(days=60)],
  title=lambda M, c: func.concat(M.carrier, " · ", M.coverage_type), href=lambda M, c: literal("/insurance"),
  dims={"property": attr("property_id")}, facets={"coverage_type": cattr("coverage_type")},
  cols=[P_COL(), C("coverage_type", "Coverage", "status"), C("premium", "Premium", "currency"),
        C("expires_on", "Expires", "date")],
  sort=lambda M, c: [M.expires_on], module_href="/insurance", better="down")

K(key="operations.coi_deficient", label="Deficient or expired certificates", family="operations",
  module="operations", model="operations.models:InsuranceCertificate",
  definition="Tenant and vendor certificates of insurance marked deficient or expired.",
  where=lambda M, c: [M.status.in_(["deficient", "expired"])],
  title=lambda M, c: func.coalesce(M.tenant_name, parent(VENDOR, M.vendor_id, "name"), M.carrier),
  href=lambda M, c: link("/vendors/", M.vendor_id, "/insurance"),
  dims={"property": attr("property_id")}, facets={"holder_kind": cattr("holder_kind")},
  cols=[P_COL(), C("holder_kind", "Holder", "status"), C("status", "Status", "status"), C("expires_on", "Expires", "date")],
  module_href="/insurance", better="down")

PROJECT = "operations.models:CapitalProject"
PROJECT_ACTIVE = ["approved", "bidding", "awarded", "in_progress"]
PROJECT_COLS = [P_COL(), C("status", "Status", "status"), C("original_budget", "Original budget", "currency"),
                C("current_budget", "Current budget", "currency"), C("target_completion_on", "Target", "date"),
                U_COL("manager_id", "Manager")]
for _key, _label, _def, _where, _extra in [
    ("operations.capex_active", "Active capital projects", "Capital projects approved, bidding, awarded or in "
     "progress.", lambda M, c: [M.status.in_(PROJECT_ACTIVE)], {}),
    ("operations.capex_budget", "Active capex budget", "Current budget of active capital projects.",
     lambda M, c: [M.status.in_(PROJECT_ACTIVE)],
     {"unit": "currency", "agg": "sum", "measure": cattr("current_budget"), "measure_label": "Current budget"}),
    ("operations.capex_over_budget", "Capital projects over budget", "Active capital projects whose current "
     "budget exceeds the original approved budget.",
     lambda M, c: [M.status.in_(PROJECT_ACTIVE), M.current_budget > M.original_budget], {"better": "down"}),
]:
    K(key=_key, label=_label, family="operations", module="operations", model=PROJECT, definition=_def, where=_where,
      title=lambda M, c: M.name, href=lambda M, c: link("/capital-projects/", M.id),
      dims={"user": attr("manager_id"), "property": attr("property_id")}, facets={"category": cattr("category")},
      cols=PROJECT_COLS, sort=lambda M, c: [M.target_completion_on.nulls_last()], module_href="/capital-projects",
      **_extra)

K(key="operations.tax_due_30", label="Property tax payments due in 30 days", family="operations",
  module="operations", model="operations.models:TaxPayment",
  definition="Scheduled or late property tax installments due within the next 30 days (or past due).",
  where=lambda M, c: [M.status.in_(["scheduled", "late"]), M.due_on <= c.today + timedelta(days=30)],
  title=lambda M, c: func.concat(prop_label(M.property_id), " · ", cast(M.tax_year, String)),
  href=lambda M, c: literal("/insurance"), dims={"property": attr("property_id")},
  unit="currency", agg="sum", measure=cattr("amount_due"), measure_label="Amount due",
  cols=[C("installment", "Installment"), C("status", "Status", "status"), C("due_on", "Due", "date")],
  sort=lambda M, c: [M.due_on], module_href="/insurance")

# ============================================================================ BROKERAGE

LISTING = "brokerage.models:Listing"
LIVE_LISTINGS = ["coming_soon", "active", "under_contract"]
LISTING_COLS = [P_COL(), C("listing_type", "Type", "status"), C("status", "Status", "status"),
                C("asking_price", "Asking", "currency"), C("listed_on", "Listed", "date"),
                C("expires_on", "Expires", "date"), U_COL("agent_id", "Agent")]


def _listing(key, label, definition, where, **kw):
    K(key=key, label=label, family="brokerage", module="brokerage", model=LISTING, definition=definition,
      where=where, title=lambda M, c: func.coalesce(M.headline, prop_label(M.property_id)),
      href=lambda M, c: link("/listings/", M.id), dims={"user": attr("agent_id"), "property": attr("property_id")},
      facets={"listing_type": cattr("listing_type"), "status": cattr("status")}, cols=LISTING_COLS,
      sort=kw.pop("sort", lambda M, c: [M.expires_on.nulls_last()]), module_href="/listings", **kw)


_listing("brokerage.active_listings", "Live listings", "Listings coming soon, active or under contract.",
         lambda M, c: [M.status.in_(LIVE_LISTINGS)])
_listing("brokerage.listings_expiring_30", "Listings expiring in 30 days", "Live listings whose listing "
         "agreement expires within the next 30 days.",
         lambda M, c: [M.status.in_(LIVE_LISTINGS), M.expires_on.between(c.today, c.today + timedelta(days=30))],
         better="down")

K(key="brokerage.inquiries", label="New inquiries", family="brokerage", module="brokerage",
  model="brokerage.models:Inquiry",
  definition="Buyer/tenant inquiries received in the period.",
  title=lambda M, c: func.coalesce(M.contact_name, literal("Inquiry")),
  href=lambda M, c: link("/listings/", M.listing_id, "/brokerage"),
  dims={"date": attr("received_at"), "user": attr("assigned_to_id"), "property": attr("property_id"),
        "source": attr("source")},
  facets={"status": cattr("status")},
  cols=[P_COL(), C("source", "Source", "status"), C("status", "Status", "status"), U_COL("assigned_to_id", "Assigned"),
        C("received_at", "Received", "datetime")],
  sort=lambda M, c: [M.received_at.desc()], module_href="/brokerage", better="up")

K(key="brokerage.showings", label="Showings completed", family="brokerage", module="brokerage",
  model="brokerage.models:Showing",
  definition="Showings with status completed, by scheduled date.",
  where=lambda M, c: [M.status == "completed"], title=lambda M, c: func.coalesce(M.contact_name, prop_label(M.property_id)),
  href=lambda M, c: link("/listings/", M.listing_id, "/brokerage"),
  dims={"date": attr("scheduled_at"), "user": attr("shown_by_id"), "property": attr("property_id")},
  facets={"interest_level": cattr("interest_level")},
  cols=[P_COL(), C("interest_level", "Interest", "status"), U_COL("shown_by_id", "Shown by"),
        C("scheduled_at", "When", "datetime")],
  sort=lambda M, c: [M.scheduled_at.desc()], module_href="/brokerage", better="up")

DEAL = "brokerage.models:BrokerageDeal"


def _deal_prob(M, c):
    probs = _const("brokerage.models:STAGE_PROBABILITY", {})
    default = case(*[(M.stage == s, literal(float(p))) for s, p in probs.items()], else_=literal(0.0)) if probs \
        else literal(0.0)
    norm = case((M.probability.is_(None), null()), (M.probability <= 1, M.probability * 100),
                else_=func.least(M.probability, 100))
    return func.coalesce(norm, default)


DEAL_COLS = [P_COL(), C("side", "Side", "status"), C("stage", "Stage", "status"), C("deal_value", "Deal value", "currency"),
             C("gross_commission_estimate", "GCI est.", "currency"), C("expected_close_on", "Expected close", "date"),
             U_COL("agent_id", "Agent")]


def _deal(key, label, definition, where, date=None, **kw):
    K(key=key, label=label, family="brokerage", module="brokerage", model=DEAL, definition=definition, where=where,
      title=lambda M, c: M.title, href=lambda M, c: literal("/brokerage"),
      dims={"user": attr("agent_id"), "property": attr("property_id"), "stage": attr("stage"),
            **({"date": attr(date)} if date else {})},
      facets={"side": cattr("side")}, cols=DEAL_COLS,
      sort=kw.pop("sort", lambda M, c: [M.expected_close_on.nulls_last()]), module_href="/brokerage", **kw)


def _active_deal(M, c):
    return [M.stage.in_(_const("brokerage.models:ACTIVE_DEAL_STAGES", []))]


_deal("brokerage.active_deals", "Active brokerage deals", "Brokerage deals in an active stage (lead through "
      "closing).", _active_deal)
_deal("brokerage.pipeline_gci", "GCI pipeline", "Estimated gross commission of active brokerage deals.",
      _active_deal, unit="currency", agg="sum", measure=cattr("gross_commission_estimate"), measure_label="GCI est.")
_deal("brokerage.weighted_gci", "Weighted GCI pipeline", "Estimated gross commission of active deals weighted by "
      "win probability (deal override, else the stage default).", _active_deal, unit="currency", agg="sum",
      measure=lambda M, c: M.gross_commission_estimate * _deal_prob(M, c) / 100.0, measure_label="Weighted GCI",
      better="up")
_deal("brokerage.deals_closed", "Brokerage deals closed", "Brokerage deals closed in the period.",
      lambda M, c: [M.stage == "closed"], date="closed_on", sort=lambda M, c: [M.closed_on.desc()], better="up")

COMMISSION = "commissions.models:Commission"


def _commission_scope(M, c):
    """Agents without commissions:view_sensitive only see commissions they hold or have a split on."""
    if c.user.can("commissions", "view_sensitive"):
        return []
    S = load("commissions.models:CommissionSplit")
    mine = select(S.commission_id).where(S.agent_id == c.user.id, S.deleted_at.is_(None))
    return [or_(M.agent_id == c.user.id, M.id.in_(mine))]


COMM_DIMS = {"date": attr("earned_on"), "user": attr("agent_id"), "property": attr("property_id"),
             "source": attr("source")}
COMM_COLS = [P_COL(), C("side", "Side", "status"), C("status", "Status", "status"), U_COL("agent_id", "Agent"),
             C("earned_on", "Earned", "date")]
for _key, _label, _def, _where, _extra in [
    ("commissions.earned_count", "Commissions earned", "Commissions earned, invoiced or paid with an earned date in "
     "the period (only those visible to you).", lambda M, c: [M.status.in_(["earned", "invoiced", "paid"])], {}),
    ("commissions.earned", "Gross commission earned", "Gross commission of commissions earned in the period.",
     lambda M, c: [M.status.in_(["earned", "invoiced", "paid"])],
     {"unit": "currency", "agg": "sum", "measure": cattr("gross"), "measure_label": "Gross",
      "requires": (("commissions", "view_sensitive"),)}),
    ("commissions.receivable", "Commission receivable", "Gross less amounts paid for commissions earned or "
     "invoiced but not fully paid.", lambda M, c: [M.status.in_(["earned", "invoiced"])],
     {"unit": "currency", "agg": "sum", "measure": lambda M, c: M.gross - M.paid_total, "measure_label": "Outstanding",
      "requires": (("commissions", "view_sensitive"),), "dims": {k: v for k, v in COMM_DIMS.items() if k != "date"}}),
]:
    K(key=_key, label=_label, family="brokerage", module="commissions", model=COMMISSION, definition=_def,
      where=_where, title=lambda M, c: M.title, href=lambda M, c: literal("/commissions"),
      dims=_extra.pop("dims", COMM_DIMS), facets={"side": cattr("side"), "status": cattr("status")},
      cols=COMM_COLS, scope=_commission_scope, sort=lambda M, c: [M.earned_on.desc().nulls_last()],
      module_href="/commissions", better="up", **_extra)

# ============================================================================ DATA


def _band(M, c):
    s = M.completeness_score
    return case((s < 25, literal("0-24")), (s < 50, literal("25-49")), (s < 75, literal("50-74")),
                else_=literal("75-100"))


DATA_PROP = dict(family="data", module="properties", model=PROPERTY, title=_prop_title,
                 href=lambda M, c: link("/properties/", M.id), module_href="/data-quality",
                 facets={"band": _band, "property_type": cattr("property_type")},
                 cols=PROP_COLS + [C("completeness_score", "Completeness %", "percent")],
                 sort=lambda M, c: [M.completeness_score])

K(key="data.avg_completeness", label="Avg. data completeness", definition="Average completeness score (0–100) "
  "of property records.", dims=_prop_dims(), unit="percent", agg="avg", measure=cattr("completeness_score"),
  measure_label="Completeness %", better="up", **DATA_PROP)
K(key="data.properties_total", label="Properties tracked", definition="All live property records; break down by "
  "completeness band.", dims=_prop_dims(), **DATA_PROP)
K(key="data.low_completeness", label="Low-completeness properties", definition="Properties with a completeness "
  "score below 50.", where=lambda M, c: [M.completeness_score < 50], dims=_prop_dims(), better="down", **DATA_PROP)
K(key="data.missing_location", label="Properties without location", definition="Properties with no geocoded "
  "point (cannot appear on the map or in radius/territory rules).", where=lambda M, c: [M.location.is_(None)],
  dims=_prop_dims(), better="down", **DATA_PROP)

OBS = "app.common.provenance:FieldObservation"
OBS_COLS = [Col("property", "Property", lambda M, c: prop_label(M.entity_id)), C("field", "Field"),
            C("source", "Source"), C("confidence", "Confidence", "number"), C("ai_derived", "AI", "bool"),
            C("recorded_at", "Recorded", "datetime")]
for _key, _label, _def, _where in [
    ("data.unverified_observations", "Unverified property facts", "Current property field values (material facts) "
     "not yet verified by a person.", lambda M, c: [M.entity_type == "property", M.is_current.is_(True),
                                                    M.verification == "unverified"]),
    ("data.ai_unverified", "AI-derived facts awaiting review", "Current AI-derived property values that remain "
     "unverified.", lambda M, c: [M.entity_type == "property", M.is_current.is_(True), M.ai_derived.is_(True),
                                  M.verification == "unverified"]),
]:
    K(key=_key, label=_label, family="data", module="properties", model=OBS, definition=_def, where=_where,
      title=lambda M, c: func.concat(prop_label(M.entity_id), " · ", M.field),
      href=lambda M, c: link("/properties/", M.entity_id),
      dims={"date": attr("recorded_at"), "user": attr("recorded_by_id"), "property": attr("entity_id"),
            "source": attr("source")},
      facets={"field": cattr("field")}, cols=OBS_COLS, sort=lambda M, c: [M.recorded_at.desc()],
      module_href="/data-quality", better="down")

IMPORT_JOB = "imports.models:ImportJob"


def _job_provider(M):
    J, S = load(IMPORT_JOB), load("imports.models:DataSource")
    return (select(S.provider).select_from(J).join(S, S.id == J.data_source_id)
            .where(J.id == M.job_id).scalar_subquery())


for _key, _label, _status in [("data.import_invalid", "Invalid import rows", "invalid"),
                              ("data.import_duplicates", "Duplicate import rows", "duplicate")]:
    K(key=_key, label=_label, family="data", module="imports", model="imports.models:ImportRow",
      definition=f"Staged import rows with status {_status}, by import date.",
      where=lambda M, c, s=_status: [M.status == s],
      title=lambda M, c: func.concat(parent(IMPORT_JOB, M.job_id, "filename"), " · row ", cast(M.row_number, String)),
      href=lambda M, c: link("/imports/", M.job_id),
      dims={"date": lambda M: parent(IMPORT_JOB, M.job_id, "created_at"),
            "user": lambda M: parent(IMPORT_JOB, M.job_id, "created_by_id"), "source": _job_provider},
      cols=[Col("source", "Source", lambda M, c: _job_provider(M)), C("status", "Status", "status")],
      sort=lambda M, c: [M.job_id, M.row_number], module_href="/imports", better="down")

DATA_SOURCE = "imports.models:DataSource"
DS_COLS = [C("cadence", "Cadence", "status"), C("cost", "Cost", "currency"), C("renewal_date", "Renewal", "date"),
           C("redistribution_allowed", "Redistribution", "bool")]
K(key="data.sources_active", label="Active data sources", family="data", module="imports", model=DATA_SOURCE,
  definition="Data sources/licenses registered as active, with their cost where known.",
  where=lambda M, c: [M.is_active.is_(True)], title=lambda M, c: M.provider, href=lambda M, c: literal("/imports"),
  dims={"source": attr("provider")}, cols=DS_COLS, sort=lambda M, c: [M.provider], module_href="/imports")
K(key="data.sources_renewing", label="Data licenses renewing in 60 days", family="data", module="imports",
  model=DATA_SOURCE, definition="Active data sources whose license renews within the next 60 days.",
  where=lambda M, c: [M.is_active.is_(True), M.renewal_date.between(c.today, c.today + timedelta(days=60))],
  title=lambda M, c: M.provider, href=lambda M, c: literal("/imports"), dims={"source": attr("provider")},
  cols=DS_COLS, sort=lambda M, c: [M.renewal_date], module_href="/imports")

# ============================================================================ REACTIVATION

REACT = "reactivation.models:ReactivationItem"
REACT_COLS = [P_COL(), C("trigger_type", "Trigger", "status"), C("status", "Status", "status"),
              C("what_changed", "What changed"), U_COL("owner_id", "Owner"), C("fired_at", "Fired", "datetime")]


def _react(key, label, definition, where, date=None, **kw):
    K(key=key, label=label, family="reactivation", module="reactivation", model=REACT, definition=definition,
      where=where, title=lambda M, c: opp(M.opportunity_id, "title"),
      href=lambda M, c: link("/pipeline/", M.opportunity_id, "/reactivation"),
      dims={"user": attr("owner_id"), "property": attr("property_id"),
            "source": lambda M: opp(M.opportunity_id, "source"), **({"date": attr(date)} if date else {})},
      facets={"trigger_type": cattr("trigger_type")}, cols=REACT_COLS,
      sort=kw.pop("sort", lambda M, c: [M.fired_at.desc()]), module_href="/reactivation", **kw)


_react("reactivation.pending", "Reactivation queue", "Dead opportunities returned by a trigger and awaiting a "
       "decision (pending, or snoozed past their snooze date).",
       lambda M, c: [or_(M.status == "pending", and_(M.status == "snoozed", M.snoozed_until <= c.today))])
_react("reactivation.fired", "Reactivations triggered", "Reactivation items created in the period (trigger fired).",
       lambda M, c: [], date="fired_at")
_react("reactivation.converted", "Reactivations converted", "Reactivated opportunities that converted, by "
       "conversion date.", lambda M, c: [M.converted.is_(True)], date="converted_at", better="up")
_react("reactivation.conversion_rate", "Reactivation conversion rate", "Of reactivation items fired in the period, "
       "the share that converted.", lambda M, c: [], date="fired_at", unit="percent", agg="rate",
       measure=lambda M, c: M.converted.is_(True), hit_label="Converted", better="up")

K(key="reactivation.armed", label="Armed reactivation triggers", family="reactivation", module="reactivation",
  model="reactivation.models:ReactivationTrigger",
  definition="Watches armed on dead opportunities that have not fired or been cancelled.",
  where=lambda M, c: [M.status == "armed"], title=lambda M, c: opp(M.opportunity_id, "title"),
  href=lambda M, c: link("/pipeline/", M.opportunity_id, "/reactivation"),
  dims={"property": attr("property_id"), "user": lambda M: opp(M.opportunity_id, "owner_id")},
  facets={"trigger_type": cattr("trigger_type")},
  cols=[P_COL(), C("trigger_type", "Trigger", "status"), C("fire_on", "Fires on", "date"), C("dead_reason", "Dead reason", "status")],
  sort=lambda M, c: [M.fire_on.nulls_last()], module_href="/reactivation")

# ============================================================================ COMPLIANCE (outreach family)

OUTBOUND = "compliance.models:OutboundMessage"


def _msg_href(M, c):
    return link("/people/", M.person_id, "/compliance")


for _key, _label, _def, _where, _extra in [
    ("compliance.sends", "Outbound attempts", "Outbound calls/SMS/emails attempted, including those blocked at send "
     "time.", lambda M, c: [], {}),
    ("compliance.blocked", "Blocked sends", "Outbound attempts blocked by consent, DNC, suppression, quiet-hours or "
     "frequency rules.", lambda M, c: [M.allowed.is_(False)], {"better": "down"}),
]:
    K(key=_key, label=_label, family="outreach", module="compliance", model=OUTBOUND, definition=_def, where=_where,
      title=lambda M, c: masked(M.to_value, c), href=_msg_href,
      dims={"date": attr("sent_at"), "user": attr("actor_id")}, facets={"channel": cattr("channel")},
      cols=[C("channel", "Channel", "status"), C("allowed", "Allowed", "bool"), C("actor_name", "By"),
            Col("reasons", "Block reasons", lambda M, c: cast(M.block_reasons, String)),
            C("sent_at", "When", "datetime")],
      sort=lambda M, c: [M.sent_at.desc()], module_href="/compliance", **_extra)

for _key, _label, _event in [("compliance.opt_outs", "Opt-outs", "opt_out"),
                             ("compliance.consent_revoked", "Consent revocations", "consent_revoked")]:
    K(key=_key, label=_label, family="outreach", module="compliance", model="compliance.models:ConsentEvent",
      definition=f"Consent events of type {_event.replace('_', ' ')} recorded in the period.",
      where=lambda M, c, e=_event: [M.event_type == e], title=lambda M, c: masked(M.normalized_value, c),
      href=_msg_href, dims={"date": attr("occurred_at"), "user": attr("actor_id")},
      cols=[C("channel", "Channel", "status"), C("source", "Source"), C("actor_name", "By"),
            C("occurred_at", "When", "datetime")],
      sort=lambda M, c: [M.occurred_at.desc()], module_href="/compliance")

CREC = "compliance.models:ComplianceRecord"
CREC_COLS = [C("channel", "Channel", "status"), C("dnc_status", "DNC", "status"), C("consent_state", "Consent", "status"),
             C("scrub_expires_on", "Scrub expires", "date"), C("internal_suppression", "Suppressed", "bool")]
for _key, _label, _def, _where in [
    ("compliance.dnc_listed", "Numbers on DNC", "Phone/SMS contact values whose last scrub found them on a "
     "do-not-call list.", lambda M, c: [M.dnc_status == "listed"]),
    ("compliance.scrub_expired", "Phones without a valid DNC scrub", "Phone records never scrubbed or whose scrub "
     "has expired.", lambda M, c: [M.channel == "phone", or_(M.scrub_expires_on.is_(None), M.scrub_expires_on < c.today)]),
    ("compliance.suppressed", "Internally suppressed contacts", "Contact values on the internal suppression list.",
     lambda M, c: [M.internal_suppression.is_(True)]),
]:
    K(key=_key, label=_label, family="outreach", module="compliance", model=CREC, definition=_def, where=_where,
      title=lambda M, c: masked(M.value, c), href=lambda M, c: link("/people/", M.person_id, "/compliance"),
      facets={"channel": cattr("channel")}, cols=CREC_COLS, sort=lambda M, c: [M.updated_at.desc()],
      module_href="/compliance", better="down")
