"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";

import { signalTitle, type Signal } from "./api";
import { CategoryBadge, DecayBar, SensitiveBadge, SeverityBadge } from "./components";
import { SignalSheet } from "./signal-sheet";

/** Signals linked to an owner and to the properties it currently owns (for person/organization pages). */
export function OwnerSignals({ kind, ownerId }: { kind: "person" | "organization"; ownerId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["signals", "owner", kind, ownerId],
    queryFn: () => api.get<Signal[]>(`/signals/owner/${kind}/${ownerId}`),
  });
  return (
    <Card>
      <CardHeader title="Signals" description="Dated, sourced signals on this owner and its current properties." />
      {isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : !data?.length ? (
        <p className="px-4 py-6 text-center text-sm text-ink-3">No signals recorded.</p>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((s) => (
            <li key={s.id} className={cn("flex cursor-pointer flex-wrap items-center gap-3 px-4 py-2 hover:bg-subtle/60", s.effective_status !== "active" && "opacity-60")} onClick={() => setOpenId(s.id)}>
              <div className="min-w-[200px] flex-1">
                <p className="flex items-center gap-1.5 text-sm text-ink">
                  {signalTitle(s)}
                  {s.is_sensitive && <SensitiveBadge />}
                </p>
                <p className="text-xs text-ink-3">
                  {formatDate(s.observed_on)} · {s.source}
                  {s.property_id && (
                    <>
                      {" · "}
                      <Link href={`/properties/${s.property_id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                        {s.property_label ?? "Property"}
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <CategoryBadge category={s.category} />
              <SeverityBadge severity={s.severity} />
              <DecayBar signal={s} />
            </li>
          ))}
        </ul>
      )}
      <SignalSheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)} signalId={openId} />
    </Card>
  );
}
