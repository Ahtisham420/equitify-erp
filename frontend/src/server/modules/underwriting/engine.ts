/**
 * Pure underwriting calculation engine (spec module 12). No I/O, no randomness except `simulate` (seeded).
 *
 * Conventions
 * - Rates and percentages are expressed in percent (6.5 means 6.5%). Money is annual dollars unless noted.
 * - Every material input may be a plain number or a sourced value {"value": x, "source": str, "comp_id": uuid,
 *   "document_id": uuid, "note": str}; `val()` unwraps either form.
 * - Time runs monthly from `acquisition.analysis_start` (snapped to the 1st of the month) and is aggregated into
 *   annual periods. Year 1 = months 0..11. One extra (forward) year is modeled so the exit can be priced on forward NOI.
 * - Each function below documents the exact formula it implements so it can be checked by an independent model.
 *
 * This is a line-by-line port of engine.py; Python numeric semantics (round, sum, **) come from ./pyutil.
 */
import {
  asList,
  deepEqual,
  firstOfMonth,
  isDict,
  isoDate,
  PyDate,
  pyFloat,
  PyRandom,
  pyPow,
  pyRound,
  pySum,
  roundHalfEven,
  toFloat,
  toPyDate,
  today,
  truthy,
  type Obj,
  fromIso,
} from "./pyutil";

export type { PyDate };

// --------------------------------------------------------------------------- value helpers

/** Unwrap a sourced value ({"value": x, ...}) or a raw scalar. None, "" or non-numeric -> default. */
export function val(x: any, default_ = 0.0): number {
  if (isDict(x)) x = x.value;
  if (x === null || x === undefined || x === "" || typeof x === "boolean") return default_;
  const f = pyFloat(x);
  if (f === undefined) return default_;
  return Number.isFinite(f) ? f : default_;
}

/** True when a (sourced) value is present and numeric. */
export function hasVal(x: any): boolean {
  if (isDict(x)) x = x.value;
  if (x === null || x === undefined || x === "" || typeof x === "boolean") return false;
  return pyFloat(x) !== undefined;
}

/** Percent input -> decimal fraction: pct(6.5) = 0.065. */
export function pct(x: any, default_ = 0.0): number {
  return val(x, default_) / 100.0;
}

export function parseDate(x: any): PyDate | null {
  if (isDict(x)) x = x.value;
  if (!truthy(x)) return null;
  return fromIso(String(x).slice(0, 10));
}

/** Whole months from the analysis start month to d's month: (y_d − y_s)·12 + (m_d − m_s). */
export function monthIndex(start: PyDate, d: PyDate): number {
  return (d.year - start.year) * 12 + (d.month - start.month);
}

/** A material assumption is sourced when it carries a source label, a comp id or a document id. */
export function isSourced(x: any): boolean {
  return isDict(x) && truthy(x.source || x.comp_id || x.comp_ids || x.document_id);
}

// --------------------------------------------------------------------------- finance primitives

/** Net present value with annual periods: NPV = Σ_t cf_t / (1 + rate)^t, t = 0..n. */
export function npv(rate: number, cfs: number[]): number {
  let total = 0.0;
  const base = 1.0 + rate;
  for (let t = 0; t < cfs.length; t++) {
    const d = pyPow(base, t);
    if (d === 0) throw new Error("float division by zero");
    total += cfs[t] / d;
  }
  return total;
}

/**
 * Internal rate of return: the r with Σ_t cf_t / (1 + r)^t = 0, found by bisection on [lo, hi].
 *
 * Guard rails: returns None when the cash flows never change sign or NPV has the same sign at both bounds
 * (no bracketed root). Result is a decimal fraction (0.12 = 12%).
 */
export function irr(cfs: number[], lo = -0.99, hi = 10.0, tol = 1e-7, max_iter = 300): number | null {
  if (!cfs.length || !(cfs.some((c) => c < 0) && cfs.some((c) => c > 0))) return null;
  let f_lo: number;
  let f_hi: number;
  try {
    f_lo = npv(lo, cfs);
    f_hi = npv(hi, cfs);
  } catch {
    // long series: (1+r)^t over/underflows at the bounds
    return null;
  }
  if (!(Number.isFinite(f_lo) && Number.isFinite(f_hi))) return null;
  if (f_lo === 0) return lo;
  if (f_hi === 0) return hi;
  if (f_lo * f_hi > 0) return null;
  for (let i = 0; i < max_iter; i++) {
    const mid = (lo + hi) / 2;
    const f_mid = npv(mid, cfs);
    if (Math.abs(f_mid) < tol || (hi - lo) / 2 < tol) return mid;
    if (f_lo * f_mid < 0) {
      hi = mid;
      f_hi = f_mid;
    } else {
      lo = mid;
      f_lo = f_mid;
    }
  }
  return (lo + hi) / 2;
}

/** Equity multiple = Σ positive cash flows / |Σ negative cash flows|. None when nothing was invested. */
export function equityMultiple(cfs: number[]): number | null {
  const invested = -pySum(cfs.filter((c) => c < 0));
  if (invested <= 0) return null;
  return pySum(cfs.filter((c) => c > 0)) / invested;
}

/** Peak equity = −min_t(Σ_{k≤t} cf_k), floored at 0: the largest cumulative cash outlay before recovery. */
export function peakEquity(cfs: number[]): number {
  let running = 0.0;
  let worst = 0.0;
  for (const c of cfs) {
    running += c;
    worst = Math.min(worst, running);
  }
  return -worst;
}

/** Cap rate (%) = NOI / value × 100. */
export function capRate(noi: number | null, value: number | null): number | null {
  if (noi === null || value === null || value <= 0) return null;
  return (noi / value) * 100;
}

/**
 * Level monthly payment: P·r / (1 − (1 + r)^−n) with r = rate/12, n = amort_years·12.
 *
 * amort_years ≤ 0 means interest-only: P·r. A zero rate amortizes straight-line: P / n.
 */
export function monthlyPayment(principal: number, rate_pct: number, amort_years: number): number {
  const r = rate_pct / 100 / 12;
  const n = roundHalfEven(amort_years * 12);
  if (principal <= 0) return 0.0;
  if (n <= 0) return principal * r;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - pyPow(1 + r, -n));
}

/** Annual debt constant = 12 × monthly_payment(1, rate, amort). Interest-only (amort ≤ 0) → rate. */
export function annualDebtConstant(rate_pct: number, amort_years: number): number {
  return 12 * monthlyPayment(1.0, rate_pct, amort_years);
}

