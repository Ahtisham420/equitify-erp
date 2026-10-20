"""Anthropic Claude implementation of the documents `AIProvider` protocol (Release 6).

Registered at startup only when ANTHROPIC_API_KEY is set (see `register_ai()`, called from
platform/handlers.py). Without a key the NullProvider stays active and every AI feature degrades
to manual workflows. Output is always assistive: callers store it as pending suggestions /
verification items, never as verified facts.
"""
import asyncio
import base64
import json
import logging
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.modules.documents import ai

log = logging.getLogger("equitify.ai.claude")

MAX_TOKENS = 16000
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_TEXT_CHARS = 400_000

_client: Any = None


class AIRefused(RuntimeError):
    """The model declined the request (stop_reason == "refusal"); treated as a skipped AI call."""


class AIUnavailable(RuntimeError):
    """Transient provider failure after retries (rate limit, 5xx, connection)."""


def _get_client() -> Any:
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY or None)
    return _client


def pdf_block(path: str | Path) -> dict | None:
    """Base64 PDF document block (≤32 MB), or None when the file is missing/too large."""
    p = Path(path)
    try:
        if not p.is_file() or p.stat().st_size > MAX_PDF_BYTES:
            return None
        data = base64.b64encode(p.read_bytes()).decode("ascii")  # b64encode emits no newlines
    except OSError:
        return None
    return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}}


def document_content(d: Any) -> tuple[str, str | None]:
    """(text, pdf_path) for a `Document`: PDFs are sent natively from the stored file, others as text_content.

    Usage from the documents service: `text, pdf = document_content(d)` then
    `provider.extract(text, doc_class, schema, pdf_path=pdf)`.
    """
    if (d.mime_type or "").lower() == "application/pdf" and d.storage_key:
        from app.modules.documents.service import file_path

        try:
            return d.text_content or "", str(file_path(d.storage_key))
        except Exception:  # noqa: BLE001 — fall back to text
            pass
    return d.text_content or "", None


def _schema(properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": properties, "required": required or list(properties),
            "additionalProperties": False}


NULLABLE_STR = {"type": ["string", "null"]}
NULLABLE_INT = {"type": ["integer", "null"]}

SYSTEM = (
    "You are the assistive AI layer of EquitiFy, a commercial real estate operating system. "
    "Your output is reviewed by a named human before it is used; it never becomes authoritative on its own. "
    "Only state what the supplied material supports. When something is not stated, return null or omit it "
    "rather than guessing. Cite page numbers and clause references exactly as they appear."
)


