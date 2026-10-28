import {
  bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";

export const DOC_CLASSES = [
  "acquisition", "lease", "amendment", "estoppel", "snda", "debt", "loan_agreement", "tax", "insurance",
  "closing", "settlement_statement", "survey", "title", "environmental", "pca", "appraisal", "bov", "entity",
  "correspondence", "contract", "loi", "other",
];
export const EXTRACTION_STATUSES = ["none", "queued", "running", "completed", "skipped", "failed"];
export const JOB_STATUSES = ["queued", "running", "completed", "skipped", "failed"];
export const VALUE_STATUSES = ["pending", "confirmed", "rejected", "edited"];
export const ACCESS_ACTIONS = ["view", "download", "preview"];
// Record types a document can be linked to (polymorphic). Any lower_snake type is accepted; these are offered in the UI.
export const LINK_TYPES = [
  "property", "person", "organization", "opportunity", "offer", "contract", "closing", "asset", "lease", "loan",
  "disposition", "work_order", "vendor", "capital_project", "insurance_policy", "capital_partner", "listing",
  "brokerage_deal", "uw_model",
];

/** A stored file version. Versions of one logical document share `parent_document_id` (the chain root). */
export const documents = pgTable(
  "documents",
  {
    ...entity(),
    title: varchar("title", { length: 300 }).notNull(),
    description: text("description"),
    doc_class: varchar("doc_class", { length: 40 }).notNull().$defaultFn(() => "other"),
    classification_source: varchar("classification_source", { length: 20 }).notNull().$defaultFn(() => "manual"), // manual | ai
    classification_confidence: doublePrecision("classification_confidence"),
    filename: varchar("filename", { length: 300 }).notNull(),
    mime_type: varchar("mime_type", { length: 120 }).notNull().$defaultFn(() => "application/octet-stream"),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull().$defaultFn(() => 0),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    storage_key: varchar("storage_key", { length: 400 }).notNull(),
    version: integer("version").notNull().$defaultFn(() => 1),
    parent_document_id: fk("parent_document_id", (): AnyPgColumn => documents.id),
    is_latest: boolean("is_latest").notNull().$defaultFn(() => true),
    retention_until: date("retention_until", { mode: "string" }),
    legal_hold: boolean("legal_hold").notNull().$defaultFn(() => false),
    is_sensitive: boolean("is_sensitive").notNull().$defaultFn(() => false),
    uploaded_by_id: fk("uploaded_by_id", () => users.id),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
    // Plain text used for search/extraction: read from text files, or pasted / supplied by a future extractor.
    text_content: text("text_content"),
    text_source: varchar("text_source", { length: 20 }), // file | manual | extractor
    extraction_status: varchar("extraction_status", { length: 20 }).notNull().$defaultFn(() => "none"),
  },
  (t) => [
    index("ix_documents_deleted_at").on(t.deleted_at),
    index("ix_documents_doc_class").on(t.doc_class),
    index("ix_documents_sha256").on(t.sha256),
    index("ix_documents_parent_document_id").on(t.parent_document_id),
    index("ix_documents_is_latest").on(t.is_latest),
    index("ix_documents_legal_hold").on(t.legal_hold),
    index("ix_documents_is_sensitive").on(t.is_sensitive),
    index("ix_documents_uploaded_by_id").on(t.uploaded_by_id),
    index("ix_documents_extraction_status").on(t.extraction_status),
  ],
);
export type Document = typeof documents.$inferSelect;

/** Chain root id (Python `Document.root_id`). */
export const rootId = (d: Pick<Document, "id" | "parent_document_id">): string => d.parent_document_id || d.id;

/** Polymorphic record linkage. Links are attached to the chain root so they follow every version. */
export const documentLinks = pgTable(
  "document_links",
  {
    id: pk(),
    document_id: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    entity_type: varchar("entity_type", { length: 40 }).notNull(),
    entity_id: uuid("entity_id").notNull(),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    created_by_id: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("uq_document_links_target").on(t.document_id, t.entity_type, t.entity_id),
    index("ix_document_links_document_id").on(t.document_id),
    index("ix_document_links_entity_type").on(t.entity_type),
    index("ix_document_links_entity_id").on(t.entity_id),
  ],
);
export type DocumentLink = typeof documentLinks.$inferSelect;

/** Immutable access trail: every view, download and preview. */
export const documentAccessLog = pgTable(
  "document_access_log",
  {
    id: pk(),
    document_id: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    user_id: fk("user_id", () => users.id),
    action: varchar("action", { length: 20 }).notNull(),
    occurred_at: tz("occurred_at").notNull().$defaultFn(() => new Date()),
    ip_address: varchar("ip_address", { length: 64 }),
  },
  (t) => [
    index("ix_document_access_log_document_id").on(t.document_id),
    index("ix_document_access_log_user_id").on(t.user_id),
    index("ix_document_access_log_action").on(t.action),
    index("ix_document_access_log_occurred_at").on(t.occurred_at),
  ],
);
export type DocumentAccessLog = typeof documentAccessLog.$inferSelect;

/** Non-blocking AI extraction run. `skipped` when no provider (or no text) is available. */
export const extractionJobs = pgTable(
  "extraction_jobs",
  {
    ...entity(),
    document_id: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "queued"),
    target_entity_type: varchar("target_entity_type", { length: 40 }),
    target_entity_id: uuid("target_entity_id"),
    fields: jsonb("fields").$type<any[]>().notNull().$defaultFn(() => []),
    provider: varchar("provider", { length: 60 }),
    model: varchar("model", { length: 120 }),
    values_count: integer("values_count").notNull().$defaultFn(() => 0),
    message: text("message"),
    started_at: tz("started_at"),
    finished_at: tz("finished_at"),
  },
  (t) => [
    index("ix_extraction_jobs_deleted_at").on(t.deleted_at),
    index("ix_extraction_jobs_document_id").on(t.document_id),
    index("ix_extraction_jobs_status").on(t.status),
  ],
);
export type ExtractionJob = typeof extractionJobs.$inferSelect;