/**
 * Loan = min(price × LTV_max, NOI / (DSCR_min × annual constant), NOI / debt-yield_min).
 *
 * A constraint is ignored when its input is missing or ≤ 0. Returns (amount, binding constraint, each constraint).
 */
export function sizeLoan(
  price: number,
  noi: number,
  o: {
    ltv_max_pct: number | null;
    dscr_min: number | null;
    debt_yield_min_pct: number | null;
    rate_pct: number;
    amort_years: number;
  },
): [number, string | null, Record<string, number | null>] {
  const { ltv_max_pct, dscr_min, debt_yield_min_pct, rate_pct, amort_years } = o;
  const constant = annualDebtConstant(rate_pct, amort_years);
  const limits: Record<string, number | null> = {
    ltv: ltv_max_pct && ltv_max_pct > 0 ? (price * ltv_max_pct) / 100 : null,
    dscr: dscr_min && dscr_min > 0 && constant > 0 && noi > 0 ? noi / (dscr_min * constant) : null,
    debt_yield: debt_yield_min_pct && debt_yield_min_pct > 0 && noi > 0 ? noi / (debt_yield_min_pct / 100) : null,
  };
  if (((dscr_min && dscr_min > 0) || (debt_yield_min_pct && debt_yield_min_pct > 0)) && noi <= 0) {
    return [0.0, dscr_min ? "dscr" : "debt_yield", limits];
  }
  const active = Object.entries(limits).filter(([, v]) => v !== null) as Array<[string, number]>;
  if (!active.length) return [0.0, null, limits];
  let binding = active[0];
  for (const a of active) if (a[1] < binding[1]) binding = a;
  return [Math.max(0.0, binding[1]), binding[0], limits];
}

/**
 * Monthly schedule: interest_t = balance × rate/12; interest-only for io_years·12 months, then a level payment
 * amortizing the then-outstanding balance over amort_years (amort ≤ 0 = interest-only for the whole term).
 */
export function loanSchedule(
  amount: number,
  rate_pct: number,
  amort_years: number,
  io_years: number,
  months: number,
): Array<{ interest: number; principal: number; balance: number }> {
  const rows: Array<{ interest: number; principal: number; balance: number }> = [];
  let balance = amount;
  const r = rate_pct / 100 / 12;
  const io_m = roundHalfEven(io_years * 12);
  let payment: number | null = null;
  for (let m = 0; m < months; m++) {
    const interest = balance * r;
    let principal: number;
    if (m < io_m || amort_years <= 0) {
      principal = 0.0;
    } else {
      if (payment === null) payment = monthlyPayment(balance, rate_pct, amort_years);
      principal = Math.min(balance, payment - interest);
    }
    balance -= principal;
    rows.push({ interest, principal, balance });
  }
  return rows;
}

/** Break-even occupancy (%) = (operating expenses + debt service) / potential gross income at 100% occupancy. */
export function breakevenOccupancy(opex: number, debt_service: number, potential_income_at_full: number): number | null {
  if (potential_income_at_full <= 0) return null;
  return ((opex + debt_service) / potential_income_at_full) * 100;
}

