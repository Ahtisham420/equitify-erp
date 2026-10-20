import csv
import io
import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.common import audit
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.operations import service
from app.modules.operations.models import (
    BID_STATUSES,
    BUDGET_CATEGORIES,
    BUDGET_STATUSES,
    CERTIFICATE_STATUSES,
    CHANGE_ORDER_STATUSES,
    CLAIM_STATUSES,
    COVERAGE_TYPES,
    CREDENTIAL_KINDS,
    DRAW_STATUSES,
    PAYMENT_STATUSES,
    POLICY_STATUSES,
    PROJECT_STATUSES,
    PROTEST_STATUSES,
    VENDOR_STATUSES,
    Budget,
    CapitalProject,
    InsuranceCertificate,
    InsuranceClaim,
    InsurancePolicy,
    TaxAssessment,
    TaxPayment,
    TaxProtest,
    Vendor,
)
from app.modules.operations.schemas import (
    AssessmentIn,
    AssessmentOut,
    AwardIn,
    BidIn,
    BidOut,
    BidStatusIn,
    BudgetIn,
    BudgetListItem,
    BudgetOut,
    BudgetRevisionIn,
    CertificateIn,
    CertificateOut,
    ChangeOrderIn,
    ChangeOrderOut,
    ClaimIn,
    ClaimOut,
    ClaimStatusIn,
    ComplianceOut,
    CredentialIn,
    CredentialOut,
    DecisionIn,
    DrawIn,
    DrawOut,
    DrawPayIn,
    DrawUpdate,
    HearingResultIn,
    LinesIn,
    NewVersionIn,
    PaymentConfirmIn,
    PaymentIn,
    PaymentOut,
    PolicyIn,
    PolicyOut,
    ProjectFacets,
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
    ScanOut,
    TaxSummaryOut,
    VendorFacets,
    VendorIn,
    VendorListItem,
    VendorOut,
    VendorUpdate,
)
from app.modules.operations.service import ProjectFilters, VendorFilters

router = APIRouter(tags=["operations"])

VIEW = require("operations", "view")
CREATE = require("operations", "create")
EDIT = require("operations", "edit")
APPROVE = require("operations", "approve")
DELETE = require("operations", "delete")


def _facet_dict(values: dict[str, int]) -> dict[str, int]:
    return dict(sorted(values.items(), key=lambda kv: -kv[1]))


# ======================================================================= meta / scan

@router.get("/operations/meta")
async def meta(_: CurrentUser = Depends(VIEW)):
    return {
        "vendor_statuses": VENDOR_STATUSES, "credential_kinds": CREDENTIAL_KINDS, "project_statuses": PROJECT_STATUSES,
        "bid_statuses": BID_STATUSES, "draw_statuses": DRAW_STATUSES, "change_order_statuses": CHANGE_ORDER_STATUSES,
        "coverage_types": COVERAGE_TYPES, "policy_statuses": POLICY_STATUSES,
        "certificate_statuses": CERTIFICATE_STATUSES, "claim_statuses": CLAIM_STATUSES,
        "protest_statuses": PROTEST_STATUSES, "payment_statuses": PAYMENT_STATUSES,
        "budget_statuses": BUDGET_STATUSES, "budget_categories": BUDGET_CATEGORIES,
    }


@router.post("/operations/scan", response_model=ScanOut)
async def scan(db: DB, user: CurrentUser = Depends(EDIT)):
    """Credential / policy / certificate expirations, protest deadlines and tax payments → idempotent alerts."""
    return await service.run_scan(db, user)


# ======================================================================= vendors

VENDOR_SORTS = {"name": Vendor.name, "status": Vendor.status, "performance_rating": Vendor.performance_rating,
                "updated_at": Vendor.updated_at, "created_at": Vendor.created_at}


def vendor_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    services: list[str] | None = Query(None),
    compliance: str | None = Query(None, pattern="^(compliant|non_compliant)$"),
    tag: list[str] | None = Query(None),
) -> VendorFilters:
    return VendorFilters(**locals())


