/**
 * Date/number helpers the Python service took from `assets.calc` (add_days, add_months, norm_key, pct, r2),
 * implemented on "YYYY-MM-DD" strings so this module does not depend on the assets port's helper signatures.
 */

const parse = (d: string): Date => new Date(`${d.slice(0, 10)}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);

export const todayStr = (): string => new Date().toISOString().slice(0, 10);

export function addDays(d: string, n: number): string {
  const x = parse(d);
  x.setUTCDate(x.getUTCDate() + n);
  return iso(x);
}

export function addMonths(d: string, n: number): string {
  const x = parse(d);
  const total = x.getUTCMonth() + n;
  const year = x.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(year, month, Math.min(x.getUTCDate(), lastDay))));
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export const daysBetween = (a: string, b: string): number => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);

/** Non-null variant of r2 for plain numbers. */
export const rr = (v: number, digits = 2): number => Math.round(v * 10 ** digits) / 10 ** digits;

export function r2(v: number | null | undefined, digits = 2): number | null {
  if (v === null || v === undefined) return null;
  const f = 10 ** digits;
  return Math.round(Number(v) * f) / f;
}

export function pct(part: number | null | undefined, whole: number | null | undefined, digits = 2): number | null {
  if (part === null || part === undefined || !whole) return null;
  return r2((part / whole) * 100, digits);
}

export const normKey = (value: string | null | undefined): string =>
  (value ?? "").toLowerCase().replaceAll(",", " ").replaceAll(".", " ").split(/\s+/).filter(Boolean).join(" ");

export const fmt0 = (v: number): string => Math.round(v).toLocaleString("en-US");
