import { and, asc, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, csvResponse, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import {
  BID_STATUSES, BUDGET_CATEGORIES, BUDGET_STATUSES, budgets, CERTIFICATE_STATUSES, CHANGE_ORDER_STATUSES,
  CLAIM_STATUSES, COVERAGE_TYPES, CREDENTIAL_KINDS, DRAW_STATUSES, PAYMENT_STATUSES, POLICY_STATUSES,
  PROJECT_STATUSES, PROTEST_STATUSES, VENDOR_STATUSES, capitalProjects, insuranceCertificates, insuranceClaims,
  insurancePolicies, taxAssessments, taxPayments, taxProtests, vendors,
} from "./schema";
import {
  assessmentIn, awardIn, bidIn, bidStatusIn, budgetIn, budgetRevisionIn, certificateIn, changeOrderIn, claimIn,
  claimStatusIn, credentialIn, decisionIn, drawIn, drawPayIn, drawUpdate, hearingResultIn, linesIn, newVersionIn,
  paymentConfirmIn, paymentIn, policyIn, projectIn, projectStatusIn, projectUpdate, protestIn, protestUpdate, reviewIn,
  vendorIn, vendorUpdate,
} from "./schemas";
import * as service from "./service";
import type { ProjectFilters, VendorFilters } from "./service";

export const router = new Router();

const VIEW = (ctx: Ctx) => ctx.require("operations", "view");
const CREATE = (ctx: Ctx) => ctx.require("operations", "create");
const EDIT = (ctx: Ctx) => ctx.require("operations", "edit");
const APPROVE = (ctx: Ctx) => ctx.require("operations", "approve");
const DELETE = (ctx: Ctx) => ctx.require("operations", "delete");

const likeAny = (cols: any[], q: string) => or(...cols.map((c) => ilike(c, `%${q}%`)));

// ======================================================================= meta / scan

router.get("/operations/meta", async (ctx) => {
  await VIEW(ctx);
  return {
    vendor_statuses: VENDOR_STATUSES, credential_kinds: CREDENTIAL_KINDS, project_statuses: PROJECT_STATUSES,
    bid_statuses: BID_STATUSES, draw_statuses: DRAW_STATUSES, change_order_statuses: CHANGE_ORDER_STATUSES,
    coverage_types: COVERAGE_TYPES, policy_statuses: POLICY_STATUSES, certificate_statuses: CERTIFICATE_STATUSES,
    claim_statuses: CLAIM_STATUSES, protest_statuses: PROTEST_STATUSES, payment_statuses: PAYMENT_STATUSES,
    budget_statuses: BUDGET_STATUSES, budget_categories: BUDGET_CATEGORIES,
  };
});

/** Credential / policy / certificate expirations, protest deadlines and tax payments -> idempotent alerts. */
router.post("/operations/scan", async (ctx) => {
  const user = await EDIT(ctx);
  return service.runScan(ctx.db, user);
});

// ======================================================================= vendors

const VENDOR_SORTS = {
  name: vendors.name, status: vendors.status, performance_rating: vendors.performance_rating,
  updated_at: vendors.updated_at, created_at: vendors.created_at,
};

function vendorFilters(ctx: Ctx): VendorFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    services: q.strs("services"),
    compliance: q.str("compliance", { pattern: /^(compliant|non_compliant)$/ }),
    tag: q.strs("tag"),
  };
}

async function vendorWhere(ctx: Ctx, f: VendorFilters, skip: Set<string> = new Set()): Promise<SQL | undefined> {
  const where = service.vendorQuery(f, { skip });
  if (!f.compliance) return where;
  const bad = await service.nonCompliantIds(ctx.db);
  if (f.compliance === "non_compliant") return and(where, bad.length ? inArray(vendors.id, bad) : sql`false`);
  return and(where, bad.length ? notInArray(vendors.id, bad) : undefined);
}

router.get("/vendors", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const f = vendorFilters(ctx);
  const where = await vendorWhere(ctx, f);
  const [rows, total] = await paginate(ctx.db, vendors, where, applySort(p.sort, VENDOR_SORTS, asc(vendors.name)), p);
  return page(await service.vendorItems(ctx.db, rows), total, p);
});

