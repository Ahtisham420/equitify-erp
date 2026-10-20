import csv
import io
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, or_, select

from app.common import audit, provenance
from app.common.provenance import ObservationOut
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.signals import service
from app.modules.signals.models import CATEGORIES, STATUSES, Signal, SignalSubscription, SignalType
from app.modules.signals.schemas import (
    DismissIn,
    MotivationOut,
    PropertySignalsOut,
    SettingsIn,
    SettingsOut,
    SignalCreate,
    SignalFacets,
    SignalOut,
    SignalTypeIn,
    SignalTypeOut,
    SignalTypeUpdate,
    SignalUpdate,
    SubscriptionIn,
    SubscriptionOut,
    VerifyIn,
)
from app.modules.signals.service import SignalFilters

router = APIRouter(prefix="/signals", tags=["signals"])

SORTS = {
    "observed_on": Signal.observed_on, "severity": Signal.severity, "confidence": Signal.confidence,
    "category": Signal.category, "signal_type": Signal.signal_type, "expires_on": Signal.expires_on,
    "created_at": Signal.created_at, "updated_at": Signal.updated_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    category: list[str] | None = Query(None),
    severity: list[int] | None = Query(None),
    status: list[str] | None = Query(None),
    signal_type: list[str] | None = Query(None),
    verification: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    owner_kind: str | None = None,
    owner_id: uuid.UUID | None = None,
    sensitive: bool | None = None,
    min_confidence: float | None = Query(None, ge=0, le=1),
    observed_from: date | None = None,
    observed_to: date | None = None,
) -> SignalFilters:
    return SignalFilters(**locals())


@router.get("", response_model=Page[SignalOut])
async def list_signals(
    db: DB, params: ListParams = Depends(), f: SignalFilters = Depends(filters),
    user: CurrentUser = Depends(require("signals", "view")),
):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Signal.observed_on.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[SignalOut](items=await service.to_outs(db, rows, user), total=total, page=params.page,
                           page_size=params.page_size)


@router.get("/facets", response_model=SignalFacets)
async def facets(db: DB, f: SignalFilters = Depends(filters), _: CurrentUser = Depends(require("signals", "view"))):
    q = service.build_query
    return SignalFacets(
        category=await facet_counts(db, q(f, skip={"category"}), Signal.category),
        severity=await facet_counts(db, q(f, skip={"severity"}), Signal.severity),
        status=await facet_counts(db, q(f, skip={"status"}), service.status_expr()),
        signal_type=await facet_counts(db, q(f, skip={"signal_type"}), Signal.signal_type),
    )


@router.get("/meta")
async def meta(db: DB, _: CurrentUser = Depends(require("signals", "view"))):
    await service.ensure_types(db)
    await db.commit()
    return {"categories": CATEGORIES, "statuses": STATUSES, "severities": [1, 2, 3, 4, 5]}


@router.get("/export")
async def export_csv(
    db: DB, params: ListParams = Depends(), f: SignalFilters = Depends(filters),
    user: CurrentUser = Depends(require("signals", "export")),
):
    # Sensitive circumstances never leave the system, regardless of the caller's permissions.
    f.sensitive = False
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Signal.observed_on.desc()).limit(50_000)
    rows = list((await db.execute(stmt)).scalars().all())
    outs = await service.to_outs(db, rows, user)
    cols = ["id", "property_label", "owner_kind", "owner_label", "category", "signal_type", "title", "observed_on",
            "severity", "source", "confidence", "expires_on", "effective_status", "current_weight", "verification"]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(cols)
    for o in outs:
        if o.is_sensitive:
            continue
        writer.writerow([getattr(o, c) for c in cols])
    await audit.record(db, actor=user, action="signal.exported", entity_type="signal", summary=f"{len(outs)} rows",
                       changes={"filters": {k: str(v) for k, v in vars(f).items() if v not in (None, [])}},
                       ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=signals.csv"})


# ----------------------------------------------------------------------------- configuration


@router.get("/types", response_model=list[SignalTypeOut])
async def list_types(db: DB, _: CurrentUser = Depends(require("signals", "view"))):
    return await service.list_types(db)


@router.post("/types", response_model=SignalTypeOut, status_code=201)
async def create_type(body: SignalTypeIn, db: DB, user: CurrentUser = Depends(require("signals", "approve"))):
    return await service.create_type(db, body, user)


@router.patch("/types/{type_id}", response_model=SignalTypeOut)
async def update_type(type_id: uuid.UUID, body: SignalTypeUpdate, db: DB,
                      user: CurrentUser = Depends(require("signals", "approve"))):
    t = await db.get(SignalType, type_id)
    if not t or t.deleted_at:
        raise HTTPException(404, "Signal type not found")
    return await service.update_type(db, t, body, user)


@router.get("/settings", response_model=SettingsOut)
async def get_settings(db: DB, _: CurrentUser = Depends(require("signals", "view"))):
    await service.ensure_rule(db)
    await db.commit()
    enabled, th = await service.settings(db)
    return SettingsOut(enabled=enabled, **{k: th[k] for k in service.RULE_DEFAULTS})


@router.put("/settings", response_model=SettingsOut)
async def put_settings(body: SettingsIn, db: DB, user: CurrentUser = Depends(require("signals", "approve"))):
    enabled, th = await service.save_settings(db, body.model_dump(), user)
    return SettingsOut(enabled=enabled, **{k: th[k] for k in service.RULE_DEFAULTS})


# ----------------------------------------------------------------------------- subscriptions


@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(db: DB, user: CurrentUser = Depends(require("signals", "view"))):
    return list(await db.scalars(select(SignalSubscription).where(
        SignalSubscription.subscriber_id == user.id, SignalSubscription.deleted_at.is_(None))
        .order_by(SignalSubscription.created_at.desc())))


@router.post("/subscriptions", response_model=SubscriptionOut, status_code=201)
async def create_subscription(body: SubscriptionIn, db: DB, user: CurrentUser = Depends(require("signals", "view"))):
    return await service.create_subscription(db, body, user)


@router.put("/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def update_subscription(sub_id: uuid.UUID, body: SubscriptionIn, db: DB,
                              user: CurrentUser = Depends(require("signals", "view"))):
    return await service.update_subscription(db, await service.get_subscription(db, sub_id, user), body, user)


@router.delete("/subscriptions/{sub_id}", status_code=204)
async def delete_subscription(sub_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("signals", "view"))):
    await service.delete_subscription(db, await service.get_subscription(db, sub_id, user), user)


