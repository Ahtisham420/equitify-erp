/**
 * Column helpers that reproduce the SQLAlchemy mixins (UUIDPk, Timestamps, SoftDelete) and special types.
 * Column KEYS are the snake_case database column names so rows serialize to the same JSON as the old API.
 */
import { randomUUID } from "node:crypto";

import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

export const newId = () => randomUUID();

export const pk = () => uuid("id").primaryKey().$defaultFn(newId);

/** timestamptz as a JS Date. */
export const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const timestamps = () => ({
  created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
  updated_at: tz("updated_at").notNull().$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
});

export const softDelete = () => ({ deleted_at: tz("deleted_at") });

/** NUMERIC(p,s) surfaced as a JS number (SQLAlchemy `Numeric(..., asdecimal=False)`). */
export const numericFloat = (name: string, precision: number, scale: number) =>
  customType<{ data: number; driverData: string | number }>({
    dataType: () => `numeric(${precision}, ${scale})`,
    fromDriver: (v) => (v === null || v === undefined ? (v as never) : Number(v)),
    toDriver: (v) => v,
  })(name);

/** PostGIS geometry(POINT, 4326) kept opaque in TS; set it with sql`ST_SetSRID(ST_MakePoint(lng, lat), 4326)`. */
export const geometry = (name: string, type = "POINT", srid = 4326) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => `geometry(${type}, ${srid})`,
  })(name);
