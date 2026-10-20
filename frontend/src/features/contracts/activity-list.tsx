"use client";

import { ArrowRight, History } from "lucide-react";

import { EmptyState } from "@/components/data/page";
import { describeAction } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Avatar, Skeleton } from "@/components/ui/misc";
import { formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import { useContractActivity } from "./api";

const ENTITY_LABELS: Record<string, string> = {
  contract: "Contract",
  critical_date: "Critical date",
  dd_item: "DD item",
  third_party_report: "Report",
  title_exception: "Title / survey",
  estoppel: "Estoppel / SNDA",
  risk_item: "Risk",
};

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ") : "empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Audit trail for the contract and everything hanging off it (dates, DD, reports, title, estoppels, risks). */
export function ContractActivity({ contractId }: { contractId: string }) {
  const { data, isLoading } = useContractActivity(contractId);
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data?.length) return <EmptyState icon={<History />} title="No activity yet" description="Every change to this contract and its diligence is recorded here." />;
  return (
    <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-line">
      {data.map((e) => {
        const changes = e.changes && typeof e.changes === "object" ? Object.entries(e.changes) : [];
        return (
          <li key={e.id} className="relative flex gap-3">
            <Avatar name={e.actor_name ?? "System"} className="relative z-10 ring-4 ring-surface" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                <span className="font-medium">{e.actor_name ?? "System"}</span>
                <span className="text-ink-2">{describeAction(e.action)}</span>
                <Badge tone="outline">{ENTITY_LABELS[e.entity_type] ?? titleCase(e.entity_type)}</Badge>
                {e.summary && <span className="text-ink-2">· {e.summary}</span>}
              </p>
              <p className="text-xs text-ink-3" title={formatDateTime(e.occurred_at)}>
                {formatRelative(e.occurred_at)}
              </p>
              {changes.length > 0 && (
                <div className="mt-2 space-y-1 rounded-md border border-line bg-subtle/60 px-3 py-2">
                  {changes.slice(0, 12).map(([field, c]) => {
                    const change = c as { from?: unknown; to?: unknown } | null;
                    const isDiff = !!change && typeof change === "object" && "to" in change;
                    return (
                      <div key={field} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="font-medium text-ink-2">{titleCase(field)}</span>
                        {isDiff ? (
                          <>
                            <span className="max-w-[200px] truncate text-ink-3 line-through decoration-ink-3/50">{show(change!.from)}</span>
                            <ArrowRight className="size-3 text-ink-3" />
                            <span className="max-w-[260px] truncate text-ink">{show(change!.to)}</span>
                          </>
                        ) : (
                          <span className="max-w-[420px] truncate text-ink">{show(c)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
