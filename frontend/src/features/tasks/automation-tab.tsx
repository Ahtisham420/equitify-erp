"use client";

import { Play, Settings2, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Skeleton, Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime, formatNumber, formatPercent, formatRelative } from "@/lib/utils";

import { useAlertNoise, useRules, useRunEscalations, useUpdateRule, type AutomationRule, type EscalationResult } from "./api";

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-ink bg-ink" : "border-line-strong bg-muted",
      )}
    >
      <span className={cn("inline-block size-3.5 rounded-full bg-white shadow-card transition-transform", checked ? "translate-x-[18px]" : "translate-x-[2px]")} />
    </button>
  );
}

function ThresholdsDialog({ rule, onClose }: { rule: AutomationRule | null; onClose: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateRule();
  useEffect(() => {
    if (rule) {
      setText(JSON.stringify(rule.thresholds ?? {}, null, 2));
      setError(null);
    }
  }, [rule]);

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text || "{}");
    } catch {
      setError("Thresholds must be valid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("Thresholds must be a JSON object");
      return;
    }
    update.mutate(
      { key: rule!.key, thresholds: parsed as Record<string, unknown> },
      {
        onSuccess: () => {
          toast.success("Thresholds saved");
          onClose();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={!!rule}
      onOpenChange={(o) => !o && onClose()}
      title={`Thresholds · ${rule?.name ?? ""}`}
      description={rule?.description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} onClick={save}>
            Save thresholds
          </Button>
        </>
      }
    >
      <Field label="Configuration" error={error} hint="Values are merged over the rule defaults. Changes are audited.">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className="font-mono text-xs" spellCheck={false} />
      </Field>
    </Dialog>
  );
}

function EscalationPanel() {
  const run = useRunEscalations();
  const [result, setResult] = useState<EscalationResult | null>(null);
  const exec = (dry: boolean) =>
    run.mutate(dry, {
      onSuccess: (r) => {
        setResult(r);
        if (r.skipped) toast.message("Escalation rule is disabled");
        else if (!r.dry_run) toast.success(`Escalated ${r.tasks_escalated} tasks and ${r.alerts_escalated} alerts`);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  return (
    <Card>
      <CardHeader
        title="Overdue escalation"
        description="Raises priority/severity after the configured intervals and notifies the owner's manager. Safe to re-run."
        actions={
          <>
            <Button size="sm" loading={run.isPending && run.variables === true} onClick={() => exec(true)}>
              Preview
            </Button>
            <Button size="sm" variant="primary" loading={run.isPending && run.variables === false} onClick={() => exec(false)}>
              <Play /> Run now
            </Button>
          </>
        }
      />
      {result && (
        <CardBody className="space-y-2 text-sm">
          <p className="text-ink-2">
            {result.skipped
              ? "Skipped — the rule is disabled."
              : `${result.dry_run ? "Would escalate" : "Escalated"} ${result.tasks_escalated} task(s) and ${result.alerts_escalated} alert(s)${result.dry_run ? "" : `; ${result.managers_notified} manager notification(s)`}.`}
          </p>
          {result.items.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto scrollbar-thin">
              {result.items.map((i) => (
                <li key={`${i.kind}-${i.id}`} className="flex items-center gap-2 text-xs">
                  <Badge tone="outline">{i.kind}</Badge>
                  <span className="min-w-0 flex-1 truncate text-ink">{i.title}</span>
                  <span className="text-ink-3">
                    {i.priority ? `${i.priority.from} → ${i.priority.to}` : i.severity ? `${i.severity.from} → ${i.severity.to}` : ""} · level {i.level}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      )}
    </Card>
  );
}

export function AutomationTab() {
  const { user } = useAuth();
  const isAdmin = !!user?.permissions["*"]?.includes("*");
  const { data: rules, isLoading } = useRules();
  const { data: noise } = useAlertNoise();
  const update = useUpdateRule();
  const [editing, setEditing] = useState<AutomationRule | null>(null);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Automation rules"
          description="Every automation is individually configurable and can be disabled. Run and error counts make jobs observable."
        />
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !rules?.length ? (
          <EmptyState icon={<Workflow />} title="No automation rules" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-subtle text-left text-xs text-ink-3">
                  <th className="px-4 py-2 font-medium">Enabled</th>
                  <th className="px-3 py-2 font-medium">Rule</th>
                  <th className="px-3 py-2 font-medium">Trigger</th>
                  <th className="px-3 py-2 text-right font-medium">Runs</th>
                  <th className="px-3 py-2 text-right font-medium">Errors</th>
                  <th className="px-3 py-2 font-medium">Last run</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.key} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <Toggle
                        checked={r.enabled}
                        disabled={!isAdmin || update.isPending}
                        label={`Enable ${r.name}`}
                        onChange={(enabled) =>
                          update.mutate(
                            { key: r.key, enabled },
                            { onSuccess: () => toast.success(`${r.name} ${enabled ? "enabled" : "disabled"}`), onError: (e) => toast.error(errorMessage(e)) },
                          )
                        }
                      />
                    </td>
                    <td className="max-w-[420px] px-3 py-2.5">
                      <p className="font-medium text-ink">{r.name}</p>
                      <p className="text-xs text-ink-3">{r.description}</p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-3">{r.key}</p>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-2xs text-ink-2">{r.event ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular">{formatNumber(r.run_count)}</td>
                    <td className="px-3 py-2.5 text-right tabular">
                      {r.error_count > 0 ? (
                        <Tooltip content={r.last_error}>
                          <span className="font-medium text-negative">{formatNumber(r.error_count)}</span>
                        </Tooltip>
                      ) : (
                        <span className="text-ink-3">0</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-ink-3" title={formatDateTime(r.last_run_at)}>
                      {r.last_run_at ? formatRelative(r.last_run_at) : "Never"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button size="xs" variant="ghost" onClick={() => setEditing(r)} disabled={!isAdmin}>
                        <Settings2 /> Thresholds
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isAdmin && <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Only administrators can change automations.</p>}
      </Card>

      {isAdmin && <EscalationPanel />}

      <Card>
        <CardHeader title="Alert noise (last 90 days)" description="Alert fatigue is a product-quality issue: rules with high dismissal rates need tuning." />
        {!noise?.length ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">No alerts in this period.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-subtle text-left text-xs text-ink-3">
                <th className="px-4 py-2 font-medium">Rule</th>
                <th className="px-3 py-2 text-right font-medium">Raised</th>
                <th className="px-3 py-2 text-right font-medium">Open</th>
                <th className="px-3 py-2 text-right font-medium">Actioned</th>
                <th className="px-3 py-2 text-right font-medium">Dismissed</th>
                <th className="px-3 py-2 text-right font-medium">Dismiss rate</th>
                <th className="px-3 py-2 text-right font-medium">Avg. hours to resolve</th>
              </tr>
            </thead>
            <tbody>
              {noise.map((n) => (
                <tr key={n.rule_key} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 font-mono text-xs">{n.rule_key}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(n.total)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(n.open)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(n.actioned)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(n.dismissed)}</td>
                  <td className={cn("px-3 py-2 text-right tabular", n.dismiss_rate >= 0.5 ? "font-medium text-negative" : n.dismiss_rate >= 0.25 ? "text-caution" : "")}>
                    {formatPercent(n.dismiss_rate * 100, 0)}
                  </td>
                  <td className="px-3 py-2 text-right tabular">{n.avg_hours_to_resolve != null ? formatNumber(n.avg_hours_to_resolve, 1) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ThresholdsDialog rule={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
