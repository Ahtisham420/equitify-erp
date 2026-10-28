import { date, doublePrecision, index, integer, jsonb, pgTable, text, varchar } from "drizzle-orm/pg-core";

import { geometry, numericFloat } from "../../db/columns";
import { entity } from "../../db/entity";

export const PROPERTY_STATUSES = ["tracked", "pursued", "rejected", "owned", "managed", "listed", "sold"] as const;
export const PROPERTY_TYPES = [
  "retail", "stnl", "multi_tenant_retail", "gas_convenience", "medical", "office", "industrial",
  "multifamily", "hospitality", "ground_lease", "land", "mixed_use", "other",
] as const;

// Fields whose changes are historical facts with source/date/confidence/verification.
export const MATERIAL_FIELDS = new Set([
  "building_area_sf", "land_area_acres", "year_built", "year_renovated", "parking_spaces", "construction_class",
  "asking_price", "last_sale_price", "last_sale_date", "occupancy_pct", "wale_years", "noi",
  "zoning", "future_land_use", "flood_zone", "traffic_count", "property_type",
]);

export const properties = pgTable(
  "properties",
  {
    ...entity(),

    // Identity
    name: varchar("name", { length: 200 }),
    address_line: varchar("address_line", { length: 255 }).notNull(),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 40 }),
    postal_code: varchar("postal_code", { length: 20 }),
    county: varchar("county", { length: 120 }),
    normalized_address: varchar("normalized_address", { length: 400 }).notNull(),
    alternate_addresses: jsonb("alternate_addresses").$type<string[]>().notNull().$defaultFn(() => []),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    location: geometry("location", "POINT", 4326),

    property_type: varchar("property_type", { length: 40 }).notNull().$defaultFn(() => "other"),
    property_subtype: varchar("property_subtype", { length: 80 }),
    building_area_sf: numericFloat("building_area_sf", 14, 2),
    land_area_acres: numericFloat("land_area_acres", 12, 4),
    year_built: integer("year_built"),
    year_renovated: integer("year_renovated"),
    parking_spaces: integer("parking_spaces"),
    construction_class: varchar("construction_class", { length: 20 }),

    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "tracked"),

    // Market
    asking_price: numericFloat("asking_price", 16, 2),
    last_sale_price: numericFloat("last_sale_price", 16, 2),
    last_sale_date: date("last_sale_date", { mode: "string" }),

    // Income
    occupancy_pct: numericFloat("occupancy_pct", 5, 2),
    wale_years: numericFloat("wale_years", 6, 2),
    noi: numericFloat("noi", 16, 2),

    // Site / location
    zoning: varchar("zoning", { length: 80 }),
    future_land_use: varchar("future_land_use", { length: 80 }),
    flood_zone: varchar("flood_zone", { length: 20 }),
    traffic_count: integer("traffic_count"),
    corridor: varchar("corridor", { length: 160 }),

    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
    completeness_score: doublePrecision("completeness_score").notNull().$defaultFn(() => 0),
  },
  (t) => [
    index("ix_properties_deleted_at").on(t.deleted_at),
    index("ix_properties_city").on(t.city),
    index("ix_properties_state").on(t.state),
    index("ix_properties_county").on(t.county),
    index("ix_properties_normalized_address").on(t.normalized_address),
    index("ix_properties_property_type").on(t.property_type),
    index("ix_properties_status").on(t.status),
  ],
);

export type Property = typeof properties.$inferSelect;
