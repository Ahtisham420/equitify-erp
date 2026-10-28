import { and, eq } from "drizzle-orm";

import * as events from "../../core/events";
import { signalSubscriptions } from "./schema";

// Subscriptions are personal: a deactivated user stops receiving signal alerts.
events.on("user.deactivated", async (db, { user_id }) => {
  await db
    .update(signalSubscriptions)
    .set({ is_active: false })
    .where(and(eq(signalSubscriptions.subscriber_id, user_id), eq(signalSubscriptions.is_active, true)));
});
