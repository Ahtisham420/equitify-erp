"use client";

import { ArrowDownLeft, ArrowUpRight, CalendarClock, CircleSlash, Mail, MapPin, MessageSquare, Phone, StickyNote, Users, FileText, Plus, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useState, type ComponentType } from "react";

import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { toQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatDateTime, formatRelative, isOverdue } from "@/lib/utils";

import { CHANNEL_LABELS, DISPOSITION_LABELS, DISPOSITION_TONES, formatDuration, useRecordInteractions, type Interaction, type RecordLinks } from "./api";
import { LogInteractionSheet } from "./log-interaction-sheet";

export const CHANNEL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  call: Phone, email: Mail, sms: MessageSquare, meeting: Users, tour: MapPin, letter: FileText, note: StickyNote,
};

/** One compact interaction row: channel, disposition, summary and its follow-up state. */
export function InteractionItem({ it, showRecord }: { it: Interaction; showRecord?: boolean }) {
  const Icon = CHANNEL_ICONS[it.channel] ?? StickyNote;
  const record = it.person_name || it.organization_name || it.property_label || it.opportunity_title;
  return (
    <li className="relative flex gap-3">
      <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-2 ring-4 ring-surface">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium text-ink">{CHANNEL_LABELS[it.channel] ?? it.channel}</span>
          {it.direction === "inbound" ? <ArrowDownLeft className="size-3.5 text-ink-3" /> : it.direction === "outbound" ? <ArrowUpRight className="size-3.5 text-ink-3" /> : null}
          {it.disposition && <Badge tone={DISPOSITION_TONES[it.disposition] ?? "neutral"}>{DISPOSITION_LABELS[it.disposition] ?? it.disposition}</Badge>}
          {showRecord && record && <span className="truncate text-ink-2">· {record}</span>}
          <span className="ml-auto whitespace-nowrap text-xs text-ink-3" title={formatDateTime(it.occurred_at)}>
            {formatRelative(it.occurred_at)}
          </span>
        </div>
        {(it.subject || it.summary) && (
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm text-ink-2">
            {it.subject && <span className="font-medium text-ink">{it.subject} — </span>}
            {it.summary}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
          {it.logged_by_name && <span>{it.logged_by_name}</span>}
          {it.contact_value && <span>{it.contact_value}</span>}
          {formatDuration(it.duration_seconds) && <span>{formatDuration(it.duration_seconds)}</span>}
          {it.next_action && (
            <span className={cn("inline-flex items-center gap-1", it.next_action_at && isOverdue(it.next_action_at) ? "text-negative" : "text-ink-2")}>
              <CalendarClock className="size-3" />
              {it.next_action}
              {it.next_action_at && ` · ${formatDate(it.next_action_at)}`}
            </span>
          )}
          {it.loop_closed && (
            <span className="inline-flex items-center gap-1" title={it.closed_reason ?? undefined}>
              <CircleSlash className="size-3" /> Loop closed{it.closed_reason ? `: ${it.closed_reason}` : ""}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export function InteractionList({ items, showRecord }: { items: Interaction[]; showRecord?: boolean }) {
  return (
    <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-line">
      {items.map((it) => (
        <InteractionItem key={it.id} it={it} showRecord={showRecord} />
      ))}
    </ol>
  );
}

/** Compact interaction timeline + "Log interaction" for embedding on record pages. */
export function RecordInteractions({ filter }: { filter: { person_id?: string; organization_id?: string; property_id?: string; opportunity_id?: string } }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const links: RecordLinks = filter;
  const { data, isLoading } = useRecordInteractions(links, 10);
  const items = data?.items ?? [];
  const viewAll = `/interactions${toQuery(links as Record<string, string | undefined>)}`;

  return (
    <Card>
      <CardHeader
        title="Interactions"
        description={data ? `${data.total} logged` : undefined}
        actions={
          <>
            {data && data.total > items.length && (
              <Link href={viewAll} className="text-xs font-medium text-accent hover:underline">
                View all
              </Link>
            )}
            {can("outreach", "create") && (
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus /> Log interaction
              </Button>
            )}
          </>
        }
      />
      <div className="p-4">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<MessagesSquare />} title="No interactions yet" description="Calls, emails, meetings and notes linked to this record appear here." className="py-8" />
        ) : (
          <InteractionList items={items} showRecord={!filter.person_id} />
        )}
      </div>
      <LogInteractionSheet open={open} onOpenChange={setOpen} defaults={filter} />
    </Card>
  );
}
