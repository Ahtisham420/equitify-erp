/**
 * Pure, deterministic capital-account and distribution-waterfall math.
 *
 * No I/O and no database access: every function takes plain values and returns plain values so the
 * results can be reproduced by an independent model (spreadsheet) and tested in isolation.
 *
 * Conventions
 * - Amounts are numbers; allocations are rounded to cents at tier level and pennies of rounding drift
 *   are assigned to the largest share so every tier sums exactly to the amount it distributes.
 * - Dates are "YYYY-MM-DD" strings (compare lexicographically). Rates/hurdles are annual fractions (0.08 = 8%).
 *   Shares are fractions.
 * - Ownership weights may be expressed in any unit (percent or fraction); they are normalised per class.
 */

export const EPS = 0.005; // half a cent

export function round2(x: number): number {
  return Number(Number(x).toFixed(2)) + 0;
}

// --------------------------------------------------------------------------- date helpers (UTC, whole days)

const MS_DAY = 86_400_000;
const parts = (d: string): [number, number, number] => {
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return [y, m, day];
};
const dayNumber = (d: string): number => {
  const [y, m, day] = parts(d);
  return Math.round(Date.UTC(y, m - 1, day) / MS_DAY);
};
/** (end - start).days */
export const daysBetween = (start: string, end: string): number => dayNumber(end) - dayNumber(start);
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const fmt = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// --------------------------------------------------------------------------- day count

/**
 * Year fraction between two dates.
 *
 * act_365: (end - start).days / 365
 * act_360: (end - start).days / 360
 * 30_360 (US bond basis): [360·(Y2−Y1) + 30·(M2−M1) + (D2−D1)] / 360,
 *     with D1 = min(D1, 30) and D2 = 30 when D2 = 31 and D1 ≥ 30.
 */
export function yearFraction(start: string, end: string, basis = "act_365"): number {
  if (end <= start) return 0.0;
  if (basis === "act_360") return daysBetween(start, end) / 360.0;
  if (basis === "30_360") {
    const [y1, m1, day1] = parts(start);
    const [y2, m2, day2] = parts(end);
    const d1 = Math.min(day1, 30);
    const d2 = day2 === 31 && d1 >= 30 ? 30 : day2;
    return (360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1)) / 360.0;
  }
  return daysBetween(start, end) / 365.0;
}

/** Anniversary date; 29 Feb rolls to 28 Feb in non-leap years. */
export function addYears(d: string, years: number): string {
  const [y0, m, day] = parts(d);
  const y = y0 + years;
  if (m === 2 && day === 29 && !isLeap(y)) return fmt(y, 2, 28);
  return fmt(y, m, day);
}

// --------------------------------------------------------------------------- preferred return accrual

export interface Flow {
  on: string;
  kind: string; // 'contribution' | 'return_of_capital' | 'pref_paid'
  amount: number; // reversals arrive as negative amounts
}

const FLOW_ORDER: Record<string, number> = { contribution: 0, return_of_capital: 1, pref_paid: 2 };

/**
 * Accrued preferred return on unreturned capital, by day count.
 *
 * Between consecutive checkpoint dates d_k < d_{k+1}:
 *     accrual_k = B_k · rate · yf(d_k, d_{k+1}, basis)
 * where B_k is the accrual base after all flows dated d_k:
 *     simple:  B = unreturned capital
 *     annual:  B = unreturned capital + capitalised unpaid pref (unpaid pref is capitalised on each
 *              anniversary of the first contribution, i.e. compounded annually).
 * Flows: contribution → capital += amount; return_of_capital → capital = max(0, capital − amount);
 * pref_paid → reduces the uncapitalised unpaid balance first, then the capitalised balance.
 */
