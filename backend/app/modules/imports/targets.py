"""Target-field metadata, value conversion and header-to-field mapping suggestions per entity type."""
import re
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
from typing import Any

from app.modules.properties.models import PROPERTY_STATUSES, PROPERTY_TYPES


@dataclass(frozen=True)
class Target:
    key: str
    label: str
    type: str = "string"  # string | integer | number | date | list | enum | email
    required: bool = False
    options: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()
    max_length: int | None = None
    group: str = "General"


PROPERTY_TYPE_ALIASES = {
    "single tenant net lease": "stnl", "single tenant": "stnl", "net lease": "stnl", "nnn": "stnl",
    "multi tenant retail": "multi_tenant_retail", "strip center": "multi_tenant_retail",
    "shopping center": "multi_tenant_retail", "gas station": "gas_convenience", "c store": "gas_convenience",
    "convenience store": "gas_convenience", "gas convenience": "gas_convenience", "medical office": "medical",
    "mob": "medical", "warehouse": "industrial", "flex": "industrial", "apartment": "multifamily",
    "apartments": "multifamily", "hotel": "hospitality", "motel": "hospitality", "mixed use": "mixed_use",
    "vacant land": "land", "ground lease": "ground_lease",
}

PROPERTY_TARGETS: list[Target] = [
    Target("name", "Property name", aliases=("property name", "building name", "name"), max_length=200, group="Identity"),
    Target("address_line", "Street address", required=True, max_length=255, group="Identity",
           aliases=("address", "street", "street address", "property address", "site address", "address 1", "address line 1")),
    Target("city", "City", aliases=("town", "property city"), max_length=120, group="Identity"),
    Target("state", "State", aliases=("st", "province", "property state"), max_length=40, group="Identity"),
    Target("postal_code", "Postal code", aliases=("zip", "zip code", "zipcode", "postal"), max_length=20, group="Identity"),
    Target("county", "County", aliases=("parish",), max_length=120, group="Identity"),
    Target("latitude", "Latitude", "number", aliases=("lat", "y"), group="Identity"),
    Target("longitude", "Longitude", "number", aliases=("lng", "lon", "long", "x"), group="Identity"),
    Target("property_type", "Property type", "enum", options=tuple(PROPERTY_TYPES), group="Classification",
           aliases=("type", "asset type", "property use", "use type", "asset class")),
    Target("property_subtype", "Subtype", aliases=("sub type", "secondary type"), max_length=80, group="Classification"),
    Target("status", "Status", "enum", options=tuple(PROPERTY_STATUSES), group="Classification"),
    Target("construction_class", "Construction class", aliases=("class", "building class"), max_length=20, group="Physical"),
    Target("building_area_sf", "Building area (SF)", "number", group="Physical",
           aliases=("sf", "gla", "rba", "building sf", "square feet", "building size", "sq ft", "gross leasable area")),
    Target("land_area_acres", "Land area (acres)", "number", aliases=("acres", "lot acres", "land acres", "lot size"), group="Physical"),
    Target("year_built", "Year built", "integer", aliases=("built", "yr built"), group="Physical"),
    Target("year_renovated", "Year renovated", "integer", aliases=("renovated", "yr renovated"), group="Physical"),
    Target("parking_spaces", "Parking spaces", "integer", aliases=("parking", "spaces"), group="Physical"),
    Target("asking_price", "Asking price", "number", aliases=("price", "list price", "asking"), group="Market & income"),
    Target("last_sale_price", "Last sale price", "number", aliases=("sale price", "sold price"), group="Market & income"),
    Target("last_sale_date", "Last sale date", "date", aliases=("sale date", "sold date"), group="Market & income"),
    Target("occupancy_pct", "Occupancy (%)", "number", aliases=("occupancy", "leased", "percent leased", "occ"), group="Market & income"),
    Target("wale_years", "WALE (years)", "number", aliases=("wale", "walt"), group="Market & income"),
    Target("noi", "NOI", "number", aliases=("net operating income",), group="Market & income"),
    Target("zoning", "Zoning", max_length=80, aliases=("zone", "zoning code"), group="Site"),
    Target("future_land_use", "Future land use", max_length=80, aliases=("flu",), group="Site"),
    Target("flood_zone", "Flood zone", max_length=20, aliases=("fema flood zone", "flood"), group="Site"),
    Target("traffic_count", "Traffic count (VPD)", "integer", aliases=("vpd", "traffic", "aadt", "adt"), group="Site"),
    Target("corridor", "Corridor", max_length=160, group="Site"),
    Target("notes", "Notes", aliases=("comments", "description"), group="Other"),
    Target("tags", "Tags", "list", aliases=("labels", "tag"), group="Other"),
]

