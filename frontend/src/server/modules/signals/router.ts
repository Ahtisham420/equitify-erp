import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySort, page } from "../../common/query";
import { csvResponse, created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { get } from "../../db/orm";
import { CATEGORIES, STATUSES, signalSubscriptions, signalTypes, signals } from "./schema";
import {
  dismissIn,
  settingsIn,
  signalCreate,
  signalTypeIn,
  signalTypeUpdate,
  signalUpdate,
  subscriptionIn,
  verifyIn,
} from "./schemas";
import * as service from "./service";
import type { SignalFilters } from "./service";

export const router = new Router();

const SORTS = {
  observed_on: signals.observed_on, severity: signals.severity, confidence: signals.confidence,
  category: signals.category, signal_type: signals.signal_type, expires_on: signals.expires_on,
  created_at: signals.created_at, updated_at: signals.updated_at,
};

function filters(ctx: Ctx): SignalFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    category: q.strs("category"),
    severity: q.ints("severity"),
    status: q.strs("status"),
    signal_type: q.strs("signal_type"),
    verification: q.strs("verification"),
    property_id: q.uuid("property_id"),
    owner_kind: q.str("owner_kind"),
    owner_id: q.uuid("owner_id"),
    sensitive: q.bool("sensitive"),
    min_confidence: q.num("min_confidence", { ge: 0, le: 1 }),
    observed_from: q.date("observed_from"),
    observed_to: q.date("observed_to"),
  };
}

router.get("/signals", async (ctx) => {
  const user = await ctx.require("signals", "view");
  const p = ctx.listParams();
  const order = applySort(p.sort, SORTS, desc(signals.observed_on));
  const [rows, total] = await service.listPage(ctx.db, service.buildWhere(filters(ctx)), order, p);
  return page(await service.toOuts(ctx.db, rows, user), total, p);
});

router.get("/signals/facets", async (ctx) => {
  await ctx.require("signals", "view");
  const f = filters(ctx);
  const w = (skip: string) => service.buildWhere(f, new Set([skip]));
  return {
    category: await service.facetBy(ctx.db, w("category"), signals.category),
    severity: await service.facetBy(ctx.db, w("severity"), signals.severity),
    status: await service.facetBy(ctx.db, w("status"), service.statusExpr()),
    signal_type: await service.facetBy(ctx.db, w("signal_type"), signals.signal_type),
  };
});

router.get("/signals/meta", async (ctx) => {
  await ctx.require("signals", "view");
  await service.ensureTypes(ctx.db);
  await ctx.db.commit();
  return { categories: CATEGORIES, statuses: STATUSES, severities: [1, 2, 3, 4, 5] };
});

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Python `str(v)` for the audit filter summary. */
const pyStr = (v: unknown): string =>
  typeof v === "boolean" ? (v ? "True" : "False") : Array.isArray(v) ? `[${v.map((x) => `'${x}'`).join(", ")}]` : String(v);

