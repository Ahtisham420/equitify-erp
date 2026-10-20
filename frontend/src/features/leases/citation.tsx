"use client";

import { Check, ExternalLink, FileText, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime } from "@/lib/utils";

import { openCitation, type Citation } from "./api";

export function hasCitation(c?: Partial<Citation> | null) {
  return !!c && !!(c.document_id || c.page || c.clause_ref || c.quoted_text);
}

/** Clause-level source chip: shows page / clause and opens the cited page of the source document. */
export function CitationChip({ citation, className }: { citation?: Partial<Citation> | null; className?: string }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!hasCitation(citation)) return null;
  const c = citation as Citation;
  const label = [c.page ? `p. ${c.page}` : null, c.clause_ref ? `§ ${c.clause_ref}` : null].filter(Boolean).join(" · ") || "Source";

  const open = async () => {
    if (!c.document_id) return;
    setBusy(true);
    try {
      await openCitation(c.document_id, c.page);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex h-5 items-center gap-1 rounded border border-line bg-subtle px-1.5 text-2xs font-medium text-ink-2 hover:border-line-strong hover:text-ink",
            className,
          )}
        >
          <FileText className="size-3" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-2 p-3" onClick={(e) => e.stopPropagation()}>
          <p className="text-xs font-medium text-ink-3">{label}</p>
          {c.quoted_text ? (
            <blockquote className="max-h-48 overflow-y-auto border-l-2 border-line-strong pl-2.5 text-sm text-ink-2 scrollbar-thin">{c.quoted_text}</blockquote>
          ) : (
            <p className="text-sm text-ink-3">No quoted text recorded.</p>
          )}
          {c.document_id && can("documents", "view") && (
            <Button size="sm" onClick={open} loading={busy}>
              <ExternalLink /> Open cited page
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Verification state + verify / unverify control for an abstracted term. */
export function VerifyControl({
  verified,
  aiExtracted,
  verifiedAt,
  onToggle,
  pending,
  compact,
}: {
  verified: boolean;
  aiExtracted?: boolean;
  verifiedAt?: string | null;
  onToggle?: (verified: boolean) => void;
  pending?: boolean;
  compact?: boolean;
}) {
  const { can } = useAuth();
  const canEdit = can("leases", "edit") && !!onToggle;
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {verified ? (
        <Tooltip content={verifiedAt ? `Verified ${formatDateTime(verifiedAt)}` : "Verified"}>
          <span>
            <Badge tone="green" dot>Verified</Badge>
          </span>
        </Tooltip>
      ) : (
        <Badge tone="amber" dot>
          {aiExtracted ? "AI · unverified" : "Unverified"}
        </Badge>
      )}
      {canEdit &&
        (verified ? (
          !compact && (
            <Button size="xs" variant="ghost" onClick={() => onToggle!(false)} disabled={pending} aria-label="Mark unverified">
              <X className="!size-3.5" />
            </Button>
          )
        ) : (
          <Button size="xs" onClick={() => onToggle!(true)} loading={pending}>
            <Check className="!size-3.5" /> Verify
          </Button>
        ))}
    </span>
  );
}

export function UnverifiedBanner({ count, leaseVerified }: { count: number; leaseVerified: boolean }) {
  if (leaseVerified && count === 0) return null;
  return (
    <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-caution/30 bg-caution-soft px-3 py-2.5 text-sm">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-caution" />
      <div>
        <p className="font-medium text-caution">{leaseVerified ? `${count} term${count === 1 ? "" : "s"} awaiting verification` : "Abstract not verified"}</p>
        <p className="text-ink-2">
          Critical dates and billing use verified terms only. AI-extracted and unverified terms are shown but do not drive dates, charges or valuation until a person verifies them.
        </p>
      </div>
    </div>
  );
}