router.get("/vendors/facets", async (ctx) => {
  await VIEW(ctx);
  const f = vendorFilters(ctx);
  const services: Record<string, number> = {};
  for (const v of await ctx.db.select().from(vendors).where(await vendorWhere(ctx, f, new Set(["services"])))) {
    for (const s of v.services ?? []) services[s] = (services[s] ?? 0) + 1;
  }
  return {
    status: await facetCounts(ctx.db, vendors, await vendorWhere(ctx, f, new Set(["status"])), vendors.status),
    services: Object.fromEntries(Object.entries(services).sort((a, b) => b[1] - a[1])),
  };
});

/** Python csv.writer cell formatting. */
const csvCell = (v: unknown) => {
  let s: string;
  if (v === null || v === undefined) s = "";
  else if (Array.isArray(v)) s = v.join("; ");
  else if (typeof v === "boolean") s = v ? "True" : "False";
  else s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get("/vendors/export", async (ctx) => {
  const user = await ctx.require("operations", "export");
  const p = ctx.listParams();
  const f = vendorFilters(ctx);
  const rows = await ctx.db.select().from(vendors).where(await vendorWhere(ctx, f))
    .orderBy(...applySort(p.sort, VENDOR_SORTS, asc(vendors.name))).limit(20_000);
  const items = await service.vendorItems(ctx.db, rows);
  const cols = [
    "name", "status", "services", "primary_contact_name", "email", "phone", "performance_rating", "compliant",
    "compliance_reasons", "next_expiry_on", "spend_ytd",
  ];
  const lines = [cols.join(","), ...items.map((r) => cols.map((c) => csvCell((r as Record<string, any>)[c])).join(","))];
  await audit.record(ctx.db, {
    actor: user, action: "vendor.exported", entity_type: "vendor", summary: `${items.length} rows`,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csvResponse(lines.join("\r\n") + "\r\n", "vendors.csv");
});

router.post("/vendors", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(vendorIn);
  return created(await service.vendorOut(ctx.db, await service.createVendor(ctx.db, body, user)));
});

router.get("/vendors/{vendor_id}", async (ctx) => {
  await VIEW(ctx);
  return service.vendorOut(ctx.db, await service.getVendor(ctx.db, ctx.uuid("vendor_id")));
});

router.patch("/vendors/{vendor_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(vendorUpdate);
  const v = await service.updateVendor(ctx.db, await service.getVendor(ctx.db, ctx.uuid("vendor_id")), body, user);
  return service.vendorOut(ctx.db, v);
});

router.delete("/vendors/{vendor_id}", async (ctx) => {
  const user = await DELETE(ctx);
  await service.archiveVendor(ctx.db, await service.getVendor(ctx.db, ctx.uuid("vendor_id")), user);
  return noContent();
});

router.get("/vendors/{vendor_id}/compliance", async (ctx) => {
  await VIEW(ctx);
  const [compliant, reasons] = await service.vendorIsCompliant(ctx.db, ctx.uuid("vendor_id"));
  return { compliant, reasons };
});

router.post("/vendors/{vendor_id}/credentials", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(credentialIn);
  const c = await service.saveCredential(ctx.db, await service.getVendor(ctx.db, ctx.uuid("vendor_id")), body, user);
  return created(service.credentialOut(c));
});

router.put("/vendor-credentials/{cred_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(credentialIn);
  const c = await service.getCredential(ctx.db, ctx.uuid("cred_id"));
  const saved = await service.saveCredential(ctx.db, await service.getVendor(ctx.db, c.vendor_id), body, user, c);
  return service.credentialOut(saved);
});

router.delete("/vendor-credentials/{cred_id}", async (ctx) => {
  const user = await EDIT(ctx);
  await service.archiveCredential(ctx.db, await service.getCredential(ctx.db, ctx.uuid("cred_id")), user);
  return noContent();
});

router.post("/vendors/{vendor_id}/reviews", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(reviewIn);
  return created(await service.addReview(ctx.db, await service.getVendor(ctx.db, ctx.uuid("vendor_id")), body, user));
});

// ======================================================================= capital projects