/** Linear-interpolated percentile (p in 0..100) of an ascending list. */
export function percentile(sorted_values: number[], p: number): number | null {
  if (!sorted_values.length) return null;
  const k = ((sorted_values.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return sorted_values[Math.trunc(k)];
  return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f);
}

// --------------------------------------------------------------------------- overrides (scenarios, simulation)

function setLeaf(node: Obj, key: string, value: any): void {
  const cur = node[key];
  if (isDict(value) && ("delta" in value || "mult" in value)) {
    const base = val(cur);
    value = "delta" in value ? base + toFloat(value.delta) : base * toFloat(value.mult);
  }
  if (isDict(cur) && "value" in cur && !isDict(value)) {
    node[key] = { ...cur, value };
  } else {
    node[key] = value;
  }
}

function setPath(node: any, parts: string[], value: any): void {
  if (!parts.length) return;
  const [key, ...rest] = parts;
  if (key === "__proto__") return;
  if (Array.isArray(node)) {
    const isIdx = /^\d+$/.test(key);
    const targets = key === "*" ? node : isIdx && Number(key) < node.length ? [node[Number(key)]] : [];
    for (const item of targets) if (rest.length) setPath(item, rest, value);
    return;
  }
  if (!isDict(node)) return;
  if (!rest.length) {
    setLeaf(node, key, value);
    return;
  }
  if (node[key] === null || node[key] === undefined) node[key] = {};
  setPath(node[key], rest, value);
}

/**
 * Deep-copy assumptions and set each dotted path (`exit.exit_cap`, `leases.*.renewal_probability_pct`).
 *
 * A value may be absolute, {"delta": d} (current + d) or {"mult": m} (current × m). Sourced values keep their
 * source metadata and only the `value` changes.
 */
export function applyOverrides(assumptions: Obj, overrides: Obj | null | undefined): Obj {
  const out = structuredClone(assumptions);
  for (const [path, value] of Object.entries(overrides ?? {})) setPath(out, String(path).split("."), value);
  return out;
}

// --------------------------------------------------------------------------- income model

export const ADJUST_KEYS: Record<string, number> = { price_pct: 0.0, noi_pct: 0.0, rate_bps: 0.0, exit_cap_bps: 0.0, hold_delta: 0.0 };

function adjustOf(adjust: Obj | null | undefined): Record<string, number> {
  const out = { ...ADJUST_KEYS };
  for (const [k, v] of Object.entries(adjust ?? {})) {
    if (k in out && v !== null && v !== undefined) out[k] = toFloat(v);
  }
  return out;
}

function startOf(acq: Obj): PyDate {
  const d = parseDate(acq.analysis_start) ?? today();
  return firstOfMonth(d);
}

interface LeaseFacts {
  area: number;
  remaining_years: number;
  vacant: boolean;
}

/**
 * Accumulate one lease row's monthly economics into `out` and return per-lease facts.
 *
 * Initial term: rent = explicit rent steps when given, else base_rent_annual (or rent_psf × area) escalated by
 * escalation_pct on each commencement anniversary. Abatements reduce base rent by pct in their date window.
 * Percentage rent = max(0, sales − breakpoint) × rate (natural breakpoint = annual base rent / rate).
 * Recoveries: nnn = share × recoverable pool; base_year/stop = max(0, share × pool − stop_psf × area / 12);
 * fixed = fixed_recovery_annual / 12; gross = 0. Share = recovery_share_pct or area / total area.
 * Rollover at expiration (probability-weighted with renewal probability p):
 *   downtime = round((1 − p) × downtime_months); free rent = round((1 − p) × free_rent_new_months);
 *   renewal rent = last rent × (1 + option rent change) when an option remains, else market rent;
 *   next rent = p × renewal rent + (1 − p) × market rent, market = market_rent_psf × area × (1 + g)^(t/12);
 *   TI = area × (p × ti_renewal_psf + (1 − p) × ti_new_psf); LC = (p × lc_renewal% + (1 − p) × lc_new%) ×
 *   next rent × term years; both paid in the first month of the new term. Vacant rows lease up with p = 0.
 */
function leaseMonths(
  lease: Obj,
  o: {
    n: number;
    start: PyDate;
    total_area: number;
    pool: number[];
    pool_year1: number;
    mkt_growth: number;
    out: Record<string, number[]>;
  },
): LeaseFacts {
  const { n, start, total_area, pool, pool_year1, mkt_growth, out } = o;
  const area = val(lease.area_sf);
  const share = hasVal(lease.recovery_share_pct) ? pct(lease.recovery_share_pct) : total_area ? area / total_area : 0.0;
  const rtype = lease.recovery_type || "nnn";
  let stop_psf = val(lease.expense_stop_psf);
  if (rtype === "base_year" && !stop_psf && total_area) stop_psf = pool_year1 / total_area;
  const fixed = val(lease.fixed_recovery_annual);
  const esc = pct(lease.escalation_pct);
  const vacant = truthy(lease.vacant);
  const comm = parseDate(lease.commencement_on);
  const exp = parseDate(lease.expiration_on);
  const rent0 = val(lease.base_rent_annual) || val(lease.rent_psf) * area;
  const steps: Array<[number, number]> = [];
  for (const s of asList(lease.rent_steps)) {
    if (!isDict(s)) continue;
    const d = parseDate(s.start_on);
    if (d) steps.push([monthIndex(start, d), val(s.annual_rent)]);
  }
  steps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const abatements: Array<[number, number, number]> = [];
  for (const a of asList(lease.abatements)) {
    if (!isDict(a)) continue;
    const s = parseDate(a.start_on);
    const e = parseDate(a.end_on);
    if (s && e) abatements.push([monthIndex(start, s), monthIndex(start, e), pct(a.pct, 100)]);
  }
  const pr: Obj = isDict(lease.percentage_rent) ? lease.percentage_rent : {};
  const pr_rate = pct(pr.rate_pct);
  const pr_sales = val(pr.sales_annual);
  const pr_growth = pct(pr.sales_growth_pct);
  const pr_break = val(pr.breakpoint);
  const options: Obj[] = asList(lease.options).filter((x) => isDict(x));
  let p = vacant ? 0.0 : pct(lease.renewal_probability_pct, 50);
  p = Math.min(1.0, Math.max(0.0, p));
  const new_term = val(lease.new_lease_term_years, 5) || 5;
  const downtime_m = val(lease.downtime_months, 6);
  const market_psf = val(lease.market_rent_psf);

  const fill = (s: number, e: number, rent: number, step_list: Array<[number, number]> | null, free: number, anchor: number, original: boolean): number => {
    let current = rent;
    for (let i = Math.max(0, s); i <= Math.min(e, n - 1); i++) {
      if (step_list && step_list.length) {
        const applicable = step_list.filter(([idx]) => idx <= i).map(([, r]) => r);
        current = applicable.length ? applicable[applicable.length - 1] : rent;
      } else if (i > s && (i - anchor) % 12 === 0) {
        current *= 1 + esc;
      }
      const monthly = current / 12;
      out.base[i] += monthly;
      if (i < s + free) {
        out.abate[i] += monthly;
      } else if (original) {
        for (const [a_s, a_e, a_p] of abatements) {
          if (a_s <= i && i <= a_e) {
            out.abate[i] += monthly * a_p;
            break;
          }
        }
      }
      if (pr_rate > 0 && pr_sales > 0) {
        const sales = pr_sales * pyPow(1 + pr_growth, Math.floor(i / 12));
        const breakpoint = pr_break || current / pr_rate;
        out.pct[i] += (Math.max(0.0, sales - breakpoint) * pr_rate) / 12;
      }
      out.occ[i] += area;
      if (rtype === "nnn") {
        out.recov[i] += share * pool[i];
        out.nnn_share[i] += share;
      } else if (rtype === "base_year" || rtype === "stop") {
        out.recov[i] += Math.max(0.0, share * pool[i] - (stop_psf * area) / 12);
      } else if (rtype === "fixed") {
        out.recov[i] += fixed / 12;
      }
    }
    return current;
  };

  let cur_end: number;
  let last_rent: number;
  if (vacant) {
    cur_end = -1;
    last_rent = 0.0;
  } else {
    const end_idx = exp ? monthIndex(start, exp) : n + 1;
    const begin = comm ? Math.max(0, monthIndex(start, comm)) : 0;
    const anchor = comm ? monthIndex(start, comm) : 0;
    last_rent = end_idx >= 0 ? fill(begin, end_idx, rent0, steps.length ? steps : null, 0, anchor, true) : rent0;
    cur_end = end_idx;
  }
  const remaining = !vacant ? Math.max(0.0, exp ? monthIndex(start, exp) / 12 : 0.0) : 0.0;

  let first_roll = true;
  let guard = 0;
  while (cur_end < n - 1 && guard < 60) {
    guard += 1;
    const i0 = Math.max(0, cur_end + 1);
    const p_eff = vacant && first_roll ? 0.0 : p;
    first_roll = false;
    const market = market_psf ? market_psf * area * pyPow(1 + mkt_growth, i0 / 12) : last_rent;
    const opt: Obj | null = options.length && p_eff > 0 ? (options.shift() as Obj) : null;
    const renew_rent = opt && truthy(opt) ? last_rent * (1 + pct(opt.rent_change_pct)) : market;
    const next_rent = p_eff * renew_rent + (1 - p_eff) * market;
    const term_years = (opt && truthy(opt) ? val(opt.term_years, new_term) : new_term) || new_term;
    const downtime = roundHalfEven((1 - p_eff) * downtime_m);
    const free = roundHalfEven((1 - p_eff) * val(lease.free_rent_new_months));
    const s = i0 + downtime;
    if (s >= n) break;
    out.ti[s] += area * (p_eff * val(lease.ti_renewal_psf) + (1 - p_eff) * val(lease.ti_new_psf));
    const lc_rate = p_eff * pct(lease.lc_renewal_pct) + (1 - p_eff) * pct(lease.lc_new_pct);
    out.lc[s] += lc_rate * next_rent * term_years;
    const e = s + roundHalfEven(term_years * 12) - 1;
    last_rent = fill(s, e, next_rent, null, free, s, false);
    cur_end = e;
  }
  return { area, remaining_years: remaining, vacant };
}

/**
 * Annual cash flows and core outputs for an income property.
 *
 * Revenue: PGR = base rent − abatements + percentage rent + recoveries + other income.
 * EGR = PGR × (1 − general vacancy% − credit loss%) + management-fee recoveries.
 * Opex = Σ expense lines (grown annually) + management fee (mgmt% × EGR before mgmt recoveries).
 * NOI = EGR − Opex (× (1 + noi_pct) under sensitivity). Unlevered CF = NOI − TI − LC − reserves − capex.
 * Levered CF = unlevered CF − debt service. Year 0 = −(price + closing costs [+ loan fee − loan]).
 * Exit value = exit NOI / exit cap (forward = year hold+1 NOI, trailing = year hold NOI); net of selling costs,
 * less loan payoff for levered flows.
 */
export function runIncome(a: Obj, adjust?: Obj | null): Obj {
  const adj = adjustOf(adjust);
  const acq: Obj = a.acquisition || {};
  const fin: Obj = a.financing || {};
  const ext: Obj = a.exit || {};
  const rev: Obj = a.revenue || {};
  const es: Obj = a.expense_settings || {};
  const warnings: string[] = [];

  const price = val(acq.purchase_price) * (1 + adj.price_pct / 100);
  const closing = price * pct(acq.closing_cost_pct);
  const start = startOf(acq);
  const hold = Math.min(30, Math.max(1, roundHalfEven(val(acq.hold_years, 10)) + Math.trunc(adj.hold_delta)));
  const n = (hold + 1) * 12;
  const leases: Obj[] = asList(a.leases).filter((l) => isDict(l));
  const total_area = val(rev.total_area_sf) || pySum(leases.map((l) => val(l.area_sf)));
  const mkt_growth = pct(rev.market_rent_growth_pct);
  const default_exp_growth = es.expense_growth_pct;

  // Expenses (monthly); taxes reassessed on sale and insurance repriced when enabled.
  const tr: Obj = isDict(es.tax_reassessment) ? es.tax_reassessment : {};
  const ins: Obj = isDict(es.insurance_repricing) ? es.insurance_repricing : {};
  const exp_total: number[] = new Array(n).fill(0.0);
  const pool: number[] = new Array(n).fill(0.0);
  for (const e of asList(a.expenses)) {
    if (!isDict(e)) continue;
    let base = val(e.annual_amount);
    const cat = e.category;
    if (cat === "tax" && truthy(tr.enabled)) {
      base = price * pct(tr.assessment_ratio_pct, 100) * pct(tr.tax_rate_pct);
    }
    if (cat === "insurance" && truthy(ins.enabled)) {
      base = val(ins.new_annual_amount) || base * (1 + pct(ins.change_pct));
    }
    const g = pct(hasVal(e.growth_pct) ? e.growth_pct : default_exp_growth, 3);
    const recoverable = truthy(e.recoverable);
    for (let i = 0; i < n; i++) {
      const m = (base * pyPow(1 + g, Math.floor(i / 12))) / 12;
      exp_total[i] += m;
      if (recoverable) pool[i] += m;
    }
  }
  const pool_year1 = pySum(pool.slice(0, 12));

  const out: Record<string, number[]> = {};
  for (const k of ["base", "abate", "pct", "recov", "occ", "ti", "lc", "nnn_share"]) out[k] = new Array(n).fill(0.0);
  const facts = leases.map((lease) => leaseMonths(lease, { n, start, total_area, pool, pool_year1, mkt_growth, out }));
  if (!leases.length) warnings.push("No tenant or lease rows: revenue is limited to other income.");
  if (price <= 0) warnings.push("Purchase price is missing.");

  const gv = pct(rev.general_vacancy_pct);
  const cl = pct(rev.credit_loss_pct);
  const other0 = val(rev.other_income);
  const mgmt = pct(es.mgmt_fee_pct);
  const mgmt_recoverable = truthy(es.mgmt_recoverable);

  const months: Array<Record<string, number>> = [];
  for (let i = 0; i < n; i++) {
    const other = (other0 * pyPow(1 + mkt_growth, Math.floor(i / 12))) / 12;
    const pgr = out.base[i] - out.abate[i] + out.pct[i] + out.recov[i] + other;
    const vac = pgr * gv;
    const credit = pgr * cl;
    const egr_pre = pgr - vac - credit;
    const fee = egr_pre * mgmt;
    const fee_recovery = mgmt_recoverable ? out.nnn_share[i] * fee : 0.0;
    const egr = egr_pre + fee_recovery;
    const opex = exp_total[i] + fee;
    months.push({
      base_rent: out.base[i],
      abatements: -out.abate[i],
      percentage_rent: out.pct[i],
      recoveries: out.recov[i] + fee_recovery,
      other_income: other,
      general_vacancy: -vac,
      credit_loss: -credit,
      egr,
      expenses: exp_total[i],
      mgmt_fee: fee,
      opex,
      noi: egr - opex,
      ti: out.ti[i],
      lc: out.lc[i],
      occ: out.occ[i],
      pgi_full: out.base[i] + out.pct[i] + out.recov[i] + fee_recovery + other,
    });
  }

  const years: Array<Record<string, number>> = [];
  const reserves = val(es.reserves_psf) * total_area + val(es.structural_reserve_annual);
  const capex = new Map<number, number>();
  for (const c of asList(a.capex)) if (isDict(c)) capex.set(Math.trunc(val(c.year)), val(c.amount));
  for (let y = 0; y <= hold; y++) {
    const chunk = months.slice(y * 12, (y + 1) * 12);
    const row: Record<string, number> = {};
    for (const k of Object.keys(chunk[0])) if (k !== "occ") row[k] = pySum(chunk.map((m) => m[k]));
    row.noi *= 1 + adj.noi_pct / 100;
    row.occupancy_pct = total_area ? (pySum(chunk.map((m) => m.occ)) / 12 / total_area) * 100 : 0.0;
    row.reserves = reserves;
    row.capex = capex.get(y + 1) ?? 0.0;
    row.cf_unlevered = row.noi - row.ti - row.lc - row.reserves - row.capex;
    years.push(row);
  }

  const noi1 = years[0].noi;

  // Debt sizing and schedule
  const rate = val(fin.interest_rate) + adj.rate_bps / 100;
  const amort = val(fin.amortization_years, 25);
  const io_years = val(fin.io_years);
  const use_debt = fin.use_debt !== false;
  let loan = 0.0;
  let constraint: string | null = null;
  let limits: Record<string, number | null> = { ltv: null, dscr: null, debt_yield: null };
  if (use_debt) {
    [loan, constraint, limits] = sizeLoan(price, noi1, {
      ltv_max_pct: val(fin.ltv_max) || null,
      dscr_min: val(fin.dscr_min) || null,
      debt_yield_min_pct: val(fin.debt_yield_min) || null,
      rate_pct: rate,
      amort_years: amort,
    });
    const override = val(fin.loan_amount_override);
    if (override > 0) {
      if (override > loan) warnings.push("Loan override exceeds the sized loan amount.");
      loan = override;
      constraint = "override";
    }
  }
  const loan_fee = loan * pct(fin.loan_fee_pct);
  const sched = loan > 0 ? loanSchedule(loan, rate, amort, io_years, hold * 12) : [];
  for (let y = 0; y <= hold; y++) {
    const chunk = y < hold ? sched.slice(y * 12, (y + 1) * 12) : [];
    const interest = pySum(chunk.map((m) => m.interest));
    const principal = pySum(chunk.map((m) => m.principal));
    years[y].interest = interest;
    years[y].principal = principal;
    years[y].debt_service = interest + principal;
    years[y].cf_levered = years[y].cf_unlevered - years[y].debt_service;
  }
  const balance_at_exit = sched.length ? sched[sched.length - 1].balance : 0.0;

  // Exit
  const exit_cap = val(ext.exit_cap) + adj.exit_cap_bps / 100;
  const exit_noi = ext.exit_noi_basis !== "trailing" ? years[hold].noi : years[hold - 1].noi;
  const exit_value = exit_cap > 0 ? exit_noi / (exit_cap / 100) : 0.0;
  if (exit_cap <= 0) warnings.push("Exit cap rate is missing; exit value is zero.");
  const selling = exit_value * pct(ext.selling_cost_pct);
  const net_sale = exit_value - selling;

  const total_cost = price + closing + loan_fee;
  const equity = total_cost - loan;
  const unlev = [-(price + closing)];
  for (let y = 0; y < hold; y++) unlev.push(years[y].cf_unlevered);
  unlev[unlev.length - 1] += net_sale;
  const lev = [-equity];
  for (let y = 0; y < hold; y++) lev.push(years[y].cf_levered);
  lev[lev.length - 1] += net_sale - balance_at_exit;

  const ds1 = years[0].debt_service;
  const stab_year = Math.min(hold, Math.max(1, Math.trunc(val(acq.stabilized_year, 1))));
  const stab_noi = years[stab_year - 1].noi;
  const occ1 = years[0].occupancy_pct;
  const pgi_full = occ1 > 0 ? years[0].pgi_full / (occ1 / 100) : years[0].pgi_full;
  const leased = facts.filter((f) => !f.vacant && f.area > 0);
  const walt = leased.length
    ? pySum(leased.map((f) => f.area * f.remaining_years)) / pySum(leased.map((f) => f.area))
    : null;
  const unlev_irr = irr(unlev);
  const lev_irr = irr(lev);
  const coc: number[] = [];
  if (equity > 0) for (let y = 0; y < hold; y++) coc.push((years[y].cf_levered / equity) * 100);

  const outputs: Obj = {
    model_type: "income",
    purchase_price: price,
    closing_costs: closing,
    loan_fees: loan_fee,
    total_capitalization: total_cost,
    loan_amount: loan,
    equity,
    ltv: price > 0 ? (loan / price) * 100 : null,
    loan_constraint: constraint,
    loan_constraints: limits,
    interest_rate: rate,
    annual_debt_service: ds1,
    noi_year1: noi1,
    going_in_cap: capRate(noi1, price),
    stabilized_year: stab_year,
    stabilized_noi: stab_noi,
    stabilized_cap: capRate(stab_noi, price),
    dscr: ds1 > 0 ? noi1 / ds1 : null,
    debt_yield: loan > 0 ? (noi1 / loan) * 100 : null,
    cash_on_cash: coc.length ? coc[0] : null,
    avg_cash_on_cash: coc.length ? pySum(coc) / coc.length : null,
    unlevered_irr: unlev_irr !== null ? unlev_irr * 100 : null,
    irr: lev_irr !== null ? lev_irr * 100 : null,
    equity_multiple: equityMultiple(lev),
    unlevered_multiple: equityMultiple(unlev),
    exit_cap,
    exit_noi,
    exit_value,
    selling_costs: selling,
    net_sale_proceeds: net_sale,
    loan_payoff: balance_at_exit,
    profit: pySum(lev),
    peak_equity: peakEquity(lev),
    breakeven_occupancy: breakevenOccupancy(years[0].opex, ds1, pgi_full),
    hold_years: hold,
    total_area_sf: total_area,
    price_psf: total_area ? price / total_area : null,
    occupancy_year1: occ1,
    walt_years: walt,
    cash_flows_unlevered: unlev,
    cash_flows_levered: lev,
  };
  const annual: Obj[] = [];
  for (let y = 0; y < hold; y++) {
    const row: Obj = {};
    for (const [k, v] of Object.entries(years[y])) if (k !== "pgi_full") row[k] = pyRound(v, 2);
    row.year = y + 1;
    row.period_start = isoDate({ year: start.year + y, month: start.month, day: 1 });
    annual.push(row);
  }
  return { annual, outputs: roundOutputs(outputs), warnings };
}

// --------------------------------------------------------------------------- land model

/**
 * Land acquisition / entitlement / disposition model.
 *
 * Usable acres = usable_acres or gross − detention − floodplain − right-of-way.
 * Costs: entitlement cost spread evenly over entitlement months; utilities + site work + detention cost spread over
 * the development months that follow. Carry = (tax + insurance + other) / 12 per month × unsold-acre fraction.
 * Exit: bulk sale (usable × price per usable acre, or bulk price) when ready; parcelization (lots sold evenly over
 * the absorption period); ground lease (rent until hold end, then rent / ground-lease cap); build-to-suit sale.
 * Ready month = entitlement + development months (+ 12 × hold_delta under sensitivity). Sales are net of selling
 * costs. Optional land loan = price × LTV, interest-only, repaid at the final sale.
 */
export function runLand(a: Obj, adjust?: Obj | null): Obj {
  const adj = adjustOf(adjust);
  const acq: Obj = a.acquisition || {};
  const fin: Obj = a.financing || {};
  const land: Obj = a.land || {};
  const warnings: string[] = [];

  const price = val(acq.purchase_price) * (1 + adj.price_pct / 100);
  const closing = price * pct(acq.closing_cost_pct);
  const gross = val(land.gross_acres);
  const detention = val(land.detention_acres);
  const flood = val(land.floodplain_acres);
  const row_acres = val(land.row_acres);
  const usable = val(land.usable_acres) || Math.max(0.0, gross - detention - flood - row_acres);
  const ent_m = Math.max(0, Math.trunc(val(land.entitlement_months)));
  const dev_m = Math.max(0, Math.trunc(val(land.development_months, 6)));
  const ent_cost = val(land.entitlement_cost);
  const dev_cost = val(land.utilities_cost) + val(land.site_work_cost) + val(land.detention_cost);
  const method = land.exit_method || "bulk_sale";
  const rev_mult = 1 + adj.noi_pct / 100;
  const sell_pct = pct(land.selling_cost_pct);
  const ready = ent_m + dev_m + Math.max(0, roundHalfEven(adj.hold_delta * 12));

  const sales: Array<[number, number, number]> = []; // (month, gross amount, acres)
  const income = new Map<number, number>();
  if (method === "parcelization") {
    const lots: Obj[] = asList(land.lots).filter((l) => isDict(l));
    const absorb = Math.max(1, Math.trunc(val(land.absorption_months, 12)));
    lots.forEach((lot, j) => {
      const m = ready + roundHalfEven((absorb * (j + 1)) / lots.length) - 1;
      const amount = val(lot.price) || val(lot.acres) * val(lot.price_per_acre);
      sales.push([Math.max(ready, m), amount * rev_mult, val(lot.acres)]);
    });
    if (!lots.length) warnings.push("Parcelization exit has no lots.");
  } else if (method === "ground_lease") {
    const rent = val(land.ground_lease_rent_annual) * rev_mult;
    const esc = pct(land.ground_lease_escalation_pct);
    const hold_m = Math.max(ready + 12, roundHalfEven(val(acq.hold_years, 10) * 12));
    for (let i = ready; i < hold_m; i++) {
      income.set(i, (rent * pyPow(1 + esc, Math.floor((i - ready) / 12))) / 12);
    }
    const cap = val(land.ground_lease_cap) + adj.exit_cap_bps / 100;
    const fwd = rent * pyPow(1 + esc, Math.floor((hold_m - ready) / 12));
    sales.push([hold_m - 1, cap > 0 ? fwd / (cap / 100) : 0.0, usable]);
    if (cap <= 0) warnings.push("Ground lease cap rate is missing.");
  } else if (method === "build_to_suit") {
    sales.push([ready + Math.max(0, Math.trunc(val(land.construction_months))), val(land.bts_sale_price) * rev_mult, usable]);
  } else {
    const amount = val(land.bulk_sale_price) || usable * val(land.bulk_price_per_usable_acre);
    sales.push([ready, amount * rev_mult, usable]);
  }

  const end_m = Math.max(...sales.map(([m]) => m), income.size ? Math.max(...income.keys()) : 0, ent_m + dev_m - 1, 0);
  const n = end_m + 1;
  const total_acres = pySum(sales.map(([, , ac]) => ac)) || 1.0;
  const carry_annual = val(land.carry_tax_annual) + val(land.carry_insurance_annual) + val(land.carry_other_annual);

  const use_debt = fin.use_debt === true;
  const loan = use_debt ? price * pct(fin.ltv_max) : 0.0;
  const loan_fee = loan * pct(fin.loan_fee_pct);
  const rate = val(fin.interest_rate) + adj.rate_bps / 100;

  const monthly: Array<Record<string, number>> = [];
  let sold = 0.0;
  for (let i = 0; i < n; i++) {
    let cost = ent_m && i < ent_m ? ent_cost / ent_m : ent_m === 0 && i === 0 ? ent_cost : 0.0;
    if (dev_m && ent_m <= i && i < ent_m + dev_m) cost += dev_cost / dev_m;
    else if (dev_m === 0 && i === ent_m) cost += dev_cost;
    const carry = (carry_annual / 12) * Math.max(0.0, 1 - sold / total_acres);
    const gross_sales = pySum(sales.filter(([m]) => m === i).map(([, amt]) => amt));
    sold += pySum(sales.filter(([m]) => m === i).map(([, , ac]) => ac));
    const interest = (loan * rate) / 100 / 12;
    monthly.push({
      revenue: gross_sales + (income.get(i) ?? 0.0),
      sales: gross_sales,
      income: income.get(i) ?? 0.0,
      selling_costs: gross_sales * sell_pct,
      development: cost,
      carry,
      interest,
    });
  }

  const years_n = Math.max(1, Math.ceil(n / 12));
  const annual: Obj[] = [];
  const unlev = [-(price + closing)];
  const lev = [-(price + closing + loan_fee) + loan];
  for (let y = 0; y < years_n; y++) {
    const chunk = monthly.slice(y * 12, (y + 1) * 12);
    const row: Record<string, number> = {};
    for (const k of Object.keys(monthly[0])) row[k] = pySum(chunk.map((m) => m[k]));
    row.cf_unlevered = row.revenue - row.selling_costs - row.development - row.carry;
    row.debt_service = row.interest;
    row.cf_levered = row.cf_unlevered - row.interest - (y === years_n - 1 ? loan : 0.0);
    unlev.push(row.cf_unlevered);
    lev.push(row.cf_levered);
    const rounded: Obj = {};
    for (const [k, v] of Object.entries(row)) rounded[k] = pyRound(v, 2);
    annual.push({ ...rounded, year: y + 1 });
  }

  const gross_rev = pySum(monthly.map((m) => m.revenue));
  const total_dev = ent_cost + dev_cost;
  const total_carry = pySum(monthly.map((m) => m.carry));
  const frontage = val(land.frontage_ft);
  const unlev_irr = irr(unlev);
  const lev_irr = irr(lev);
  const outputs: Obj = {
    model_type: "land",
    purchase_price: price,
    closing_costs: closing,
    loan_fees: loan_fee,
    total_capitalization: price + closing + loan_fee,
    loan_amount: loan,
    equity: price + closing + loan_fee - loan,
    interest_rate: loan ? rate : null,
    gross_acres: gross,
    usable_acres: usable,
    usable_pct: gross ? (usable / gross) * 100 : null,
    price_per_gross_acre: gross ? price / gross : null,
    price_per_usable_acre: usable ? price / usable : null,
    price_per_frontage_ft: frontage ? price / frontage : null,
    total_development_cost: total_dev,
    total_carry,
    gross_revenue: gross_rev,
    net_revenue: gross_rev - pySum(monthly.map((m) => m.selling_costs)),
    profit: pySum(lev),
    unlevered_irr: unlev_irr !== null ? unlev_irr * 100 : null,
    irr: lev_irr !== null ? lev_irr * 100 : null,
    equity_multiple: equityMultiple(lev),
    unlevered_multiple: equityMultiple(unlev),
    exit_value: pySum(sales.map(([, amt]) => amt)),
    exit_method: method,
    peak_equity: peakEquity(lev),
    hold_years: pyRound(n / 12, 2),
    noi_year1: null,
    going_in_cap: null,
    stabilized_cap: null,
    dscr: null,
    debt_yield: null,
    cash_on_cash: null,
    breakeven_occupancy: null,
    exit_cap: null,
    cash_flows_unlevered: unlev,
    cash_flows_levered: lev,
  };
  if (usable <= 0) warnings.push("Usable acreage is zero.");
  return { annual, outputs: roundOutputs(outputs), warnings };
}

/** Python `_round`: floats to 6 dp when |v| < 100 else 2 dp; list elements and dict values to 2 dp. */
function roundOutputs(d: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "number") {
      out[k] = Math.abs(v) < 100 ? pyRound(v, 6) : pyRound(v, 2);
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === "number" ? pyRound(x, 2) : x));
    } else if (isDict(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, typeof vv === "number" ? pyRound(vv, 2) : vv]));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Dispatch to the land or income model by `assumptions.model_type`. */
