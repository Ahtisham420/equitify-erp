import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { pyRound, todayStr } from "../assets/calc";
import * as calc from "./calc";
import {
  COVENANT_KINDS, covenants, covenantTests, FREQUENCIES, lenderReportingObligations, LOAN_STATUSES, LOAN_TYPES, loanEvents,
  loanReserves, loans, PREPAYMENT_TYPES, RATE_TYPES, RECOURSE_TYPES, REPORT_TYPES, reserveTransactions, RESERVE_TYPES,
  type CovenantTest, type LoanReserve, type ReserveTransaction,
} from "./schema";
import {
  collateralIn, covenantIn, covenantTestIn, debtSettingsIn, loanCreate, loanUpdate, obligationIn, reserveIn, reserveTxnIn,
  submitIn,
} from "./schemas";
import * as service from "./service";
import type { LoanFilters } from "./service";

export const router = new Router();

const t = loans;
const SORTS = {
  label: t.name, lender_name: t.lender_name, current_balance: t.current_balance, rate: t.rate,
  maturity_on: t.maturity_on, status: t.status, covenant_state: t.covenant_state, loan_type: t.loan_type,
  updated_at: t.updated_at,
};
const MATURITY_ASC = sql`${t.maturity_on} asc nulls last`;

function filters(ctx: Ctx): LoanFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    rate_type: q.strs("rate_type"),
    loan_type: q.strs("loan_type"),
    covenant_state: q.strs("covenant_state"),
    lender_name: q.strs("lender_name"),
    property_id: q.uuid("property_id"),
    asset_id: q.uuid("asset_id"),
    maturity_from: q.date("maturity_from"),
    maturity_to: q.date("maturity_to"),
  };
}