const PROJECT_SORTS = {
  name: capitalProjects.name, status: capitalProjects.status, current_budget: capitalProjects.current_budget,
  contract_amount: capitalProjects.contract_amount, target_completion_on: capitalProjects.target_completion_on,
  start_on: capitalProjects.start_on, updated_at: capitalProjects.updated_at,
};

function projectFilters(ctx: Ctx): ProjectFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    category: q.strs("category"),
    property_id: q.uuid("property_id"),
    asset_id: q.uuid("asset_id"),
    contractor_vendor_id: q.uuid("contractor_vendor_id"),
    manager_id: q.uuid("manager_id"),
    min_budget: q.num("min_budget"),
    max_budget: q.num("max_budget"),
  };
}

router.get("/capital-projects", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const where = service.projectQuery(projectFilters(ctx));
  const [rows, total] = await paginate(
    ctx.db, capitalProjects, where, applySort(p.sort, PROJECT_SORTS, desc(capitalProjects.updated_at)), p,
  );
  return page(await service.projectItems(ctx.db, rows), total, p);
});

router.get("/capital-projects/facets", async (ctx) => {
  await VIEW(ctx);
  const f = projectFilters(ctx);
  return {
    status: await facetCounts(ctx.db, capitalProjects, service.projectQuery(f, { skip: new Set(["status"]) }), capitalProjects.status),
    category: await facetCounts(ctx.db, capitalProjects, service.projectQuery(f, { skip: new Set(["category"]) }), capitalProjects.category),
  };
});

router.post("/capital-projects", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(projectIn);
  return created(await service.projectOut(ctx.db, await service.createProject(ctx.db, body, user)));
});

router.get("/capital-projects/{project_id}", async (ctx) => {
  await VIEW(ctx);
  return service.projectOut(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")));
});

router.patch("/capital-projects/{project_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(projectUpdate);
  const p = await service.updateProject(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), body, user);
  return service.projectOut(ctx.db, p);
});

router.delete("/capital-projects/{project_id}", async (ctx) => {
  const user = await DELETE(ctx);
  await service.archiveProject(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), user);
  return noContent();
});

router.post("/capital-projects/{project_id}/status", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(projectStatusIn);
  const p = await service.setProjectStatus(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), body, user);
  return service.projectOut(ctx.db, p);
});

router.post("/capital-projects/{project_id}/budget-approval", async (ctx) => {
  const user = await APPROVE(ctx);
  const body = await ctx.body(decisionIn);
  const p = await service.decideBudget(
    ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), body.decision, body.note, user,
  );
  return service.projectOut(ctx.db, p);
});

router.post("/capital-projects/{project_id}/budget-revisions", async (ctx) => {
  const user = await APPROVE(ctx);
  const body = await ctx.body(budgetRevisionIn);
  const p = await service.reviseBudget(
    ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), body.new_budget, body.reason, user,
  );
  return service.projectOut(ctx.db, p);
});

router.post("/capital-projects/{project_id}/bids", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(bidIn);
  const b = await service.addBid(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), body, user);
  return created((await service.bidItems(ctx.db, [b]))[0]);
});

router.post("/project-bids/{bid_id}/status", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(bidStatusIn);
  const b = await service.setBidStatus(ctx.db, await service.getBid(ctx.db, ctx.uuid("bid_id")), body.status, body.note, user);
  return (await service.bidItems(ctx.db, [b]))[0];
});

router.post("/project-bids/{bid_id}/award", async (ctx) => {
  const user = await APPROVE(ctx);
  const body = await ctx.body(awardIn);
  const p = await service.awardBid(ctx.db, await service.getBid(ctx.db, ctx.uuid("bid_id")), body.note, user);
  return service.projectOut(ctx.db, p);
});

router.post("/capital-projects/{project_id}/change-orders", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(changeOrderIn);
  const co = await service.addChangeOrder(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), body, user);
  return created(service.changeOrderOut(co));
});

router.post("/change-orders/{co_id}/decision", async (ctx) => {
  const user = await APPROVE(ctx);
  const body = await ctx.body(decisionIn);
  const co = await service.decideChangeOrder(
    ctx.db, await service.getChangeOrder(ctx.db, ctx.uuid("co_id")), body.decision, body.note, user,
  );
  return service.changeOrderOut(co);
});