export function run(a: Obj, adjust?: Obj | null): Obj {
  return a.model_type === "land" ? runLand(a, adjust) : runIncome(a, adjust);
}

// --------------------------------------------------------------------------- sensitivity / tornado

export const SENSITIVITY_VARS: Obj[] = [
  { key: "price", label: "Purchase price", adjust: "price_pct", step: 5.0, unit: "%" },
  { key: "noi", label: "NOI / revenue", adjust: "noi_pct", step: 5.0, unit: "%" },
  { key: "rate", label: "Interest rate", adjust: "rate_bps", step: 50.0, unit: "bps" },
  { key: "exit_cap", label: "Exit cap rate", adjust: "exit_cap_bps", step: 25.0, unit: "bps" },
  { key: "hold", label: "Hold period", adjust: "hold_delta", step: 1.0, unit: "yrs" },
];

const outputOf = (outputs: Obj, metric: string): any =>
  Object.prototype.hasOwnProperty.call(outputs, metric) ? outputs[metric] : null;

/**
 * One-way sensitivities. For each variable v with step s, output(metric) is computed at −2s, −s, 0, +s, +2s;
 * tornado low/high are the −s/+s values and swing = |high − low|. Rows are sorted by swing (largest first).
 */
export function sensitivity(a: Obj, metric = "irr", steps?: Record<string, number> | null): Obj {
  const base = outputOf(run(a).outputs, metric);
  const rows: Obj[] = [];
  for (const v of SENSITIVITY_VARS) {
    const s = toFloat(steps && v.key in steps ? steps[v.key] : v.step);
    const points: Obj[] = [];
    for (const mult of [-2, -1, 0, 1, 2]) {
      const value = mult === 0 ? base : outputOf(run(a, { [v.adjust]: mult * s }).outputs, metric);
      points.push({ shift: mult * s, value });
    }
    const low = points[1].value;
    const high = points[3].value;
    let swing = 0.0;
    if (low !== null && high !== null) {
      // Python: abs((high or 0) - (low or 0)); non-numeric metrics raise TypeError
      if (typeof low !== "number" || typeof high !== "number") throw new TypeError("unsupported operand type(s) for -");
      swing = Math.abs((high || 0) - (low || 0));
    }
    rows.push({ variable: v.key, label: v.label, unit: v.unit, step: s, low, high, swing, points });
  }
  rows.sort((x, y) => y.swing - x.swing);
  return { metric, base, rows };
}

