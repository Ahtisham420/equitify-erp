import { and, eq, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { contracts, criticalDates, ddItems, riskItems, thirdPartyReports } from "./schema";

/** Accountable owners must never point at an inactive user. */
events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (!reassign_to_id) return;
  for (const t of [contracts, criticalDates, ddItems, riskItems, thirdPartyReports]) {
    await db
      .update(t)
      .set({ owner_id: reassign_to_id })
      .where(and(eq(t.owner_id, user_id), isNull(t.deleted_at)));
  }
});
