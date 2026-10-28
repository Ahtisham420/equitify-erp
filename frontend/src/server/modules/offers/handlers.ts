import * as events from "../../core/events";
import * as service from "./service";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (user_id) await service.reassignUser(db, user_id, reassign_to_id);
});
