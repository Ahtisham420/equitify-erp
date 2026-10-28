/**
 * Small, deterministic date/number helpers shared by the ownership modules (assets, debt, dispositions).
 * Dates are "YYYY-MM-DD" strings (Drizzle `date` columns in string mode); all date math is done in UTC.
 */

export const todayStr = (): string => new Date().toISOString().slice(0, 10);

/** Normalises a Date / ISO timestamp / "YYYY-MM-DD" to "YYYY-MM-DD". */
export const isoDate = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

const ymd = (s: string): [number, number, number] => [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
const fmtYmd = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const ordinal = (s: string): number => {
  const [y, m, d] = ymd(s);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function monthStart(d: string): string {
  return `${d.slice(0, 8)}01`;
}

export function addMonths(d: string, n: number): string {
  const [y, m, day] = ymd(d);
  const total = m - 1 + n;
  const year = y + Math.floor(total / 12);
  const month = (((total % 12) + 12) % 12) + 1;
  return fmtYmd(year, month, Math.min(day, daysInMonth(year, month)));
}

export function addDays(d: string, n: number): string {
  return new Date((ordinal(d) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** `(a - b).days` */
export const daysBetween = (a: string, b: string): number => ordinal(a) - ordinal(b);

/** Whole calendar months from start to end (negative when end precedes start). */
export function monthsBetween(start: string, end: string): number {
  const [sy, sm] = ymd(start);
  const [ey, em] = ymd(end);
  return (ey - sy) * 12 + (em - sm);
}

export function monthRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = monthStart(start);
  while (cur <= end) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

/** Python `round(v, digits)`: correctly rounded on the binary value, ties to even. */
export function pyRound(v: number, digits = 0): number {
  if (!Number.isFinite(v)) return v;
  const abs = Math.abs(v);
  const sign = v < 0 ? -1 : 1;
  const long = abs.toFixed(Math.min(100, digits + 30));
  const dot = long.indexOf(".");
  const cut = dot + 1 + digits;
  if (/^50*$/.test(long.slice(cut))) {
    const trunc = long.slice(0, digits === 0 ? dot : cut);
    const last = Number(trunc[trunc.length - 1]);
    if (last % 2 === 0) return sign * Number(trunc);
  }
  return sign * Number(abs.toFixed(digits));
}

export function safeDiv(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || !b) return null;
  return a / b;
}

export function pct(part: number | null | undefined, whole: number | null | undefined, digits = 2): number | null {
  const r = safeDiv(part, whole);
  return r === null ? null : pyRound(r * 100, digits);
}

export function r2(v: number | null | undefined, digits = 2): number | null {
  return v === null || v === undefined ? null : pyRound(Number(v), digits);
}

export function normKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/,/g, " ").replace(/\./g, " ").split(/\s+/).filter(Boolean).join(" ");
}

// ---- Python formatting helpers (f-strings / str()) used in user-visible messages ----

/** Python `str(x)` for values that are floats in Python (1000.0 -> "1000.0"), None -> "None". */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 1e16 ? `${v}.0` : String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** f"{v:.{d}f}" */
export const fmtFixed = (v: number, d: number): string => pyRound(v, d).toFixed(d);

/** f"{v:,.{d}f}" */
export function fmtMoney(v: number, d: number): string {
  const s = fmtFixed(v, d);
  const neg = s.startsWith("-");
  const [int, frac] = (neg ? s.slice(1) : s).split(".");
  return `${neg ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

/** f"{v:g}" */
export function fmtG(v: number): string {
  if (v === 0) return "0";
  if (!Number.isFinite(v)) return String(v);
  const exp = Math.floor(Math.log10(Math.abs(Number(v.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const mant = Number((v / 10 ** exp).toPrecision(6)).toString();
    return `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return Number(v.toPrecision(6)).toString();
}

/** `urllib.parse.quote(s)` (safe="/"). */
export function pyQuote(s: string): string {
  return encodeURIComponent(s)
    .replace(/%2F/g, "/")
    .replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** strftime("%b %Y") */
export const fmtMonthYear = (d: string): string => `${MONTH_ABBR[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
