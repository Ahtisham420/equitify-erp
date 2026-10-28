import { and, eq, inArray, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { inspections, pmSchedules, workOrders } from "./schema";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (!reassign_to_id) return;
  await db
    .update(workOrders)
    .set({ assigned_user_id: reassign_to_id })
    .where(and(eq(workOrders.assigned_user_id, user_id), isNull(workOrders.deleted_at), inArray(workOrders.status, ["open", "assigned", "in_progress"])));
  await db
    .update(pmSchedules)
    .set({ default_assignee_id: reassign_to_id })
    .where(and(eq(pmSchedules.default_assignee_id, user_id), isNull(pmSchedules.deleted_at)));
  await db
    .update(inspections)
    .set({ inspector_id: reassign_to_id })
    .where(and(eq(inspections.inspector_id, user_id), isNull(inspections.deleted_at), inArray(inspections.status, ["scheduled", "in_progress"])));
});
