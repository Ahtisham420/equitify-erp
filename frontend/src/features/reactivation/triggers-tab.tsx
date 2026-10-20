"use client";

import { Crosshair } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, Toolbar } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useListQuery } from "@/hooks/use-list-query";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatRelative, titleCase } from "@/lib/utils";

import { DEAD_REASON_LABELS, type ReactivationRule } from "@/features/pipeline/api";
import { ReactivationRuleBuilder } from "@/features/pipeline/stage-fields";

import { OPERATOR_LABELS, TRIGGER_STATUSES, useReactivationMeta, useTriggerAction, type Trigger } from "./api";

const STATUS_TONES: Record<string, Tone> = { armed: "blue", fired: "green", cancelled: "neutral" };

function EditTriggerDialog({ trigger, onOpenChange }: { trigger: Trigger | null; onOpenChange: (o: boolean) => void }) {
  const { data: meta } = useReactivationMeta();
  const run = useTriggerAction();
  const [rule, setRule] = useState<ReactivationRule | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [mode, setMode] = useState<"edit" | "cancel">("edit");

  useEffect(() => {
    if (trigger) {
      setRule({ type: trigger.trigger_type, params: { ...trigger.params } });
      setCancelReason("");
      setMode("edit");
    }
  }, [trigger]);

  const params = rule?.params ?? {};
  const setParam = (k: string, v: unknown) => setRule((r) => (r ? { ...r, params: { ...r.params, [k]: v } } : r));
  const types = (meta?.trigger_types ?? []).filter((t) => t.type === trigger?.trigger_type);
  const field = meta?.property_fields.find((f) => f.key === params.field);

  const save = () =>
    trigger &&
    rule &&
    run.mutate(
      { id: trigger.id, action: "update", params: rule.params },
      { onSuccess: () => { toast.success("Trigger updated"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
    );
  const cancel = () =>
    trigger &&
    run.mutate(
      { id: trigger.id, action: "cancel", reason: cancelReason.trim() },
      { onSuccess: () => { toast.success("Trigger cancelled"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <Dialog
      open={!!trigger}
      onOpenChange={onOpenChange}
      className="max-w-xl"
      title={mode === "edit" ? "Edit trigger" : "Cancel trigger"}
      description={trigger ? `${trigger.opportunity_title ?? "Opportunity"} · ${trigger.description ?? ""}` : undefined}
      footer={
        mode === "edit" ? (
          <>
            <Button variant="ghost" onClick={() => setMode("cancel")}>
              Cancel trigger…
            </Button>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
            <Button variant="primary" loading={run.isPending} onClick={save}>
              Save trigger
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setMode("edit")}>Back</Button>
            <Button variant="danger" disabled={cancelReason.trim().length < 3} loading={run.isPending} onClick={cancel}>
              Cancel trigger
            </Button>
          </>
        )
      }
    >
      {mode === "cancel" ? (
        <Field label="Reason" required hint="The opportunity stays dead and is no longer watched by this trigger.">
          <Textarea autoFocus value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        </Field>
      ) : (
        <div className="space-y-4">
          <ReactivationRuleBuilder value={rule} onChange={(r) => r && setRule({ ...r, type: trigger?.trigger_type ?? r.type })} types={types} />
          {trigger?.trigger_type === "manual" && meta && (
            <div className="space-y-2 rounded-md border border-line p-3">
              <p className="text-xs font-medium text-ink-2">Property field threshold (optional)</p>
              <div className="grid grid-cols-[1fr_110px_1fr] gap-2">
                <Select
                  value={String(params.field ?? "")}
                  onChange={(e) => setParam("field", e.target.value || null)}
                  placeholder="Choose a field"
                  options={meta.property_fields.map((f) => ({ value: f.key, label: titleCase(f.key) }))}
                />
                <Select
                  value={String(params.operator ?? "")}
                  onChange={(e) => setParam("operator", e.target.value || null)}
                  placeholder="Operator"
                  options={meta.field_operators.map((o) => ({ value: o, label: OPERATOR_LABELS[o] ?? o }))}
                />
                <Input
                  type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text"}
                  disabled={params.operator === "changed"}
                  value={String(params.value ?? "")}
                  onChange={(e) => setParam("value", e.target.value)}
                  placeholder="Value"
                />
              </div>
              <p className="text-xs text-ink-3">Fires when the property&apos;s field meets the condition (checked on property updates and by the scan).</p>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function TriggersTab() {
  const { can } = useAuth();
  const list = useListQuery<Trigger>("reactivation", "/reactivation/triggers");
  const { url } = list;
  const { data: meta } = useReactivationMeta();
  const [editing, setEditing] = useState<Trigger | null>(null);

  const columns: Column<Trigger>[] = [
    {
      id: "opportunity",
      header: "Opportunity",
      cell: (t) => (
        <div className="min-w-[200px]">
          <Link href={`/pipeline/${t.opportunity_id}`} className="font-medium text-ink hover:underline">
            {t.opportunity_title ?? "Opportunity"}
          </Link>
          <p className="truncate text-xs text-ink-3">{t.property_label ?? "—"}</p>
        </div>
      ),
    },
    { id: "type", header: "Trigger", sortKey: "trigger_type", cell: (t) => <Badge tone="outline">{titleCase(t.trigger_type)}</Badge> },
    { id: "description", header: "Condition", cell: (t) => <span className="block max-w-[280px] truncate text-ink-2">{t.description}</span> },
    { id: "origin", header: "Origin", cell: (t) => <span className="text-xs text-ink-3">{titleCase(t.origin)}</span> },
    { id: "dead_reason", header: "Dead reason", cell: (t) => <span className="text-ink-2">{t.dead_reason ? DEAD_REASON_LABELS[t.dead_reason] ?? titleCase(t.dead_reason) : "—"}</span> },
    { id: "armed", header: "Armed", sortKey: "armed_at", cell: (t) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDate(t.armed_at)}</span> },
    { id: "fire_on", header: "Date watch", sortKey: "fire_on", cell: (t) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDate(t.fire_on)}</span> },
    { id: "checked", header: "Last checked", sortKey: "last_checked_at", cell: (t) => <span className="whitespace-nowrap text-xs text-ink-3">{t.last_checked_at ? `${formatRelative(t.last_checked_at)} · ${t.check_count}×` : "Never"}</span> },
    { id: "status", header: "Status", cell: (t) => <Badge tone={STATUS_TONES[t.status] ?? "neutral"} dot>{titleCase(t.status)}</Badge> },
  ];

  return (
    <>
      <ListCard
        toolbar={
          <Toolbar>
            <FacetFilter label="Status" options={TRIGGER_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Trigger" options={(meta?.trigger_types ?? []).map((t) => ({ value: t.type, label: t.label }))} selected={url.getAll("trigger_type")} onChange={(v) => url.set({ trigger_type: v })} />
          </Toolbar>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={can("reactivation", "edit") ? (t) => t.status === "armed" && setEditing(t) : undefined}
          empty={<EmptyState icon={<Crosshair />} title="No triggers" description="Triggers are armed automatically when an opportunity is marked dead with a reactivation rule." />}
        />
      </ListCard>
      <EditTriggerDialog trigger={editing} onOpenChange={(o) => !o && setEditing(null)} />
    </>
  );
}