class ClaudeProvider:
    name = "anthropic"

    def __init__(self, model: str | None = None):
        self.model = model or settings.AI_MODEL or "claude-opus-5-5"
        self.available = bool(settings.ANTHROPIC_API_KEY)
        self.last_usage: dict | None = None

    # --- core call -------------------------------------------------------------------------------

    async def structured(self, *, prompt: str, schema: dict, effort: str = "medium", system: str | None = None,
                         documents: list[dict] | None = None) -> dict:
        """One JSON-schema-constrained call. Raises AIRefused / AIUnavailable / RuntimeError on failure."""
        import anthropic

        self.last_usage = None
        content: list[dict] = list(documents or [])  # document blocks go before the instruction text
        content.append({"type": "text", "text": prompt})
        client = _get_client()
        attempts = 3
        for attempt in range(1, attempts + 1):
            try:
                response = await client.beta.messages.create(
                    model=self.model,
                    max_tokens=MAX_TOKENS,
                    betas=[FALLBACK_BETA],
                    fallbacks="default",
                    system=system or SYSTEM,
                    messages=[{"role": "user", "content": content}],
                    output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
                )
                break
            except anthropic.RateLimitError as exc:
                if attempt == attempts:
                    raise AIUnavailable(f"Rate limited by the AI provider: {exc}") from exc
            except anthropic.APIStatusError as exc:
                if exc.status_code < 500 or attempt == attempts:
                    raise RuntimeError(f"AI provider error {exc.status_code}: {exc}") from exc
            except anthropic.APIConnectionError as exc:
                if attempt == attempts:
                    raise AIUnavailable(f"Cannot reach the AI provider: {exc}") from exc
            await asyncio.sleep(2 ** attempt)

        usage = getattr(response, "usage", None)
        if usage is not None:
            self.last_usage = {"input_tokens": getattr(usage, "input_tokens", None),
                               "output_tokens": getattr(usage, "output_tokens", None)}
        if response.stop_reason == "refusal":
            category = getattr(getattr(response, "stop_details", None), "category", None)
            log.warning("AI request refused (category=%s)", category)
            raise AIRefused(f"The AI model declined this request{f' ({category})' if category else ''}")
        if response.stop_reason == "max_tokens":
            raise RuntimeError("AI response was truncated (max_tokens)")
        text = next((b.text for b in response.content if getattr(b, "type", None) == "text"), None)
        if not text:
            raise RuntimeError("AI response contained no text")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError("AI response was not valid JSON") from exc
        if not isinstance(data, dict):
            raise RuntimeError("AI response was not a JSON object")
        return data

    @staticmethod
    def _material(text: str, pdf_path: str | None) -> tuple[list[dict], str]:
        block = pdf_block(pdf_path) if pdf_path else None
        if block:
            return [block], "The document is attached above."
        return [], f"<document>\n{(text or '')[:MAX_TEXT_CHARS]}\n</document>"

    # --- AIProvider protocol ---------------------------------------------------------------------

    async def classify(self, text: str, filename: str, *, pdf_path: str | None = None) -> dict:
        from app.modules.documents.models import DOC_CLASSES

        docs, body = self._material((text or "")[:20_000], pdf_path)
        schema = _schema({"doc_class": {"type": "string", "enum": DOC_CLASSES}, "confidence": {"type": "number"}})
        prompt = (f"Classify this commercial real estate document into exactly one class. Filename: {filename}\n\n"
                  f"{body}\n\nReturn the class and your confidence between 0 and 1.")
        data = await self.structured(prompt=prompt, schema=schema, effort="low", documents=docs)
        doc_class = data.get("doc_class")
        return {"doc_class": doc_class if doc_class in DOC_CLASSES else None,
                "confidence": _clamp(data.get("confidence"))}

    async def extract(self, text: str, doc_class: str, schema: list[ai.SchemaField], *,
                      pdf_path: str | None = None) -> list[dict]:
        fields = [s["field"] for s in schema if s.get("field")]
        if not fields:
            return []
        types = {s["field"]: s.get("type", "text") for s in schema if s.get("field")}
        listing = "\n".join(f"- {s['field']} ({s.get('type', 'text')}): {s.get('label', s['field'])}"
                            for s in schema if s.get("field"))
        out_schema = _schema({"values": {"type": "array", "items": _schema({
            "field": {"type": "string", "enum": fields},
            "value": {"type": "string"},
            "page": NULLABLE_INT,
            "clause": NULLABLE_STR,
            "citation_text": {"type": "string"},
            "confidence": {"type": "number"},
        })}})
        docs, body = self._material(text, pdf_path)
        prompt = (
            f"Extract the following fields from this {doc_class.replace('_', ' ')} document.\n{listing}\n\n"
            "Rules: only extract values the document states explicitly; skip fields it does not contain. "
            "Dates as YYYY-MM-DD. Money, numbers and percents as plain numbers without symbols or commas. "
            "For every value give the page number, the clause/section reference if any, the exact supporting "
            "text (citation_text) and a confidence between 0 and 1.\n\n" + body
        )
        data = await self.structured(prompt=prompt, schema=out_schema, effort="medium", documents=docs)
        items = []
        for v in data.get("values") or []:
            if not isinstance(v, dict) or v.get("field") not in types:
                continue
            items.append({
                "field": v["field"],
                "value": _coerce(v.get("value"), types[v["field"]]),
                "page": v.get("page"),
                "clause": v.get("clause"),
                "citation_text": v.get("citation_text"),
                "confidence": _clamp(v.get("confidence")),
            })
        return items

    async def summarize(self, texts: list[ai.SourceText], purpose: str) -> dict:
        drafting = purpose.startswith("draft:")
        pdfs = await _pdf_blocks([t["document_id"] for t in texts if t.get("document_id")]) if not drafting else {}
        docs: list[dict] = []
        parts: list[str] = []
        for t in texts:
            block = pdfs.get(t.get("document_id") or "")
            if block:
                docs.append(block)
                parts.append(f'Attached document #{len(docs)} = document_id "{t["document_id"]}" ({t["title"]})')
            else:
                parts.append(f'<source document_id="{t.get("document_id", "")}" title="{t["title"]}">\n'
                             f'{(t.get("text") or "")[:MAX_TEXT_CHARS // max(len(texts), 1)]}\n</source>')
        material = "\n\n".join(parts)
        if drafting:
            kind = purpose.split(":", 1)[1]
            prompt = (
                f"Polish the following {kind} draft into clear, professional business prose. Use only the verified "
                "facts it contains; do not add numbers, dates, names or claims that are not present. Keep "
                "placeholders in square brackets. Return the finished text as `summary` and no citations.\n\n"
                + material
            )
        else:
            prompt = (
                f"Write a concise, factual summary of the sources below for this purpose: {purpose}. "
                "Use short paragraphs or bullet points. Every material statement must be supported by a citation "
                "(document_id, page if known, clause if any, and the supporting text).\n\n" + material
            )
        schema = _schema({"summary": {"type": "string"}, "citations": {"type": "array", "items": _schema({
            "document_id": {"type": "string"}, "page": NULLABLE_INT, "clause": NULLABLE_STR,
            "text": {"type": "string"}})}})
        data = await self.structured(prompt=prompt, schema=schema, effort="medium", documents=docs)
        valid_ids = {t.get("document_id") for t in texts}
        citations = [c for c in (data.get("citations") or [])
                     if isinstance(c, dict) and c.get("document_id") in valid_ids and c.get("document_id")]
        return {"summary": str(data.get("summary") or ""), "citations": citations}


