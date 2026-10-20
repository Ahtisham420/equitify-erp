"""Small, deterministic date/number helpers shared by the ownership modules (assets, debt, dispositions)."""
import calendar
from datetime import date


def month_start(d: date) -> date:
    return d.replace(day=1)


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    year, month = d.year + y, m + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def add_days(d: date, n: int) -> date:
    return date.fromordinal(d.toordinal() + n)


def months_between(start: date, end: date) -> int:
    """Whole calendar months from start to end (negative when end precedes start)."""
    return (end.year - start.year) * 12 + (end.month - start.month)


def month_range(start: date, end: date) -> list[date]:
    out, cur = [], month_start(start)
    while cur <= end:
        out.append(cur)
        cur = add_months(cur, 1)
    return out


def safe_div(a: float | None, b: float | None) -> float | None:
    if a is None or not b:
        return None
    return a / b


def pct(part: float | None, whole: float | None, digits: int = 2) -> float | None:
    r = safe_div(part, whole)
    return None if r is None else round(r * 100, digits)


def r2(v: float | None, digits: int = 2) -> float | None:
    return None if v is None else round(float(v), digits)


def norm_key(value: str | None) -> str:
    return " ".join((value or "").lower().replace(",", " ").replace(".", " ").split())