# ----------------------------------------------------------------------------- record views


@router.get("/property/{property_id}", response_model=PropertySignalsOut)
async def property_signals(property_id: uuid.UUID, db: DB, include_inactive: bool = False,
                           user: CurrentUser = Depends(require("signals", "view"))):
    rows = await service.property_signal_rows(db, property_id, live_only=not include_inactive)
    return PropertySignalsOut(motivation=MotivationOut(**await service.motivation_breakdown(db, property_id)),
                              signals=await service.to_outs(db, rows, user))


@router.get("/motivation/{property_id}", response_model=MotivationOut)
async def motivation(property_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("signals", "view"))):
    return MotivationOut(**await service.motivation_breakdown(db, property_id))


@router.get("/owner/{owner_kind}/{owner_id}", response_model=list[SignalOut])
async def owner_signals(owner_kind: str, owner_id: uuid.UUID, db: DB,
                        user: CurrentUser = Depends(require("signals", "view"))):
    if owner_kind not in ("person", "organization"):
        raise HTTPException(422, "Owner kind must be person or organization")
    pids = await service.owned_properties(db, owner_kind, owner_id)
    conds = [and_(Signal.owner_kind == owner_kind, Signal.owner_id == owner_id)]
    if pids:
        conds.append(Signal.property_id.in_(pids))
    rows = list(await db.scalars(select(Signal).where(Signal.deleted_at.is_(None), or_(*conds))
                                 .order_by(Signal.observed_on.desc()).limit(500)))
    return await service.to_outs(db, rows, user)


# ----------------------------------------------------------------------------- signals


@router.post("", response_model=SignalOut, status_code=201)
async def create_signal(body: SignalCreate, db: DB, user: CurrentUser = Depends(require("signals", "create"))):
    s = await service.create(db, body, user)
    return (await service.to_outs(db, [s], user))[0]


@router.get("/{signal_id}", response_model=SignalOut)
async def get_signal(signal_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("signals", "view"))):
    return (await service.to_outs(db, [await service.get(db, signal_id)], user))[0]


@router.patch("/{signal_id}", response_model=SignalOut)
async def update_signal(signal_id: uuid.UUID, body: SignalUpdate, db: DB,
                        user: CurrentUser = Depends(require("signals", "edit"))):
    s = await service.get(db, signal_id)
    if s.is_sensitive and not user.can("signals", "view_sensitive"):
        raise HTTPException(403, "Editing a sensitive signal requires signals:view_sensitive")
    s = await service.update_signal(db, s, body, user)
    return (await service.to_outs(db, [s], user))[0]


@router.post("/{signal_id}/dismiss", response_model=SignalOut)
async def dismiss_signal(signal_id: uuid.UUID, body: DismissIn, db: DB,
                         user: CurrentUser = Depends(require("signals", "edit"))):
    s = await service.dismiss(db, await service.get(db, signal_id), body.reason, user)
    return (await service.to_outs(db, [s], user))[0]


@router.post("/{signal_id}/restore", response_model=SignalOut)
async def restore_signal(signal_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("signals", "edit"))):
    s = await service.restore(db, await service.get(db, signal_id), user)
    return (await service.to_outs(db, [s], user))[0]


@router.post("/{signal_id}/verify", response_model=SignalOut)
async def verify_signal(signal_id: uuid.UUID, body: VerifyIn, db: DB,
                        user: CurrentUser = Depends(require("signals", "edit"))):
    s = await service.verify(db, await service.get(db, signal_id), body.state, user)
    return (await service.to_outs(db, [s], user))[0]


@router.get("/{signal_id}/history", response_model=list[ObservationOut])
async def signal_history(signal_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("signals", "view"))):
    await service.get(db, signal_id)
    return await provenance.history(db, service.ENTITY, signal_id)


@router.delete("/{signal_id}", status_code=204)
async def archive_signal(signal_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("signals", "delete"))):
    await service.archive(db, await service.get(db, signal_id), user)
