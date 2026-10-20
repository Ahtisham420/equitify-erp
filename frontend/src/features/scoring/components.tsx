"use client";

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { Badge, type Tone } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/dialog";
import { Skeleton, Tooltip } from "@/components/ui/misc";
import { cn, formatCurrency, formatDateTime, titleCase } from "@/lib/utils";

import { BAND_LABELS, COMPONENT_LABELS, usePropertyScore, type ConfidenceFactor, type HistoryPoint, type Score, type ScoreComponent } from "./api";

const BAND_TONES: Record<string, Tone> = { high: "green", medium: "amber", low: "neutral" };

export function BandBadge({ band }: { band: string }) {
  return (
    <Badge tone={BAND_TONES[band] ?? "neutral"} dot>
      {BAND_LABELS[band] ?? titleCase(band)}
    </Badge>
  );
}

export function ScoreDelta({ score, previous }: { score: number; previous: number | null | undefined }) {
  if (previous === null || previous === undefined) return <span className="text-xs text-ink-3">new</span>;
  const d = Math.round((score - previous) * 10) / 10;
  if (d === 0) return <Minus className="size-3.5 text-ink-3" aria-label="No change" />;
  return (
    <span className={cn("inline-flex items-center text-xs tabular", d > 0 ? "text-positive" : "text-negative")}>
      {d > 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {Math.abs(d)}
    </span>
  );
}

export function ScorePill({ score, className }: { score: number; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 min-w-[42px] items-center justify-center rounded-md px-1.5 text-sm font-semibold tabular", score >= 75 ? "bg-positive-soft text-positive" : score >= 50 ? "bg-accent-soft text-accent-ink" : "bg-muted text-ink-2", className)}>
      {Math.round(score)}
    </span>
  );
}

/** Tiny 6-component profile used in ranking rows. */
export function ComponentStrip({ values }: { values: Record<string, number> }) {
  const keys = ["economics", "location", "motivation", "transaction_probability", "relationship", "negative_risk"];
  return (
    <div className="flex items-end gap-0.5" aria-label="Component profile">
      {keys.map((k) => {
        const v = values[k] ?? 0;
        return (
          <Tooltip key={k} content={`${COMPONENT_LABELS[k]}: ${Math.round(v)}`}>
            <span className="flex h-5 w-1.5 items-end overflow-hidden rounded-sm bg-muted">
              <span className={cn("w-full rounded-sm", k === "negative_risk" ? "bg-negative" : "bg-accent")} style={{ height: `${Math.max(4, v)}%` }} />
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

function inputValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${titleCase(k)} ${String(x)}`).join(", ") || "—";
  return String(v);
}

export function ComponentRow({ c }: { c: ScoreComponent }) {
  const risk = c.key === "negative_risk";
  return (
    <div className="space-y-1.5 py-3">
      <div className="flex items-center gap-3">
        <p className="w-48 shrink-0 text-sm font-medium text-ink">{c.label || COMPONENT_LABELS[c.key]}</p>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full", risk ? "bg-negative" : "bg-accent")} style={{ width: `${Math.min(100, c.value)}%` }} />
        </div>
        <span className="w-10 text-right text-sm text-ink tabular">{Math.round(c.value)}</span>
        <Tooltip content={risk ? `Penalty weight ${c.weight}` : `Weight ${c.weight}`}>
          <span className={cn("w-14 text-right text-xs tabular", c.contribution < 0 ? "text-negative" : "text-ink-3")}>
            {c.contribution > 0 ? "+" : ""}
            {c.contribution.toFixed(1)}
          </span>
        </Tooltip>
      </div>
      <div className="space-y-0.5 pl-0 text-xs md:pl-[204px]">
        {c.positive.map((d, i) => (
          <p key={`p${i}`} className="flex items-start gap-1.5 text-positive">
            <ArrowUpRight className="mt-px size-3.5 shrink-0" /> <span className="text-ink-2">{d}</span>
          </p>
        ))}
        {c.negative.map((d, i) => (
          <p key={`n${i}`} className="flex items-start gap-1.5 text-negative">
            <ArrowDownRight className="mt-px size-3.5 shrink-0" /> <span className="text-ink-2">{d}</span>
          </p>
        ))}
        {c.missing.length > 0 && <p className="text-ink-3">Missing inputs: {c.missing.map((m) => titleCase(m)).join(", ")}</p>}
        {Object.keys(c.inputs).length > 0 && (
          <p className="text-ink-3">
            Inputs:{" "}
            {Object.entries(c.inputs)
              .map(([k, v]) => `${titleCase(k)} ${inputValue(v)}`)
              .join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
}

export function ConfidenceFactors({ factors, confidence }: { factors: ConfidenceFactor[]; confidence: number }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Confidence (certainty, not value)</p>
        <span className="text-sm font-semibold text-ink tabular">{confidence.toFixed(2)}</span>
      </div>
      {factors.map((f) => (
        <div key={f.key} className="flex items-center gap-3 text-sm">
          <span className="w-48 shrink-0 text-ink-2">{f.label}</span>
          {f.value >= 0 ? (
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-ink-3" style={{ width: `${Math.round(f.value * 100)}%` }} />
            </div>
          ) : (
            <span className="flex-1 text-xs text-negative">−{Math.abs(f.value).toFixed(2)}</span>
          )}
          <span className="w-10 text-right text-xs text-ink-3 tabular">{f.value >= 0 ? Math.round(f.value * 100) : ""}</span>
        </div>
      ))}
      {factors.filter((f) => f.detail).length > 0 && (
        <ul className="space-y-0.5 text-xs text-ink-3">
          {factors.map((f) => f.detail && <li key={f.key}>{f.label}: {f.detail}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Sparkline({ points, height = 40, width = 220 }: { points: HistoryPoint[]; height?: number; width?: number }) {
  if (points.length < 2) return <p className="text-xs text-ink-3">Not enough history yet.</p>;
  const xs = points.map((_, i) => (i / (points.length - 1)) * (width - 4) + 2);
  const ys = points.map((p) => height - 2 - (Math.max(0, Math.min(100, p.score)) / 100) * (height - 4));
  const d = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" role="img" aria-label="Score history">
      <line x1={0} x2={width} y1={height - 2 - 0.75 * (height - 4)} y2={height - 2 - 0.75 * (height - 4)} className="stroke-line" strokeDasharray="2 3" />
      <path d={d} fill="none" className="stroke-accent" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={p.id} cx={xs[i]} cy={ys[i]} r={i === points.length - 1 ? 3 : 1.75} className={i === points.length - 1 ? "fill-accent" : "fill-ink-3"}>
          <title>{`${Math.round(p.score)} · ${p.band} · ${formatDateTime(p.computed_at)} · ${p.trigger.replace(/_/g, " ")}`}</title>
        </circle>
      ))}
      <title>{`Latest ${Math.round(last.score)}`}</title>
    </svg>
  );
}

export function ScoreExplanation({ score, history }: { score: Score; history?: HistoryPoint[] }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <p className="text-xs text-ink-3">Score</p>
          <p className="text-3xl font-semibold tracking-tight text-ink tabular">{Math.round(score.score)}</p>
        </div>
        <div>
          <p className="text-xs text-ink-3">Confidence</p>
          <p className="text-3xl font-semibold tracking-tight text-ink-2 tabular">{score.confidence.toFixed(2)}</p>
        </div>
        <div className="space-y-1">
          <BandBadge band={score.band} />
          <p className="text-xs text-ink-3">
            Config v{score.config_version} · {formatDateTime(score.computed_at)}
          </p>
        </div>
        {history && history.length > 1 && (
          <div className="ml-auto">
            <Sparkline points={history} />
          </div>
        )}
      </div>

      {(score.needs_research || score.requires_human_approval) && (
        <div className="space-y-1.5">
          {score.needs_research && (
            <p className="flex items-start gap-2 rounded-md border border-caution/30 bg-caution-soft px-3 py-2 text-sm text-caution">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {score.drivers.note ?? "High value score on weak evidence — research before treating as a verified opportunity."}
            </p>
          )}
          {score.requires_human_approval && (
            <p className="flex items-start gap-2 rounded-md border border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ink-3" />
              {score.value_basis ? `High-dollar (${formatCurrency(score.value_basis, { compact: true })})` : "Value unknown"} — automated actions cannot act on this score without human approval.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Top positive drivers</p>
          <ul className="space-y-1 text-sm text-ink-2">
            {(score.drivers.positive ?? []).map((d, i) => (
              <li key={i} className="flex gap-1.5">
                <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-positive" />
                {d}
              </li>
            ))}
            {!(score.drivers.positive ?? []).length && <li className="text-ink-3">None</li>}
          </ul>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Top negative drivers</p>
          <ul className="space-y-1 text-sm text-ink-2">
            {(score.drivers.negative ?? []).map((d, i) => (
              <li key={i} className="flex gap-1.5">
                <ArrowDownRight className="mt-0.5 size-3.5 shrink-0 text-negative" />
                {d}
              </li>
            ))}
            {!(score.drivers.negative ?? []).length && <li className="text-ink-3">None</li>}
          </ul>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between border-b border-line pb-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Components</p>
          <p className="text-xs text-ink-3">value · contribution</p>
        </div>
        <div className="divide-y divide-line">
          {score.components.map((c) => (
            <ComponentRow key={c.key} c={c} />
          ))}
        </div>
      </div>

      <ConfidenceFactors factors={score.confidence_factors} confidence={score.confidence} />

      {score.eligibility.length > 0 && (
        <p className="text-xs text-ink-3">
          Eligible via buy box: {score.eligibility.filter((e) => e.result === "pass" || e.result === "pass_with_exception").map((e) => `${e.buy_box_name ?? "Buy box"} (${titleCase(e.result)})`).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Right-side drawer with the full explanation for a property's current score. */
export function ScoreExplanationSheet({ propertyId, title, onOpenChange }: { propertyId: string | null; title?: string | null; onOpenChange: (o: boolean) => void }) {
  const { data, isLoading } = usePropertyScore(propertyId);
  return (
    <Sheet
      open={!!propertyId}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      title={title ?? "Score explanation"}
      description={
        propertyId ? (
          <Link href={`/properties/${propertyId}`} className="text-accent hover:underline">
            Open property
          </Link>
        ) : undefined
      }
    >
      {isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : data.score ? (
        <ScoreExplanation score={data.score} history={data.history} />
      ) : (
        <p className="text-sm text-ink-2">
          {data.eligible ? "This property has not been scored yet." : "Not eligible: only properties passing a buy box (or with an approved exception) are scored."}
        </p>
      )}
    </Sheet>
  );
}
