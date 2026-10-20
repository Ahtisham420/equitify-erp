"""Claude-powered assistive features (Release 6): natural-language property search (spec 33) and
conversation intelligence — interaction summaries, commitments, suggested next actions and pre-call
talking points (spec 28).

Rules: AI output is never authoritative. NL search returns structured records plus the interpreted
filters; conversation output is stored as pending `ai_suggestions` that a named user must accept.
Every provider call is written to `ai_calls` via documents.ai.logged_call. Without a configured
provider everything degrades to the existing manual behaviour.
"""
import json
import uuid
from datetime import timedelta
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.query import ListParams, apply_sort, paginate
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.documents import ai
from app.modules.platform.models import AISuggestion
from app.modules.platform.schemas import AcceptIn, NLFilters

NULL = {"type": "null"}


def _nullable(schema: dict) -> dict:
    return {"anyOf": [schema, NULL]}


def _obj(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def _structured_provider():
    """The active provider if it supports schema-constrained JSON calls, else None (degraded mode)."""
    p = ai.get_provider()
    return p if p.available and callable(getattr(p, "structured", None)) else None


# --- Natural-language property query -------------------------------------------------------------


def _nl_schema() -> dict:
    from app.modules.properties.models import PROPERTY_STATUSES, PROPERTY_TYPES
    from app.modules.properties.router import SORTS

    num, integer, string = {"type": "number"}, {"type": "integer"}, {"type": "string"}
    sorts = sorted(SORTS) + [f"-{s}" for s in sorted(SORTS)]
    filters = _obj({
        "q": _nullable(string),
        "status": _nullable({"type": "array", "items": {"type": "string", "enum": PROPERTY_STATUSES}}),
        "property_type": _nullable({"type": "array", "items": {"type": "string", "enum": PROPERTY_TYPES}}),
        "state": _nullable({"type": "array", "items": string}),
        "county": _nullable(string),
        "city": _nullable(string),
        "tag": _nullable({"type": "array", "items": string}),
        "min_area": _nullable(num), "max_area": _nullable(num),
        "min_acres": _nullable(num), "max_acres": _nullable(num),
        "min_price": _nullable(num), "max_price": _nullable(num),
        "min_year": _nullable(integer), "max_year": _nullable(integer),
        "min_completeness": _nullable(num),
        "near_lat": _nullable(num), "near_lng": _nullable(num), "radius_miles": _nullable(num),
        "sort": _nullable({"type": "string", "enum": sorts}),
    })
    return _obj({"filters": filters, "unmapped": {"type": "array", "items": string}})


NL_GUIDE = """Translate the user's question into a structured property search. Use ONLY these filters:
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
filters cannot express (owner names, signals, debt, lease terms, etc.) in `unmapped`, verbatim and short."""


def _clean_filters(raw: dict) -> tuple[NLFilters, list[str]]:
    from app.modules.properties.models import PROPERTY_STATUSES, PROPERTY_TYPES
    from app.modules.properties.router import SORTS

    data = {k: v for k, v in (raw or {}).items() if v not in (None, "", [])}
    dropped: list[str] = []
    for key, allowed in (("status", PROPERTY_STATUSES), ("property_type", PROPERTY_TYPES)):
        if key in data:
            kept = [v for v in data[key] if v in allowed]
            dropped += [f"{key}={v}" for v in data[key] if v not in allowed]
            data[key] = kept or None
    if "state" in data:
        data["state"] = [str(s).upper()[:2] for s in data["state"]]
    if data.get("sort") and data["sort"].lstrip("-") not in SORTS:
        dropped.append(f"sort={data.pop('sort')}")
    for _ in range(len(data) + 1):
        try:
            return NLFilters.model_validate({k: v for k, v in data.items() if v is not None}), dropped
        except ValidationError as exc:
            bad = {str(e["loc"][0]) for e in exc.errors() if e.get("loc")}
            if not bad:
                break
            dropped += [f"{b}={data.get(b)}" for b in bad]
            for b in bad:
                data.pop(b, None)
    return NLFilters(), dropped


async def nl_query(db: AsyncSession, question: str, page: int, page_size: int, user: CurrentUser) -> dict:
    from app.modules.properties.models import Property
    from app.modules.properties.router import SORTS
    from app.modules.properties.schemas import PropertyListItem
    from app.modules.properties.service import PropertyFilters, build_query

    provider = _structured_provider()
    message, unmapped, ai_used = None, [], False
    filters = NLFilters()
    if provider is None:
        filters = NLFilters(q=question)
        message = "AI search is not configured on this workspace; ran a keyword search instead."
    else:
        prompt = f"{NL_GUIDE}\n\nQuestion: {question}"
        await db.commit()  # no DB transaction held open across the provider call
        try:
            result = await ai.logged_call(
                db, provider, purpose="nl_query", prompt_parts=("nl_query", question),
                call=lambda: provider.structured(prompt=prompt, schema=_nl_schema(), effort="low"),
                actor_id=user.id, summarize_output=lambda r: {"filters": r.get("filters"), "unmapped": r.get("unmapped")},
            )
            filters, dropped = _clean_filters(result.get("filters") or {})
            unmapped = [str(u)[:200] for u in (result.get("unmapped") or [])][:10] + dropped
            ai_used = True
        except Exception as exc:  # noqa: BLE001 — AI never blocks the user path
            filters = NLFilters(q=question)
            message = f"AI search is unavailable right now ({type(exc).__name__}); ran a keyword search instead."
        await db.commit()

    values = filters.model_dump(exclude_none=True)
    sort = values.pop("sort", None)
    stmt = apply_sort(build_query(PropertyFilters(**values)), sort, SORTS, Property.updated_at.desc())
    params = ListParams(q=None, page=page, page_size=page_size, sort=None)
    rows, total = await paginate(db, stmt, params)
    return {
        "question": question, "ai_used": ai_used, "provider": ai.get_provider().name, "message": message,
        "filters": to_jsonable({**values, **({"sort": sort} if sort else {})}), "unmapped": unmapped,
        "items": [PropertyListItem.model_validate(r) for r in rows], "total": total,
        "page": page, "page_size": page_size,
    }


# --- Conversation intelligence -------------------------------------------------------------------


async def _interaction(db: AsyncSession, interaction_id: uuid.UUID):
    from app.modules.outreach.models import Interaction

    it = await db.get(Interaction, interaction_id)
    if not it or it.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Interaction not found")
    return it


async def list_suggestions(db: AsyncSession, source_type: str, source_id: uuid.UUID,
                           include_closed: bool = True) -> list[AISuggestion]:
    stmt = select(AISuggestion).where(AISuggestion.source_type == source_type, AISuggestion.source_id == source_id,
                                      AISuggestion.deleted_at.is_(None), AISuggestion.status != "superseded")
    if not include_closed:
        stmt = stmt.where(AISuggestion.status == "pending")
    return list(await db.scalars(stmt.order_by(AISuggestion.created_at.desc(), AISuggestion.kind)))


SUMMARY_SCHEMA = _obj({
    "summary": {"type": "string"},
    "commitments": {"type": "array", "items": _obj({
        "text": {"type": "string"},
        "party": {"type": "string", "enum": ["us", "them", "both", "unclear"]},
        "due_hint": _nullable({"type": "string"}),
    })},
    "next_actions": {"type": "array", "items": _obj({
        "title": {"type": "string"},
        "due_in_days": _nullable({"type": "integer"}),
        "rationale": {"type": "string"},
    })},
})


async def summarize_interaction(db: AsyncSession, interaction_id: uuid.UUID, user: CurrentUser) -> dict:
    from app.modules.contacts.models import Person
    from app.modules.properties.models import Property

    it = await _interaction(db, interaction_id)
    provider = _structured_provider()
    existing = await list_suggestions(db, "interaction", it.id)
    if provider is None:
        return {"ai_used": False, "provider": ai.get_provider().name, "suggestions": existing,
                "message": "AI summaries are not configured on this workspace. Log commitments and next actions manually."}
    notes = "\n".join(x for x in [it.subject, it.summary] if x)
    if not notes.strip():
        return {"ai_used": False, "provider": provider.name, "suggestions": existing,
                "message": "This interaction has no notes to summarize."}

    person = await db.get(Person, it.person_id) if it.person_id else None
    prop = await db.get(Property, it.property_id) if it.property_id else None
    context = {
        "channel": it.channel, "direction": it.direction, "occurred_at": it.occurred_at.isoformat(),
        "disposition": it.disposition, "contact": person.full_name if person else None,
        "property": (prop.name or prop.address_line) if prop else None,
        "logged_next_action": it.next_action,
    }
    prompt = (
        "Summarize this logged CRE outreach interaction for the deal team. Then list the explicit commitments "
        "made (who committed: us = our team, them = the contact) and suggest concrete next actions with a due "
        "date offset in days when the notes imply one. Use only what the notes say; if there are no commitments "
        "or actions, return empty lists. Suggestions will be reviewed by a person before anything happens.\n\n"
        f"Context: {json.dumps(context)}\n\n<notes>\n{notes[:50_000]}\n</notes>"
    )
    await db.commit()  # no DB transaction held open across the provider call
    try:
        result = await ai.logged_call(
            db, provider, purpose="interaction_summary", prompt_parts=("interaction_summary", str(it.id), notes),
            call=lambda: provider.structured(prompt=prompt, schema=SUMMARY_SCHEMA, effort="medium"),
            actor_id=user.id,
            summarize_output=lambda r: {"commitments": len(r.get("commitments") or []),
                                        "next_actions": len(r.get("next_actions") or [])},
        )
    except Exception as exc:  # noqa: BLE001
        await db.commit()
        return {"ai_used": False, "provider": provider.name, "suggestions": existing,
                "message": f"The AI provider could not summarize this interaction ({type(exc).__name__})."}

    for s in existing:
        if s.status == "pending":
            s.status, s.updated_by_id = "superseded", user.id
    common = {"source_type": "interaction", "source_id": it.id, "status": "pending", "provider": provider.name,
              "model": provider.model, "created_by_id": user.id, "updated_by_id": user.id}
    if (result.get("summary") or "").strip():
        db.add(AISuggestion(kind="summary", content=result["summary"].strip(), details={}, **common))
    for c in (result.get("commitments") or [])[:20]:
        if isinstance(c, dict) and (c.get("text") or "").strip():
            db.add(AISuggestion(kind="commitment", content=c["text"].strip(),
                                details={"party": c.get("party"), "due_hint": c.get("due_hint")}, **common))
    for a in (result.get("next_actions") or [])[:10]:
        if isinstance(a, dict) and (a.get("title") or "").strip():
            days = a.get("due_in_days")
            db.add(AISuggestion(kind="next_action", content=a["title"].strip()[:300],
                                details={"due_in_days": days if isinstance(days, int) and 0 <= days <= 365 else None,
                                         "rationale": a.get("rationale")}, **common))
    await audit.record(db, actor=user, action="interaction.ai_summarized", entity_type="interaction", entity_id=it.id,
                       summary=f"AI suggestions by {provider.name}/{provider.model}", ip_address=user.ip_address)
    await db.commit()
    return {"ai_used": True, "provider": provider.name, "message": None,
            "suggestions": await list_suggestions(db, "interaction", it.id)}


async def _suggestion(db: AsyncSession, suggestion_id: uuid.UUID) -> AISuggestion:
    s = await db.get(AISuggestion, suggestion_id)
    if not s or s.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Suggestion not found")
    if s.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Suggestion is already {s.status}")
    return s


async def accept_suggestion(db: AsyncSession, suggestion_id: uuid.UUID, data: AcceptIn, user: CurrentUser) -> AISuggestion:
    """Explicit human confirmation. Only an accepted next action creates anything (a task)."""
    from app.modules.contacts.models import Person
    from app.modules.tasks.service import create_task

    s = await _suggestion(db, suggestion_id)
    now = utcnow()
    if s.kind == "next_action":
        if not user.can("tasks", "create") and not user.can("outreach", "edit"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing permission to create tasks")
        it = await _interaction(db, s.source_id) if s.source_type == "interaction" else None
        rtype, rid, rlabel = None, None, None
        if it is not None:
            if it.opportunity_id:
                rtype, rid, rlabel = "opportunity", it.opportunity_id, None
            elif it.person_id:
                person = await db.get(Person, it.person_id)
                rtype, rid, rlabel = "person", it.person_id, person.full_name if person else None
            elif it.property_id:
                rtype, rid = "property", it.property_id
        days = (s.details or {}).get("due_in_days")
        due = data.due_at or ((now + timedelta(days=days)) if isinstance(days, int) else None)
        task = await create_task(
            db, title=(data.title or s.content)[:300], assignee_id=data.assignee_id or user.id, due_at=due,
            task_type="follow_up", description=f"Accepted AI-suggested next action. {(s.details or {}).get('rationale') or ''}".strip(),
            related_type=rtype, related_id=rid, related_label=rlabel, source="ai_suggestion",
            idempotency_key=f"ai-suggestion:{s.id}", actor_id=user.id,
        )
        s.task_id = task.id
    if data.title and s.kind != "next_action":
        s.details = {**(s.details or {}), "original": s.content}
        s.content = data.title
    s.status, s.decided_by_id, s.decided_at, s.updated_by_id = "accepted", user.id, now, user.id
    await audit.record(db, actor=user, action="ai_suggestion.accepted", entity_type="ai_suggestion", entity_id=s.id,
                       summary=f"{s.kind}: {s.content}"[:500],
                       changes={"task_id": {"from": None, "to": s.task_id}} if s.task_id else None,
                       ip_address=user.ip_address)
    await db.commit()
    return s


async def reject_suggestion(db: AsyncSession, suggestion_id: uuid.UUID, user: CurrentUser) -> AISuggestion:
    s = await _suggestion(db, suggestion_id)
    s.status, s.decided_by_id, s.decided_at, s.updated_by_id = "rejected", user.id, utcnow(), user.id
    await audit.record(db, actor=user, action="ai_suggestion.rejected", entity_type="ai_suggestion", entity_id=s.id,
                       summary=f"{s.kind}: {s.content}"[:500], ip_address=user.ip_address)
    await db.commit()
    return s


# --- Pre-call talking points ---------------------------------------------------------------------


def _money(v: Any) -> str:
    try:
        return f"${float(v):,.0f}"
    except (TypeError, ValueError):
        return "—"


async def _talking_context(db: AsyncSession, person, user: CurrentUser) -> dict:
    from app.modules.outreach.models import Interaction
    from app.modules.ownership.models import OwnershipInterest
    from app.modules.pipeline.models import Opportunity
    from app.modules.properties.models import Property

    relation: dict[uuid.UUID, str] = {}
    for pid in await db.scalars(select(OwnershipInterest.property_id).where(
            OwnershipInterest.owner_person_id == person.id, OwnershipInterest.deleted_at.is_(None),
            OwnershipInterest.effective_to.is_(None)).limit(20)):
        relation.setdefault(pid, "owner")
    opp_stage: dict[uuid.UUID, str] = {}
    for pid, stage in (await db.execute(select(Opportunity.property_id, Opportunity.stage).where(
            Opportunity.primary_person_id == person.id, Opportunity.deleted_at.is_(None)).limit(20))).all():
        if pid:
            relation.setdefault(pid, "opportunity contact")
            opp_stage[pid] = stage

    interactions: list[dict] = []
    if user.can("outreach", "view"):
        rows = list(await db.scalars(select(Interaction).where(
            Interaction.person_id == person.id, Interaction.deleted_at.is_(None))
            .order_by(Interaction.occurred_at.desc()).limit(8)))
        for it in rows:
            if it.property_id:
                relation.setdefault(it.property_id, "discussed")
            interactions.append({"id": str(it.id), "occurred_at": it.occurred_at.isoformat(), "channel": it.channel,
                                 "direction": it.direction, "disposition": it.disposition,
                                 "summary": (it.summary or it.subject or "")[:400], "next_action": it.next_action})

    properties: list[dict] = []
    signals: list[dict] = []
    valuations: list[dict] = []
    if user.can("properties", "view") and relation:
        props = list(await db.scalars(select(Property).where(Property.id.in_(list(relation)[:8]),
                                                             Property.deleted_at.is_(None))))
        for p in props:
            properties.append({"id": str(p.id), "label": p.name or p.address_line, "relationship": relation[p.id],
                               "property_type": p.property_type, "status": p.status, "city": p.city, "state": p.state,
                               "asking_price": p.asking_price, "opportunity_stage": opp_stage.get(p.id)})
            if user.can("signals", "view"):
                try:
                    from app.modules.signals.service import outbound_signals

                    for s in (await outbound_signals(db, p.id))[:5]:  # never sensitive signals
                        signals.append({"property_id": str(p.id), "property": p.name or p.address_line,
                                        "title": s.title or s.signal_type.replace("_", " "), "category": s.category,
                                        "observed_on": s.observed_on.isoformat(), "severity": s.severity,
                                        "source": s.source})
                except ImportError:
                    pass
            if user.can("comps", "view"):
                try:
                    from app.modules.comps.service import latest_value

                    v = await latest_value(db, p.id)
                    if v:
                        valuations.append({"property_id": str(p.id), "property": p.name or p.address_line,
                                           **to_jsonable(v)})
                except ImportError:
                    pass
    return {"properties": properties, "recent_interactions": interactions, "signals": signals,
            "valuations": valuations}


def _fallback_points(person, ctx: dict) -> list[dict]:
    points: list[dict] = []
    if ctx["recent_interactions"]:
        last = ctx["recent_interactions"][0]
        points.append({"text": f"Last touch {last['occurred_at'][:10]} by {last['channel']}"
                               f"{' (' + last['disposition'].replace('_', ' ') + ')' if last['disposition'] else ''}"
                               f"{': ' + last['summary'][:160] if last['summary'] else ''}",
                       "basis": "Most recent logged interaction"})
    if person.next_action:
        points.append({"text": f"Open next step: {person.next_action}", "basis": "Contact next action"})
    for p in ctx["properties"][:4]:
        stage = f", opportunity at {p['opportunity_stage'].replace('_', ' ')}" if p.get("opportunity_stage") else ""
        points.append({"text": f"{p['relationship'].capitalize()} — {p['label']} ({p['property_type'].replace('_', ' ')}"
                               f"{', ' + p['city'] if p.get('city') else ''}){stage}",
                       "basis": "Property and ownership records"})
    for s in ctx["signals"][:4]:
        points.append({"text": f"{s['title'].capitalize()} at {s['property']} observed {s['observed_on']}",
                       "basis": f"Signal · source: {s['source']}"})
    for v in ctx["valuations"][:2]:
        points.append({"text": f"Latest value view on {v['property']}: {_money(v.get('value_point'))}"
                               f" ({v.get('method') or 'valuation'}, as of {str(v.get('as_of'))[:10]})",
                       "basis": "Comps & valuation"})
    return points


TALKING_SCHEMA = _obj({"points": {"type": "array", "items": _obj({"text": {"type": "string"},
                                                                   "basis": {"type": "string"}})}})


async def talking_points(db: AsyncSession, person_id: uuid.UUID, user: CurrentUser) -> dict:
    from app.modules.contacts.models import Person

    person = await db.get(Person, person_id)
    if not person or person.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found")
    ctx = await _talking_context(db, person, user)
    base = {"person_id": person.id, "person_name": person.full_name, **ctx}
    provider = _structured_provider()
    fallback = _fallback_points(person, ctx)
    if provider is None:
        return {**base, "ai_used": False, "provider": ai.get_provider().name, "points": fallback,
                "message": "Generated from records (AI not configured)."}
    facts = {"contact": {"name": person.full_name, "title": person.title,
                         "relationship_strength": person.relationship_strength,
                         "next_action": person.next_action}, **ctx}
    prompt = (
        "Prepare 3-7 short pre-call talking points for a commercial real estate acquisitions call with this "
        "contact. Ground every point in the facts below and name the fact in `basis` (e.g. 'Interaction 2026-09-02', "
        "'Signal: tax delinquency', 'Valuation'). Do not speculate about personal circumstances, do not mention "
        "anything not in the facts, and keep the tone respectful.\n\n"
        f"<facts>\n{json.dumps(facts, default=str)[:60_000]}\n</facts>"
    )
    await db.commit()  # no DB transaction held open across the provider call
    try:
        result = await ai.logged_call(
            db, provider, purpose="talking_points", prompt_parts=("talking_points", str(person.id), facts),
            call=lambda: provider.structured(prompt=prompt, schema=TALKING_SCHEMA, effort="medium"),
            actor_id=user.id, summarize_output=lambda r: {"points": len(r.get("points") or [])},
        )
        points = [{"text": str(p["text"])[:500], "basis": str(p.get("basis") or "")[:200]}
                  for p in (result.get("points") or []) if isinstance(p, dict) and p.get("text")][:10]
        await db.commit()
        if points:
            return {**base, "ai_used": True, "provider": provider.name, "points": points, "message": None}
        return {**base, "ai_used": False, "provider": provider.name, "points": fallback,
                "message": "AI returned no talking points; showing record-based points."}
    except Exception as exc:  # noqa: BLE001
        await db.commit()
        return {**base, "ai_used": False, "provider": provider.name, "points": fallback,
                "message": f"AI unavailable ({type(exc).__name__}); showing record-based points."}