function marketOverrides(ctx: Ctx): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["rate", "ltv", "dscr", "debt_yield", "amort_years", "cap_rate", "treasury_rate", "sale_cost_pct", "refi_cost_pct"]) {
    const v = ctx.query.num(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---- Out mappers (response_model equivalents) ----

const covenantTestOut = (x: CovenantTest) => ({
  id: x.id, covenant_id: x.covenant_id, loan_id: x.loan_id, test_date: x.test_date, period_start: x.period_start,
  period_end: x.period_end, measured_value: x.measured_value, threshold: x.threshold, state: x.state,
  projected_value: x.projected_value, projected_state: x.projected_state, projected_on: x.projected_on,
  inputs: x.inputs ?? {}, basis: x.basis, is_manual: x.is_manual, notes: x.notes, created_at: x.created_at,
});

const reserveOut = (r: LoanReserve) => ({
  reserve_type: r.reserve_type, label: r.label, required_amount: r.required_amount, monthly_deposit: r.monthly_deposit,
  cap_amount: r.cap_amount, release_conditions: r.release_conditions, notes: r.notes,
  id: r.id, loan_id: r.loan_id, balance: r.balance,
  funded_pct: r.required_amount ? pyRound((Number(r.balance || 0) / Number(r.required_amount)) * 100, 1) : null,
  updated_at: r.updated_at,
});

const reserveTxnOut = (x: ReserveTransaction) => ({
  id: x.id, reserve_id: x.reserve_id, loan_id: x.loan_id, kind: x.kind, amount: x.amount, occurred_on: x.occurred_on,
  balance_after: x.balance_after, document_id: x.document_id, memo: x.memo, created_at: x.created_at,
  created_by_id: x.created_by_id,
});

const loanEventOut = (e: typeof loanEvents.$inferSelect) => ({
  id: e.id, event_type: e.event_type, at: e.at, effective_on: e.effective_on, field: e.field, from_value: e.from_value,
  to_value: e.to_value, note: e.note, actor_name: e.actor_name,
});

router.get("/loans", async (ctx) => {
  await ctx.require("debt", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  const order = applySort(p.sort, SORTS, MATURITY_ASC);
  const [items, total] = await paginate(ctx.db, loans, service.buildWhere(f), order, p);
  return page(await service.toItems(ctx.db, items), total, p);
});

router.get("/loans/facets", async (ctx) => {
  await ctx.require("debt", "view");
  const f = filters(ctx);
  const w = (key: string) => service.buildWhere(f, new Set([key]));
  return {
    status: await facetCounts(ctx.db, loans, w("status"), t.status),
    rate_type: await facetCounts(ctx.db, loans, w("rate_type"), t.rate_type),
    loan_type: await facetCounts(ctx.db, loans, w("loan_type"), t.loan_type),
    covenant_state: await facetCounts(ctx.db, loans, w("covenant_state"), t.covenant_state),
    lender_name: await facetCounts(ctx.db, loans, w("lender_name"), t.lender_name),
  };
});

router.get("/loans/meta", async (ctx) => {
  await ctx.require("debt", "view");
  return {
    statuses: LOAN_STATUSES, loan_types: LOAN_TYPES, rate_types: RATE_TYPES, recourse: RECOURSE_TYPES,
    prepayment_types: PREPAYMENT_TYPES, covenant_kinds: COVENANT_KINDS, frequencies: FREQUENCIES,
    reserve_types: RESERVE_TYPES, report_types: REPORT_TYPES,
  };
});

router.get("/loans/ladder", async (ctx) => {
  await ctx.require("debt", "view");
  const bucket = ctx.query.str("bucket", { pattern: /^(year|quarter|month)$/ }) ?? "year";
  return service.ladder(ctx.db, bucket, filters(ctx));
});

router.get("/loans/exposure", async (ctx) => {
  await ctx.require("debt", "view");
  return service.exposure(ctx.db);
});

router.get("/loans/covenants", async (ctx) => {
  await ctx.require("debt", "view");
  const state = ctx.query.strs("state");
  const kind = ctx.query.strs("kind");
  const loanId = ctx.query.uuid("loan_id");
  const rows = await ctx.db
    .select({ c: covenants })
    .from(covenants)
    .innerJoin(loans, eq(loans.id, covenants.loan_id))
    .where(
      and(
        isNull(covenants.deleted_at), isNull(loans.deleted_at),
        state?.length ? inArray(covenants.last_state, state) : undefined,
        kind?.length ? inArray(covenants.kind, kind) : undefined,
        loanId ? eq(covenants.loan_id, loanId) : undefined,
      ),
    )
    .orderBy(sql`${covenants.next_test_on} asc nulls first`);
  return service.covenantItems(ctx.db, rows.map((r) => r.c));
});

router.get("/loans/settings", async (ctx) => {
  await ctx.require("debt", "view");
  return service.getSettings(ctx.db);
});

router.put("/loans/settings", async (ctx) => {
  const user = await ctx.require("debt", "approve");
  return service.saveSettings(ctx.db, await ctx.body(debtSettingsIn), user);
});

router.post("/loans/scan", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const result = await service.scan(ctx.db, user);
  await ctx.db.commit();
  return result;
});

router.get("/loans/by-property/{property_id}", async (ctx) => {
  await ctx.require("debt", "view");
  const rows = await ctx.db
    .select()
    .from(loans)
    .where(service.buildWhere({ property_id: ctx.uuid("property_id") }))
    .orderBy(asc(loans.status), MATURITY_ASC);
  return service.toItems(ctx.db, rows);
});

// ---------------------------------------------------------------- by-id sub-resources (declared before /{loan_id})

async function getCovenant(ctx: Ctx, covenantId: string) {
  const [c] = await ctx.db.select().from(covenants).where(eq(covenants.id, covenantId)).limit(1);
  if (!c || c.deleted_at) throw new HttpError(404, "Covenant not found");
  return c;
}

router.patch("/loans/covenants/{covenant_id}", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const covenantId = ctx.uuid("covenant_id");
  const body = await ctx.body(covenantIn);
  const c = await service.updateCovenant(ctx.db, await getCovenant(ctx, covenantId), body, user);
  return (await service.covenantItems(ctx.db, [c]))[0];
});

router.post("/loans/covenants/{covenant_id}/test", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const covenantId = ctx.uuid("covenant_id");
  const body = await ctx.body(covenantTestIn);
  const c = await getCovenant(ctx, covenantId);
  if (body.manual_value !== null && body.manual_value !== undefined && c.kind !== "net_worth" && !user.can("debt", "approve")) {
    throw new HttpError(403, "Overriding a computed covenant value requires approval permission");
  }
  const test = await service.runTest(ctx.db, c, user, {
    test_date: body.test_date, manual_value: body.manual_value, notes: body.notes,
  });
  await ctx.db.commit();
  return covenantTestOut(test);
});

async function getReserve(ctx: Ctx, reserveId: string) {
  const [r] = await ctx.db.select().from(loanReserves).where(eq(loanReserves.id, reserveId)).limit(1);
  if (!r || r.deleted_at) throw new HttpError(404, "Reserve not found");
  return r;
}

