/**
 * Internal provider-interface registry (spec 36: provider lock-in is a design defect).
 *
 * Core business logic never imports vendor code. Vendor adapters register a factory per
 * (category, provider name); callers resolve the configured provider through this registry:
 *
 *   import * as providers from "../platform/providers";
 *   providers.register("esignature", "acme_sign", (config, credentials) => new AcmeSign(config, credentials),
 *     { required_config: ["account_id"], required_credentials: ["api_key"] });
 *   const adapter = providers.build(entry, credentials);   // entry: IntegrationProvider row
 *
 * A factory is called as `factory(config, credentials)` and may expose an optional
 * `async test(): Promise<[boolean, string]>` used by the "Test connection" action.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { settings } from "../../config";
import { INTEGRATION_CATEGORIES } from "./schema";

export type Factory = (config: Record<string, any>, credentials: Record<string, any>) => any;

export interface ProviderSpec {
  category: string;
  name: string;
  factory: Factory;
  label: string;
  required_config: string[];
  required_credentials: string[];
  description: string | null;
}

// Shared on globalThis: the Next.js instrumentation hook and the route handlers are separate bundles.
const g = globalThis as unknown as { __eqfProviders?: Map<string, ProviderSpec> };
const registry = (g.__eqfProviders ??= new Map<string, ProviderSpec>());
const keyOf = (category: string, name: string) => JSON.stringify([category, name]);

/** Python `name.replace("_", " ").title()` */
const titleCase = (name: string) =>
  name.replace(/_/g, " ").replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

export function register(
  category: string,
  name: string,
  factory: Factory,
  o: { label?: string; required_config?: string[]; required_credentials?: string[]; description?: string } = {},
): void {
  registry.set(keyOf(category, name), {
    category,
    name,
    factory,
    label: o.label || titleCase(name),
    required_config: [...(o.required_config ?? [])],
    required_credentials: [...(o.required_credentials ?? [])],
    description: o.description ?? null,
  });
}

export function get(category: string, name: string): ProviderSpec | undefined {
  return registry.get(keyOf(category, name));
}

/** Specs sorted by (category, name), optionally for one category. */
export function available(category?: string | null): ProviderSpec[] {
  return [...registry.values()]
    .filter((s) => !category || s.category === category)
    .sort((a, b) => (a.category === b.category ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.category < b.category ? -1 : 1));
}

/** Python `LookupError` */
export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}

/** Instantiate the adapter for a configured IntegrationProvider row (or throw LookupError). */
export function build(entry: { category: string; provider: string; config?: Record<string, any> | null }, credentials?: Record<string, any> | null): any {
  const spec = get(entry.category, entry.provider);
  if (!spec) throw new LookupError(`No adapter registered for ${entry.category}/${entry.provider}`);
  return spec.factory({ ...(entry.config ?? {}) }, { ...(credentials ?? {}) });
}

/** Missing required config/credential keys (empty list = valid). */
export function validate(category: string, name: string, config: Record<string, any>, credential_keys: string[]): string[] {
  const spec = get(category, name);
  if (!spec) return [];
  const missing = spec.required_config
    .filter((k) => config[k] === undefined || config[k] === null || config[k] === "")
    .map((k) => `config.${k}`);
  missing.push(...spec.required_credentials.filter((k) => !credential_keys.includes(k)).map((k) => `credentials.${k}`));
  return missing;
}

// --- Built-in adapters ---------------------------------------------------------------------------

/** Records are entered or imported by users; no external system is called. */
class ManualAdapter {
  constructor(public config: Record<string, any>, _credentials: Record<string, any>) {}

  async test(): Promise<[boolean, string]> {
    return [true, "Manual entry and file imports are always available."];
  }
}

class LocalStorageAdapter {
  constructor(public config: Record<string, any>, _credentials: Record<string, any>) {}

  async test(): Promise<[boolean, string]> {
    const root = String(this.config.path || settings.STORAGE_DIR);
    const exists = existsSync(root);
    return [exists, `Storage directory ${exists ? "is" : "does not"} exist: ${resolve(root)}`];
  }
}

class AnthropicAdapter {
  constructor(public config: Record<string, any>, _credentials: Record<string, any>) {}

  async test(): Promise<[boolean, string]> {
    const ai = await import("../documents/ai");
    const status = ai.providerStatus();
    if (status.available) return [true, `AI provider ${status.name} is registered with model ${status.model}.`];
    return [false, "ANTHROPIC_API_KEY is not set on the server; AI features run in degraded (manual) mode."];
  }
}

/** Generic REST adapter placeholder: validated configuration only; vendor calls live in adapters. */
class GenericHttpAdapter {
  has_credentials: boolean;

  constructor(public config: Record<string, any>, credentials: Record<string, any>) {
    this.has_credentials = Object.keys(credentials ?? {}).length > 0;
  }

  async test(): Promise<[boolean, string]> {
    const base = String(this.config.base_url || "");
    if (!base.startsWith("https://")) return [false, "base_url must be an https:// URL."];
    return [true, "Configuration is valid. Live calls are made by the vendor adapter when it is installed."];
  }
}

function registerBuiltins(): void {
  const manual: Factory = (c, k) => new ManualAdapter(c, k);
  const generic: Factory = (c, k) => new GenericHttpAdapter(c, k);
  for (const category of Object.keys(INTEGRATION_CATEGORIES)) {
    register(category, "manual", manual, {
      label: "Manual entry / import",
      description: "No external provider. Data is entered or imported by users.",
    });
    register(category, "generic_http", generic, {
      label: "Generic REST API",
      required_config: ["base_url"],
      required_credentials: ["api_key"],
      description: "Any HTTPS API secured with an API key.",
    });
  }
  register("storage", "local", (c, k) => new LocalStorageAdapter(c, k), {
    label: "Server file storage",
    description: "Private object storage on the application server (signed access only).",
  });
  register("spreadsheets", "csv", manual, { label: "CSV / XLSX files", description: "Open-format import and export." });
  register("ai", "anthropic", (c, k) => new AnthropicAdapter(c, k), {
    label: "Anthropic Claude",
    description: "Assistive classification, extraction, summaries and natural-language search.",
  });
}

registerBuiltins();
