/** Entity mixin: id + timestamps + actor attribution + soft delete (SQLAlchemy `Entity`). */
import { type AnyPgColumn, uuid } from "drizzle-orm/pg-core";

import { users } from "../modules/auth/schema";
import { pk, softDelete, timestamps } from "./columns";

export const actors = () => ({
  created_by_id: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  updated_by_id: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
});

export const entity = () => ({ id: pk(), ...timestamps(), ...actors(), ...softDelete() });

/** Nullable FK column to `<table>.id` (SQLAlchemy `fk()`), default ON DELETE SET NULL.
 *  Usage: `owner_id: fk("owner_id", () => users.id)`. */
type OnDelete = "cascade" | "set null" | "restrict" | "no action";
export function fk(column: string, ref: () => AnyPgColumn, opts: { notNull: true; onDelete?: OnDelete }): ReturnType<ReturnType<typeof uuid>["notNull"]>;
export function fk(column: string, ref: () => AnyPgColumn, opts?: { notNull?: false; onDelete?: OnDelete }): ReturnType<typeof uuid>;
export function fk(column: string, ref: () => AnyPgColumn, opts: { notNull?: boolean; onDelete?: OnDelete } = {}): any {
  const c = uuid(column).references(ref, { onDelete: opts.onDelete ?? (opts.notNull ? "restrict" : "set null") });
  return opts.notNull ? c.notNull() : c;
}