router.post("/capital-projects/{project_id}/draws", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(drawIn);
  const d = await service.addDraw(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), body, user);
  return created(service.drawOut(d));
});

router.patch("/project-draws/{draw_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(drawUpdate);
  return service.drawOut(await service.updateDraw(ctx.db, await service.getDraw(ctx.db, ctx.uuid("draw_id")), body, user));
});

router.post("/project-draws/{draw_id}/decision", async (ctx) => {
  const user = await APPROVE(ctx);
  const body = await ctx.body(decisionIn);
  const d = await service.decideDraw(ctx.db, await service.getDraw(ctx.db, ctx.uuid("draw_id")), body.decision, body.note, user);
  return service.drawOut(d);
});

router.post("/project-draws/{draw_id}/pay", async (ctx) => {
  const user = await APPROVE(ctx);
  const body = await ctx.body(drawPayIn);
  const d = await service.payDraw(
    ctx.db, await service.getDraw(ctx.db, ctx.uuid("draw_id")), body.paid_on, body.payment_reference, user,
  );
  return service.drawOut(d);
});

router.post("/capital-projects/{project_id}/recoverability", async (ctx) => {
  const user = await EDIT(ctx);
  const p = await service.analyzeRecoverability(ctx.db, await service.getProject(ctx.db, ctx.uuid("project_id")), user);
  return service.projectOut(ctx.db, p);
});

// ======================================================================= insurance: policies

const POLICY_SORTS = {
  expires_on: insurancePolicies.expires_on, effective_on: insurancePolicies.effective_on,
  carrier: insurancePolicies.carrier, premium: insurancePolicies.premium, limit_amount: insurancePolicies.limit_amount,
  coverage_type: insurancePolicies.coverage_type, updated_at: insurancePolicies.updated_at,
};

router.get("/insurance/policies", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const q = ctx.query;
  const where = service.policyQuery(
    p.q, q.strs("coverage_type"), q.strs("status"), q.uuid("property_id"), q.int("expiring_within_days", { ge: 0 }),
  );
  const [rows, total] = await paginate(
    ctx.db, insurancePolicies, where, applySort(p.sort, POLICY_SORTS, asc(insurancePolicies.expires_on)), p,
  );
  return page(await service.policyItems(ctx.db, rows), total, p);
});

router.get("/insurance/policies/facets", async (ctx) => {
  await VIEW(ctx);
  const q = ctx.query;
  const args = [q.str("q"), q.strs("coverage_type"), q.strs("status"), q.uuid("property_id"), q.int("expiring_within_days")] as const;
  return {
    coverage_type: await facetCounts(ctx.db, insurancePolicies, service.policyQuery(...args, { skip: new Set(["coverage_type"]) }), insurancePolicies.coverage_type),
    status: await facetCounts(ctx.db, insurancePolicies, service.policyQuery(...args, { skip: new Set(["status"]) }), insurancePolicies.status),
  };
});

router.post("/insurance/policies", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(policyIn);
  return created((await service.policyItems(ctx.db, [await service.savePolicy(ctx.db, body, user)]))[0]);
});

router.get("/insurance/policies/{policy_id}", async (ctx) => {
  await VIEW(ctx);
  return (await service.policyItems(ctx.db, [await service.getPolicy(ctx.db, ctx.uuid("policy_id"))]))[0];
});

router.put("/insurance/policies/{policy_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(policyIn);
  const p = await service.savePolicy(ctx.db, body, user, await service.getPolicy(ctx.db, ctx.uuid("policy_id")));
  return (await service.policyItems(ctx.db, [p]))[0];
});

router.delete("/insurance/policies/{policy_id}", async (ctx) => {
  const user = await DELETE(ctx);
  await service.archivePolicy(ctx.db, await service.getPolicy(ctx.db, ctx.uuid("policy_id")), user);
  return noContent();
});

// ======================================================================= insurance: certificates

const CERT_SORTS = {
  expires_on: insuranceCertificates.expires_on, status: insuranceCertificates.status,
  tenant_name: insuranceCertificates.tenant_name, updated_at: insuranceCertificates.updated_at,
};

