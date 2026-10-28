import { and, eq, inArray, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { assetMilestones, assets, varianceExplanations } from "./schema";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (!reassign_to_id) return;
  await db
    .update(assets)
    .set({ manager_id: reassign_to_id })
    .where(and(eq(assets.manager_id, user_id), isNull(assets.deleted_at)));
  await db
    .update(assetMilestones)
    .set({ owner_id: reassign_to_id })
    .where(and(eq(assetMilestones.owner_id, user_id), inArray(assetMilestones.status, ["planned", "in_progress"])));
  await db
    .update(varianceExplanations)
    .set({ owner_id: reassign_to_id })
    .where(and(eq(varianceExplanations.owner_id, user_id), inArray(varianceExplanations.status, ["required", "rejected"])));
});