// --------------------------------------------------------------------------- Monte Carlo

/**
 * Seeded Monte Carlo over assumption ranges.
 *
 * Each iteration draws every range independently — triangular(min, max, mode) when a mode is given, else
 * uniform(min, max) — applies them as overrides and runs the model. Reports mean, min/max and the 5/10/25/50/75/90/95th
 * percentiles per metric, a 20-bin histogram, and P(IRR < target) when a target is given. N is capped at 2000.
 * The random stream is CPython's Mersenne Twister, so a seed reproduces the same draws as the Python backend.
 */
export function simulate(
  a: Obj,
  ranges: Obj[],
  iterations = 500,
  seed = 1,
  metrics: string[] = ["irr", "equity_multiple", "exit_value", "noi_year1"],
  target_irr: number | null = null,
): Obj {
  const rng = new PyRandom(seed);
  const n = Math.max(1, Math.min(2000, Math.trunc(iterations)));
  const samples: Record<string, number[]> = {};
  for (const m of metrics) samples[m] = [];
  const clean = ranges.filter((r) => truthy(r.path) && r.min !== null && r.min !== undefined && r.max !== null && r.max !== undefined);
  for (let it = 0; it < n; it++) {
    const overrides: Obj = {};
    for (const r of clean) {
      let lo = toFloat(r.min);
      let hi = toFloat(r.max);
      if (lo > hi) [lo, hi] = [hi, lo];
      const mode = r.mode;
      overrides[r.path] =
        mode !== null && mode !== undefined && lo <= toFloat(mode) && toFloat(mode) <= hi
          ? rng.triangular(lo, hi, toFloat(mode))
          : rng.uniform(lo, hi);
    }
    const outputs = run(applyOverrides(a, overrides)).outputs;
    for (const m of metrics) {
      const v = outputOf(outputs, m);
      if (typeof v === "number") samples[m].push(v);
    }
  }

  const result: Obj = { iterations: n, seed, ranges: clean, metrics: {} };
  for (const [m, values] of Object.entries(samples)) {
    values.sort((x, y) => x - y);
    if (!values.length) {
      result.metrics[m] = { count: 0 };
      continue;
    }
    const lo = values[0];
    const hi = values[values.length - 1];
    const width = (hi - lo) / 20 || 1.0;
    const bins: number[] = new Array(20).fill(0);
    for (const v of values) bins[Math.min(19, Math.trunc((v - lo) / width))] += 1;
    const stats: Obj = { count: values.length, mean: pySum(values) / values.length, min: lo, max: hi };
    for (const p of [5, 10, 25, 50, 75, 90, 95]) stats[`p${p}`] = percentile(values, p);
    stats.histogram = bins.map((c, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, count: c }));
    result.metrics[m] = stats;
  }
  if (target_irr !== null && target_irr !== undefined && samples.irr && samples.irr.length) {
    result.prob_irr_below_target = samples.irr.filter((v) => v < target_irr).length / samples.irr.length;
    result.target_irr = target_irr;
  }
  return result;
}

