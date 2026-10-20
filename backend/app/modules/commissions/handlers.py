from app.core import events
from app.modules.commissions import service


async def _sync_deal(db, brokerage_deal_id=None, actor=None, **_):
    """Closing or expected closing creates/updates the commission record (runs in the caller's transaction)."""
    if not brokerage_deal_id:
        return
    # Sessions do not autoflush; deal_rows reads the table directly, so pending stage changes must be flushed.
    await db.flush()
    rows = await service.deal_rows(db, {brokerage_deal_id})
    if rows:
        await service.upsert_from_deal(db, rows[0], actor)


# Brokerage publishes these when a transaction is created, changes stage/estimates, or closes.
for _name in ("brokerage_deal.created", "brokerage_deal.updated", "brokerage_deal.stage_changed",
              "brokerage_deal.closed"):
    events.on(_name)(_sync_deal)
