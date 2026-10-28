/**
 * Platform event subscribers.
 *
 * 1. Startup hook: registers the Claude AI provider when ANTHROPIC_API_KEY is configured.
 * 2. Domain-event -> webhook bridge: matching subscriptions get `webhook_deliveries` outbox rows inside
 *    the caller's transaction. Delivery (network I/O) happens later in the scheduler job / POST
 *    /platform/webhooks/deliver-pending.
 */
import * as events from "../../core/events";
import { registerAi } from "../documents/claude_provider";
import { enqueue, WEBHOOK_EVENTS } from "./service";

try {
  registerAi();
} catch (err) {
  // AI is optional; never block startup
  console.error("[platform] AI provider registration failed; continuing without AI", err);
}

for (const event of WEBHOOK_EVENTS) {
  events.on(event, async (db, payload) => {
    // A SELECT plus inserts only (no network); errors are logged, not raised.
    try {
      await enqueue(db, event, payload);
    } catch (err) {
      // webhook fan-out must never break the business transaction
      console.error(`[platform] Could not enqueue webhook deliveries for ${event}`, err);
    }
  });
}
