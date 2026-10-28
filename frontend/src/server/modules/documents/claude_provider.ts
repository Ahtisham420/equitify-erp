/**
 * Anthropic Claude implementation of the documents `AIProvider` interface (Release 6).
 *
 * Registered only when ANTHROPIC_API_KEY is set (`registerAi()`). Without a key the NullProvider stays active and
 * every AI feature degrades to manual workflows. Output is always assistive: callers store it as pending
 * suggestions / verification items, never as verified facts.
 */
import { readFile, stat } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";
import { inArray, and, eq } from "drizzle-orm";

import { settings } from "../../config";
import { withSession } from "../../db";
import * as ai from "./ai";
import { DOC_CLASSES, documents, type Document } from "./schema";
import { filePath } from "./storage";

const MAX_TOKENS = 16000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;

let client: Anthropic | null = null;

/** The model declined the request (stop_reason == "refusal"); treated as a skipped AI call. */
export class AIRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIRefused";
  }
}

/** Transient provider failure after retries (rate limit, 5xx, connection). */
export class AIUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIUnavailable";
  }
}

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: settings.ANTHROPIC_API_KEY || undefined });
  return client;
}

type Block = Record<string, any>;

/** Base64 PDF document block (<=32 MB), or null when the file is missing/too large. */
export async function pdfBlock(path: string): Promise<Block | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > MAX_PDF_BYTES) return null;
    const data = (await readFile(path)).toString("base64");
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  } catch {
    return null;
  }
}

/** [text, pdf_path] for a `Document`: PDFs are sent natively from the stored file, others as text_content. */
export function documentContent(d: Pick<Document, "mime_type" | "storage_key" | "text_content">): [string, string | null] {
  if ((d.mime_type || "").toLowerCase() === "application/pdf" && d.storage_key) {
    try {
      return [d.text_content || "", filePath(d.storage_key)];
    } catch {
      // fall back to text
    }
  }
  return [d.text_content || "", null];
}

const schemaOf = (properties: Record<string, any>, required?: string[]) => ({
  type: "object",
  properties,
  required: required ?? Object.keys(properties),
  additionalProperties: false,
});

const NULLABLE_STR = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

const SYSTEM =
  "You are the assistive AI layer of EquitiFy, a commercial real estate operating system. " +
  "Your output is reviewed by a named human before it is used; it never becomes authoritative on its own. " +
  "Only state what the supplied material supports. When something is not stated, return null or omit it " +
  "rather than guessing. Cite page numbers and clause references exactly as they appear.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clamp = (v: unknown): number => {
  const n = Number(v);
  return v === null || v === undefined || Number.isNaN(n) ? 0 : Math.max(0, Math.min(1, n));
};

function coerce(value: any, valueType: string): any {
  if (value === null || value === undefined) return null;
  if (["number", "money", "percent"].includes(valueType)) {
    const s = String(value).replace(/,/g, "").replace(/\$/g, "").replace(/%/g, "").trim();
    const n = Number(s);
    return s === "" || Number.isNaN(n) ? value : n;
  }
  return value;
}

export class ClaudeProvider implements ai.AIProvider {
  name = "anthropic";
  model: string;
  available: boolean;
  last_usage: ai.ProviderUsage | null = null;

  constructor(model?: string | null) {
    this.model = model || settings.AI_MODEL || "claude-opus-5-5";
    this.available = Boolean(settings.ANTHROPIC_API_KEY);
  }

  // --- core call ---------------------------------------------------------------------------------

