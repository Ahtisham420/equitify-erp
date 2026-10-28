import * as events from "../../core/events";
import * as service from "./service";

/** Closing or expected closing creates/updates the commission record (runs in the caller's transaction). */
async function syncDeal(db: Parameters<typeof service.dealRows>[0], { brokerage_deal_id, actor }: Record<string, any>) {
  if (!brokerage_deal_id) return;
  const rows = await service.dealRows(db, new Set([brokerage_deal_id]));
  if (rows.length) await service.upsertFromDeal(db, rows[0], actor ?? null);
}

// Brokerage publishes these when a transaction is created, changes stage/estimates, or closes.
for (const name of ["brokerage_deal.created", "brokerage_deal.updated", "brokerage_deal.stage_changed", "brokerage_deal.closed"]) {
  events.on(name, syncDeal);
}
