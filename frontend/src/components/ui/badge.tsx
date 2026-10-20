import type { ReactNode } from "react";

import { cn, titleCase } from "@/lib/utils";

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "sky" | "outline";

const tones: Record<Tone, string> = {
  neutral: "bg-muted text-ink-2 ring-line-strong/50",
  blue: "bg-accent-soft text-accent-ink ring-accent/20",
  green: "bg-positive-soft text-positive ring-positive/20",
  amber: "bg-caution-soft text-caution ring-caution/20",
  red: "bg-negative-soft text-negative ring-negative/20",
  sky: "bg-info-soft text-info ring-info/20",
  outline: "bg-surface text-ink-2 ring-line-strong",
};

const dots: Record<Tone, string> = {
  neutral: "bg-ink-3",
  blue: "bg-accent",
  green: "bg-positive",
  amber: "bg-caution",
  red: "bg-negative",
  sky: "bg-info",
  outline: "bg-ink-3",
};

export function Badge({ tone = "neutral", dot, className, children }: { tone?: Tone; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", dots[tone])} />}
      {children}
    </span>
  );
}

/** One place that maps workflow states across modules to a consistent colour language. */
const STATUS_TONES: Record<string, Tone> = {
  // generic
  active: "green", inactive: "neutral", archived: "neutral", draft: "neutral", pending: "amber",
  open: "blue", in_progress: "blue", done: "green", completed: "green", cancelled: "neutral", closed: "neutral",
  approved: "green", rejected: "red", expired: "neutral", failed: "red", success: "green", overdue: "red",
  // verification
  verified: "green", unverified: "amber",
  // property
  tracked: "neutral", pursued: "blue", owned: "green", managed: "sky", listed: "amber", sold: "neutral",
  // pipeline
  sourced: "neutral", screening: "sky", research: "amber", underwriting: "blue", contact: "sky",
  negotiation: "blue", offer: "blue", under_contract: "green", due_diligence: "green", closing: "green",
  dead: "red", nurture: "amber",
  // buy box
  pass: "green", pass_with_exception: "amber", fail: "red", insufficient_data: "neutral",
  // severity / priority
  low: "neutral", medium: "amber", high: "red", critical: "red", urgent: "red", normal: "neutral",
  // compliance
  allowed: "green", blocked: "red", suppressed: "red", consented: "green", unknown: "neutral",
  // imports
  staged: "sky", validated: "blue", committed: "green", rolled_back: "neutral",
};

export function statusTone(status?: string | null): Tone {
  return (status && STATUS_TONES[status]) || "neutral";
}

export function StatusBadge({ status, label, className }: { status?: string | null; label?: string; className?: string }) {
  if (!status) return <span className="text-ink-3">—</span>;
  return (
    <Badge tone={statusTone(status)} dot className={className}>
      {label ?? titleCase(status)}
    </Badge>
  );
}
