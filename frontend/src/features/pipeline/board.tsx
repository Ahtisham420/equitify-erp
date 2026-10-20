"use client";

import { CalendarClock, GripVertical } from "lucide-react";
import Link from "next/link";
import { useState, type DragEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Avatar, Skeleton, Tooltip } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { type Params } from "@/lib/api";
import { cn, formatCurrency, formatDate, formatNumber, isOverdue } from "@/lib/utils";

import { ACTIVE_STAGES, stageLabel, useBoard, type OpportunityListItem, type Stage } from "./api";
import { MoveStageDialog } from "./move-dialog";

const DROP_ZONES: Stage[] = ["closed", "nurture", "dead"];

function OpportunityCard({ o, draggable, onDragStart }: { o: OpportunityListItem; draggable: boolean; onDragStart: (e: DragEvent) => void }) {
  const overdue = !!o.next_action_at && isOverdue(o.next_action_at);
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className={cn(
        "group rounded-md border bg-surface p-2.5 shadow-card transition-colors",
        draggable && "cursor-grab active:cursor-grabbing",
        o.stalled ? "border-caution/50" : "border-line hover:border-line-strong",
      )}
    >
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <Link href={`/pipeline/${o.id}`} className="line-clamp-2 text-sm font-medium text-ink hover:underline" draggable={false}>
            {o.title}
          </Link>
          {o.property_label && o.property_label !== o.title && <p className="truncate text-xs text-ink-3">{o.property_label}</p>}
          {!o.property_label && o.property_city && <p className="truncate text-xs text-ink-3">{[o.property_city, o.property_state].filter(Boolean).join(", ")}</p>}
        </div>
        {draggable && <GripVertical className="mt-0.5 size-3.5 shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <Avatar name={o.owner_name ?? "Unassigned"} size={18} />
        <Tooltip content={o.stalled ? "Stalled — over this stage's threshold" : "Days in stage"}>
          <span className={cn("tabular", o.stalled ? "font-medium text-caution" : "text-ink-3")}>{formatNumber(Math.floor(o.stage_age_days))}d</span>
        </Tooltip>
        {o.next_action_at && (
          <Tooltip content={o.next_action ?? "Next action"}>
            <span className={cn("inline-flex items-center gap-1 tabular", overdue ? "font-medium text-negative" : "text-ink-2")}>
              <CalendarClock className="size-3" />
              {formatDate(o.next_action_at, "MMM d")}
            </span>
          </Tooltip>
        )}
        <span className="ml-auto tabular text-ink-2">{o.value != null ? formatCurrency(o.value, { compact: true }) : ""}</span>
      </div>
      {(o.priority === "high" || o.priority === "urgent") && (
        <div className="mt-1.5">
          <Badge tone={o.priority === "urgent" ? "red" : "amber"}>{o.priority === "urgent" ? "Urgent" : "High priority"}</Badge>
        </div>
      )}
    </div>
  );
}

/** Kanban board with native HTML5 drag-and-drop; dropping opens the gated Move stage dialog. */
export function PipelineBoard({ params }: { params: Params }) {
  const { can } = useAuth();
  const { data, isLoading, isFetching } = useBoard(params);
  const [dragging, setDragging] = useState<OpportunityListItem | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const [move, setMove] = useState<{ o: OpportunityListItem; to: Stage } | null>(null);
  const canMove = can("pipeline", "edit");

  const startDrag = (o: OpportunityListItem) => (e: DragEvent) => {
    e.dataTransfer.setData("text/plain", o.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(o);
  };

  const dropProps = (stage: Stage) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging || dragging.stage === stage) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== stage) setOver(stage);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver((s) => (s === stage ? null : s));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (dragging && dragging.stage !== stage) setMove({ o: dragging, to: stage });
      setDragging(null);
      setOver(null);
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex gap-3 overflow-hidden">
        {ACTIVE_STAGES.slice(0, 5).map((s) => (
          <Skeleton key={s} className="h-80 w-72 shrink-0" />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", isFetching && "opacity-90")} onDragEnd={() => { setDragging(null); setOver(null); }}>
      <div className="flex gap-3 overflow-x-auto pb-3 scrollbar-thin">
        {data.map((col) => (
          <div
            key={col.stage}
            {...dropProps(col.stage)}
            className={cn(
              "flex max-h-[calc(100vh-330px)] min-h-[240px] w-72 shrink-0 flex-col rounded-lg border bg-subtle/70 transition-colors",
              over === col.stage ? "border-accent/50 bg-accent-soft/40" : "border-line",
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{stageLabel(col.stage)}</p>
                <p className="text-xs text-ink-3 tabular">{formatCurrency(col.value, { compact: true })}</p>
              </div>
              <span className="rounded bg-muted px-1.5 text-xs font-medium text-ink-2 tabular">{formatNumber(col.count)}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2 scrollbar-thin">
              {col.items.map((o) => (
                <OpportunityCard key={o.id} o={o} draggable={canMove} onDragStart={startDrag(o)} />
              ))}
              {col.items.length === 0 && <p className="px-1 py-6 text-center text-xs text-ink-3">No opportunities</p>}
              {col.count > col.items.length && (
                <Link href={`/pipeline?view=table&stage=${col.stage}`} className="block py-1 text-center text-xs font-medium text-accent hover:underline">
                  View all {formatNumber(col.count)}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      {canMove && (
        <div className={cn("grid grid-cols-3 gap-3 transition-opacity", dragging ? "opacity-100" : "opacity-60")}>
          {DROP_ZONES.map((s) => (
            <div
              key={s}
              {...dropProps(s)}
              className={cn(
                "rounded-lg border border-dashed px-3 py-3 text-center text-sm transition-colors",
                over === s ? "border-accent/60 bg-accent-soft/40 text-ink" : "border-line-strong text-ink-3",
              )}
            >
              Drop to move to <span className="font-medium text-ink-2">{stageLabel(s)}</span>
            </div>
          ))}
        </div>
      )}

      <MoveStageDialog
        open={!!move}
        onOpenChange={(o) => !o && setMove(null)}
        opportunity={move ? { id: move.o.id, title: move.o.title, stage: move.o.stage } : null}
        toStage={move?.to ?? null}
      />
    </div>
  );
}
