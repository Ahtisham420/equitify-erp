/** Target-field metadata, value conversion and header-to-field mapping suggestions per entity type. */
import { PROPERTY_STATUSES, PROPERTY_TYPES } from "../properties/schema";

export interface Target {
  key: string;
  label: string;
  type: string; // string | integer | number | date | list | enum | email
  required: boolean;
  options: readonly string[];
  aliases: readonly string[];
  max_length: number | null;
  group: string;
}

/** `Target(key, label, type?, ...)` with the Python dataclass defaults. */
function T(
  key: string,
  label: string,
  type = "string",
  o: { required?: boolean; options?: readonly string[]; aliases?: readonly string[]; max_length?: number; group?: string } = {},
): Target {
  return {
    key, label, type, required: o.required ?? false, options: o.options ?? [], aliases: o.aliases ?? [],
    max_length: o.max_length ?? null, group: o.group ?? "General",
  };
}

const PROPERTY_TYPE_ALIASES: Record<string, string> = {
  "single tenant net lease": "stnl", "single tenant": "stnl", "net lease": "stnl", nnn: "stnl",
  "multi tenant retail": "multi_tenant_retail", "strip center": "multi_tenant_retail",
  "shopping center": "multi_tenant_retail", "gas station": "gas_convenience", "c store": "gas_convenience",
  "convenience store": "gas_convenience", "gas convenience": "gas_convenience", "medical office": "medical",
  mob: "medical", warehouse: "industrial", flex: "industrial", apartment: "multifamily",
  apartments: "multifamily", hotel: "hospitality", motel: "hospitality", "mixed use": "mixed_use",
  "vacant land": "land", "ground lease": "ground_lease",
};

export const PROPERTY_TARGETS: Target[] = [
  T("name", "Property name", "string", { aliases: ["property name", "building name", "name"], max_length: 200, group: "Identity" }),
  T("address_line", "Street address", "string", {
    required: true, max_length: 255, group: "Identity",
    aliases: ["address", "street", "street address", "property address", "site address", "address 1", "address line 1"],
  }),
  T("city", "City", "string", { aliases: ["town", "property city"], max_length: 120, group: "Identity" }),
  T("state", "State", "string", { aliases: ["st", "province", "property state"], max_length: 40, group: "Identity" }),
  T("postal_code", "Postal code", "string", { aliases: ["zip", "zip code", "zipcode", "postal"], max_length: 20, group: "Identity" }),
  T("county", "County", "string", { aliases: ["parish"], max_length: 120, group: "Identity" }),
  T("latitude", "Latitude", "number", { aliases: ["lat", "y"], group: "Identity" }),
  T("longitude", "Longitude", "number", { aliases: ["lng", "lon", "long", "x"], group: "Identity" }),
  T("property_type", "Property type", "enum", {
    options: PROPERTY_TYPES, group: "Classification", aliases: ["type", "asset type", "property use", "use type", "asset class"],
  }),
  T("property_subtype", "Subtype", "string", { aliases: ["sub type", "secondary type"], max_length: 80, group: "Classification" }),
  T("status", "Status", "enum", { options: PROPERTY_STATUSES, group: "Classification" }),
  T("construction_class", "Construction class", "string", { aliases: ["class", "building class"], max_length: 20, group: "Physical" }),
  T("building_area_sf", "Building area (SF)", "number", {
    group: "Physical",
    aliases: ["sf", "gla", "rba", "building sf", "square feet", "building size", "sq ft", "gross leasable area"],
  }),
  T("land_area_acres", "Land area (acres)", "number", { aliases: ["acres", "lot acres", "land acres", "lot size"], group: "Physical" }),
  T("year_built", "Year built", "integer", { aliases: ["built", "yr built"], group: "Physical" }),
  T("year_renovated", "Year renovated", "integer", { aliases: ["renovated", "yr renovated"], group: "Physical" }),
  T("parking_spaces", "Parking spaces", "integer", { aliases: ["parking", "spaces"], group: "Physical" }),
  T("asking_price", "Asking price", "number", { aliases: ["price", "list price", "asking"], group: "Market & income" }),
  T("last_sale_price", "Last sale price", "number", { aliases: ["sale price", "sold price"], group: "Market & income" }),
  T("last_sale_date", "Last sale date", "date", { aliases: ["sale date", "sold date"], group: "Market & income" }),
  T("occupancy_pct", "Occupancy (%)", "number", {
    aliases: ["occupancy", "leased", "percent leased", "occ"], group: "Market & income",
  }),
  T("wale_years", "WALE (years)", "number", { aliases: ["wale", "walt"], group: "Market & income" }),
  T("noi", "NOI", "number", { aliases: ["net operating income"], group: "Market & income" }),
  T("zoning", "Zoning", "string", { max_length: 80, aliases: ["zone", "zoning code"], group: "Site" }),
  T("future_land_use", "Future land use", "string", { max_length: 80, aliases: ["flu"], group: "Site" }),
  T("flood_zone", "Flood zone", "string", { max_length: 20, aliases: ["fema flood zone", "flood"], group: "Site" }),
  T("traffic_count", "Traffic count (VPD)", "integer", { aliases: ["vpd", "traffic", "aadt", "adt"], group: "Site" }),
  T("corridor", "Corridor", "string", { max_length: 160, group: "Site" }),
  T("notes", "Notes", "string", { aliases: ["comments", "description"], group: "Other" }),
  T("tags", "Tags", "list", { aliases: ["labels", "tag"], group: "Other" }),
];

