"""Platform event subscribers.

1. Startup hook: registers the Claude AI provider when ANTHROPIC_API_KEY is configured
   (handlers modules are imported once at startup by app.registry.load_handlers).
2. Domain-event → webhook bridge: matching subscriptions get `webhook_deliveries` outbox rows inside
   the caller's transaction. Delivery (network I/O) happens later in POST /platform/webhooks/deliver-pending.
"""
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.documents.claude_provider import register_ai
from app.modules.platform.service import WEBHOOK_EVENTS, enqueue

log = logging.getLogger("equitify.platform")

try:
    register_ai()
except Exception:  # noqa: BLE001 — AI is optional; never block startup
    log.exception("AI provider registration failed; continuing without AI")


def _bridge(event: str):
    async def handler(db: AsyncSession, **payload) -> None:
        # A SELECT plus db.add() only (no flush, no network); errors are logged, not raised.
        try:
            await enqueue(db, event, payload)
        except Exception:  # noqa: BLE001 — webhook fan-out must never break the business transaction
            log.exception("Could not enqueue webhook deliveries for %s", event)

    handler.__qualname__ = f"webhook_bridge[{event}]"
    return handler


for _event in WEBHOOK_EVENTS:
    events.on(_event)(_bridge(_event))
