/**
 * Platform administration (spec 36): integrations, credentials, feature flags, webhooks, job monitoring,
 * export monitoring, retention/legal hold, backups and system health.
 *
 * Public helpers other modules may import (lazily, inside functions):
 *   flagEnabled(db, key, user) -> boolean
 *   trackJob(db, key, [{ actor_id }], async (job) => { ...; job.counts.created = n })
 *   onLegalHold(db, entity_type, entity_id) -> boolean
 *   getCredentials(db, category, provider?) -> object
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

import { and, arrayOverlaps, asc, desc, eq, gte, inArray, isNull, like, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
// @ts-ignore -- the `fernet` package ships no type declarations
import fernet from "fernet";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { applySearch, countWhere, paginate } from "../../common/query";
import { settings } from "../../config";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import type { ListParams } from "../../core/router";
import { utcnow } from "../../core/security";
import { withSession, type Db } from "../../db";
import { get, insert, insertMany, patch } from "../../db/orm";
import { auditEvents } from "../../common/schema";
import { users } from "../auth/schema";
import * as providers from "./providers";
import {
  backupRecords,
  featureFlags,
  INTEGRATION_CATEGORIES,
  integrationProviders,
  jobRuns,
  legalHolds,
  retentionPolicies,
  webhookDeliveries,
  webhookSubscriptions,
  type BackupRecord,
  type FeatureFlag,
  type IntegrationProvider,
  type LegalHold,
  type RetentionPolicy,
  type WebhookDelivery,
  type WebhookSubscription,
} from "./schema";
import type {
  BackupIn,
  CredentialsIn,
  DeliverResult,
  FlagCreate,
  FlagUpdate,
  HoldIn,
  IntegrationCreate,
  IntegrationUpdate,
  RetentionIn,
  SubscriptionCreate,
  SubscriptionUpdate,
} from "./schemas";

type AuditEvent = typeof auditEvents.$inferSelect;

// Domain events bridged to outbound webhooks (see handlers.ts).
export const WEBHOOK_EVENTS = [
  "property.created", "property.updated",
  "opportunity.stage_changed", "opportunity.dead",
  "offer.sent", "offer.accepted", "offer.expired",
  "contract.executed", "closing.completed",
  "lease.created", "lease.updated", "lease.verified",
  "loan.maturity_window", "compliance.opted_out", "signal.created",
];
export const MAX_ATTEMPTS = 8;
export const DELIVERY_TIMEOUT_SECONDS = 10;
const STALE_SENDING_MS = 10 * 60_000;

const notFound = (what: string) => new HttpError(404, `${what} not found`);
const errName = (e: unknown) => (e as any)?.constructor?.name ?? "Error";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sorted = (xs: Iterable<string>) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const round2 = (n: number) => Math.round(n * 100) / 100;

// --- Encryption at rest --------------------------------------------------------------------------

let cachedSecret: any;

/** Same key derivation as the Python service so ciphertexts written by either implementation decrypt. */
function secret(): any {
  if (!cachedSecret) {
    let key = settings.ENCRYPTION_KEY.trim();
    if (!key) {
      // Development fallback only: production must set ENCRYPTION_KEY (see /platform/environment).
      key = createHash("sha256").update(`equitify:${settings.JWT_SECRET}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
    }
    cachedSecret = new fernet.Secret(key);
  }
  return cachedSecret;
}

const encryptRaw = (value: string): string => new fernet.Token({ secret: secret(), ttl: 0 }).encode(value);
// ttl 0 = never expire (Python Fernet.decrypt without ttl)
const decryptRaw = (token: string): string => new fernet.Token({ secret: secret(), token, ttl: 0 }).decode();

export function encryptJson(data: Record<string, any>): string {
  return encryptRaw(JSON.stringify(data));
}

export function decryptJson(token: string | null | undefined): Record<string, any> {
  if (!token) return {};
  try {
    return JSON.parse(decryptRaw(token));
  } catch {
    return {};
  }
}

export function encryptText(value: string): string {
  return encryptRaw(value);
}

export function decryptText(token: string): string {
  try {
    return decryptRaw(token);
  } catch {
    return "";
  }
}

export function mask(value: unknown): string {
  const v = String(value || "");
  return v.length <= 8 ? "••••••••" : `••••••••${v.slice(-4)}`;
}

// --- Integrations --------------------------------------------------------------------------------

export function integrationOut(row: IntegrationProvider) {
  const creds = decryptJson(row.credentials_encrypted);
  return {
    id: row.id,
    category: row.category,
    provider: row.provider,
    label: row.label,
    status: row.status,
    is_primary: row.is_primary,
    config: row.config,
    credentials: Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, mask(v)])), // masked values only
    credentials_version: row.credentials_version,
    credentials_rotated_at: row.credentials_rotated_at,
    usage_restrictions: row.usage_restrictions,
    last_success_at: row.last_success_at,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
    last_tested_at: row.last_tested_at,
    updated_at: row.updated_at,
  };
}

function options(category: string) {
  return providers.available(category).map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    required_config: s.required_config,
    required_credentials: s.required_credentials,
  }));
}

/** Lazily seed one built-in provider per spec category the first time the catalog is opened. */
export async function ensureCatalog(db: Db): Promise<void> {
  if (await countWhere(db, integrationProviders)) return;
  const defaults: Record<string, [string, string]> = {
    storage: ["local", "active"],
    spreadsheets: ["csv", "active"],
    ai: ["anthropic", settings.ANTHROPIC_API_KEY ? "active" : "not_configured"],
  };
  const rows = Object.keys(INTEGRATION_CATEGORIES).map((category) => {
    const [name, state] = defaults[category] ?? ["manual", "manual"];
    const spec = providers.get(category, name);
    return {
      category, provider: name, label: spec ? spec.label : name, status: state, is_primary: true, config: {},
    };
  });
  await insertMany(db, integrationProviders, rows);
  await audit.record(db, {
    actor: null, action: "integration.catalog_seeded", entity_type: "integration",
    summary: `${Object.keys(INTEGRATION_CATEGORIES).length} categories`,
  });
  await db.commit();
}

export async function listCatalog(db: Db) {
  await ensureCatalog(db);
  const t = integrationProviders;
  const rows = await db.select().from(t).where(isNull(t.deleted_at)).orderBy(desc(t.is_primary), asc(t.provider));
  const byCat = new Map<string, IntegrationProvider[]>();
  for (const r of rows) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  return Object.entries(INTEGRATION_CATEGORIES).map(([key, label]) => ({
    key, label, providers: (byCat.get(key) ?? []).map(integrationOut), options: options(key),
  }));
}

export async function getIntegration(db: Db, integrationId: string): Promise<IntegrationProvider> {
  const row = await get(db, integrationProviders, integrationId);
  if (!row || row.deleted_at) throw notFound("Integration");
  return row;
}

async function setPrimary(db: Db, row: IntegrationProvider): Promise<void> {
  const t = integrationProviders;
  await db.update(t).set({ is_primary: false }).where(and(eq(t.category, row.category), ne(t.id, row.id), eq(t.is_primary, true)));
}

const cleanCreds = (creds: Record<string, string>) =>
  Object.fromEntries(Object.entries(creds).map(([k, v]) => [k.trim(), v] as const).filter(([k, v]) => k && v));

export async function createIntegration(db: Db, data: IntegrationCreate, actor: CurrentUser): Promise<IntegrationProvider> {
  const t = integrationProviders;
  if (!(data.category in INTEGRATION_CATEGORIES)) {
    throw new HttpError(422, `Unknown integration category ${data.category}`);
  }
  const [exists] = await db.select().from(t).where(and(eq(t.category, data.category), eq(t.provider, data.provider))).limit(1);
  if (exists && !exists.deleted_at) throw new HttpError(409, "This provider is already configured for the category");
  const spec = providers.get(data.category, data.provider);
  const values: Partial<typeof t.$inferInsert> = {
    deleted_at: null,
    label: data.label || (spec ? spec.label : data.provider),
    config: data.config,
    usage_restrictions: data.usage_restrictions ?? null,
    status: "not_configured",
    is_primary: data.is_primary,
    updated_by_id: actor.id,
  };
  const creds = cleanCreds(data.credentials);
  if (Object.keys(creds).length) {
    values.credentials_encrypted = encryptJson(creds);
    values.credential_keys = sorted(Object.keys(creds));
    values.credentials_version = (exists?.credentials_version || 0) + 1;
    values.credentials_rotated_at = utcnow();
  }
  const row = exists
    ? await patch(db, t, exists, values)
    : await insert(db, t, { ...values, category: data.category, provider: data.provider, created_by_id: actor.id } as typeof t.$inferInsert);
  if (row.is_primary) await setPrimary(db, row);
  await audit.record(db, {
    actor, action: "integration.created", entity_type: "integration", entity_id: row.id,
    summary: `${data.category}/${data.provider}`,
    changes: { config_keys: sorted(Object.keys(data.config)), credential_keys: sorted(Object.keys(creds)) },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return row;
}

export async function updateIntegration(
  db: Db, row: IntegrationProvider, data: IntegrationUpdate, actor: CurrentUser,
): Promise<IntegrationProvider> {
  const values = data as Record<string, any>;
  const changes = audit.diff(row, values);
  if (!Object.keys(changes).length) return row;
  await patch(db, integrationProviders, row, { ...values, updated_by_id: actor.id });
  if (values.is_primary) await setPrimary(db, row);
  await audit.record(db, {
    actor, action: "integration.updated", entity_type: "integration", entity_id: row.id,
    summary: `${row.category}/${row.provider}`, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return row;
}

export async function rotateCredentials(
  db: Db, row: IntegrationProvider, data: CredentialsIn, actor: CurrentUser,
): Promise<IntegrationProvider> {
  const previousKeys = [...(row.credential_keys ?? [])];
  const supplied = cleanCreds(data.credentials);
  if (!Object.keys(supplied).length && !data.remove_keys.length) {
    throw new HttpError(422, "Enter at least one credential value to rotate");
  }
  const merged: Record<string, any> = Object.fromEntries(
    Object.entries(decryptJson(row.credentials_encrypted)).filter(([k]) => !data.remove_keys.includes(k)),
  );
  Object.assign(merged, supplied);
  const keys = sorted(Object.keys(merged));
  await patch(db, integrationProviders, row, {
    credentials_encrypted: keys.length ? encryptJson(merged) : null,
    credential_keys: keys,
    credentials_version: (row.credentials_version || 0) + 1,
    credentials_rotated_at: utcnow(),
    updated_by_id: actor.id,
  });
  // Values are never written to the audit trail — only which keys changed and the new version.
  await audit.record(db, {
    actor, action: "integration.credentials_rotated", entity_type: "integration", entity_id: row.id,
    summary: data.reason || `${row.category}/${row.provider}`,
    changes: { keys: { from: previousKeys, to: row.credential_keys }, version: row.credentials_version },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return row;
}

export async function archiveIntegration(db: Db, row: IntegrationProvider, actor: CurrentUser): Promise<void> {
  await patch(db, integrationProviders, row, {
    deleted_at: utcnow(), status: "disabled", is_primary: false, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "integration.archived", entity_type: "integration", entity_id: row.id,
    summary: `${row.category}/${row.provider}`, ip_address: actor.ip_address,
  });
  await db.commit();
}

/** Validate configuration and run the adapter's own (side-effect free) check; record the result. */
export async function testIntegration(
  db: Db, row: IntegrationProvider, actor: CurrentUser,
): Promise<[boolean, string, string[]]> {
  const missing = providers.validate(row.category, row.provider, row.config ?? {}, row.credential_keys ?? []);
  let ok: boolean;
  let message: string;
  if (missing.length) {
    ok = false;
    message = "Missing required settings: " + missing.join(", ");
  } else {
    try {
      const adapter = providers.build(row, decryptJson(row.credentials_encrypted));
      [ok, message] = typeof adapter.test === "function" ? await adapter.test() : [true, "Configuration is valid."];
    } catch (exc) {
      // adapter failures are reported, never raised to the user path
      if (exc instanceof providers.LookupError) {
        ok = false;
        message = `${exc.message}. Install the vendor adapter before activating this provider.`;
      } else {
        ok = false;
        message = `${errName(exc)}: ${errMsg(exc)}`.slice(0, 1000);
      }
    }
  }
  const now = utcnow();
  const values: Partial<typeof integrationProviders.$inferInsert> = { last_tested_at: now };
  if (ok) {
    values.last_success_at = now;
    values.last_error = null;
    values.last_error_at = null;
    if (row.status === "not_configured" || row.status === "error") {
      values.status = row.provider === "manual" || row.provider === "csv" ? "manual" : "active";
    }
  } else {
    values.last_error = message;
    values.last_error_at = now;
    if (row.status !== "disabled") values.status = "error";
  }
  await patch(db, integrationProviders, row, values);
  await audit.record(db, {
    actor, action: "integration.tested", entity_type: "integration", entity_id: row.id,
    summary: `${ok ? "ok" : "failed"}: ${message}`.slice(0, 500), ip_address: actor.ip_address,
  });
  await db.commit();
  return [ok, message, missing];
}

/** Decrypted credentials of the primary (or named) provider for adapter use only. Never return to clients. */
export async function getCredentials(db: Db, category: string, provider?: string | null): Promise<Record<string, any>> {
  const t = integrationProviders;
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.category, category), isNull(t.deleted_at), provider ? eq(t.provider, provider) : eq(t.is_primary, true)))
    .limit(1);
  return row ? decryptJson(row.credentials_encrypted) : {};
}

/** Adapters call this after real traffic so the catalog shows last success / last error. Does not commit. */
export async function recordProviderResult(
  db: Db, category: string, provider: string, { ok, error }: { ok: boolean; error?: string | null },
): Promise<void> {
  const t = integrationProviders;
  const [row] = await db.select().from(t).where(and(eq(t.category, category), eq(t.provider, provider))).limit(1);
  if (!row) return;
  const now = utcnow();
  if (ok) await patch(db, t, row, { last_success_at: now });
  else await patch(db, t, row, { last_error: (error || "error").slice(0, 2000), last_error_at: now });
}

// --- Feature flags -------------------------------------------------------------------------------

export async function listFlags(db: Db): Promise<FeatureFlag[]> {
  return db.select().from(featureFlags).where(isNull(featureFlags.deleted_at)).orderBy(asc(featureFlags.key));
}

export async function getFlag(db: Db, flagId: string): Promise<FeatureFlag> {
  const f = await get(db, featureFlags, flagId);
  if (!f || f.deleted_at) throw notFound("Feature flag");
  return f;
}

export async function createFlag(db: Db, data: FlagCreate, actor: CurrentUser): Promise<FeatureFlag> {
  const [dup] = await db.select({ id: featureFlags.id }).from(featureFlags).where(eq(featureFlags.key, data.key)).limit(1);
  if (dup) throw new HttpError(409, "A flag with this key already exists");
  const f = await insert(db, featureFlags, {
    key: data.key,
    description: data.description ?? null,
    enabled: data.enabled,
    is_sensitive: data.is_sensitive,
    rollout_roles: data.rollout_roles,
    rollout_user_ids: data.rollout_user_ids.map(String),
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "feature_flag.created", entity_type: "feature_flag", entity_id: f.id, summary: f.key,
    changes: { enabled: { from: null, to: f.enabled } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return f;
}

export async function updateFlag(db: Db, f: FeatureFlag, data: FlagUpdate, actor: CurrentUser): Promise<FeatureFlag> {
  const { reason, ...rest } = data;
  const values: Record<string, any> = { ...rest };
  if ("rollout_user_ids" in values && values.rollout_user_ids !== null && values.rollout_user_ids !== undefined) {
    values.rollout_user_ids = values.rollout_user_ids.map(String);
  }
  const changes = audit.diff(f, values);
  if (!Object.keys(changes).length) return f;
  if ((f.is_sensitive || values.is_sensitive || "is_sensitive" in changes) && !(reason || "").trim()) {
    throw new HttpError(422, "Changing a money/date/permission-sensitive flag requires a reason");
  }
  await patch(db, featureFlags, f, { ...values, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "feature_flag.updated", entity_type: "feature_flag", entity_id: f.id,
    summary: `${f.key}${reason ? " — " + reason : ""}`.slice(0, 500), changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return f;
}

/** True when the flag exists, is enabled and the user is inside its rollout (empty rollout = everyone). */
export async function flagEnabled(db: Db, key: string, user: any = null): Promise<boolean> {
  const t = featureFlags;
  const [f] = await db.select().from(t).where(and(eq(t.key, key), isNull(t.deleted_at))).limit(1);
  if (!f || !f.enabled) return false;
  if (!f.rollout_roles?.length && !f.rollout_user_ids?.length) return true;
  if (user === null || user === undefined) return false;
  const u = user.user ?? user;
  const role = u?.role?.key;
  return (f.rollout_roles ?? []).includes(role) || (f.rollout_user_ids ?? []).includes(String(u?.id ?? ""));
}

// --- Webhooks ------------------------------------------------------------------------------------

function validateEvents(events: string[]): string[] {
  const allowed = new Set([...WEBHOOK_EVENTS, "*"]);
  const bad = events.filter((e) => !allowed.has(e));
  if (bad.length) throw new HttpError(422, `Unknown events: ${bad.join(", ")}`);
  return sorted(new Set(events));
}

export function subscriptionOut(s: WebhookSubscription, secretValue: string | null = null) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    events: s.events,
    active: s.active,
    last_delivery_at: s.last_delivery_at,
    consecutive_failures: s.consecutive_failures,
    created_at: s.created_at,
    secret: secretValue, // only on create / rotate
  };
}

export async function listSubscriptions(db: Db): Promise<WebhookSubscription[]> {
  const t = webhookSubscriptions;
  return db.select().from(t).where(isNull(t.deleted_at)).orderBy(desc(t.created_at));
}

export async function getSubscription(db: Db, subId: string): Promise<WebhookSubscription> {
  const s = await get(db, webhookSubscriptions, subId);
  if (!s || s.deleted_at) throw notFound("Webhook subscription");
  return s;
}

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

export async function createSubscription(db: Db, data: SubscriptionCreate, actor: CurrentUser) {
  const secretValue = newSecret();
  const s = await insert(db, webhookSubscriptions, {
    name: data.name,
    url: data.url,
    events: validateEvents(data.events),
    active: data.active,
    secret_encrypted: encryptText(secretValue),
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "webhook.created", entity_type: "webhook_subscription", entity_id: s.id,
    summary: `${s.name} → ${s.url}`, changes: { events: { from: null, to: s.events } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return subscriptionOut(s, secretValue);
}

export async function updateSubscription(
  db: Db, s: WebhookSubscription, data: SubscriptionUpdate, actor: CurrentUser,
): Promise<WebhookSubscription> {
  const values: Record<string, any> = { ...data };
  if (values.events !== null && values.events !== undefined) values.events = validateEvents(values.events);
  const changes = audit.diff(s, values);
  if (Object.keys(changes).length) {
    const set: Record<string, any> = { ...values, updated_by_id: actor.id };
    if (values.active) set.consecutive_failures = 0;
    await patch(db, webhookSubscriptions, s, set);
    await audit.record(db, {
      actor, action: "webhook.updated", entity_type: "webhook_subscription", entity_id: s.id,
      summary: s.name, changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return s;
}

export async function rotateSecret(db: Db, s: WebhookSubscription, actor: CurrentUser) {
  const secretValue = newSecret();
  await patch(db, webhookSubscriptions, s, { secret_encrypted: encryptText(secretValue), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "webhook.secret_rotated", entity_type: "webhook_subscription", entity_id: s.id,
    summary: s.name, ip_address: actor.ip_address,
  });
  await db.commit();
  return subscriptionOut(s, secretValue);
}

export async function archiveSubscription(db: Db, s: WebhookSubscription, actor: CurrentUser): Promise<void> {
  await patch(db, webhookSubscriptions, s, { deleted_at: utcnow(), active: false, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "webhook.archived", entity_type: "webhook_subscription", entity_id: s.id,
    summary: s.name, ip_address: actor.ip_address,
  });
  await db.commit();
}

/** An in-process ORM row (as opposed to a plain dict) carried in a domain-event payload. */
const isRow = (v: any) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Set) &&
  typeof v.id === "string" && ("created_at" in v || "updated_at" in v);

/** JSON-safe copy of a domain-event payload; the in-process actor object becomes `actor_id`. */
export function eventPayload(payload: Record<string, any>): Record<string, any> {
  let out: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "actor") out.actor_id = v?.id ? String(v.id) : null;
    else if (v instanceof Set) out[k] = sorted([...v].map(String));
    else if (isRow(v)) out[`${k}_id`] = v.id ? String(v.id) : null;
    else out[k] = toJsonable(v);
  }
  try {
    JSON.stringify(out);
  } catch {
    out = Object.fromEntries(
      Object.entries(out).map(([k, v]) => [
        k,
        v === null || ["string", "number", "boolean"].includes(typeof v) || Array.isArray(v) ||
        (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) ? v : String(v),
      ]),
    );
  }
  return out;
}

/** Write outbox rows for matching active subscriptions. Runs inside the event transaction; no network I/O. */
export async function enqueue(
  db: Db, event: string, payload: Record<string, any>, { subscription_id }: { subscription_id?: string | null } = {},
): Promise<number> {
  const t = webhookSubscriptions;
  const ids = (
    await db.select({ id: t.id }).from(t).where(
      and(eq(t.active, true), isNull(t.deleted_at), subscription_id ? eq(t.id, subscription_id) : arrayOverlaps(t.events, [event, "*"])),
    )
  ).map((r) => r.id);
  const data = eventPayload(payload);
  await insertMany(
    db,
    webhookDeliveries,
    ids.map((sid) => ({ subscription_id: sid, event, payload: data, status: "pending", next_attempt_at: utcnow() })),
  );
  return ids.length;
}

export async function sendTest(db: Db, s: WebhookSubscription, actor: CurrentUser): Promise<number> {
  const n = await enqueue(
    db, "ping", { message: "Test delivery from EquitiFy", subscription_id: String(s.id), actor }, { subscription_id: s.id },
  );
  await audit.record(db, {
    actor, action: "webhook.test_queued", entity_type: "webhook_subscription", entity_id: s.id,
    summary: s.name, ip_address: actor.ip_address,
  });
  await db.commit();
  return n;
}

async function post(url: string, body: string, headers: Record<string, string>, timeoutSeconds: number): Promise<[number | null, string | null]> {
  try {
    const res = await fetch(url, {
      method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return [res.status, null];
    return [res.status, `HTTP ${res.status} ${res.statusText}`.slice(0, 500)];
  } catch (exc) {
    // network errors become retryable delivery failures
    return [null, `${errName(exc)}: ${errMsg(exc)}`.slice(0, 500)];
  }
}

export function sign(secretValue: string, timestamp: string, body: string): string {
  return createHmac("sha256", secretValue).update(`${timestamp}.${body}`).digest("hex");
}

const backoffMs = (attempts: number) => Math.min(2 ** Math.max(attempts - 1, 0), 360) * 60_000;

export async function deliverPending(db: Db, actor: CurrentUser | null = null, limit = 50): Promise<DeliverResult> {
  const result: DeliverResult = { attempted: 0, delivered: 0, failed: 0, dead: 0 };
  await trackJob(db, "webhooks.deliver", { actor_id: actor?.id ?? null }, async (job) => {
    const d = webhookDeliveries;
    const now = utcnow();
    const due = or(
      and(inArray(d.status, ["pending", "failed"]), lte(d.next_attempt_at, now)),
      and(eq(d.status, "sending"), lt(d.last_attempt_at, new Date(now.getTime() - STALE_SENDING_MS))),
    );
    const rows = await db.select().from(d).where(due).orderBy(asc(d.next_attempt_at)).limit(limit).for("update", { skipLocked: true });
    const subIds = [...new Set(rows.map((r) => r.subscription_id as string))];
    const subs = new Map<string, WebhookSubscription>();
    if (rows.length) {
      const s = webhookSubscriptions;
      for (const sub of await db.select().from(s).where(inArray(s.id, subIds))) subs.set(sub.id, sub);
    }
    // claim, then end the transaction (and its locks) before any network I/O
    if (rows.length) {
      await db.update(d).set({ status: "sending", last_attempt_at: now }).where(inArray(d.id, rows.map((r) => r.id)));
      for (const r of rows) Object.assign(r, { status: "sending", last_attempt_at: now });
    }
    await db.commit();
    for (const r of rows) {
      result.attempted += 1;
      const sub = subs.get(r.subscription_id as string);
      if (!sub || !sub.active || sub.deleted_at) {
        await patch(db, d, r, { status: "dead", last_error: "Subscription is inactive or archived" });
        result.dead += 1;
        await db.commit();
        continue;
      }
      const body = JSON.stringify({ id: String(r.id), event: r.event, created_at: r.created_at.toISOString(), data: r.payload });
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": `${settings.APP_NAME}-Webhooks/1`,
        "X-EquitiFy-Event": r.event,
        "X-EquitiFy-Delivery": String(r.id),
        "X-EquitiFy-Timestamp": ts,
        "X-EquitiFy-Signature": `t=${ts},v1=${sign(decryptText(sub.secret_encrypted), ts, body)}`,
      };
      const [code, error] = await post(sub.url, body, headers, DELIVERY_TIMEOUT_SECONDS);
      const attempts = r.attempts + 1;
      const attemptedAt = utcnow();
      const rowValues: Partial<typeof d.$inferInsert> = { attempts, last_status_code: code, last_attempt_at: attemptedAt };
      let failures: number;
      if (code !== null && code >= 200 && code < 300) {
        Object.assign(rowValues, { status: "delivered", delivered_at: attemptedAt, last_error: null });
        failures = 0;
        result.delivered += 1;
      } else {
        rowValues.last_error = error || `HTTP ${code}`;
        failures = (sub.consecutive_failures || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          rowValues.status = "dead";
          result.dead += 1;
        } else {
          rowValues.status = "failed";
          rowValues.next_attempt_at = new Date(attemptedAt.getTime() + backoffMs(attempts));
          result.failed += 1;
        }
      }
      await patch(db, d, r, rowValues);
      await patch(db, webhookSubscriptions, sub, { last_delivery_at: attemptedAt, consecutive_failures: failures });
      await db.commit();
    }
    Object.assign(job.counts, result);
  });
  return result;
}

export async function retryDelivery(db: Db, deliveryId: string, actor: CurrentUser): Promise<WebhookDelivery> {
  const r = await get(db, webhookDeliveries, deliveryId);
  if (!r) throw notFound("Delivery");
  if (r.status === "delivered") throw new HttpError(409, "Delivery already succeeded");
  await patch(db, webhookDeliveries, r, {
    ...(r.status === "dead" ? { attempts: 0 } : {}),
    status: "pending",
    next_attempt_at: utcnow(),
  });
  await audit.record(db, {
    actor, action: "webhook.delivery_retried", entity_type: "webhook_delivery", entity_id: r.id,
    summary: r.event, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

// --- Job monitoring ------------------------------------------------------------------------------

export class JobHandle {
  counts: Record<string, any> = {};
  constructor(public id: string | null) {}
}

async function finishJob(
  runId: string | null, state: string, error: string | null, counts: Record<string, any>, started: number,
): Promise<void> {
  if (runId === null) return;
  try {
    await withSession(async (s) => {
      const run = await get(s, jobRuns, runId);
      if (run) {
        await patch(s, jobRuns, run, {
          status: state, error, finished_at: utcnow(), duration_ms: Math.trunc(performance.now() - started),
          counts: toJsonable(counts),
        });
      }
    });
  } catch {
    // monitoring must never break the job itself
  }
}

type TrackOpts = { actor_id?: string | null };

/**
 * Record a `job_runs` row around a background job (Python `async with track_job(...) as job`):
 *
 *   await platform.trackJob(db, "leases.notices", async (job) => { ...; job.counts.created = n; });
 *   await platform.trackJob(db, "leases.notices", { actor_id }, async (job) => { ... });   // options before or after fn
 *
 * Bookkeeping uses its own session so a failed/rolled-back job is still recorded as failed.
 */
export async function trackJob<T>(
  db: Db, key: string, a: TrackOpts | ((job: JobHandle) => Promise<T>), b?: TrackOpts | ((job: JobHandle) => Promise<T>),
): Promise<T> {
  const fn = (typeof a === "function" ? a : b) as (job: JobHandle) => Promise<T>;
  const opts = ((typeof a === "function" ? b : a) ?? {}) as TrackOpts;
  const started = performance.now();
  let runId: string | null = null;
  try {
    runId = await withSession(async (s) => {
      const run = await insert(s, jobRuns, { job_key: key.slice(0, 80), status: "running", triggered_by_id: opts.actor_id ?? null });
      return run.id;
    });
  } catch {
    runId = null;
  }
  const handle = new JobHandle(runId);
  let value: T;
  try {
    value = await fn(handle);
  } catch (exc) {
    await finishJob(runId, "failed", `${errName(exc)}: ${errMsg(exc)}`.slice(0, 4000), handle.counts, started);
    throw exc;
  }
  await finishJob(runId, "succeeded", null, handle.counts, started);
  return value;
}

export async function jobSummary(db: Db, days = 7) {
  const since = new Date(utcnow().getTime() - days * 86_400_000);
  const rows = await db.select().from(jobRuns).where(gte(jobRuns.started_at, since)).orderBy(desc(jobRuns.started_at));
  const out = new Map<string, { job_key: string; runs: number; failures: number; last_status: string; last_started_at: Date; last_error: string | null }>();
  for (const r of rows) {
    let s = out.get(r.job_key);
    if (!s) {
      s = { job_key: r.job_key, runs: 0, failures: 0, last_status: r.status, last_started_at: r.started_at, last_error: r.error };
      out.set(r.job_key, s);
    }
    s.runs += 1;
    s.failures += r.status === "failed" ? 1 : 0;
  }
  return [...out.values()].sort((a, b) => b.failures - a.failures || (a.job_key < b.job_key ? -1 : a.job_key > b.job_key ? 1 : 0));
}

// --- Bulk-export monitor -------------------------------------------------------------------------

const ROWS_RE = /(\d[\d,]*)\s+(?:rows?|records?|items?)/i;

export function exportRows(e: AuditEvent): number | null {
  const changes = (e.changes ?? {}) as Record<string, any>;
  for (const key of ["rows", "row_count", "count"]) {
    const v = changes[key];
    if (typeof v === "number") return Math.trunc(v);
  }
  const m = ROWS_RE.exec(e.summary ?? "");
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}

export function exportWhere(days: number, actorId: string | null | undefined, q: string | null | undefined): SQL | undefined {
  const a = auditEvents;
  return and(
    or(like(a.action, "%exported"), like(a.action, "%export")),
    gte(a.occurred_at, new Date(utcnow().getTime() - days * 86_400_000)),
    actorId ? eq(a.actor_id, actorId) : undefined,
    applySearch(q, [a.action, a.actor_name, a.summary, a.entity_type]),
  );
}

export async function listExports(db: Db, params: ListParams, days: number, actorId: string | null | undefined) {
  return paginate(db, auditEvents, exportWhere(days, actorId, params.q), [desc(auditEvents.occurred_at)], params);
}

export async function exportsByUser(db: Db, days: number) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(exportWhere(days, null, null))
    .orderBy(desc(auditEvents.occurred_at))
    .limit(10_000);
  const out = new Map<string, { actor_id: string | null; actor_name: string | null; exports: number; rows: number; last_at: Date }>();
  for (const e of rows) {
    const k = String(e.actor_id);
    let s = out.get(k);
    if (!s) {
      s = { actor_id: e.actor_id, actor_name: e.actor_name, exports: 0, rows: 0, last_at: e.occurred_at };
      out.set(k, s);
    }
    s.exports += 1;
    s.rows += exportRows(e) || 0;
  }
  return [...out.values()].sort((a, b) => b.rows - a.rows);
}

// --- Retention & legal hold ----------------------------------------------------------------------

export async function listRetention(db: Db): Promise<RetentionPolicy[]> {
  const t = retentionPolicies;
  return db.select().from(t).where(isNull(t.deleted_at)).orderBy(asc(t.entity_type));
}

export async function upsertRetention(db: Db, data: RetentionIn, actor: CurrentUser): Promise<RetentionPolicy> {
  const t = retentionPolicies;
  const [existing] = await db.select().from(t).where(eq(t.entity_type, data.entity_type)).limit(1);
  const values = {
    entity_type: data.entity_type,
    retain_days: data.retain_days,
    action: data.action,
    description: data.description ?? null,
    is_active: data.is_active,
  };
  let row: RetentionPolicy;
  let changes: Record<string, any>;
  let action: string;
  if (existing) {
    changes = audit.diff(existing, values);
    const set: Record<string, any> = { ...values, updated_by_id: actor.id };
    if (existing.deleted_at) {
      set.deleted_at = null;
      changes.restored = { from: false, to: true };
    }
    row = await patch(db, t, existing, set);
    action = "retention_policy.updated";
  } else {
    row = await insert(db, t, { ...values, created_by_id: actor.id, updated_by_id: actor.id });
    changes = { retain_days: { from: null, to: row.retain_days } };
    action = "retention_policy.created";
  }
  await audit.record(db, {
    actor, action, entity_type: "retention_policy", entity_id: row.id, summary: row.entity_type, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return row;
}

export async function listHolds(db: Db, activeOnly = true): Promise<LegalHold[]> {
  const t = legalHolds;
  return db.select().from(t).where(and(isNull(t.deleted_at), activeOnly ? isNull(t.released_at) : undefined))
    .orderBy(desc(t.placed_at)).limit(500);
}

export async function placeHold(db: Db, data: HoldIn, actor: CurrentUser): Promise<LegalHold> {
  const h = await insert(db, legalHolds, {
    entity_type: data.entity_type,
    entity_id: data.entity_id ?? null,
    reason: data.reason,
    matter: data.matter ?? null,
    placed_by_id: actor.id,
    placed_at: utcnow(),
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "legal_hold.placed", entity_type: "legal_hold", entity_id: h.id,
    summary: `${h.entity_type}${h.entity_id ? "/" + h.entity_id : " (all)"}: ${h.reason}`.slice(0, 500),
    ip_address: actor.ip_address,
  });
  await db.commit();
  return h;
}

export async function releaseHold(db: Db, holdId: string, reason: string, actor: CurrentUser): Promise<LegalHold> {
  const h = await get(db, legalHolds, holdId);
  if (!h || h.deleted_at) throw notFound("Legal hold");
  if (h.released_at) throw new HttpError(409, "Hold is already released");
  await patch(db, legalHolds, h, {
    released_at: utcnow(), released_by_id: actor.id, release_reason: reason, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "legal_hold.released", entity_type: "legal_hold", entity_id: h.id,
    summary: reason.slice(0, 500), ip_address: actor.ip_address,
  });
  await db.commit();
  return h;
}

/** True while an open hold covers this record (or its whole entity type). Callers must block purge/destroy. */
export async function onLegalHold(db: Db, entityType: string, entityId: string | null | undefined): Promise<boolean> {
  const t = legalHolds;
  const cond = entityId ? or(isNull(t.entity_id), eq(t.entity_id, entityId)) : isNull(t.entity_id);
  const [found] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.entity_type, entityType), isNull(t.released_at), isNull(t.deleted_at), cond))
    .limit(1);
  return found !== undefined;
}

// --- Backups -------------------------------------------------------------------------------------

export function backupOut(b: BackupRecord) {
  const checks: boolean[] = [];
  if (b.rpo_target_minutes !== null && b.achieved_rpo_minutes !== null) checks.push(b.achieved_rpo_minutes <= b.rpo_target_minutes);
  if (b.rto_target_minutes !== null && b.achieved_rto_minutes !== null) checks.push(b.achieved_rto_minutes <= b.rto_target_minutes);
  return {
    id: b.id,
    kind: b.kind,
    environment: b.environment,
    performed_at: b.performed_at,
    reference: b.reference,
    encrypted: b.encrypted,
    point_in_time: b.point_in_time,
    size_bytes: b.size_bytes,
    rpo_target_minutes: b.rpo_target_minutes,
    rto_target_minutes: b.rto_target_minutes,
    achieved_rpo_minutes: b.achieved_rpo_minutes,
    achieved_rto_minutes: b.achieved_rto_minutes,
    result: b.result,
    notes: b.notes,
    performed_by_id: b.performed_by_id,
    meets_targets: checks.length ? checks.every(Boolean) && b.result === "success" : null,
  };
}

export async function listBackups(db: Db, kind?: string | null): Promise<BackupRecord[]> {
  const t = backupRecords;
  return db.select().from(t).where(and(isNull(t.deleted_at), kind ? eq(t.kind, kind) : undefined))
    .orderBy(desc(t.performed_at)).limit(200);
}

export async function recordBackup(db: Db, data: BackupIn, actor: CurrentUser): Promise<BackupRecord> {
  const b = await insert(db, backupRecords, {
    kind: data.kind,
    environment: data.environment,
    performed_at: data.performed_at ?? utcnow(),
    reference: data.reference ?? null,
    encrypted: data.encrypted,
    point_in_time: data.point_in_time,
    size_bytes: data.size_bytes ?? null,
    rpo_target_minutes: data.rpo_target_minutes ?? null,
    rto_target_minutes: data.rto_target_minutes ?? null,
    achieved_rpo_minutes: data.achieved_rpo_minutes ?? null,
    achieved_rto_minutes: data.achieved_rto_minutes ?? null,
    result: data.result,
    notes: data.notes ?? null,
    performed_by_id: actor.id,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `backup.${data.kind}_recorded`, entity_type: "backup_record", entity_id: b.id,
    summary: `${data.environment}: ${data.result}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return b;
}

// --- Health --------------------------------------------------------------------------------------

export async function dbLatencyMs(db: Db): Promise<number | null> {
  const started = performance.now();
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    return null;
  }
  return round2(performance.now() - started);
}

export async function health(db: Db) {
  const ai = await import("../documents/ai");
  const now = utcnow();
  const latency = await dbLatencyMs(db);
  const jobFailures = await countWhere(
    db, jobRuns, and(eq(jobRuns.status, "failed"), gte(jobRuns.started_at, new Date(now.getTime() - 86_400_000))),
  );
  const dead = await countWhere(db, webhookDeliveries, eq(webhookDeliveries.status, "dead"));
  const pending = await countWhere(db, webhookDeliveries, inArray(webhookDeliveries.status, ["pending", "failed", "sending"]));
  const intErrors = await countWhere(
    db, integrationProviders, and(eq(integrationProviders.status, "error"), isNull(integrationProviders.deleted_at)),
  );
  const b = backupRecords;
  const [lb] = await db.select({ m: sql<Date | string | null>`max(${b.performed_at})` }).from(b)
    .where(and(eq(b.kind, "backup"), eq(b.result, "success"), isNull(b.deleted_at)));
  const [lr] = await db.select({ m: sql<Date | string | null>`max(${b.performed_at})` }).from(b)
    .where(and(eq(b.kind, "restore_test"), isNull(b.deleted_at)));
  const lastBackup = lb?.m ? new Date(lb.m) : null;
  const lastRestore = lr?.m ? new Date(lr.m) : null;
  const aiStatus = ai.providerStatus();
  const stamp = (d: Date, n: number) => d.toISOString().replace("T", " ").slice(0, n);

  const checks = [
    {
      key: "database", label: "Database",
      status: latency === null ? "error" : latency > 250 ? "warning" : "ok",
      detail: latency === null ? "Unreachable" : `${latency} ms round trip`,
    },
    {
      key: "jobs", label: "Background jobs", status: jobFailures ? "warning" : "ok",
      detail: `${jobFailures} failed run(s) in the last 24 hours`,
    },
    {
      key: "webhooks", label: "Webhooks", status: dead ? "warning" : "ok",
      detail: `${dead} dead-lettered, ${pending} pending delivery`,
    },
    {
      key: "integrations", label: "Integrations", status: intErrors ? "warning" : "ok",
      detail: `${intErrors} provider(s) reporting errors`,
    },
    {
      key: "ai", label: "AI provider", status: "ok",
      detail: aiStatus.available ? `${aiStatus.name} · ${aiStatus.model}` : "Not configured — AI features run in manual mode",
    },
    {
      key: "backup", label: "Backups",
      status: lastBackup && now.getTime() - lastBackup.getTime() <= 2 * 86_400_000 ? "ok" : "warning",
      detail: lastBackup ? `Last successful backup ${stamp(lastBackup, 16)} UTC` : "No backup recorded",
    },
    {
      key: "restore", label: "Restoration tests",
      status: lastRestore && now.getTime() - lastRestore.getTime() <= 90 * 86_400_000 ? "ok" : "warning",
      detail: lastRestore ? `Last restore test ${stamp(lastRestore, 10)}` : "No restoration test recorded",
    },
    {
      key: "encryption", label: "Credential encryption",
      status: settings.ENCRYPTION_KEY || settings.ENVIRONMENT !== "production" ? "ok" : "error",
      detail: settings.ENCRYPTION_KEY ? "Dedicated ENCRYPTION_KEY configured" : "Using development key derived from JWT_SECRET",
    },
  ];
  const worst = checks.some((c) => c.status === "error") ? "error" : checks.some((c) => c.status === "warning") ? "warning" : "ok";
  return {
    status: worst, environment: settings.ENVIRONMENT, checked_at: now, db_latency_ms: latency,
    job_failures_24h: jobFailures, webhook_dead_letters: dead, webhook_pending: pending,
    integrations_in_error: intErrors, ai: aiStatus, last_backup_at: lastBackup,
    last_restore_test_at: lastRestore, checks,
  };
}

export function environmentInfo() {
  return {
    environment: settings.ENVIRONMENT,
    app_name: settings.APP_NAME,
    api_prefix: settings.API_PREFIX,
    api_version: "v1",
    encryption_key_configured: Boolean(settings.ENCRYPTION_KEY),
    ai_configured: Boolean(settings.ANTHROPIC_API_KEY),
    mfa_enforced: settings.MFA_ENFORCED,
    data_rules: [
      "Production, staging and development run as separate deployments with separate databases and keys.",
      "Production data is never copied to development or staging without anonymization.",
      "Integration credentials and webhook secrets are encrypted at rest and never returned in plaintext.",
      "Documents are served only through short-lived signed URLs.",
      "Audit events are immutable; exports and critical changes are always audited.",
      "Money, date and permission-sensitive changes ship behind feature flags with a recorded reason.",
    ],
  };
}

export async function apiCatalog() {
  const { ACTIONS, MODULES } = await import("../auth/permissions");
  return {
    version: "v1",
    prefix: settings.API_PREFIX,
    auth: ["Bearer access token (users)", "X-API-Key header (service credentials, scoped)"],
    actions: ACTIONS,
    modules: Object.entries(MODULES).map(([m, label]) => ({ module: m, label, scopes: ACTIONS.map((a) => `${m}:${a}`) })),
    webhook_events: WEBHOOK_EVENTS,
  };
}

export async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Record<string, string>> {
  const set = [...new Set([...ids].filter((i): i is string => Boolean(i)))];
  if (!set.length) return {};
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, set));
  return Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
}
