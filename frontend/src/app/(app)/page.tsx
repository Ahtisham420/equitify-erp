"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { EmptyState, PageHeader, StatCard } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, titleCase } from "@/lib/utils";

interface Metric { label: string; value: number; href: string | null; hint: string | null; tone: "negative" | "caution" | "positive" | null }
interface Bucket { key: string; label: string; value: number; href: string | null }
interface Overview {
  generated_at: string;
  headline: Metric[];
  pipeline_by_stage: Bucket[];
  properties_by_status: Bucket[];
  interactions_by_day: Bucket[];
  buybox_results: Bucket[];
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Horizontal magnitude bars; every row drills to its records. */
function BarList({ buckets, status }: { buckets: Bucket[]; status?: boolean }) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  if (buckets.every((b) => b.value === 0)) return <p className="py-6 text-center text-sm text-ink-3">No records yet</p>;
  return (
    <ul className="space-y-1">
      {buckets.map((b) => (
        <li key={b.key}>
          <Link href={b.href ?? "#"} className="group grid grid-cols-[140px_1fr_48px] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-subtle">
            <span className="truncate text-sm text-ink-2 group-hover:text-ink">{status ? <StatusBadge status={b.key} /> : titleCase(b.label)}</span>
            <span className="h-2 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-accent transition-all" style={{ width: `${(b.value / max) * 100}%` }} />
            </span>
            <span className="text-right text-sm font-medium tabular">{formatNumber(b.value)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ActivityChart({ data }: { data: Bucket[] }) {
  if (data.every((d) => d.value === 0)) return <p className="py-10 text-center text-sm text-ink-3">No interactions logged in the last 14 days</p>;
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -24 }} barCategoryGap={4}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} interval={1} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} />
          <ChartTooltip
            cursor={{ fill: "rgb(var(--muted))" }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                  <p className="text-ink-3">{(payload[0].payload as Bucket).label}</p>
                  <p className="font-medium text-ink tabular">{formatNumber(payload[0].value as number)} interactions</p>
                </div>
              ) : null
            }
          />
          <Bar dataKey="value" fill="rgb(var(--accent))" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function DashboardPage() {
  const { user, can } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "overview"],
    queryFn: () => api.get<Overview>("/dashboard/overview"),
    enabled: can("dashboard"),
    refetchInterval: 120_000,
  });

  if (!can("dashboard")) {
    return <EmptyState title="No dashboard access" description="Ask an administrator for dashboard permission." />;
  }

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${user?.full_name.split(" ")[0] ?? ""}`}
        description={data ? `Command center · updated ${formatDateTime(data.generated_at)}` : "Command center"}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
        {isLoading
          ? Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)
          : data?.headline.map((m) => (
              <StatCard
                key={m.label}
                label={m.label}
                value={m.label.includes("completeness") ? `${formatNumber(m.value, 1)}%` : formatNumber(m.value)}
                hint={m.hint ?? undefined}
                href={m.href ?? undefined}
                tone={m.tone ?? "default"}
              />
            ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {data && data.pipeline_by_stage.length > 0 && (
          <Card className="lg:col-span-2">
            <CardHeader title="Pipeline by stage" description="Active opportunities — click a stage to open the list" actions={<Link href="/pipeline" className="text-xs font-medium text-accent hover:underline">Open pipeline</Link>} />
            <CardBody>
              <BarList buckets={data.pipeline_by_stage} />
            </CardBody>
          </Card>
        )}
        {data && data.properties_by_status.length > 0 && (
          <Card>
            <CardHeader title="Properties by status" />
            <CardBody>
              <BarList buckets={data.properties_by_status} status />
            </CardBody>
          </Card>
        )}
        {data && data.interactions_by_day.length > 0 && (
          <Card className="lg:col-span-2">
            <CardHeader title="Outreach activity" description="Interactions logged per day, last 14 days" />
            <CardBody>
              <ActivityChart data={data.interactions_by_day} />
            </CardBody>
          </Card>
        )}
        {data && data.buybox_results.length > 0 && (
          <Card>
            <CardHeader title="Buy Box fit" description="Properties by current evaluation result" />
            <CardBody>
              <BarList buckets={data.buybox_results} status />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
