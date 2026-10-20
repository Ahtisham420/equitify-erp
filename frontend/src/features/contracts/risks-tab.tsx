"use client";

import { Gavel, Plus, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Avatar, Checkbox, Skeleton } from "@/components/ui/misc";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatRelative, titleCase, toNumber } from "@/lib/utils";

import {
  DECISION_KIND_LABELS,
  DECISION_KINDS,
  RISK_CATEGORIES,
  RISK_DECISIONS,
  RISK_STATUSES,
  SEVERITIES,
  useContractDates,
  useDecideRisk,
  useDecisions,
  useRecordDecision,
  useRisks,
  useSaveRisk,
  type Contract,
  type Risk,
} from "./api";

function RiskSheet({ open, onOpenChange, contractId, risk }: { open: boolean; onOpenChange: (o: boolean) => void; contractId: string; risk: Risk | null }) {
  const save = useSaveRisk(contractId);
  const [v, setV] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!open) return;
    setV(risk ? { ...risk } : { title: "", category: "other", severity: "medium", decision_required: null });
  }, [open, risk]);

  const set = (k: string, value: unknown) => setV((s) => ({ ...s, [k]: value }));
  const str = (k: string) => (v[k] === null || v[k] === undefined ? "" : String(v[k]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = {
      title: str("title").trim(), description: str("description").trim() || null, category: v.category, severity: v.severity,
      owner_id: v.owner_id ?? null, cost_impact: toNumber(str("cost_impact")), mitigation: str("mitigation").trim() || null,
      decision_due_on: v.decision_due_on || null,
    };
    if (v.decision_required !== null && v.decision_required !== undefined) data.decision_required = v.decision_required;
    if (risk) data.status = v.status;
    save.mutate(
      { id: risk?.id, data },
      {
        onSuccess: () => {
          toast.success(risk ? "Risk updated" : "Risk added");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const highSeverity = v.severity === "high" || v.severity === "critical";
  const required = v.decision_required === null || v.decision_required === undefined ? highSeverity : !!v.decision_required;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={risk ? "Edit risk" : "New risk"}
      description="High-severity risks need a recorded decision before the feasibility deadline."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="risk-form" loading={save.isPending} disabled={!str("title").trim()}>
            Save
          </Button>
        </>
      }
    >
      <form id="risk-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Risk" required className="col-span-2">
          <Input value={str("title")} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Category">
          <Select value={str("category")} onChange={(e) => set("category", e.target.value)} options={RISK_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
        </Field>
        <Field label="Severity">
          <Select value={str("severity")} onChange={(e) => set("severity", e.target.value)} options={SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        {risk && (
          <Field label="Status">
            <Select value={str("status")} onChange={(e) => set("status", e.target.value)} options={RISK_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
        )}
        <Field label="Owner">
          <UserPicker value={v.owner_id as string | null} onChange={(id) => set("owner_id", id)} />
        </Field>
        <Field label="Cost impact">
          <Input inputMode="decimal" value={str("cost_impact")} onChange={(e) => set("cost_impact", e.target.value)} />
        </Field>
        <Field label="Decide by" hint="Defaults to the feasibility deadline">
          <Input type="date" value={str("decision_due_on")} onChange={(e) => set("decision_due_on", e.target.value)} />
        </Field>
        <Field label="Decision" className="col-span-2">
          <label className="flex h-8 items-center gap-2 text-sm">
            <Checkbox checked={required} onChange={(c) => set("decision_required", c)} label="Decision required" /> A recorded decision is required before feasibility
          </label>
        </Field>
        <Field label="Description" className="col-span-2">
          <Textarea value={str("description")} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <Field label="Mitigation" className="col-span-2">
          <Textarea value={str("mitigation")} onChange={(e) => set("mitigation", e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}

function DecisionDialog({ open, onOpenChange, contract }: { open: boolean; onOpenChange: (o: boolean) => void; contract: Contract }) {
  const record = useRecordDecision(contract.id);
  const { data: dates } = useContractDates(contract.id);
  const [kind, setKind] = useState("extend");
  const [reasoning, setReasoning] = useState("");
  const [dateId, setDateId] = useState("");
  const [newDue, setNewDue] = useState("");
  const [pending, setPending] = useState<{ title: string; severity: string }[]>([]);

  const openDates = useMemo(() => (dates ?? []).filter((d) => ["proposed", "confirmed", "missed"].includes(d.status)), [dates]);

  useEffect(() => {
    if (open) {
      setKind("extend");
      setReasoning("");
      setNewDue("");
      setPending([]);
      setDateId(openDates.find((d) => d.key === "closing")?.id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const needsDate = kind === "extend" || kind === "waive_contingency";
  const submit = () =>
    record.mutate(
      { kind, reasoning: reasoning.trim(), critical_date_id: dateId || null, new_due_on: kind === "extend" ? newDue || null : null },
      {
        onSuccess: () => {
          toast.success("Decision recorded");
          onOpenChange(false);
        },
        onError: (e) => {
          const detail = e instanceof ApiError ? (e.detail as { risks?: { title: string; severity: string }[] } | null) : null;
          if (detail?.risks) setPending(detail.risks);
          toast.error(errorMessage(e));
        },
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record a decision"
      description="Decisions are permanent and kept with the reasoning given. Extensions reschedule the selected deadline; termination waives open deadlines."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={kind === "terminate" ? "danger" : "primary"}
            loading={record.isPending}
            disabled={!reasoning.trim() || (kind === "extend" && (!newDue || !dateId)) || (kind === "waive_contingency" && !dateId)}
            onClick={submit}
          >
            Record decision
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Decision" className="col-span-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value)} options={DECISION_KINDS.map((k) => ({ value: k, label: DECISION_KIND_LABELS[k] }))} />
        </Field>
        {(needsDate || kind === "proceed") && (
          <Field label={kind === "proceed" ? "Deadline being passed" : "Deadline"} className={kind === "extend" ? "" : "col-span-2"}>
            <Select
              value={dateId}
              onChange={(e) => setDateId(e.target.value)}
              placeholder={kind === "proceed" ? "Feasibility (default)" : "Select a date"}
              options={openDates.map((d) => ({ value: d.id, label: `${d.label} · ${formatDate(d.due_on)}` }))}
            />
          </Field>
        )}
        {kind === "extend" && (
          <Field label="New date" required>
            <Input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} />
          </Field>
        )}
        <Field label="Reasoning" required className="col-span-2">
          <Textarea rows={4} value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
        </Field>
        {pending.length > 0 && (
          <div className="col-span-2 rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-sm">
            <p className="font-medium text-negative">Decisions still required</p>
            <ul className="mt-1 list-disc pl-5 text-xs text-ink-2">
              {pending.map((r) => (
                <li key={r.title}>
                  {r.title} ({r.severity})
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function RisksTab({ contract, feasibilityOn }: { contract: Contract; feasibilityOn: string | null }) {
  const { can } = useAuth();
  const { data: risks, isLoading } = useRisks(contract.id);
  const { data: decisions, isLoading: decisionsLoading } = useDecisions(contract.id);
  const decide = useDecideRisk();
  const [editing, setEditing] = useState<Risk | null>(null);
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<Risk | null>(null);
  const [decision, setDecision] = useState("proceed");
  const [reason, setReason] = useState("");
  const [recording, setRecording] = useState(false);
  const editable = can("contracts", "edit");
  const approver = can("contracts", "approve");
  const rows = risks ?? [];
  const needs = rows.filter((r) => r.needs_decision);

  return (
    <div className="space-y-5">
      {needs.length > 0 && (
        <div className="rounded-lg border border-negative/30 bg-negative-soft px-4 py-3 text-sm">
          <p className="font-medium text-negative">
            {needs.length} high-severity risk{needs.length === 1 ? "" : "s"} without a decision
            {feasibilityOn ? ` — feasibility expires ${formatDate(feasibilityOn)}` : ""}
          </p>
          <p className="mt-0.5 text-ink-2">Proceeding past feasibility is blocked until each has a recorded decision.</p>
        </div>
      )}

      <Card>
        <CardHeader
          title="Risk register"
          description="Severity, owner, cost impact and the decision taken."
          actions={
            editable && (
              <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
                <Plus /> Add risk
              </Button>
            )
          }
        />
        {isLoading ? (
          <Skeleton className="m-4 h-24" />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ShieldAlert />} title="No risks recorded" description="Add risks here or promote findings from the DD checklist." />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className={cn("grid grid-cols-1 gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_220px_auto] md:items-start", r.needs_decision && "bg-negative-soft/30", r.status === "closed" && "opacity-70")}>
                <div className="min-w-0">
                  <button type="button" className="text-left text-sm font-medium text-ink hover:underline" onClick={() => editable && setEditing(r)}>
                    {r.title}
                  </button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                    <StatusBadge status={r.severity} />
                    <Badge tone="outline">{titleCase(r.category)}</Badge>
                    <span>{titleCase(r.status)}</span>
                    {r.cost_impact != null && <span className="tabular">· {formatCurrency(r.cost_impact)}</span>}
                    {r.source_type && <span>· from {titleCase(r.source_type)}</span>}
                  </div>
                  {r.description && <p className="mt-1 line-clamp-2 text-xs text-ink-2">{r.description}</p>}
                  {r.mitigation && <p className="mt-0.5 text-xs text-ink-2">Mitigation: {r.mitigation}</p>}
                </div>
                <div className="text-xs">
                  {r.decision ? (
                    <>
                      <p className="font-medium text-ink">Decision: {titleCase(r.decision)}</p>
                      <p className="text-ink-3">
                        {r.decided_by_name ?? "—"} · {formatRelative(r.decided_at)}
                      </p>
                      {r.decision_reason && <p className="mt-0.5 line-clamp-3 text-ink-2">{r.decision_reason}</p>}
                    </>
                  ) : r.decision_required ? (
                    <p className={cn(r.needs_decision ? "font-medium text-negative" : "text-ink-2")}>Decision required{r.decision_due_on ? ` by ${formatDate(r.decision_due_on)}` : ""}</p>
                  ) : (
                    <p className="text-ink-3">No decision required</p>
                  )}
                  {r.owner_name && (
                    <p className="mt-1 flex items-center gap-1 text-ink-3">
                      <Avatar name={r.owner_name} size={16} /> {r.owner_name}
                    </p>
                  )}
                </div>
                {approver && r.status !== "closed" ? (
                  <Button
                    size="xs"
                    variant={r.needs_decision ? "primary" : "secondary"}
                    onClick={() => {
                      setDecision(r.decision ?? "proceed");
                      setReason("");
                      setDeciding(r);
                    }}
                  >
                    <Gavel /> {r.decision ? "Revise decision" : "Decide"}
                  </Button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Extension and termination decisions"
          description="Immutable history with the reasoning recorded at the time."
          actions={
            approver &&
            contract.status === "executed" && (
              <Button size="sm" variant="ghost" onClick={() => setRecording(true)}>
                <Gavel /> Record decision
              </Button>
            )
          }
        />
        {decisionsLoading ? (
          <Skeleton className="m-4 h-16" />
        ) : !decisions?.length ? (
          <EmptyState icon={<Gavel />} title="No decisions yet" description="Extensions, terminations and go-hard decisions are recorded here." />
        ) : (
          <ol className="divide-y divide-line">
            {decisions.map((d) => (
              <li key={d.id} className="px-4 py-3 text-sm">
                <p className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={d.kind === "terminate" ? "red" : d.kind === "proceed" ? "green" : "blue"}>{DECISION_KIND_LABELS[d.kind] ?? titleCase(d.kind)}</Badge>
                  {typeof d.data.target_label === "string" && <span className="text-ink-2">{d.data.target_label}</span>}
                  {d.new_due_on && (
                    <span className="text-xs text-ink-2 tabular">
                      {formatDate(d.previous_due_on)} → {formatDate(d.new_due_on)}
                    </span>
                  )}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-ink">{d.reasoning}</p>
                <p className="mt-1 text-xs text-ink-3" title={formatDateTime(d.decided_at)}>
                  {d.decided_by_name ?? "—"} · {formatDateTime(d.decided_at)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <RiskSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} contractId={contract.id} risk={editing} />
      <DecisionDialog open={recording} onOpenChange={setRecording} contract={contract} />

      <Dialog
        open={!!deciding}
        onOpenChange={(o) => !o && setDeciding(null)}
        title="Decide on risk"
        description={deciding ? `${deciding.title} — the decision and reasoning are kept in the audit trail.` : undefined}
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!reason.trim()}
              loading={decide.isPending}
              onClick={() =>
                deciding &&
                decide.mutate(
                  { id: deciding.id, decision, reason: reason.trim() },
                  { onSuccess: () => { toast.success("Decision recorded"); setDeciding(null); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              Record decision
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Decision">
            <Select value={decision} onChange={(e) => setDecision(e.target.value)} options={RISK_DECISIONS.map((d) => ({ value: d, label: titleCase(d) }))} />
          </Field>
          <Field label="Reasoning" required>
            <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
