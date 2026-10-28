import { and, eq, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { compSets } from "./schema";

/** Hand open comp sets to the replacement owner. Analyst/verifier attribution on history is never rewritten. */
events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (user_id && reassign_to_id) {
    await db
      .update(compSets)
      .set({ owner_id: reassign_to_id })
      .where(and(eq(compSets.owner_id, user_id), isNull(compSets.deleted_at)));
  }
});