export function prefAccrual(flowsIn: Flow[], rate: number, asOf: string, basis = "act_365", compounding = "simple") {
  const flows = flowsIn
    .filter((f) => f.on <= asOf)
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : (FLOW_ORDER[a.kind] ?? 9) - (FLOW_ORDER[b.kind] ?? 9)));
  let capital = 0.0;
  let contributed = 0.0;
  let returned = 0.0;
  let openPref = 0.0;
  let capPref = 0.0;
  let accruedTotal = 0.0;
  let paid = 0.0;
  if (!flows.length) {
    return { accrued_total: 0.0, paid: 0.0, unpaid: 0.0, unreturned_capital: 0.0, contributed: 0.0, returned: 0.0 };
  }

  const contribDates = flows.filter((f) => f.kind === "contribution" && f.amount > 0).map((f) => f.on);
  const first = contribDates.length ? contribDates.reduce((a, b) => (b < a ? b : a)) : flows[0].on;
  const anniversaries = new Set<string>();
  if (compounding === "annual") {
    let n = 1;
    for (;;) {
      const d = addYears(first, n);
      if (!(d <= asOf)) break;
      anniversaries.add(d);
      n += 1;
    }
  }

  const byDate = new Map<string, Flow[]>();
  for (const f of flows) {
    const list = byDate.get(f.on) ?? [];
    list.push(f);
    byDate.set(f.on, list);
  }
  const checkpoints = [...new Set<string>([...byDate.keys(), ...anniversaries, asOf])].sort();

  let prev: string | null = null;
  for (const d of checkpoints) {
    if (prev !== null && rate > 0) {
      const a = (capital + capPref) * rate * yearFraction(prev, d, basis);
      openPref += a;
      accruedTotal += a;
    }
    if (anniversaries.has(d)) {
      capPref += openPref;
      openPref = 0.0;
    }
    for (const f of byDate.get(d) ?? []) {
      if (f.kind === "contribution") {
        capital += f.amount;
        contributed += f.amount;
      } else if (f.kind === "return_of_capital") {
        returned += f.amount;
        capital = Math.max(0.0, capital - f.amount);
      } else if (f.kind === "pref_paid") {
        paid += f.amount;
        const take = Math.min(openPref, f.amount);
        openPref -= take;
        const rest = f.amount - take;
        if (rest > 0) capPref = Math.max(0.0, capPref - rest);
      }
    }
    prev = d;
  }

  return {
    accrued_total: accruedTotal,
    paid,
    unpaid: Math.max(0.0, openPref + capPref),
    unreturned_capital: Math.max(0.0, capital),
    contributed,
    returned,
  };
}

// --------------------------------------------------------------------------- IRR / multiple

export type CashFlow = [string, number];

/** NPV = Σ CF_i / (1 + rate)^((d_i − d_0)/365). */
export function xnpv(rate: number, flows: CashFlow[]): number {
  const t0 = flows[0][0];
  let total = 0;
  for (const [d, cf] of flows) total += cf / (1.0 + rate) ** (daysBetween(t0, d) / 365.0);
  return total;
}

/**
 * Annualised IRR r with xnpv(r) = 0 (Act/365), solved by bisection on [lo, hi].
 *
 * Guard rails: returns null unless there is at least one negative and one positive flow and the
 * NPV changes sign on the bracket. Bisection is monotone and deterministic.
 */
export function xirr(flowsIn: CashFlow[], lo = -0.99, hi = 10.0, tol = 1e-8, maxIter = 300): number | null {
  const flows: CashFlow[] = flowsIn
    .map(([d, cf]) => [d, Number(cf)] as CashFlow)
    .filter(([, cf]) => Math.abs(cf) > 1e-9)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  if (!flows.length || !flows.some(([, cf]) => cf < 0) || !flows.some(([, cf]) => cf > 0)) return null;
  let fLo = xnpv(lo, flows);
  const fHi = xnpv(hi, flows);
  if (fLo === 0) return lo;
  if (fLo * fHi > 0) return null;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2.0;
    const fMid = xnpv(mid, flows);
    if (Math.abs(fMid) < tol || (hi - lo) / 2.0 < tol) return mid;
    if (fLo < 0 === fMid < 0) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2.0;
}