async def _pdf_blocks(document_ids: list[str]) -> dict[str, dict]:
    """Load native PDF blocks for up to 5 PDF documents (own short-lived session; read only)."""
    import uuid

    from sqlalchemy import select

    from app.core.database import SessionLocal
    from app.modules.documents.models import Document
    from app.modules.documents.service import file_path

    ids = []
    for i in document_ids:
        try:
            ids.append(uuid.UUID(str(i)))
        except ValueError:
            continue
    if not ids:
        return {}
    out: dict[str, dict] = {}
    try:
        async with SessionLocal() as s:
            rows = list(await s.scalars(select(Document).where(Document.id.in_(ids),
                                                              Document.mime_type == "application/pdf")))
        for d in rows[:5]:
            try:
                block = pdf_block(file_path(d.storage_key))
            except Exception:  # noqa: BLE001
                block = None
            if block:
                out[str(d.id)] = block
    except Exception:  # noqa: BLE001 — fall back to text content
        return {}
    return out


def _clamp(v: Any) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


def _coerce(value: Any, value_type: str) -> Any:
    if value is None:
        return None
    if value_type in ("number", "money", "percent"):
        try:
            return float(str(value).replace(",", "").replace("$", "").replace("%", "").strip())
        except ValueError:
            return value
    return value


def register_ai() -> bool:
    """Register Claude as the default AI provider when ANTHROPIC_API_KEY is configured."""
    if not settings.ANTHROPIC_API_KEY:
        return False
    try:
        import anthropic  # noqa: F401 — verify the SDK is installed before registering
    except ImportError:
        log.warning("ANTHROPIC_API_KEY is set but the anthropic package is not installed; AI stays disabled")
        return False
    ai.register_provider(ClaudeProvider(settings.AI_MODEL), default=True)
    log.info("Registered Claude AI provider (%s)", settings.AI_MODEL)
    return True