router.get("/insurance/certificates", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const q = ctx.query;
  const where = service.certificateQuery(p.q, q.strs("holder_kind"), q.strs("status"), q.uuid("property_id"), q.uuid("vendor_id"));
  const [rows, total] = await paginate(
    ctx.db, insuranceCertificates, where, applySort(p.sort, CERT_SORTS, asc(insuranceCertificates.expires_on)), p,
  );
  return page(await service.certificateItems(ctx.db, rows), total, p);
});

router.get("/insurance/certificates/facets", async (ctx) => {
  await VIEW(ctx);
  const q = ctx.query;
  const args = [q.str("q"), q.strs("holder_kind"), q.strs("status"), q.uuid("property_id"), q.uuid("vendor_id")] as const;
  return {
    holder_kind: await facetCounts(ctx.db, insuranceCertificates, service.certificateQuery(...args, { skip: new Set(["holder_kind"]) }), insuranceCertificates.holder_kind),
    status: await facetCounts(ctx.db, insuranceCertificates, service.certificateQuery(...args, { skip: new Set(["status"]) }), insuranceCertificates.status),
  };
});

router.post("/insurance/certificates", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(certificateIn);
  return created((await service.certificateItems(ctx.db, [await service.saveCertificate(ctx.db, body, user)]))[0]);
});

router.put("/insurance/certificates/{cert_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(certificateIn);
  const c = await service.saveCertificate(ctx.db, body, user, await service.getCertificate(ctx.db, ctx.uuid("cert_id")));
  return (await service.certificateItems(ctx.db, [c]))[0];
});

router.delete("/insurance/certificates/{cert_id}", async (ctx) => {
  const user = await DELETE(ctx);
  await service.archiveCertificate(ctx.db, await service.getCertificate(ctx.db, ctx.uuid("cert_id")), user);
  return noContent();
});

// ======================================================================= insurance: claims

const CLAIM_SORTS = {
  incident_on: insuranceClaims.incident_on, status: insuranceClaims.status, claimed_amount: insuranceClaims.claimed_amount,
  paid_amount: insuranceClaims.paid_amount, updated_at: insuranceClaims.updated_at,
};

router.get("/insurance/claims", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const q = ctx.query;
  const where = service.claimQuery(p.q, q.strs("status"), q.uuid("property_id"), q.uuid("policy_id"));
  const [rows, total] = await paginate(
    ctx.db, insuranceClaims, where, applySort(p.sort, CLAIM_SORTS, desc(insuranceClaims.incident_on)), p,
  );
  return page(await service.claimItems(ctx.db, rows), total, p);
});

router.get("/insurance/claims/facets", async (ctx) => {
  await VIEW(ctx);
  const q = ctx.query;
  const where = service.claimQuery(q.str("q"), q.strs("status"), q.uuid("property_id"), q.uuid("policy_id"), {
    skip: new Set(["status"]),
  });
  return { status: await facetCounts(ctx.db, insuranceClaims, where, insuranceClaims.status) };
});

router.post("/insurance/claims", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(claimIn);
  return created((await service.claimItems(ctx.db, [await service.saveClaim(ctx.db, body, user)]))[0]);
});

router.put("/insurance/claims/{claim_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(claimIn);
  const c = await service.saveClaim(ctx.db, body, user, await service.getClaim(ctx.db, ctx.uuid("claim_id")));
  return (await service.claimItems(ctx.db, [c]))[0];
});

router.post("/insurance/claims/{claim_id}/status", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(claimStatusIn);
  const c = await service.setClaimStatus(
    ctx.db, await service.getClaim(ctx.db, ctx.uuid("claim_id")), body.status, body.note, body.paid_amount, user,
  );
  return (await service.claimItems(ctx.db, [c]))[0];
});

// ======================================================================= property tax

