/**
 * Keep rule-based territory membership current and reassign territories of departing users.
 *
 * Handlers run inside the caller's transaction and never commit.
 */
import * as events from "../../core/events";
import * as service from "./service";

events.on("property.created", async (db, { property_id }) => {
  await service.evaluateProperty(db, property_id);
});

events.on("property.updated", async (db, { property_id, changed }) => {
  await service.evaluateProperty(db, property_id, changed !== null && changed !== undefined ? new Set(changed) : null);
});

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  await service.reassignOwner(db, user_id, reassign_to_id);
});
