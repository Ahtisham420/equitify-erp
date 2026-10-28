import { eq } from "drizzle-orm";

import * as events from "../../core/events";
import { organizations, people } from "./schema";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (!user_id || !reassign_to_id) return;
  for (const table of [people, organizations]) {
    await db.update(table).set({ owner_id: reassign_to_id }).where(eq(table.owner_id, user_id));
  }
});