router.get("/tax/assessments", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = taxAssessments;
  const property_id = q.uuid("property_id");
  const tax_year = q.ints("tax_year");
  const where = and(
    isNull(t.deleted_at),
    p.q ? likeAny([t.jurisdiction, t.account_number], p.q) : undefined,
    property_id ? eq(t.property_id, property_id) : undefined,
    tax_year?.length ? inArray(t.tax_year, tax_year) : undefined,
  );
  const sorts = {
    tax_year: t.tax_year, assessed_total: t.assessed_total, protest_deadline_on: t.protest_deadline_on,
    updated_at: t.updated_at,
  };
  const [rows, total] = await paginate(ctx.db, t, where, applySort(p.sort, sorts, desc(t.tax_year)), p);
  return page(await service.assessmentItems(ctx.db, rows), total, p);
});

router.post("/tax/assessments", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(assessmentIn);
  return created((await service.assessmentItems(ctx.db, [await service.saveAssessment(ctx.db, body, user)]))[0]);
});

router.put("/tax/assessments/{assessment_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(assessmentIn);
  const a = await service.saveAssessment(ctx.db, body, user, await service.getAssessment(ctx.db, ctx.uuid("assessment_id")));
  return (await service.assessmentItems(ctx.db, [a]))[0];
});

router.delete("/tax/assessments/{assessment_id}", async (ctx) => {
  const user = await DELETE(ctx);
  await service.archiveAssessment(ctx.db, await service.getAssessment(ctx.db, ctx.uuid("assessment_id")), user);
  return noContent();
});

router.get("/tax/protests", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = taxProtests;
  const property_id = q.uuid("property_id");
  const status = q.strs("status");
  const tax_year = q.ints("tax_year");
  const where = and(
    isNull(t.deleted_at),
    p.q ? likeAny([t.consultant_name, t.notes], p.q) : undefined,
    property_id ? eq(t.property_id, property_id) : undefined,
    status?.length ? inArray(t.status, status) : undefined,
    tax_year?.length ? inArray(t.tax_year, tax_year) : undefined,
  );
  const sorts = {
    tax_year: t.tax_year, deadline_on: t.deadline_on, hearing_on: t.hearing_on, net_savings: t.net_savings,
    updated_at: t.updated_at,
  };
  const [rows, total] = await paginate(ctx.db, t, where, applySort(p.sort, sorts, desc(t.tax_year)), p);
  return page(await service.protestItems(ctx.db, rows), total, p);
});

router.get("/tax/summary", async (ctx) => {
  await VIEW(ctx);
  return service.taxSummary(ctx.db, ctx.query.uuid("property_id"), ctx.query.int("tax_year"));
});

router.post("/tax/protests", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(protestIn);
  return created((await service.protestItems(ctx.db, [await service.createProtest(ctx.db, body, user)]))[0]);
});

router.patch("/tax/protests/{protest_id}", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(protestUpdate);
  const p = await service.updateProtest(ctx.db, await service.getProtest(ctx.db, ctx.uuid("protest_id")), body, user);
  return (await service.protestItems(ctx.db, [p]))[0];
});

router.post("/tax/protests/{protest_id}/hearing", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(hearingResultIn);
  const p = await service.recordHearing(ctx.db, await service.getProtest(ctx.db, ctx.uuid("protest_id")), body, user);
  return (await service.protestItems(ctx.db, [p]))[0];
});

router.get("/tax/payments", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = taxPayments;
  const property_id = q.uuid("property_id");
  const status = q.strs("status");
  const tax_year = q.ints("tax_year");
  const where = and(
    isNull(t.deleted_at),
    p.q ? likeAny([t.confirmation_number, t.installment], p.q) : undefined,
    property_id ? eq(t.property_id, property_id) : undefined,
    status?.length ? inArray(t.status, status) : undefined,
    tax_year?.length ? inArray(t.tax_year, tax_year) : undefined,
  );
  const sorts = { due_on: t.due_on, amount_due: t.amount_due, status: t.status, tax_year: t.tax_year };
  const [rows, total] = await paginate(ctx.db, t, where, applySort(p.sort, sorts, desc(t.due_on)), p);
  return page(await service.paymentItems(ctx.db, rows), total, p);
});

router.post("/tax/payments", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(paymentIn);
  return created((await service.paymentItems(ctx.db, [await service.createPayment(ctx.db, body, user)]))[0]);
});

