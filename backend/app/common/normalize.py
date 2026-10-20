import re

_SUFFIXES = {
    "STREET": "ST", "AVENUE": "AVE", "BOULEVARD": "BLVD", "DRIVE": "DR", "ROAD": "RD", "LANE": "LN",
    "PARKWAY": "PKWY", "HIGHWAY": "HWY", "FREEWAY": "FWY", "COURT": "CT", "PLACE": "PL", "TERRACE": "TER",
    "CIRCLE": "CIR", "SQUARE": "SQ", "TRAIL": "TRL", "EXPRESSWAY": "EXPY", "SUITE": "STE", "NORTH": "N",
    "SOUTH": "S", "EAST": "E", "WEST": "W", "NORTHEAST": "NE", "NORTHWEST": "NW", "SOUTHEAST": "SE",
    "SOUTHWEST": "SW", "FARM TO MARKET": "FM",
}


def normalize_address(line: str | None, city: str | None = None, state: str | None = None, postal: str | None = None) -> str:
    """Deterministic key used for deduplication. Original observations are stored separately."""
    raw = " ".join(p for p in [line, city, state, (postal or "")[:5]] if p)
    s = re.sub(r"[^\w\s]", " ", raw.upper())
    for long, short in _SUFFIXES.items():
        s = re.sub(rf"\b{long}\b", short, s)
    return re.sub(r"\s+", " ", s).strip()


def normalize_apn(apn: str | None) -> str | None:
    if not apn:
        return None
    return re.sub(r"[^0-9A-Z]", "", apn.upper())


def normalize_name(name: str | None) -> str:
    if not name:
        return ""
    s = re.sub(r"[^\w\s]", " ", name.upper())
    s = re.sub(r"\b(LLC|L L C|INC|CORP|CORPORATION|LP|LTD|LLP|CO|COMPANY|TRUST|THE)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()
