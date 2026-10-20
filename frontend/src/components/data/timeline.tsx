"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, History } from "lucide-react";

import { EmptyState } from "@/components/data/page";
import { Avatar, Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { formatDateTime, formatRelative, titleCase } from "@/lib/utils";

export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  changes: Record<string, { from: unknown; to: unknown } | unknown> | null;
  ip_address: string | null;
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function describeAction(action: string): string {
  const [, verb] = action.split(".");
  return titleCase(verb ?? action).toLowerCase();
}

/** Change history for any record, fed by the immutable audit log. */
export function RecordTimeline({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["timeline", entityType, entityId],
    queryFn: () => api.get<AuditEvent[]>(`/timeline/${entityType}/${entityId}`),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-6 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!data?.length) return <EmptyState icon={<History />} title="No activity yet" description="Changes to this record will appear here." />;

  return (
    <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-line">
      {data.map((e) => {
        const changes = e.changes && typeof e.changes === "object" ? Object.entries(e.changes) : [];
        return (
          <li key={e.id} className="relative flex gap-3">
            <Avatar name={e.actor_name ?? "System"} className="relative z-10 ring-4 ring-surface" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">
                <span className="font-medium">{e.actor_name ?? "System"}</span>{" "}
                <span className="text-ink-2">{describeAction(e.action)}</span>
                {e.summary && <span className="text-ink-2"> · {e.summary}</span>}
              </p>
              <p className="text-xs text-ink-3" title={formatDateTime(e.occurred_at)}>
                {formatRelative(e.occurred_at)}
              </p>
              {changes.length > 0 && (
                <div className="mt-2 space-y-1 rounded-md border border-line bg-subtle/60 px-3 py-2">
                  {changes.slice(0, 12).map(([field, c]) => {
                    const change = c as { from?: unknown; to?: unknown };
                    const isDiff = change && typeof change === "object" && "to" in change;
                    return (
                      <div key={field} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="font-medium text-ink-2">{titleCase(field)}</span>
                        {isDiff ? (
                          <>
                            <span className="max-w-[200px] truncate text-ink-3 line-through decoration-ink-3/50">{show(change.from)}</span>
                            <ArrowRight className="size-3 text-ink-3" />
                            <span className="max-w-[260px] truncate text-ink">{show(change.to)}</span>
                          </>
                        ) : (
                          <span className="truncate text-ink">{show(c)}</span>
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
