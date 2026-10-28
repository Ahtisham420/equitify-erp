import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { geometry, numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const RULE_TYPES = ["explicit", "boundary", "radius", "corridor", "county", "city", "saved_query"] as const;
export const VISIBILITIES = ["private", "role", "company"] as const;
export const ROAD_CLASSES = ["interstate", "highway", "arterial", "collector", "local", "other"] as const;
export const GROWTH_KINDS = ["permit", "plat", "rooftops", "school", "utility", "project"] as const;
export const TRADE_AREA_MINUTES = [5, 10, 15] as const;

// Geometry columns are deferred in SQLAlchemy; services select rows without them (see service.ts `plainCols`).

export const corridors = pgTable(
  "corridors",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(),
    road_name: varchar("road_name", { length: 160 }), // named highway / arterial
    road_class: varchar("road_class", { length: 20 }).notNull().$defaultFn(() => "arterial"),
    side_of_road: varchar("side_of_road", { length: 20 }),
    travel_direction: varchar("travel_direction", { length: 20 }),
    frontage_length_ft: numericFloat("frontage_length_ft", 12, 2),
    city: varchar("city", { length: 120 }),
    county: varchar("county", { length: 120 }),
    state: varchar("state", { length: 40 }),
    geometry: geometry("geometry", "LINESTRING", 4326),
    has_geometry: boolean("has_geometry").notNull().$defaultFn(() => false),
    length_ft: numericFloat("length_ft", 12, 2),
    source: varchar("source", { length: 200 }),
    observed_on: date("observed_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_corridors_deleted_at").on(t.deleted_at),
    index("ix_corridors_name").on(t.name),
    index("ix_corridors_road_class").on(t.road_class),
    index("ix_corridors_city").on(t.city),
    index("ix_corridors_county").on(t.county),
    index("idx_corridors_geometry").using("gist", t.geometry),
  ],
);
export type Corridor = typeof corridors.$inferSelect;

export const nodes = pgTable(
  "nodes",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(), // intersection name
    corridor_id: fk("corridor_id", () => corridors.id),
    cross_street: varchar("cross_street", { length: 160 }),
    city: varchar("city", { length: 120 }),
    county: varchar("county", { length: 120 }),
    state: varchar("state", { length: 40 }),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    location: geometry("location", "POINT", 4326),
    approach_traffic: jsonb("approach_traffic").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // {"NB": 24000, ...}
    signalized: boolean("signalized"),
    turn_restrictions: text("turn_restrictions"),
    quadrants: jsonb("quadrants").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // {"NE": {"tenancy": "...", "vacancy": "..."}}
    nearby_development: text("nearby_development"),
    source: varchar("source", { length: 200 }),
    observed_on: date("observed_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_nodes_deleted_at").on(t.deleted_at),
    index("ix_nodes_name").on(t.name),
    index("ix_nodes_corridor_id").on(t.corridor_id),
    index("ix_nodes_city").on(t.city),
    index("ix_nodes_county").on(t.county),
    index("idx_nodes_location").using("gist", t.location),
  ],
);
export type Node = typeof nodes.$inferSelect;

