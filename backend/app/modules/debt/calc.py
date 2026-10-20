"""Pure debt math (no I/O). All rates are annual percentages (6.5 = 6.5%)."""
from datetime import date
from typing import Any

from app.modules.assets.calc import add_months, months_between


def payment(principal: float, annual_rate_pct: float, months: int) -> float:
    """Level monthly payment (principal + interest)."""
    if principal <= 0 or months <= 0:
        return 0.0
    r = annual_rate_pct / 100 / 12
    if r == 0:
        return principal / months
    return principal * r / (1 - (1 + r) ** -months)


def principal_from_payment(monthly_payment: float, annual_rate_pct: float, months: int | None) -> float:
    """Loan amount supported by a monthly payment (interest-only when months is falsy)."""
    if monthly_payment <= 0:
        return 0.0
    r = annual_rate_pct / 100 / 12
    if not months:
        return monthly_payment / r if r else 0.0
    if r == 0:
        return monthly_payment * months
    return monthly_payment * (1 - (1 + r) ** -months) / r


def _get(loan: Any, key: str) -> Any:
    return loan.get(key) if isinstance(loan, dict) else getattr(loan, key, None)


def io_active(loan: Any, on: date) -> bool:
    io = _get(loan, "io_months") or 0
    orig = _get(loan, "originated_on")
    if not io or not orig:
        return False
    return months_between(orig, on) < io


def remaining_amort_months(loan: Any, on: date) -> int | None:
    amort = _get(loan, "amortization_months")
    if not amort:
        return None
    orig = _get(loan, "originated_on")
    io = _get(loan, "io_months") or 0
    elapsed = max(0, months_between(orig, on) - io) if orig else 0
    return max(12, amort - elapsed)


def monthly_debt_service(loan: Any, on: date | None = None) -> float:
    on = on or date.today()
    bal = float(_get(loan, "current_balance") or 0)
    rate = float(_get(loan, "rate") or 0)
    if bal <= 0:
        return 0.0
    if io_active(loan, on) or not _get(loan, "amortization_months"):
        return bal * rate / 100 / 12
    return payment(bal, rate, remaining_amort_months(loan, on) or 360)


def annual_debt_service(loan: Any, on: date | None = None) -> float:
    return round(monthly_debt_service(loan, on) * 12, 2)


def balance_after(loan: Any, months: int, on: date | None = None) -> float:
    """Projected balance after `months` of scheduled payments from `on`."""
    on = on or date.today()
    bal = float(_get(loan, "current_balance") or 0)
    rate = float(_get(loan, "rate") or 0) / 100 / 12
    for i in range(max(0, months)):
        d = add_months(on, i)
        if io_active(loan, d) or not _get(loan, "amortization_months"):
            continue
        pay = payment(bal, rate * 1200, remaining_amort_months(loan, d) or 360)
        bal -= pay - bal * rate
    return round(max(0.0, bal), 2)


