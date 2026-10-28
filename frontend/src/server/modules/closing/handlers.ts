import * as events from "../../core/events";
import * as service from "./service";

// Reaching the closing stage opens the closing workspace (idempotent; runs in the caller's transaction).
events.on("opportunity.stage_changed", async (db, { opportunity_id, to_stage, actor }) => {
  if (opportunity_id && to_stage === "closing") await service.ensureClosing(db, opportunity_id, actor);
});

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (user_id) await service.reassignUser(db, user_id, reassign_to_id);
});
