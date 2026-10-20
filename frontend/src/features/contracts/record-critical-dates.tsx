"use client";

import { CalendarClock, Lock, Plus } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Avatar, Skeleton, Tooltip } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { isOverdueDate, useRecordDates, type CriticalDate } from "./api";
import { AddDateDialog, DateActionDialog, DateRowActions, DateStatusBadge, DueText, SourceBadge, type DateDialogKind } from "./critical-date-actions";

/** Critical dates attached to any record (lease, loan, offer, disposition, …). Reusable on record pages. */
export function RecordCriticalDates({
  relatedType,
  relatedId,
  relatedLabel,
  propertyId,
  title = "Critical dates",
}: {
  relatedType: string;
  relatedId: string;
  relatedLabel?: string | null;
  propertyId?: string | null;
  title?: string;
}) {
  const { can } = useAuth();
  const { data, isLoading } = useRecordDates(relatedType, relatedId);
  const [adding, setAdding] = useState(false);
  const [active, setActive] = useState<{ d: CriticalDate; kind: DateDialogKind } | null>(null);
  const rows = data?.items ?? [];
  const proposed = rows.filter((d) => d.status === "proposed").length;

  return (
    <Card>
      <CardHeader
        title={title}
        description={proposed ? `${proposed} awaiting confirmation against the source` : "Accountable deadlines with owners and escalation."}
        actions={
          can("contracts", "create") && (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <Plus /> Add
            </Button>
          )
        }
      />
      {isLoading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title="No critical dates" description="Deadlines from this record will appear here." className="py-8" />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((d) => (
            <li key={d.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5", isOverdueDate(d) && "bg-negative-soft/40", !["proposed", "confirmed", "missed"].includes(d.status) && "opacity-70")}>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                  {d.is_blocking && (
                    <Tooltip content="Blocking deadline">
                      <Lock className="size-3.5 shrink-0 text-ink-3" />
                    </Tooltip>
                  )}
                  <span className="truncate">{d.label}</span>
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <DueText d={d} />
                  <DateStatusBadge status={d.status} />
                  <SourceBadge d={d} />
                  {d.owner_name && (
                    <span className="flex items-center gap-1 text-ink-3">
                      <Avatar name={d.owner_name} size={16} /> {d.owner_name}
                    </span>
                  )}
                </div>
              </div>
              <DateRowActions d={d} compact onAction={(kind) => setActive({ d, kind })} />
            </li>
          ))}
        </ul>
      )}
      <AddDateDialog open={adding} onOpenChange={setAdding} relatedType={relatedType} relatedId={relatedId} relatedLabel={relatedLabel} propertyId={propertyId} />
      <DateActionDialog date={active?.d ?? null} kind={active?.kind ?? null} onClose={() => setActive(null)} />
    </Card>
  );
}
