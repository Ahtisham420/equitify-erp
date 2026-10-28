/** Node-only startup work (kept out of instrumentation.ts so the edge bundle never traces these imports). */
export async function startup() {
  const { sql: pg, withSession } = await import("@/server/db");
  const { settings } = await import("@/server/config");
  await import("@/server/registry.generated"); // registers domain event handlers

  try {
    await pg`CREATE EXTENSION IF NOT EXISTS postgis`;
    await pg`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    const { seed } = await import("@/server/modules/auth/service");
    await withSession((db) => seed(db));
  } catch (err) {
    console.error(
      "[startup] Database is not ready (is Postgres running and the schema created? run `npm run db:push`).",
      err instanceof Error ? err.message : err,
    );
  }

  if (settings.SCHEDULER_ENABLED) {
    const { startScheduler } = await import("@/server/core/scheduler");
    startScheduler();
  }
}
