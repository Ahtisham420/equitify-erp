"use client";

import { Plus, Radar } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { cn, formatDate } from "@/lib/utils";

import { signalTitle, usePropertySignals } from "./api";
import { CategoryBadge, DecayBar, MotivationMeter, PriorityBadge, SensitiveBadge, SeverityBadge } from "./components";
import { SignalSheet } from "./signal-sheet";

export function PropertySignalsTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = usePropertySignals(propertyId, showAll);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading || !data) return <Skeleton className="h-48 w-full" />;
  const { motivation, signals } = data;
  const contribution = new Map(motivation.contributions.map((c) => [c.signal_id, c.contribution]));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <Card>
          <CardBody>
            <MotivationMeter motivation={motivation} />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="text-sm text-ink-2">
            Signals on this property and on its current owners. Each signal&apos;s weight decays with its type&apos;s half-life; independent signals inside
            the {motivation.window_days}-day window stack and escalate priority. Sensitive signals stay internal and never appear in exports or outreach.
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Signals"
          description={showAll ? "Including expired and dismissed signals" : "Active signals"}
          actions={
            <>
              <Button size="sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Active only" : "Show all"}
              </Button>
              {can("signals", "create") && (
                <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                  <Plus /> Record signal
                </Button>
              )}
            </>
          }
        />
        {signals.length === 0 ? (
          <EmptyState icon={<Radar />} title="No signals" description="Record a lien, maturity, vacancy, lease event, rezoning or other dated signal with its source." />
        ) : (
          <ul className="divide-y divide-line">
            {signals.map((s) => (
              <li key={s.id} className={cn("flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-subtle/60", s.effective_status !== "active" && "opacity-60")} onClick={() => setOpenId(s.id)}>
                <div className="min-w-[220px] flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                    {signalTitle(s)}
                    {s.is_sensitive && <SensitiveBadge />}
                    {s.owner_id && !s.property_id && <span className="text-xs font-normal text-ink-3">via owner {s.owner_label}</span>}
                  </p>
                  <p className="text-xs text-ink-3">
                    {formatDate(s.observed_on)} · {s.source} · confidence {Math.round(s.confidence * 100)}%
                  </p>
                </div>
                <CategoryBadge category={s.category} />
                <SeverityBadge severity={s.severity} />
                <PriorityBadge priority={s.priority} stacked={s.stacked} />
                <DecayBar signal={s} />
                <span className="w-14 text-right text-xs text-ink-3 tabular">{contribution.has(s.id) ? `+${contribution.get(s.id)}` : ""}</span>
                {s.effective_status !== "active" && <StatusBadge status={s.effective_status} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SignalSheet open={creating} onOpenChange={setCreating} defaults={{ property_id: propertyId }} />
      <SignalSheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)} signalId={openId} />
    </div>
  );
}
