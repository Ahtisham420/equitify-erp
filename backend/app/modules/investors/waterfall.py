"""Pure, deterministic capital-account and distribution-waterfall math.

No I/O and no database access: every function takes plain values and returns plain values so the
results can be reproduced by an independent model (spreadsheet) and tested in isolation.

Conventions
- Amounts are floats; allocations are rounded to cents at tier level and pennies of rounding drift
  are assigned to the largest share so every tier sums exactly to the amount it distributes.
- Dates are `datetime.date`. Rates/hurdles are annual fractions (0.08 = 8%). Shares are fractions.
- Ownership weights may be expressed in any unit (percent or fraction); they are normalised per class.
"""
from __future__ import annotations

from calendar import isleap
from dataclasses import dataclass, field
from datetime import date

EPS = 0.005  # half a cent


def round2(x: float) -> float:
    return round(float(x) + 0.0, 2) + 0.0


# --------------------------------------------------------------------------- day count

def year_fraction(start: date, end: date, basis: str = "act_365") -> float:
    """Year fraction between two dates.

    act_365: (end - start).days / 365
    act_360: (end - start).days / 360
    30_360 (US bond basis): [360·(Y2−Y1) + 30·(M2−M1) + (D2−D1)] / 360,
        with D1 = min(D1, 30) and D2 = 30 when D2 = 31 and D1 ≥ 30.
    """
    if end <= start:
        return 0.0
    if basis == "act_360":
        return (end - start).days / 360.0
    if basis == "30_360":
        d1 = min(start.day, 30)
        d2 = 30 if (end.day == 31 and d1 >= 30) else end.day
        return (360 * (end.year - start.year) + 30 * (end.month - start.month) + (d2 - d1)) / 360.0
    return (end - start).days / 365.0


def add_years(d: date, years: int) -> date:
    """Anniversary date; 29 Feb rolls to 28 Feb in non-leap years."""
    y = d.year + years
    if d.month == 2 and d.day == 29 and not isleap(y):
        return date(y, 2, 28)
    return d.replace(year=y)


# --------------------------------------------------------------------------- preferred return accrual

@dataclass
class Flow:
    on: date
    kind: str  # 'contribution' | 'return_of_capital' | 'pref_paid'
    amount: float  # reversals arrive as negative amounts


_FLOW_ORDER = {"contribution": 0, "return_of_capital": 1, "pref_paid": 2}


def pref_accrual(
    flows: list[Flow], rate: float, as_of: date, basis: str = "act_365", compounding: str = "simple"
) -> dict:
    """Accrued preferred return on unreturned capital, by day count.

    Between consecutive checkpoint dates d_k < d_{k+1}:
        accrual_k = B_k · rate · yf(d_k, d_{k+1}, basis)
    where B_k is the accrual base after all flows dated d_k:
        simple:  B = unreturned capital
        annual:  B = unreturned capital + capitalised unpaid pref (unpaid pref is capitalised on each
                 anniversary of the first contribution, i.e. compounded annually).
    Flows: contribution → capital += amount; return_of_capital → capital = max(0, capital − amount);
    pref_paid → reduces the uncapitalised unpaid balance first, then the capitalised balance.

    Returns {accrued_total, paid, unpaid, unreturned_capital, contributed, returned}.
    """
    flows = sorted((f for f in flows if f.on <= as_of), key=lambda f: (f.on, _FLOW_ORDER.get(f.kind, 9)))
    capital = contributed = returned = 0.0
    open_pref = cap_pref = accrued_total = paid = 0.0
    if not flows:
        return {"accrued_total": 0.0, "paid": 0.0, "unpaid": 0.0, "unreturned_capital": 0.0,
                "contributed": 0.0, "returned": 0.0}

    contrib_dates = [f.on for f in flows if f.kind == "contribution" and f.amount > 0]
    first = min(contrib_dates) if contrib_dates else flows[0].on
    anniversaries: set[date] = set()
    if compounding == "annual":
        n = 1
        while (d := add_years(first, n)) <= as_of:
            anniversaries.add(d)
            n += 1

    by_date: dict[date, list[Flow]] = {}
    for f in flows:
        by_date.setdefault(f.on, []).append(f)
    checkpoints = sorted(set(by_date) | anniversaries | {as_of})

    prev: date | None = None
    for d in checkpoints:
        if prev is not None and rate > 0:
            a = (capital + cap_pref) * rate * year_fraction(prev, d, basis)
            open_pref += a
            accrued_total += a
        if d in anniversaries:
            cap_pref += open_pref
            open_pref = 0.0
        for f in by_date.get(d, []):
            if f.kind == "contribution":
                capital += f.amount
                contributed += f.amount
            elif f.kind == "return_of_capital":
                returned += f.amount
                capital = max(0.0, capital - f.amount)
            elif f.kind == "pref_paid":
                paid += f.amount
                take = min(open_pref, f.amount)
                open_pref -= take
                rest = f.amount - take
                if rest > 0:
                    cap_pref = max(0.0, cap_pref - rest)
        prev = d

    return {
        "accrued_total": accrued_total,
        "paid": paid,
        "unpaid": max(0.0, open_pref + cap_pref),
        "unreturned_capital": max(0.0, capital),
        "contributed": contributed,
        "returned": returned,
    }