async def _vendor_stmt(db, f: VendorFilters, skip: set[str] = frozenset()):
    stmt = service.vendor_query(f, skip=skip)
    if f.compliance:
        bad = await service.non_compliant_ids(db)
        stmt = stmt.where(Vendor.id.in_(bad) if f.compliance == "non_compliant" else Vendor.id.not_in(bad))
    return stmt


@router.get("/vendors", response_model=Page[VendorListItem])
async def list_vendors(db: DB, params: ListParams = Depends(), f: VendorFilters = Depends(vendor_filters),
                       _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(await _vendor_stmt(db, f), params.sort, VENDOR_SORTS, Vendor.name.asc())
    rows, total = await paginate(db, stmt, params)
    return Page[VendorListItem](items=await service.vendor_items(db, rows), total=total, page=params.page,
                                page_size=params.page_size)


@router.get("/vendors/facets", response_model=VendorFacets)
async def vendor_facets(db: DB, f: VendorFilters = Depends(vendor_filters), _: CurrentUser = Depends(VIEW)):
    services: dict[str, int] = {}
    for v in await db.scalars(await _vendor_stmt(db, f, {"services"})):
        for s in v.services or []:
            services[s] = services.get(s, 0) + 1
    return VendorFacets(status=await facet_counts(db, await _vendor_stmt(db, f, {"status"}), Vendor.status),
                        services=_facet_dict(services))


@router.get("/vendors/export")
async def export_vendors(db: DB, params: ListParams = Depends(), f: VendorFilters = Depends(vendor_filters),
                         user: CurrentUser = Depends(require("operations", "export"))):
    stmt = apply_sort(await _vendor_stmt(db, f), params.sort, VENDOR_SORTS, Vendor.name.asc()).limit(20_000)
    items = await service.vendor_items(db, list(await db.scalars(stmt)))
    cols = ["name", "status", "services", "primary_contact_name", "email", "phone", "performance_rating", "compliant",
            "compliance_reasons", "next_expiry_on", "spend_ytd"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in items:
        w.writerow(["; ".join(v) if isinstance(v := getattr(r, c), list) else v for c in cols])
    await audit.record(db, actor=user, action="vendor.exported", entity_type="vendor", summary=f"{len(items)} rows",
                       ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=vendors.csv"})


@router.post("/vendors", response_model=VendorOut, status_code=201)
async def create_vendor(body: VendorIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return await service.vendor_out(db, await service.create_vendor(db, body, user))


@router.get("/vendors/{vendor_id}", response_model=VendorOut)
async def get_vendor(vendor_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.vendor_out(db, await service.get_vendor(db, vendor_id))


@router.patch("/vendors/{vendor_id}", response_model=VendorOut)
async def update_vendor(vendor_id: uuid.UUID, body: VendorUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.vendor_out(db, await service.update_vendor(db, await service.get_vendor(db, vendor_id), body, user))


@router.delete("/vendors/{vendor_id}", status_code=204)
async def archive_vendor(vendor_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_vendor(db, await service.get_vendor(db, vendor_id), user)


@router.get("/vendors/{vendor_id}/compliance", response_model=ComplianceOut)
async def vendor_compliance(vendor_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    ok, reasons = await service.vendor_is_compliant(db, vendor_id)
    return ComplianceOut(compliant=ok, reasons=reasons)


@router.post("/vendors/{vendor_id}/credentials", response_model=CredentialOut, status_code=201)
async def add_credential(vendor_id: uuid.UUID, body: CredentialIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.save_credential(db, await service.get_vendor(db, vendor_id), body, user)
    return service.credential_out(c)


@router.put("/vendor-credentials/{cred_id}", response_model=CredentialOut)
async def update_credential(cred_id: uuid.UUID, body: CredentialIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.get_credential(db, cred_id)
    c = await service.save_credential(db, await service.get_vendor(db, c.vendor_id), body, user, c)
    return service.credential_out(c)


@router.delete("/vendor-credentials/{cred_id}", status_code=204)
async def remove_credential(cred_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    await service.archive_credential(db, await service.get_credential(db, cred_id), user)


@router.post("/vendors/{vendor_id}/reviews", response_model=ReviewOut, status_code=201)
async def add_review(vendor_id: uuid.UUID, body: ReviewIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.add_review(db, await service.get_vendor(db, vendor_id), body, user)


# ======================================================================= capital projects

PROJECT_SORTS = {"name": CapitalProject.name, "status": CapitalProject.status, "current_budget": CapitalProject.current_budget,
                 "contract_amount": CapitalProject.contract_amount, "target_completion_on": CapitalProject.target_completion_on,
                 "start_on": CapitalProject.start_on, "updated_at": CapitalProject.updated_at}


def project_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    category: list[str] | None = Query(None),
    property_id: uuid.UUID | None = None,
    asset_id: uuid.UUID | None = None,
    contractor_vendor_id: uuid.UUID | None = None,
    manager_id: uuid.UUID | None = None,
    min_budget: float | None = None,
    max_budget: float | None = None,
) -> ProjectFilters:
    return ProjectFilters(**locals())


@router.get("/capital-projects", response_model=Page[ProjectListItem])
async def list_projects(db: DB, params: ListParams = Depends(), f: ProjectFilters = Depends(project_filters),
                        _: CurrentUser = Depends(VIEW)):
    stmt = apply_sort(service.project_query(f), params.sort, PROJECT_SORTS, CapitalProject.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[ProjectListItem](items=await service.project_items(db, rows), total=total, page=params.page,
                                 page_size=params.page_size)


@router.get("/capital-projects/facets", response_model=ProjectFacets)
async def project_facets(db: DB, f: ProjectFilters = Depends(project_filters), _: CurrentUser = Depends(VIEW)):
    return ProjectFacets(
        status=await facet_counts(db, service.project_query(f, skip={"status"}), CapitalProject.status),
        category=await facet_counts(db, service.project_query(f, skip={"category"}), CapitalProject.category),
    )


@router.post("/capital-projects", response_model=ProjectOut, status_code=201)
async def create_project(body: ProjectIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return await service.project_out(db, await service.create_project(db, body, user))


@router.get("/capital-projects/{project_id}", response_model=ProjectOut)
async def get_project(project_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.project_out(db, await service.get_project(db, project_id))


@router.patch("/capital-projects/{project_id}", response_model=ProjectOut)
async def update_project(project_id: uuid.UUID, body: ProjectUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    p = await service.update_project(db, await service.get_project(db, project_id), body, user)
    return await service.project_out(db, p)


@router.delete("/capital-projects/{project_id}", status_code=204)
async def archive_project(project_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_project(db, await service.get_project(db, project_id), user)


@router.post("/capital-projects/{project_id}/status", response_model=ProjectOut)
async def project_status(project_id: uuid.UUID, body: ProjectStatusIn, db: DB, user: CurrentUser = Depends(EDIT)):
    p = await service.set_project_status(db, await service.get_project(db, project_id), body, user)
    return await service.project_out(db, p)


@router.post("/capital-projects/{project_id}/budget-approval", response_model=ProjectOut)
async def budget_approval(project_id: uuid.UUID, body: DecisionIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    p = await service.decide_budget(db, await service.get_project(db, project_id), body.decision, body.note, user)
    return await service.project_out(db, p)


@router.post("/capital-projects/{project_id}/budget-revisions", response_model=ProjectOut)
async def budget_revision(project_id: uuid.UUID, body: BudgetRevisionIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    p = await service.revise_budget(db, await service.get_project(db, project_id), body.new_budget, body.reason, user)
    return await service.project_out(db, p)


@router.post("/capital-projects/{project_id}/bids", response_model=BidOut, status_code=201)
async def add_bid(project_id: uuid.UUID, body: BidIn, db: DB, user: CurrentUser = Depends(EDIT)):
    b = await service.add_bid(db, await service.get_project(db, project_id), body, user)
    return (await service.bid_items(db, [b]))[0]


@router.post("/project-bids/{bid_id}/status", response_model=BidOut)
async def bid_status(bid_id: uuid.UUID, body: BidStatusIn, db: DB, user: CurrentUser = Depends(EDIT)):
    b = await service.set_bid_status(db, await service.get_bid(db, bid_id), body.status, body.note, user)
    return (await service.bid_items(db, [b]))[0]


@router.post("/project-bids/{bid_id}/award", response_model=ProjectOut)
async def award_bid(bid_id: uuid.UUID, body: AwardIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    p = await service.award_bid(db, await service.get_bid(db, bid_id), body.note, user)
    return await service.project_out(db, p)


@router.post("/capital-projects/{project_id}/change-orders", response_model=ChangeOrderOut, status_code=201)
async def add_change_order(project_id: uuid.UUID, body: ChangeOrderIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.add_change_order(db, await service.get_project(db, project_id), body, user)


@router.post("/change-orders/{co_id}/decision", response_model=ChangeOrderOut)
async def decide_change_order(co_id: uuid.UUID, body: DecisionIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.decide_change_order(db, await service.get_change_order(db, co_id), body.decision, body.note, user)


@router.post("/capital-projects/{project_id}/draws", response_model=DrawOut, status_code=201)
async def add_draw(project_id: uuid.UUID, body: DrawIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.add_draw(db, await service.get_project(db, project_id), body, user)


@router.patch("/project-draws/{draw_id}", response_model=DrawOut)
async def update_draw(draw_id: uuid.UUID, body: DrawUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.update_draw(db, await service.get_draw(db, draw_id), body, user)


@router.post("/project-draws/{draw_id}/decision", response_model=DrawOut)
async def decide_draw(draw_id: uuid.UUID, body: DecisionIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.decide_draw(db, await service.get_draw(db, draw_id), body.decision, body.note, user)


@router.post("/project-draws/{draw_id}/pay", response_model=DrawOut)
async def pay_draw(draw_id: uuid.UUID, body: DrawPayIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    return await service.pay_draw(db, await service.get_draw(db, draw_id), body.paid_on, body.payment_reference, user)


@router.post("/capital-projects/{project_id}/recoverability", response_model=ProjectOut)
async def recoverability(project_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    p = await service.analyze_recoverability(db, await service.get_project(db, project_id), user)
    return await service.project_out(db, p)


# ======================================================================= insurance: policies

POLICY_SORTS = {"expires_on": InsurancePolicy.expires_on, "effective_on": InsurancePolicy.effective_on,
                "carrier": InsurancePolicy.carrier, "premium": InsurancePolicy.premium,
                "limit_amount": InsurancePolicy.limit_amount, "coverage_type": InsurancePolicy.coverage_type,
                "updated_at": InsurancePolicy.updated_at}


@router.get("/insurance/policies", response_model=Page[PolicyOut])
async def list_policies(db: DB, params: ListParams = Depends(), coverage_type: list[str] | None = Query(None),
                        status: list[str] | None = Query(None), property_id: uuid.UUID | None = None,
                        expiring_within_days: int | None = Query(None, ge=0), _: CurrentUser = Depends(VIEW)):
    stmt = service.policy_query(params.q, coverage_type, status, property_id, expiring_within_days)
    rows, total = await paginate(db, apply_sort(stmt, params.sort, POLICY_SORTS, InsurancePolicy.expires_on.asc()), params)
    return Page[PolicyOut](items=await service.policy_items(db, rows), total=total, page=params.page,
                           page_size=params.page_size)


@router.get("/insurance/policies/facets")
async def policy_facets(db: DB, q: str | None = None, coverage_type: list[str] | None = Query(None),
                        status: list[str] | None = Query(None), property_id: uuid.UUID | None = None,
                        expiring_within_days: int | None = None, _: CurrentUser = Depends(VIEW)) -> dict[str, dict[str, int]]:
    args = (q, coverage_type, status, property_id, expiring_within_days)
    return {
        "coverage_type": await facet_counts(db, service.policy_query(*args, skip={"coverage_type"}), InsurancePolicy.coverage_type),
        "status": await facet_counts(db, service.policy_query(*args, skip={"status"}), InsurancePolicy.status),
    }


@router.post("/insurance/policies", response_model=PolicyOut, status_code=201)
async def create_policy(body: PolicyIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.policy_items(db, [await service.save_policy(db, body, user)]))[0]


@router.get("/insurance/policies/{policy_id}", response_model=PolicyOut)
async def get_policy(policy_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return (await service.policy_items(db, [await service.get_policy(db, policy_id)]))[0]


@router.put("/insurance/policies/{policy_id}", response_model=PolicyOut)
async def update_policy(policy_id: uuid.UUID, body: PolicyIn, db: DB, user: CurrentUser = Depends(EDIT)):
    p = await service.save_policy(db, body, user, await service.get_policy(db, policy_id))
    return (await service.policy_items(db, [p]))[0]


@router.delete("/insurance/policies/{policy_id}", status_code=204)
async def archive_policy(policy_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_policy(db, await service.get_policy(db, policy_id), user)


# ======================================================================= insurance: certificates

CERT_SORTS = {"expires_on": InsuranceCertificate.expires_on, "status": InsuranceCertificate.status,
              "tenant_name": InsuranceCertificate.tenant_name, "updated_at": InsuranceCertificate.updated_at}


@router.get("/insurance/certificates", response_model=Page[CertificateOut])
async def list_certificates(db: DB, params: ListParams = Depends(), holder_kind: list[str] | None = Query(None),
                            status: list[str] | None = Query(None), property_id: uuid.UUID | None = None,
                            vendor_id: uuid.UUID | None = None, _: CurrentUser = Depends(VIEW)):
    stmt = service.certificate_query(params.q, holder_kind, status, property_id, vendor_id)
    rows, total = await paginate(db, apply_sort(stmt, params.sort, CERT_SORTS, InsuranceCertificate.expires_on.asc()), params)
    return Page[CertificateOut](items=await service.certificate_items(db, rows), total=total, page=params.page,
                                page_size=params.page_size)


@router.get("/insurance/certificates/facets")
async def certificate_facets(db: DB, q: str | None = None, holder_kind: list[str] | None = Query(None),
                             status: list[str] | None = Query(None), property_id: uuid.UUID | None = None,
                             vendor_id: uuid.UUID | None = None, _: CurrentUser = Depends(VIEW)) -> dict[str, dict[str, int]]:
    args = (q, holder_kind, status, property_id, vendor_id)
    return {
        "holder_kind": await facet_counts(db, service.certificate_query(*args, skip={"holder_kind"}), InsuranceCertificate.holder_kind),
        "status": await facet_counts(db, service.certificate_query(*args, skip={"status"}), InsuranceCertificate.status),
    }


@router.post("/insurance/certificates", response_model=CertificateOut, status_code=201)
async def create_certificate(body: CertificateIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.certificate_items(db, [await service.save_certificate(db, body, user)]))[0]


@router.put("/insurance/certificates/{cert_id}", response_model=CertificateOut)
async def update_certificate(cert_id: uuid.UUID, body: CertificateIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.save_certificate(db, body, user, await service.get_certificate(db, cert_id))
    return (await service.certificate_items(db, [c]))[0]


@router.delete("/insurance/certificates/{cert_id}", status_code=204)
async def archive_certificate(cert_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_certificate(db, await service.get_certificate(db, cert_id), user)


# ======================================================================= insurance: claims

CLAIM_SORTS = {"incident_on": InsuranceClaim.incident_on, "status": InsuranceClaim.status,
               "claimed_amount": InsuranceClaim.claimed_amount, "paid_amount": InsuranceClaim.paid_amount,
               "updated_at": InsuranceClaim.updated_at}


@router.get("/insurance/claims", response_model=Page[ClaimOut])
async def list_claims(db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
                      property_id: uuid.UUID | None = None, policy_id: uuid.UUID | None = None,
                      _: CurrentUser = Depends(VIEW)):
    stmt = service.claim_query(params.q, status, property_id, policy_id)
    rows, total = await paginate(db, apply_sort(stmt, params.sort, CLAIM_SORTS, InsuranceClaim.incident_on.desc()), params)
    return Page[ClaimOut](items=await service.claim_items(db, rows), total=total, page=params.page,
                          page_size=params.page_size)


@router.get("/insurance/claims/facets")
async def claim_facets(db: DB, q: str | None = None, status: list[str] | None = Query(None),
                       property_id: uuid.UUID | None = None, policy_id: uuid.UUID | None = None,
                       _: CurrentUser = Depends(VIEW)) -> dict[str, dict[str, int]]:
    return {"status": await facet_counts(db, service.claim_query(q, status, property_id, policy_id, skip={"status"}),
                                         InsuranceClaim.status)}


@router.post("/insurance/claims", response_model=ClaimOut, status_code=201)
async def create_claim(body: ClaimIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.claim_items(db, [await service.save_claim(db, body, user)]))[0]


@router.put("/insurance/claims/{claim_id}", response_model=ClaimOut)
async def update_claim(claim_id: uuid.UUID, body: ClaimIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.save_claim(db, body, user, await service.get_claim(db, claim_id))
    return (await service.claim_items(db, [c]))[0]


@router.post("/insurance/claims/{claim_id}/status", response_model=ClaimOut)
async def claim_status(claim_id: uuid.UUID, body: ClaimStatusIn, db: DB, user: CurrentUser = Depends(EDIT)):
    c = await service.set_claim_status(db, await service.get_claim(db, claim_id), body.status, body.note,
                                       body.paid_amount, user)
    return (await service.claim_items(db, [c]))[0]


# ======================================================================= property tax

@router.get("/tax/assessments", response_model=Page[AssessmentOut])
async def list_assessments(db: DB, params: ListParams = Depends(), property_id: uuid.UUID | None = None,
                           tax_year: list[int] | None = Query(None), _: CurrentUser = Depends(VIEW)):
    stmt = select(TaxAssessment).where(TaxAssessment.deleted_at.is_(None))
    if params.q:
        stmt = stmt.where(TaxAssessment.jurisdiction.ilike(f"%{params.q}%") | TaxAssessment.account_number.ilike(f"%{params.q}%"))
    if property_id:
        stmt = stmt.where(TaxAssessment.property_id == property_id)
    if tax_year:
        stmt = stmt.where(TaxAssessment.tax_year.in_(tax_year))
    sorts = {"tax_year": TaxAssessment.tax_year, "assessed_total": TaxAssessment.assessed_total,
             "protest_deadline_on": TaxAssessment.protest_deadline_on, "updated_at": TaxAssessment.updated_at}
    rows, total = await paginate(db, apply_sort(stmt, params.sort, sorts, TaxAssessment.tax_year.desc()), params)
    return Page[AssessmentOut](items=await service.assessment_items(db, rows), total=total, page=params.page,
                               page_size=params.page_size)


@router.post("/tax/assessments", response_model=AssessmentOut, status_code=201)
async def create_assessment(body: AssessmentIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.assessment_items(db, [await service.save_assessment(db, body, user)]))[0]


@router.put("/tax/assessments/{assessment_id}", response_model=AssessmentOut)
async def update_assessment(assessment_id: uuid.UUID, body: AssessmentIn, db: DB, user: CurrentUser = Depends(EDIT)):
    a = await service.save_assessment(db, body, user, await service.get_assessment(db, assessment_id))
    return (await service.assessment_items(db, [a]))[0]


@router.delete("/tax/assessments/{assessment_id}", status_code=204)
async def archive_assessment(assessment_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_assessment(db, await service.get_assessment(db, assessment_id), user)


@router.get("/tax/protests", response_model=Page[ProtestOut])
async def list_protests(db: DB, params: ListParams = Depends(), property_id: uuid.UUID | None = None,
                        status: list[str] | None = Query(None), tax_year: list[int] | None = Query(None),
                        _: CurrentUser = Depends(VIEW)):
    stmt = select(TaxProtest).where(TaxProtest.deleted_at.is_(None))
    if params.q:
        stmt = stmt.where(TaxProtest.consultant_name.ilike(f"%{params.q}%") | TaxProtest.notes.ilike(f"%{params.q}%"))
    if property_id:
        stmt = stmt.where(TaxProtest.property_id == property_id)
    if status:
        stmt = stmt.where(TaxProtest.status.in_(status))
    if tax_year:
        stmt = stmt.where(TaxProtest.tax_year.in_(tax_year))
    sorts = {"tax_year": TaxProtest.tax_year, "deadline_on": TaxProtest.deadline_on, "hearing_on": TaxProtest.hearing_on,
             "net_savings": TaxProtest.net_savings, "updated_at": TaxProtest.updated_at}
    rows, total = await paginate(db, apply_sort(stmt, params.sort, sorts, TaxProtest.tax_year.desc()), params)
    return Page[ProtestOut](items=await service.protest_items(db, rows), total=total, page=params.page,
                            page_size=params.page_size)


@router.get("/tax/summary", response_model=TaxSummaryOut)
async def tax_summary(db: DB, property_id: uuid.UUID | None = None, tax_year: int | None = None,
                      _: CurrentUser = Depends(VIEW)):
    return await service.tax_summary(db, property_id, tax_year)


@router.post("/tax/protests", response_model=ProtestOut, status_code=201)
async def create_protest(body: ProtestIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.protest_items(db, [await service.create_protest(db, body, user)]))[0]


@router.patch("/tax/protests/{protest_id}", response_model=ProtestOut)
async def update_protest(protest_id: uuid.UUID, body: ProtestUpdate, db: DB, user: CurrentUser = Depends(EDIT)):
    p = await service.update_protest(db, await service.get_protest(db, protest_id), body, user)
    return (await service.protest_items(db, [p]))[0]


@router.post("/tax/protests/{protest_id}/hearing", response_model=ProtestOut)
async def record_hearing(protest_id: uuid.UUID, body: HearingResultIn, db: DB, user: CurrentUser = Depends(EDIT)):
    p = await service.record_hearing(db, await service.get_protest(db, protest_id), body, user)
    return (await service.protest_items(db, [p]))[0]


@router.get("/tax/payments", response_model=Page[PaymentOut])
async def list_payments(db: DB, params: ListParams = Depends(), property_id: uuid.UUID | None = None,
                        status: list[str] | None = Query(None), tax_year: list[int] | None = Query(None),
                        _: CurrentUser = Depends(VIEW)):
    stmt = select(TaxPayment).where(TaxPayment.deleted_at.is_(None))
    if params.q:
        stmt = stmt.where(TaxPayment.confirmation_number.ilike(f"%{params.q}%") | TaxPayment.installment.ilike(f"%{params.q}%"))
    if property_id:
        stmt = stmt.where(TaxPayment.property_id == property_id)
    if status:
        stmt = stmt.where(TaxPayment.status.in_(status))
    if tax_year:
        stmt = stmt.where(TaxPayment.tax_year.in_(tax_year))
    sorts = {"due_on": TaxPayment.due_on, "amount_due": TaxPayment.amount_due, "status": TaxPayment.status,
             "tax_year": TaxPayment.tax_year}
    rows, total = await paginate(db, apply_sort(stmt, params.sort, sorts, TaxPayment.due_on.desc()), params)
    return Page[PaymentOut](items=await service.payment_items(db, rows), total=total, page=params.page,
                            page_size=params.page_size)


@router.post("/tax/payments", response_model=PaymentOut, status_code=201)
async def create_payment(body: PaymentIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return (await service.payment_items(db, [await service.create_payment(db, body, user)]))[0]


@router.post("/tax/payments/{payment_id}/confirm", response_model=PaymentOut)
async def confirm_payment(payment_id: uuid.UUID, body: PaymentConfirmIn, db: DB, user: CurrentUser = Depends(EDIT)):
    p = await service.confirm_payment(db, await service.get_payment(db, payment_id), body, user)
    return (await service.payment_items(db, [p]))[0]


@router.delete("/tax/payments/{payment_id}", status_code=204)
async def archive_payment(payment_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_payment(db, await service.get_payment(db, payment_id), user)


# ======================================================================= budgets

BUDGET_SORTS = {"fiscal_year": Budget.fiscal_year, "name": Budget.name, "status": Budget.status,
                "version": Budget.version, "updated_at": Budget.updated_at}


@router.get("/budgets", response_model=Page[BudgetListItem])
async def list_budgets(db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
                       fiscal_year: list[int] | None = Query(None), property_id: uuid.UUID | None = None,
                       asset_id: uuid.UUID | None = None, current_only: bool | None = None,
                       _: CurrentUser = Depends(VIEW)):
    stmt = service.budget_query(params.q, status, fiscal_year, property_id, asset_id, current_only)
    stmt = apply_sort(stmt, params.sort, BUDGET_SORTS, Budget.fiscal_year.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[BudgetListItem](items=await service.budget_items(db, rows), total=total, page=params.page,
                                page_size=params.page_size)


@router.get("/budgets/facets")
async def budget_facets(db: DB, q: str | None = None, status: list[str] | None = Query(None),
                        fiscal_year: list[int] | None = Query(None), property_id: uuid.UUID | None = None,
                        asset_id: uuid.UUID | None = None, current_only: bool | None = None,
                        _: CurrentUser = Depends(VIEW)) -> dict[str, dict[str, int]]:
    args = (q, status, fiscal_year, property_id, asset_id, current_only)
    return {
        "status": await facet_counts(db, service.budget_query(*args, skip={"status"}), Budget.status),
        "fiscal_year": await facet_counts(db, service.budget_query(*args, skip={"fiscal_year"}), Budget.fiscal_year),
    }


@router.post("/budgets", response_model=BudgetOut, status_code=201)
async def create_budget(body: BudgetIn, db: DB, user: CurrentUser = Depends(CREATE)):
    return await service.budget_out(db, await service.create_budget(db, body, user))


@router.get("/budgets/{budget_id}", response_model=BudgetOut)
async def get_budget(budget_id: uuid.UUID, db: DB, _: CurrentUser = Depends(VIEW)):
    return await service.budget_out(db, await service.get_budget(db, budget_id))


@router.put("/budgets/{budget_id}/lines", response_model=BudgetOut)
async def save_lines(budget_id: uuid.UUID, body: LinesIn, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.budget_out(db, await service.save_lines(db, await service.get_budget(db, budget_id), body, user))


@router.post("/budgets/{budget_id}/load-prior-actuals", response_model=BudgetOut)
async def load_prior(budget_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.budget_out(db, await service.load_prior_actuals(db, await service.get_budget(db, budget_id), user))


@router.post("/budgets/{budget_id}/submit", response_model=BudgetOut)
async def submit_budget(budget_id: uuid.UUID, db: DB, user: CurrentUser = Depends(EDIT)):
    return await service.budget_out(db, await service.submit_budget(db, await service.get_budget(db, budget_id), user))


@router.post("/budgets/{budget_id}/approval", response_model=BudgetOut)
async def approve_budget(budget_id: uuid.UUID, body: DecisionIn, db: DB, user: CurrentUser = Depends(APPROVE)):
    b = await service.decide_budget_approval(db, await service.get_budget(db, budget_id), body.decision, body.note, user)
    return await service.budget_out(db, b)


@router.post("/budgets/{budget_id}/versions", response_model=BudgetOut, status_code=201)
async def new_version(budget_id: uuid.UUID, body: NewVersionIn, db: DB, user: CurrentUser = Depends(CREATE)):
    b = await service.new_version(db, await service.get_budget(db, budget_id), body.kind, body.name, user)
    return await service.budget_out(db, b)


@router.delete("/budgets/{budget_id}", status_code=204)
async def archive_budget(budget_id: uuid.UUID, db: DB, user: CurrentUser = Depends(DELETE)):
    await service.archive_budget(db, await service.get_budget(db, budget_id), user)
