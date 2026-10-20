"use client";

import { Layers, Lock } from "lucide-react";

import { Badge, type Tone } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/misc";
import { cn, formatDate } from "@/lib/utils";

import { CATEGORY_LABELS, halfLifeLabel, type Motivation, type Signal } from "./api";

const SEVERITY_TONES: Record<number, Tone> = { 1: "neutral", 2: "neutral", 3: "amber", 4: "red", 5: "red" };
const PRIORITY_TONES: Record<string, Tone> = { low: "neutral", normal: "neutral", high: "amber", urgent: "red" };

export function SeverityBadge({ severity }: { severity: number }) {
  return (
    <Badge tone={SEVERITY_TONES[severity] ?? "neutral"} className="tabular">
      <span className="flex gap-px" aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={cn("h-2 w-1 rounded-sm", i <= severity ? "bg-current" : "bg-current opacity-20")} />
        ))}
      </span>
      {severity}
    </Badge>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  return <Badge tone="outline">{CATEGORY_LABELS[category] ?? category}</Badge>;
}

export function PriorityBadge({ priority, stacked }: { priority: string; stacked?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={PRIORITY_TONES[priority] ?? "neutral"} dot>
        {priority.charAt(0).toUpperCase() + priority.slice(1)}
      </Badge>
      {stacked && (
        <Tooltip content="Part of a stack of independent signals inside the configured window">
          <span className="inline-flex">
            <Badge tone="blue">
              <Layers className="size-3" /> Stacked
            </Badge>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

export function SensitiveBadge() {
  return (
    <Tooltip content="Sensitive: internal only. Never included in exports or outbound communications.">
      <span className="inline-flex">
        <Badge tone="amber">
          <Lock className="size-3" /> Sensitive
        </Badge>
      </span>
    </Tooltip>
  );
}

/** Current decayed weight (0–1) as a bar, with the half-life in the tooltip. */
export function DecayBar({ signal, className }: { signal: Pick<Signal, "current_weight" | "half_life_days" | "age_days" | "effective_status" | "expires_on">; className?: string }) {
  const pct = Math.round(signal.current_weight * 100);
  const inactive = signal.effective_status !== "active";
  const tip = inactive
    ? `${signal.effective_status === "expired" ? "Expired" : "Dismissed"} — no longer weighted`
    : `${pct}% of original weight · ${signal.age_days} days old · half-life ${halfLifeLabel(signal.half_life_days)}${signal.expires_on ? ` · expires ${formatDate(signal.expires_on)}` : ""}`;
  return (
    <Tooltip content={tip}>
      <div className={cn("flex items-center gap-2", className)}>
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full", inactive ? "bg-ink-3/40" : pct >= 60 ? "bg-accent" : pct >= 30 ? "bg-caution" : "bg-ink-3")} style={{ width: `${inactive ? 0 : pct}%` }} />
        </div>
        <span className="w-8 text-right text-xs text-ink-3 tabular">{inactive ? "—" : `${pct}%`}</span>
      </div>
    </Tooltip>
  );
}

export function MotivationMeter({ motivation }: { motivation: Motivation }) {
  const v = Math.round(motivation.index);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium text-ink-3">Motivation index</p>
        <p className="text-2xl font-semibold tracking-tight text-ink tabular">{v}</p>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", v >= 60 ? "bg-negative" : v >= 30 ? "bg-caution" : "bg-accent")} style={{ width: `${Math.min(100, v)}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-ink-3">
        {motivation.active_signals} active signal{motivation.active_signals === 1 ? "" : "s"}
        {motivation.stacked ? ` · ${motivation.stack_count} stacked within ${motivation.window_days} days (×${motivation.stack_multiplier})` : ""}
      </p>
    </div>
  );
}
