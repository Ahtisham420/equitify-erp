const SUFFIXES: Record<string, string> = {
  STREET: "ST", AVENUE: "AVE", BOULEVARD: "BLVD", DRIVE: "DR", ROAD: "RD", LANE: "LN",
  PARKWAY: "PKWY", HIGHWAY: "HWY", FREEWAY: "FWY", COURT: "CT", PLACE: "PL", TERRACE: "TER",
  CIRCLE: "CIR", SQUARE: "SQ", TRAIL: "TRL", EXPRESSWAY: "EXPY", SUITE: "STE", NORTH: "N",
  SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE",
  SOUTHWEST: "SW", "FARM TO MARKET": "FM",
};

/** Deterministic key used for deduplication. Original observations are stored separately. */
export function normalizeAddress(line?: string | null, city?: string | null, state?: string | null, postal?: string | null): string {
  const raw = [line, city, state, (postal ?? "").slice(0, 5)].filter(Boolean).join(" ");
  let s = raw.toUpperCase().replace(/[^\w\s]/g, " ");
  for (const [long, short] of Object.entries(SUFFIXES)) s = s.replace(new RegExp(`\\b${long}\\b`, "g"), short);
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeApn(apn?: string | null): string | null {
  if (!apn) return null;
  return apn.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function normalizeName(name?: string | null): string {
  if (!name) return "";
  let s = name.toUpperCase().replace(/[^\w\s]/g, " ");
  s = s.replace(/\b(LLC|L L C|INC|CORP|CORPORATION|LP|LTD|LLP|CO|COMPANY|TRUST|THE)\b/g, " ");
  return s.replace(/\s+/g, " ").trim();
}
