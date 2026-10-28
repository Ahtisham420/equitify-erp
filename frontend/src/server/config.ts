/** Server settings, read from the environment (mirrors the former FastAPI Settings). */
const env = process.env;

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const settings = {
  APP_NAME: env.APP_NAME ?? "EquitiFy",
  API_PREFIX: "/api/v1",

  DATABASE_URL: env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/equitify",

  JWT_SECRET: env.JWT_SECRET ?? "change-me",
  JWT_ALGORITHM: "HS256" as const,
  ACCESS_TOKEN_MINUTES: int(env.ACCESS_TOKEN_MINUTES, 480),
  MFA_TOKEN_MINUTES: int(env.MFA_TOKEN_MINUTES, 10),
  MFA_ENFORCED: bool(env.MFA_ENFORCED, true),
  MFA_ISSUER: env.MFA_ISSUER ?? "EquitiFy",

  STORAGE_DIR: env.STORAGE_DIR ?? "storage",
  SCHEDULER_ENABLED: bool(env.SCHEDULER_ENABLED, true), // periodic automations (server/core/scheduler.ts)

  SEED_ADMIN_EMAIL: env.SEED_ADMIN_EMAIL ?? "admin@equitify.local",
  SEED_ADMIN_PASSWORD: env.SEED_ADMIN_PASSWORD ?? "Admin@12345",

  // Platform (spec 36): deployment environment and at-rest encryption of integration credentials.
  ENVIRONMENT: env.ENVIRONMENT ?? "development", // development | staging | production
  ENCRYPTION_KEY: env.ENCRYPTION_KEY ?? "", // Fernet key (urlsafe base64, 32 bytes). Derived from JWT_SECRET when empty (dev only).

  // Optional AI provider. Without a key every AI feature degrades gracefully.
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
  AI_MODEL: env.AI_MODEL ?? "claude-opus-5-5",
};
