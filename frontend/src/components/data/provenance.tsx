"use client";

import { Sparkles } from "lucide-react";

import { Tooltip } from "@/components/ui/misc";
import { cn, formatDate } from "@/lib/utils";

export interface ProvenanceInfo {
  source: string;
  observed_on: string | null;
  confidence: number;
  verification: "unverified" | "verified" | "rejected";
  ai_derived: boolean;
}

/** Small indicator next to a material value: colour = verification, tooltip = source/date/confidence. */
export function ProvenanceDot({ obs }: { obs?: ProvenanceInfo | null }) {
  if (!obs) return null;
  const color =
    obs.verification === "verified" ? "bg-positive" : obs.verification === "rejected" ? "bg-negative" : "bg-caution";
  return (
    <Tooltip
      content={
        <div className="space-y-0.5">
          <p className="font-medium">
            {obs.verification === "verified" ? "Verified" : obs.verification === "rejected" ? "Rejected" : "Unverified"}
            {obs.ai_derived && " · AI-derived"}
          </p>
          <p className="text-white/70">Source: {obs.source}</p>
          <p className="text-white/70">Observed: {formatDate(obs.observed_on)}</p>
          <p className="text-white/70">Confidence: {Math.round(obs.confidence * 100)}%</p>
        </div>
      }
    >
      <span className="inline-flex cursor-help items-center gap-0.5">
        <span className={cn("size-1.5 rounded-full", color)} />
        {obs.ai_derived && <Sparkles className="size-3 text-info" />}
      </span>
    </Tooltip>
  );
}

export function ConfidencePill({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 80 ? "text-positive" : pct >= 50 ? "text-caution" : "text-negative";
  return <span className={cn("text-xs font-medium tabular", tone)}>{pct}%</span>;
}
