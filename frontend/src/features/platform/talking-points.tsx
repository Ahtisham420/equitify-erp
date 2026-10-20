"use client";

import { useQueryClient } from "@tanstack/react-query";
import { MessageSquareText, RefreshCw } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatCurrency, formatDate, titleCase } from "@/lib/utils";

import { aiKeys, useTalkingPoints } from "./api";

/** Pre-call talking points grounded in the person's properties, history, outbound-safe signals and valuations. */
export function TalkingPoints({ personId }: { personId: string }) {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, isError, error } = useTalkingPoints(personId);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquareText className="size-4 text-ink-3" />
          <span className="text-sm font-medium text-ink">Pre-call talking points</span>
          {data && (data.ai_used ? <Badge tone="blue">AI-drafted from records</Badge> : <Badge>From records</Badge>)}
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh talking points" loading={isFetching && !isLoading} onClick={() => qc.invalidateQueries({ queryKey: aiKeys.talkingPoints(personId) })}>
          {!isFetching && <RefreshCw />}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : isError ? (
        <p className="text-sm text-negative">{errorMessage(error)}</p>
      ) : data && data.points.length === 0 ? (
        <p className="text-sm text-ink-3">Not enough history yet. Log an interaction or link a property to build talking points.</p>
      ) : (
        data && (
          <>
            <ol className="space-y-2">
              {data.points.map((p, i) => (
                <li key={i} className="flex gap-2.5 text-sm">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-subtle text-2xs font-medium text-ink-3 tabular">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="text-ink">{p.text}</span>
                    {p.basis && <span className="block text-xs text-ink-3">{p.basis}</span>}
                  </span>
                </li>
              ))}
            </ol>
            {data.message && <p className="text-xs text-ink-3">{data.message}</p>}

            {(data.properties.length > 0 || data.signals.length > 0 || data.valuations.length > 0) && (
              <div className="space-y-2 border-t border-line pt-3">
                {data.properties.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-3">Properties</p>
                    <ul className="space-y-1">
                      {data.properties.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                          <Link href={`/properties/${p.id}`} className="min-w-0 truncate text-ink hover:underline">
                            {p.label}
                          </Link>
                          <span className="shrink-0 text-xs text-ink-3">
                            {titleCase(p.relationship)}
                            {p.opportunity_stage ? ` · ${titleCase(p.opportunity_stage)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.signals.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-3">Signals</p>
                    <ul className="space-y-1">
                      {data.signals.map((s, i) => (
                        <li key={i} className="flex items-center justify-between gap-2 text-sm">
                          <span className="min-w-0 truncate text-ink">{titleCase(s.title)} · {s.property}</span>
                          <span className="shrink-0 text-xs text-ink-3">{formatDate(s.observed_on)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.valuations.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-3">Valuations</p>
                    <ul className="space-y-1">
                      {data.valuations.map((v) => (
                        <li key={v.property_id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="min-w-0 truncate text-ink">{v.property}</span>
                          <span className="shrink-0 text-ink-2 tabular">
                            {formatCurrency(v.value_point, { compact: true })}
                            <span className="ml-1.5 text-xs text-ink-3">{formatDate(v.as_of)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
