import { and, eq, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { leases } from "./schema";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (reassign_to_id) {
    await db
      .update(leases)
      .set({ manager_id: reassign_to_id })
      .where(and(eq(leases.manager_id, user_id), isNull(leases.deleted_at)));
  }
});

/** Leases on an acquired property roll up to the new asset. */
events.on("closing.completed", async (db, { property_id, asset_id }) => {
  if (property_id && asset_id) {
    await db
      .update(leases)
      .set({ asset_id })
      .where(and(eq(leases.property_id, property_id), isNull(leases.asset_id), isNull(leases.deleted_at)));
  }
});
