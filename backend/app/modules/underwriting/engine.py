"""Pure underwriting calculation engine (spec module 12). No I/O, no randomness except `simulate` (seeded).

Conventions
- Rates and percentages are expressed in percent (6.5 means 6.5%). Money is annual dollars unless noted.
- Every material input may be a plain number or a sourced value {"value": x, "source": str, "comp_id": uuid,
  "document_id": uuid, "note": str}; `val()` unwraps either form.
- Time runs monthly from `acquisition.analysis_start` (snapped to the 1st of the month) and is aggregated into
  annual periods. Year 1 = months 0..11. One extra (forward) year is modeled so the exit can be priced on forward NOI.
- Each function below documents the exact formula it implements so it can be checked by an independent model.
"""
from __future__ import annotations

import copy
import math
import random
from datetime import date
from typing import Any

# --------------------------------------------------------------------------- value helpers


def val(x: Any, default: float = 0.0) -> float:
    """Unwrap a sourced value ({"value": x, ...}) or a raw scalar. None, "" or non-numeric -> default."""
    if isinstance(x, dict):
        x = x.get("value")
    if x is None or x == "" or isinstance(x, bool):
        return default
    try:
        f = float(x)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def has_val(x: Any) -> bool:
    """True when a (sourced) value is present and numeric."""
    if isinstance(x, dict):
        x = x.get("value")
    if x is None or x == "" or isinstance(x, bool):
        return False
    try:
        float(x)
        return True
    except (TypeError, ValueError):
        return False


def pct(x: Any, default: float = 0.0) -> float:
    """Percent input -> decimal fraction: pct(6.5) = 0.065."""
    return val(x, default) / 100.0


def parse_date(x: Any) -> date | None:
    if isinstance(x, dict):
        x = x.get("value")
    if isinstance(x, date):
        return x
    if not x:
        return None
    try:
        return date.fromisoformat(str(x)[:10])
    except ValueError:
        return None


def month_index(start: date, d: date) -> int:
    """Whole months from the analysis start month to d's month: (y_d − y_s)·12 + (m_d − m_s)."""
    return (d.year - start.year) * 12 + (d.month - start.month)


def is_sourced(x: Any) -> bool:
    """A material assumption is sourced when it carries a source label, a comp id or a document id."""
    return isinstance(x, dict) and bool(
        x.get("source") or x.get("comp_id") or x.get("comp_ids") or x.get("document_id"))


# --------------------------------------------------------------------------- finance primitives


def npv(rate: float, cfs: list[float]) -> float:
    """Net present value with annual periods: NPV = Σ_t cf_t / (1 + rate)^t, t = 0..n."""
    total = 0.0
    base = 1.0 + rate
    for t, cf in enumerate(cfs):
        total += cf / (base ** t)
    return total


def irr(cfs: list[float], lo: float = -0.99, hi: float = 10.0, tol: float = 1e-7, max_iter: int = 300) -> float | None:
    """Internal rate of return: the r with Σ_t cf_t / (1 + r)^t = 0, found by bisection on [lo, hi].

    Guard rails: returns None when the cash flows never change sign or NPV has the same sign at both bounds
    (no bracketed root). Result is a decimal fraction (0.12 = 12%).
    """
    if not cfs or not (any(c < 0 for c in cfs) and any(c > 0 for c in cfs)):
        return None
    try:
        f_lo, f_hi = npv(lo, cfs), npv(hi, cfs)
    except (OverflowError, ZeroDivisionError):  # long series: (1+r)^t over/underflows at the bounds
        return None
    if not (math.isfinite(f_lo) and math.isfinite(f_hi)):
        return None
    if f_lo == 0:
        return lo
    if f_hi == 0:
        return hi
    if f_lo * f_hi > 0:
        return None
    for _ in range(max_iter):
        mid = (lo + hi) / 2
        f_mid = npv(mid, cfs)
        if abs(f_mid) < tol or (hi - lo) / 2 < tol:
            return mid
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return (lo + hi) / 2


def equity_multiple(cfs: list[float]) -> float | None:
    """Equity multiple = Σ positive cash flows / |Σ negative cash flows|. None when nothing was invested."""
    invested = -sum(c for c in cfs if c < 0)
    if invested <= 0:
        return None
    return sum(c for c in cfs if c > 0) / invested


def peak_equity(cfs: list[float]) -> float:
    """Peak equity = −min_t(Σ_{k≤t} cf_k), floored at 0: the largest cumulative cash outlay before recovery."""
    running, worst = 0.0, 0.0
    for c in cfs:
        running += c
        worst = min(worst, running)
    return -worst


def cap_rate(noi: float | None, value: float | None) -> float | None:
    """Cap rate (%) = NOI / value × 100."""
    if noi is None or value is None or value <= 0:
        return None
    return noi / value * 100


def monthly_payment(principal: float, rate_pct: float, amort_years: float) -> float:
    """Level monthly payment: P·r / (1 − (1 + r)^−n) with r = rate/12, n = amort_years·12.

    amort_years ≤ 0 means interest-only: P·r. A zero rate amortizes straight-line: P / n.
    """
    r = rate_pct / 100 / 12
    n = int(round(amort_years * 12))
    if principal <= 0:
        return 0.0
    if n <= 0:
        return principal * r
    if r == 0:
        return principal / n
    return principal * r / (1 - (1 + r) ** -n)


def annual_debt_constant(rate_pct: float, amort_years: float) -> float:
    """Annual debt constant = 12 × monthly_payment(1, rate, amort). Interest-only (amort ≤ 0) → rate."""
    return 12 * monthly_payment(1.0, rate_pct, amort_years)


