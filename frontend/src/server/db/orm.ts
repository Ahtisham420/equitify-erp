/** Thin helpers that give Drizzle the get/add/mutate/delete ergonomics the old SQLAlchemy services relied on. */
import { eq, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Db } from "./index";

type Row<T extends PgTable> = T["$inferSelect"];
type Values<T extends PgTable> = T["$inferInsert"];
type IdTable = PgTable & { id: any };

/** `db.get(Model, id)` -> row | undefined */
export async function get<T extends IdTable>(db: Db, table: T, id: string): Promise<Row<T> | undefined> {
  const [row] = await db.select().from(table as PgTable).where(eq(table.id, id)).limit(1);
  return row as Row<T> | undefined;
}

/** `db.add(Model(**values)); await db.flush()` -> the inserted row (defaults applied). */
export async function insert<T extends PgTable>(db: Db, table: T, values: Values<T>): Promise<Row<T>> {
  const [row] = await db.insert(table).values(values as never).returning();
  return row as Row<T>;
}

export async function insertMany<T extends PgTable>(db: Db, table: T, values: Values<T>[]): Promise<Row<T>[]> {
  if (!values.length) return [];
  return (await db.insert(table).values(values as never).returning()) as Row<T>[];
}

/** `obj.a = x; obj.b = y` + flush: updates the DB row and the in-memory object, returns the object. */
export async function patch<T extends IdTable>(
  db: Db,
  table: T,
  row: Row<T>,
  values: Partial<Values<T>>,
): Promise<Row<T>> {
  const [updated] = await db
    .update(table)
    .set(values as never)
    .where(eq(table.id, (row as { id: string }).id))
    .returning();
  if (updated) Object.assign(row as object, updated);
  return row;
}

/** `await db.delete(obj)` */
export async function remove<T extends IdTable>(db: Db, table: T, row: Row<T>): Promise<void> {
  await db.delete(table).where(eq(table.id, (row as { id: string }).id));
}

/** Rows from a raw `db.execute(sql`...`)` as a plain array. */
export async function raw<R = Record<string, any>>(db: Db, query: SQL): Promise<R[]> {
  return Array.from((await db.execute(query)) as unknown as R[]);
}

/** COUNT(*) helper: `await count(db, table, where)` */
export async function count(db: Db, table: PgTable, where?: SQL): Promise<number> {
  const { sql: s } = await import("drizzle-orm");
  const [r] = await db.select({ n: s<number>`count(*)::int` }).from(table).where(where);
  return r?.n ?? 0;
}