router.patch("/loans/reserves/{reserve_id}", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const reserveId = ctx.uuid("reserve_id");
  const body = await ctx.body(reserveIn);
  return reserveOut(await service.updateReserve(ctx.db, await getReserve(ctx, reserveId), body, user));
});

router.post("/loans/reserves/{reserve_id}/transactions", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const reserveId = ctx.uuid("reserve_id");
  const body = await ctx.body(reserveTxnIn);
  const r = await getReserve(ctx, reserveId);
  if ((body.kind === "release" || body.kind === "adjustment") && !user.can("debt", "approve")) {
    throw new HttpError(403, "Reserve releases and adjustments require approval permission");
  }
  return created(reserveTxnOut(await service.postReserveTxn(ctx.db, r, body, user)));
});

async function getObligation(ctx: Ctx, obligationId: string) {
  const [o] = await ctx.db
    .select()
    .from(lenderReportingObligations)
    .where(eq(lenderReportingObligations.id, obligationId))
    .limit(1);
  if (!o || o.deleted_at) throw new HttpError(404, "Reporting obligation not found");
  return o;
}

router.patch("/loans/obligations/{obligation_id}", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const obligationId = ctx.uuid("obligation_id");
  const body = await ctx.body(obligationIn);
  const o = await service.updateObligation(ctx.db, await getObligation(ctx, obligationId), body, user);
  return (await service.obligationItems(ctx.db, [o]))[0];
});

router.post("/loans/obligations/{obligation_id}/submit", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const obligationId = ctx.uuid("obligation_id");
  const body = await ctx.body(submitIn);
  const o = await service.submitObligation(
    ctx.db, await getObligation(ctx, obligationId), body.submitted_on, body.document_id, body.note, user,
  );
  return (await service.obligationItems(ctx.db, [o]))[0];
});

// ---------------------------------------------------------------- loan record

router.post("/loans", async (ctx) => {
  const user = await ctx.require("debt", "create");
  const body = await ctx.body(loanCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user)));
});

router.get("/loans/{loan_id}", async (ctx) => {
  await ctx.require("debt", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("loan_id")));
});

router.patch("/loans/{loan_id}", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const loanId = ctx.uuid("loan_id");
  const body = await ctx.body(loanUpdate);
  return service.toOut(ctx.db, await service.update(ctx.db, await service.get(ctx.db, loanId), body, user));
});

router.delete("/loans/{loan_id}", async (ctx) => {
  const user = await ctx.require("debt", "delete");
  await service.archive(ctx.db, await service.get(ctx.db, ctx.uuid("loan_id")), user);
  return noContent();
});

router.get("/loans/{loan_id}/events", async (ctx) => {
  await ctx.require("debt", "view");
  const loanId = ctx.uuid("loan_id");
  await service.get(ctx.db, loanId);
  const rows = await ctx.db.select().from(loanEvents).where(eq(loanEvents.loan_id, loanId)).orderBy(desc(loanEvents.at));
  return rows.map(loanEventOut);
});

router.post("/loans/{loan_id}/collateral", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const loanId = ctx.uuid("loan_id");
  const body = await ctx.body(collateralIn);
  const loan = await service.get(ctx.db, loanId);
  await service.addCollateral(ctx.db, loan, body, user);
  return created(await service.toOut(ctx.db, loan));
});

router.delete("/loans/{loan_id}/collateral/{link_id}", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const loanId = ctx.uuid("loan_id");
  const linkId = ctx.uuid("link_id");
  await service.removeCollateral(ctx.db, await service.get(ctx.db, loanId), linkId, user);
  return noContent();
});

router.get("/loans/{loan_id}/prepayment", async (ctx) => {
  await ctx.require("debt", "view");
  const loanId = ctx.uuid("loan_id");
  const payoffOn = ctx.query.date("payoff_on");
  const treasuryRate = ctx.query.num("treasury_rate", { ge: 0, le: 100 });
  const loan = await service.get(ctx.db, loanId);
  const s = await service.getSettings(ctx.db);
  const tsy = treasuryRate !== undefined
    ? treasuryRate
    : (loan.prepayment || {}).treasury_rate || s.market.treasury_rate;
  return calc.prepaymentCost(loan, payoffOn ?? todayStr(), Number(tsy));
});

router.get("/loans/{loan_id}/refinance", async (ctx) => {
  await ctx.require("debt", "view");
  const m = marketOverrides(ctx);
  return service.refinance(ctx.db, await service.get(ctx.db, ctx.uuid("loan_id")), m);
});

