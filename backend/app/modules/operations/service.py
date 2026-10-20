"""Vendors, capital projects, insurance, property tax and operating budgets (spec module 22).

Public contract for other modules:
    vendor_is_compliant(db, vendor_id) -> tuple[bool, list[str]]
"""
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import Select, delete, extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter, range_filter
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.operations.models import (
    Budget,
    BudgetLine,
    CapitalProject,
    ChangeOrder,
    InsuranceCertificate,
    InsuranceClaim,
    InsurancePolicy,
    ProjectApproval,
    ProjectBid,
    ProjectBudgetEntry,
    ProjectDraw,
    TaxAssessment,
    TaxPayment,
    TaxProtest,
    Vendor,
    VendorCredential,
    VendorReview,
)
from app.modules.operations.schemas import (
    ApprovalOut,
    AssessmentIn,
    AssessmentOut,
    BidIn,
    BidOut,
    BudgetEntryOut,
    BudgetIn,
    BudgetListItem,
    BudgetOut,
    CertificateIn,
    CertificateOut,
    ChangeOrderIn,
    ChangeOrderOut,
    ClaimIn,
    ClaimOut,
    CredentialIn,
    CredentialOut,
    DrawIn,
    DrawOut,
    DrawUpdate,
    GridRow,
    HearingResultIn,
    LinesIn,
    PaymentConfirmIn,
    PaymentIn,
    PaymentOut,
    PolicyIn,
    PolicyOut,
    ProjectIn,
    ProjectListItem,
    ProjectOut,
    ProjectStatusIn,
    ProjectUpdate,
    ProtestIn,
    ProtestOut,
    ProtestUpdate,
    ReviewIn,
    ReviewOut,
    VendorIn,
    VendorListItem,
    VendorOut,
    VendorUpdate,
)
from app.modules.properties.models import Property
from app.modules.tasks.models import Alert
from app.modules.tasks.service import raise_alert

EXPIRING_DAYS = 30
POLICY_WARNING_DAYS = 60
CREDENTIAL_LABELS = {"license": "License", "insurance_coi": "Certificate of insurance", "w9": "W-9", "other": "Credential"}


def _404(what: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")


def _422(message: str, **extra) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"message": message, **extra} if extra else message)


def _delta(before: dict, after: dict) -> dict:
    return {k: {"from": audit.to_jsonable(before.get(k)), "to": audit.to_jsonable(v)}
            for k, v in after.items() if before.get(k) != v}


def _days(d: date | None) -> int | None:
    return (d - date.today()).days if d else None


async def _record(db: AsyncSession, actor: CurrentUser, action: str, entity_type: str, entity_id: uuid.UUID | None,
                  *, changes: dict | None = None, summary: str | None = None) -> None:
    await audit.record(db, actor=actor, action=action, entity_type=entity_type, entity_id=entity_id,
                       changes=changes, summary=summary, ip_address=actor.ip_address)


# ======================================================================= cross-module helpers (guarded)

async def link_documents(db: AsyncSession, ids: list[uuid.UUID | None] | None, entity_type: str, entity_id: uuid.UUID,
                         actor: CurrentUser) -> None:
    ids = [i for i in (ids or []) if i]
    if not ids:
        return
    try:
        from app.modules.documents import service as documents
    except ImportError:
        return
    for doc_id in ids:
        await documents.link(db, doc_id, entity_type, entity_id, actor)


async def linked_document_counts(db: AsyncSession, entity_type: str, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    try:
        from app.modules.documents.models import DocumentLink
    except ImportError:
        return {}
    rows = await db.execute(select(DocumentLink.entity_id, func.count())
                            .where(DocumentLink.entity_type == entity_type, DocumentLink.entity_id.in_(ids))
                            .group_by(DocumentLink.entity_id))
    return {r[0]: int(r[1]) for r in rows.all()}


async def critical_date(db: AsyncSession, *, related_type: str, related_id: uuid.UUID, date_type: str, label: str,
                        due_on: date | None, property_id: uuid.UUID | None, actor: CurrentUser | None,
                        lead_days: int = 14, is_blocking: bool = False, status_: str = "confirmed") -> None:
    """Operational deadlines feed the shared critical-date engine (contracts module) when installed."""
    if not due_on:
        return
    try:
        from app.modules.contracts.service import upsert_critical_date
    except ImportError:
        return
    await upsert_critical_date(
        db, related_type=related_type, related_id=related_id, date_type=date_type, label=label, due_on=due_on,
        property_id=property_id, owner_id=actor.id if actor else None, lead_days=lead_days,
        is_blocking=is_blocking, source="manual", status=status_, actor=actor,
    )


async def asset_for_property(db: AsyncSession, property_id: uuid.UUID | None) -> uuid.UUID | None:
    if not property_id:
        return None
    try:
        from app.modules.assets.models import Asset
    except ImportError:
        return None
    return await db.scalar(select(Asset.id).where(Asset.property_id == property_id).limit(1))


async def property_names(db: AsyncSession, ids: set) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(Property.id, Property.name, Property.address_line).where(Property.id.in_(ids)))
    return {r.id: r.name or r.address_line for r in rows.all()}


async def user_names(db: AsyncSession, ids: set) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))
    return {r.id: r.full_name for r in rows.all()}


async def vendor_names(db: AsyncSession, ids: set) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(Vendor.id, Vendor.name).where(Vendor.id.in_(ids)))
    return {r.id: r.name for r in rows.all()}


async def _require_property(db: AsyncSession, property_id: uuid.UUID | None) -> None:
    if property_id:
        p = await db.get(Property, property_id)
        if not p or p.deleted_at:
            raise _404("Property")


def _check_capital_limit(actor: CurrentUser, amount: float) -> None:
    if not actor.can_approve("capital", amount):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"${amount:,.2f} exceeds your capital approval limit")


# ======================================================================= vendor compliance

def credential_status(c: VendorCredential, today: date | None = None) -> str:
    today = today or date.today()
    if c.status == "rejected":
        return "rejected"
    if c.expires_on and c.expires_on < today:
        return "expired"
    if c.expires_on and c.expires_on <= today + timedelta(days=EXPIRING_DAYS):
        return "expiring"
    return "valid"


def _current(c: VendorCredential, today: date) -> bool:
    return c.status != "rejected" and (c.expires_on is None or c.expires_on >= today)


def _current_certificate(c: InsuranceCertificate, today: date) -> bool:
    return c.status == "compliant" and (c.expires_on is None or c.expires_on >= today)


def evaluate_compliance(v: Vendor, creds: list[VendorCredential], certs: list[InsuranceCertificate],
                        today: date | None = None) -> tuple[bool, list[str]]:
    """Pure rule: vendor active, every required credential kind has a current (unexpired, not rejected) record."""
    today = today or date.today()
    reasons: list[str] = []
    if v.status in ("suspended", "inactive"):
        reasons.append(f"Vendor is {v.status}")
    current_kinds = {c.kind for c in creds if _current(c, today)}
    if any(_current_certificate(c, today) for c in certs):
        current_kinds.add("insurance_coi")
    for c in creds:
        if c.is_required and c.status != "rejected" and c.expires_on and c.expires_on < today and c.kind not in current_kinds:
            reasons.append(f"{CREDENTIAL_LABELS.get(c.kind, 'Credential')} \"{c.name}\" expired on {c.expires_on.isoformat()}")
    expired_kinds = {c.kind for c in creds if c.is_required and c.expires_on and c.expires_on < today}
    if v.requires_insurance and "insurance_coi" not in current_kinds and "insurance_coi" not in expired_kinds:
        reasons.append("No current certificate of insurance on file")
    if v.requires_license and "license" not in current_kinds and "license" not in expired_kinds:
        reasons.append("No current license on file")
    return not reasons, reasons


async def _compliance_inputs(db: AsyncSession, vendor_ids: list[uuid.UUID]):
    creds: dict[uuid.UUID, list[VendorCredential]] = defaultdict(list)
    certs: dict[uuid.UUID, list[InsuranceCertificate]] = defaultdict(list)
    if vendor_ids:
        for c in await db.scalars(select(VendorCredential).where(
                VendorCredential.vendor_id.in_(vendor_ids), VendorCredential.deleted_at.is_(None))):
            creds[c.vendor_id].append(c)
        for c in await db.scalars(select(InsuranceCertificate).where(
                InsuranceCertificate.vendor_id.in_(vendor_ids), InsuranceCertificate.holder_kind == "vendor",
                InsuranceCertificate.deleted_at.is_(None))):
            certs[c.vendor_id].append(c)
    return creds, certs


async def vendor_is_compliant(db: AsyncSession, vendor_id: uuid.UUID) -> tuple[bool, list[str]]:
    """Expired required insurance/license blocks dependent workflows (work-order assignment, project award, draws)."""
    v = await db.get(Vendor, vendor_id)
    if not v or v.deleted_at:
        return False, ["Vendor not found"]
    creds, certs = await _compliance_inputs(db, [v.id])
    return evaluate_compliance(v, creds[v.id], certs[v.id])


# ======================================================================= vendors

@dataclass
class VendorFilters:
    q: str | None = None
    status: list[str] | None = None
    services: list[str] | None = None
    compliance: str | None = None  # compliant | non_compliant (applied after paging is not possible → pre-filter ids)
    tag: list[str] | None = None


def vendor_query(f: VendorFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Vendor).where(Vendor.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Vendor.name, Vendor.primary_contact_name, Vendor.email, Vendor.service_area])
    if "status" not in skip:
        stmt = in_filter(stmt, Vendor.status, f.status)
    if f.services and "services" not in skip:
        stmt = stmt.where(Vendor.services.overlap(f.services))
    if f.tag:
        stmt = stmt.where(Vendor.tags.overlap(f.tag))
    return stmt


async def non_compliant_ids(db: AsyncSession) -> list[uuid.UUID]:
    vendors = list(await db.scalars(select(Vendor).where(Vendor.deleted_at.is_(None))))
    creds, certs = await _compliance_inputs(db, [v.id for v in vendors])
    return [v.id for v in vendors if not evaluate_compliance(v, creds[v.id], certs[v.id])[0]]


async def _spend_by_vendor(db: AsyncSession, vendor_ids: list[uuid.UUID], year: int | None = None) -> dict[uuid.UUID, dict]:
    out: dict[uuid.UUID, dict] = defaultdict(lambda: {"work_orders": 0.0, "projects": 0.0})
    if not vendor_ids:
        return out
    try:
        from app.modules.maintenance.models import WorkOrder
        stmt = (select(WorkOrder.vendor_id, func.coalesce(func.sum(WorkOrder.actual_cost), 0))
                .where(WorkOrder.vendor_id.in_(vendor_ids), WorkOrder.deleted_at.is_(None),
                       WorkOrder.status.in_(["completed", "verified"]))
                .group_by(WorkOrder.vendor_id))
        if year:
            stmt = stmt.where(extract("year", WorkOrder.completed_at) == year)
        for vid, total in (await db.execute(stmt)).all():
            out[vid]["work_orders"] = float(total or 0)
    except ImportError:
        pass
    stmt = (select(CapitalProject.contractor_vendor_id, func.coalesce(func.sum(ProjectDraw.amount), 0))
            .join(ProjectDraw, ProjectDraw.project_id == CapitalProject.id)
            .where(CapitalProject.contractor_vendor_id.in_(vendor_ids), ProjectDraw.status == "paid",
                   ProjectDraw.deleted_at.is_(None))
            .group_by(CapitalProject.contractor_vendor_id))
    if year:
        stmt = stmt.where(extract("year", ProjectDraw.paid_on) == year)
    for vid, total in (await db.execute(stmt)).all():
        out[vid]["projects"] = float(total or 0)
    return out


