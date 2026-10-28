import { boolean, index, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { pk, softDelete, timestamps, tz } from "../../db/columns";

// This module defines the tables every other entity points at, so it declares its own actor/timestamp columns
// instead of using db/entity.ts (which imports `users` from here).
const actorCols = () => ({
  created_by_id: uuid("created_by_id").references((): any => users.id, { onDelete: "set null" }),
  updated_by_id: uuid("updated_by_id").references((): any => users.id, { onDelete: "set null" }),
});

export const roles = pgTable("roles", {
  id: pk(),
  ...timestamps(),
  ...actorCols(),
  ...softDelete(),
  key: varchar("key", { length: 60 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  permissions: jsonb("permissions").notNull().$defaultFn(() => ({})),
  approval_limits: jsonb("approval_limits").notNull().$defaultFn(() => ({})),
  is_system: boolean("is_system").notNull().$defaultFn(() => false),
});

export const teams = pgTable("teams", {
  id: pk(),
  ...timestamps(),
  ...actorCols(),
  ...softDelete(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  description: text("description"),
});

export const users = pgTable(
  "users",
  {
    id: pk(),
    ...timestamps(),
    ...actorCols(),
    ...softDelete(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    full_name: varchar("full_name", { length: 200 }).notNull(),
    password_hash: varchar("password_hash", { length: 200 }),
    job_title: varchar("job_title", { length: 120 }),
    phone: varchar("phone", { length: 40 }),
    role_id: uuid("role_id").notNull().references(() => roles.id),
    team_id: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    manager_id: uuid("manager_id").references((): any => users.id, { onDelete: "set null" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    is_service: boolean("is_service").notNull().$defaultFn(() => false),
    mfa_secret: varchar("mfa_secret", { length: 64 }),
    mfa_enabled: boolean("mfa_enabled").notNull().$defaultFn(() => false),
    last_login_at: tz("last_login_at"),
    deactivated_at: tz("deactivated_at"),
  },
  (t) => [index("ix_users_role_id").on(t.role_id), index("ix_users_status").on(t.status)],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: pk(),
    user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    expires_at: tz("expires_at").notNull(),
    revoked_at: tz("revoked_at"),
    ip_address: varchar("ip_address", { length: 64 }),
    user_agent: varchar("user_agent", { length: 400 }),
  },
  (t) => [index("ix_user_sessions_user_id").on(t.user_id)],
);

/** Least-privilege programmatic credential bound to a service user. */
export const serviceCredentials = pgTable(
  "service_credentials",
  {
    id: pk(),
    ...timestamps(),
    ...actorCols(),
    ...softDelete(),
    name: varchar("name", { length: 120 }).notNull(),
    user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key_prefix: varchar("key_prefix", { length: 16 }).notNull(),
    key_hash: varchar("key_hash", { length: 64 }).notNull().unique(),
    scopes: jsonb("scopes").notNull().$defaultFn(() => []),
    last_used_at: tz("last_used_at"),
    revoked_at: tz("revoked_at"),
  },
  (t) => [index("ix_service_credentials_user_id").on(t.user_id), index("ix_service_credentials_key_prefix").on(t.key_prefix)],
);
