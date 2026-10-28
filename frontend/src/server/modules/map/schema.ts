import { doublePrecision, index, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { geometry, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { properties } from "../properties/schema";

export const OBSERVATION_CATEGORIES = [
  "general", "vacancy", "signage", "condition", "construction", "tenant", "access", "other",
] as const;

/**
 * A field note captured on a property drive: coordinates, optional photos (documents) and a note.
 * `field_observations` is the provenance table (common/provenance), so this lives in its own table.
 * `client_uuid` is generated on the device so offline re-sends are idempotent.
 */
export const mapFieldObservations = pgTable(
  "map_field_observations",
  {
    ...entity(),
    client_uuid: uuid("client_uuid").notNull(),
    property_id: fk("property_id", () => properties.id),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    location: geometry("location", "POINT", 4326),
    accuracy_m: doublePrecision("accuracy_m"),
    observed_at: tz("observed_at").notNull(),
    category: varchar("category", { length: 40 }).notNull().$defaultFn(() => "general"),
    note: text("note"),
    photo_document_ids: jsonb("photo_document_ids").$type<string[]>().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_map_field_observations_deleted_at").on(t.deleted_at),
    uniqueIndex("ix_map_field_observations_client_uuid").on(t.client_uuid),
    index("ix_map_field_observations_property_id").on(t.property_id),
    index("ix_map_field_observations_observed_at").on(t.observed_at),
    index("ix_map_field_observations_category").on(t.category),
  ],
);
export type MapFieldObservation = typeof mapFieldObservations.$inferSelect;
