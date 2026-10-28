/** Buy box automations: evaluate new properties and re-evaluate when referenced facts change. */
import { eq } from "drizzle-orm";

import * as events from "../../core/events";
import { buyBoxes } from "./schema";
import * as service from "./service";

const actorId = (actor: any): string | null => actor?.id ?? null;

events.on("property.created", async (db, { property_id, actor }) => {
  await service.evaluateProperty(db, property_id, { trigger: "property_created", actor_id: actorId(actor) });
});

events.on("property.updated", async (db, { property_id, changed, actor }) => {
  // Only boxes whose criteria reference a changed field are re-evaluated (see evaluateProperty).
  await service.evaluateProperty(db, property_id, {
    trigger: "property_updated",
    actor_id: actorId(actor),
    changed: new Set<string>(changed ?? []),
  });
});

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (reassign_to_id) await db.update(buyBoxes).set({ owner_id: reassign_to_id }).where(eq(buyBoxes.owner_id, user_id));
});
