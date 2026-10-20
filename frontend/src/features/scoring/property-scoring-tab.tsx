"use client";

import { Gauge, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";

import { usePropertyScore, useRescore } from "./api";
import { BandBadge, ScoreExplanation, Sparkline } from "./components";

export function PropertyScoringTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = usePropertyScore(propertyId);
  const rescore = useRescore();

  const run = () =>
    rescore.mutate(propertyId, {
      onSuccess: (r) => toast.success(r.score ? `Scored ${Math.round(r.score.score)} (${r.score.band} confidence)` : "Not eligible for scoring"),
      onError: (e) => toast.error(errorMessage(e)),
    });

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;
  const action = can("scoring", "edit") ? (
    <Button size="sm" loading={rescore.isPending} onClick={run}>
      <RefreshCw /> Rescore
    </Button>
  ) : undefined;

  return (
    <div className="space-y-4">
      {!data.score ? (
        <Card>
          <EmptyState
            icon={<Gauge />}
            title={data.eligible ? "Not scored yet" : "Not eligible for scoring"}
            description={
              data.eligible
                ? "Rescore to compute value components, confidence and drivers."
                : "Only properties whose current buy box evaluation is pass or pass with an approved exception are scored and ranked."
            }
            action={action}
          />
          {data.eligibility.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2 border-t border-line px-4 py-3">
              {data.eligibility.map((e, i) => (
                <span key={i} className="flex items-center gap-1.5 text-xs text-ink-2">
                  {e.buy_box_name ?? "Buy box"} <StatusBadge status={e.result} />
                </span>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  Opportunity score <BandBadge band={data.score.band} />
                </span>
              }
              description="Value score and data confidence are kept separate; rankings order by score within each confidence band."
              actions={action}
            />
            <CardBody>
              <ScoreExplanation score={data.score} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Score history" description={`${data.history.length} computation${data.history.length === 1 ? "" : "s"}`} />
            <CardBody className="space-y-3">
              <Sparkline points={data.history} width={560} height={64} />
              <ul className="divide-y divide-line text-sm">
                {[...data.history].reverse().slice(0, 12).map((h) => (
                  <li key={h.id} className="flex items-center gap-3 py-1.5">
                    <span className="w-10 font-medium text-ink tabular">{Math.round(h.score)}</span>
                    <span className="w-12 text-xs text-ink-3 tabular">{h.confidence.toFixed(2)}</span>
                    <BandBadge band={h.band} />
                    <span className="text-xs text-ink-3">v{h.config_version} · {h.trigger.replace(/_/g, " ")}</span>
                    <span className="ml-auto text-xs text-ink-3">{formatDateTime(h.computed_at)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