def size_loan(
    price: float, noi: float, *, ltv_max_pct: float | None, dscr_min: float | None, debt_yield_min_pct: float | None,
    rate_pct: float, amort_years: float,
) -> tuple[float, str | None, dict[str, float | None]]:
    """Loan = min(price × LTV_max, NOI / (DSCR_min × annual constant), NOI / debt-yield_min).

    A constraint is ignored when its input is missing or ≤ 0. Returns (amount, binding constraint, each constraint).
    """
    constant = annual_debt_constant(rate_pct, amort_years)
    limits: dict[str, float | None] = {
        "ltv": price * ltv_max_pct / 100 if ltv_max_pct and ltv_max_pct > 0 else None,
        "dscr": noi / (dscr_min * constant) if dscr_min and dscr_min > 0 and constant > 0 and noi > 0 else None,
        "debt_yield": noi / (debt_yield_min_pct / 100) if debt_yield_min_pct and debt_yield_min_pct > 0 and noi > 0 else None,
    }
    if (dscr_min and dscr_min > 0 or debt_yield_min_pct and debt_yield_min_pct > 0) and noi <= 0:
        return 0.0, "dscr" if dscr_min else "debt_yield", limits
    active = {k: v for k, v in limits.items() if v is not None}
    if not active:
        return 0.0, None, limits
    binding = min(active, key=lambda k: active[k])
    return max(0.0, active[binding]), binding, limits


def loan_schedule(amount: float, rate_pct: float, amort_years: float, io_years: float, months: int) -> list[dict]:
    """Monthly schedule: interest_t = balance × rate/12; interest-only for io_years·12 months, then a level payment
    amortizing the then-outstanding balance over amort_years (amort ≤ 0 = interest-only for the whole term)."""
    rows: list[dict] = []
    balance = amount
    r = rate_pct / 100 / 12
    io_m = int(round(io_years * 12))
    payment = None
    for m in range(months):
        interest = balance * r
        if m < io_m or amort_years <= 0:
            principal = 0.0
        else:
            if payment is None:
                payment = monthly_payment(balance, rate_pct, amort_years)
            principal = min(balance, payment - interest)
        balance -= principal
        rows.append({"interest": interest, "principal": principal, "balance": balance})
    return rows


def breakeven_occupancy(opex: float, debt_service: float, potential_income_at_full: float) -> float | None:
    """Break-even occupancy (%) = (operating expenses + debt service) / potential gross income at 100% occupancy."""
    if potential_income_at_full <= 0:
        return None
    return (opex + debt_service) / potential_income_at_full * 100


def percentile(sorted_values: list[float], p: float) -> float | None:
    """Linear-interpolated percentile (p in 0..100) of an ascending list."""
    if not sorted_values:
        return None
    k = (len(sorted_values) - 1) * p / 100
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_values[int(k)]
    return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f)


# --------------------------------------------------------------------------- overrides (scenarios, simulation)


def _set_leaf(node: dict, key: str, value: Any) -> None:
    cur = node.get(key)
    if isinstance(value, dict) and ("delta" in value or "mult" in value):
        base = val(cur)
        new = base + float(value.get("delta", 0)) if "delta" in value else base * float(value.get("mult", 1))
        value = new
    if isinstance(cur, dict) and "value" in cur and not isinstance(value, dict):
        node[key] = {**cur, "value": value}
    else:
        node[key] = value


def _set_path(node: Any, parts: list[str], value: Any) -> None:
    if not parts:
        return
    key, rest = parts[0], parts[1:]
    if isinstance(node, list):
        targets = node if key == "*" else ([node[int(key)]] if key.isdigit() and int(key) < len(node) else [])
        for item in targets:
            if rest:
                _set_path(item, rest, value)
        return
    if not isinstance(node, dict):
        return
    if not rest:
        _set_leaf(node, key, value)
        return
    if node.get(key) is None:
        node[key] = {}
    _set_path(node[key], rest, value)


def apply_overrides(assumptions: dict, overrides: dict[str, Any] | None) -> dict:
    """Deep-copy assumptions and set each dotted path (`exit.exit_cap`, `leases.*.renewal_probability_pct`).

    A value may be absolute, {"delta": d} (current + d) or {"mult": m} (current × m). Sourced values keep their
    source metadata and only the `value` changes.
    """
    out = copy.deepcopy(assumptions)
    for path, value in (overrides or {}).items():
        _set_path(out, str(path).split("."), value)
    return out


# --------------------------------------------------------------------------- income model

ADJUST_KEYS = {"price_pct": 0.0, "noi_pct": 0.0, "rate_bps": 0.0, "exit_cap_bps": 0.0, "hold_delta": 0.0}


def _adjust(adjust: dict | None) -> dict[str, float]:
    out = dict(ADJUST_KEYS)
    for k, v in (adjust or {}).items():
        if k in out and v is not None:
            out[k] = float(v)
    return out


def _start(acq: dict) -> date:
    d = parse_date(acq.get("analysis_start")) or date.today()
    return d.replace(day=1)


