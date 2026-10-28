/**
 * Database access. One Postgres connection is reserved per unit of work (an API request or a scheduler job)
 * and used like a SQLAlchemy session: statements run inside an open transaction that `db.commit()` makes
 * durable (and immediately re-opens), and anything uncommitted is rolled back if the work throws.
 *
 * Do NOT use `db.transaction()`; use `db.commit()` / `db.rollback()`.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { settings } from "../config";

const globalForSql = globalThis as unknown as { __eqfSql?: postgres.Sql };

export const sql: postgres.Sql =
  globalForSql.__eqfSql ??
  postgres(settings.DATABASE_URL, {
    max: 20,
    idle_timeout: 30,
    // numeric/date handling is done per-column in db/columns.ts; keep driver defaults for everything else
    onnotice: () => {},
    // PgBouncer-style poolers (Neon "-pooler" hosts) don't support named prepared statements.
    prepare: !/-pooler\./.test(settings.DATABASE_URL),
  });
if (process.env.NODE_ENV !== "production") globalForSql.__eqfSql = sql;

type Extras = {
  /** COMMIT the open transaction and begin a new one (SQLAlchemy `await db.commit()`). */
  commit(): Promise<void>;
  /** ROLLBACK the open transaction and begin a new one. */
  rollback(): Promise<void>;
  /** Callbacks run once after the request's final commit (FastAPI BackgroundTasks equivalent). */
  after: Array<() => Promise<void> | void>;
};
export type Db = PostgresJsDatabase<Record<string, never>> & Extras;

export async function withSession<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  // drizzle's postgres-js driver reads `client.options.{parsers,serializers}`, which a reserved connection lacks.
  if (!(conn as { options?: unknown }).options) (conn as { options?: unknown }).options = sql.options;
  try {
    const base = drizzle(conn as unknown as postgres.Sql);
    const db = base as unknown as Db;
    db.after = [];
    db.commit = async () => {
      await conn.unsafe("COMMIT");
      await conn.unsafe("BEGIN");
    };
    db.rollback = async () => {
      await conn.unsafe("ROLLBACK");
      await conn.unsafe("BEGIN");
    };
    await conn.unsafe("BEGIN");
    try {
      const result = await fn(db);
      await conn.unsafe("COMMIT");
      return result;
    } catch (err) {
      await conn.unsafe("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    conn.release();
  }
}
