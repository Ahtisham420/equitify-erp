"""Internal provider-interface registry (spec 36: provider lock-in is a design defect).

Core business logic never imports vendor code. Vendor adapters register a factory per
(category, provider name); callers resolve the configured provider through this registry:

    from app.modules.platform import providers
    providers.register("esignature", "acme_sign", AcmeSign, required_config=["account_id"],
                       required_credentials=["api_key"])
    adapter = providers.build(entry, credentials)   # entry: IntegrationProvider row

A factory is called as `factory(config: dict, credentials: dict)` and may expose an optional
`async def test() -> tuple[bool, str]` used by the "Test connection" action.
"""
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

Factory = Callable[[dict, dict], Any]


@dataclass
class ProviderSpec:
    category: str
    name: str
    factory: Factory
    label: str
    required_config: list[str] = field(default_factory=list)
    required_credentials: list[str] = field(default_factory=list)
    description: str | None = None


_registry: dict[tuple[str, str], ProviderSpec] = {}


def register(
    category: str,
    name: str,
    factory: Factory,
    *,
    label: str | None = None,
    required_config: list[str] | None = None,
    required_credentials: list[str] | None = None,
    description: str | None = None,
) -> None:
    _registry[(category, name)] = ProviderSpec(
        category=category, name=name, factory=factory, label=label or name.replace("_", " ").title(),
        required_config=list(required_config or []), required_credentials=list(required_credentials or []),
        description=description,
    )


def get(category: str, name: str) -> ProviderSpec | None:
    return _registry.get((category, name))


def available(category: str | None = None) -> list[ProviderSpec]:
    return [s for (c, _), s in sorted(_registry.items()) if category is None or c == category]


def build(entry: Any, credentials: dict | None = None) -> Any:
    """Instantiate the adapter for a configured IntegrationProvider row (or raise LookupError)."""
    spec = get(entry.category, entry.provider)
    if spec is None:
        raise LookupError(f"No adapter registered for {entry.category}/{entry.provider}")
    return spec.factory(dict(entry.config or {}), dict(credentials or {}))


def validate(category: str, name: str, config: dict, credential_keys: list[str]) -> list[str]:
    """Missing required config/credential keys (empty list = valid)."""
    spec = get(category, name)
    if spec is None:
        return []
    missing = [f"config.{k}" for k in spec.required_config if config.get(k) in (None, "")]
    missing += [f"credentials.{k}" for k in spec.required_credentials if k not in credential_keys]
    return missing


# --- Built-in adapters ---------------------------------------------------------------------------


class ManualAdapter:
    """Records are entered or imported by users; no external system is called."""

    def __init__(self, config: dict, credentials: dict):
        self.config = config

    async def test(self) -> tuple[bool, str]:
        return True, "Manual entry and file imports are always available."


class LocalStorageAdapter:
    def __init__(self, config: dict, credentials: dict):
        self.config = config

    async def test(self) -> tuple[bool, str]:
        from pathlib import Path

        from app.core.config import settings

        root = Path(self.config.get("path") or settings.STORAGE_DIR)
        return (root.exists(), f"Storage directory {'is' if root.exists() else 'does not'} exist: {root.resolve()}")


class AnthropicAdapter:
    def __init__(self, config: dict, credentials: dict):
        self.config = config

    async def test(self) -> tuple[bool, str]:
        from app.modules.documents import ai

        status = ai.provider_status()
        if status["available"]:
            return True, f"AI provider {status['name']} is registered with model {status['model']}."
        return False, "ANTHROPIC_API_KEY is not set on the server; AI features run in degraded (manual) mode."


class GenericHttpAdapter:
    """Generic REST adapter placeholder: validated configuration only; vendor calls live in adapters."""

    def __init__(self, config: dict, credentials: dict):
        self.config = config
        self.has_credentials = bool(credentials)

    async def test(self) -> tuple[bool, str]:
        base = str(self.config.get("base_url") or "")
        if not base.startswith("https://"):
            return False, "base_url must be an https:// URL."
        return True, "Configuration is valid. Live calls are made by the vendor adapter when it is installed."


def _register_builtins() -> None:
    from app.modules.platform.models import INTEGRATION_CATEGORIES

    for category in INTEGRATION_CATEGORIES:
        register(category, "manual", ManualAdapter, label="Manual entry / import",
                 description="No external provider. Data is entered or imported by users.")
        register(category, "generic_http", GenericHttpAdapter, label="Generic REST API",
                 required_config=["base_url"], required_credentials=["api_key"],
                 description="Any HTTPS API secured with an API key.")
    register("storage", "local", LocalStorageAdapter, label="Server file storage",
             description="Private object storage on the application server (signed access only).")
    register("spreadsheets", "csv", ManualAdapter, label="CSV / XLSX files",
             description="Open-format import and export.")
    register("ai", "anthropic", AnthropicAdapter, label="Anthropic Claude",
             description="Assistive classification, extraction, summaries and natural-language search.")


_register_builtins()