/** Equity multiple = total distributions / total contributions. */
export function equityMultiple(contributed: number, distributed: number): number | null {
  return contributed > 0 ? distributed / contributed : null;
}

// --------------------------------------------------------------------------- allocation helpers

/**
 * Allocate `total` (rounded to cents) by weight; cent drift goes to the largest weight.
 * With all-zero weights the amount is split equally.
 */
export function splitProRata(totalIn: number, weights: Record<string, number>): Record<string, number> {
  const total = round2(totalIn);
  const keys = Object.keys(weights);
  if (!keys.length) return {};
  let w: Record<string, number> = {};
  for (const k of keys) w[k] = Math.max(0.0, Number(weights[k] || 0));
  let s = keys.reduce((acc, k) => acc + w[k], 0);
  if (s <= 0) {
    w = Object.fromEntries(keys.map((k) => [k, 1.0]));
    s = keys.length;
  }
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = round2((total * w[k]) / s);
  const drift = round2(total - keys.reduce((acc, k) => acc + out[k], 0));
  if (drift) {
    let top = keys[0];
    for (const k of keys) if (w[k] > w[top]) top = k;
    out[top] = round2(out[top] + drift);
  }
  return out;
}

// --------------------------------------------------------------------------- waterfall

export interface PartnerPosition {
  investment_id: string;
  partner_id: string;
  name: string;
  position: string; // 'lp' | 'gp'
  ownership_pct: number;
  commitment: number;
  contributed: number;
  unfunded: number;
  unreturned_capital: number;
  pref_unpaid: number;
  distributed_to_date: number;
  profit_to_date: number; // preferred_return + catch_up + profit components received before this event
  cash_flows: CashFlow[]; // contributions < 0, distributions > 0
}

export const partnerPosition = (p: Partial<PartnerPosition> &
  Pick<PartnerPosition, "investment_id" | "partner_id" | "name" | "position" | "ownership_pct">): PartnerPosition => ({
  commitment: 0.0,
  contributed: 0.0,
  unfunded: 0.0,
  unreturned_capital: 0.0,
  pref_unpaid: 0.0,
  distributed_to_date: 0.0,
  profit_to_date: 0.0,
  cash_flows: [],
  ...p,
});

export interface Tier {
  position: number;
  tier_type: string; // return_of_capital | preferred_return | catch_up | split
  name: string;
  hurdle_type: string; // none | irr | equity_multiple (split tiers only)
  hurdle_value: number | null; // IRR as fraction (0.15) or multiple (1.8)
  lp_share: number;
  gp_share: number;
  catch_up_rate: number; // share of catch-up dollars paid to GP
  catch_up_target: number; // GP target share of cumulative profit
}

export const tier = (t: Partial<Tier> & Pick<Tier, "position" | "tier_type">): Tier => ({
  name: "",
  hurdle_type: "none",
  hurdle_value: null,
  lp_share: 1.0,
  gp_share: 0.0,
  catch_up_rate: 1.0,
  catch_up_target: 0.2,
  ...t,
});

const sumValues = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * Allocate a distribution (or net liquidation proceeds) through ordered tiers.
 *
 * Tier formulas (R = amount still undistributed when the tier starts):
 * - return_of_capital: pay = min(R, Σ unreturned capital_i); allocated pro rata to unreturned capital.
 * - preferred_return:  pay = min(R, Σ unpaid accrued pref_i);  allocated pro rata to unpaid pref.
 * - catch_up: GP receives rate r of each dollar until GP holds target t of cumulative profit P
 *     (P = pref + catch-up + split dollars, prior events included). With G = GP profit to date:
 *         need = max(0, (t·P − G) / (r − t)),  pay = min(R, need)
 *     GP gets r·pay, LPs get (1 − r)·pay. Requires r > t and at least one GP position.
 * - split: pay is divided lp_share / gp_share (normalised) until the LP class reaches its hurdle:
 *     none:            pay = R
 *     equity_multiple: pay = min(R, max(0, M·C_lp − D_lp) / lp_share)
 *                      (C_lp = LP contributions, D_lp = LP distributions incl. this event so far)
 *     irr:             pay = smallest x ≤ R with XIRR(LP flows + lp_share·x at event date) ≥ hurdle,
 *                      found by bisection (LP IRR is monotone increasing in x).
 * Within a class (LP or GP) amounts are allocated pro rata to ownership_pct.
 * Anything left after the last tier is distributed pro rata to ownership ("residual") and flagged.
 */
