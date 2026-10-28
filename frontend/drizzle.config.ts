import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/server/common/schema.ts", "./src/server/modules/*/schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/equitify" },
  extensionsFilters: ["postgis"],
});