// --------------------------------------------------------------------------- source linkage

export const MATERIAL_PATHS: Array<[string, string]> = [
  ["acquisition.purchase_price", "Purchase price"],
  ["acquisition.closing_cost_pct", "Closing costs"],
  ["financing.interest_rate", "Interest rate"],
  ["financing.ltv_max", "Maximum LTV"],
  ["financing.dscr_min", "Minimum DSCR"],
  ["financing.debt_yield_min", "Minimum debt yield"],
  ["exit.exit_cap", "Exit cap rate"],
  ["revenue.general_vacancy_pct", "General vacancy"],
  ["revenue.market_rent_growth_pct", "Market rent growth"],
  ["expense_settings.mgmt_fee_pct", "Management fee"],
];
export const LAND_MATERIAL_PATHS: Array<[string, string]> = [
  ["acquisition.purchase_price", "Purchase price"],
  ["land.gross_acres", "Gross acreage"],
  ["land.usable_acres", "Usable acreage"],
  ["land.entitlement_cost", "Entitlement cost"],
  ["land.utilities_cost", "Utilities cost"],
  ["land.site_work_cost", "Site work cost"],
  ["land.bulk_price_per_usable_acre", "Exit price per usable acre"],
  ["land.ground_lease_rent_annual", "Ground lease rent"],
  ["land.ground_lease_cap", "Ground lease cap rate"],
];
const LEASE_MATERIAL: Array<[string, string]> = [
  ["base_rent_annual", "base rent"],
  ["market_rent_psf", "market rent"],
  ["renewal_probability_pct", "renewal probability"],
];

