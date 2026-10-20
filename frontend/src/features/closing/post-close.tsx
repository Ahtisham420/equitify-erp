"use client";

import { CheckCircle2, Fingerprint } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { EmptyState, FieldGrid, FieldItem } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import {
  HANDOFF_LABELS,
  useClosingMutation,
  useHandoff,
  usePostCloseAudit,
  useSnapshot,
  type AuditMetric,
  type Closing,
  type HandoffItem,
  type HandoffPackage,
} from "./api";

/* ------------------------------------------------------------------ handoff */

export function HandoffPanel({ closing }: { closing: Closing }) {
  const { can } = useAuth();
  const done = closing.status === "completed";
  const { data: pkg, isLoading } = useHandoff(closing.id, done);
  const [sections, setSections] = useState<HandoffPackage["sections"]>({});
  const [recipient, setRecipient] = useState<string | null>(null);
  const save = useClosingMutation(closing.id, (body: unknown) => api.patch<HandoffPackage>(`/closings/${closing.id}/handoff`, body));
  const ack = useClosingMutation(closing.id, () => api.post<HandoffPackage>(`/closings/${closing.id}/handoff/acknowledge`));

  useEffect(() => {
    if (pkg) {
      setSections(pkg.sections);
      setRecipient(pkg.recipient_id);
    }
  }, [pkg]);

  if (!done) return <EmptyState title="Handoff package not generated yet" description="It is assembled automatically when the closing completes, carrying acquisition knowledge into operations." />;
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!pkg) return <EmptyState title="No handoff package" />;

  const locked = !!pkg.acknowledged_at;
  const editable = !locked && can("closing", "edit");
  const canAck = !locked && (can("closing", "edit") || can("assets", "edit"));
  const setItem = (key: string, i: number, patch: Partial<HandoffItem>) =>
    setSections((s) => ({ ...s, [key]: { ...s[key], items: s[key].items.map((it, j) => (j === i ? { ...it, ...patch } : it)) } }));
  const cf = pkg.carry_forward as Record<string, unknown>;
  const capital = (cf.capital_structure ?? {}) as { equity?: number; debt?: number; ltv_pct?: number | null };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Operations handoff"
          description={locked ? `Acknowledged ${formatDateTime(pkg.acknowledged_at)}` : "Review, complete and hand over to the asset manager."}
          actions={
            <>
              {editable && (
                <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ sections, recipient_id: recipient }, { onSuccess: () => toast.success("Handoff package saved"), onError: (e) => toast.error(errorMessage(e)) })}>
                  Save
                </Button>
              )}
              {canAck && (
                <Button size="sm" variant="primary" loading={ack.isPending} onClick={() => ack.mutate(undefined, { onSuccess: () => toast.success("Handoff acknowledged by operations"), onError: (e) => toast.error(errorMessage(e)) })}>
                  <CheckCircle2 /> Acknowledge receipt
                </Button>
              )}
            </>
          }
        />
        <CardBody>
          <FieldGrid cols={3}>
            <FieldItem label="Asset">{pkg.asset_id ? <Link href={`/assets/${pkg.asset_id}`} className="text-accent hover:underline">Open asset</Link> : "Pending"}</FieldItem>
            <FieldItem label="Basis">{formatCurrency(cf.basis as number | null)}</FieldItem>
            <FieldItem label="Closed on">{formatDate(cf.closed_on as string | null)}</FieldItem>
            <FieldItem label="Equity / debt">{`${formatCurrency(capital.equity ?? null, { compact: true })} / ${formatCurrency(capital.debt ?? null, { compact: true })}`}</FieldItem>
            <FieldItem label="LTV">{formatPercent(capital.ltv_pct ?? null, 1)}</FieldItem>
            <FieldItem label="Approved underwriting">{cf.uw_model_id ? <Link href={`/underwriting/${String(cf.uw_model_id)}`} className="text-accent hover:underline">Open model</Link> : null}</FieldItem>
            <FieldItem label="Hold thesis" className="col-span-2 lg:col-span-3">{(cf.hold_thesis as string) || null}</FieldItem>
          </FieldGrid>
          <div className="mt-4 max-w-sm">
            <Field label="Recipient (asset manager)">
              {editable ? <UserPicker value={recipient} onChange={setRecipient} /> : <p className="text-sm text-ink-2">{recipient ? "Assigned" : "—"}</p>}
            </Field>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {Object.entries(HANDOFF_LABELS).map(([key, label]) => {
          const sec = sections[key] ?? { items: [], notes: null };
          return (
            <Card key={key}>
              <CardHeader
                title={label}
                actions={<Badge tone={sec.items.length && sec.items.every((i) => i.status !== "pending") ? "green" : "outline"}>{sec.items.filter((i) => i.status !== "pending").length}/{sec.items.length}</Badge>}
              />
              <CardBody className="space-y-2">
                {sec.items.length === 0 && <p className="text-xs text-ink-3">{key === "open_dd_items" ? "No open DD items carried forward." : "Nothing recorded."}</p>}
                {sec.items.map((it, i) => (
                  <div key={i} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-ink">{it.label}</p>
                      {it.detail && <p className="truncate text-xs text-ink-3">{it.detail}</p>}
                    </div>
                    {editable && key !== "open_dd_items" ? (
                      <Select
                        className="w-36 shrink-0"
                        value={it.status}
                        onChange={(e) => setItem(key, i, { status: e.target.value as HandoffItem["status"] })}
                        options={["pending", "delivered", "not_applicable"].map((s) => ({ value: s, label: titleCase(s) }))}
                      />
                    ) : (
                      <Badge tone={it.status === "delivered" ? "green" : it.status === "pending" ? "amber" : "neutral"}>{titleCase(it.status)}</Badge>
                    )}
                  </div>
                ))}
                {key === "open_dd_items" && sec.items.length > 0 && (
                  <p className="border-t border-line pt-2 text-xs text-ink-3">Each open item became a task on the asset so it survives into operations.</p>
                )}
                {editable ? (
                  <Textarea rows={2} placeholder="Notes" value={sec.notes ?? ""} onChange={(e) => setSections((s) => ({ ...s, [key]: { ...sec, notes: e.target.value } }))} />
                ) : sec.notes ? (
                  <p className="text-xs text-ink-2">{sec.notes}</p>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ snapshot */

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-[420px] overflow-auto rounded-md bg-subtle p-3 font-mono text-xs leading-relaxed text-ink-2 scrollbar-thin">{JSON.stringify(value, null, 2)}</pre>;
}

export function SnapshotView({ closing }: { closing: Closing }) {
  const { data, isLoading, error } = useSnapshot(closing.id, closing.has_snapshot);
  const [section, setSection] = useState("closing");
  if (!closing.has_snapshot) return <EmptyState icon={<Fingerprint />} title="No snapshot yet" description="An immutable copy of the final transaction is written when the closing completes." />;
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) return <EmptyState title="Snapshot unavailable" description={errorMessage(error)} />;
  const keys = Object.keys(data.data);
  return (
    <Card>
      <CardHeader
        title="Final transaction snapshot"
        description={`Written ${formatDateTime(data.created_at)} by ${data.created_by_name ?? "—"}. Immutable: there is no edit path.`}
        actions={<Select className="w-48" value={section} onChange={(e) => setSection(e.target.value)} options={keys.map((k) => ({ value: k, label: titleCase(k) }))} />}
      />
      <CardBody className="space-y-3">
        <p className="flex items-center gap-1.5 text-xs text-ink-3"><Fingerprint className="size-3.5" /> SHA-256 <span className="font-mono text-ink-2">{data.sha256}</span></p>
        <JsonBlock value={data.data[section]} />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ 90-day audit */

function fmtMetric(m: AuditMetric, v: number | null): string {
  if (v === null || v === undefined) return "—";
  if (m.unit === "currency") return formatCurrency(v);
  if (m.unit === "percent") return v <= 1 && v >= -1 ? formatPercent(v * 100, 2) : formatPercent(v, 2);
  return formatNumber(v, 2);
}

export function PostCloseAuditPanel({ closing }: { closing: Closing }) {
  const { can } = useAuth();
  const done = closing.status === "completed";
  const { data, isLoading } = usePostCloseAudit(closing.id, done);
  const [findings, setFindings] = useState("");
  const [lessons, setLessons] = useState("");
  const complete = useClosingMutation(closing.id, (body: unknown) => api.post<Closing>(`/closings/${closing.id}/post-close-audit/complete`, body));
  if (!done) return <EmptyState title="Post-close audit starts after closing" description="A review task is scheduled 90 days after the closing date." />;
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;
  const completed = data.completed as { findings?: string; lessons_for_acquisitions?: string; completed_by?: string; completed_at?: string } | null;
  const canComplete = !completed && (can("closing", "edit") || can("assets", "edit"));

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Actual vs acquisition assumptions"
          description={`Due ${formatDate(data.due_on)} · ${data.months_of_data} month${data.months_of_data === 1 ? "" : "s"} of actuals${data.period_start ? ` (${formatDate(data.period_start, "MMM yyyy")} – ${formatDate(data.period_end, "MMM yyyy")})` : ""}`}
        />
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-subtle text-left text-xs text-ink-3">
              <th className="px-4 py-2 font-medium">Metric</th>
              <th className="px-4 py-2 text-right font-medium">Underwritten</th>
              <th className="px-4 py-2 text-right font-medium">Actual</th>
              <th className="px-4 py-2 text-right font-medium">Variance</th>
            </tr>
          </thead>
          <tbody>
            {data.metrics.map((m) => (
              <tr key={m.key} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-ink-2">{m.label}</td>
                <td className="px-4 py-2 text-right tabular">{fmtMetric(m, m.assumed)}</td>
                <td className="px-4 py-2 text-right tabular">{fmtMetric(m, m.actual)}</td>
                <td className={cn("px-4 py-2 text-right tabular", m.variance_pct != null && m.variance_pct < -5 ? "text-negative" : m.variance_pct != null && m.variance_pct > 5 ? "text-positive" : "text-ink-2")}>
                  {m.variance_pct != null ? `${m.variance_pct > 0 ? "+" : ""}${formatNumber(m.variance_pct, 1)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.notes.length > 0 && (
          <ul className="space-y-0.5 border-t border-line px-4 py-2.5 text-xs text-ink-3">
            {data.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Findings for acquisitions" description="Recorded variances feed back to the acquisition team that underwrote the deal." />
        <CardBody className="space-y-3">
          {completed ? (
            <FieldGrid cols={1}>
              <FieldItem label="Findings"><span className="whitespace-pre-wrap">{completed.findings}</span></FieldItem>
              <FieldItem label="Lessons for acquisitions"><span className="whitespace-pre-wrap">{completed.lessons_for_acquisitions ?? "—"}</span></FieldItem>
              <FieldItem label="Recorded">{`${completed.completed_by ?? "—"} · ${formatDateTime(completed.completed_at)}`}</FieldItem>
            </FieldGrid>
          ) : canComplete ? (
            <>
              <Field label="Findings" required><Textarea rows={3} value={findings} onChange={(e) => setFindings(e.target.value)} /></Field>
              <Field label="Lessons for acquisitions"><Textarea rows={3} value={lessons} onChange={(e) => setLessons(e.target.value)} /></Field>
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  disabled={!findings.trim()}
                  loading={complete.isPending}
                  onClick={() =>
                    complete.mutate(
                      { findings, lessons_for_acquisitions: lessons || null },
                      { onSuccess: () => toast.success("Post-close audit recorded and sent to acquisitions"), onError: (e) => toast.error(errorMessage(e)) },
                    )
                  }
                >
                  Record audit
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-3">Not recorded yet.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
