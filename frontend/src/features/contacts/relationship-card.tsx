"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FieldGrid, FieldItem } from "@/components/data/page";
import { Skeleton } from "@/components/ui/misc";
import { cn, formatDateTime, formatPercent, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import { RESPONSIVENESS_TONE, STRENGTH_TONE, useContactContext, type EntityKind } from "./api";

interface Rel {
  relationship_strength: string;
  responsiveness: string;
  last_touch_at: string | null;
  next_action_at: string | null;
  next_action: string | null;
  preferences: Record<string, unknown>;
  contact_preferences?: Record<string, unknown>;
}

/** Last touch, next action, responsiveness, close rate, deal-flow attribution, preferences, strength. */
export function RelationshipCard({ kind, id, record }: { kind: EntityKind; id: string; record: Rel }) {
  const { data, isLoading } = useContactContext(kind, id);
  const m = data?.metrics;
  const lastTouch = m?.last_touch_at ?? record.last_touch_at;
  const nextAt = record.next_action_at;
  const sources = Object.entries(m?.source_attribution ?? {}).sort((a, b) => b[1] - a[1]);
  const prefs = record.preferences?.summary as string | undefined;
  const channel = record.contact_preferences?.preferred_channel as string | undefined;
  const bestTime = record.contact_preferences?.best_time as string | undefined;

  return (
    <Card>
      <CardHeader title="Relationship" />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={STRENGTH_TONE[record.relationship_strength] ?? "neutral"} dot>
            {titleCase(record.relationship_strength)} relationship
          </Badge>
          <Badge tone={RESPONSIVENESS_TONE[record.responsiveness] ?? "neutral"}>
            Responsiveness: {titleCase(record.responsiveness)}
          </Badge>
        </div>
        <FieldGrid cols={2}>
          <FieldItem label="Last touch">{lastTouch ? <span title={formatDateTime(lastTouch)}>{formatRelative(lastTouch)}</span> : null}</FieldItem>
          <FieldItem label="Next action">
            {nextAt ? (
              <span className={cn(isOverdue(nextAt) && "text-negative")} title={formatDateTime(nextAt)}>
                {formatRelative(nextAt)}
              </span>
            ) : null}
          </FieldItem>
          {record.next_action && <FieldItem label="Next step" className="col-span-2">{record.next_action}</FieldItem>}
          {isLoading ? (
            <Skeleton className="col-span-2 h-10" />
          ) : (
            <>
              <FieldItem label="Interactions">
                {m ? `${m.interactions} (${m.meaningful_interactions} meaningful)` : null}
              </FieldItem>
              <FieldItem label="Response rate">{m?.response_rate != null ? formatPercent(m.response_rate * 100, 0) : null}</FieldItem>
              <FieldItem label="Deals">{m ? `${m.opportunities} · ${m.won} won · ${m.lost} lost` : null}</FieldItem>
              <FieldItem label="Close rate">{m?.close_rate != null ? formatPercent(m.close_rate * 100, 0) : null}</FieldItem>
            </>
          )}
          {channel && <FieldItem label="Preferred channel">{titleCase(channel)}</FieldItem>}
          {bestTime && <FieldItem label="Best time">{bestTime}</FieldItem>}
        </FieldGrid>
        {sources.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-ink-3">Deal-flow attribution</p>
            <div className="flex flex-wrap gap-1">
              {sources.map(([s, c]) => (
                <Badge key={s} tone="outline">
                  {titleCase(s)} · {c}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {prefs && (
          <div>
            <p className="mb-1 text-xs text-ink-3">Preferences</p>
            <p className="whitespace-pre-wrap text-sm text-ink-2">{prefs}</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
