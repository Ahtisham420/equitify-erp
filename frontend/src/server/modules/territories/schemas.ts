import { z } from "zod";

const ruleType = z.enum(["explicit", "boundary", "radius", "corridor", "county", "city", "saved_query"]);
const visibility = z.enum(["private", "role", "company"]);
const growthKind = z.enum(["permit", "plat", "rooftops", "school", "utility", "project"]);
const minutes = z.union([z.literal(5), z.literal(10), z.literal(15)]);
const uuid = z.string().uuid();
const date = z.string().date();
const obj = z.record(z.any());

// ----------------------------------------------------------------------------- corridors

export const corridorIn = z.object({
  name: z.string().min(1).max(160),
  road_name: z.string().max(160).nullish(),
  road_class: z.string().default("arterial"),
  side_of_road: z.string().max(20).nullish(),
  travel_direction: z.string().max(20).nullish(),
  frontage_length_ft: z.number().min(0).nullish(),
  city: z.string().nullish(),
  county: z.string().nullish(),
  state: z.string().nullish(),
  source: z.string().nullish(),
  observed_on: date.nullish(),
  notes: z.string().nullish(),
  geometry: obj.nullish(),
});
export type CorridorIn = z.infer<typeof corridorIn>;

export const corridorUpdate = z
  .object({
    name: z.string().min(1).max(160).nullish(),
    road_name: z.string().nullish(),
    road_class: z.string().nullish(),
    side_of_road: z.string().nullish(),
    travel_direction: z.string().nullish(),
    frontage_length_ft: z.number().min(0).nullish(),
    city: z.string().nullish(),
    county: z.string().nullish(),
    state: z.string().nullish(),
    source: z.string().nullish(),
    observed_on: date.nullish(),
    notes: z.string().nullish(),
    geometry: obj.nullish(),
    clear_geometry: z.boolean().default(false),
  })
  .strict();
export type CorridorUpdate = z.infer<typeof corridorUpdate>;

// ----------------------------------------------------------------------------- nodes

export const nodeIn = z.object({
  name: z.string().min(1).max(160),
  corridor_id: uuid.nullish(),
  cross_street: z.string().nullish(),
  city: z.string().nullish(),
  county: z.string().nullish(),
  state: z.string().nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  approach_traffic: obj.default({}),
  signalized: z.boolean().nullish(),
  turn_restrictions: z.string().nullish(),
  quadrants: obj.default({}),
  nearby_development: z.string().nullish(),
  source: z.string().nullish(),
  observed_on: date.nullish(),
  notes: z.string().nullish(),
});
export type NodeIn = z.infer<typeof nodeIn>;

