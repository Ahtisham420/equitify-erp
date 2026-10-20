"""Property-type templates that seed the assumption structure of a new underwriting model (spec module 12).

Template defaults are deliberately left *unsourced* (`source: None`) so the analyst must confirm or source every
material assumption before approval; values copied from records (property, spaces, leases, comps) carry a source.
"""
import uuid
from datetime import date
from typing import Any

TEMPLATES: dict[str, dict[str, Any]] = {
    "stnl": {"label": "Single-tenant net lease", "model_type": "income"},
    "multi_tenant_retail": {"label": "Multi-tenant retail", "model_type": "income"},
    "gas_convenience": {"label": "Gas / convenience", "model_type": "income"},
    "medical": {"label": "Medical", "model_type": "income"},
    "ground_lease": {"label": "Ground lease", "model_type": "income"},
    "land": {"label": "Land", "model_type": "land"},
}

# Suggested template per property type.
PROPERTY_TYPE_TEMPLATE = {
    "stnl": "stnl", "retail": "multi_tenant_retail", "multi_tenant_retail": "multi_tenant_retail",
    "gas_convenience": "gas_convenience", "medical": "medical", "ground_lease": "ground_lease", "land": "land",
}

LEASE_DEFAULTS: dict[str, dict[str, Any]] = {
    "stnl": dict(recovery_type="nnn", escalation_pct=1.5, renewal=75, downtime=9, term=10, ti_new=10, ti_renewal=0,
                 lc_new=4, lc_renewal=2, free=3),
    "multi_tenant_retail": dict(recovery_type="nnn", escalation_pct=3, renewal=65, downtime=6, term=5, ti_new=15,
                                ti_renewal=5, lc_new=6, lc_renewal=3, free=3),
    "gas_convenience": dict(recovery_type="nnn", escalation_pct=1.5, renewal=80, downtime=12, term=10, ti_new=25,
                            ti_renewal=0, lc_new=4, lc_renewal=2, free=3),
    "medical": dict(recovery_type="base_year", escalation_pct=3, renewal=70, downtime=9, term=7, ti_new=45,
                    ti_renewal=15, lc_new=6, lc_renewal=3, free=4),
    "ground_lease": dict(recovery_type="nnn", escalation_pct=1, renewal=90, downtime=12, term=20, ti_new=0,
                         ti_renewal=0, lc_new=0, lc_renewal=0, free=0),
}

EXPENSE_LINES: dict[str, list[tuple[str, str, bool]]] = {
    "stnl": [],
    "multi_tenant_retail": [("Real estate taxes", "tax", True), ("Insurance", "insurance", True),
                            ("Common area maintenance", "cam", True), ("Utilities", "utilities", True),
                            ("Non-recoverable repairs", "repairs", False)],
    "gas_convenience": [("Environmental monitoring", "other", False)],
    "medical": [("Real estate taxes", "tax", True), ("Insurance", "insurance", True),
                ("Common area maintenance", "cam", True), ("Utilities", "utilities", True),
                ("Janitorial", "other", True)],
    "ground_lease": [],
}

SETTINGS: dict[str, dict[str, Any]] = {
    "stnl": dict(vacancy=0, credit=0, mgmt=1, mgmt_rec=False, reserves=0.10, stab=1, ltv=60, dscr=1.25, dy=8),
    "multi_tenant_retail": dict(vacancy=3, credit=1, mgmt=4, mgmt_rec=True, reserves=0.20, stab=2, ltv=60, dscr=1.30, dy=9),
    "gas_convenience": dict(vacancy=0, credit=0, mgmt=1, mgmt_rec=False, reserves=0.25, stab=1, ltv=55, dscr=1.30, dy=9),
    "medical": dict(vacancy=5, credit=0.5, mgmt=3.5, mgmt_rec=True, reserves=0.25, stab=2, ltv=60, dscr=1.30, dy=9),
    "ground_lease": dict(vacancy=0, credit=0, mgmt=0, mgmt_rec=False, reserves=0, stab=1, ltv=65, dscr=1.20, dy=7),
}

INCOME_SCENARIOS = [
    {"key": "base", "name": "Base", "kind": "base", "overrides": {}},
    {"key": "downside", "name": "Downside", "kind": "downside", "overrides": {
        "exit.exit_cap": {"delta": 0.5}, "revenue.general_vacancy_pct": {"delta": 3},
        "revenue.market_rent_growth_pct": {"delta": -1}, "leases.*.renewal_probability_pct": {"delta": -20},
        "financing.interest_rate": {"delta": 0.5}}},
    {"key": "upside", "name": "Upside", "kind": "upside", "overrides": {
        "exit.exit_cap": {"delta": -0.25}, "revenue.market_rent_growth_pct": {"delta": 0.5},
        "leases.*.renewal_probability_pct": {"delta": 10}}},
]
LAND_SCENARIOS = [
    {"key": "base", "name": "Base", "kind": "base", "overrides": {}},
    {"key": "downside", "name": "Downside", "kind": "downside", "overrides": {
        "land.bulk_price_per_usable_acre": {"mult": 0.9}, "land.entitlement_months": {"delta": 6},
        "land.entitlement_cost": {"mult": 1.2}}},
    {"key": "upside", "name": "Upside", "kind": "upside", "overrides": {"land.bulk_price_per_usable_acre": {"mult": 1.1}}},
]


