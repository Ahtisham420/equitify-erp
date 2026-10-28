/**
 * List/search/sort/paginate helpers (port of common/query.py). Filter helpers return `SQL | undefined`, so
 * they compose with `and(...)` which ignores undefined:
 *
 *   const where = and(isNull(t.deleted_at), applySearch(p.q, [t.name, t.city]), inFilter(t.status, status));
 *   const [items, total] = await paginate(db, t, where, applySort(p.sort, SORTS, desc(t.updated_at)), p);
 *   return page(items, total, p);
 */
import { and, asc, desc, ilike, inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Db } from "../db";
import type { ListParams } from "../core/router";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export const page = <T>(items: T[], total: number, p: ListParams): Page<T> => ({
  items,
  total,
  page: p.page,
  page_size: p.page_size,
});

/** Every whitespace-separated term must match at least one of the columns. */
export function applySearch(q: string | null | undefined, columns: Array<AnyColumn | SQL>): SQL | undefined {
  if (!q) return undefined;
  const terms = q.split(/\s+/).filter(Boolean);
  return and(...terms.map((term) => or(...columns.map((c) => ilike(c as AnyColumn, `%${term}%`)))));
}

/** `sort` is `field` or `-field`; only keys of `allowed` are honoured. Returns the ORDER BY list. */
export function applySort(
  sort: string | null | undefined,
  allowed: Record<string, AnyColumn | SQL>,
  fallback: AnyColumn | SQL,
): SQL[] {
  if (sort) {
    const isDesc = sort.startsWith("-");
    const col = allowed[sort.replace(/^-+/, "")];
    if (col !== undefined) return [isDesc ? sql`${col} desc nulls last` : sql`${col} asc nulls last`];
  }
  return [fallback as SQL];
}

export const inFilter = (column: AnyColumn | SQL, values?: any[] | null): SQL | undefined =>
  values && values.length ? inArray(column as AnyColumn, values) : undefined;

export function rangeFilter(column: AnyColumn | SQL, low?: any, high?: any): SQL | undefined {
  const parts: SQL[] = [];
  if (low !== undefined && low !== null) parts.push(sql`${column} >= ${low}`);
  if (high !== undefined && high !== null) parts.push(sql`${column} <= ${high}`);
  return parts.length ? and(...parts) : undefined;
}

export async function countWhere(db: Db, table: PgTable, where?: SQL): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return r?.n ?? 0;
}

/** One page of full rows from a single table plus the unpaginated total. */
export async function paginate<T extends PgTable>(
  db: Db,
  table: T,
  where: SQL | undefined,
  orderBy: SQL[],
  p: ListParams,
): Promise<[T["$inferSelect"][], number]> {
  const total = await countWhere(db, table, where);
  const items = await db
    .select()
    .from(table as PgTable)
    .where(where)
    .orderBy(...orderBy)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return [items as T["$inferSelect"][], total];
}

/** Counts per distinct value of `column` within the already-filtered rows. */
export async function facetCounts(db: Db, table: PgTable, where: SQL | undefined, column: PgColumn): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(table)
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export { and, asc, desc };