async def vendor_items(db: AsyncSession, rows: list[Vendor]) -> list[VendorListItem]:
    ids = [v.id for v in rows]
    creds, certs = await _compliance_inputs(db, ids)
    spend = await _spend_by_vendor(db, ids, date.today().year)
    today = date.today()
    out = []
    for v in rows:
        item = VendorListItem.model_validate(v)
        item.compliant, item.compliance_reasons = evaluate_compliance(v, creds[v.id], certs[v.id], today)
        upcoming = [c.expires_on for c in [*creds[v.id], *certs[v.id]] if c.expires_on]
        item.next_expiry_on = min(upcoming) if upcoming else None
        item.spend_ytd = round(spend[v.id]["work_orders"] + spend[v.id]["projects"], 2) if v.id in spend else 0
        out.append(item)
    return out


async def get_vendor(db: AsyncSession, vendor_id: uuid.UUID) -> Vendor:
    v = await db.get(Vendor, vendor_id)
    if not v or v.deleted_at:
        raise _404("Vendor")
    return v


def credential_out(c: VendorCredential) -> CredentialOut:
    out = CredentialOut.model_validate(c)
    out.status = credential_status(c)
    out.days_to_expiry = _days(c.expires_on)
    return out


async def vendor_out(db: AsyncSession, v: Vendor) -> VendorOut:
    base = (await vendor_items(db, [v]))[0]
    out = VendorOut.model_validate(v)
    for k in ("compliant", "compliance_reasons", "next_expiry_on", "spend_ytd"):
        setattr(out, k, getattr(base, k))
    creds = list(await db.scalars(select(VendorCredential).where(
        VendorCredential.vendor_id == v.id, VendorCredential.deleted_at.is_(None)).order_by(VendorCredential.expires_on)))
    out.credentials = [credential_out(c) for c in creds]
    reviews = list(await db.scalars(select(VendorReview).where(
        VendorReview.vendor_id == v.id, VendorReview.deleted_at.is_(None)).order_by(VendorReview.created_at.desc())))
    out.reviews = [ReviewOut.model_validate(r) for r in reviews]
    certs = list(await db.scalars(select(InsuranceCertificate).where(
        InsuranceCertificate.vendor_id == v.id, InsuranceCertificate.deleted_at.is_(None))))
    out.certificates = [o.model_dump(mode="json") for o in await certificate_items(db, certs)]

    total = (await _spend_by_vendor(db, [v.id]))[v.id]
    ytd = (await _spend_by_vendor(db, [v.id], date.today().year))[v.id]
    out.spend = {"work_orders_total": total["work_orders"], "projects_total": total["projects"],
                 "total": round(total["work_orders"] + total["projects"], 2),
                 "ytd": round(ytd["work_orders"] + ytd["projects"], 2)}

    bids = list(await db.scalars(select(ProjectBid).where(
        ProjectBid.vendor_id == v.id, ProjectBid.deleted_at.is_(None)).order_by(ProjectBid.created_at.desc())))
    projects = {p.id: p for p in await db.scalars(select(CapitalProject).where(
        CapitalProject.id.in_([b.project_id for b in bids])))} if bids else {}
    out.bids = [{"id": str(b.id), "project_id": str(b.project_id),
                 "project_name": projects[b.project_id].name if b.project_id in projects else None,
                 "amount": b.amount, "status": b.status, "submitted_on": b.submitted_on.isoformat() if b.submitted_on else None,
                 "created_at": b.created_at.isoformat()} for b in bids]

    perf = {"review_rating": v.performance_rating, "review_count": len(reviews), "satisfaction_avg": None,
            "completed_work_orders": 0, "on_time_pct": None, "avg_days_to_complete": None,
            "bids_submitted": len(bids), "bids_won": sum(1 for b in bids if b.status == "awarded")}
    try:
        from app.modules.maintenance.models import WorkOrder
        wos = list(await db.scalars(select(WorkOrder).where(WorkOrder.vendor_id == v.id, WorkOrder.deleted_at.is_(None))
                                    .order_by(WorkOrder.created_at.desc()).limit(200)))
        done = [w for w in wos if w.status in ("completed", "verified") and w.completed_at]
        rated = [w.satisfaction_rating for w in done if w.satisfaction_rating]
        dated = [w for w in done if w.due_on]
        perf.update({
            "completed_work_orders": len(done),
            "satisfaction_avg": round(sum(rated) / len(rated), 2) if rated else None,
            "on_time_pct": round(100 * sum(1 for w in dated if w.completed_at.date() <= w.due_on) / len(dated), 1) if dated else None,
            "avg_days_to_complete": round(sum((w.completed_at - (w.assigned_at or w.created_at)).total_seconds()
                                              for w in done) / 86400 / len(done), 1) if done else None,
        })
        out.work_orders = [{"id": str(w.id), "number": w.number, "title": w.title, "status": w.status,
                            "actual_cost": w.actual_cost, "satisfaction_rating": w.satisfaction_rating,
                            "completed_at": w.completed_at.isoformat() if w.completed_at else None,
                            "created_at": w.created_at.isoformat()} for w in wos[:50]]
    except ImportError:
        pass
    out.performance = perf
    return out


def _vendor_values(data) -> dict:
    values = data.model_dump(exclude_unset=isinstance(data, VendorUpdate), mode="json")
    for k in ("organization_id",):
        if values.get(k):
            values[k] = uuid.UUID(values[k])
    return values