PERSON_TARGETS: list[Target] = [
    Target("first_name", "First name", aliases=("first", "given name", "fname"), max_length=120),
    Target("last_name", "Last name", aliases=("last", "surname", "family name", "lname"), max_length=120),
    Target("full_name", "Full name", aliases=("name", "contact name", "contact", "person"), max_length=200),
    Target("title", "Title", aliases=("job title", "position", "role"), max_length=200),
    Target("primary_email", "Email", "email", aliases=("email", "email address", "e mail"), max_length=255),
    Target("primary_phone", "Phone", aliases=("phone", "phone number", "mobile", "cell", "telephone"), max_length=40),
    Target("mailing_address", "Mailing address", aliases=("address", "street", "mailing street"), max_length=255),
    Target("city", "City", max_length=120),
    Target("state", "State", aliases=("st",), max_length=40),
    Target("tags", "Tags", "list", aliases=("labels",)),
]

ORGANIZATION_TARGETS: list[Target] = [
    Target("name", "Name", required=True, max_length=200,
           aliases=("company", "company name", "organization", "organization name", "entity", "entity name", "owner name")),
    Target("legal_name", "Legal name", aliases=("legal entity", "registered name"), max_length=200),
    Target("org_type", "Organization type", aliases=("type", "entity type", "company type"), max_length=60),
    Target("website", "Website", aliases=("url", "web", "web site"), max_length=255),
    Target("domain", "Domain", aliases=("email domain",), max_length=255),
    Target("phone", "Phone", aliases=("phone number", "telephone", "main phone"), max_length=40),
    Target("mailing_address", "Mailing address", aliases=("address", "street"), max_length=255),
    Target("city", "City", max_length=120),
    Target("state", "State", aliases=("st",), max_length=40),
    Target("tags", "Tags", "list", aliases=("labels",)),
]

TARGETS: dict[str, list[Target]] = {
    "property": PROPERTY_TARGETS,
    "person": PERSON_TARGETS,
    "organization": ORGANIZATION_TARGETS,
}

_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%m-%d-%Y", "%d-%b-%Y", "%b %d, %Y", "%B %d, %Y")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _number(text: str) -> float:
    s = text.replace(",", "").replace("$", "").replace("%", "").replace(" ", "")
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    return float(s)


def convert(t: Target, raw: Any) -> tuple[Any, str | None]:
    """Convert one raw CSV cell to the target type. Returns (value, error)."""
    if raw is None:
        return None, None
    text = str(raw).strip()
    if text == "":
        return None, None
    try:
        if t.type == "integer":
            n = _number(text)
            if n != int(n):
                return None, f"{t.label} must be a whole number"
            return int(n), None
        if t.type == "number":
            return _number(text), None
        if t.type == "date":
            for fmt in _DATE_FORMATS:
                try:
                    return datetime.strptime(text, fmt).date().isoformat(), None
                except ValueError:
                    continue
            return None, f"{t.label} is not a recognised date (use YYYY-MM-DD)"
        if t.type == "list":
            return [p.strip() for p in re.split(r"[;,|]", text) if p.strip()], None
        if t.type == "enum":
            key = _norm(text)
            candidate = key.replace(" ", "_")
            if candidate in t.options:
                return candidate, None
            if t.key == "property_type" and key in PROPERTY_TYPE_ALIASES:
                return PROPERTY_TYPE_ALIASES[key], None
            return None, f"{t.label} '{text}' is not one of: {', '.join(t.options)}"
        if t.type == "email":
            if not _EMAIL.match(text):
                return None, f"'{text}' is not a valid email address"
            return text.lower(), None
    except (ValueError, OverflowError):
        return None, f"{t.label} '{text}' is not a valid number"
    if t.max_length and len(text) > t.max_length:
        return None, f"{t.label} is longer than {t.max_length} characters"
    return text, None


def suggest_mapping(headers: list[str], targets: list[Target]) -> dict[str, str | None]:
    """Fuzzy header match against key, label and aliases; each field is used at most once."""
    scored: list[tuple[float, str, str]] = []
    for h in headers:
        nh = _norm(h)
        if not nh:
            continue
        for t in targets:
            candidates = {_norm(t.key), _norm(t.label), *(_norm(a) for a in t.aliases)}
            best = max(1.0 if nh == c else SequenceMatcher(None, nh, c).ratio() for c in candidates)
            if best >= 0.8:
                scored.append((best, h, t.key))
    scored.sort(key=lambda s: -s[0])
    mapping: dict[str, str | None] = {h: None for h in headers}
    used: set[str] = set()
    for _, header, key in scored:
        if mapping[header] is None and key not in used:
            mapping[header] = key
            used.add(key)
    return mapping
