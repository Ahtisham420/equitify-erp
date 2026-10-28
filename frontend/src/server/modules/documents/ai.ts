/**
 * AI provider interface for the documents module.
 *
 * The platform treats AI as an assistive layer: providers classify, extract and summarize, but nothing they return
 * is authoritative. Every call is logged to `ai_calls`, extracted values land as `pending` verification items, and
 * calls never block user paths (extraction runs in background tasks and degrades to `skipped` when no provider is
 * available).
 *
 * A real provider is plugged in with `registerProvider(new MyProvider(), true)`; no other code changes are required.
 */
import { createHash } from "node:crypto";

import type { Db } from "../../db";
import { insert } from "../../db/orm";
import { aiCalls } from "./schema";

export interface SourceText {
  document_id: string;
  title: string;
  text: string;
}

export interface SchemaField {
  field: string;
  label?: string;
  type?: string; // text | number | money | date | percent
}

export interface ProviderUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface CallOpts {
  pdf_path?: string | null;
}

export interface AIProvider {
  name: string;
  model: string;
  available: boolean;
  /** Token usage of the most recent call. */
  last_usage: ProviderUsage | null;
  /** Return {doc_class, confidence}. */
  classify(text: string, filename: string, opts?: CallOpts): Promise<{ doc_class: string | null; confidence: number }>;
  /** Return [{field, value, page, clause, citation_text, confidence}]. */
  extract(text: string, doc_class: string, schema: SchemaField[], opts?: CallOpts): Promise<Record<string, any>[]>;
  /** Return {summary, citations: [{document_id, page, clause, text}]}. */
  summarize(texts: SourceText[], purpose: string): Promise<{ summary: string; citations: Record<string, any>[] }>;
}

/** No-op provider used until a real one is registered. Returns empty results. */
export class NullProvider implements AIProvider {
  name = "none";
  model = "none";
  available = false;
  last_usage: ProviderUsage | null = null;

  async classify() {
    return { doc_class: null, confidence: 0.0 };
  }
  async extract() {
    return [];
  }
  async summarize() {
    return { summary: "", citations: [] };
  }
}

// Shared on globalThis: the instrumentation hook and the route handlers are separate bundles.
const g = globalThis as unknown as { __eqfAiRegistry?: { providers: Map<string, AIProvider>; def: string | null } };
const registry = (g.__eqfAiRegistry ??= { providers: new Map<string, AIProvider>(), def: null });

export function registerProvider(provider: AIProvider, isDefault = true): void {
  registry.providers.set(provider.name, provider);
  if (isDefault || registry.def === null) registry.def = provider.name;
}

export function unregisterProvider(name: string): void {
  registry.providers.delete(name);
  if (registry.def === name) registry.def = registry.providers.keys().next().value ?? null;
}

export function getProvider(name?: string | null): AIProvider {
  const key = name || registry.def;
  if (key && registry.providers.has(key)) return registry.providers.get(key)!;
  return new NullProvider();
}

export function providerStatus() {
  const p = getProvider();
  return { name: p.name, model: p.model, available: Boolean(p.available) };
}

function sortKeys(v: any): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

export function promptHash(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(parts))).digest("hex");
}

/** Run one provider call and write an `ai_calls` row (success or error). Does not commit. */
export async function loggedCall<T>(
  db: Db,
  provider: AIProvider,
  o: {
    purpose: string;
    prompt_parts: unknown[];
    call: () => Promise<T>;
    document_id?: string | null;
    actor_id?: string | null;
    summarize_output?: (r: T) => Record<string, any>;
  },
): Promise<T> {
  const started = performance.now();
  let status = "ok";
  let error: string | null = null;
  let result: T | undefined;
  try {
    result = await o.call();
    return result;
  } catch (exc) {
    status = "error";
    const e = exc as Error;
    error = `${e?.name ?? "Error"}: ${e?.message ?? String(exc)}`.slice(0, 2000);
    throw exc;
  } finally {
    const usage = provider.last_usage ?? ({} as Partial<ProviderUsage>);
    await insert(db, aiCalls, {
      provider: provider.name,
      model: provider.model,
      purpose: o.purpose,
      prompt_hash: promptHash(...o.prompt_parts),
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      latency_ms: Math.floor(performance.now() - started),
      status,
      error,
      output_summary: o.summarize_output && result !== undefined && result !== null ? o.summarize_output(result) : null,
      document_id: o.document_id ?? null,
      created_by_id: o.actor_id ?? null,
    } as never);
  }
}
