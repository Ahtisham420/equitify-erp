import { and, eq, isNull } from "drizzle-orm";

import * as events from "../../core/events";
import { lenderReportingObligations, loans } from "./schema";

events.on("user.deactivated", async (db, { user_id, reassign_to_id }) => {
  if (!reassign_to_id) return;
  await db
    .update(loans)
    .set({ owner_id: reassign_to_id })
    .where(and(eq(loans.owner_id, user_id), isNull(loans.deleted_at)));
  await db
    .update(lenderReportingObligations)
    .set({ owner_id: reassign_to_id })
    .where(and(eq(lenderReportingObligations.owner_id, user_id), isNull(lenderReportingObligations.deleted_at)));
});

// Loans recorded while a property was being pursued attach to the new asset automatically.
events.on("asset.created", async (db, { asset_id, property_id }) => {
  if (!property_id) return;
  await db
    .update(loans)
    .set({ asset_id })
    .where(and(eq(loans.property_id, property_id), isNull(loans.asset_id), isNull(loans.deleted_at)));
});