function getPath(d: any, path: string): any {
  for (const part of path.split(".")) {
    if (!isDict(d)) return null;
    d = d[part] ?? null;
  }
  return d;
}

/** Material assumptions that carry a value but no source / comp / document link. */
export function unsourced(a: Obj): Array<{ path: string; label: string }> {
  const flags: Array<{ path: string; label: string }> = [];
  const paths = a.model_type === "land" ? LAND_MATERIAL_PATHS : MATERIAL_PATHS;
  for (const [path, label] of paths) {
    const x = getPath(a, path);
    if (hasVal(x) && !isSourced(x)) flags.push({ path, label });
  }
  if (a.model_type !== "land") {
    asList(a.leases).forEach((lease, i) => {
      if (!isDict(lease) || truthy(lease.vacant)) return;
      const name = lease.tenant || lease.suite || `Lease ${i + 1}`;
      for (const [key, label] of LEASE_MATERIAL) {
        const x = lease[key];
        if (hasVal(x) && !isSourced(x)) flags.push({ path: `leases.${i}.${key}`, label: `${name}: ${label}` });
      }
    });
    asList(a.expenses).forEach((e, i) => {
      if (!isDict(e)) return;
      const x = e.annual_amount;
      if (hasVal(x) && val(x) !== 0 && !isSourced(x)) {
        flags.push({ path: `expenses.${i}.annual_amount`, label: `${e.name || "Expense"}: amount` });
      }
    });
  }
  return flags;
}

