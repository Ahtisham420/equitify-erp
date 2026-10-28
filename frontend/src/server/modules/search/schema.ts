import { boolean, index, jsonb, pgTable, varchar } from "drizzle-orm/pg-core";

import { entity, fk } from "../../db/entity";
import { teams, users } from "../auth/schema";

/** A reusable list definition (search + filters + sort) for any module. */
export const savedViews = pgTable(
  "saved_views",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(),
    module: varchar("module", { length: 60 }).notNull(),
    params: jsonb("params").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    visibility: varchar("visibility", { length: 20 }).notNull().$defaultFn(() => "private"), // private | team | company
    owner_id: fk("owner_id", () => users.id, { notNull: true, onDelete: "cascade" }),
    team_id: fk("team_id", () => teams.id),
    is_default: boolean("is_default").notNull().$defaultFn(() => false),
  },
  (t) => [
    index("ix_saved_views_deleted_at").on(t.deleted_at),
    index("ix_saved_views_module").on(t.module),
    index("ix_saved_views_owner_id").on(t.owner_id),
    index("ix_saved_views_team_id").on(t.team_id),
  ],
);

export type SavedView = typeof savedViews.$inferSelect;
