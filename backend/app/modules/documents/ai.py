"""AI provider interface for the documents module.

The platform treats AI as an assistive layer: providers classify, extract and summarize, but
nothing they return is authoritative. Every call is logged to `ai_calls`, extracted values land
as `pending` verification items, and calls never block user paths (extraction runs in background
tasks and degrades to `skipped` when no provider is available).

Release 6 plugs a real provider in with:

    from app.modules.documents import ai
    ai.register_provider(MyProvider(), default=True)

No other code changes are required.
"""
import hashlib
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Protocol, TypedDict, TypeVar, runtime_checkable

from sqlalchemy.ext.asyncio import AsyncSession

T = TypeVar("T")


class SourceText(TypedDict):
    document_id: str
    title: str
    text: str


class SchemaField(TypedDict, total=False):
    field: str
    label: str
    type: str  # text | number | money | date | percent


@runtime_checkable
class AIProvider(Protocol):
    name: str
    model: str
    available: bool
    # Optional token usage of the most recent call: {"input_tokens": int, "output_tokens": int}.
    last_usage: dict | None

    async def classify(self, text: str, filename: str) -> dict:
        """Return {"doc_class": str | None, "confidence": float}."""
        ...

    async def extract(self, text: str, doc_class: str, schema: list[SchemaField]) -> list[dict]:
        """Return [{field, value, page, clause, citation_text, confidence}]."""
        ...

    async def summarize(self, texts: list[SourceText], purpose: str) -> dict:
        """Return {"summary": str, "citations": [{document_id, page, clause, text}]}."""
        ...


class NullProvider:
    """No-op provider used until a real one is registered. Returns empty results."""

    name = "none"
    model = "none"
    available = False
    last_usage: dict | None = None

    async def classify(self, text: str, filename: str) -> dict:
        return {"doc_class": None, "confidence": 0.0}

    async def extract(self, text: str, doc_class: str, schema: list[SchemaField]) -> list[dict]:
        return []

    async def summarize(self, texts: list[SourceText], purpose: str) -> dict:
        return {"summary": "", "citations": []}


_registry: dict[str, AIProvider] = {}
_default: str | None = None


def register_provider(provider: AIProvider, *, default: bool = True) -> None:
    global _default
    _registry[provider.name] = provider
    if default or _default is None:
        _default = provider.name


def unregister_provider(name: str) -> None:
    global _default
    _registry.pop(name, None)
    if _default == name:
        _default = next(iter(_registry), None)


def get_provider(name: str | None = None) -> AIProvider:
    key = name or _default
    if key and key in _registry:
        return _registry[key]
    return NullProvider()


def provider_status() -> dict:
    p = get_provider()
    return {"name": p.name, "model": p.model, "available": bool(p.available)}


def prompt_hash(*parts: Any) -> str:
    raw = json.dumps(parts, default=str, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


async def logged_call(
    db: AsyncSession,
    provider: AIProvider,
    *,
    purpose: str,
    prompt_parts: tuple,
    call: Callable[[], Awaitable[T]],
    document_id: uuid.UUID | None = None,
    actor_id: uuid.UUID | None = None,
    summarize_output: Callable[[T], dict] | None = None,
) -> T:
    """Run one provider call and write an `ai_calls` row (success or error). Does not commit."""
    from app.modules.documents.models import AICall

    started = time.perf_counter()
    status, error, result = "ok", None, None
    try:
        result = await call()
        return result
    except Exception as exc:  # noqa: BLE001 — provider failures are logged, then re-raised to the caller
        status, error = "error", f"{type(exc).__name__}: {exc}"[:2000]
        raise
    finally:
        usage = getattr(provider, "last_usage", None) or {}
        db.add(AICall(
            provider=provider.name,
            model=provider.model,
            purpose=purpose,
            prompt_hash=prompt_hash(*prompt_parts),
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            latency_ms=int((time.perf_counter() - started) * 1000),
            status=status,
            error=error,
            output_summary=summarize_output(result) if (summarize_output and result is not None) else None,
            document_id=document_id,
            created_by_id=actor_id,
        ))
