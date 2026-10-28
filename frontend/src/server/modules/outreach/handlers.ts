import { and, eq, inArray } from "drizzle-orm";

import * as events from "../../core/events";
import { sequenceEnrollments, sequences } from "./schema";

/** Active sequence work follows the successor so queued steps are not orphaned. */
events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (!user_id || !reassign_to_id) return;
  await db
    .update(sequenceEnrollments)
    .set({ owner_id: reassign_to_id })
    .where(and(eq(sequenceEnrollments.owner_id, user_id), inArray(sequenceEnrollments.status, ["active", "paused"])));
  await db.update(sequences).set({ owner_id: reassign_to_id }).where(eq(sequences.owner_id, user_id));
});