/** A candidate value with page/clause citation and confidence. Never authoritative until a named human confirms. */
export const extractedValues = pgTable(
  "extracted_values",
  {
    ...entity(),
    document_id: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    job_id: fk("job_id", () => extractionJobs.id),
    origin: varchar("origin", { length: 20 }).notNull().$defaultFn(() => "ai"), // ai | manual
    target_entity_type: varchar("target_entity_type", { length: 40 }),
    target_entity_id: uuid("target_entity_id"),
    field: varchar("field", { length: 80 }).notNull(),
    value_type: varchar("value_type", { length: 20 }).notNull().$defaultFn(() => "text"), // text | number | money | date | percent
    value: jsonb("value").$type<any>(),
    original_value: jsonb("original_value").$type<any>(),
    page: integer("page"),
    clause: varchar("clause", { length: 200 }),
    citation_text: text("citation_text"),
    confidence: doublePrecision("confidence").notNull().$defaultFn(() => 0),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "pending"),
    reviewer_id: fk("reviewer_id", () => users.id),
    reviewed_at: tz("reviewed_at"),
    review_note: text("review_note"),
    ai_model: varchar("ai_model", { length: 120 }),
    applied_observation_id: uuid("applied_observation_id"),
  },
  (t) => [
    index("ix_extracted_values_deleted_at").on(t.deleted_at),
    index("ix_extracted_values_document_id").on(t.document_id),
    index("ix_extracted_values_job_id").on(t.job_id),
    index("ix_extracted_values_target_entity_type").on(t.target_entity_type),
    index("ix_extracted_values_target_entity_id").on(t.target_entity_id),
    index("ix_extracted_values_field").on(t.field),
    index("ix_extracted_values_status").on(t.status),
    index("ix_extracted_values_reviewer_id").on(t.reviewer_id),
  ],
);
export type ExtractedValue = typeof extractedValues.$inferSelect;

/** Prompt/model/output logging for AI provenance. Prompts are stored as hashes only. */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: pk(),
    provider: varchar("provider", { length: 60 }).notNull(),
    model: varchar("model", { length: 120 }),
    purpose: varchar("purpose", { length: 60 }).notNull(),
    prompt_hash: varchar("prompt_hash", { length: 64 }).notNull(),
    input_tokens: integer("input_tokens"),
    output_tokens: integer("output_tokens"),
    latency_ms: integer("latency_ms").notNull().$defaultFn(() => 0),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "ok"), // ok | error
    error: text("error"),
    output_summary: jsonb("output_summary").$type<Record<string, any> | null>(),
    document_id: fk("document_id", () => documents.id),
    created_by_id: fk("created_by_id", () => users.id),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("ix_ai_calls_provider").on(t.provider),
    index("ix_ai_calls_purpose").on(t.purpose),
    index("ix_ai_calls_document_id").on(t.document_id),
    index("ix_ai_calls_created_by_id").on(t.created_by_id),
    index("ix_ai_calls_created_at").on(t.created_at),
  ],
);
export type AICall = typeof aiCalls.$inferSelect;
