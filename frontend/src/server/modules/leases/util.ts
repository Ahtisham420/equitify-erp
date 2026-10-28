/** Small helpers shared by the leases and receivables ports: ISO-date math, number formatting, row persistence. */
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { HttpError } from "../../core/http";
import type { Db } from "../../db";

// --------------------------------------------------------------------------- dates ("YYYY-MM-DD" strings)

const DAY = 86_400_000;
const utc = (s: string): number => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Python `date.today()`. */
export const today = (): string => new Date().toISOString().slice(0, 10);
/** `date` part of a timestamp. */
export const dateOf = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => iso(utc(s) + n * DAY);
/** `(a - b).days` */
export const diffDays = (a: string, b: string): number => Math.round((utc(a) - utc(b)) / DAY);
export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const ymd = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
export const yearOf = (s: string): number => Number(s.slice(0, 4));

export function addMonths(s: string, months: number): string {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = (((total % 12) + 12) % 12) + 1;
  return ymd(year, month, Math.min(d, daysInMonth(year, month)));
}

export function monthEnd(s: string): string {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return ymd(y, m, daysInMonth(y, m));
}

/** `_as_date`: tolerant coercion to "YYYY-MM-DD" (null when unparseable). */
export function asDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) return null;
  return s;
}

export const minDate = (...ds: string[]): string => ds.reduce((a, b) => (b < a ? b : a));
export const maxDate = (...ds: string[]): string => ds.reduce((a, b) => (b > a ? b : a));

/** Python `strftime("%B %d, %Y")` */
export function longDate(s: string): string {
  const d = new Date(utc(s));
  return `${d.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}`;
}
/** Python `strftime("%b %Y")` */
export function shortMonthYear(s: string): string {
  const d = new Date(utc(s));
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

// --------------------------------------------------------------------------- numbers

/** Python `float(v)` tolerant of blanks (`_num`). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Python `round(x, n)` (half away from zero). */
export function round(x: number, n = 0): number {
  const f = 10 ** n;
  return (Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9)) / f;
}

/** Python `f"{x:,.{n}f}"` */
export const money = (x: number, n = 2): string =>
  x.toLocaleString("en-US", { minimumFractionDigits: n, maximumFractionDigits: n });

/** Python `f"{x:g}"` */
export const fmtG = (x: number): string => String(Number(x.toPrecision(6)));

/** Python `str.title()` */
export const titleCase = (s: string): string => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

// --------------------------------------------------------------------------- persistence

type IdTable = PgTable & { id: any };

/** Persist every column of an in-memory row (SQLAlchemy flushed whatever was mutated). `updated_at` is bumped by the table. */
export async function save<T extends IdTable>(db: Db, table: T, row: T["$inferSelect"]): Promise<void> {
  const { id, created_at: _c, updated_at: _u, ...rest } = row as Record<string, any>;
  await db.update(table).set(rest as never).where(eq(table.id, id));
}

/** `async with db.begin_nested():` — a SAVEPOINT. HttpErrors are swallowed when `swallow` is true (rolled back). */
export async function nested<T>(db: Db, fn: () => Promise<T>, swallow = false): Promise<T | undefined> {
  await db.execute(sql`savepoint eqf_nested`);
  try {
    const result = await fn();
    await db.execute(sql`release savepoint eqf_nested`);
    return result;
  } catch (err) {
    await db.execute(sql`rollback to savepoint eqf_nested`);
    await db.execute(sql`release savepoint eqf_nested`);
    if (swallow && err instanceof HttpError) return undefined;
    throw err;
  }
}

/** Pydantic-style model_dump of a record: pick `keys`, missing -> null. */
export const pick = (row: Record<string, any>, keys: readonly string[]): Record<string, any> =>
  Object.fromEntries(keys.map((k) => [k, row[k] === undefined ? null : row[k]]));
