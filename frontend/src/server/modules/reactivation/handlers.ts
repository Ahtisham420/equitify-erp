/** Reactivation automations: arm triggers at dead disposition; evaluate them when related facts change. */
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import * as events from "../../core/events";
import { get } from "../../db/orm";
import { opportunities } from "../pipeline/schema";
import { ownedProperties } from "../signals/service";
import { reactivationItems, reactivationTriggers } from "./schema";
import * as service from "./service";

const SIGNAL_TYPES = new Set(["debt", "lease", "market", "development", "ownership", "price"]);

events.on("opportunity.dead", async (db, { opportunity_id, actor = null }) => {
  const o = await get(db, opportunities, opportunity_id);
  if (o && o.stage === "dead") await service.armFromOpportunity(db, o, actor);
});

events.on("opportunity.stage_changed", async (db, { opportunity_id, from_stage = null, to_stage = null, actor = null }) => {
  if (from_stage === "dead" && to_stage && to_stage !== "dead") await service.onLeftDead(db, opportunity_id, to_stage, actor);
  if (to_stage && service.CONVERTED_STAGES.has(to_stage)) await service.markConverted(db, opportunity_id);
});

events.on("closing.completed", async (db, { opportunity_id = null }) => {
  if (opportunity_id) await service.markConverted(db, opportunity_id);
});

events.on("property.updated", async (db, { property_id, actor = null }) => {
  await service.checkProperty(db, property_id, { types: new Set(["price", "manual"]), actor });
});

events.on("ownership.changed", async (db, { property_id, actor = null }) => {
  await service.checkProperty(db, property_id, { types: new Set(["ownership", "relationship"]), actor });
});

events.on("signal.created", async (db, { property_id = null, owner_kind = null, owner_id = null, actor = null }) => {
  const pids: string[] = property_id ? [property_id] : [];
  if (owner_kind && owner_id) {
    for (const p of await ownedProperties(db, owner_kind, owner_id)) if (!pids.includes(p)) pids.push(p);
  }
  for (const pid of pids.slice(0, 50)) await service.checkProperty(db, pid, { types: SIGNAL_TYPES, actor });
});

events.on(
  "interaction.logged",
  async (
    db,
    {
      person_id = null, organization_id = null, property_id = null, opportunity_id = null, disposition = null,
      direction = null, meaningful = false, actor = null,
    },
  ) => {
    if (!service.POSITIVE_DISPOSITIONS.has(disposition) && !(direction === "inbound" && meaningful)) return;
    const conds: SQL[] = [];
    if (opportunity_id) conds.push(eq(opportunities.id, opportunity_id));
    if (property_id) conds.push(eq(opportunities.property_id, property_id));
    if (person_id) conds.push(eq(opportunities.primary_person_id, person_id));
    if (organization_id) conds.push(eq(opportunities.primary_organization_id, organization_id));
    const ids: string[] = conds.length
      ? (
          await db
            .select({ id: opportunities.id })
            .from(opportunities)
            .where(and(eq(opportunities.stage, "dead"), or(...conds)))
        ).map((r) => r.id)
      : [];
    // Owners of a dead deal's property count as a warm path too (checked against the trigger baseline).
    if (person_id || organization_id) {
      const key = person_id ? `person:${person_id}` : `organization:${organization_id}`;
      const rows = await db
        .select({ id: reactivationTriggers.opportunity_id })
        .from(reactivationTriggers)
        .where(
          and(
            eq(reactivationTriggers.status, "armed"),
            eq(reactivationTriggers.trigger_type, "relationship"),
            sql`${reactivationTriggers.baseline} -> 'owners' @> ${JSON.stringify([key])}::jsonb`,
          ),
        );
      const have = new Set(ids);
      ids.push(...rows.map((r) => r.id).filter((i) => !have.has(i)));
    }
    await service.checkOpportunities(db, ids, { types: new Set(["relationship"]), actor });
  },
);

events.on("loan.maturity_window", async (db, { property_id = null, actor = null }) => {
  await service.checkProperty(db, property_id, { types: new Set(["debt"]), actor });
});

events.on("user.deactivated", async (db, { user_id, reassign_to_id = null }) => {
  if (reassign_to_id) {
    await db
      .update(reactivationItems)
      .set({ owner_id: reassign_to_id })
      .where(and(eq(reactivationItems.owner_id, user_id), inArray(reactivationItems.status, ["pending", "snoozed"])));
  }
});