router.post("/tax/payments/{payment_id}/confirm", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(paymentConfirmIn);
  const p = await service.confirmPayment(ctx.db, await service.getPayment(ctx.db, ctx.uuid("payment_id")), body, user);
  return (await service.paymentItems(ctx.db, [p]))[0];
});

router.delete("/tax/payments/{payment_id}", async (ctx) => {
  const user = await DELETE(ctx);
  await service.archivePayment(ctx.db, await service.getPayment(ctx.db, ctx.uuid("payment_id")), user);
  return noContent();
});

// ======================================================================= budgets

const BUDGET_SORTS = {
  fiscal_year: budgets.fiscal_year, name: budgets.name, status: budgets.status, version: budgets.version,
  updated_at: budgets.updated_at,
};

function budgetArgs(ctx: Ctx, q: string | undefined) {
  const p = ctx.query;
  return [q, p.strs("status"), p.ints("fiscal_year"), p.uuid("property_id"), p.uuid("asset_id"), p.bool("current_only")] as const;
}

router.get("/budgets", async (ctx) => {
  await VIEW(ctx);
  const p = ctx.listParams();
  const where = service.budgetQuery(...budgetArgs(ctx, p.q));
  const [rows, total] = await paginate(ctx.db, budgets, where, applySort(p.sort, BUDGET_SORTS, desc(budgets.fiscal_year)), p);
  return page(await service.budgetItems(ctx.db, rows), total, p);
});

router.get("/budgets/facets", async (ctx) => {
  await VIEW(ctx);
  const args = budgetArgs(ctx, ctx.query.str("q"));
  return {
    status: await facetCounts(ctx.db, budgets, service.budgetQuery(...args, { skip: new Set(["status"]) }), budgets.status),
    fiscal_year: await facetCounts(ctx.db, budgets, service.budgetQuery(...args, { skip: new Set(["fiscal_year"]) }), budgets.fiscal_year),
  };
});

router.post("/budgets", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(budgetIn);
  return created(await service.budgetOut(ctx.db, await service.createBudget(ctx.db, body, user)));
});

router.get("/budgets/{budget_id}", async (ctx) => {
  await VIEW(ctx);
  return service.budgetOut(ctx.db, await service.getBudget(ctx.db, ctx.uuid("budget_id")));
});

router.put("/budgets/{budget_id}/lines", async (ctx) => {
  const user = await EDIT(ctx);
  const body = await ctx.body(linesIn);
  return service.budgetOut(ctx.db, await service.saveLines(ctx.db, await service.getBudget(ctx.db, ctx.uuid("budget_id")), body, user));
});

router.post("/budgets/{budget_id}/load-prior-actuals", async (ctx) => {
  const user = await EDIT(ctx);
  return service.budgetOut(
    ctx.db, await service.loadPriorActuals(ctx.db, await service.getBudget(ctx.db, ctx.uuid("budget_id")), user),
  );
});

router.post("/budgets/{budget_id}/submit", async (ctx) => {
  const user = await EDIT(ctx);
  return service.budgetOut(
    ctx.db, await service.submitBudget(ctx.db, await service.getBudget(ctx.db, ctx.uuid("budget_id")), user),
  );
});

router.post("/budgets/{budget_id}/approval", async (ctx) => {
  const user = await APPROVE(ctx);
  const body = await ctx.body(decisionIn);
  const b = await service.decideBudgetApproval(
    ctx.db, await service.getBudget(ctx.db, ctx.uuid("budget_id")), body.decision, body.note, user,
  );
  return service.budgetOut(ctx.db, b);
});

router.post("/budgets/{budget_id}/versions", async (ctx) => {
  const user = await CREATE(ctx);
  const body = await ctx.body(newVersionIn);
  const b = await service.newVersion(ctx.db, await service.getBudget(ctx.db, ctx.uuid("budget_id")), body.kind, body.name, user);
  return created(await service.budgetOut(ctx.db, b));
});

router.delete("/budgets/{budget_id}", async (ctx) => {
  const user = await DELETE(ctx);
  await service.archiveBudget(ctx.db, await service.getBudget(ctx.db, ctx.uuid("budget_id")), user);
  return noContent();
});