# --------------------------------------------------------------------------- IRR / multiple

def xnpv(rate: float, flows: list[tuple[date, float]]) -> float:
    """NPV = Σ CF_i / (1 + rate)^((d_i − d_0)/365)."""
    t0 = flows[0][0]
    return sum(cf / (1.0 + rate) ** ((d - t0).days / 365.0) for d, cf in flows)


def xirr(flows: list[tuple[date, float]], lo: float = -0.99, hi: float = 10.0,
         tol: float = 1e-8, max_iter: int = 300) -> float | None:
    """Annualised IRR r with xnpv(r) = 0 (Act/365), solved by bisection on [lo, hi].

    Guard rails: returns None unless there is at least one negative and one positive flow and the
    NPV changes sign on the bracket. Bisection is monotone and deterministic.
    """
    flows = sorted((d, float(cf)) for d, cf in flows if abs(cf) > 1e-9)
    if not flows or not any(cf < 0 for _, cf in flows) or not any(cf > 0 for _, cf in flows):
        return None
    f_lo, f_hi = xnpv(lo, flows), xnpv(hi, flows)
    if f_lo == 0:
        return lo
    if f_lo * f_hi > 0:
        return None
    for _ in range(max_iter):
        mid = (lo + hi) / 2.0
        f_mid = xnpv(mid, flows)
        if abs(f_mid) < tol or (hi - lo) / 2.0 < tol:
            return mid
        if (f_lo < 0) == (f_mid < 0):
            lo, f_lo = mid, f_mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def equity_multiple(contributed: float, distributed: float) -> float | None:
    """Equity multiple = total distributions / total contributions."""
    return distributed / contributed if contributed > 0 else None


# --------------------------------------------------------------------------- allocation helpers

def split_pro_rata(total: float, weights: dict[str, float]) -> dict[str, float]:
    """Allocate `total` (rounded to cents) by weight; cent drift goes to the largest weight.
    With all-zero weights the amount is split equally."""
    total = round2(total)
    keys = list(weights)
    if not keys:
        return {}
    w = {k: max(0.0, float(weights[k] or 0)) for k in keys}
    s = sum(w.values())
    if s <= 0:
        w = {k: 1.0 for k in keys}
        s = float(len(keys))
    out = {k: round2(total * w[k] / s) for k in keys}
    drift = round2(total - sum(out.values()))
    if drift:
        top = max(keys, key=lambda k: w[k])
        out[top] = round2(out[top] + drift)
    return out


# --------------------------------------------------------------------------- waterfall

@dataclass
class PartnerPosition:
    investment_id: str
    partner_id: str
    name: str
    position: str  # 'lp' | 'gp'
    ownership_pct: float
    commitment: float = 0.0
    contributed: float = 0.0
    unfunded: float = 0.0
    unreturned_capital: float = 0.0
    pref_unpaid: float = 0.0
    distributed_to_date: float = 0.0
    profit_to_date: float = 0.0  # preferred_return + catch_up + profit components received before this event
    cash_flows: list[tuple[date, float]] = field(default_factory=list)  # contributions < 0, distributions > 0


