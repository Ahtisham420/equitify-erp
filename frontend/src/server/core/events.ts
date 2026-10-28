/**
 * In-process domain event bus.
 *
 * Modules publish facts (`property.created`, `opportunity.stage_changed`, ...) and other modules subscribe in
 * their `handlers.ts`. Handlers run inside the caller's transaction so derived work commits atomically with
 * the source change.
 */
import type { Db } from "../db";

export type Handler = (db: Db, payload: Record<string, any>) => Promise<unknown> | unknown;
// Shared on globalThis: the Next.js instrumentation hook and the route handlers are separate bundles.
const g = globalThis as unknown as { __eqfHandlers?: Map<string, Handler[]> };
const handlers = (g.__eqfHandlers ??= new Map<string, Handler[]>());

/** Subscribe: `on("property.created", async (db, { property_id, actor }) => { ... })`. */
export function on(event: string, fn: Handler): void {
  const list = handlers.get(event) ?? [];
  list.push(fn);
  handlers.set(event, list);
}

/** Payload keys are snake_case, exactly as the Python kwargs were (property_id, actor, changed, ...). */
export async function emit(db: Db, event: string, payload: Record<string, any> = {}): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler(db, payload);
}
