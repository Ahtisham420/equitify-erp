/** Global search. Each source declares its permission module, so results never leak across permissions. */
import { and, ilike, isNull, or, type AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { CurrentUser } from "../../core/deps";
import type { Db } from "../../db";
import { organizations, people } from "../contacts/schema";
import { parcels } from "../parcels/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";

interface Source {
  type: string;
  module: string;
  table: PgTable;
  /** Columns read by title/subtitle/href (and searched, see `searchable`). */
  columns: Record<string, AnyColumn>;
  searchable: string[];
  title: (r: Record<string, any>) => string;
  subtitle: (r: Record<string, any>) => string | null;
  href: (r: Record<string, any>) => string;
}

const join = (...parts: Array<string | null | undefined>): string | null => parts.filter(Boolean).join(", ") || null;

// Python str.capitalize(): first character upper, the rest lower.
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function sources(): Source[] {
  const p = properties;
  const o = opportunities;
  const pe = people;
  const og = organizations;
  const pa = parcels;
  return [
    {
      type: "property", module: "properties", table: p,
      columns: {
        id: p.id, name: p.name, address_line: p.address_line, city: p.city, county: p.county, state: p.state,
        normalized_address: p.normalized_address,
      },
      searchable: ["name", "address_line", "city", "county", "normalized_address"],
      title: (r) => r.name || r.address_line,
      subtitle: (r) => join(r.name ? r.address_line : null, r.city, r.state),
      href: (r) => `/properties/${r.id}`,
    },
    {
      type: "opportunity", module: "pipeline", table: o,
      columns: { id: o.id, title: o.title, stage: o.stage },
      searchable: ["title"],
      title: (r) => r.title,
      subtitle: (r) => capitalize(String(r.stage).replace(/_/g, " ")),
      href: (r) => `/pipeline/${r.id}`,
    },
    {
      type: "person", module: "contacts", table: pe,
      columns: { id: pe.id, full_name: pe.full_name, title: pe.title, city: pe.city, state: pe.state, primary_email: pe.primary_email },
      searchable: ["full_name", "title", "city", "primary_email"],
      title: (r) => r.full_name,
      subtitle: (r) => join(r.title, r.city, r.state),
      href: (r) => `/people/${r.id}`,
    },
    {
      type: "organization", module: "contacts", table: og,
      columns: { id: og.id, name: og.name, legal_name: og.legal_name, domain: og.domain, city: og.city, state: og.state },
      searchable: ["name", "legal_name", "domain"],
      title: (r) => r.name,
      subtitle: (r) => join(r.legal_name !== r.name ? r.legal_name : null, r.city, r.state),
      href: (r) => `/organizations/${r.id}`,
    },
    {
      type: "parcel", module: "parcels", table: pa,
      columns: { id: pa.id, apn: pa.apn, apn_normalized: pa.apn_normalized, situs_address: pa.situs_address, county: pa.county },
      searchable: ["apn", "apn_normalized", "situs_address", "county"],
      title: (r) => `APN ${r.apn}`,
      subtitle: (r) => join(r.situs_address, r.county),
      href: (r) => `/parcels/${r.id}`,
    },
  ];
}

export async function globalSearch(db: Db, user: CurrentUser, q: string, limit: number) {
  const hits: Array<{ type: string; id: string; title: string; subtitle: string | null; href: string }> = [];
  const terms = q.split(/\s+/).filter(Boolean);
  for (const src of sources()) {
    if (!user.can(src.module, "view")) continue;
    const t = src.table as any;
    const where = and(
      t.deleted_at ? isNull(t.deleted_at) : undefined,
      t.merged_into_id ? isNull(t.merged_into_id) : undefined,
      ...terms.map((term) => or(...src.searchable.map((c) => ilike(src.columns[c], `%${term}%`)))),
    );
    const rows = await db
      .select(src.columns as never)
      .from(src.table)
      .where(where)
      .limit(Math.max(3, Math.floor(limit / 4)));
    for (const row of rows as Record<string, any>[]) {
      hits.push({ type: src.type, id: row.id, title: src.title(row), subtitle: src.subtitle(row), href: src.href(row) });
    }
  }
  return hits.slice(0, limit);
}
