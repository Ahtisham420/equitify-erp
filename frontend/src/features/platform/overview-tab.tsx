"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

import { StatCard } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { cn, formatDateTime, formatNumber, formatRelative } from "@/lib/utils";

import { useApiCatalog, useEnvironment, useHealth, type HealthCheck } from "./api";

const ENV_TONE = { production: "red", staging: "amber", development: "blue" } as const;

function CheckIcon({ status }: { status: HealthCheck["status"] }) {
  if (status === "ok") return <CheckCircle2 className="size-4 text-positive" />;
  if (status === "warning") return <AlertTriangle className="size-4 text-caution" />;
  return <XCircle className="size-4 text-negative" />;
}

export function OverviewTab() {
  const health = useHealth();
  const env = useEnvironment();
  const apiCatalog = useApiCatalog();
  const h = health.data;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Database latency" value={h ? (h.db_latency_ms === null ? "Down" : `${formatNumber(h.db_latency_ms, 1)} ms`) : "—"} tone={h && h.db_latency_ms === null ? "negative" : "default"} />
        <StatCard label="Job failures (24h)" value={h ? formatNumber(h.job_failures_24h) : "—"} tone={h && h.job_failures_24h > 0 ? "caution" : "default"} href="/admin/platform?tab=jobs&status=failed" />
        <StatCard label="Webhook dead letters" value={h ? formatNumber(h.webhook_dead_letters) : "—"} hint={h ? `${formatNumber(h.webhook_pending)} pending` : undefined} tone={h && h.webhook_dead_letters > 0 ? "caution" : "default"} href="/admin/platform?tab=webhooks&status=dead" />
        <StatCard label="AI provider" value={h ? (h.ai.available ? "Active" : "Manual mode") : "—"} hint={h?.ai.available ? h.ai.model : "Core workflows run without AI"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="System health"
            description={h ? `Checked ${formatRelative(h.checked_at)}` : undefined}
            actions={h ? <Badge tone={h.status === "ok" ? "green" : h.status === "warning" ? "amber" : "red"} dot>{h.status === "ok" ? "Healthy" : h.status === "warning" ? "Needs attention" : "Degraded"}</Badge> : undefined}
          />
          <div className="divide-y divide-line">
            {health.isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="px-4 py-3"><Skeleton className="h-4 w-2/3" /></div>
                ))
              : h?.checks.map((c) => (
                  <div key={c.key} className="flex items-center gap-3 px-4 py-2.5">
                    <CheckIcon status={c.status} />
                    <span className="w-44 shrink-0 text-sm font-medium text-ink">{c.label}</span>
                    <span className={cn("min-w-0 truncate text-sm", c.status === "ok" ? "text-ink-2" : c.status === "warning" ? "text-caution" : "text-negative")}>{c.detail}</span>
                  </div>
                ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Environment" />
          <CardBody className="space-y-3 text-sm">
            {env.data ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-ink-3">Environment</span>
                  <Badge tone={ENV_TONE[env.data.environment as keyof typeof ENV_TONE] ?? "neutral"}>{env.data.environment}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-3">API</span>
                  <span className="font-mono text-xs text-ink">{env.data.api_prefix}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-3">Encryption key</span>
                  <Badge tone={env.data.encryption_key_configured ? "green" : "amber"}>{env.data.encryption_key_configured ? "Dedicated" : "Development fallback"}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-3">MFA enforced</span>
                  <span className="text-ink">{env.data.mfa_enforced ? "Yes" : "No"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-3">Last backup</span>
                  <span className="text-ink">{h?.last_backup_at ? formatDateTime(h.last_backup_at) : "—"}</span>
                </div>
                <ul className="mt-2 space-y-1.5 border-t border-line pt-3 text-xs text-ink-2">
                  {env.data.data_rules.map((r) => (
                    <li key={r} className="flex gap-2">
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-3" />
                      {r}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Versioned API and service scopes"
          description={apiCatalog.data ? `All endpoints are served under ${apiCatalog.data.prefix} (${apiCatalog.data.version}). Service credentials are granted module:action scopes from this list.` : undefined}
        />
        <CardBody>
          {apiCatalog.data ? (
            <div className="space-y-3">
              <p className="text-xs text-ink-3">{apiCatalog.data.auth.join(" · ")}</p>
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                {apiCatalog.data.modules.map((m) => (
                  <div key={m.module} className="min-w-0">
                    <p className="text-sm font-medium text-ink">{m.label}</p>
                    <p className="truncate font-mono text-2xs text-ink-3" title={m.scopes.join(", ")}>
                      {m.module}:{"{"}
                      {apiCatalog.data?.actions.join(",")}
                      {"}"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