@dataclass
class Tier:
    position: int
    tier_type: str  # return_of_capital | preferred_return | catch_up | split
    name: str = ""
    hurdle_type: str = "none"  # none | irr | equity_multiple (split tiers only)
    hurdle_value: float | None = None  # IRR as fraction (0.15) or multiple (1.8)
    lp_share: float = 1.0
    gp_share: float = 0.0
    catch_up_rate: float = 1.0  # share of catch-up dollars paid to GP
    catch_up_target: float = 0.2  # GP target share of cumulative profit


def run_waterfall(amount: float, event_date: date, partners: list[PartnerPosition], tiers: list[Tier]) -> dict:
    """Allocate a distribution (or net liquidation proceeds) through ordered tiers.

    Tier formulas (R = amount still undistributed when the tier starts):
    - return_of_capital: pay = min(R, Σ unreturned capital_i); allocated pro rata to unreturned capital.
    - preferred_return:  pay = min(R, Σ unpaid accrued pref_i);  allocated pro rata to unpaid pref.
    - catch_up: GP receives rate r of each dollar until GP holds target t of cumulative profit P
        (P = pref + catch-up + split dollars, prior events included). With G = GP profit to date:
            need = max(0, (t·P − G) / (r − t)),  pay = min(R, need)
        GP gets r·pay, LPs get (1 − r)·pay. Requires r > t and at least one GP position.
    - split: pay is divided lp_share / gp_share (normalised) until the LP class reaches its hurdle:
        none:            pay = R
        equity_multiple: pay = min(R, max(0, M·C_lp − D_lp) / lp_share)
                         (C_lp = LP contributions, D_lp = LP distributions incl. this event so far)
        irr:             pay = smallest x ≤ R with XIRR(LP flows + lp_share·x at event date) ≥ hurdle,
                         found by bisection (LP IRR is monotone increasing in x).
    Within a class (LP or GP) amounts are allocated pro rata to ownership_pct.
    Anything left after the last tier is distributed pro rata to ownership ("residual") and flagged.
    """
    amount = round2(amount)
    warnings: list[str] = []
    ids = [p.investment_id for p in partners]
    by_id = {p.investment_id: p for p in partners}
    lps = [p for p in partners if p.position != "gp"]
    gps = [p for p in partners if p.position == "gp"]

    unreturned = {p.investment_id: max(0.0, p.unreturned_capital) for p in partners}
    pref = {p.investment_id: max(0.0, p.pref_unpaid) for p in partners}
    got = {i: 0.0 for i in ids}
    breakdown: dict[str, list[dict]] = {i: [] for i in ids}
    lp_profit = sum(p.profit_to_date for p in lps)
    gp_profit = sum(p.profit_to_date for p in gps)
    lp_contrib = sum(p.contributed for p in lps)
    lp_dist_prior = sum(p.distributed_to_date for p in lps)
    lp_hist: list[tuple[date, float]] = [cf for p in lps for cf in p.cash_flows]
    lp_event = 0.0  # LP dollars allocated so far in this event

    def lp_irr(extra: float) -> float | None:
        return xirr(lp_hist + [(event_date, lp_event + extra)])

    def credit(alloc: dict[str, float], tier: Tier, component: str) -> None:
        for inv_id, amt in alloc.items():
            if abs(amt) < 0.005:
                continue
            got[inv_id] = round2(got[inv_id] + amt)
            breakdown[inv_id].append({"tier": tier.position, "name": tier.name or tier.tier_type,
                                      "tier_type": tier.tier_type, "component": component, "amount": amt})

    def own(group: list[PartnerPosition]) -> dict[str, float]:
        return {p.investment_id: p.ownership_pct for p in group}

    remaining = amount
    tier_rows: list[dict] = []
    for tier in sorted(tiers, key=lambda t: t.position):
        row = {"position": tier.position, "name": tier.name or tier.tier_type, "tier_type": tier.tier_type,
               "hurdle_type": tier.hurdle_type, "hurdle_value": tier.hurdle_value,
               "amount": 0.0, "lp_amount": 0.0, "gp_amount": 0.0}
        if remaining <= EPS:
            tier_rows.append(row)
            continue
        alloc: dict[str, float] = {}
        component = tier.tier_type

        if tier.tier_type == "return_of_capital":
            pay = round2(min(remaining, sum(unreturned.values())))
            alloc = split_pro_rata(pay, unreturned) if pay > 0 else {}
            for k, v in alloc.items():
                unreturned[k] = max(0.0, unreturned[k] - v)

        elif tier.tier_type == "preferred_return":
            pay = round2(min(remaining, sum(pref.values())))
            alloc = split_pro_rata(pay, pref) if pay > 0 else {}
            for k, v in alloc.items():
                pref[k] = max(0.0, pref[k] - v)
            lp_profit += sum(v for k, v in alloc.items() if by_id[k].position != "gp")
            gp_profit += sum(v for k, v in alloc.items() if by_id[k].position == "gp")

        elif tier.tier_type == "catch_up":
            r, t = float(tier.catch_up_rate or 0), float(tier.catch_up_target or 0)
            if not gps:
                warnings.append(f"Tier {tier.position}: catch-up skipped — no GP position on this asset.")
                pay = 0.0
            elif r <= t:
                warnings.append(f"Tier {tier.position}: catch-up rate must exceed the target share; skipped.")
                pay = 0.0
            else:
                need = max(0.0, (t * (lp_profit + gp_profit) - gp_profit) / (r - t))
                pay = round2(min(remaining, need))
                gp_part = round2(pay * r) if lps else pay
                alloc = {**split_pro_rata(gp_part, own(gps)), **(split_pro_rata(round2(pay - gp_part), own(lps)) if lps else {})}
                gp_profit += gp_part
                lp_profit += round2(pay - gp_part)

        elif tier.tier_type == "split":
            lp_s, gp_s = max(0.0, float(tier.lp_share or 0)), max(0.0, float(tier.gp_share or 0))
            if not gps and gp_s > 0:
                warnings.append(f"Tier {tier.position}: no GP position — GP share paid to LPs.")
                lp_s, gp_s = 1.0, 0.0
            if not lps and lp_s > 0:
                lp_s, gp_s = 0.0, 1.0
            tot = lp_s + gp_s or 1.0
            lp_s, gp_s = lp_s / tot, gp_s / tot
            hv = tier.hurdle_value
            if tier.hurdle_type == "equity_multiple" and hv is not None and lp_s > 0:
                if lp_contrib <= 0:
                    warnings.append(f"Tier {tier.position}: no LP contributions — multiple hurdle not measurable.")
                    pay = remaining
                else:
                    need_lp = max(0.0, hv * lp_contrib - (lp_dist_prior + lp_event))
                    pay = round2(min(remaining, need_lp / lp_s))
            elif tier.hurdle_type == "irr" and hv is not None and lp_s > 0:
                base = lp_irr(0.0)
                full = lp_irr(lp_s * remaining)
                if full is None:
                    warnings.append(f"Tier {tier.position}: LP IRR not measurable — tier applied to the full remainder.")
                    pay = remaining
                elif base is not None and base >= hv:
                    pay = 0.0
                elif full <= hv:
                    pay = remaining
                else:
                    lo, hi = 0.0, remaining
                    for _ in range(80):
                        mid = (lo + hi) / 2.0
                        irr_mid = lp_irr(lp_s * mid)
                        if irr_mid is not None and irr_mid >= hv:
                            hi = mid
                        else:
                            lo = mid
                        if hi - lo < 0.001:
                            break
                    pay = round2(hi)
            else:
                pay = remaining
            pay = round2(min(pay, remaining))
            lp_part = round2(pay * lp_s)
            gp_part = round2(pay - lp_part)
            alloc = {**(split_pro_rata(lp_part, own(lps)) if lps else {}), **(split_pro_rata(gp_part, own(gps)) if gps else {})}
            component = "profit"
            lp_profit += lp_part
            gp_profit += gp_part
        else:
            warnings.append(f"Tier {tier.position}: unknown tier type '{tier.tier_type}' ignored.")
            pay = 0.0

        credit(alloc, tier, component)
        tier_lp = round2(sum(v for k, v in alloc.items() if by_id[k].position != "gp"))
        tier_gp = round2(sum(v for k, v in alloc.items() if by_id[k].position == "gp"))
        lp_event += tier_lp
        row.update(amount=round2(tier_lp + tier_gp), lp_amount=tier_lp, gp_amount=tier_gp,
                   lp_irr_after=lp_irr(0.0), lp_multiple_after=equity_multiple(lp_contrib, lp_dist_prior + lp_event))
        tier_rows.append(row)
        remaining = round2(remaining - tier_lp - tier_gp)

    if remaining > EPS and partners:
        warnings.append(f"{remaining:,.2f} remained after the last tier and was allocated pro rata to ownership.")
        residual_tier = Tier(position=(max((t.position for t in tiers), default=0) + 1), tier_type="residual", name="Residual")
        alloc = split_pro_rata(remaining, own(partners))
        credit(alloc, residual_tier, "residual")
        tier_rows.append({"position": residual_tier.position, "name": "Residual", "tier_type": "residual",
                          "hurdle_type": "none", "hurdle_value": None, "amount": remaining,
                          "lp_amount": round2(sum(v for k, v in alloc.items() if by_id[k].position != "gp")),
                          "gp_amount": round2(sum(v for k, v in alloc.items() if by_id[k].position == "gp"))})
        remaining = 0.0

    allocations = [
        {
            "investment_id": p.investment_id,
            "partner_id": p.partner_id,
            "name": p.name,
            "position": p.position,
            "ownership_pct": p.ownership_pct,
            "amount": got[p.investment_id],
            "tiers": breakdown[p.investment_id],
            "unreturned_capital_before": round2(p.unreturned_capital),
            "pref_unpaid_before": round2(p.pref_unpaid),
        }
        for p in partners
    ]
    return {"amount": amount, "allocated": round2(sum(got.values())), "tiers": tier_rows,
            "allocations": allocations, "warnings": warnings}


