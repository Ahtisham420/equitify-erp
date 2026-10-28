import { and, eq, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { capitalPartners } from "./schema";

/**
 * Relationship ownership moves to the successor. Portal links are left intact (access is
 * already blocked for deactivated users) so the partner's history stays attributable.
 */
events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (user_id && reassign_to_id) {
    await db
      .update(capitalPartners)
      .set({ owner_id: reassign_to_id })
      .where(and(eq(capitalPartners.owner_id, user_id), isNull(capitalPartners.deleted_at)));
  }
});
