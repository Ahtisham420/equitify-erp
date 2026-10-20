"""Permission catalogue and default role profiles (spec module 1)."""

ACTIONS = ["view", "create", "edit", "approve", "export", "delete", "view_sensitive"]

MODULES: dict[str, str] = {
    "users": "Users & Access",
    "audit": "Audit Log",
    "properties": "Properties",
    "parcels": "Parcels & Spaces",
    "contacts": "People & Organizations",
    "ownership": "Ownership Intelligence",
    "territories": "Geography & Territories",
    "buybox": "Buy Box",
    "pipeline": "Acquisition Pipeline",
    "outreach": "Outreach & Follow-up",
    "compliance": "Communication Compliance",
    "tasks": "Tasks & Alerts",
    "imports": "Data Imports",
    "search": "Search & Saved Views",
    "dashboard": "Dashboards",
    # Release 2 — Intelligence
    "signals": "Motivation & Market Signals",
    "scoring": "Opportunity Scoring",
    "reactivation": "Reactivation",
    "comps": "Comparables & Valuation",
    "underwriting": "Underwriting",
    "documents": "Documents & AI",
    # Release 3 — Transaction
    "offers": "Offers & LOIs",
    "contracts": "Contracts & Due Diligence",
    "closing": "Closing & Handoff",
    # Release 4 — Ownership
    "assets": "Asset & Portfolio",
    "leases": "Leases & Rent Roll",
    "receivables": "Receivables",
    "debt": "Debt & Capital Stack",
    "dispositions": "Dispositions & 1031",
    # Release 5 — Operations & Brokerage
    "maintenance": "Maintenance & Inspections",
    "operations": "Vendors, CapEx, Insurance & Tax",
    "investors": "Capital Partners",
    "brokerage": "Brokerage & Listings",
    "dealroom": "Tours & Deal Room",
    "commissions": "Commissions",
    # Release 6 — Leverage / platform
    "map": "Map",
    "reports": "Reports & Analytics",
    "platform": "Platform & Integrations",
}

ALL = ["view", "create", "edit", "approve", "export", "delete", "view_sensitive"]
RW = ["view", "create", "edit"]
RO = ["view"]


def _grant(**modules: list[str]) -> dict[str, list[str]]:
    return {m: a for m, a in modules.items()}


DEFAULT_ROLES: list[dict] = [
    {
        "key": "admin",
        "name": "Executive / Admin",
        "description": "Full access including administration, approvals and audit.",
        "permissions": {"*": ["*"]},
        "approval_limits": {"underwriting": None, "offer": None, "capital": None},
    },
    {
        "key": "acquisitions_manager",
        "name": "Acquisitions Manager",
        "description": "Owns the acquisition pipeline, approvals within limits.",
        "permissions": _grant(
            properties=ALL, parcels=ALL, contacts=ALL, ownership=ALL, territories=RW + ["export"],
            buybox=RW + ["approve"], pipeline=ALL, outreach=ALL, compliance=RO, tasks=ALL,
            imports=RW, search=RW + ["export"], dashboard=RO, audit=RO,
            signals=RW, scoring=RW + ["approve"], reactivation=RW, comps=RW + ["approve"],
            underwriting=RW + ["approve"], documents=RW, offers=RW + ["approve"], contracts=RW + ["approve"],
            closing=RW + ["approve"], debt=RO, assets=RO, map=RO, reports=RO + ["export"],
        ),
        "approval_limits": {"underwriting": 25_000_000, "offer": 25_000_000},
    },
    {
        "key": "analyst",
        "name": "Analyst",
        "description": "Research, data quality and underwriting support.",
        "permissions": _grant(
            properties=RW, parcels=RW, contacts=RW, ownership=RW, territories=RO, buybox=RO,
            pipeline=RW, outreach=RW, compliance=RO, tasks=RW, imports=RW, search=RW, dashboard=RO,
            signals=RW, scoring=RO, reactivation=RO, comps=RW, underwriting=RW, documents=RW, offers=RO,
            contracts=RO, leases=RW, debt=RO, assets=RO, map=RO, reports=RO,
        ),
        "approval_limits": {},
    },
    {
        "key": "asset_manager",
        "name": "Asset Manager",
        "description": "Operates owned assets and portfolio performance.",
        "permissions": _grant(
            properties=RW, parcels=RW, contacts=RW, ownership=RO, territories=RO, pipeline=RO,
            outreach=RW, tasks=RW, search=RW, dashboard=RO,
            assets=ALL, leases=ALL, receivables=RW + ["approve"], debt=ALL, dispositions=ALL,
            maintenance=RW + ["approve"], operations=RW + ["approve"], investors=RW, comps=RW,
            underwriting=RO, documents=RW, closing=RO, signals=RO, map=RO, reports=RO + ["export"],
        ),
        "approval_limits": {"capital": 250_000},
    },
    {
        "key": "property_manager",
        "name": "Property Manager",
        "description": "Day-to-day property operations.",
        "permissions": _grant(
            properties=RO, parcels=RW, contacts=RW, outreach=RW, tasks=RW, search=RW, dashboard=RO,
            leases=RO, receivables=RW, maintenance=ALL, operations=RW, documents=RW, assets=RO, map=RO,
        ),
        "approval_limits": {},
    },
    {
        "key": "transaction_coordinator",
        "name": "Transaction / DD Coordinator",
        "description": "Contracts, critical dates and due diligence.",
        "permissions": _grant(
            properties=RO, parcels=RO, contacts=RW, pipeline=RW, tasks=ALL, search=RW, dashboard=RO,
            offers=RO, contracts=ALL, closing=RW, documents=RW, dispositions=RW, underwriting=RO,
        ),
        "approval_limits": {},
    },
    {
        "key": "broker",
        "name": "Broker / Agent",
        "description": "Brokerage workflows on permitted shared data and own production.",
        "permissions": _grant(
            properties=RO, parcels=RO, contacts=RW, ownership=RO, outreach=RW, compliance=RO, tasks=RW,
            search=RW, dashboard=RO, comps=RO, brokerage=RW, dealroom=RW, commissions=RO, documents=RW, map=RO,
        ),
        "approval_limits": {},
    },
    {
        "key": "capital_partner",
        "name": "Capital Partner",
        "description": "Read-only access to own assets and capital accounts.",
        # Investor portal: the investors module scopes every query to the partner's own accounts.
        "permissions": _grant(dashboard=RO, investors=RO),
        "approval_limits": {},
    },
    {
        "key": "service",
        "name": "Service Integration",
        "description": "Programmatic access; scopes are set per credential.",
        "permissions": {},
        "approval_limits": {},
    },
]


def allows(permissions: dict[str, list[str]], module: str, action: str) -> bool:
    if "*" in permissions.get("*", []):
        return True
    granted = permissions.get(module, [])
    return "*" in granted or action in granted


def scopes_to_permissions(scopes: list[str]) -> dict[str, list[str]]:
    """Service credential scopes look like `properties:view`."""
    perms: dict[str, list[str]] = {}
    for scope in scopes:
        module, _, action = scope.partition(":")
        if module and action:
            perms.setdefault(module, []).append(action)
    return perms