def prepayment_cost(loan: Any, payoff_on: date, treasury_rate_pct: float | None = None) -> dict:
    """Estimate prepayment cost under the loan's prepayment structure.

    prepayment JSON: {type: none|open|lockout|yield_maintenance|defeasance|step_down,
    lockout_end, open_from, step_down: [{until: date, pct}], ym_floor_pct, defeasance_fee}
    """
    p = _get(loan, "prepayment") or {}
    ptype = p.get("type") or "none"
    bal = float(_get(loan, "current_balance") or 0)
    rate = float(_get(loan, "rate") or 0)
    maturity = _get(loan, "maturity_on")
    lines: list[dict] = []
    out = {"type": ptype, "payoff_on": payoff_on.isoformat(), "balance": round(bal, 2), "allowed": True,
           "cost": 0.0, "cost_pct": 0.0, "lines": lines, "explanation": "", "estimate": True}

    def _d(v: Any) -> date | None:
        if not v:
            return None
        return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])

    lockout_end = _d(p.get("lockout_end"))
    open_from = _d(p.get("open_from"))
    if lockout_end and payoff_on < lockout_end:
        out.update(allowed=False, explanation=f"Prepayment is locked out until {lockout_end.isoformat()}.")
        return out
    if open_from and payoff_on >= open_from:
        out["explanation"] = f"Open to prepayment at par from {open_from.isoformat()}."
        return out
    if ptype in ("none", "open") or bal <= 0:
        out["explanation"] = "No prepayment premium."
        return out

    months_left = max(0, months_between(payoff_on, maturity)) if maturity else 0
    tsy = treasury_rate_pct if treasury_rate_pct is not None else float(p.get("treasury_rate") or 4.0)

    if ptype == "step_down":
        pct_ = 0.0
        for step in sorted(p.get("step_down") or [], key=lambda s: str(s.get("until"))):
            until = _d(step.get("until"))
            if until and payoff_on <= until:
                pct_ = float(step.get("pct") or 0)
                break
        cost = bal * pct_ / 100
        lines.append({"label": f"Step-down premium {pct_:g}% of balance", "amount": round(cost, 2)})
        out["explanation"] = "Step-down schedule applied to the outstanding balance."
    elif ptype == "yield_maintenance":
        r = tsy / 100 / 12
        diff = max(0.0, (rate - tsy) / 100 / 12) * bal
        pv = sum(diff / (1 + r) ** (i + 1) for i in range(months_left)) if r > -1 else 0.0
        floor = bal * float(p.get("ym_floor_pct") or 1.0) / 100
        cost = max(pv, floor)
        lines.append({"label": f"PV of rate differential ({rate:g}% vs treasury {tsy:g}%) over {months_left} months",
                      "amount": round(pv, 2)})
        if floor > pv:
            lines.append({"label": f"Minimum premium {float(p.get('ym_floor_pct') or 1.0):g}% applies", "amount": round(floor, 2)})
        out["explanation"] = "Yield maintenance: present value of lost interest discounted at the treasury rate."
    elif ptype == "defeasance":
        r = tsy / 100 / 12
        pay = monthly_debt_service(loan, payoff_on)
        bal_at_maturity = balance_after(loan, months_left, payoff_on)
        pv = sum(pay / (1 + r) ** (i + 1) for i in range(months_left)) + bal_at_maturity / (1 + r) ** max(1, months_left)
        securities = max(0.0, pv - bal)
        fee = float(p.get("defeasance_fee") or 75000)
        cost = securities + fee
        lines.append({"label": f"Treasury portfolio cost above balance (discounted at {tsy:g}%)", "amount": round(securities, 2)})
        lines.append({"label": "Defeasance consultant, legal and servicer fees", "amount": round(fee, 2)})
        out["explanation"] = "Defeasance: cost of a treasury portfolio replicating remaining payments, plus fees."
    else:
        cost = 0.0
        out["explanation"] = "Unrecognised prepayment structure; no premium estimated."

    out["cost"] = round(cost, 2)
    out["cost_pct"] = round(cost / bal * 100, 3) if bal else 0.0
    return out


def size_loan(noi: float | None, value: float | None, rate_pct: float, amort_years: float | None,
              ltv_pct: float | None, dscr: float | None, debt_yield_pct: float | None) -> dict:
    """Max loan under LTV, DSCR and debt-yield constraints; the binding constraint wins."""
    amort_months = int(amort_years * 12) if amort_years else None
    candidates: dict[str, float] = {}
    if value and ltv_pct:
        candidates["ltv"] = value * ltv_pct / 100
    if noi and noi > 0 and dscr:
        candidates["dscr"] = principal_from_payment(noi / dscr / 12, rate_pct, amort_months)
    if noi and noi > 0 and debt_yield_pct:
        candidates["debt_yield"] = noi / (debt_yield_pct / 100)
    if not candidates:
        return {"max_loan": None, "binding": None, "constraints": {}}
    binding = min(candidates, key=lambda k: candidates[k])
    amount = candidates[binding]
    new_ds = payment(amount, rate_pct, amort_months) * 12 if amort_months else amount * rate_pct / 100
    return {
        "max_loan": round(amount, 2),
        "binding": binding,
        "constraints": {k: round(v, 2) for k, v in candidates.items()},
        "annual_debt_service": round(new_ds, 2),
    }


def npv(rate_pct: float, flows: list[float]) -> float:
    r = rate_pct / 100
    return sum(cf / (1 + r) ** i for i, cf in enumerate(flows))


def irr(flows: list[float]) -> float | None:
    """IRR (percent) by bisection on [-99%, 1000%]; None when no sign change."""
    if not flows or all(f >= 0 for f in flows) or all(f <= 0 for f in flows):
        return None
    lo, hi = -0.99, 10.0
    f_lo = sum(cf / (1 + lo) ** i for i, cf in enumerate(flows))
    f_hi = sum(cf / (1 + hi) ** i for i, cf in enumerate(flows))
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = sum(cf / (1 + mid) ** i for i, cf in enumerate(flows))
        if abs(f_mid) < 1e-6:
            break
        if f_lo * f_mid < 0:
            hi = mid
        else:
            lo, f_lo = mid, f_mid
    return round(mid * 100, 3)
