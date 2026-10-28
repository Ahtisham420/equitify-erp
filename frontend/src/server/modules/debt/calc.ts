/** Pure debt math (no I/O). All rates are annual percentages (6.5 = 6.5%). Dates are "YYYY-MM-DD" strings. */
import { addMonths, fmtG, monthsBetween, pyRound, todayStr } from "../assets/calc";

/** Level monthly payment (principal + interest). */
export function payment(principal: number, annualRatePct: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0.0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - (1 + r) ** -months);
}

/** Loan amount supported by a monthly payment (interest-only when months is falsy). */
export function principalFromPayment(monthlyPayment: number, annualRatePct: number, months: number | null | undefined): number {
  if (monthlyPayment <= 0) return 0.0;
  const r = annualRatePct / 100 / 12;
  if (!months) return r ? monthlyPayment / r : 0.0;
  if (r === 0) return monthlyPayment * months;
  return (monthlyPayment * (1 - (1 + r) ** -months)) / r;
}

const get = (loan: any, key: string): any => (loan == null ? undefined : loan[key]);

export function ioActive(loan: any, on: string): boolean {
  const io = get(loan, "io_months") || 0;
  const orig = get(loan, "originated_on");
  if (!io || !orig) return false;
  return monthsBetween(orig, on) < io;
}

export function remainingAmortMonths(loan: any, on: string): number | null {
  const amort = get(loan, "amortization_months");
  if (!amort) return null;
  const orig = get(loan, "originated_on");
  const io = get(loan, "io_months") || 0;
  const elapsed = orig ? Math.max(0, monthsBetween(orig, on) - io) : 0;
  return Math.max(12, amort - elapsed);
}

export function monthlyDebtService(loan: any, on?: string | null): number {
  const d = on || todayStr();
  const bal = Number(get(loan, "current_balance") || 0);
  const rate = Number(get(loan, "rate") || 0);
  if (bal <= 0) return 0.0;
  if (ioActive(loan, d) || !get(loan, "amortization_months")) return (bal * rate) / 100 / 12;
  return payment(bal, rate, remainingAmortMonths(loan, d) || 360);
}

export function annualDebtService(loan: any, on?: string | null): number {
  return pyRound(monthlyDebtService(loan, on) * 12, 2);
}

/** Projected balance after `months` of scheduled payments from `on`. */
export function balanceAfter(loan: any, months: number, on?: string | null): number {
  const start = on || todayStr();
  let bal = Number(get(loan, "current_balance") || 0);
  const rate = Number(get(loan, "rate") || 0) / 100 / 12;
  for (let i = 0; i < Math.max(0, months); i++) {
    const d = addMonths(start, i);
    if (ioActive(loan, d) || !get(loan, "amortization_months")) continue;
    const pay = payment(bal, rate * 1200, remainingAmortMonths(loan, d) || 360);
    bal -= pay - bal * rate;
  }
  return pyRound(Math.max(0.0, bal), 2);
}

/**
 * Estimate prepayment cost under the loan's prepayment structure.
 *
 * prepayment JSON: {type: none|open|lockout|yield_maintenance|defeasance|step_down, lockout_end, open_from,
 * step_down: [{until: date, pct}], ym_floor_pct, defeasance_fee}
 */