export function runWaterfall(amountIn: number, eventDate: string, partners: PartnerPosition[], tiers: Tier[]) {
  const amount = round2(amountIn);
  const warnings: string[] = [];
  const ids = partners.map((p) => p.investment_id);
  const byId = Object.fromEntries(partners.map((p) => [p.investment_id, p]));
  const lps = partners.filter((p) => p.position !== "gp");
  const gps = partners.filter((p) => p.position === "gp");

  const unreturned: Record<string, number> = {};
  const pref: Record<string, number> = {};
  const got: Record<string, number> = {};
  const breakdown: Record<string, Record<string, any>[]> = {};
  for (const p of partners) {
    unreturned[p.investment_id] = Math.max(0.0, p.unreturned_capital);
    pref[p.investment_id] = Math.max(0.0, p.pref_unpaid);
  }
  for (const i of ids) {
    got[i] = 0.0;
    breakdown[i] = [];
  }
  let lpProfit = lps.reduce((a, p) => a + p.profit_to_date, 0);
  let gpProfit = gps.reduce((a, p) => a + p.profit_to_date, 0);
  const lpContrib = lps.reduce((a, p) => a + p.contributed, 0);
  const lpDistPrior = lps.reduce((a, p) => a + p.distributed_to_date, 0);
  const lpHist: CashFlow[] = lps.flatMap((p) => p.cash_flows);
  let lpEvent = 0.0; // LP dollars allocated so far in this event

  const lpIrr = (extra: number): number | null => xirr([...lpHist, [eventDate, lpEvent + extra]]);

  const credit = (alloc: Record<string, number>, t: Tier, component: string) => {
    for (const [invId, amt] of Object.entries(alloc)) {
      if (Math.abs(amt) < 0.005) continue;
      got[invId] = round2(got[invId] + amt);
      breakdown[invId].push({
        tier: t.position, name: t.name || t.tier_type, tier_type: t.tier_type, component, amount: amt,
      });
    }
  };

  const own = (group: PartnerPosition[]): Record<string, number> =>
    Object.fromEntries(group.map((p) => [p.investment_id, p.ownership_pct]));

  let remaining = amount;
  const tierRows: Record<string, any>[] = [];
  for (const t of [...tiers].sort((a, b) => a.position - b.position)) {
    const row: Record<string, any> = {
      position: t.position, name: t.name || t.tier_type, tier_type: t.tier_type,
      hurdle_type: t.hurdle_type, hurdle_value: t.hurdle_value,
      amount: 0.0, lp_amount: 0.0, gp_amount: 0.0,
    };
    if (remaining <= EPS) {
      tierRows.push(row);
      continue;
    }
    let alloc: Record<string, number> = {};
    let component = t.tier_type;
    let pay: number;

    if (t.tier_type === "return_of_capital") {
      pay = round2(Math.min(remaining, sumValues(unreturned)));
      alloc = pay > 0 ? splitProRata(pay, unreturned) : {};
      for (const [k, v] of Object.entries(alloc)) unreturned[k] = Math.max(0.0, unreturned[k] - v);
    } else if (t.tier_type === "preferred_return") {
      pay = round2(Math.min(remaining, sumValues(pref)));
      alloc = pay > 0 ? splitProRata(pay, pref) : {};
      for (const [k, v] of Object.entries(alloc)) pref[k] = Math.max(0.0, pref[k] - v);
      lpProfit += Object.entries(alloc).filter(([k]) => byId[k].position !== "gp").reduce((a, [, v]) => a + v, 0);
      gpProfit += Object.entries(alloc).filter(([k]) => byId[k].position === "gp").reduce((a, [, v]) => a + v, 0);
    } else if (t.tier_type === "catch_up") {
      const r = Number(t.catch_up_rate || 0);
      const tg = Number(t.catch_up_target || 0);
      if (!gps.length) {
        warnings.push(`Tier ${t.position}: catch-up skipped — no GP position on this asset.`);
        pay = 0.0;
      } else if (r <= tg) {
        warnings.push(`Tier ${t.position}: catch-up rate must exceed the target share; skipped.`);
        pay = 0.0;
      } else {
        const need = Math.max(0.0, (tg * (lpProfit + gpProfit) - gpProfit) / (r - tg));
        pay = round2(Math.min(remaining, need));
        const gpPart = lps.length ? round2(pay * r) : pay;
        alloc = {
          ...splitProRata(gpPart, own(gps)),
          ...(lps.length ? splitProRata(round2(pay - gpPart), own(lps)) : {}),
        };
        gpProfit += gpPart;
        lpProfit += round2(pay - gpPart);
      }
    } else if (t.tier_type === "split") {
      let lpS = Math.max(0.0, Number(t.lp_share || 0));
      let gpS = Math.max(0.0, Number(t.gp_share || 0));
      if (!gps.length && gpS > 0) {
        warnings.push(`Tier ${t.position}: no GP position — GP share paid to LPs.`);
        lpS = 1.0;
        gpS = 0.0;
      }
      if (!lps.length && lpS > 0) {
        lpS = 0.0;
        gpS = 1.0;
      }
      const tot = lpS + gpS || 1.0;
      lpS = lpS / tot;
      gpS = gpS / tot;
      const hv = t.hurdle_value;
      if (t.hurdle_type === "equity_multiple" && hv !== null && hv !== undefined && lpS > 0) {
        if (lpContrib <= 0) {
          warnings.push(`Tier ${t.position}: no LP contributions — multiple hurdle not measurable.`);
          pay = remaining;
        } else {
          const needLp = Math.max(0.0, hv * lpContrib - (lpDistPrior + lpEvent));
          pay = round2(Math.min(remaining, needLp / lpS));
        }
      } else if (t.hurdle_type === "irr" && hv !== null && hv !== undefined && lpS > 0) {
        const base = lpIrr(0.0);
        const full = lpIrr(lpS * remaining);
        if (full === null) {
          warnings.push(`Tier ${t.position}: LP IRR not measurable — tier applied to the full remainder.`);
          pay = remaining;
        } else if (base !== null && base >= hv) {
          pay = 0.0;
        } else if (full <= hv) {
          pay = remaining;
        } else {
          let lo = 0.0;
          let hi = remaining;
          for (let i = 0; i < 80; i++) {
            const mid = (lo + hi) / 2.0;
            const irrMid = lpIrr(lpS * mid);
            if (irrMid !== null && irrMid >= hv) hi = mid;
            else lo = mid;
            if (hi - lo < 0.001) break;
          }
          pay = round2(hi);
        }
      } else {
        pay = remaining;
      }
      pay = round2(Math.min(pay, remaining));
      const lpPart = round2(pay * lpS);
      const gpPart = round2(pay - lpPart);
      alloc = {
        ...(lps.length ? splitProRata(lpPart, own(lps)) : {}),
        ...(gps.length ? splitProRata(gpPart, own(gps)) : {}),
      };
      component = "profit";
      lpProfit += lpPart;
      gpProfit += gpPart;
    } else {
      warnings.push(`Tier ${t.position}: unknown tier type '${t.tier_type}' ignored.`);
      pay = 0.0;
    }

    credit(alloc, t, component);
    const entries = Object.entries(alloc);
    const tierLp = round2(entries.filter(([k]) => byId[k].position !== "gp").reduce((a, [, v]) => a + v, 0));
    const tierGp = round2(entries.filter(([k]) => byId[k].position === "gp").reduce((a, [, v]) => a + v, 0));
    lpEvent += tierLp;
    Object.assign(row, {
      amount: round2(tierLp + tierGp), lp_amount: tierLp, gp_amount: tierGp,
      lp_irr_after: lpIrr(0.0), lp_multiple_after: equityMultiple(lpContrib, lpDistPrior + lpEvent),
    });
    tierRows.push(row);
    remaining = round2(remaining - tierLp - tierGp);
  }

  if (remaining > EPS && partners.length) {
    warnings.push(`${remaining.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} remained after the last tier and was allocated pro rata to ownership.`);
    const residualTier = tier({
      position: tiers.reduce((m, t) => Math.max(m, t.position), 0) + 1, tier_type: "residual", name: "Residual",
    });
    const alloc = splitProRata(remaining, own(partners));
    credit(alloc, residualTier, "residual");
    const entries = Object.entries(alloc);
    tierRows.push({
      position: residualTier.position, name: "Residual", tier_type: "residual", hurdle_type: "none",
      hurdle_value: null, amount: remaining,
      lp_amount: round2(entries.filter(([k]) => byId[k].position !== "gp").reduce((a, [, v]) => a + v, 0)),
      gp_amount: round2(entries.filter(([k]) => byId[k].position === "gp").reduce((a, [, v]) => a + v, 0)),
    });
    remaining = 0.0;
  }

  const allocations = partners.map((p) => ({
    investment_id: p.investment_id,
    partner_id: p.partner_id,
    name: p.name,
    position: p.position,
    ownership_pct: p.ownership_pct,
    amount: got[p.investment_id],
    tiers: breakdown[p.investment_id],
    unreturned_capital_before: round2(p.unreturned_capital),
    pref_unpaid_before: round2(p.pref_unpaid),
  }));
  return {
    amount, allocated: round2(sumValues(got)), tiers: tierRows, allocations, warnings,
  };
}

