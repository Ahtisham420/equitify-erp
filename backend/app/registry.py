"""Module registry. Each module lives in app/modules/<name>/ and may provide:

    models.py    SQLAlchemy models (imported so metadata knows every table)
    router.py    `router: APIRouter` mounted under the API prefix
    handlers.py  domain event subscribers (`@events.on("...")`)
"""
import importlib
import importlib.util

from fastapi import FastAPI

MODULES = [
    "auth",
    "properties",
    "parcels",
    "contacts",
    "ownership",
    "territories",
    "buybox",
    "pipeline",
    "outreach",
    "compliance",
    "tasks",
    "imports",
    "search",
    "dashboard",
    # Release 2 — Intelligence
    "signals",
    "scoring",
    "reactivation",
    "comps",
    "underwriting",
    "documents",
    # Release 3 — Transaction
    "offers",
    "contracts",
    "closing",
    # Release 4 — Ownership
    "assets",
    "leases",
    "receivables",
    "debt",
    "dispositions",
    # Release 5 — Operations & Brokerage
    "maintenance",
    "operations",
    "investors",
    "brokerage",
    "dealroom",
    "commissions",
    # Release 6 — Leverage / platform
    "map",
    "reports",
    "platform",
]


def _load(module: str, part: str):
    name = f"app.modules.{module}.{part}"
    if importlib.util.find_spec(name) is None:
        return None
    return importlib.import_module(name)


def load_models() -> None:
    import app.common.audit  # noqa: F401
    import app.common.provenance  # noqa: F401

    for module in MODULES:
        _load(module, "models")


def load_handlers() -> None:
    for module in MODULES:
        _load(module, "handlers")


def mount_routers(app: FastAPI, prefix: str) -> None:
    for module in MODULES:
        mod = _load(module, "router")
        if mod is not None:
            app.include_router(mod.router, prefix=prefix)