export const nodeUpdate = z
  .object({
    name: z.string().min(1).max(160).nullish(),
    corridor_id: uuid.nullish(),
    cross_street: z.string().nullish(),
    city: z.string().nullish(),
    county: z.string().nullish(),
    state: z.string().nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    approach_traffic: obj.nullish(),
    signalized: z.boolean().nullish(),
    turn_restrictions: z.string().nullish(),
    quadrants: obj.nullish(),
    nearby_development: z.string().nullish(),
    source: z.string().nullish(),
    observed_on: date.nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type NodeUpdate = z.infer<typeof nodeUpdate>;

// ----------------------------------------------------------------------------- traffic counts

export const trafficCountIn = z.object({
  corridor_id: uuid.nullish(),
  node_id: uuid.nullish(),
  segment: z.string().max(200).nullish(),
  approach: z.string().max(40).nullish(),
  count: z.number().int().min(0),
  count_year: z.number().int().min(1950).max(2100),
  count_type: z.string().default("aadt"),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  source: z.string().min(1).max(200),
  observed_on: date.nullish(),
  notes: z.string().nullish(),
});
export type TrafficCountIn = z.infer<typeof trafficCountIn>;

export const trafficCountUpdate = z
  .object({
    corridor_id: uuid.nullish(),
    node_id: uuid.nullish(),
    segment: z.string().nullish(),
    approach: z.string().nullish(),
    count: z.number().int().min(0).nullish(),
    count_year: z.number().int().min(1950).max(2100).nullish(),
    count_type: z.string().nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    source: z.string().min(1).max(200).nullish(),
    observed_on: date.nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type TrafficCountUpdate = z.infer<typeof trafficCountUpdate>;

// ----------------------------------------------------------------------------- trade areas

export const tradeAreaIn = z.object({
  name: z.string().nullish(),
  node_id: uuid.nullish(),
  property_id: uuid.nullish(),
  minutes,
  geometry: obj.nullish(),
  demographics: obj.default({}),
  competitors: z.array(z.any()).default([]),
  anchors: z.array(z.any()).default([]),
  source: z.string().min(1).max(200),
  observed_on: date.nullish(),
  notes: z.string().nullish(),
});
export type TradeAreaIn = z.infer<typeof tradeAreaIn>;

export const tradeAreaUpdate = z
  .object({
    name: z.string().nullish(),
    node_id: uuid.nullish(),
    property_id: uuid.nullish(),
    minutes: minutes.nullish(),
    geometry: obj.nullish(),
    demographics: obj.nullish(),
    competitors: z.array(z.any()).nullish(),
    anchors: z.array(z.any()).nullish(),
    source: z.string().min(1).max(200).nullish(),
    observed_on: date.nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type TradeAreaUpdate = z.infer<typeof tradeAreaUpdate>;

// ----------------------------------------------------------------------------- growth context

export const growthIn = z.object({
  kind: growthKind,
  name: z.string().min(1).max(200),
  description: z.string().nullish(),
  status: z.string().max(40).nullish(),
  units: z.number().int().min(0).nullish(),
  value: z.number().min(0).nullish(),
  event_date: date.nullish(),
  city: z.string().nullish(),
  county: z.string().nullish(),
  state: z.string().nullish(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  source: z.string().min(1).max(200),
  observed_on: date.nullish(),
});
export type GrowthIn = z.infer<typeof growthIn>;

export const growthUpdate = z
  .object({
    kind: growthKind.nullish(),
    name: z.string().min(1).max(200).nullish(),
    description: z.string().nullish(),
    status: z.string().nullish(),
    units: z.number().int().min(0).nullish(),
    value: z.number().min(0).nullish(),
    event_date: date.nullish(),
    city: z.string().nullish(),
    county: z.string().nullish(),
    state: z.string().nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    source: z.string().min(1).max(200).nullish(),
    observed_on: date.nullish(),
  })
  .strict();
export type GrowthUpdate = z.infer<typeof growthUpdate>;

// ----------------------------------------------------------------------------- territories

export const territoryIn = z.object({
  name: z.string().min(1).max(160),
  description: z.string().nullish(),
  rule_type: ruleType.default("explicit"),
  rule: obj.default({}),
  /** GeoJSON polygon for boundary rules */
  geometry: obj.nullish(),
  parent_id: uuid.nullish(),
  visibility: visibility.default("private"),
  allowed_roles: z.array(z.string()).default([]),
  owner_id: uuid.nullish(),
  assignee_id: uuid.nullish(),
});
export type TerritoryIn = z.infer<typeof territoryIn>;

export const territoryUpdate = z
  .object({
    name: z.string().min(1).max(160).nullish(),
    description: z.string().nullish(),
    rule_type: ruleType.nullish(),
    rule: obj.nullish(),
    geometry: obj.nullish(),
    parent_id: uuid.nullish(),
    visibility: visibility.nullish(),
    allowed_roles: z.array(z.string()).nullish(),
    owner_id: uuid.nullish(),
    assignee_id: uuid.nullish(),
  })
  .strict();
export type TerritoryUpdate = z.infer<typeof territoryUpdate>;

export const membersIn = z.object({
  property_ids: z.array(uuid).max(1000).default([]),
  parcel_ids: z.array(uuid).max(1000).default([]),
});
export type MembersIn = z.infer<typeof membersIn>;
