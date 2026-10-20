"use client";

import { Lock, ShieldAlert, Sparkles } from "lucide-react";
import Link from "next/link";

import { Badge, type Tone } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/misc";
import { formatDate } from "@/lib/utils";

import { LINK_TYPE_LABELS, VALUE_STATUS_LABELS, recordHref, type DocumentLink, type DocumentListItem } from "./api";

const EXTRACTION_TONES: Record<string, Tone> = {
  none: "outline",
  queued: "sky",
  running: "blue",
  completed: "green",
  skipped: "neutral",
  failed: "red",
};

const EXTRACTION_LABELS: Record<string, string> = {
  none: "Not extracted",
  queued: "Queued",
  running: "Extracting",
  completed: "Extracted",
  skipped: "Skipped",
  failed: "Failed",
};

export function ExtractionBadge({ status }: { status: string }) {
  return (
    <Badge tone={EXTRACTION_TONES[status] ?? "neutral"} dot>
      {EXTRACTION_LABELS[status] ?? status}
    </Badge>
  );
}

const VALUE_TONES: Record<string, Tone> = { pending: "amber", confirmed: "green", edited: "green", rejected: "red" };

export function ValueStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={VALUE_TONES[status] ?? "neutral"} dot>
      {VALUE_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function OriginBadge({ origin, model }: { origin: string; model?: string | null }) {
  if (origin !== "ai") return <Badge tone="outline">Manual</Badge>;
  return (
    <Tooltip content={model ? `Model: ${model}` : "AI-derived"}>
      <span>
        <Badge tone="sky">
          <Sparkles className="size-3" /> AI
        </Badge>
      </span>
    </Tooltip>
  );
}

/** Sensitivity, legal hold and retention markers for a document. */
export function DocFlags({ doc }: { doc: Pick<DocumentListItem, "is_sensitive" | "legal_hold" | "retention_until"> }) {
  return (
    <span className="inline-flex items-center gap-1">
      {doc.is_sensitive && (
        <Tooltip content="Sensitive — visible only with documents: view sensitive">
          <span>
            <Badge tone="amber">
              <ShieldAlert className="size-3" /> Sensitive
            </Badge>
          </span>
        </Tooltip>
      )}
      {doc.legal_hold && (
        <Tooltip content="Legal hold — cannot be deleted">
          <span>
            <Badge tone="red">
              <Lock className="size-3" /> Hold
            </Badge>
          </span>
        </Tooltip>
      )}
      {doc.retention_until && !doc.legal_hold && new Date(doc.retention_until) > new Date() && (
        <Tooltip content={`Retained until ${formatDate(doc.retention_until)}`}>
          <span>
            <Badge tone="outline">Retained</Badge>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

export function linkLabel(l: Pick<DocumentLink, "entity_type" | "entity_id" | "label">) {
  return l.label || `${LINK_TYPE_LABELS[l.entity_type] ?? l.entity_type} ${l.entity_id.slice(0, 8)}`;
}

export function LinkChips({ links, max = 2 }: { links: DocumentLink[]; max?: number }) {
  if (!links.length) return <span className="text-ink-3">—</span>;
  const shown = links.slice(0, max);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((l) => {
        const href = recordHref(l.entity_type, l.entity_id);
        const body = (
          <span className="inline-flex h-5 max-w-[180px] items-center gap-1 rounded bg-muted px-1.5 text-xs text-ink-2">
            <span className="text-ink-3">{LINK_TYPE_LABELS[l.entity_type] ?? l.entity_type}</span>
            <span className="truncate">{l.label ?? l.entity_id.slice(0, 8)}</span>
          </span>
        );
        return href ? (
          <Link key={l.id} href={href} onClick={(e) => e.stopPropagation()} className="hover:opacity-80">
            {body}
          </Link>
        ) : (
          <span key={l.id}>{body}</span>
        );
      })}
      {links.length > max && <span className="text-xs text-ink-3">+{links.length - max}</span>}
    </span>
  );
}
