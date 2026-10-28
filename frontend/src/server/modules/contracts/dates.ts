/** "YYYY-MM-DD" date helpers (the `date` columns are strings). All math is UTC; weekdays use Python numbering (Mon=0). */
import { utcnow } from "../../core/security";

const DAY_MS = 86_400_000;

export const today = (): string => utcnow().toISOString().slice(0, 10);
export const toDate = (s: string): Date => new Date(`${s.slice(0, 10)}T00:00:00Z`);
export const iso = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => iso(new Date(toDate(s).getTime() + n * DAY_MS));
/** a - b in whole days. */
export const diffDays = (a: string, b: string): number => Math.round((toDate(a).getTime() - toDate(b).getTime()) / DAY_MS);
/** Python `date.weekday()`: Monday = 0 ... Sunday = 6. */
export const weekday = (s: string): number => (toDate(s).getUTCDay() + 6) % 7;
export const yearOf = (s: string): number => Number(s.slice(0, 4));
export const ymd = (y: number, m: number, d: number): string => iso(new Date(Date.UTC(y, m - 1, d)));
export const endOfDay = (s: string): Date => new Date(`${s.slice(0, 10)}T23:59:00Z`);
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && iso(d) === s;
}