export function prepaymentCost(loan: any, payoffOn: string, treasuryRatePct?: number | null): Record<string, any> {
  const p: Record<string, any> = get(loan, "prepayment") || {};
  const ptype: string = p.type || "none";
  const bal = Number(get(loan, "current_balance") || 0);
  const rate = Number(get(loan, "rate") || 0);
  const maturity: string | null = get(loan, "maturity_on");
  const lines: Array<Record<string, any>> = [];
  const out: Record<string, any> = {
    type: ptype, payoff_on: payoffOn, balance: pyRound(bal, 2), allowed: true, cost: 0.0, cost_pct: 0.0, lines,
    explanation: "", estimate: true,
  };

  const d = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);

  const lockoutEnd = d(p.lockout_end);
  const openFrom = d(p.open_from);
  if (lockoutEnd && payoffOn < lockoutEnd) {
    Object.assign(out, { allowed: false, explanation: `Prepayment is locked out until ${lockoutEnd}.` });
    return out;
  }
  if (openFrom && payoffOn >= openFrom) {
    out.explanation = `Open to prepayment at par from ${openFrom}.`;
    return out;
  }
  if (ptype === "none" || ptype === "open" || bal <= 0) {
    out.explanation = "No prepayment premium.";
    return out;
  }

  const monthsLeft = maturity ? Math.max(0, monthsBetween(payoffOn, maturity)) : 0;
  const tsy = treasuryRatePct !== null && treasuryRatePct !== undefined ? treasuryRatePct : Number(p.treasury_rate || 4.0);

  let cost: number;
  if (ptype === "step_down") {
    let pctV = 0.0;
    const steps = [...(p.step_down || [])].sort((a: any, b: any) => {
      const x = String(a.until);
      const y = String(b.until);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const step of steps) {
      const until = d(step.until);
      if (until && payoffOn <= until) {
        pctV = Number(step.pct || 0);
        break;
      }
    }
    cost = (bal * pctV) / 100;
    lines.push({ label: `Step-down premium ${fmtG(pctV)}% of balance`, amount: pyRound(cost, 2) });
    out.explanation = "Step-down schedule applied to the outstanding balance.";
  } else if (ptype === "yield_maintenance") {
    const r = tsy / 100 / 12;
    const diff = Math.max(0.0, (rate - tsy) / 100 / 12) * bal;
    let pv = 0.0;
    if (r > -1) for (let i = 0; i < monthsLeft; i++) pv += diff / (1 + r) ** (i + 1);
    const floor = (bal * Number(p.ym_floor_pct || 1.0)) / 100;
    cost = Math.max(pv, floor);
    lines.push({
      label: `PV of rate differential (${fmtG(rate)}% vs treasury ${fmtG(tsy)}%) over ${monthsLeft} months`,
      amount: pyRound(pv, 2),
    });
    if (floor > pv) {
      lines.push({ label: `Minimum premium ${fmtG(Number(p.ym_floor_pct || 1.0))}% applies`, amount: pyRound(floor, 2) });
    }
    out.explanation = "Yield maintenance: present value of lost interest discounted at the treasury rate.";
  } else if (ptype === "defeasance") {
    const r = tsy / 100 / 12;
    const pay = monthlyDebtService(loan, payoffOn);
    const balAtMaturity = balanceAfter(loan, monthsLeft, payoffOn);
    let pv = 0.0;
    for (let i = 0; i < monthsLeft; i++) pv += pay / (1 + r) ** (i + 1);
    pv += balAtMaturity / (1 + r) ** Math.max(1, monthsLeft);
    const securities = Math.max(0.0, pv - bal);
    const fee = Number(p.defeasance_fee || 75000);
    cost = securities + fee;
    lines.push({ label: `Treasury portfolio cost above balance (discounted at ${fmtG(tsy)}%)`, amount: pyRound(securities, 2) });
    lines.push({ label: "Defeasance consultant, legal and servicer fees", amount: pyRound(fee, 2) });
    out.explanation = "Defeasance: cost of a treasury portfolio replicating remaining payments, plus fees.";
  } else {
    cost = 0.0;
    out.explanation = "Unrecognised prepayment structure; no premium estimated.";
  }

  out.cost = pyRound(cost, 2);
  out.cost_pct = bal ? pyRound((cost / bal) * 100, 3) : 0.0;
  return out;
}

/** Max loan under LTV, DSCR and debt-yield constraints; the binding constraint wins. */
export function sizeLoan(
  noi: number | null | undefined,
  value: number | null | undefined,
  ratePct: number,
  amortYears: number | null | undefined,
  ltvPct: number | null | undefined,
  dscr: number | null | undefined,
  debtYieldPct: number | null | undefined,
): Record<string, any> {
  const amortMonths = amortYears ? Math.trunc(amortYears * 12) : null;
  const candidates: Record<string, number> = {};
  if (value && ltvPct) candidates.ltv = (value * ltvPct) / 100;
  if (noi && noi > 0 && dscr) candidates.dscr = principalFromPayment(noi / dscr / 12, ratePct, amortMonths);
  if (noi && noi > 0 && debtYieldPct) candidates.debt_yield = noi / (debtYieldPct / 100);
  const keys = Object.keys(candidates);
  if (!keys.length) return { max_loan: null, binding: null, constraints: {} };
  let binding = keys[0];
  for (const k of keys) if (candidates[k] < candidates[binding]) binding = k;
  const amount = candidates[binding];
  const newDs = amortMonths ? payment(amount, ratePct, amortMonths) * 12 : (amount * ratePct) / 100;
  return {
    max_loan: pyRound(amount, 2),
    binding,
    constraints: Object.fromEntries(keys.map((k) => [k, pyRound(candidates[k], 2)])),
    annual_debt_service: pyRound(newDs, 2),
  };
}

export function npv(ratePct: number, flows: number[]): number {
  const r = ratePct / 100;
  return flows.reduce((t, cf, i) => t + cf / (1 + r) ** i, 0);
}

/** IRR (percent) by bisection on [-99%, 1000%]; null when no sign change. */
export function irr(flows: number[]): number | null {
  if (!flows.length || flows.every((f) => f >= 0) || flows.every((f) => f <= 0)) return null;
  let lo = -0.99;
  let hi = 10.0;
  const f = (x: number) => flows.reduce((t, cf, i) => t + cf / (1 + x) ** i, 0);
  let fLo = f(lo);
  const fHi = f(hi);
  if (fLo * fHi > 0) return null;
  let mid = lo;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < 1e-6) break;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return pyRound(mid * 100, 3);
}