export const PERSON_TARGETS: Target[] = [
  T("first_name", "First name", "string", { aliases: ["first", "given name", "fname"], max_length: 120 }),
  T("last_name", "Last name", "string", { aliases: ["last", "surname", "family name", "lname"], max_length: 120 }),
  T("full_name", "Full name", "string", { aliases: ["name", "contact name", "contact", "person"], max_length: 200 }),
  T("title", "Title", "string", { aliases: ["job title", "position", "role"], max_length: 200 }),
  T("primary_email", "Email", "email", { aliases: ["email", "email address", "e mail"], max_length: 255 }),
  T("primary_phone", "Phone", "string", { aliases: ["phone", "phone number", "mobile", "cell", "telephone"], max_length: 40 }),
  T("mailing_address", "Mailing address", "string", { aliases: ["address", "street", "mailing street"], max_length: 255 }),
  T("city", "City", "string", { max_length: 120 }),
  T("state", "State", "string", { aliases: ["st"], max_length: 40 }),
  T("tags", "Tags", "list", { aliases: ["labels"] }),
];

export const ORGANIZATION_TARGETS: Target[] = [
  T("name", "Name", "string", {
    required: true, max_length: 200,
    aliases: ["company", "company name", "organization", "organization name", "entity", "entity name", "owner name"],
  }),
  T("legal_name", "Legal name", "string", { aliases: ["legal entity", "registered name"], max_length: 200 }),
  T("org_type", "Organization type", "string", { aliases: ["type", "entity type", "company type"], max_length: 60 }),
  T("website", "Website", "string", { aliases: ["url", "web", "web site"], max_length: 255 }),
  T("domain", "Domain", "string", { aliases: ["email domain"], max_length: 255 }),
  T("phone", "Phone", "string", { aliases: ["phone number", "telephone", "main phone"], max_length: 40 }),
  T("mailing_address", "Mailing address", "string", { aliases: ["address", "street"], max_length: 255 }),
  T("city", "City", "string", { max_length: 120 }),
  T("state", "State", "string", { aliases: ["st"], max_length: 40 }),
  T("tags", "Tags", "list", { aliases: ["labels"] }),
];

export const TARGETS: Record<string, Target[]> = {
  property: PROPERTY_TARGETS,
  person: PERSON_TARGETS,
  organization: ORGANIZATION_TARGETS,
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_FULL = [
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

class ValueError extends Error {}

function toNumber(text: string): number {
  let s = text.replace(/,/g, "").replace(/\$/g, "").replace(/%/g, "").replace(/ /g, "");
  if (s.startsWith("(") && s.endsWith(")")) s = "-" + s.slice(1, -1);
  if (!FLOAT.test(s)) throw new ValueError("could not convert string to float");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new ValueError("not finite");
  return n;
}

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The `strptime` formats the importer accepts, as anchored regexes (numeric fields take 1-2 digits like strptime). */
const DATE_PARSERS: Array<(s: string) => string | null> = [
  (s) => { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); return m ? validDate(+m[1], +m[2], +m[3]) : null; }, // %Y-%m-%d
  (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); return m ? validDate(+m[3], +m[1], +m[2]) : null; }, // %m/%d/%Y
  (s) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s); // %m/%d/%y
    if (!m) return null;
    const yy = +m[3];
    return validDate(yy >= 69 ? 1900 + yy : 2000 + yy, +m[1], +m[2]);
  },
  (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s); return m ? validDate(+m[1], +m[2], +m[3]) : null; }, // %Y/%m/%d
  (s) => { const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s); return m ? validDate(+m[3], +m[1], +m[2]) : null; }, // %m-%d-%Y
  (s) => { // %d-%b-%Y
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
    const mi = m ? MONTH_ABBR.indexOf(m[2].toLowerCase()) : -1;
    return m && mi >= 0 ? validDate(+m[3], mi + 1, +m[1]) : null;
  },
  (s) => { // %b %d, %Y
    const m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(s);
    const mi = m ? MONTH_ABBR.indexOf(m[1].toLowerCase()) : -1;
    return m && mi >= 0 ? validDate(+m[3], mi + 1, +m[2]) : null;
  },
  (s) => { // %B %d, %Y
    const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(s);
    const mi = m ? MONTH_FULL.indexOf(m[1].toLowerCase()) : -1;
    return m && mi >= 0 ? validDate(+m[3], mi + 1, +m[2]) : null;
  },
];