def _lease_months(lease: dict, *, n: int, start: date, total_area: float, pool: list[float], pool_year1: float,
                  mkt_growth: float, out: dict[str, list[float]]) -> dict:
    """Accumulate one lease row's monthly economics into `out` and return per-lease facts.

    Initial term: rent = explicit rent steps when given, else base_rent_annual (or rent_psf × area) escalated by
    escalation_pct on each commencement anniversary. Abatements reduce base rent by pct in their date window.
    Percentage rent = max(0, sales − breakpoint) × rate (natural breakpoint = annual base rent / rate).
    Recoveries: nnn = share × recoverable pool; base_year/stop = max(0, share × pool − stop_psf × area / 12);
    fixed = fixed_recovery_annual / 12; gross = 0. Share = recovery_share_pct or area / total area.
    Rollover at expiration (probability-weighted with renewal probability p):
      downtime = round((1 − p) × downtime_months); free rent = round((1 − p) × free_rent_new_months);
      renewal rent = last rent × (1 + option rent change) when an option remains, else market rent;
      next rent = p × renewal rent + (1 − p) × market rent, market = market_rent_psf × area × (1 + g)^(t/12);
      TI = area × (p × ti_renewal_psf + (1 − p) × ti_new_psf); LC = (p × lc_renewal% + (1 − p) × lc_new%) ×
      next rent × term years; both paid in the first month of the new term. Vacant rows lease up with p = 0.
    """
    area = val(lease.get("area_sf"))
    share = pct(lease.get("recovery_share_pct")) if has_val(lease.get("recovery_share_pct")) else (area / total_area if total_area else 0.0)
    rtype = lease.get("recovery_type") or "nnn"
    stop_psf = val(lease.get("expense_stop_psf"))
    if rtype == "base_year" and not stop_psf and total_area:
        stop_psf = pool_year1 / total_area
    fixed = val(lease.get("fixed_recovery_annual"))
    esc = pct(lease.get("escalation_pct"))
    vacant = bool(lease.get("vacant"))
    comm = parse_date(lease.get("commencement_on"))
    exp = parse_date(lease.get("expiration_on"))
    rent0 = val(lease.get("base_rent_annual")) or val(lease.get("rent_psf")) * area
    steps = sorted(
        (month_index(start, d), val(s.get("annual_rent")))
        for s in (lease.get("rent_steps") or []) if isinstance(s, dict) and (d := parse_date(s.get("start_on")))
    )
    abatements = []
    for a in lease.get("abatements") or []:
        if not isinstance(a, dict):
            continue
        s, e = parse_date(a.get("start_on")), parse_date(a.get("end_on"))
        if s and e:
            abatements.append((month_index(start, s), month_index(start, e), pct(a.get("pct"), 100)))
    pr = lease.get("percentage_rent") if isinstance(lease.get("percentage_rent"), dict) else {}
    pr_rate = pct(pr.get("rate_pct"))
    pr_sales = val(pr.get("sales_annual"))
    pr_growth = pct(pr.get("sales_growth_pct"))
    pr_break = val(pr.get("breakpoint"))
    options = [o for o in (lease.get("options") or []) if isinstance(o, dict)]
    p = 0.0 if vacant else pct(lease.get("renewal_probability_pct"), 50)
    p = min(1.0, max(0.0, p))
    new_term = val(lease.get("new_lease_term_years"), 5) or 5
    downtime_m = val(lease.get("downtime_months"), 6)
    market_psf = val(lease.get("market_rent_psf"))

    def fill(s: int, e: int, rent: float, step_list: list | None, free: int, anchor: int, original: bool) -> float:
        current = rent
        for i in range(max(0, s), min(e, n - 1) + 1):
            if step_list:
                applicable = [r for idx, r in step_list if idx <= i]
                current = applicable[-1] if applicable else rent
            elif i > s and (i - anchor) % 12 == 0:
                current *= 1 + esc
            monthly = current / 12
            out["base"][i] += monthly
            if i < s + free:
                out["abate"][i] += monthly
            elif original:
                for a_s, a_e, a_p in abatements:
                    if a_s <= i <= a_e:
                        out["abate"][i] += monthly * a_p
                        break
            if pr_rate > 0 and pr_sales > 0:
                sales = pr_sales * (1 + pr_growth) ** (i // 12)
                breakpoint = pr_break or (current / pr_rate)
                out["pct"][i] += max(0.0, sales - breakpoint) * pr_rate / 12
            out["occ"][i] += area
            if rtype == "nnn":
                out["recov"][i] += share * pool[i]
                out["nnn_share"][i] += share
            elif rtype in ("base_year", "stop"):
                out["recov"][i] += max(0.0, share * pool[i] - stop_psf * area / 12)
            elif rtype == "fixed":
                out["recov"][i] += fixed / 12
        return current

    if vacant:
        cur_end, last_rent = -1, 0.0
    else:
        end_idx = month_index(start, exp) if exp else n + 1
        begin = max(0, month_index(start, comm)) if comm else 0
        anchor = month_index(start, comm) if comm else 0
        last_rent = fill(begin, end_idx, rent0, steps or None, 0, anchor, True) if end_idx >= 0 else rent0
        cur_end = end_idx
    remaining = max(0.0, (month_index(start, exp) / 12) if exp else 0.0) if not vacant else 0.0

    first_roll = True
    guard = 0
    while cur_end < n - 1 and guard < 60:
        guard += 1
        i0 = max(0, cur_end + 1)
        p_eff = 0.0 if vacant and first_roll else p
        first_roll = False
        market = market_psf * area * (1 + mkt_growth) ** (i0 / 12) if market_psf else last_rent
        opt = options.pop(0) if options and p_eff > 0 else None
        renew_rent = last_rent * (1 + pct(opt.get("rent_change_pct"))) if opt else market
        next_rent = p_eff * renew_rent + (1 - p_eff) * market
        term_years = (val(opt.get("term_years"), new_term) if opt else new_term) or new_term
        downtime = int(round((1 - p_eff) * downtime_m))
        free = int(round((1 - p_eff) * val(lease.get("free_rent_new_months"))))
        s = i0 + downtime
        if s >= n:
            break
        out["ti"][s] += area * (p_eff * val(lease.get("ti_renewal_psf")) + (1 - p_eff) * val(lease.get("ti_new_psf")))
        lc_rate = p_eff * pct(lease.get("lc_renewal_pct")) + (1 - p_eff) * pct(lease.get("lc_new_pct"))
        out["lc"][s] += lc_rate * next_rent * term_years
        e = s + int(round(term_years * 12)) - 1
        last_rent = fill(s, e, next_rent, None, free, s, False)
        cur_end = e
    return {"area": area, "remaining_years": remaining, "vacant": vacant}


def run_income(a: dict, adjust: dict | None = None) -> dict:
    """Annual cash flows and core outputs for an income property.

    Revenue: PGR = base rent − abatements + percentage rent + recoveries + other income.
    EGR = PGR × (1 − general vacancy% − credit loss%) + management-fee recoveries.
    Opex = Σ expense lines (grown annually) + management fee (mgmt% × EGR before mgmt recoveries).
    NOI = EGR − Opex (× (1 + noi_pct) under sensitivity). Unlevered CF = NOI − TI − LC − reserves − capex.
    Levered CF = unlevered CF − debt service. Year 0 = −(price + closing costs [+ loan fee − loan]).
    Exit value = exit NOI / exit cap (forward = year hold+1 NOI, trailing = year hold NOI); net of selling costs,
    less loan payoff for levered flows.
    """
    adj = _adjust(adjust)
    acq = a.get("acquisition") or {}
    fin = a.get("financing") or {}
    ext = a.get("exit") or {}
    rev = a.get("revenue") or {}
    es = a.get("expense_settings") or {}
    warnings: list[str] = []

    price = val(acq.get("purchase_price")) * (1 + adj["price_pct"] / 100)
    closing = price * pct(acq.get("closing_cost_pct"))
    start = _start(acq)
    hold = min(30, max(1, int(round(val(acq.get("hold_years"), 10))) + int(adj["hold_delta"])))
    n = (hold + 1) * 12
    leases = [lease for lease in (a.get("leases") or []) if isinstance(lease, dict)]
    total_area = val(rev.get("total_area_sf")) or sum(val(lease.get("area_sf")) for lease in leases)
    mkt_growth = pct(rev.get("market_rent_growth_pct"))
    default_exp_growth = es.get("expense_growth_pct")

    # Expenses (monthly); taxes reassessed on sale and insurance repriced when enabled.
    tr = es.get("tax_reassessment") if isinstance(es.get("tax_reassessment"), dict) else {}
    ins = es.get("insurance_repricing") if isinstance(es.get("insurance_repricing"), dict) else {}
    exp_total = [0.0] * n
    pool = [0.0] * n
    for e in a.get("expenses") or []:
        if not isinstance(e, dict):
            continue
        base = val(e.get("annual_amount"))
        cat = e.get("category")
        if cat == "tax" and tr.get("enabled"):
            base = price * pct(tr.get("assessment_ratio_pct"), 100) * pct(tr.get("tax_rate_pct"))
        if cat == "insurance" and ins.get("enabled"):
            base = val(ins.get("new_annual_amount")) or base * (1 + pct(ins.get("change_pct")))
        g = pct(e.get("growth_pct") if has_val(e.get("growth_pct")) else default_exp_growth, 3)
        recoverable = bool(e.get("recoverable"))
        for i in range(n):
            m = base * (1 + g) ** (i // 12) / 12
            exp_total[i] += m
            if recoverable:
                pool[i] += m
    pool_year1 = sum(pool[:12])

    out = {k: [0.0] * n for k in ("base", "abate", "pct", "recov", "occ", "ti", "lc", "nnn_share")}
    facts = [_lease_months(lease, n=n, start=start, total_area=total_area, pool=pool, pool_year1=pool_year1,
                           mkt_growth=mkt_growth, out=out) for lease in leases]
    if not leases:
        warnings.append("No tenant or lease rows: revenue is limited to other income.")
    if price <= 0:
        warnings.append("Purchase price is missing.")

    gv = pct(rev.get("general_vacancy_pct"))
    cl = pct(rev.get("credit_loss_pct"))
    other0 = val(rev.get("other_income"))
    mgmt = pct(es.get("mgmt_fee_pct"))
    mgmt_recoverable = bool(es.get("mgmt_recoverable"))

    months: list[dict[str, float]] = []
    for i in range(n):
        other = other0 * (1 + mkt_growth) ** (i // 12) / 12
        pgr = out["base"][i] - out["abate"][i] + out["pct"][i] + out["recov"][i] + other
        vac = pgr * gv
        credit = pgr * cl
        egr_pre = pgr - vac - credit
        fee = egr_pre * mgmt
        fee_recovery = out["nnn_share"][i] * fee if mgmt_recoverable else 0.0
        egr = egr_pre + fee_recovery
        opex = exp_total[i] + fee
        months.append({
            "base_rent": out["base"][i], "abatements": -out["abate"][i], "percentage_rent": out["pct"][i],
            "recoveries": out["recov"][i] + fee_recovery, "other_income": other, "general_vacancy": -vac,
            "credit_loss": -credit, "egr": egr, "expenses": exp_total[i], "mgmt_fee": fee, "opex": opex,
            "noi": egr - opex, "ti": out["ti"][i], "lc": out["lc"][i], "occ": out["occ"][i],
            "pgi_full": out["base"][i] + out["pct"][i] + out["recov"][i] + fee_recovery + other,
        })

    years: list[dict[str, float]] = []
    reserves = val(es.get("reserves_psf")) * total_area + val(es.get("structural_reserve_annual"))
    capex = {int(val(c.get("year"))): val(c.get("amount")) for c in (a.get("capex") or []) if isinstance(c, dict)}
    for y in range(hold + 1):
        chunk = months[y * 12:(y + 1) * 12]
        row = {k: sum(m[k] for m in chunk) for k in chunk[0] if k != "occ"}
        row["noi"] *= 1 + adj["noi_pct"] / 100
        row["occupancy_pct"] = (sum(m["occ"] for m in chunk) / 12 / total_area * 100) if total_area else 0.0
        row["reserves"] = reserves
        row["capex"] = capex.get(y + 1, 0.0)
        row["cf_unlevered"] = row["noi"] - row["ti"] - row["lc"] - row["reserves"] - row["capex"]
        years.append(row)

    noi1 = years[0]["noi"]

    # Debt sizing and schedule
    rate = val(fin.get("interest_rate")) + adj["rate_bps"] / 100
    amort = val(fin.get("amortization_years"), 25)
    io_years = val(fin.get("io_years"))
    use_debt = fin.get("use_debt", True) is not False
    loan, constraint, limits = 0.0, None, {"ltv": None, "dscr": None, "debt_yield": None}
    if use_debt:
        loan, constraint, limits = size_loan(
            price, noi1, ltv_max_pct=val(fin.get("ltv_max")) or None, dscr_min=val(fin.get("dscr_min")) or None,
            debt_yield_min_pct=val(fin.get("debt_yield_min")) or None, rate_pct=rate, amort_years=amort,
        )
        override = val(fin.get("loan_amount_override"))
        if override > 0:
            if override > loan:
                warnings.append("Loan override exceeds the sized loan amount.")
            loan, constraint = override, "override"
    loan_fee = loan * pct(fin.get("loan_fee_pct"))
    sched = loan_schedule(loan, rate, amort, io_years, hold * 12) if loan > 0 else []
    for y in range(hold + 1):
        chunk = sched[y * 12:(y + 1) * 12] if y < hold else []
        interest = sum(m["interest"] for m in chunk)
        principal = sum(m["principal"] for m in chunk)
        years[y]["interest"] = interest
        years[y]["principal"] = principal
        years[y]["debt_service"] = interest + principal
        years[y]["cf_levered"] = years[y]["cf_unlevered"] - years[y]["debt_service"]
    balance_at_exit = sched[-1]["balance"] if sched else 0.0

    # Exit
    exit_cap = val(ext.get("exit_cap")) + adj["exit_cap_bps"] / 100
    exit_noi = years[hold]["noi"] if ext.get("exit_noi_basis", "forward") != "trailing" else years[hold - 1]["noi"]
    exit_value = exit_noi / (exit_cap / 100) if exit_cap > 0 else 0.0
    if exit_cap <= 0:
        warnings.append("Exit cap rate is missing; exit value is zero.")
    selling = exit_value * pct(ext.get("selling_cost_pct"))
    net_sale = exit_value - selling

    total_cost = price + closing + loan_fee
    equity = total_cost - loan
    unlev = [-(price + closing)] + [years[y]["cf_unlevered"] for y in range(hold)]
    unlev[-1] += net_sale
    lev = [-equity] + [years[y]["cf_levered"] for y in range(hold)]
    lev[-1] += net_sale - balance_at_exit

    ds1 = years[0]["debt_service"]
    stab_year = min(hold, max(1, int(val(acq.get("stabilized_year"), 1))))
    stab_noi = years[stab_year - 1]["noi"]
    occ1 = years[0]["occupancy_pct"]
    pgi_full = years[0]["pgi_full"] / (occ1 / 100) if occ1 > 0 else years[0]["pgi_full"]
    leased = [f for f in facts if not f["vacant"] and f["area"] > 0]
    walt = (sum(f["area"] * f["remaining_years"] for f in leased) / sum(f["area"] for f in leased)) if leased else None
    unlev_irr = irr(unlev)
    lev_irr = irr(lev)
    coc = [(years[y]["cf_levered"] / equity * 100) for y in range(hold)] if equity > 0 else []

    outputs = {
        "model_type": "income",
        "purchase_price": price,
        "closing_costs": closing,
        "loan_fees": loan_fee,
        "total_capitalization": total_cost,
        "loan_amount": loan,
        "equity": equity,
        "ltv": loan / price * 100 if price > 0 else None,
        "loan_constraint": constraint,
        "loan_constraints": limits,
        "interest_rate": rate,
        "annual_debt_service": ds1,
        "noi_year1": noi1,
        "going_in_cap": cap_rate(noi1, price),
        "stabilized_year": stab_year,
        "stabilized_noi": stab_noi,
        "stabilized_cap": cap_rate(stab_noi, price),
        "dscr": noi1 / ds1 if ds1 > 0 else None,
        "debt_yield": noi1 / loan * 100 if loan > 0 else None,
        "cash_on_cash": coc[0] if coc else None,
        "avg_cash_on_cash": sum(coc) / len(coc) if coc else None,
        "unlevered_irr": unlev_irr * 100 if unlev_irr is not None else None,
        "irr": lev_irr * 100 if lev_irr is not None else None,
        "equity_multiple": equity_multiple(lev),
        "unlevered_multiple": equity_multiple(unlev),
        "exit_cap": exit_cap,
        "exit_noi": exit_noi,
        "exit_value": exit_value,
        "selling_costs": selling,
        "net_sale_proceeds": net_sale,
        "loan_payoff": balance_at_exit,
        "profit": sum(lev),
        "peak_equity": peak_equity(lev),
        "breakeven_occupancy": breakeven_occupancy(years[0]["opex"], ds1, pgi_full),
        "hold_years": hold,
        "total_area_sf": total_area,
        "price_psf": price / total_area if total_area else None,
        "occupancy_year1": occ1,
        "walt_years": walt,
        "cash_flows_unlevered": unlev,
        "cash_flows_levered": lev,
    }
    annual = []
    for y in range(hold):
        row = {k: round(v, 2) for k, v in years[y].items() if k != "pgi_full"}
        row["year"] = y + 1
        row["period_start"] = date(start.year + y, start.month, 1).isoformat()
        annual.append(row)
    return {"annual": annual, "outputs": _round(outputs), "warnings": warnings}


# --------------------------------------------------------------------------- land model


def run_land(a: dict, adjust: dict | None = None) -> dict:
    """Land acquisition / entitlement / disposition model.

    Usable acres = usable_acres or gross − detention − floodplain − right-of-way.
    Costs: entitlement cost spread evenly over entitlement months; utilities + site work + detention cost spread over
    the development months that follow. Carry = (tax + insurance + other) / 12 per month × unsold-acre fraction.
    Exit: bulk sale (usable × price per usable acre, or bulk price) when ready; parcelization (lots sold evenly over
    the absorption period); ground lease (rent until hold end, then rent / ground-lease cap); build-to-suit sale.
    Ready month = entitlement + development months (+ 12 × hold_delta under sensitivity). Sales are net of selling
    costs. Optional land loan = price × LTV, interest-only, repaid at the final sale.
    """
    adj = _adjust(adjust)
    acq = a.get("acquisition") or {}
    fin = a.get("financing") or {}
    land = a.get("land") or {}
    warnings: list[str] = []

    price = val(acq.get("purchase_price")) * (1 + adj["price_pct"] / 100)
    closing = price * pct(acq.get("closing_cost_pct"))
    gross = val(land.get("gross_acres"))
    detention, flood, row_acres = val(land.get("detention_acres")), val(land.get("floodplain_acres")), val(land.get("row_acres"))
    usable = val(land.get("usable_acres")) or max(0.0, gross - detention - flood - row_acres)
    ent_m = max(0, int(val(land.get("entitlement_months"))))
    dev_m = max(0, int(val(land.get("development_months"), 6)))
    ent_cost = val(land.get("entitlement_cost"))
    dev_cost = val(land.get("utilities_cost")) + val(land.get("site_work_cost")) + val(land.get("detention_cost"))
    method = land.get("exit_method") or "bulk_sale"
    rev_mult = 1 + adj["noi_pct"] / 100
    sell_pct = pct(land.get("selling_cost_pct"))
    ready = ent_m + dev_m + max(0, int(round(adj["hold_delta"] * 12)))

    sales: list[tuple[int, float, float]] = []  # (month, gross amount, acres)
    income: dict[int, float] = {}
    if method == "parcelization":
        lots = [lot for lot in (land.get("lots") or []) if isinstance(lot, dict)]
        absorb = max(1, int(val(land.get("absorption_months"), 12)))
        for j, lot in enumerate(lots):
            m = ready + int(round(absorb * (j + 1) / len(lots))) - 1
            amount = val(lot.get("price")) or val(lot.get("acres")) * val(lot.get("price_per_acre"))
            sales.append((max(ready, m), amount * rev_mult, val(lot.get("acres"))))
        if not lots:
            warnings.append("Parcelization exit has no lots.")
    elif method == "ground_lease":
        rent = val(land.get("ground_lease_rent_annual")) * rev_mult
        esc = pct(land.get("ground_lease_escalation_pct"))
        hold_m = max(ready + 12, int(round(val(acq.get("hold_years"), 10) * 12)))
        for i in range(ready, hold_m):
            income[i] = rent * (1 + esc) ** ((i - ready) // 12) / 12
        cap = val(land.get("ground_lease_cap")) + adj["exit_cap_bps"] / 100
        fwd = rent * (1 + esc) ** ((hold_m - ready) // 12)
        sales.append((hold_m - 1, fwd / (cap / 100) if cap > 0 else 0.0, usable))
        if cap <= 0:
            warnings.append("Ground lease cap rate is missing.")
    elif method == "build_to_suit":
        sales.append((ready + max(0, int(val(land.get("construction_months")))), val(land.get("bts_sale_price")) * rev_mult, usable))
    else:
        amount = val(land.get("bulk_sale_price")) or usable * val(land.get("bulk_price_per_usable_acre"))
        sales.append((ready, amount * rev_mult, usable))

    end_m = max([m for m, _, _ in sales] + [max(income) if income else 0, ent_m + dev_m - 1, 0])
    n = end_m + 1
    total_acres = sum(ac for _, _, ac in sales) or 1.0
    carry_annual = val(land.get("carry_tax_annual")) + val(land.get("carry_insurance_annual")) + val(land.get("carry_other_annual"))

    use_debt = fin.get("use_debt", False) is True
    loan = price * pct(fin.get("ltv_max")) if use_debt else 0.0
    loan_fee = loan * pct(fin.get("loan_fee_pct"))
    rate = val(fin.get("interest_rate")) + adj["rate_bps"] / 100

    monthly = []
    sold = 0.0
    for i in range(n):
        cost = (ent_cost / ent_m if ent_m and i < ent_m else (ent_cost if ent_m == 0 and i == 0 else 0.0))
        if dev_m and ent_m <= i < ent_m + dev_m:
            cost += dev_cost / dev_m
        elif dev_m == 0 and i == ent_m:
            cost += dev_cost
        carry = carry_annual / 12 * max(0.0, 1 - sold / total_acres)
        gross_sales = sum(amt for m, amt, _ in sales if m == i)
        sold += sum(ac for m, _, ac in sales if m == i)
        interest = loan * rate / 100 / 12
        monthly.append({"revenue": gross_sales + income.get(i, 0.0), "sales": gross_sales, "income": income.get(i, 0.0),
                        "selling_costs": gross_sales * sell_pct, "development": cost, "carry": carry, "interest": interest})

    years_n = max(1, math.ceil(n / 12))
    annual = []
    unlev = [-(price + closing)]
    lev = [-(price + closing + loan_fee) + loan]
    for y in range(years_n):
        chunk = monthly[y * 12:(y + 1) * 12]
        row = {k: sum(m[k] for m in chunk) for k in monthly[0]}
        row["cf_unlevered"] = row["revenue"] - row["selling_costs"] - row["development"] - row["carry"]
        row["debt_service"] = row["interest"]
        row["cf_levered"] = row["cf_unlevered"] - row["interest"] - (loan if y == years_n - 1 else 0.0)
        unlev.append(row["cf_unlevered"])
        lev.append(row["cf_levered"])
        annual.append({**{k: round(v, 2) for k, v in row.items()}, "year": y + 1})

    gross_rev = sum(m["revenue"] for m in monthly)
    total_dev = ent_cost + dev_cost
    total_carry = sum(m["carry"] for m in monthly)
    frontage = val(land.get("frontage_ft"))
    unlev_irr, lev_irr = irr(unlev), irr(lev)
    outputs = {
        "model_type": "land",
        "purchase_price": price,
        "closing_costs": closing,
        "loan_fees": loan_fee,
        "total_capitalization": price + closing + loan_fee,
        "loan_amount": loan,
        "equity": price + closing + loan_fee - loan,
        "interest_rate": rate if loan else None,
        "gross_acres": gross,
        "usable_acres": usable,
        "usable_pct": usable / gross * 100 if gross else None,
        "price_per_gross_acre": price / gross if gross else None,
        "price_per_usable_acre": price / usable if usable else None,
        "price_per_frontage_ft": price / frontage if frontage else None,
        "total_development_cost": total_dev,
        "total_carry": total_carry,
        "gross_revenue": gross_rev,
        "net_revenue": gross_rev - sum(m["selling_costs"] for m in monthly),
        "profit": sum(lev),
        "unlevered_irr": unlev_irr * 100 if unlev_irr is not None else None,
        "irr": lev_irr * 100 if lev_irr is not None else None,
        "equity_multiple": equity_multiple(lev),
        "unlevered_multiple": equity_multiple(unlev),
        "exit_value": sum(amt for _, amt, _ in sales),
        "exit_method": method,
        "peak_equity": peak_equity(lev),
        "hold_years": round(n / 12, 2),
        "noi_year1": None, "going_in_cap": None, "stabilized_cap": None, "dscr": None, "debt_yield": None,
        "cash_on_cash": None, "breakeven_occupancy": None, "exit_cap": None,
        "cash_flows_unlevered": unlev,
        "cash_flows_levered": lev,
    }
    if usable <= 0:
        warnings.append("Usable acreage is zero.")
    return {"annual": annual, "outputs": _round(outputs), "warnings": warnings}


def _round(d: dict) -> dict:
    out: dict = {}
    for k, v in d.items():
        if isinstance(v, float):
            out[k] = round(v, 6) if abs(v) < 100 else round(v, 2)
        elif isinstance(v, list):
            out[k] = [round(x, 2) if isinstance(x, float) else x for x in v]
        elif isinstance(v, dict):
            out[k] = {kk: (round(vv, 2) if isinstance(vv, float) else vv) for kk, vv in v.items()}
        else:
            out[k] = v
    return out


def run(a: dict, adjust: dict | None = None) -> dict:
    """Dispatch to the land or income model by `assumptions.model_type`."""
    return run_land(a, adjust) if a.get("model_type") == "land" else run_income(a, adjust)


# --------------------------------------------------------------------------- sensitivity / tornado

SENSITIVITY_VARS: list[dict[str, Any]] = [
    {"key": "price", "label": "Purchase price", "adjust": "price_pct", "step": 5.0, "unit": "%"},
    {"key": "noi", "label": "NOI / revenue", "adjust": "noi_pct", "step": 5.0, "unit": "%"},
    {"key": "rate", "label": "Interest rate", "adjust": "rate_bps", "step": 50.0, "unit": "bps"},
    {"key": "exit_cap", "label": "Exit cap rate", "adjust": "exit_cap_bps", "step": 25.0, "unit": "bps"},
    {"key": "hold", "label": "Hold period", "adjust": "hold_delta", "step": 1.0, "unit": "yrs"},
]


def sensitivity(a: dict, metric: str = "irr", steps: dict[str, float] | None = None) -> dict:
    """One-way sensitivities. For each variable v with step s, output(metric) is computed at −2s, −s, 0, +s, +2s;
    tornado low/high are the −s/+s values and swing = |high − low|. Rows are sorted by swing (largest first)."""
    base = run(a)["outputs"].get(metric)
    rows = []
    for var in SENSITIVITY_VARS:
        s = float((steps or {}).get(var["key"], var["step"]))
        points = []
        for mult in (-2, -1, 0, 1, 2):
            value = base if mult == 0 else run(a, {var["adjust"]: mult * s})["outputs"].get(metric)
            points.append({"shift": mult * s, "value": value})
        low, high = points[1]["value"], points[3]["value"]
        swing = abs((high or 0) - (low or 0)) if low is not None and high is not None else 0.0
        rows.append({"variable": var["key"], "label": var["label"], "unit": var["unit"], "step": s,
                     "low": low, "high": high, "swing": swing, "points": points})
    rows.sort(key=lambda r: r["swing"], reverse=True)
    return {"metric": metric, "base": base, "rows": rows}


# --------------------------------------------------------------------------- Monte Carlo


def simulate(a: dict, ranges: list[dict], iterations: int = 500, seed: int = 1,
             metrics: tuple[str, ...] = ("irr", "equity_multiple", "exit_value", "noi_year1"),
             target_irr: float | None = None) -> dict:
    """Seeded Monte Carlo over assumption ranges.

    Each iteration draws every range independently — triangular(min, max, mode) when a mode is given, else
    uniform(min, max) — applies them as overrides and runs the model. Reports mean, min/max and the 5/10/25/50/75/90/95th
    percentiles per metric, a 20-bin histogram, and P(IRR < target) when a target is given. N is capped at 2000.
    """
    rng = random.Random(seed)
    n = max(1, min(2000, int(iterations)))
    samples: dict[str, list[float]] = {m: [] for m in metrics}
    clean = [r for r in ranges if r.get("path") and r.get("min") is not None and r.get("max") is not None]
    for _ in range(n):
        overrides: dict[str, float] = {}
        for r in clean:
            lo, hi = float(r["min"]), float(r["max"])
            if lo > hi:
                lo, hi = hi, lo
            mode = r.get("mode")
            overrides[r["path"]] = rng.triangular(lo, hi, float(mode)) if mode is not None and lo <= float(mode) <= hi else rng.uniform(lo, hi)
        outputs = run(apply_overrides(a, overrides))["outputs"]
        for m in metrics:
            v = outputs.get(m)
            if isinstance(v, (int, float)):
                samples[m].append(float(v))

    result: dict[str, Any] = {"iterations": n, "seed": seed, "ranges": clean, "metrics": {}}
    for m, values in samples.items():
        values.sort()
        if not values:
            result["metrics"][m] = {"count": 0}
            continue
        lo, hi = values[0], values[-1]
        width = (hi - lo) / 20 or 1.0
        bins = [0] * 20
        for v in values:
            bins[min(19, int((v - lo) / width))] += 1
        result["metrics"][m] = {
            "count": len(values), "mean": sum(values) / len(values), "min": lo, "max": hi,
            **{f"p{p}": percentile(values, p) for p in (5, 10, 25, 50, 75, 90, 95)},
            "histogram": [{"from": lo + i * width, "to": lo + (i + 1) * width, "count": c} for i, c in enumerate(bins)],
        }
    if target_irr is not None and samples.get("irr"):
        result["prob_irr_below_target"] = sum(1 for v in samples["irr"] if v < target_irr) / len(samples["irr"])
        result["target_irr"] = target_irr
    return result


# --------------------------------------------------------------------------- source linkage

MATERIAL_PATHS: list[tuple[str, str]] = [
    ("acquisition.purchase_price", "Purchase price"),
    ("acquisition.closing_cost_pct", "Closing costs"),
    ("financing.interest_rate", "Interest rate"),
    ("financing.ltv_max", "Maximum LTV"),
    ("financing.dscr_min", "Minimum DSCR"),
    ("financing.debt_yield_min", "Minimum debt yield"),
    ("exit.exit_cap", "Exit cap rate"),
    ("revenue.general_vacancy_pct", "General vacancy"),
    ("revenue.market_rent_growth_pct", "Market rent growth"),
    ("expense_settings.mgmt_fee_pct", "Management fee"),
]
LAND_MATERIAL_PATHS: list[tuple[str, str]] = [
    ("acquisition.purchase_price", "Purchase price"),
    ("land.gross_acres", "Gross acreage"),
    ("land.usable_acres", "Usable acreage"),
    ("land.entitlement_cost", "Entitlement cost"),
    ("land.utilities_cost", "Utilities cost"),
    ("land.site_work_cost", "Site work cost"),
    ("land.bulk_price_per_usable_acre", "Exit price per usable acre"),
    ("land.ground_lease_rent_annual", "Ground lease rent"),
    ("land.ground_lease_cap", "Ground lease cap rate"),
]
LEASE_MATERIAL = [("base_rent_annual", "base rent"), ("market_rent_psf", "market rent"),
                  ("renewal_probability_pct", "renewal probability")]
EXPENSE_MATERIAL = [("annual_amount", "amount")]


def _get(d: Any, path: str) -> Any:
    for part in path.split("."):
        if not isinstance(d, dict):
            return None
        d = d.get(part)
    return d


def unsourced(a: dict) -> list[dict[str, str]]:
    """Material assumptions that carry a value but no source / comp / document link."""
    flags: list[dict[str, str]] = []
    paths = LAND_MATERIAL_PATHS if a.get("model_type") == "land" else MATERIAL_PATHS
    for path, label in paths:
        x = _get(a, path)
        if has_val(x) and not is_sourced(x):
            flags.append({"path": path, "label": label})
    if a.get("model_type") != "land":
        for i, lease in enumerate(a.get("leases") or []):
            if not isinstance(lease, dict) or lease.get("vacant"):
                continue
            name = lease.get("tenant") or lease.get("suite") or f"Lease {i + 1}"
            for key, label in LEASE_MATERIAL:
                x = lease.get(key)
                if has_val(x) and not is_sourced(x):
                    flags.append({"path": f"leases.{i}.{key}", "label": f"{name}: {label}"})
        for i, e in enumerate(a.get("expenses") or []):
            if not isinstance(e, dict):
                continue
            x = e.get("annual_amount")
            if has_val(x) and val(x) != 0 and not is_sourced(x):
                flags.append({"path": f"expenses.{i}.annual_amount", "label": f"{e.get('name') or 'Expense'}: amount"})
    return flags


# --------------------------------------------------------------------------- version diff


def flatten(d: Any, prefix: str = "") -> dict[str, Any]:
    """Flatten assumptions to {dotted.path: value}; sourced values collapse to value plus `#source` entries.
    List items are keyed by their `id` when present (so re-ordering is not reported as a change)."""
    out: dict[str, Any] = {}
    if isinstance(d, dict):
        if "value" in d and set(d) <= {"value", "source", "comp_id", "comp_ids", "comp_set_id", "document_id", "note"}:
            out[prefix] = d.get("value")
            if d.get("source") or d.get("comp_id") or d.get("document_id"):
                out[f"{prefix}#source"] = d.get("source") or d.get("comp_id") or d.get("document_id")
            return out
        for k, v in d.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(d, list):
        for i, item in enumerate(d):
            key = item.get("id") if isinstance(item, dict) and item.get("id") else i
            out.update(flatten(item, f"{prefix}[{key}]"))
    else:
        out[prefix] = d
    return out


def diff_assumptions(old: dict, new: dict) -> list[dict[str, Any]]:
    a, b = flatten(old or {}), flatten(new or {})
    changes = []
    for k in sorted(set(a) | set(b)):
        if a.get(k) != b.get(k):
            changes.append({"path": k, "from": a.get(k), "to": b.get(k)})
    return changes
