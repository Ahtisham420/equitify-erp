import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import * as events from "../../core/events";
import { alertSubscriptions, alerts, tasks } from "./schema";

/** Open work never sits with a deactivated user: tasks/alerts move to the successor, subscriptions stop. */
events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (!user_id) return;
  await db.update(alertSubscriptions).set({ is_active: false }).where(eq(alertSubscriptions.subscriber_id, user_id));
  if (!reassign_to_id) return;
  await db
    .update(tasks)
    .set({ assignee_id: reassign_to_id })
    .where(and(eq(tasks.assignee_id, user_id), inArray(tasks.status, ["open", "in_progress"]), isNull(tasks.deleted_at)));
  await db
    .update(alerts)
    .set({ owner_id: reassign_to_id })
    .where(and(eq(alerts.owner_id, user_id), ne(alerts.status, "resolved"), isNull(alerts.deleted_at)));
});
