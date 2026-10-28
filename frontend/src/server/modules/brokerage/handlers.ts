import * as events from "../../core/events";
import { reassignUser } from "./service";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (reassign_to_id) await reassignUser(db, user_id, reassign_to_id);
});
