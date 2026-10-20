"use client";

import { Filter, History, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";

import { usePropertyEvaluations, useRunPropertyEvaluation } from "./api";
import { EvaluationDetails, ExceptionActions, ExceptionBadge, ResultBadge } from "./evaluation";

export function PropertyBuyboxTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const [history, setHistory] = useState(false);
  const { data, isLoading } = usePropertyEvaluations(propertyId, history);
  const run = useRunPropertyEvaluation(propertyId);

  const evaluate = () =>
    run.mutate(undefined, {
      onSuccess: (r) => toast.success(r.length ? `Evaluated against ${r.length} buy box${r.length === 1 ? "" : "es"}` : "No active buy boxes to evaluate against"),
      onError: (e) => toast.error(errorMessage(e)),
    });

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  const current = (data ?? []).filter((e) => e.is_current);
  const past = (data ?? []).filter((e) => !e.is_current);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Fit is a gate, not a score. Failing properties stay out of eligible rankings unless an exception is approved.</p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setHistory((h) => !h)}>
            <History /> {history ? "Hide history" : "Show history"}
          </Button>
          {can("buybox", "edit") && (
            <Button size="sm" loading={run.isPending} onClick={evaluate}>
              <RefreshCw /> Evaluate now
            </Button>
          )}
        </div>
      </div>

      {current.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Filter />}
            title="Not evaluated yet"
            description="This property has no evaluation against an active buy box."
            action={can("buybox", "edit") ? <Button onClick={evaluate} loading={run.isPending}>Evaluate now</Button> : undefined}
          />
        </Card>
      ) : (
        current.map((e) => (
          <Card key={e.id}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/buy-boxes/${e.buy_box_id}`} className="hover:underline">
                    {e.buy_box_name ?? "Buy box"}
                  </Link>
                  <span className="text-xs font-normal text-ink-3">v{e.buy_box_version}</span>
                  <ResultBadge result={e.result} />
                  <ExceptionBadge status={e.exception_status} />
                </span>
              }
              actions={<ExceptionActions evaluation={e} />}
            />
            <CardBody>
              <EvaluationDetails evaluation={e} />
            </CardBody>
          </Card>
        ))
      )}

      {history && past.length > 0 && (
        <Card>
          <CardHeader title="Previous evaluations" description="Superseded results are kept with the criteria version used." />
          <ul className="divide-y divide-line">
            {past.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <span className="font-medium text-ink">{e.buy_box_name}</span>
                <span className="text-xs text-ink-3">v{e.buy_box_version}</span>
                <ResultBadge result={e.result} />
                {e.missing_fields.length > 0 && <span className="text-xs text-ink-3">missing {e.missing_fields.join(", ")}</span>}
                <span className="ml-auto text-xs text-ink-3">{formatDateTime(e.evaluated_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
