/**
 * In-process scheduler for the periodic automations (critical dates, escalations, scans...).
 *
 * Every job is idempotent (the services key their tasks/alerts), runs in its own session as the
 * "System Automation" service user, and takes a Postgres advisory lock so that several server instances
 * never run the same job concurrently. Disable with SCHEDULER_ENABLED=false on extra instances if wanted.
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "../db";
import { withSession } from "../db";
import { insert } from "../db/orm";
import { roles, users } from "../modules/auth/schema";
import { CurrentUser, loadUser } from "./deps";
import { utcnow } from "./security";

const SYSTEM_EMAIL = "system@equitify.local";
const TICK_MS = 60_000;

interface Job {
  key: string;
  everyMinutes: number;
  /** Lazily imports the service module so a missing module only skips its job. */
  run: (db: Db, actor: CurrentUser) => Promise<unknown>;
}

const today = () => new Date().toISOString().slice(0, 10);

function jobs(): Job[] {
  return [
    { key: "offers.expire", everyMinutes: 15, run: async (db, a) => (await import("../modules/offers/service")).expireDue(db, a) },
    { key: "tasks.escalation", everyMinutes: 60, run: async (db, a) => (await import("../modules/tasks/service")).runEscalations(db, a) },
    { key: "contracts.critical_dates", everyMinutes: 60, run: async (db, a) => (await import("../modules/contracts/service")).scanCriticalDates(db, a) },
    { key: "reactivation.scan", everyMinutes: 360, run: async (db, a) => (await import("../modules/reactivation/service")).scan(db, a) },
    { key: "debt.scan", everyMinutes: 720, run: async (db, a) => (await import("../modules/debt/service")).scan(db, a) },
    { key: "assets.watchlist", everyMinutes: 720, run: async (db, a) => (await import("../modules/assets/service")).scanWatchlist(db, a) },
    { key: "operations.scan", everyMinutes: 720, run: async (db, a) => (await import("../modules/operations/service")).runScan(db, a) },
    { key: "maintenance.pm", everyMinutes: 720, run: async (db, a) => (await import("../modules/maintenance/service")).generatePmWorkOrders(db, a) },
    { key: "dealroom.compliance", everyMinutes: 720, run: async (db, a) => (await import("../modules/dealroom/service")).scanCompliance(db, a) },
    {
      key: "receivables.delinquency",
      everyMinutes: 720,
      run: async (db, a) => {
        const svc = await import("../modules/receivables/service");
        const { evaluateIn } = await import("../modules/receivables/schemas");
        return svc.evaluate(db, evaluateIn.parse({}), a);
      },
    },
    { key: "commissions.forecast_snapshot", everyMinutes: 1440, run: async (db, a) => (await import("../modules/commissions/service")).ensureSnapshot(db, a) },
    { key: "investors.report_schedules", everyMinutes: 1440, run: async (db, a) => (await import("../modules/investors/service")).runDueSchedules(db, today(), a) },
    { key: "brokerage.seller_reports", everyMinutes: 1440, run: async (db, a) => (await import("../modules/brokerage/service")).runDueReports(db, a) },
    { key: "webhooks.deliver", everyMinutes: 5, run: async (db, a) => (await import("../modules/platform/service")).deliverPending(db, a) },
    { key: "reports.schedules", everyMinutes: 60, run: async (db, a) => (await import("../modules/reports/service")).runDue(db, a) },
    { key: "reports.snapshots", everyMinutes: 1440, run: async (db, a) => (await import("../modules/reports/service")).runSnapshots(db, a) },
  ];
}

async function systemActor(db: Db): Promise<CurrentUser | null> {
  const [found] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${SYSTEM_EMAIL}`).limit(1);
  let id = found?.id;
  if (!id) {
    const [admin] = await db.select().from(roles).where(eq(roles.key, "admin")).limit(1);
    if (!admin) return null;
    const created = await insert(db, users, {
      email: SYSTEM_EMAIL, full_name: "System Automation", role_id: admin.id, is_service: true, job_title: "Scheduled automations",
    });
    await db.commit();
    id = created.id;
  }
  const user = await loadUser(db, id);
  if (!user || user.status !== "active") return null;
  return new CurrentUser(user, { "*": ["*"] }, {});
}

async function runJob(job: Job): Promise<void> {
  await withSession(async (db) => {
    const actor = await systemActor(db); // may commit on first run, so it happens before taking the lock
    if (!actor) return;
    // Transaction-scoped: released automatically when the job's transaction commits or rolls back.
    const [lock] = (await db.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${job.key})) AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (!lock?.ok) return;
    const started = utcnow();
    try {
      const result = await job.run(db, actor);
      await db.commit();
      console.info(`[scheduler] job ${job.key} ok in ${((utcnow().getTime() - started.getTime()) / 1000).toFixed(1)}s: ${short(result)}`);
    } catch (err) {
      await db.rollback();
      console.error(`[scheduler] job ${job.key} failed`, err);
    }
  });
}

function short(result: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(result) ?? String(result);
  } catch {
    s = String(result);
  }
  return s.length < 300 ? s : `${s.slice(0, 300)}...`;
}

/** Starts the periodic loop once per process (idempotent). */
export function startScheduler(): void {
  const g = globalThis as unknown as { __eqfScheduler?: NodeJS.Timeout };
  if (g.__eqfScheduler) return;
  const list = jobs();
  const lastRun = new Map<string, number>();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const job of list) {
        if (Date.now() - (lastRun.get(job.key) ?? -Infinity) >= job.everyMinutes * 60_000) {
          lastRun.set(job.key, Date.now());
          try {
            await runJob(job);
          } catch (err) {
            // e.g. a module not ported yet or DB unreachable: never let one failure kill the loop
            console.error(`[scheduler] job ${job.key} could not start`, err);
          }
        }
      }
    } finally {
      running = false;
    }
  };

  // Give the app a moment to finish startup before the first pass.
  const first = setTimeout(() => {
    void tick();
    g.__eqfScheduler = setInterval(() => void tick(), TICK_MS);
    g.__eqfScheduler.unref?.();
  }, 30_000);
  first.unref?.();
  g.__eqfScheduler = first as unknown as NodeJS.Timeout;
}