router.get("/loans/{loan_id}/hold-refi-sell", async (ctx) => {
  await ctx.require("debt", "view");
  const m = marketOverrides(ctx);
  return service.holdRefiSell(ctx.db, await service.get(ctx.db, ctx.uuid("loan_id")), m);
});

router.get("/loans/{loan_id}/covenants", async (ctx) => {
  await ctx.require("debt", "view");
  const rows = await ctx.db
    .select()
    .from(covenants)
    .where(and(eq(covenants.loan_id, ctx.uuid("loan_id")), isNull(covenants.deleted_at)))
    .orderBy(asc(covenants.kind));
  return service.covenantItems(ctx.db, rows);
});

router.post("/loans/{loan_id}/covenants", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const loanId = ctx.uuid("loan_id");
  const body = await ctx.body(covenantIn);
  const c = await service.createCovenant(ctx.db, await service.get(ctx.db, loanId), body, user);
  return created((await service.covenantItems(ctx.db, [c]))[0]);
});

router.post("/loans/{loan_id}/covenants/test", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const loanId = ctx.uuid("loan_id");
  await service.get(ctx.db, loanId);
  const covs = await ctx.db
    .select()
    .from(covenants)
    .where(
      and(
        eq(covenants.loan_id, loanId), isNull(covenants.deleted_at), eq(covenants.is_active, true),
        ne(covenants.kind, "net_worth"),
      ),
    );
  const tests: CovenantTest[] = [];
  for (const c of covs) tests.push(await service.runTest(ctx.db, c, user));
  await ctx.db.commit();
  return tests.map(covenantTestOut);
});

router.get("/loans/{loan_id}/covenant-tests", async (ctx) => {
  await ctx.require("debt", "view");
  const loanId = ctx.uuid("loan_id");
  const covenantId = ctx.query.uuid("covenant_id");
  const rows = await ctx.db
    .select()
    .from(covenantTests)
    .where(
      and(
        eq(covenantTests.loan_id, loanId), isNull(covenantTests.deleted_at),
        covenantId ? eq(covenantTests.covenant_id, covenantId) : undefined,
      ),
    )
    .orderBy(desc(covenantTests.test_date), desc(covenantTests.created_at))
    .limit(500);
  return rows.map(covenantTestOut);
});

router.get("/loans/{loan_id}/reserves", async (ctx) => {
  await ctx.require("debt", "view");
  const rows = await ctx.db
    .select()
    .from(loanReserves)
    .where(and(eq(loanReserves.loan_id, ctx.uuid("loan_id")), isNull(loanReserves.deleted_at)))
    .orderBy(asc(loanReserves.reserve_type));
  return rows.map(reserveOut);
});

router.post("/loans/{loan_id}/reserves", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const loanId = ctx.uuid("loan_id");
  const body = await ctx.body(reserveIn);
  return created(reserveOut(await service.createReserve(ctx.db, await service.get(ctx.db, loanId), body, user)));
});

router.get("/loans/{loan_id}/reserve-transactions", async (ctx) => {
  await ctx.require("debt", "view");
  const loanId = ctx.uuid("loan_id");
  const reserveId = ctx.query.uuid("reserve_id");
  const rows = await ctx.db
    .select()
    .from(reserveTransactions)
    .where(
      and(
        eq(reserveTransactions.loan_id, loanId), isNull(reserveTransactions.deleted_at),
        reserveId ? eq(reserveTransactions.reserve_id, reserveId) : undefined,
      ),
    )
    .orderBy(desc(reserveTransactions.occurred_on), desc(reserveTransactions.created_at));
  return rows.map(reserveTxnOut);
});

router.get("/loans/{loan_id}/obligations", async (ctx) => {
  await ctx.require("debt", "view");
  const rows = await ctx.db
    .select()
    .from(lenderReportingObligations)
    .where(
      and(eq(lenderReportingObligations.loan_id, ctx.uuid("loan_id")), isNull(lenderReportingObligations.deleted_at)),
    )
    .orderBy(sql`${lenderReportingObligations.next_due_on} asc nulls last`);
  return service.obligationItems(ctx.db, rows);
});

router.post("/loans/{loan_id}/obligations", async (ctx) => {
  const user = await ctx.require("debt", "edit");
  const loanId = ctx.uuid("loan_id");
  const body = await ctx.body(obligationIn);
  const o = await service.createObligation(ctx.db, await service.get(ctx.db, loanId), body, user);
  return created((await service.obligationItems(ctx.db, [o]))[0]);
});