/**
 * Capital call: amount_i = amount · commitment_i / Σ commitment (cent drift to the largest).
 * Calls that exceed a partner's unfunded commitment are flagged, not silently capped.
 */
export function allocateCall(amountIn: number, partners: PartnerPosition[]) {
  const amount = round2(amountIn);
  const warnings: string[] = [];
  const alloc = splitProRata(amount, Object.fromEntries(partners.map((p) => [p.investment_id, p.commitment])));
  const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows: Record<string, any>[] = [];
  for (const p of partners) {
    const a = alloc[p.investment_id] ?? 0.0;
    const over = a > p.unfunded + EPS;
    if (over) warnings.push(`${p.name}: call of ${money(a)} exceeds unfunded commitment of ${money(p.unfunded)}.`);
    rows.push({
      investment_id: p.investment_id, partner_id: p.partner_id, name: p.name, position: p.position,
      ownership_pct: p.ownership_pct, commitment: p.commitment, unfunded_before: round2(p.unfunded),
      exceeds_unfunded: over, amount: a,
      tiers: [{ tier: 0, name: "Capital call", tier_type: "call", component: "contribution", amount: a }],
    });
  }
  return {
    amount,
    allocated: round2(rows.reduce((s, r) => s + r.amount, 0)),
    tiers: [{
      position: 0, name: "Capital call (pro rata to commitment)", tier_type: "call", hurdle_type: "none",
      hurdle_value: null, amount,
      lp_amount: round2(rows.filter((r) => r.position !== "gp").reduce((s, r) => s + r.amount, 0)),
      gp_amount: round2(rows.filter((r) => r.position === "gp").reduce((s, r) => s + r.amount, 0)),
    }],
    allocations: rows,
    warnings,
  };
}

/** Default interest on an unfunded call: shortfall · rate · yf(due_on, as_of). */
export function lateInterest(shortfall: number, annualRate: number, dueOn: string, asOf: string, basis = "act_365"): number {
  if (shortfall <= 0 || asOf <= dueOn || annualRate <= 0) return 0.0;
  return round2(shortfall * annualRate * yearFraction(dueOn, asOf, basis));
}
