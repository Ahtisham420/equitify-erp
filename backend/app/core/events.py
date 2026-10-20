"""In-process domain event bus.

Modules publish facts (`property.created`, `opportunity.stage_changed`, ...) and other
modules subscribe in their `handlers.py`. Handlers run inside the caller's transaction so
derived work (Buy Box evaluation, tasks, alerts) commits atomically with the source change.
"""
import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("equitify.events")

Handler = Callable[..., Awaitable[Any]]
_handlers: dict[str, list[Handler]] = defaultdict(list)


def on(event: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        _handlers[event].append(fn)
        return fn

    return register


async def emit(db: AsyncSession, event: str, **payload: Any) -> None:
    handlers = _handlers.get(event, [])
    if handlers:
        # Sessions run with autoflush off; handlers query with SQL, so they must see the emitter's pending changes.
        await db.flush()
    for handler in handlers:
        log.debug("event %s -> %s", event, handler.__qualname__)
        await handler(db, **payload)