def sv(value: Any = None, source: str | None = None, **extra: Any) -> dict[str, Any]:
    """Sourced value."""
    return {"value": value, "source": source, **extra}


def short_id() -> str:
    return uuid.uuid4().hex[:8]


def lease_row(template: str, *, tenant: str | None = None, suite: str | None = None, space_id: str | None = None,
              lease_id: str | None = None, area_sf: float | None = None, vacant: bool = False,
              base_rent_annual: float | None = None, rent_source: str | None = None, commencement_on: str | None = None,
              expiration_on: str | None = None, rent_steps: list | None = None, source: str | None = None) -> dict:
    d = LEASE_DEFAULTS.get(template, LEASE_DEFAULTS["multi_tenant_retail"])
    return {
        "id": short_id(), "tenant": tenant, "suite": suite, "space_id": space_id, "lease_id": lease_id,
        "row_source": source, "area_sf": area_sf, "vacant": vacant,
        "commencement_on": commencement_on, "expiration_on": expiration_on,
        "base_rent_annual": sv(base_rent_annual, rent_source), "rent_psf": None, "rent_steps": rent_steps or [],
        "escalation_pct": d["escalation_pct"], "recovery_type": d["recovery_type"], "expense_stop_psf": None,
        "recovery_share_pct": None, "fixed_recovery_annual": None, "abatements": [],
        "percentage_rent": {"rate_pct": None, "sales_annual": None, "sales_growth_pct": None, "breakpoint": None},
        "options": [], "renewal_probability_pct": sv(d["renewal"]), "downtime_months": d["downtime"],
        "market_rent_psf": sv(None), "new_lease_term_years": d["term"], "ti_new_psf": d["ti_new"],
        "ti_renewal_psf": d["ti_renewal"], "lc_new_pct": d["lc_new"], "lc_renewal_pct": d["lc_renewal"],
        "free_rent_new_months": d["free"], "tenant_credit": None,
    }


def seed(template: str, *, start: date, purchase_price: float | None = None, price_source: str | None = None,
         total_area_sf: float | None = None, area_source: str | None = None, gross_acres: float | None = None,
         acres_source: str | None = None) -> dict:
    """Blank assumption structure for a template."""
    if template not in TEMPLATES:
        template = "multi_tenant_retail"
    common = {
        "template": template,
        "model_type": TEMPLATES[template]["model_type"],
        "acquisition": {
            "purchase_price": sv(purchase_price, price_source), "closing_cost_pct": sv(1.5),
            "analysis_start": start.replace(day=1).isoformat(), "hold_years": sv(10), "stabilized_year": 1,
        },
        "capex": [],
    }
    if template == "land":
        return {
            **common,
            "financing": {"use_debt": False, "ltv_max": sv(50), "interest_rate": sv(8.0), "loan_fee_pct": 1.0},
            "land": {
                "gross_acres": sv(gross_acres, acres_source), "usable_acres": sv(None), "detention_acres": 0,
                "floodplain_acres": 0, "row_acres": 0, "frontage_ft": None, "utilities_available": [],
                "entitlement_status": None, "entitlement_cost": sv(None), "entitlement_months": 9,
                "utilities_cost": sv(None), "site_work_cost": sv(None), "detention_cost": 0, "development_months": 6,
                "exit_method": "bulk_sale", "bulk_price_per_usable_acre": sv(None), "bulk_sale_price": None,
                "lots": [], "absorption_months": 18, "ground_lease_rent_annual": sv(None),
                "ground_lease_escalation_pct": 1.5, "ground_lease_cap": sv(None), "bts_sale_price": None,
                "construction_months": 9, "selling_cost_pct": 3, "carry_tax_annual": None,
                "carry_insurance_annual": None, "carry_other_annual": None,
            },
            "scenarios_seed": LAND_SCENARIOS,
        }
    s = SETTINGS[template]
    return {
        **common,
        "acquisition": {**common["acquisition"], "stabilized_year": s["stab"]},
        "financing": {
            "use_debt": True, "ltv_max": sv(s["ltv"]), "dscr_min": sv(s["dscr"]), "debt_yield_min": sv(s["dy"]),
            "interest_rate": sv(6.5), "amortization_years": 25, "io_years": 0, "loan_fee_pct": 1.0,
            "loan_amount_override": None,
        },
        "exit": {"exit_cap": sv(None), "selling_cost_pct": 2.0, "exit_noi_basis": "forward"},
        "revenue": {
            "general_vacancy_pct": sv(s["vacancy"]), "credit_loss_pct": s["credit"], "other_income": 0,
            "market_rent_growth_pct": sv(2.5), "total_area_sf": total_area_sf, "total_area_source": area_source,
        },
        "expense_settings": {
            "mgmt_fee_pct": sv(s["mgmt"]), "mgmt_recoverable": s["mgmt_rec"], "expense_growth_pct": 3.0,
            "reserves_psf": s["reserves"], "structural_reserve_annual": 0,
            "tax_reassessment": {"enabled": False, "assessment_ratio_pct": 100, "tax_rate_pct": 2.0},
            "insurance_repricing": {"enabled": False, "new_annual_amount": None, "change_pct": 0},
        },
        "leases": [],
        "expenses": [
            {"id": short_id(), "name": name, "category": cat, "annual_amount": sv(0), "growth_pct": None,
             "recoverable": rec}
            for name, cat, rec in EXPENSE_LINES[template]
        ],
        "scenarios_seed": INCOME_SCENARIOS,
    }