// --------------------------------------------------------------------------- version diff

const SOURCED_KEYS = new Set(["value", "source", "comp_id", "comp_ids", "comp_set_id", "document_id", "note"]);

/**
 * Flatten assumptions to {dotted.path: value}; sourced values collapse to value plus `#source` entries.
 * List items are keyed by their `id` when present (so re-ordering is not reported as a change).
 */
export function flatten(d: any, prefix = ""): Obj {
  const out: Obj = {};
  if (isDict(d)) {
    if ("value" in d && Object.keys(d).every((k) => SOURCED_KEYS.has(k))) {
      out[prefix] = d.value ?? null;
      if (truthy(d.source) || truthy(d.comp_id) || truthy(d.document_id)) {
        out[`${prefix}#source`] = truthy(d.source) ? d.source : truthy(d.comp_id) ? d.comp_id : d.document_id;
      }
      return out;
    }
    for (const [k, v] of Object.entries(d)) Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : String(k)));
  } else if (Array.isArray(d)) {
    d.forEach((item, i) => {
      const key = isDict(item) && truthy(item.id) ? item.id : i;
      Object.assign(out, flatten(item, `${prefix}[${key}]`));
    });
  } else {
    out[prefix] = d ?? null;
  }
  return out;
}

export function diffAssumptions(old: Obj | null | undefined, next: Obj | null | undefined): Array<{ path: string; from: any; to: any }> {
  const a = flatten(old || {});
  const b = flatten(next || {});
  const changes: Array<{ path: string; from: any; to: any }> = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    if (!deepEqual(a[k], b[k])) changes.push({ path: k, from: a[k] ?? null, to: b[k] ?? null });
  }
  return changes;
}

export { toPyDate };