async def create_vendor(db: AsyncSession, data: VendorIn, actor: CurrentUser) -> Vendor:
    v = Vendor(**_vendor_values(data), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(v)
    await db.flush()
    await _record(db, actor, "vendor.created", "vendor", v.id, summary=v.name)
    await db.commit()
    return v


async def update_vendor(db: AsyncSession, v: Vendor, data: VendorUpdate, actor: CurrentUser) -> Vendor:
    values = _vendor_values(data)
    changes = audit.diff(v, values)
    if not changes:
        return v
    for k, val in values.items():
        setattr(v, k, val)
    v.updated_by_id = actor.id
    await _record(db, actor, "vendor.updated", "vendor", v.id, changes=changes)
    await db.commit()
    return v


async def archive_vendor(db: AsyncSession, v: Vendor, actor: CurrentUser) -> None:
    v.deleted_at = utcnow()
    v.status = "inactive"
    await _record(db, actor, "vendor.archived", "vendor", v.id, summary=v.name)
    await db.commit()


async def save_credential(db: AsyncSession, v: Vendor, data: CredentialIn, actor: CurrentUser,
                          c: VendorCredential | None = None) -> VendorCredential:
    values = data.model_dump(exclude={"verified"})
    if c is None:
        c = VendorCredential(vendor_id=v.id, **values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(c)
        changes = {k: audit.to_jsonable(val) for k, val in values.items() if val is not None}
        action = "vendor.credential_added"
    else:
        changes = audit.diff(c, values)
        for k, val in values.items():
            setattr(c, k, val)
        c.updated_by_id = actor.id
        action = "vendor.credential_updated"
        if c.status == "rejected" and "expires_on" in changes:
            c.status = "valid"
    if data.verified and not c.verified_at:
        c.verified_by_id, c.verified_at = actor.id, utcnow()
    elif not data.verified:
        c.verified_by_id, c.verified_at = None, None
    if c.status != "rejected":
        c.status = credential_status(c)
    await db.flush()
    await link_documents(db, [data.document_id], "vendor_credential", c.id, actor)
    await _record(db, actor, action, "vendor", v.id, changes=changes, summary=f"{c.kind}: {c.name}")
    await db.commit()
    return c


async def get_credential(db: AsyncSession, cred_id: uuid.UUID) -> VendorCredential:
    c = await db.get(VendorCredential, cred_id)
    if not c or c.deleted_at:
        raise _404("Credential")
    return c


async def archive_credential(db: AsyncSession, c: VendorCredential, actor: CurrentUser) -> None:
    c.deleted_at = utcnow()
    await _record(db, actor, "vendor.credential_removed", "vendor", c.vendor_id, summary=f"{c.kind}: {c.name}")
    await db.commit()


async def add_review(db: AsyncSession, v: Vendor, data: ReviewIn, actor: CurrentUser) -> VendorReview:
    r = VendorReview(vendor_id=v.id, **data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(r)
    await db.flush()
    avg = await db.scalar(select(func.avg(VendorReview.rating)).where(
        VendorReview.vendor_id == v.id, VendorReview.deleted_at.is_(None)))
    before = v.performance_rating
    v.performance_rating = round(float(avg), 2) if avg is not None else None
    await _record(db, actor, "vendor.reviewed", "vendor", v.id, summary=f"{data.rating}/5",
                  changes={"performance_rating": {"from": before, "to": v.performance_rating}})
    await db.commit()
    return r


# ======================================================================= expiration scan

async def run_scan(db: AsyncSession, actor: CurrentUser | None) -> dict:
    """Idempotent: alerts are keyed by record + date + state, so re-running never duplicates."""
    today = date.today()
    counts = defaultdict(int)
    raised = 0

    async def alert(key: str, **kw) -> None:
        nonlocal raised
        exists = await db.scalar(select(Alert.id).where(Alert.idempotency_key == key))
        await raise_alert(db, idempotency_key=key, **kw)
        if not exists:
            raised += 1

    vendors = {v.id: v for v in await db.scalars(select(Vendor).where(Vendor.deleted_at.is_(None)))}
    creds = [c for c in await db.scalars(select(VendorCredential).where(
        VendorCredential.deleted_at.is_(None), VendorCredential.expires_on.is_not(None))) if c.vendor_id in vendors]
    for c in creds:
        state = credential_status(c, today)
        if c.status != state and c.status != "rejected":
            c.status = state
        if state not in ("expiring", "expired"):
            continue
        counts[f"credentials_{state}"] += 1
        v = vendors[c.vendor_id]
        label = CREDENTIAL_LABELS.get(c.kind, "Credential")
        await alert(
            f"vendor_credential:{c.id}:{c.expires_on}:{state}",
            title=f"{v.name}: {label.lower()} {'expired' if state == 'expired' else 'expiring'}",
            reason=f"{label} \"{c.name}\" {'expired' if state == 'expired' else 'expires'} on {c.expires_on.isoformat()}."
                   + (" Assignment and award are blocked until renewed." if state == "expired" and c.is_required else ""),
            severity="high" if state == "expired" and c.is_required else "medium",
            related_type="vendor", related_id=v.id, related_label=v.name, rule_key="operations.credential_expiry",
        )

    for p in await db.scalars(select(InsurancePolicy).where(
            InsurancePolicy.deleted_at.is_(None), InsurancePolicy.status.in_(["active", "pending_renewal"]),
            InsurancePolicy.expires_on <= today + timedelta(days=POLICY_WARNING_DAYS))):
        expired = p.expires_on < today
        if expired:
            p.status = "expired"
        counts["policies_expiring"] += 1
        await alert(
            f"policy:{p.id}:{p.expires_on}:{'expired' if expired else 'expiring'}",
            title=f"{p.carrier} {p.coverage_type.replace('_', ' ')} policy {'expired' if expired else 'expiring'}",
            reason=f"Policy {p.policy_number} {'expired' if expired else 'expires'} on {p.expires_on.isoformat()}.",
            severity="high" if expired or (p.expires_on - today).days <= 14 else "medium",
            related_type="insurance_policy", related_id=p.id, related_label=p.policy_number,
            rule_key="operations.policy_expiry",
        )

    for c in await db.scalars(select(InsuranceCertificate).where(
            InsuranceCertificate.deleted_at.is_(None), InsuranceCertificate.expires_on.is_not(None),
            InsuranceCertificate.expires_on <= today + timedelta(days=EXPIRING_DAYS))):
        lapsed = c.expires_on < today
        if lapsed and c.status != "expired":
            c.status = "expired"
        if lapsed:
            counts["certificates_lapsed"] += 1
        holder = c.tenant_name or (vendors[c.vendor_id].name if c.vendor_id in vendors else "Certificate holder")
        await alert(
            f"certificate:{c.id}:{c.expires_on}:{'lapsed' if lapsed else 'expiring'}",
            title=f"{holder}: insurance certificate {'lapsed' if lapsed else 'expiring'}",
            reason=f"{c.coverage_type.replace('_', ' ').capitalize()} certificate "
                   f"{'lapsed' if lapsed else 'expires'} on {c.expires_on.isoformat()}. Request a renewal.",
            severity="high" if lapsed else "medium", related_type="insurance_certificate", related_id=c.id,
            related_label=holder, rule_key="operations.certificate_lapse",
        )

    for pr in await db.scalars(select(TaxProtest).where(
            TaxProtest.deleted_at.is_(None), TaxProtest.status == "considering", TaxProtest.deadline_on.is_not(None),
            TaxProtest.deadline_on <= today + timedelta(days=EXPIRING_DAYS))):
        counts["protest_deadlines"] += 1
        await alert(
            f"protest_deadline:{pr.id}:{pr.deadline_on}",
            title=f"Tax protest deadline {pr.deadline_on.isoformat()} ({pr.tax_year})",
            reason="The protest has not been filed. Missing the deadline forfeits the appeal for this tax year.",
            severity="high", related_type="tax_protest", related_id=pr.id, related_label=f"{pr.tax_year} protest",
            rule_key="operations.protest_deadline",
        )
    protested = select(TaxProtest.assessment_id).where(TaxProtest.deleted_at.is_(None))
    for a in await db.scalars(select(TaxAssessment).where(
            TaxAssessment.deleted_at.is_(None), TaxAssessment.protest_deadline_on.is_not(None),
            TaxAssessment.protest_deadline_on >= today,
            TaxAssessment.protest_deadline_on <= today + timedelta(days=EXPIRING_DAYS),
            TaxAssessment.id.not_in(protested))):
        counts["protest_deadlines"] += 1
        await alert(
            f"assessment_deadline:{a.id}:{a.protest_deadline_on}",
            title=f"Decide on {a.tax_year} assessment protest by {a.protest_deadline_on.isoformat()}",
            reason=f"Assessed value ${a.assessed_total:,.0f}; no protest decision is recorded.",
            severity="medium", related_type="tax_assessment", related_id=a.id, related_label=f"{a.tax_year} assessment",
            rule_key="operations.protest_deadline",
        )

    for pay in await db.scalars(select(TaxPayment).where(
            TaxPayment.deleted_at.is_(None), TaxPayment.status.in_(["scheduled", "late"]),
            TaxPayment.due_on <= today + timedelta(days=EXPIRING_DAYS))):
        late = pay.due_on < today
        if late:
            pay.status = "late"
        counts["payments_due"] += 1
        await alert(
            f"tax_payment:{pay.id}:{pay.due_on}:{'late' if late else 'due'}",
            title=f"Property tax {'past due' if late else 'due'} {pay.due_on.isoformat()}",
            reason=f"${pay.amount_due:,.2f} {pay.tax_year} {pay.installment or 'installment'} has no payment confirmation.",
            severity="high" if late else "medium", related_type="tax_payment", related_id=pay.id,
            related_label=f"{pay.tax_year} {pay.installment or ''}".strip(), rule_key="operations.tax_payment",
        )

    if actor:
        await audit.record(db, actor=actor, action="operations.scan", entity_type="operations",
                           summary=f"{raised} alerts", changes=dict(counts), ip_address=actor.ip_address)
    await db.commit()
    return {"credentials_expiring": counts["credentials_expiring"], "credentials_expired": counts["credentials_expired"],
            "policies_expiring": counts["policies_expiring"], "certificates_lapsed": counts["certificates_lapsed"],
            "protest_deadlines": counts["protest_deadlines"], "payments_due": counts["payments_due"],
            "alerts_raised": raised}


# ======================================================================= capital projects

PROJECT_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"pending_approval", "cancelled"},
    "pending_approval": {"draft", "cancelled"},
    "approved": {"bidding", "cancelled"},
    "bidding": {"cancelled"},
    "awarded": {"in_progress", "cancelled"},
    "in_progress": {"completed", "cancelled"},
    "completed": {"closed", "in_progress"},
    "closed": set(),
    "cancelled": set(),
}


@dataclass
class ProjectFilters:
    q: str | None = None
    status: list[str] | None = None
    category: list[str] | None = None
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    contractor_vendor_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    min_budget: float | None = None
    max_budget: float | None = None


def project_query(f: ProjectFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(CapitalProject).where(CapitalProject.deleted_at.is_(None))
    if f.q:
        stmt = stmt.outerjoin(Property, Property.id == CapitalProject.property_id)
        stmt = apply_search(stmt, f.q, [CapitalProject.name, CapitalProject.scope, Property.name, Property.address_line])
    if "status" not in skip:
        stmt = in_filter(stmt, CapitalProject.status, f.status)
    if "category" not in skip:
        stmt = in_filter(stmt, CapitalProject.category, f.category)
    for key in ("property_id", "asset_id", "contractor_vendor_id", "manager_id"):
        if getattr(f, key):
            stmt = stmt.where(getattr(CapitalProject, key) == getattr(f, key))
    return range_filter(stmt, CapitalProject.current_budget, f.min_budget, f.max_budget)


async def project_items(db: AsyncSession, rows: list[CapitalProject]) -> list[ProjectListItem]:
    ids = [p.id for p in rows]
    props = await property_names(db, {p.property_id for p in rows})
    users = await user_names(db, {p.manager_id for p in rows})
    vendors = await vendor_names(db, {p.contractor_vendor_id for p in rows})
    spent: dict = {}
    pending: dict = {}
    if ids:
        spent = dict((await db.execute(
            select(ProjectDraw.project_id, func.coalesce(func.sum(ProjectDraw.amount), 0))
            .where(ProjectDraw.project_id.in_(ids), ProjectDraw.status.in_(["approved", "paid"]),
                   ProjectDraw.deleted_at.is_(None)).group_by(ProjectDraw.project_id))).all())
        pending = dict((await db.execute(
            select(ChangeOrder.project_id, func.count())
            .where(ChangeOrder.project_id.in_(ids), ChangeOrder.status == "pending", ChangeOrder.deleted_at.is_(None))
            .group_by(ChangeOrder.project_id))).all())
    out = []
    for p in rows:
        item = ProjectListItem.model_validate(p)
        item.property_name = props.get(p.property_id)
        item.manager_name = users.get(p.manager_id) if p.manager_id else None
        item.contractor_name = vendors.get(p.contractor_vendor_id) if p.contractor_vendor_id else None
        item.committed = float(p.contract_amount or 0)
        item.spent = float(spent.get(p.id, 0) or 0)
        item.pending_change_orders = int(pending.get(p.id, 0) or 0)
        out.append(item)
    return out


async def get_project(db: AsyncSession, project_id: uuid.UUID) -> CapitalProject:
    p = await db.get(CapitalProject, project_id)
    if not p or p.deleted_at:
        raise _404("Capital project")
    return p


async def bid_items(db: AsyncSession, bids: list[ProjectBid]) -> list[BidOut]:
    names = await vendor_names(db, {b.vendor_id for b in bids})
    creds, certs = await _compliance_inputs(db, list({b.vendor_id for b in bids}))
    vendors = {v.id: v for v in await db.scalars(select(Vendor).where(Vendor.id.in_([b.vendor_id for b in bids])))} if bids else {}
    out = []
    for b in bids:
        o = BidOut.model_validate(b)
        o.vendor_name = names.get(b.vendor_id)
        if b.vendor_id in vendors:
            o.vendor_compliant, o.vendor_compliance_reasons = evaluate_compliance(
                vendors[b.vendor_id], creds[b.vendor_id], certs[b.vendor_id])
        out.append(o)
    return out


async def project_out(db: AsyncSession, p: CapitalProject) -> ProjectOut:
    base = (await project_items(db, [p]))[0]
    out = ProjectOut.model_validate(p)
    for k in ("property_name", "manager_name", "contractor_name", "committed", "spent", "pending_change_orders"):
        setattr(out, k, getattr(base, k))
    bids = list(await db.scalars(select(ProjectBid).where(ProjectBid.project_id == p.id, ProjectBid.deleted_at.is_(None))
                                 .order_by(ProjectBid.amount)))
    draws = list(await db.scalars(select(ProjectDraw).where(ProjectDraw.project_id == p.id, ProjectDraw.deleted_at.is_(None))
                                  .order_by(ProjectDraw.number)))
    cos = list(await db.scalars(select(ChangeOrder).where(ChangeOrder.project_id == p.id, ChangeOrder.deleted_at.is_(None))
                                .order_by(ChangeOrder.number)))
    history = list(await db.scalars(select(ProjectBudgetEntry).where(ProjectBudgetEntry.project_id == p.id)
                                    .order_by(ProjectBudgetEntry.recorded_at)))
    approvals = list(await db.scalars(select(ProjectApproval).where(ProjectApproval.project_id == p.id)
                                      .order_by(ProjectApproval.decided_at)))
    out.bids = await bid_items(db, bids)
    waivers = await linked_document_counts(db, "lien_waiver", [d.id for d in draws])
    out.draws = []
    for d in draws:
        do = DrawOut.model_validate(d)
        do.lien_waiver_on_file = bool(d.lien_waiver_document_id) or waivers.get(d.id, 0) > 0
        out.draws.append(do)
    out.change_orders = [ChangeOrderOut.model_validate(c) for c in cos]
    out.budget_history = [BudgetEntryOut.model_validate(h) for h in history]
    names = await user_names(db, {a.decided_by_id for a in approvals})
    out.approvals = []
    for a in approvals:
        ao = ApprovalOut.model_validate(a)
        ao.decided_by_name = names.get(a.decided_by_id) if a.decided_by_id else None
        out.approvals.append(ao)
    out.paid = round(sum(float(d.amount) for d in draws if d.status == "paid"), 2)
    out.approved_change_orders = round(sum(float(c.amount) for c in cos if c.status == "approved"), 2)
    out.remaining = round(float(p.current_budget or 0) - float(p.contract_amount or 0), 2)
    return out


async def _budget_entry(db: AsyncSession, p: CapitalProject, kind: str, after: float, reason: str | None,
                        actor: CurrentUser, change_order_id: uuid.UUID | None = None) -> None:
    before = float(p.current_budget or 0) if kind != "original" else 0.0
    db.add(ProjectBudgetEntry(project_id=p.id, kind=kind, amount_before=before, amount_after=after,
                              delta=round(after - before, 2), reason=reason, change_order_id=change_order_id,
                              recorded_at=utcnow(), created_by_id=actor.id, updated_by_id=actor.id))
    p.current_budget = after


def _approval(db: AsyncSession, p: CapitalProject, stage: str, decision: str, actor: CurrentUser, *,
              amount: float | None = None, reference_id: uuid.UUID | None = None, note: str | None = None) -> None:
    db.add(ProjectApproval(project_id=p.id, stage=stage, decision=decision, amount=amount, reference_id=reference_id,
                           note=note, decided_by_id=actor.id, decided_at=utcnow(), created_by_id=actor.id,
                           updated_by_id=actor.id))


async def create_project(db: AsyncSession, data: ProjectIn, actor: CurrentUser) -> CapitalProject:
    await _require_property(db, data.property_id)
    values = data.model_dump(mode="json", exclude={"property_id", "asset_id", "manager_id", "original_budget"})
    for k in ("start_on", "target_completion_on"):
        values[k] = getattr(data, k)
    p = CapitalProject(
        **values, property_id=data.property_id, manager_id=data.manager_id or actor.id,
        asset_id=data.asset_id or await asset_for_property(db, data.property_id),
        original_budget=data.original_budget, current_budget=0, status="draft",
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(p)
    await db.flush()
    await _budget_entry(db, p, "original", data.original_budget, "Original budget", actor)
    await _record(db, actor, "capital_project.created", "capital_project", p.id, summary=p.name,
                  changes={"original_budget": data.original_budget})
    await critical_date(db, related_type="capital_project", related_id=p.id, date_type="target_completion",
                        label=f"{p.name}: target completion", due_on=p.target_completion_on, property_id=p.property_id,
                        actor=actor)
    await db.commit()
    return p


async def update_project(db: AsyncSession, p: CapitalProject, data: ProjectUpdate, actor: CurrentUser) -> CapitalProject:
    if p.status in ("closed", "cancelled"):
        raise _422(f"A {p.status} project cannot be edited")
    values = data.model_dump(exclude_unset=True)
    if "milestones" in values and values["milestones"] is not None:
        values["milestones"] = [m.model_dump(mode="json") for m in data.milestones or []]
    changes = audit.diff(p, values)
    if not changes:
        return p
    for k, v in values.items():
        setattr(p, k, v)
    p.updated_by_id = actor.id
    await _record(db, actor, "capital_project.updated", "capital_project", p.id, changes=changes)
    if "target_completion_on" in changes:
        await critical_date(db, related_type="capital_project", related_id=p.id, date_type="target_completion",
                            label=f"{p.name}: target completion", due_on=p.target_completion_on,
                            property_id=p.property_id, actor=actor)
    if "warranty_expires_on" in changes:
        await critical_date(db, related_type="capital_project", related_id=p.id, date_type="warranty_expiration",
                            label=f"{p.name}: warranty expires", due_on=p.warranty_expires_on,
                            property_id=p.property_id, actor=actor, lead_days=60)
    await db.commit()
    return p


async def archive_project(db: AsyncSession, p: CapitalProject, actor: CurrentUser) -> None:
    if p.status not in ("draft", "cancelled"):
        raise _422("Only draft or cancelled projects can be archived; project history is retained")
    p.deleted_at = utcnow()
    await _record(db, actor, "capital_project.archived", "capital_project", p.id, summary=p.name)
    await db.commit()


async def set_project_status(db: AsyncSession, p: CapitalProject, data: ProjectStatusIn, actor: CurrentUser) -> CapitalProject:
    to = data.status
    if to not in PROJECT_TRANSITIONS.get(p.status, set()):
        raise _422(f"Cannot move a project from {p.status} to {to}")
    if to == "in_progress" and p.contractor_vendor_id:
        ok, reasons = await vendor_is_compliant(db, p.contractor_vendor_id)
        if not ok:
            raise _422("Contractor is not compliant; work cannot start", reasons=reasons)
    if to == "completed":
        p.actual_completion_on = data.actual_completion_on or date.today()
        if data.warranty_expires_on:
            p.warranty_expires_on = data.warranty_expires_on
        if data.warranty_terms:
            p.warranty_terms = data.warranty_terms
        await critical_date(db, related_type="capital_project", related_id=p.id, date_type="warranty_expiration",
                            label=f"{p.name}: warranty expires", due_on=p.warranty_expires_on,
                            property_id=p.property_id, actor=actor, lead_days=60)
    if to == "closed":
        open_cos = await db.scalar(select(func.count()).where(ChangeOrder.project_id == p.id, ChangeOrder.status == "pending",
                                                              ChangeOrder.deleted_at.is_(None)))
        open_draws = await db.scalar(select(func.count()).where(ProjectDraw.project_id == p.id,
                                                                ProjectDraw.status.in_(["requested", "approved"]),
                                                                ProjectDraw.deleted_at.is_(None)))
        if open_cos or open_draws:
            raise _422("Resolve pending change orders and unpaid draws before closing the project")
    if to == "cancelled" and not (data.note or "").strip():
        raise _422("A reason is required to cancel a project")
    previous = p.status
    p.status = to
    p.updated_by_id = actor.id
    if to == "completed":
        _approval(db, p, "completion", "approved", actor, amount=float(p.contract_amount or 0), note=data.note)
    await _record(db, actor, f"capital_project.{to}", "capital_project", p.id,
                  changes={"status": {"from": previous, "to": to}}, summary=data.note)
    await db.commit()
    return p


async def decide_budget(db: AsyncSession, p: CapitalProject, decision: str, note: str | None, actor: CurrentUser) -> CapitalProject:
    if p.status != "pending_approval":
        raise _422("Submit the project for approval first")
    if decision == "approved":
        _check_capital_limit(actor, float(p.current_budget or 0))
        p.status = "approved"
        p.budget_approved_by_id, p.budget_approved_at = actor.id, utcnow()
    else:
        if not (note or "").strip():
            raise _422("A note is required when rejecting")
        p.status = "draft"
    _approval(db, p, "budget", decision, actor, amount=float(p.current_budget or 0), note=note)
    await _record(db, actor, f"capital_project.budget_{decision}", "capital_project", p.id, summary=note,
                  changes={"current_budget": p.current_budget})
    await db.commit()
    return p


async def revise_budget(db: AsyncSession, p: CapitalProject, new_budget: float, reason: str, actor: CurrentUser) -> CapitalProject:
    if p.status in ("closed", "cancelled"):
        raise _422(f"A {p.status} project cannot be revised")
    if p.contract_amount and new_budget < float(p.contract_amount):
        raise _422("Budget cannot be below the committed contract amount")
    if p.status not in ("draft", "pending_approval"):
        _check_capital_limit(actor, new_budget)
    before = float(p.current_budget or 0)
    await _budget_entry(db, p, "revision", new_budget, reason, actor)
    if p.status not in ("draft", "pending_approval"):
        _approval(db, p, "budget", "approved", actor, amount=new_budget, note=f"Revision: {reason}")
    await _record(db, actor, "capital_project.budget_revised", "capital_project", p.id, summary=reason,
                  changes={"current_budget": {"from": before, "to": new_budget}})
    await db.commit()
    return p


async def add_bid(db: AsyncSession, p: CapitalProject, data: BidIn, actor: CurrentUser) -> ProjectBid:
    if p.status not in ("approved", "bidding"):
        raise _422("Bids are collected once the project budget is approved")
    await get_vendor(db, data.vendor_id)
    b = ProjectBid(project_id=p.id, **data.model_dump(), status="submitted", created_by_id=actor.id, updated_by_id=actor.id)
    db.add(b)
    if p.status == "approved":
        p.status = "bidding"
    await db.flush()
    await link_documents(db, [data.document_id], "project_bid", b.id, actor)
    await _record(db, actor, "capital_project.bid_added", "capital_project", p.id,
                  summary=f"${data.amount:,.2f}", changes={"vendor_id": data.vendor_id, "amount": data.amount})
    await db.commit()
    return b


async def get_bid(db: AsyncSession, bid_id: uuid.UUID) -> ProjectBid:
    b = await db.get(ProjectBid, bid_id)
    if not b or b.deleted_at:
        raise _404("Bid")
    return b


async def set_bid_status(db: AsyncSession, b: ProjectBid, to: str, note: str | None, actor: CurrentUser) -> ProjectBid:
    if b.status == "awarded":
        raise _422("An awarded bid cannot be changed")
    previous = b.status
    b.status, b.decision_note = to, note
    await _record(db, actor, "capital_project.bid_updated", "capital_project", b.project_id,
                  changes={"bid": str(b.id), "status": {"from": previous, "to": to}}, summary=note)
    await db.commit()
    return b


async def award_bid(db: AsyncSession, b: ProjectBid, note: str | None, actor: CurrentUser) -> CapitalProject:
    p = await get_project(db, b.project_id)
    if p.status not in ("approved", "bidding"):
        raise _422(f"Cannot award while the project is {p.status}")
    if b.status not in ("submitted", "shortlisted"):
        raise _422(f"A {b.status} bid cannot be awarded")
    ok, reasons = await vendor_is_compliant(db, b.vendor_id)
    if not ok:
        raise _422("Vendor is not compliant; award is blocked", reasons=reasons)
    if float(b.amount) > float(p.current_budget or 0):
        raise _422(f"Bid ${b.amount:,.2f} exceeds the approved budget ${p.current_budget:,.2f}; revise the budget first")
    _check_capital_limit(actor, float(b.amount))
    for other in await db.scalars(select(ProjectBid).where(
            ProjectBid.project_id == p.id, ProjectBid.id != b.id, ProjectBid.deleted_at.is_(None),
            ProjectBid.status.in_(["submitted", "shortlisted"]))):
        other.status, other.decision_note = "rejected", "Not selected"
    b.status, b.decision_note = "awarded", note
    p.status = "awarded"
    p.contractor_vendor_id, p.awarded_bid_id, p.contract_amount = b.vendor_id, b.id, b.amount
    p.updated_by_id = actor.id
    _approval(db, p, "award", "approved", actor, amount=float(b.amount), reference_id=b.id, note=note)
    await _record(db, actor, "capital_project.awarded", "capital_project", p.id, summary=note,
                  changes={"vendor_id": b.vendor_id, "contract_amount": b.amount})
    await db.commit()
    return p


async def add_change_order(db: AsyncSession, p: CapitalProject, data: ChangeOrderIn, actor: CurrentUser) -> ChangeOrder:
    if p.status not in ("awarded", "in_progress"):
        raise _422("Change orders apply to awarded or in-progress projects")
    number = int(await db.scalar(select(func.coalesce(func.max(ChangeOrder.number), 0)).where(ChangeOrder.project_id == p.id)) or 0) + 1
    co = ChangeOrder(project_id=p.id, number=number, **data.model_dump(), status="pending",
                     created_by_id=actor.id, updated_by_id=actor.id)
    db.add(co)
    await db.flush()
    await link_documents(db, [data.document_id], "change_order", co.id, actor)
    await raise_alert(db, title=f"Change order #{number} needs approval: {p.name}",
                      reason=f"{data.title} (${data.amount:,.2f}).", severity="medium",
                      related_type="capital_project", related_id=p.id, related_label=p.name,
                      rule_key="operations.change_order_approval", idempotency_key=f"change_order:{co.id}")
    await _record(db, actor, "capital_project.change_order_requested", "capital_project", p.id,
                  summary=f"CO #{number} {data.title}", changes={"amount": data.amount, "days_impact": data.days_impact})
    await db.commit()
    return co


async def get_change_order(db: AsyncSession, co_id: uuid.UUID) -> ChangeOrder:
    co = await db.get(ChangeOrder, co_id)
    if not co or co.deleted_at:
        raise _404("Change order")
    return co


async def decide_change_order(db: AsyncSession, co: ChangeOrder, decision: str, note: str | None, actor: CurrentUser) -> ChangeOrder:
    if co.status != "pending":
        raise _422("This change order was already decided")
    p = await get_project(db, co.project_id)
    if decision == "rejected" and not (note or "").strip():
        raise _422("A note is required when rejecting")
    if decision == "approved":
        _check_capital_limit(actor, abs(float(co.amount)))
        new_budget = float(p.current_budget or 0) + float(co.amount)
        await _budget_entry(db, p, "change_order", new_budget, f"CO #{co.number}: {co.title}", actor, co.id)
        p.contract_amount = float(p.contract_amount or 0) + float(co.amount)
        if co.days_impact and p.target_completion_on:
            p.target_completion_on = p.target_completion_on + timedelta(days=co.days_impact)
    co.status, co.decided_by_id, co.decided_at, co.decision_note = decision, actor.id, utcnow(), note
    _approval(db, p, "change_order", decision, actor, amount=float(co.amount), reference_id=co.id, note=note)
    await _record(db, actor, f"capital_project.change_order_{decision}", "capital_project", p.id,
                  summary=f"CO #{co.number} {co.title}",
                  changes={"amount": co.amount, "current_budget": p.current_budget, "contract_amount": p.contract_amount})
    await db.commit()
    return co


async def add_draw(db: AsyncSession, p: CapitalProject, data: DrawIn, actor: CurrentUser) -> ProjectDraw:
    if p.status not in ("awarded", "in_progress", "completed"):
        raise _422("Draws apply to awarded projects")
    drawn = float(await db.scalar(select(func.coalesce(func.sum(ProjectDraw.amount), 0)).where(
        ProjectDraw.project_id == p.id, ProjectDraw.status != "rejected", ProjectDraw.deleted_at.is_(None))) or 0)
    if drawn + data.amount > float(p.contract_amount or 0) + 0.005:
        raise _422(f"Draws would total ${drawn + data.amount:,.2f}, above the contract amount ${float(p.contract_amount or 0):,.2f}")
    number = int(await db.scalar(select(func.coalesce(func.max(ProjectDraw.number), 0)).where(ProjectDraw.project_id == p.id)) or 0) + 1
    d = ProjectDraw(project_id=p.id, number=number, **data.model_dump(), status="requested",
                    created_by_id=actor.id, updated_by_id=actor.id)
    db.add(d)
    await db.flush()
    await link_documents(db, [data.lien_waiver_document_id], "lien_waiver", d.id, actor)
    await _record(db, actor, "capital_project.draw_requested", "capital_project", p.id,
                  summary=f"Draw #{number}", changes={"amount": data.amount})
    await db.commit()
    return d


async def get_draw(db: AsyncSession, draw_id: uuid.UUID) -> ProjectDraw:
    d = await db.get(ProjectDraw, draw_id)
    if not d or d.deleted_at:
        raise _404("Draw")
    return d


async def update_draw(db: AsyncSession, d: ProjectDraw, data: DrawUpdate, actor: CurrentUser) -> ProjectDraw:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(d, values)
    for k, v in values.items():
        setattr(d, k, v)
    if changes:
        await link_documents(db, [values.get("lien_waiver_document_id")], "lien_waiver", d.id, actor)
        await _record(db, actor, "capital_project.draw_updated", "capital_project", d.project_id,
                      summary=f"Draw #{d.number}", changes=changes)
    await db.commit()
    return d


async def decide_draw(db: AsyncSession, d: ProjectDraw, decision: str, note: str | None, actor: CurrentUser) -> ProjectDraw:
    if d.status != "requested":
        raise _422("This draw was already decided")
    p = await get_project(db, d.project_id)
    if decision == "approved":
        if not d.lien_waiver_document_id and not (await linked_document_counts(db, "lien_waiver", [d.id])).get(d.id):
            raise _422("A lien waiver must be attached before the draw can be approved")
        if p.contractor_vendor_id:
            ok, reasons = await vendor_is_compliant(db, p.contractor_vendor_id)
            if not ok:
                raise _422("Contractor is not compliant; draw approval is blocked", reasons=reasons)
        _check_capital_limit(actor, float(d.amount))
        d.approved_by_id, d.approved_at = actor.id, utcnow()
    elif not (note or "").strip():
        raise _422("A note is required when rejecting")
    d.status = decision
    if note:
        d.notes = f"{d.notes}\n{note}" if d.notes else note
    _approval(db, p, "draw", decision, actor, amount=float(d.amount), reference_id=d.id, note=note)
    await _record(db, actor, f"capital_project.draw_{decision}", "capital_project", p.id,
                  summary=f"Draw #{d.number}", changes={"amount": d.amount})
    await db.commit()
    return d


async def pay_draw(db: AsyncSession, d: ProjectDraw, paid_on: date, reference: str | None, actor: CurrentUser) -> ProjectDraw:
    if d.status != "approved":
        raise _422("Only approved draws can be marked paid")
    d.status, d.paid_on, d.payment_reference = "paid", paid_on, reference
    await _record(db, actor, "capital_project.draw_paid", "capital_project", d.project_id,
                  summary=f"Draw #{d.number}", changes={"amount": d.amount, "paid_on": paid_on, "reference": reference})
    await db.commit()
    return d


async def _lease_children(db: AsyncSession, model_name: str, lease_ids: list[uuid.UUID]) -> dict[uuid.UUID, list]:
    """Rows of a leases-module child table grouped by lease_id; empty when that table is not available."""
    out: dict[uuid.UUID, list] = defaultdict(list)
    if not lease_ids:
        return out
    try:
        from app.modules.leases import models as lease_models
        model = getattr(lease_models, model_name)
        rows = await db.scalars(select(model).where(model.lease_id.in_(lease_ids)))
    except (ImportError, AttributeError):
        return out
    for r in rows:
        if getattr(r, "deleted_at", None) is None:
            out[r.lease_id].append(r)
    return out


async def analyze_recoverability(db: AsyncSession, p: CapitalProject, actor: CurrentUser) -> CapitalProject:
    """Share of the project cost recoverable from tenants under applicable leases (amortized over useful life)."""
    try:
        from app.modules.leases.models import Lease
    except ImportError:
        raise _422("Lease data is not available; recoverability cannot be analyzed yet")
    leases = list(await db.scalars(select(Lease).where(
        Lease.property_id == p.property_id, Lease.status == "active", Lease.deleted_at.is_(None))))
    life = p.useful_life_years or 10
    cost = float(p.current_budget or 0)
    total_sf = sum(float(getattr(l, "rentable_sf", 0) or 0) for l in leases) or None
    lease_ids = [l.id for l in leases]
    by_lease_recs = await _lease_children(db, "LeaseRecovery", lease_ids)
    by_lease_clauses = await _lease_children(db, "LeaseClause", lease_ids)

    results = []
    recoverable_total = 0.0
    for l in leases:
        sf = float(getattr(l, "rentable_sf", 0) or 0)
        lrecs = by_lease_recs[l.id]
        share = None
        for r in lrecs:
            for attr in ("pro_rata_share", "share_pct", "pro_rata_pct"):
                val = getattr(r, attr, None)
                if val:
                    share = float(val) * (100 if float(val) <= 1 else 1)
                    break
            if share:
                break
        if share is None and total_sf:
            share = round(100 * sf / total_sf, 2)
        text = " ".join(str(getattr(c, "summary", None) or getattr(c, "quoted_text", None) or "")
                        for c in by_lease_clauses[l.id]).lower()
        rec_text = " ".join(f"{getattr(r, 'recovery_type', '')} {getattr(r, 'category', '')} {getattr(r, 'notes', '')}"
                            for r in lrecs).lower()
        excluded = any(t in text for t in ("capital expenditures are excluded", "excluding capital", "shall not include capital"))
        allowed = ("capital" in rec_text or "amortiz" in text or "capital improvement" in text) and not excluded
        lease_type = str(getattr(l, "lease_type", "") or "").lower()
        if not allowed and not excluded and lease_type in ("absolute_net", "bondable"):
            allowed = True
        if allowed:
            reason = "Lease permits recovery of amortized capital costs" if "amortiz" in text else \
                "Recovery terms include capital items"
        elif excluded:
            reason = "Lease excludes capital expenditures from recoveries"
        else:
            reason = "No capital recovery provision found"
        amount = round(cost * (share or 0) / 100, 2) if allowed else 0.0
        recoverable_total += amount
        results.append({"lease_id": str(l.id), "tenant_name": getattr(l, "tenant_name", None),
                        "lease_type": getattr(l, "lease_type", None), "rentable_sf": sf or None,
                        "share_pct": share, "recoverable": allowed, "recoverable_amount": amount,
                        "annual_recovery": round(amount / life, 2) if allowed else 0.0, "reason": reason})
    p.recoverability = {
        "project_cost": cost, "useful_life_years": life, "lease_count": len(leases),
        "recoverable_amount": round(recoverable_total, 2),
        "recoverable_pct": round(100 * recoverable_total / cost, 2) if cost else None,
        "annual_recovery": round(recoverable_total / life, 2), "leases": results,
        "status": "recoverable" if recoverable_total > 0 else ("not_recoverable" if leases else "no_leases"),
    }
    p.recoverability_analyzed_at = utcnow()
    await _record(db, actor, "capital_project.recoverability_analyzed", "capital_project", p.id,
                  changes={"recoverable_amount": p.recoverability["recoverable_amount"],
                           "recoverable_pct": p.recoverability["recoverable_pct"]})
    await db.commit()
    return p


# ======================================================================= insurance

def _policy_out(p: InsurancePolicy, names: dict, claims: dict) -> PolicyOut:
    o = PolicyOut.model_validate(p)
    o.property_name = names.get(p.property_id) if p.property_id else None
    o.days_to_expiry = _days(p.expires_on)
    o.open_claims = int(claims.get(p.id, 0) or 0)
    return o


async def policy_items(db: AsyncSession, rows: list[InsurancePolicy]) -> list[PolicyOut]:
    names = await property_names(db, {p.property_id for p in rows})
    claims = dict((await db.execute(select(InsuranceClaim.policy_id, func.count()).where(
        InsuranceClaim.policy_id.in_([p.id for p in rows]), InsuranceClaim.status.not_in(["closed", "denied", "paid"]),
        InsuranceClaim.deleted_at.is_(None)).group_by(InsuranceClaim.policy_id))).all()) if rows else {}
    return [_policy_out(p, names, claims) for p in rows]


def policy_query(q: str | None, coverage_type: list[str] | None, status_: list[str] | None,
                 property_id: uuid.UUID | None, expiring_within_days: int | None, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(InsurancePolicy).where(InsurancePolicy.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [InsurancePolicy.policy_number, InsurancePolicy.carrier, InsurancePolicy.broker,
                                  InsurancePolicy.named_insured])
    if "coverage_type" not in skip:
        stmt = in_filter(stmt, InsurancePolicy.coverage_type, coverage_type)
    if "status" not in skip:
        stmt = in_filter(stmt, InsurancePolicy.status, status_)
    if property_id:
        stmt = stmt.where(InsurancePolicy.property_id == property_id)
    if expiring_within_days is not None:
        stmt = stmt.where(InsurancePolicy.expires_on <= date.today() + timedelta(days=expiring_within_days))
    return stmt


async def get_policy(db: AsyncSession, policy_id: uuid.UUID) -> InsurancePolicy:
    p = await db.get(InsurancePolicy, policy_id)
    if not p or p.deleted_at:
        raise _404("Policy")
    return p


async def save_policy(db: AsyncSession, data: PolicyIn, actor: CurrentUser, p: InsurancePolicy | None = None) -> InsurancePolicy:
    if data.expires_on <= data.effective_on:
        raise _422("Expiration must be after the effective date")
    await _require_property(db, data.property_id)
    values = data.model_dump()
    if not values.get("asset_id"):
        values["asset_id"] = await asset_for_property(db, data.property_id)
    if p is None:
        p = InsurancePolicy(**values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(p)
        await db.flush()
        await _record(db, actor, "insurance_policy.created", "insurance_policy", p.id,
                      summary=f"{p.carrier} {p.policy_number}")
    else:
        changes = audit.diff(p, values)
        for k, v in values.items():
            setattr(p, k, v)
        p.updated_by_id = actor.id
        if changes:
            await _record(db, actor, "insurance_policy.updated", "insurance_policy", p.id, changes=changes)
    await link_documents(db, [data.document_id], "insurance_policy", p.id, actor)
    if p.status in ("active", "pending_renewal"):
        await critical_date(db, related_type="insurance_policy", related_id=p.id, date_type="insurance_expiration",
                            label=f"{p.carrier} {p.coverage_type.replace('_', ' ')} policy expires",
                            due_on=p.expires_on, property_id=p.property_id, actor=actor, lead_days=POLICY_WARNING_DAYS)
    await db.commit()
    return p


async def archive_policy(db: AsyncSession, p: InsurancePolicy, actor: CurrentUser) -> None:
    p.deleted_at = utcnow()
    await _record(db, actor, "insurance_policy.archived", "insurance_policy", p.id, summary=p.policy_number)
    await db.commit()


def evaluate_certificate(c: InsuranceCertificate, today: date | None = None) -> tuple[str, list[str]]:
    today = today or date.today()
    if not c.received_on:
        return "requested", []
    issues: list[str] = []
    if c.expires_on and c.expires_on < today:
        return "expired", [f"Expired on {c.expires_on.isoformat()}"]
    if c.required_limit and (c.limit_amount or 0) < c.required_limit:
        issues.append(f"Limit ${float(c.limit_amount or 0):,.0f} is below the required ${float(c.required_limit):,.0f}")
    if c.additional_insured_required and not c.additional_insured:
        issues.append("Owner is not named as additional insured")
    if not c.expires_on:
        issues.append("Expiration date missing")
    return ("deficient" if issues else "compliant"), issues


async def certificate_items(db: AsyncSession, rows: list[InsuranceCertificate]) -> list[CertificateOut]:
    names = await property_names(db, {c.property_id for c in rows})
    vendors = await vendor_names(db, {c.vendor_id for c in rows})
    out = []
    for c in rows:
        o = CertificateOut.model_validate(c)
        o.holder_name = (vendors.get(c.vendor_id) if c.holder_kind == "vendor" else c.tenant_name) or c.tenant_name
        o.property_name = names.get(c.property_id) if c.property_id else None
        o.days_to_expiry = _days(c.expires_on)
        out.append(o)
    return out


def certificate_query(q: str | None, holder_kind: list[str] | None, status_: list[str] | None,
                      property_id: uuid.UUID | None, vendor_id: uuid.UUID | None, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(InsuranceCertificate).where(InsuranceCertificate.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [InsuranceCertificate.tenant_name, InsuranceCertificate.carrier,
                                  InsuranceCertificate.policy_number])
    if "holder_kind" not in skip:
        stmt = in_filter(stmt, InsuranceCertificate.holder_kind, holder_kind)
    if "status" not in skip:
        stmt = in_filter(stmt, InsuranceCertificate.status, status_)
    if property_id:
        stmt = stmt.where(InsuranceCertificate.property_id == property_id)
    if vendor_id:
        stmt = stmt.where(InsuranceCertificate.vendor_id == vendor_id)
    return stmt


async def get_certificate(db: AsyncSession, cert_id: uuid.UUID) -> InsuranceCertificate:
    c = await db.get(InsuranceCertificate, cert_id)
    if not c or c.deleted_at:
        raise _404("Certificate")
    return c


async def save_certificate(db: AsyncSession, data: CertificateIn, actor: CurrentUser,
                           c: InsuranceCertificate | None = None) -> InsuranceCertificate:
    if data.holder_kind == "vendor" and not data.vendor_id:
        raise _422("Select the vendor this certificate belongs to")
    if data.holder_kind == "tenant" and not (data.tenant_name or data.tenant_organization_id or data.lease_id):
        raise _422("Identify the tenant (name, organization or lease)")
    await _require_property(db, data.property_id)
    values = data.model_dump()
    if c is None:
        c = InsuranceCertificate(**values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(c)
        action, changes = "insurance_certificate.created", None
    else:
        changes = audit.diff(c, values)
        for k, v in values.items():
            setattr(c, k, v)
        c.updated_by_id = actor.id
        action = "insurance_certificate.updated"
    c.status, c.deficiencies = evaluate_certificate(c)
    await db.flush()
    await link_documents(db, [data.document_id], "insurance_certificate", c.id, actor)
    await _record(db, actor, action, "insurance_certificate", c.id, changes=changes,
                  summary=f"{c.holder_kind}: {c.status}")
    await db.commit()
    return c


async def archive_certificate(db: AsyncSession, c: InsuranceCertificate, actor: CurrentUser) -> None:
    c.deleted_at = utcnow()
    await _record(db, actor, "insurance_certificate.archived", "insurance_certificate", c.id)
    await db.commit()


async def claim_items(db: AsyncSession, rows: list[InsuranceClaim]) -> list[ClaimOut]:
    names = await property_names(db, {c.property_id for c in rows})
    pols = {p.id: p for p in await db.scalars(select(InsurancePolicy).where(
        InsurancePolicy.id.in_([c.policy_id for c in rows if c.policy_id])))} if rows else {}
    out = []
    for c in rows:
        o = ClaimOut.model_validate(c)
        o.property_name = names.get(c.property_id) if c.property_id else None
        pol = pols.get(c.policy_id) if c.policy_id else None
        o.policy_label = f"{pol.carrier} · {pol.policy_number}" if pol else None
        out.append(o)
    return out


def claim_query(q: str | None, status_: list[str] | None, property_id: uuid.UUID | None, policy_id: uuid.UUID | None,
                *, skip: set[str] = frozenset()) -> Select:
    stmt = select(InsuranceClaim).where(InsuranceClaim.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [InsuranceClaim.claim_number, InsuranceClaim.description, InsuranceClaim.cause,
                                  InsuranceClaim.adjuster_name])
    if "status" not in skip:
        stmt = in_filter(stmt, InsuranceClaim.status, status_)
    if property_id:
        stmt = stmt.where(InsuranceClaim.property_id == property_id)
    if policy_id:
        stmt = stmt.where(InsuranceClaim.policy_id == policy_id)
    return stmt


async def get_claim(db: AsyncSession, claim_id: uuid.UUID) -> InsuranceClaim:
    c = await db.get(InsuranceClaim, claim_id)
    if not c or c.deleted_at:
        raise _404("Claim")
    return c


async def save_claim(db: AsyncSession, data: ClaimIn, actor: CurrentUser, c: InsuranceClaim | None = None) -> InsuranceClaim:
    values = data.model_dump()
    if data.policy_id and not data.property_id:
        values["property_id"] = (await get_policy(db, data.policy_id)).property_id
    await _require_property(db, values.get("property_id"))
    if c is None:
        c = InsuranceClaim(**values, status="reported", created_by_id=actor.id, updated_by_id=actor.id,
                           status_history=[{"from": None, "to": "reported", "at": utcnow().isoformat(),
                                            "by_name": actor.full_name, "note": None}])
        db.add(c)
        await db.flush()
        await _record(db, actor, "insurance_claim.created", "insurance_claim", c.id, summary=c.claim_number or c.cause)
    else:
        changes = audit.diff(c, values)
        for k, v in values.items():
            setattr(c, k, v)
        c.updated_by_id = actor.id
        if changes:
            await _record(db, actor, "insurance_claim.updated", "insurance_claim", c.id, changes=changes)
    await db.commit()
    return c


async def set_claim_status(db: AsyncSession, c: InsuranceClaim, to: str, note: str | None, paid_amount: float | None,
                           actor: CurrentUser) -> InsuranceClaim:
    if c.status == "closed":
        raise _422("This claim is closed")
    previous = c.status
    c.status_history = [*(c.status_history or []), {"from": previous, "to": to, "at": utcnow().isoformat(),
                                                    "by_name": actor.full_name, "note": note}]
    c.status = to
    if paid_amount is not None:
        c.paid_amount = paid_amount
    if to == "closed":
        c.closed_on = date.today()
    await _record(db, actor, "insurance_claim.status_changed", "insurance_claim", c.id, summary=note,
                  changes={"status": {"from": previous, "to": to}, "paid_amount": c.paid_amount})
    await db.commit()
    return c


# ======================================================================= property tax

async def assessment_items(db: AsyncSession, rows: list[TaxAssessment]) -> list[AssessmentOut]:
    names = await property_names(db, {a.property_id for a in rows})
    prior: dict = {}
    protests: dict = {}
    if rows:
        props = {a.property_id for a in rows}
        for a in await db.scalars(select(TaxAssessment).where(TaxAssessment.property_id.in_(props),
                                                              TaxAssessment.deleted_at.is_(None))):
            prior[(a.property_id, a.parcel_id, a.tax_year)] = a.assessed_total
        for pr in await db.scalars(select(TaxProtest).where(TaxProtest.assessment_id.in_([a.id for a in rows]),
                                                            TaxProtest.deleted_at.is_(None))):
            protests[pr.assessment_id] = pr
    out = []
    for a in rows:
        o = AssessmentOut.model_validate(a)
        o.property_name = names.get(a.property_id)
        o.prior_assessed_total = prior.get((a.property_id, a.parcel_id, a.tax_year - 1))
        if o.prior_assessed_total:
            o.change_pct = round(100 * (float(a.assessed_total) - float(o.prior_assessed_total)) / float(o.prior_assessed_total), 2)
        if a.id in protests:
            o.protest_id, o.protest_status = protests[a.id].id, protests[a.id].status
        out.append(o)
    return out


async def get_assessment(db: AsyncSession, assessment_id: uuid.UUID) -> TaxAssessment:
    a = await db.get(TaxAssessment, assessment_id)
    if not a or a.deleted_at:
        raise _404("Assessment")
    return a


async def save_assessment(db: AsyncSession, data: AssessmentIn, actor: CurrentUser, a: TaxAssessment | None = None) -> TaxAssessment:
    await _require_property(db, data.property_id)
    values = data.model_dump()
    if values.get("estimated_tax") is None and data.tax_rate:
        values["estimated_tax"] = round(float(data.taxable_value or data.assessed_total) * data.tax_rate / 100, 2)
    dup = select(TaxAssessment.id).where(
        TaxAssessment.property_id == data.property_id, TaxAssessment.tax_year == data.tax_year,
        TaxAssessment.deleted_at.is_(None),
        TaxAssessment.parcel_id == data.parcel_id if data.parcel_id else TaxAssessment.parcel_id.is_(None))
    if a is not None:
        dup = dup.where(TaxAssessment.id != a.id)
    if await db.scalar(dup):
        raise HTTPException(status.HTTP_409_CONFLICT, f"An assessment for {data.tax_year} already exists; edit it instead")
    if a is None:
        a = TaxAssessment(**values, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(a)
        await db.flush()
        await _record(db, actor, "tax_assessment.created", "tax_assessment", a.id,
                      summary=f"{a.tax_year}: ${a.assessed_total:,.0f}")
    else:
        changes = audit.diff(a, values)
        for k, v in values.items():
            setattr(a, k, v)
        a.updated_by_id = actor.id
        if changes:  # corrections are kept in the audit trail with before/after values
            await _record(db, actor, "tax_assessment.updated", "tax_assessment", a.id, changes=changes)
    await critical_date(db, related_type="tax_assessment", related_id=a.id, date_type="tax_protest_deadline",
                        label=f"{a.tax_year} tax protest deadline", due_on=a.protest_deadline_on,
                        property_id=a.property_id, actor=actor, lead_days=30, is_blocking=True)
    await db.commit()
    return a


async def archive_assessment(db: AsyncSession, a: TaxAssessment, actor: CurrentUser) -> None:
    a.deleted_at = utcnow()
    await _record(db, actor, "tax_assessment.archived", "tax_assessment", a.id, summary=str(a.tax_year))
    await db.commit()


async def protest_items(db: AsyncSession, rows: list[TaxProtest]) -> list[ProtestOut]:
    names = await property_names(db, {p.property_id for p in rows})
    totals = dict((await db.execute(select(TaxAssessment.id, TaxAssessment.assessed_total).where(
        TaxAssessment.id.in_([p.assessment_id for p in rows])))).all()) if rows else {}
    out = []
    for p in rows:
        o = ProtestOut.model_validate(p)
        o.property_name = names.get(p.property_id)
        o.assessed_total = totals.get(p.assessment_id)
        o.days_to_deadline = _days(p.deadline_on) if p.status == "considering" else None
        out.append(o)
    return out


async def get_protest(db: AsyncSession, protest_id: uuid.UUID) -> TaxProtest:
    p = await db.get(TaxProtest, protest_id)
    if not p or p.deleted_at:
        raise _404("Protest")
    return p


async def _protest_dates(db: AsyncSession, p: TaxProtest, actor: CurrentUser) -> None:
    await critical_date(db, related_type="tax_protest", related_id=p.id, date_type="tax_protest_deadline",
                        label=f"{p.tax_year} tax protest filing deadline", due_on=p.deadline_on,
                        property_id=p.property_id, actor=actor, lead_days=30, is_blocking=True,
                        status_="confirmed" if p.status == "considering" else "completed")
    await critical_date(db, related_type="tax_protest", related_id=p.id, date_type="tax_protest_hearing",
                        label=f"{p.tax_year} tax protest hearing", due_on=p.hearing_on, property_id=p.property_id,
                        actor=actor, lead_days=14, status_="completed" if p.hearing_result else "confirmed")


async def create_protest(db: AsyncSession, data: ProtestIn, actor: CurrentUser) -> TaxProtest:
    a = await get_assessment(db, data.assessment_id)
    if await db.scalar(select(TaxProtest.id).where(TaxProtest.assessment_id == a.id, TaxProtest.deleted_at.is_(None))):
        raise HTTPException(status.HTTP_409_CONFLICT, "A protest already exists for this assessment")
    values = data.model_dump()
    values["deadline_on"] = data.deadline_on or a.protest_deadline_on
    p = TaxProtest(**values, property_id=a.property_id, tax_year=a.tax_year, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(p)
    await db.flush()
    await link_documents(db, data.evidence_document_ids, "tax_protest", p.id, actor)
    await _protest_dates(db, p, actor)
    await _record(db, actor, "tax_protest.created", "tax_protest", p.id, summary=f"{p.tax_year} protest")
    await db.commit()
    return p


async def update_protest(db: AsyncSession, p: TaxProtest, data: ProtestUpdate, actor: CurrentUser) -> TaxProtest:
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(p, values)
    if not changes:
        return p
    new_docs = set(values.get("evidence_document_ids") or []) - set(p.evidence_document_ids or [])
    for k, v in values.items():
        setattr(p, k, v if k != "evidence_document_ids" else (v or []))
    if values.get("status") == "filed" and not p.filed_on:
        p.filed_on = date.today()
    p.updated_by_id = actor.id
    await link_documents(db, list(new_docs), "tax_protest", p.id, actor)
    await _protest_dates(db, p, actor)
    await _record(db, actor, "tax_protest.updated", "tax_protest", p.id, changes=changes)
    await db.commit()
    return p


def protest_savings(assessed_total: float, final_value: float | None, tax_rate: float | None,
                    estimated_tax: float | None, fee_pct: float | None, fee_flat: float | None) -> dict:
    """Measured outcome: value reduction × effective rate, net of consultant fees."""
    if final_value is None:
        return {"value_reduction": 0.0, "tax_savings": 0.0, "consultant_fee": float(fee_flat or 0),
                "net_savings": -float(fee_flat or 0)}
    reduction = round(float(assessed_total) - float(final_value), 2)
    rate = tax_rate if tax_rate else (100 * float(estimated_tax) / float(assessed_total) if estimated_tax and assessed_total else 0)
    savings = round(max(reduction, 0) * rate / 100, 2) if reduction > 0 else round(reduction * rate / 100, 2)
    fee = float(fee_flat or 0) + (round(savings * fee_pct / 100, 2) if fee_pct and savings > 0 else 0)
    return {"value_reduction": reduction, "tax_savings": savings, "consultant_fee": round(fee, 2),
            "net_savings": round(savings - fee, 2)}


async def record_hearing(db: AsyncSession, p: TaxProtest, data: HearingResultIn, actor: CurrentUser) -> TaxProtest:
    a = await get_assessment(db, p.assessment_id)
    final = data.final_value
    if data.hearing_result in ("no_change", "withdrawn") and final is None:
        final = float(a.assessed_total)
    if data.hearing_result in ("reduced", "increased", "settled") and final is None:
        raise _422("Enter the final assessed value")
    result = protest_savings(float(a.assessed_total), final, a.tax_rate, a.estimated_tax, p.consultant_fee_pct,
                             p.consultant_fee_flat)
    before = {k: getattr(p, k) for k in ("hearing_result", "final_value", "tax_savings", "net_savings", "status")}
    p.hearing_result, p.final_value = data.hearing_result, final
    p.value_reduction, p.tax_savings = result["value_reduction"], result["tax_savings"]
    p.consultant_fee, p.net_savings = result["consultant_fee"], result["net_savings"]
    p.resolved_on = data.resolved_on or date.today()
    p.status = {"reduced": "won", "no_change": "lost", "increased": "lost", "settled": "settled",
                "withdrawn": "withdrawn"}[data.hearing_result]
    p.updated_by_id = actor.id
    await _protest_dates(db, p, actor)
    await _record(db, actor, "tax_protest.resolved", "tax_protest", p.id, summary=data.note,
                  changes=_delta(before, {"hearing_result": p.hearing_result, "final_value": final,
                                          "tax_savings": p.tax_savings, "net_savings": p.net_savings, "status": p.status}))
    await db.commit()
    return p


async def tax_summary(db: AsyncSession, property_id: uuid.UUID | None, tax_year: int | None) -> dict:
    stmt = select(TaxProtest).where(TaxProtest.deleted_at.is_(None))
    if property_id:
        stmt = stmt.where(TaxProtest.property_id == property_id)
    if tax_year:
        stmt = stmt.where(TaxProtest.tax_year == tax_year)
    rows = list(await db.scalars(stmt))
    resolved = [p for p in rows if p.hearing_result]
    won = [p for p in resolved if (p.value_reduction or 0) > 0]
    return {
        "protests": len(rows), "resolved": len(resolved),
        "total_value_reduction": round(sum(float(p.value_reduction or 0) for p in resolved), 2),
        "total_tax_savings": round(sum(float(p.tax_savings or 0) for p in resolved), 2),
        "total_consultant_fees": round(sum(float(p.consultant_fee or 0) for p in resolved), 2),
        "total_net_savings": round(sum(float(p.net_savings or 0) for p in resolved), 2),
        "success_rate": round(100 * len(won) / len(resolved), 1) if resolved else None,
    }


async def payment_items(db: AsyncSession, rows: list[TaxPayment]) -> list[PaymentOut]:
    names = await property_names(db, {p.property_id for p in rows})
    out = []
    for p in rows:
        o = PaymentOut.model_validate(p)
        o.property_name = names.get(p.property_id)
        out.append(o)
    return out


async def get_payment(db: AsyncSession, payment_id: uuid.UUID) -> TaxPayment:
    p = await db.get(TaxPayment, payment_id)
    if not p or p.deleted_at:
        raise _404("Payment")
    return p


async def create_payment(db: AsyncSession, data: PaymentIn, actor: CurrentUser) -> TaxPayment:
    await _require_property(db, data.property_id)
    p = TaxPayment(**data.model_dump(), status="scheduled", created_by_id=actor.id, updated_by_id=actor.id)
    db.add(p)
    await db.flush()
    await critical_date(db, related_type="tax_payment", related_id=p.id, date_type="tax_payment_due",
                        label=f"{p.tax_year} property tax {p.installment or 'payment'} due", due_on=p.due_on,
                        property_id=p.property_id, actor=actor, lead_days=21, is_blocking=True)
    await _record(db, actor, "tax_payment.scheduled", "tax_payment", p.id, summary=f"${p.amount_due:,.2f} due {p.due_on}")
    await db.commit()
    return p


async def confirm_payment(db: AsyncSession, p: TaxPayment, data: PaymentConfirmIn, actor: CurrentUser) -> TaxPayment:
    if p.status == "confirmed":
        raise _422("This payment is already confirmed")
    before = {"status": p.status, "amount_paid": p.amount_paid}
    p.amount_paid, p.paid_on, p.method = data.amount_paid, data.paid_on, data.method
    p.confirmation_number = data.confirmation_number
    if data.document_id:
        p.document_id = data.document_id
    p.status = "confirmed"
    p.confirmed_by_id, p.confirmed_at = actor.id, utcnow()
    await link_documents(db, [data.document_id], "tax_payment", p.id, actor)
    await critical_date(db, related_type="tax_payment", related_id=p.id, date_type="tax_payment_due",
                        label=f"{p.tax_year} property tax {p.installment or 'payment'} due", due_on=p.due_on,
                        property_id=p.property_id, actor=actor, lead_days=21, is_blocking=True, status_="completed")
    await _record(db, actor, "tax_payment.confirmed", "tax_payment", p.id, summary=data.confirmation_number,
                  changes=_delta(before, {"status": "confirmed", "amount_paid": data.amount_paid}))
    await db.commit()
    return p


async def archive_payment(db: AsyncSession, p: TaxPayment, actor: CurrentUser) -> None:
    if p.status == "confirmed":
        raise _422("Confirmed payments are retained")
    p.deleted_at = utcnow()
    await _record(db, actor, "tax_payment.archived", "tax_payment", p.id)
    await db.commit()


# ======================================================================= operating budgets

async def _financials(db: AsyncSession, asset_id: uuid.UUID | None, year: int) -> dict[tuple[str, int], tuple[str, float]] | None:
    """{(account, month): (category, amount)} from assets.asset_financials; None if unavailable."""
    if not asset_id:
        return None
    try:
        from app.modules.assets.models import AssetFinancial
    except ImportError:
        return None
    stmt = select(AssetFinancial).where(AssetFinancial.asset_id == asset_id,
                                        extract("year", AssetFinancial.period) == year)
    if hasattr(AssetFinancial, "deleted_at"):
        stmt = stmt.where(AssetFinancial.deleted_at.is_(None))
    out: dict[tuple[str, int], tuple[str, float]] = {}
    for f in await db.scalars(stmt):
        cat = f.category if f.category in ("income", "expense", "capex") else None
        if cat is None:
            continue
        key = (f.account, f.period.month)
        out[key] = (cat, out.get(key, (cat, 0.0))[1] + float(f.amount or 0))
    return out


async def budget_totals(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, float]]:
    if not ids:
        return {}
    rows = await db.execute(
        select(BudgetLine.budget_id, BudgetLine.category,
               func.sum(func.coalesce(BudgetLine.reforecast_amount, BudgetLine.amount)))
        .where(BudgetLine.budget_id.in_(ids)).group_by(BudgetLine.budget_id, BudgetLine.category))
    out: dict = defaultdict(lambda: {"income": 0.0, "expense": 0.0, "capex": 0.0})
    for bid, cat, total in rows.all():
        out[bid][cat] = float(total or 0)
    return out


async def budget_items(db: AsyncSession, rows: list[Budget]) -> list[BudgetListItem]:
    names = await property_names(db, {b.property_id for b in rows})
    totals = await budget_totals(db, [b.id for b in rows])
    out = []
    for b in rows:
        o = BudgetListItem.model_validate(b)
        o.property_name = names.get(b.property_id)
        t = totals.get(b.id, {"income": 0.0, "expense": 0.0, "capex": 0.0})
        o.total_income, o.total_expense, o.total_capex = t["income"], t["expense"], t["capex"]
        o.noi = round(t["income"] - t["expense"], 2)
        out.append(o)
    return out


def budget_query(q: str | None, status_: list[str] | None, fiscal_year: list[int] | None,
                 property_id: uuid.UUID | None, asset_id: uuid.UUID | None, current_only: bool | None,
                 *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Budget).where(Budget.deleted_at.is_(None))
    if q:
        stmt = stmt.outerjoin(Property, Property.id == Budget.property_id)
        stmt = apply_search(stmt, q, [Budget.name, Property.name, Property.address_line])
    if "status" not in skip:
        stmt = in_filter(stmt, Budget.status, status_)
    if "fiscal_year" not in skip:
        stmt = in_filter(stmt, Budget.fiscal_year, fiscal_year)
    if property_id:
        stmt = stmt.where(Budget.property_id == property_id)
    if asset_id:
        stmt = stmt.where(Budget.asset_id == asset_id)
    if current_only:
        stmt = stmt.where(Budget.status != "superseded")
    return stmt


async def get_budget(db: AsyncSession, budget_id: uuid.UUID) -> Budget:
    b = await db.get(Budget, budget_id)
    if not b or b.deleted_at:
        raise _404("Budget")
    return b


async def budget_out(db: AsyncSession, b: Budget) -> BudgetOut:
    base = (await budget_items(db, [b]))[0]
    out = BudgetOut.model_validate(b)
    for k in ("property_name", "total_income", "total_expense", "total_capex", "noi"):
        setattr(out, k, getattr(base, k))
    lines = list(await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == b.id)))
    actuals = await _financials(db, b.asset_id, b.fiscal_year)
    out.actuals_available = actuals is not None
    accounts: dict[str, dict] = {}
    for line in lines:
        acc = accounts.setdefault(line.account, {"category": line.category, "budget": [0.0] * 12,
                                                 "reforecast": [None] * 12, "prior": [None] * 12})
        acc["budget"][line.month - 1] = float(line.amount or 0)
        acc["reforecast"][line.month - 1] = float(line.reforecast_amount) if line.reforecast_amount is not None else None
        acc["prior"][line.month - 1] = float(line.prior_actual) if line.prior_actual is not None else None
    order = {"income": 0, "expense": 1, "capex": 2}
    rows: list[GridRow] = []
    for account, acc in sorted(accounts.items(), key=lambda kv: (order.get(kv[1]["category"], 9), kv[0])):
        actual: list[float | None] = [None] * 12
        if actuals:
            for m in range(12):
                hit = actuals.get((account, m + 1))
                actual[m] = hit[1] if hit else None
        months = [m for m in range(12) if actual[m] is not None]
        plan = [acc["reforecast"][m] if acc["reforecast"][m] is not None else acc["budget"][m] for m in range(12)]
        variance = round(sum(actual[m] - plan[m] for m in months), 2) if months else None
        plan_to_date = sum(plan[m] for m in months)
        has_rf = any(v is not None for v in acc["reforecast"])
        has_prior = any(v is not None for v in acc["prior"])
        rows.append(GridRow(
            account=account, category=acc["category"], budget=acc["budget"], reforecast=acc["reforecast"],
            prior_actual=acc["prior"], actual=actual, budget_total=round(sum(acc["budget"]), 2),
            reforecast_total=round(sum(plan), 2) if has_rf else None,
            prior_actual_total=round(sum(v or 0 for v in acc["prior"]), 2) if has_prior else None,
            actual_total=round(sum(actual[m] for m in months), 2) if months else None,
            variance=variance,
            variance_pct=round(100 * variance / plan_to_date, 2) if variance is not None and plan_to_date else None,
        ))
    out.rows = rows
    versions = list(await db.scalars(select(Budget).where(
        Budget.property_id == b.property_id, Budget.fiscal_year == b.fiscal_year, Budget.deleted_at.is_(None))
        .order_by(Budget.version.desc())))
    out.versions = await budget_items(db, versions)
    return out


async def _load_prior(db: AsyncSession, b: Budget) -> int:
    prior = await _financials(db, b.asset_id, b.fiscal_year - 1)
    if not prior:
        return 0
    existing = {(l.account, l.month): l for l in await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == b.id))}
    for (account, month), (cat, amount) in prior.items():
        line = existing.get((account, month))
        if line is None:
            db.add(BudgetLine(budget_id=b.id, account=account, category=cat, month=month, amount=round(amount, 2),
                              prior_actual=round(amount, 2)))
        else:
            line.prior_actual = round(amount, 2)
    await db.flush()
    return len(prior)


async def create_budget(db: AsyncSession, data: BudgetIn, actor: CurrentUser) -> Budget:
    await _require_property(db, data.property_id)
    if await db.scalar(select(Budget.id).where(Budget.property_id == data.property_id, Budget.fiscal_year == data.fiscal_year,
                                               Budget.deleted_at.is_(None))):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"A {data.fiscal_year} budget already exists for this property; create a new version instead")
    names = await property_names(db, {data.property_id})
    b = Budget(property_id=data.property_id, asset_id=await asset_for_property(db, data.property_id),
               fiscal_year=data.fiscal_year, version=1, kind="original", status="draft", notes=data.notes,
               name=data.name or f"{names.get(data.property_id, 'Property')} FY{data.fiscal_year} budget",
               created_by_id=actor.id, updated_by_id=actor.id)
    db.add(b)
    await db.flush()
    loaded = await _load_prior(db, b) if data.load_prior_actuals else 0
    await _record(db, actor, "budget.created", "budget", b.id, summary=b.name, changes={"prior_actual_cells": loaded})
    await db.commit()
    return b


async def load_prior_actuals(db: AsyncSession, b: Budget, actor: CurrentUser) -> Budget:
    if b.status != "draft":
        raise _422("Only draft budgets can be edited")
    loaded = await _load_prior(db, b)
    if not loaded:
        raise _422("No prior-year actuals are available for this asset")
    await _record(db, actor, "budget.prior_actuals_loaded", "budget", b.id, changes={"cells": loaded})
    await db.commit()
    return b


async def save_lines(db: AsyncSession, b: Budget, data: LinesIn, actor: CurrentUser) -> Budget:
    if b.status != "draft":
        raise _422("Approved and submitted budgets are locked; create a new version to change them")
    existing = {(l.account, l.month): l for l in await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == b.id))}
    changed = 0
    for cell in data.cells:
        account = cell.account.strip()
        line = existing.get((account, cell.month))
        if line is None:
            line = BudgetLine(budget_id=b.id, account=account, category=cell.category, month=cell.month, amount=0)
            db.add(line)
            existing[(account, cell.month)] = line
        line.category = cell.category
        if cell.amount is not None and line.amount != cell.amount:
            line.amount = cell.amount
            changed += 1
        if "reforecast_amount" in cell.model_fields_set and line.reforecast_amount != cell.reforecast_amount:
            line.reforecast_amount = cell.reforecast_amount
            changed += 1
    if data.remove_accounts:
        await db.execute(delete(BudgetLine).where(BudgetLine.budget_id == b.id, BudgetLine.account.in_(data.remove_accounts)))
    b.updated_by_id = actor.id
    await _record(db, actor, "budget.lines_updated", "budget", b.id,
                  changes={"cells_changed": changed, "accounts_removed": data.remove_accounts or None})
    await db.commit()
    return b


async def submit_budget(db: AsyncSession, b: Budget, actor: CurrentUser) -> Budget:
    if b.status != "draft":
        raise _422("Only draft budgets can be submitted")
    if not await db.scalar(select(func.count()).where(BudgetLine.budget_id == b.id)):
        raise _422("Add budget lines before submitting")
    b.status, b.submitted_at = "submitted", utcnow()
    await _record(db, actor, "budget.submitted", "budget", b.id, changes={"status": {"from": "draft", "to": "submitted"}})
    await db.commit()
    return b


async def decide_budget_approval(db: AsyncSession, b: Budget, decision: str, note: str | None, actor: CurrentUser) -> Budget:
    if b.status != "submitted":
        raise _422("Submit the budget before approval")
    if decision == "approved":
        for prev in await db.scalars(select(Budget).where(
                Budget.property_id == b.property_id, Budget.fiscal_year == b.fiscal_year, Budget.id != b.id,
                Budget.status == "approved", Budget.deleted_at.is_(None))):
            prev.status, prev.superseded_at = "superseded", utcnow()
            await _record(db, actor, "budget.superseded", "budget", prev.id, summary=f"by v{b.version}")
        b.status, b.approved_by_id, b.approved_at, b.approval_note = "approved", actor.id, utcnow(), note
    else:
        if not (note or "").strip():
            raise _422("A note is required when returning a budget")
        b.status, b.approval_note = "draft", note
    await _record(db, actor, f"budget.{decision}", "budget", b.id, summary=note,
                  changes={"status": {"from": "submitted", "to": b.status}})
    await db.commit()
    return b


async def new_version(db: AsyncSession, src: Budget, kind: str, name: str | None, actor: CurrentUser) -> Budget:
    if await db.scalar(select(Budget.id).where(Budget.property_id == src.property_id, Budget.fiscal_year == src.fiscal_year,
                                               Budget.status.in_(["draft", "submitted"]), Budget.deleted_at.is_(None))):
        raise _422("A draft or submitted version already exists for this year")
    version = int(await db.scalar(select(func.max(Budget.version)).where(
        Budget.property_id == src.property_id, Budget.fiscal_year == src.fiscal_year)) or 0) + 1
    b = Budget(property_id=src.property_id, asset_id=src.asset_id, fiscal_year=src.fiscal_year, version=version, kind=kind,
               name=name or f"{src.name.split(' v')[0]} v{version}{' reforecast' if kind == 'reforecast' else ''}",
               status="draft", parent_budget_id=src.id, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(b)
    await db.flush()
    for line in await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == src.id)):
        db.add(BudgetLine(budget_id=b.id, account=line.account, category=line.category, month=line.month,
                          amount=line.amount, reforecast_amount=line.reforecast_amount, prior_actual=line.prior_actual,
                          notes=line.notes))
    await _record(db, actor, "budget.version_created", "budget", b.id, summary=f"v{version} from v{src.version}",
                  changes={"kind": kind, "parent_budget_id": src.id})
    await db.commit()
    return b


async def archive_budget(db: AsyncSession, b: Budget, actor: CurrentUser) -> None:
    if b.status in ("approved", "superseded"):
        raise _422("Approved budget versions are retained")
    b.deleted_at = utcnow()
    await _record(db, actor, "budget.archived", "budget", b.id, summary=b.name)
    await db.commit()