  /** One JSON-schema-constrained call. Throws AIRefused / AIUnavailable / Error on failure. */
  async structured(o: {
    prompt: string;
    schema: Record<string, any>;
    effort?: string;
    system?: string | null;
    documents?: Block[];
  }): Promise<Record<string, any>> {
    this.last_usage = null;
    const content: Block[] = [...(o.documents ?? []), { type: "text", text: o.prompt }]; // document blocks go first
    const c = getClient();
    const attempts = 3;
    let response: any;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        response = await (c.beta.messages as any).create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: o.system || SYSTEM,
          messages: [{ role: "user", content }],
          output_config: { effort: o.effort ?? "medium", format: { type: "json_schema", schema: o.schema } },
        });
        break;
      } catch (exc: any) {
        if (exc instanceof Anthropic.RateLimitError) {
          if (attempt === attempts) throw new AIUnavailable(`Rate limited by the AI provider: ${exc.message}`);
        } else if (exc instanceof Anthropic.APIConnectionError) {
          if (attempt === attempts) throw new AIUnavailable(`Cannot reach the AI provider: ${exc.message}`);
        } else if (exc instanceof Anthropic.APIError) {
          const status = exc.status ?? 0;
          if (status < 500 || attempt === attempts) throw new Error(`AI provider error ${status}: ${exc.message}`);
        } else {
          throw exc;
        }
      }
      await sleep(2 ** attempt * 1000);
    }

    const usage = response?.usage;
    if (usage) this.last_usage = { input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null };
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category;
      console.warn(`AI request refused (category=${category})`);
      throw new AIRefused(`The AI model declined this request${category ? ` (${category})` : ""}`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("AI response was truncated (max_tokens)");
    const text = (response.content as Block[]).find((b) => b?.type === "text")?.text;
    if (!text) throw new Error("AI response contained no text");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("AI response was not valid JSON");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("AI response was not a JSON object");
    return data as Record<string, any>;
  }

  private async material(text: string, pdfPath?: string | null): Promise<[Block[], string]> {
    const block = pdfPath ? await pdfBlock(pdfPath) : null;
    if (block) return [[block], "The document is attached above."];
    return [[], `<document>\n${(text || "").slice(0, MAX_TEXT_CHARS)}\n</document>`];
  }

  // --- AIProvider interface ----------------------------------------------------------------------

  async classify(text: string, filename: string, opts: ai.CallOpts = {}) {
    const [docs, body] = await this.material((text || "").slice(0, 20_000), opts.pdf_path);
    const schema = schemaOf({ doc_class: { type: "string", enum: DOC_CLASSES }, confidence: { type: "number" } });
    const prompt =
      `Classify this commercial real estate document into exactly one class. Filename: ${filename}\n\n` +
      `${body}\n\nReturn the class and your confidence between 0 and 1.`;
    const data = await this.structured({ prompt, schema, effort: "low", documents: docs });
    const docClass = data.doc_class;
    return { doc_class: DOC_CLASSES.includes(docClass) ? (docClass as string) : null, confidence: clamp(data.confidence) };
  }

  async extract(text: string, docClass: string, schema: ai.SchemaField[], opts: ai.CallOpts = {}) {
    const fields = schema.filter((s) => s.field).map((s) => s.field);
    if (!fields.length) return [];
    const types = Object.fromEntries(schema.filter((s) => s.field).map((s) => [s.field, s.type ?? "text"]));
    const listing = schema
      .filter((s) => s.field)
      .map((s) => `- ${s.field} (${s.type ?? "text"}): ${s.label ?? s.field}`)
      .join("\n");
    const outSchema = schemaOf({
      values: {
        type: "array",
        items: schemaOf({
          field: { type: "string", enum: fields },
          value: { type: "string" },
          page: NULLABLE_INT,
          clause: NULLABLE_STR,
          citation_text: { type: "string" },
          confidence: { type: "number" },
        }),
      },
    });
    const [docs, body] = await this.material(text, opts.pdf_path);
    const prompt =
      `Extract the following fields from this ${docClass.replace(/_/g, " ")} document.\n${listing}\n\n` +
      "Rules: only extract values the document states explicitly; skip fields it does not contain. " +
      "Dates as YYYY-MM-DD. Money, numbers and percents as plain numbers without symbols or commas. " +
      "For every value give the page number, the clause/section reference if any, the exact supporting " +
      "text (citation_text) and a confidence between 0 and 1.\n\n" +
      body;
    const data = await this.structured({ prompt, schema: outSchema, effort: "medium", documents: docs });
    const items: Record<string, any>[] = [];
    for (const v of data.values || []) {
      if (!v || typeof v !== "object" || !(v.field in types)) continue;
      items.push({
        field: v.field,
        value: coerce(v.value, types[v.field]),
        page: v.page ?? null,
        clause: v.clause ?? null,
        citation_text: v.citation_text ?? null,
        confidence: clamp(v.confidence),
      });
    }
    return items;
  }

  async summarize(texts: ai.SourceText[], purpose: string) {
    const drafting = purpose.startsWith("draft:");
    const pdfs = drafting ? {} : await pdfBlocks(texts.filter((t) => t.document_id).map((t) => t.document_id));
    const docs: Block[] = [];
    const parts: string[] = [];
    for (const t of texts) {
      const block = (pdfs as Record<string, Block>)[t.document_id || ""];
      if (block) {
        docs.push(block);
        parts.push(`Attached document #${docs.length} = document_id "${t.document_id}" (${t.title})`);
      } else {
        const limit = Math.floor(MAX_TEXT_CHARS / Math.max(texts.length, 1));
        parts.push(`<source document_id="${t.document_id ?? ""}" title="${t.title}">\n${(t.text || "").slice(0, limit)}\n</source>`);
      }
    }
    const material = parts.join("\n\n");
    let prompt: string;
    if (drafting) {
      const kind = purpose.split(":").slice(1).join(":");
      prompt =
        `Polish the following ${kind} draft into clear, professional business prose. Use only the verified ` +
        "facts it contains; do not add numbers, dates, names or claims that are not present. Keep " +
        "placeholders in square brackets. Return the finished text as `summary` and no citations.\n\n" +
        material;
    } else {
      prompt =
        `Write a concise, factual summary of the sources below for this purpose: ${purpose}. ` +
        "Use short paragraphs or bullet points. Every material statement must be supported by a citation " +
        "(document_id, page if known, clause if any, and the supporting text).\n\n" +
        material;
    }
    const schema = schemaOf({
      summary: { type: "string" },
      citations: {
        type: "array",
        items: schemaOf({ document_id: { type: "string" }, page: NULLABLE_INT, clause: NULLABLE_STR, text: { type: "string" } }),
      },
    });
    const data = await this.structured({ prompt, schema, effort: "medium", documents: docs });
    const validIds = new Set(texts.map((t) => t.document_id));
    const citations = (data.citations || []).filter(
      (c: any) => c && typeof c === "object" && c.document_id && validIds.has(c.document_id),
    );
    return { summary: String(data.summary || ""), citations };
  }
}

/** Load native PDF blocks for up to 5 PDF documents (own short-lived session; read only). */
async function pdfBlocks(documentIds: string[]): Promise<Record<string, Block>> {
  const ids = documentIds.filter((i) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(i)));
  if (!ids.length) return {};
  const out: Record<string, Block> = {};
  try {
    const rows = await withSession((s) =>
      s.select().from(documents).where(and(inArray(documents.id, ids), eq(documents.mime_type, "application/pdf"))),
    );
    for (const d of rows.slice(0, 5)) {
      let block: Block | null = null;
      try {
        block = await pdfBlock(filePath(d.storage_key));
      } catch {
        block = null;
      }
      if (block) out[d.id] = block;
    }
  } catch {
    return {}; // fall back to text content
  }
  return out;
}

/** Register Claude as the default AI provider when ANTHROPIC_API_KEY is configured. */
export function registerAi(): boolean {
  if (!settings.ANTHROPIC_API_KEY) return false;
  ai.registerProvider(new ClaudeProvider(settings.AI_MODEL), true);
  return true;
}
