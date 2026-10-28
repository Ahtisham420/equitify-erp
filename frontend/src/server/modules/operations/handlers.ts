import { and, eq, isNull, notInArray } from "drizzle-orm";

import * as events from "../../core/events";
import { capitalProjects } from "./schema";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (reassign_to_id) {
    await db
      .update(capitalProjects)
      .set({ manager_id: reassign_to_id })
      .where(
        and(
          eq(capitalProjects.manager_id, user_id),
          isNull(capitalProjects.deleted_at),
          notInArray(capitalProjects.status, ["closed", "cancelled"]),
        ),
      );
  }
});
