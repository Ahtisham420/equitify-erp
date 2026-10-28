import * as events from "../../core/events";
import * as service from "./service";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (reassign_to_id) await service.reassignOwner(db, user_id, reassign_to_id);
});