/** One count observation; history = multiple rows per segment/approach across count years. */
export const trafficCounts = pgTable(
  "traffic_counts",
  {
    ...entity(),
    corridor_id: fk("corridor_id", () => corridors.id),
    node_id: fk("node_id", () => nodes.id),
    segment: varchar("segment", { length: 200 }),
    approach: varchar("approach", { length: 40 }),
    count: integer("count").notNull(),
    count_year: integer("count_year").notNull(),
    count_type: varchar("count_type", { length: 20 }).notNull().$defaultFn(() => "aadt"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    location: geometry("location", "POINT", 4326),
    source: varchar("source", { length: 200 }).notNull(),
    observed_on: date("observed_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_traffic_counts_deleted_at").on(t.deleted_at),
    index("ix_traffic_counts_corridor_id").on(t.corridor_id),
    index("ix_traffic_counts_node_id").on(t.node_id),
    index("ix_traffic_counts_segment").on(t.segment),
    index("ix_traffic_counts_count_year").on(t.count_year),
    index("idx_traffic_counts_location").using("gist", t.location),
  ],
);
export type TrafficCount = typeof trafficCounts.$inferSelect;

export const tradeAreas = pgTable(
  "trade_areas",
  {
    ...entity(),
    name: varchar("name", { length: 160 }),
    node_id: fk("node_id", () => nodes.id),
    property_id: fk("property_id", () => properties.id),
    minutes: integer("minutes").notNull(),
    geometry: geometry("geometry", "MULTIPOLYGON", 4326),
    has_geometry: boolean("has_geometry").notNull().$defaultFn(() => false),
    demographics: jsonb("demographics").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // population, households, median income...
    competitors: jsonb("competitors").$type<any[]>().notNull().$defaultFn(() => []),
    anchors: jsonb("anchors").$type<any[]>().notNull().$defaultFn(() => []),
    source: varchar("source", { length: 200 }).notNull(),
    observed_on: date("observed_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_trade_areas_deleted_at").on(t.deleted_at),
    index("ix_trade_areas_node_id").on(t.node_id),
    index("ix_trade_areas_property_id").on(t.property_id),
    index("ix_trade_areas_minutes").on(t.minutes),
    index("idx_trade_areas_geometry").using("gist", t.geometry),
  ],
);
export type TradeArea = typeof tradeAreas.$inferSelect;

/** Dated, sourced growth context point: permit, plat, rooftops, school, utility, announced project. */
export const growthRecords = pgTable(
  "growth_records",
  {
    ...entity(),
    kind: varchar("kind", { length: 20 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 40 }),
    units: integer("units"),
    value: numericFloat("value", 16, 2),
    event_date: date("event_date", { mode: "string" }),
    city: varchar("city", { length: 120 }),
    county: varchar("county", { length: 120 }),
    state: varchar("state", { length: 40 }),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    location: geometry("location", "POINT", 4326),
    source: varchar("source", { length: 200 }).notNull(),
    observed_on: date("observed_on", { mode: "string" }),
  },
  (t) => [
    index("ix_growth_records_deleted_at").on(t.deleted_at),
    index("ix_growth_records_kind").on(t.kind),
    index("ix_growth_records_event_date").on(t.event_date),
    index("idx_growth_records_location").using("gist", t.location),
  ],
);
export type GrowthRecord = typeof growthRecords.$inferSelect;

export const territories = pgTable(
  "territories",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    rule_type: varchar("rule_type", { length: 20 }).notNull().$defaultFn(() => "explicit"),
    rule: jsonb("rule").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    // Boundary for `boundary` rules; computed buffer for radius/corridor rules (display + spatial filters).
    geometry: geometry("geometry", "GEOMETRY", 4326),
    has_geometry: boolean("has_geometry").notNull().$defaultFn(() => false),
    parent_id: fk("parent_id", (): any => territories.id),
    visibility: varchar("visibility", { length: 20 }).notNull().$defaultFn(() => "private"),
    allowed_roles: varchar("allowed_roles", { length: 60 }).array().notNull().$defaultFn(() => []),
    owner_id: fk("owner_id", () => users.id),
    assignee_id: fk("assignee_id", () => users.id), // default assignee for territory-driven routing
    member_count: integer("member_count").notNull().$defaultFn(() => 0),
    last_computed_at: tz("last_computed_at"),
  },
  (t) => [
    index("ix_territories_deleted_at").on(t.deleted_at),
    index("ix_territories_name").on(t.name),
    index("ix_territories_rule_type").on(t.rule_type),
    index("ix_territories_parent_id").on(t.parent_id),
    index("ix_territories_visibility").on(t.visibility),
    index("ix_territories_owner_id").on(t.owner_id),
    index("ix_territories_assignee_id").on(t.assignee_id),
    index("idx_territories_geometry").using("gist", t.geometry),
  ],
);
export type Territory = typeof territories.$inferSelect;

export const territoryMembers = pgTable(
  "territory_members",
  {
    id: pk(),
    territory_id: fk("territory_id", () => territories.id, { notNull: true, onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id, { notNull: true, onDelete: "cascade" }),
    source: varchar("source", { length: 10 }).notNull().$defaultFn(() => "rule"), // rule | manual
    added_at: tz("added_at").notNull().$defaultFn(() => new Date()),
    added_by_id: uuid("added_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_territory_members_territory_id").on(t.territory_id),
    index("ix_territory_members_property_id").on(t.property_id),
    unique("uq_territory_members_pair").on(t.territory_id, t.property_id),
  ],
);
export type TerritoryMember = typeof territoryMembers.$inferSelect;
