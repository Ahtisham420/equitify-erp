"use client";

import { ArrowUpRight, Briefcase, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatRelative, titleCase } from "@/lib/utils";

import { TRIGGER_LABELS, useAssetByProperty, useMilestones, useVariances, useWatchlist, type Asset } from "./api";
import { AssetFormSheet, AssetStatusBadge, MetricCards, MilestoneStatusBadge } from "./asset-forms";

const KPI_KEYS = ["occupancy", "noi", "yield_on_cost", "leverage", "coverage", "value"];

function AssetSummary({ asset: a }: { asset: Asset }) {
  const milestones = useMilestones(a.id);
  const watch = useWatchlist({ asset_id: a.id, status: ["open"] });
  const variances = useVariances({ asset_id: a.id, unexplained: true });

  const ms = milestones.data ?? [];
  const openMs = ms.filter((m) => m.status === "planned" || m.status === "in_progress");
  const overdue = openMs.filter((m) => m.overdue).length;
  const done = ms.filter((m) => m.status === "done").length;
  const upcoming = [...openMs].sort((x, y) => (x.due_on ?? "9999").localeCompare(y.due_on ?? "9999")).slice(0, 5);
  const unexplained = variances.data?.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <AssetStatusBadge status={a.status} />
          {a.acquired_on && <span>Acquired {formatDate(a.acquired_on)}</span>}
          {a.basis !== null && <span className="tabular">· Basis {formatCurrency(a.basis)}</span>}
          {a.manager_name && <span>· Managed by {a.manager_name}</span>}
        </div>
        <Link href={`/assets/${a.id}`}>
          <Button size="sm">
            Open asset <ArrowUpRight />
          </Button>
        </Link>
      </div>

      <MetricCards metrics={a.kpis} keys={KPI_KEYS} className="md:grid-cols-3 xl:grid-cols-6" />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Milestones"
            description={milestones.isLoading ? undefined : `${done} done · ${openMs.length} open${overdue ? ` · ${overdue} overdue` : ""}`}
            actions={
              <Link href={`/assets/${a.id}?tab=milestones`} className="text-xs font-medium text-accent hover:underline">
                View all
              </Link>
            }
          />
          <CardBody className="p-0">
            {milestones.isLoading ? (
              <div className="p-4">
                <Skeleton className="h-20 w-full" />
              </div>
            ) : upcoming.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">{ms.length ? "All milestones are complete." : "No business plan milestones."}</p>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">{m.title}</p>
                      <p className={cn("text-xs", m.overdue ? "font-medium text-negative" : "text-ink-3")}>
                        {m.due_on ? `Due ${formatDate(m.due_on)}` : "No due date"}
                        {m.owner_name ? ` · ${m.owner_name}` : ""}
                      </p>
                    </div>
                    <MilestoneStatusBadge status={m.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Open watchlist"
            description={watch.data ? `${watch.data.length} open ${watch.data.length === 1 ? "entry" : "entries"}` : undefined}
            actions={
              <Link href={`/assets/${a.id}?tab=watchlist`} className="text-xs font-medium text-accent hover:underline">
                View all
              </Link>
            }
          />
          <CardBody className="p-0">
            {watch.isLoading ? (
              <div className="p-4">
                <Skeleton className="h-20 w-full" />
              </div>
            ) : !watch.data?.length ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">Nothing on the watchlist.</p>
            ) : (
              <ul className="divide-y divide-line">
                {watch.data.slice(0, 5).map((e) => (
                  <li key={e.id} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={e.severity} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{TRIGGER_LABELS[e.trigger] ?? titleCase(e.trigger)}</span>
                      <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(e.first_detected_at)}</span>
                    </div>
                    {e.detail && <p className="mt-0.5 truncate text-xs text-ink-3" title={e.detail}>{e.detail}</p>}
                    {e.source_href && (
                      <Link href={e.source_href} className="mt-0.5 inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline">
                        Source <ArrowUpRight className="size-3" />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Variances" description="Flagged against budget or underwriting" />
          <CardBody>
            {variances.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <Link href={`/assets/${a.id}?tab=financials`} className="block rounded-md p-1 hover:bg-subtle">
                <p className={cn("text-2xl font-semibold tabular", unexplained > 0 ? "text-caution" : "text-ink")}>{unexplained}</p>
                <p className="text-xs text-ink-3">{unexplained === 1 ? "variance needs an explanation" : "variances need an explanation"}</p>
              </Link>
            )}
            {a.benchmark?.available && (
              <p className="mt-3 text-xs text-ink-3">
                Benchmarked against {a.benchmark.name ?? "the approved underwriting"}
                {a.benchmark.version ? ` v${a.benchmark.version}` : ""}.
              </p>
            )}
            {a.capital_structure.loans.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {a.capital_structure.loans.map((l) => (
                  <Link key={l.id} href={l.href}>
                    <Badge tone="outline">{l.lender_name}</Badge>
                  </Link>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/** Property detail tab: the asset record for an owned property, with its KPIs, milestones and watchlist. */
export function PropertyAssetsTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useAssetByProperty(propertyId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-60" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {KPI_KEYS.map((k) => (
            <Skeleton key={k} className="h-[92px] rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <EmptyState icon={<Briefcase />} title="Asset data unavailable" description={errorMessage(error)} />
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <EmptyState
          icon={<Briefcase />}
          title="Not an owned asset"
          description="An asset record is created when a closing completes, or manually for a property already owned."
          action={
            can("assets", "create") ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> Create asset record
              </Button>
            ) : undefined
          }
        />
        <AssetFormSheet open={creating} onOpenChange={setCreating} propertyId={propertyId} />
      </Card>
    );
  }

  return <AssetSummary asset={data} />;
}
