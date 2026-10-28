import { and, eq, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { opportunities } from "./schema";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (reassign_to_id) {
    await db
      .update(opportunities)
      .set({ owner_id: reassign_to_id })
      .where(and(eq(opportunities.owner_id, user_id), isNull(opportunities.deleted_at)));
  }
});