router.get("/signals/export", async (ctx) => {
  const user = await ctx.require("signals", "export");
  const p = ctx.listParams();
  const f = filters(ctx);
  // Sensitive circumstances never leave the system, regardless of the caller's permissions.
  f.sensitive = false;
  const rows = await service.listAll(
    ctx.db, service.buildWhere(f), applySort(p.sort, SORTS, desc(signals.observed_on)), 50_000,
  );
  const outs = await service.toOuts(ctx.db, rows, user);
  const cols = [
    "id", "property_label", "owner_kind", "owner_label", "category", "signal_type", "title", "observed_on",
    "severity", "source", "confidence", "expires_on", "effective_status", "current_weight", "verification",
  ] as const;
  const floatCols = new Set(["confidence", "current_weight"]);
  const lines = [cols.join(",")];
  for (const o of outs) {
    if (o.is_sensitive) continue;
    lines.push(
      cols
        .map((c) => {
          const v = (o as Record<string, any>)[c];
          return csvCell(floatCols.has(c) && typeof v === "number" && Number.isInteger(v) ? `${v}.0` : v);
        })
        .join(","),
    );
  }
  await audit.record(ctx.db, {
    actor: user, action: "signal.exported", entity_type: "signal", summary: `${outs.length} rows`,
    changes: {
      filters: Object.fromEntries(
        Object.entries(f)
          .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
          .map(([k, v]) => [k, pyStr(v)]),
      ),
    },
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csvResponse(lines.join("\r\n") + "\r\n", "signals.csv");
});

// ----------------------------------------------------------------------------- configuration

router.get("/signals/types", async (ctx) => {
  await ctx.require("signals", "view");
  return service.listTypes(ctx.db);
});

router.post("/signals/types", async (ctx) => {
  const user = await ctx.require("signals", "approve");
  const body = await ctx.body(signalTypeIn);
  return created(service.typeOut(await service.createType(ctx.db, body, user)));
});

router.patch("/signals/types/{type_id}", async (ctx) => {
  const user = await ctx.require("signals", "approve");
  const body = await ctx.body(signalTypeUpdate);
  const t = await get(ctx.db, signalTypes, ctx.uuid("type_id"));
  if (!t || t.deleted_at) throw new HttpError(404, "Signal type not found");
  return service.typeOut(await service.updateType(ctx.db, t, body, user));
});

const settingsOut = (enabled: boolean, th: Record<string, any>) => ({
  enabled, ...Object.fromEntries(Object.keys(service.RULE_DEFAULTS).map((k) => [k, th[k]])),
});

router.get("/signals/settings", async (ctx) => {
  await ctx.require("signals", "view");
  await service.ensureRule(ctx.db);
  await ctx.db.commit();
  const [enabled, th] = await service.settings(ctx.db);
  return settingsOut(enabled, th);
});

router.put("/signals/settings", async (ctx) => {
  const user = await ctx.require("signals", "approve");
  const body = await ctx.body(settingsIn);
  const [enabled, th] = await service.saveSettings(ctx.db, { ...body }, user);
  return settingsOut(enabled, th);
});

// ----------------------------------------------------------------------------- subscriptions

router.get("/signals/subscriptions", async (ctx) => {
  const user = await ctx.require("signals", "view");
  const rows = await ctx.db
    .select()
    .from(signalSubscriptions)
    .where(and(eq(signalSubscriptions.subscriber_id, user.id), isNull(signalSubscriptions.deleted_at)))
    .orderBy(desc(signalSubscriptions.created_at));
  return rows.map(service.subscriptionOut);
});

router.post("/signals/subscriptions", async (ctx) => {
  const user = await ctx.require("signals", "view");
  const body = await ctx.body(subscriptionIn);
  return created(service.subscriptionOut(await service.createSubscription(ctx.db, body, user)));
});

router.put("/signals/subscriptions/{sub_id}", async (ctx) => {
  const user = await ctx.require("signals", "view");
  const body = await ctx.body(subscriptionIn);
  const sub = await service.getSubscription(ctx.db, ctx.uuid("sub_id"), user);
  return service.subscriptionOut(await service.updateSubscription(ctx.db, sub, body, user));
});

router.delete("/signals/subscriptions/{sub_id}", async (ctx) => {
  const user = await ctx.require("signals", "view");
  await service.deleteSubscription(ctx.db, await service.getSubscription(ctx.db, ctx.uuid("sub_id"), user), user);
  return noContent();
});

// ----------------------------------------------------------------------------- record views

router.get("/signals/property/{property_id}", async (ctx) => {
  const user = await ctx.require("signals", "view");
  const propertyId = ctx.uuid("property_id");
  const includeInactive = ctx.query.bool("include_inactive") ?? false;
  const rows = await service.propertySignalRows(ctx.db, propertyId, { live_only: !includeInactive });
  return {
    motivation: await service.motivationBreakdown(ctx.db, propertyId),
    signals: await service.toOuts(ctx.db, rows, user),
  };
});

router.get("/signals/motivation/{property_id}", async (ctx) => {
  await ctx.require("signals", "view");
  return service.motivationBreakdown(ctx.db, ctx.uuid("property_id"));
});

router.get("/signals/owner/{owner_kind}/{owner_id}", async (ctx) => {
  const user = await ctx.require("signals", "view");
  const ownerKind = ctx.param("owner_kind");
  const ownerId = ctx.uuid("owner_id");
  if (!["person", "organization"].includes(ownerKind)) {
    throw new HttpError(422, "Owner kind must be person or organization");
  }
  const pids = await service.ownedProperties(ctx.db, ownerKind, ownerId);
  const conds = [and(eq(signals.owner_kind, ownerKind), eq(signals.owner_id, ownerId))!];
  if (pids.length) conds.push(inArray(signals.property_id, pids));
  const rows = await ctx.db
    .select()
    .from(signals)
    .where(and(isNull(signals.deleted_at), or(...conds)))
    .orderBy(desc(signals.observed_on))
    .limit(500);
  return service.toOuts(ctx.db, rows, user);
});

// ----------------------------------------------------------------------------- signals

router.post("/signals", async (ctx) => {
  const user = await ctx.require("signals", "create");
  const s = await service.create(ctx.db, await ctx.body(signalCreate), user);
  return created((await service.toOuts(ctx.db, [s], user))[0]);
});

router.get("/signals/{signal_id}", async (ctx) => {
  const user = await ctx.require("signals", "view");
  return (await service.toOuts(ctx.db, [await service.getSignal(ctx.db, ctx.uuid("signal_id"))], user))[0];
});

router.patch("/signals/{signal_id}", async (ctx) => {
  const user = await ctx.require("signals", "edit");
  const body = await ctx.body(signalUpdate);
  let s = await service.getSignal(ctx.db, ctx.uuid("signal_id"));
  if (s.is_sensitive && !user.can("signals", "view_sensitive")) {
    throw new HttpError(403, "Editing a sensitive signal requires signals:view_sensitive");
  }
  s = await service.updateSignal(ctx.db, s, body, user);
  return (await service.toOuts(ctx.db, [s], user))[0];
});

router.post("/signals/{signal_id}/dismiss", async (ctx) => {
  const user = await ctx.require("signals", "edit");
  const body = await ctx.body(dismissIn);
  const s = await service.dismiss(ctx.db, await service.getSignal(ctx.db, ctx.uuid("signal_id")), body.reason, user);
  return (await service.toOuts(ctx.db, [s], user))[0];
});

router.post("/signals/{signal_id}/restore", async (ctx) => {
  const user = await ctx.require("signals", "edit");
  const s = await service.restore(ctx.db, await service.getSignal(ctx.db, ctx.uuid("signal_id")), user);
  return (await service.toOuts(ctx.db, [s], user))[0];
});

router.post("/signals/{signal_id}/verify", async (ctx) => {
  const user = await ctx.require("signals", "edit");
  const body = await ctx.body(verifyIn);
  const s = await service.verify(ctx.db, await service.getSignal(ctx.db, ctx.uuid("signal_id")), body.state, user);
  return (await service.toOuts(ctx.db, [s], user))[0];
});

router.get("/signals/{signal_id}/history", async (ctx) => {
  await ctx.require("signals", "view");
  const id = ctx.uuid("signal_id");
  await service.getSignal(ctx.db, id);
  return provenance.history(ctx.db, service.ENTITY, id);
});

router.delete("/signals/{signal_id}", async (ctx) => {
  const user = await ctx.require("signals", "delete");
  await service.archive(ctx.db, await service.getSignal(ctx.db, ctx.uuid("signal_id")), user);
  return noContent();
});

