/**
 * Field-level provenance and history for material facts.
 *
 * Every material value change writes a FieldObservation (source, observed date, confidence, verification state,
 * AI flag). The previous observation is kept and marked non-current, so history is never overwritten.
 * AI-derived values stay AI-derived until a named human verifies.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db";
import { get } from "../db/orm";
import { isEqual, toJsonable } from "./audit";
import { fieldObservations } from "./schema";

export type FieldObservation = typeof fieldObservations.$inferSelect;
export type Verification = "unverified" | "verified" | "rejected";

/** Provenance block that accompanies a material-field write. */
export const provenanceIn = z.object({
  source: z.string().max(200).default("Manual entry"),
  observed_on: z.string().date().nullish(),
  confidence: z.number().min(0).max(1).default(0.8),
  verified: z.boolean().default(false),
  ai_derived: z.boolean().default(false),
});
export type ProvenanceIn = z.infer<typeof provenanceIn>;
export const defaultProvenance = (): ProvenanceIn => provenanceIn.parse({});

const today = () => new Date().toISOString().slice(0, 10);

export async function observe(
  db: Db,
  o: { entity_type: string; entity_id: string; field: string; value: unknown; prov: ProvenanceIn; actor_id: string | null },
): Promise<FieldObservation> {
  await db
    .update(fieldObservations)
    .set({ is_current: false })
    .where(
      and(
        eq(fieldObservations.entity_type, o.entity_type),
        eq(fieldObservations.entity_id, o.entity_id),
        eq(fieldObservations.field, o.field),
        eq(fieldObservations.is_current, true),
      ),
    );
  // AI output can never land as verified without a human verification step.
  const verified = o.prov.verified && !o.prov.ai_derived;
  const [obs] = await db
    .insert(fieldObservations)
    .values({
      entity_type: o.entity_type,
      entity_id: o.entity_id,
      field: o.field,
      value: toJsonable(o.value),
      source: o.prov.source,
      observed_on: o.prov.observed_on ?? today(),
      confidence: o.prov.confidence,
      verification: verified ? "verified" : "unverified",
      ai_derived: o.prov.ai_derived,
      recorded_by_id: o.actor_id,
      verified_by_id: verified ? o.actor_id : null,
      verified_at: verified ? new Date() : null,
    })
    .returning();
  return obs;
}

/** Set attributes on `obj` (in memory only; the caller persists it). Changed material fields get an observation.
 *  Returns the diff. */
export async function applyMaterial(
  db: Db,
  obj: Record<string, any>,
  o: {
    entity_type: string;
    data: Record<string, any>;
    material_fields: Set<string>;
    prov: ProvenanceIn;
    actor_id: string | null;
  },
): Promise<Record<string, { from: any; to: any }>> {
  const changes: Record<string, { from: any; to: any }> = {};
  for (const [field, next] of Object.entries(o.data)) {
    if (next === undefined) continue;
    const old = obj[field];
    if (isEqual(old, next)) continue;
    changes[field] = { from: toJsonable(old ?? null), to: toJsonable(next) };
    obj[field] = next;
    if (o.material_fields.has(field) && next !== null) {
      await observe(db, {
        entity_type: o.entity_type,
        entity_id: obj.id,
        field,
        value: next,
        prov: o.prov,
        actor_id: o.actor_id,
      });
    }
  }
  return changes;
}

export async function currentObservations(db: Db, entity_type: string, entity_id: string): Promise<Record<string, FieldObservation>> {
  const rows = await db
    .select()
    .from(fieldObservations)
    .where(
      and(
        eq(fieldObservations.entity_type, entity_type),
        eq(fieldObservations.entity_id, entity_id),
        eq(fieldObservations.is_current, true),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.field, r]));
}

export async function history(db: Db, entity_type: string, entity_id: string, field?: string | null): Promise<FieldObservation[]> {
  return db
    .select()
    .from(fieldObservations)
    .where(
      and(
        eq(fieldObservations.entity_type, entity_type),
        eq(fieldObservations.entity_id, entity_id),
        field ? eq(fieldObservations.field, field) : undefined,
      ),
    )
    .orderBy(desc(fieldObservations.recorded_at));
}

export async function setVerification(db: Db, obs_id: string, state: Verification, actor_id: string): Promise<FieldObservation | null> {
  const obs = await get(db, fieldObservations, obs_id);
  if (!obs) return null;
  const [updated] = await db
    .update(fieldObservations)
    .set({ verification: state, verified_by_id: actor_id, verified_at: new Date() })
    .where(eq(fieldObservations.id, obs_id))
    .returning();
  return updated;
}