/** Convert one raw CSV cell to the target type. Returns [value, error]. */
export function convert(t: Target, raw: unknown): [any, string | null] {
  if (raw === null || raw === undefined) return [null, null];
  const text = String(raw).trim();
  if (text === "") return [null, null];
  try {
    if (t.type === "integer") {
      const n = toNumber(text);
      if (n !== Math.trunc(n)) return [null, `${t.label} must be a whole number`];
      return [Math.trunc(n), null];
    }
    if (t.type === "number") return [toNumber(text), null];
    if (t.type === "date") {
      for (const parse of DATE_PARSERS) {
        const d = parse(text);
        if (d) return [d, null];
      }
      return [null, `${t.label} is not a recognised date (use YYYY-MM-DD)`];
    }
    if (t.type === "list") return [text.split(/[;,|]/).map((p) => p.trim()).filter(Boolean), null];
    if (t.type === "enum") {
      const key = norm(text);
      const candidate = key.replace(/ /g, "_");
      if (t.options.includes(candidate)) return [candidate, null];
      if (t.key === "property_type" && key in PROPERTY_TYPE_ALIASES) return [PROPERTY_TYPE_ALIASES[key], null];
      return [null, `${t.label} '${text}' is not one of: ${t.options.join(", ")}`];
    }
    if (t.type === "email") {
      if (!EMAIL.test(text)) return [null, `'${text}' is not a valid email address`];
      return [text.toLowerCase(), null];
    }
  } catch (e) {
    if (e instanceof ValueError) return [null, `${t.label} '${text}' is not a valid number`];
    throw e;
  }
  if (t.max_length && text.length > t.max_length) return [null, `${t.label} is longer than ${t.max_length} characters`];
  return [text, null];
}

/** difflib.SequenceMatcher(None, a, b).ratio() (no junk heuristics; inputs here are short header strings). */
export function sequenceRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1.0;
  let matches = 0;
  const stack: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    // longest common substring, earliest in a then earliest in b
    let bi = alo;
    let bj = blo;
    let bk = 0;
    let prev = new Array<number>(bhi - blo + 1).fill(0);
    for (let i = alo; i < ahi; i++) {
      const cur = new Array<number>(bhi - blo + 1).fill(0);
      for (let j = blo; j < bhi; j++) {
        if (a[i] === b[j]) {
          const k = prev[j - blo] + 1;
          cur[j - blo + 1] = k;
          if (k > bk) {
            bi = i - k + 1;
            bj = j - k + 1;
            bk = k;
          }
        }
      }
      prev = cur;
    }
    if (bk) {
      matches += bk;
      if (alo < bi && blo < bj) stack.push([alo, bi, blo, bj]);
      if (bi + bk < ahi && bj + bk < bhi) stack.push([bi + bk, ahi, bj + bk, bhi]);
    }
  }
  return (2.0 * matches) / (a.length + b.length);
}

/** Fuzzy header match against key, label and aliases; each field is used at most once. */
export function suggestMapping(headers: string[], targets: Target[]): Record<string, string | null> {
  const scored: Array<[number, string, string]> = [];
  for (const h of headers) {
    const nh = norm(h);
    if (!nh) continue;
    for (const t of targets) {
      const candidates = new Set([norm(t.key), norm(t.label), ...t.aliases.map(norm)]);
      let best = 0;
      for (const c of candidates) best = Math.max(best, nh === c ? 1.0 : sequenceRatio(nh, c));
      if (best >= 0.8) scored.push([best, h, t.key]);
    }
  }
  scored.sort((x, y) => y[0] - x[0]); // stable, like Python's sort
  const mapping: Record<string, string | null> = {};
  for (const h of headers) mapping[h] = null;
  const used = new Set<string>();
  for (const [, header, key] of scored) {
    if (mapping[header] === null && !used.has(key)) {
      mapping[header] = key;
      used.add(key);
    }
  }
  return mapping;
}
