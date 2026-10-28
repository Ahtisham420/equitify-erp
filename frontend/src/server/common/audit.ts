import type { Db } from "../db";
import { auditEvents } from "./schema";

/** JSON-safe copy of a value (Dates -> ISO strings, Sets -> arrays). */
export function toJsonable(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) return [...value].map(toJsonable);
  if (Array.isArray(value)) return value.map(toJsonable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonable(v)]));
  }
  return value;
}

/** Structural equality for scalars, Dates, arrays and plain objects (Python `==`). */
export function isEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if ((a ?? null) === null && (b ?? null) === null) return true;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as any).getTime() === new Date(b as any).getTime();
  }
  if (typeof a === "object" && typeof b === "object" && a && b) {
    return JSON.stringify(toJsonable(a)) === JSON.stringify(toJsonable(b));
  }
  return false;
}

/** Compute `{field: {from, to}}` for fields in `data` that differ from `obj`. */
export function diff(obj: Record<string, any>, data: Record<string, any>): Record<string, { from: any; to: any }> {
  const changes: Record<string, { from: any; to: any }> = {};
  for (const [field, next] of Object.entries(data)) {
    if (next === undefined) continue;
    const old = obj[field];
    if (!isEqual(old, next)) changes[field] = { from: toJsonable(old ?? null), to: toJsonable(next) };
  }
  return changes;
}

export interface Actor {
  id?: string | null;
  full_name?: string | null;
}

export async function record(
  db: Db,
  o: {
    actor?: Actor | null;
    action: string;
    entity_type: string;
    entity_id?: string | null;
    summary?: string | null;
    changes?: Record<string, any> | null;
    ip_address?: string | null;
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    actor_id: o.actor?.id ?? null,
    actor_name: o.actor?.full_name ?? null,
    action: o.action,
    entity_type: o.entity_type,
    entity_id: o.entity_id ?? null,
    summary: o.summary ?? null,
    changes: o.changes && Object.keys(o.changes).length ? toJsonable(o.changes) : null,
    ip_address: o.ip_address ?? null,
  });
}