def allocate_call(amount: float, partners: list[PartnerPosition]) -> dict:
    """Capital call: amount_i = amount · commitment_i / Σ commitment (cent drift to the largest).
    Calls that exceed a partner's unfunded commitment are flagged, not silently capped."""
    amount = round2(amount)
    warnings: list[str] = []
    alloc = split_pro_rata(amount, {p.investment_id: p.commitment for p in partners})
    rows = []
    for p in partners:
        a = alloc.get(p.investment_id, 0.0)
        over = a > p.unfunded + EPS
        if over:
            warnings.append(f"{p.name}: call of {a:,.2f} exceeds unfunded commitment of {p.unfunded:,.2f}.")
        rows.append({"investment_id": p.investment_id, "partner_id": p.partner_id, "name": p.name,
                     "position": p.position, "ownership_pct": p.ownership_pct, "commitment": p.commitment,
                     "unfunded_before": round2(p.unfunded), "exceeds_unfunded": over, "amount": a,
                     "tiers": [{"tier": 0, "name": "Capital call", "tier_type": "call", "component": "contribution",
                                "amount": a}]})
    return {"amount": amount, "allocated": round2(sum(r["amount"] for r in rows)),
            "tiers": [{"position": 0, "name": "Capital call (pro rata to commitment)", "tier_type": "call",
                       "hurdle_type": "none", "hurdle_value": None, "amount": amount,
                       "lp_amount": round2(sum(r["amount"] for r in rows if r["position"] != "gp")),
                       "gp_amount": round2(sum(r["amount"] for r in rows if r["position"] == "gp"))}],
            "allocations": rows, "warnings": warnings}


def late_interest(shortfall: float, annual_rate: float, due_on: date, as_of: date, basis: str = "act_365") -> float:
    """Default interest on an unfunded call: shortfall · rate · yf(due_on, as_of)."""
    if shortfall <= 0 or as_of <= due_on or annual_rate <= 0:
        return 0.0
    return round2(shortfall * annual_rate * year_fraction(due_on, as_of, basis))
