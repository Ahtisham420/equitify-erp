"use client";

import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatNumber, toNumber } from "@/lib/utils";

import { useAgentPlans, useAssignPlan, useSavePlan, useSplitPlans, type AgentPlan, type SplitPlan } from "./api";

function PlanSheet({ open, onOpenChange, plan }: { open: boolean; onOpenChange: (o: boolean) => void; plan: SplitPlan | null }) {
  const save = useSavePlan(plan?.id);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cap, setCap] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [active, setActive] = useState(true);
  const [tiers, setTiers] = useState<{ min: string; pct: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(plan?.name ?? "");
    setDescription(plan?.description ?? "");
    setCap(plan?.annual_cap != null ? String(plan.annual_cap) : "");
    setIsDefault(plan?.is_default ?? false);
    setActive(plan?.is_active ?? true);
    setTiers(plan ? plan.tiers.map((t) => ({ min: String(t.min_ytd_gci), pct: String(t.agent_pct) })) : [{ min: "0", pct: "60" }, { min: "250000", pct: "70" }, { min: "500000", pct: "80" }]);
  }, [open, plan]);

  const submit = () =>
    save.mutate(
      {
        name: name.trim(),
        description: description.trim() || null,
        annual_cap: toNumber(cap),
        is_default: isDefault,
        is_active: active,
        tiers: tiers.map((t) => ({ min_ytd_gci: toNumber(t.min) ?? 0, agent_pct: toNumber(t.pct) ?? 0 })),
      },
      { onSuccess: () => { toast.success("Split plan saved"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={plan ? "Edit split plan" : "New split plan"}
      description="Agent percentage steps up as the agent's year-to-date GCI crosses each threshold. A deal straddling a threshold is split across tiers."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !tiers.length} loading={save.isPending} onClick={submit}>
            Save plan
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard graduated 60/70/80" />
        </Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Tiers by YTD GCI</p>
          <div className="space-y-2">
            {tiers.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_32px] items-center gap-2">
                <Input inputMode="decimal" value={t.min} disabled={i === 0} onChange={(e) => setTiers((ts) => ts.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} placeholder="From YTD GCI $" />
                <Input inputMode="decimal" value={t.pct} onChange={(e) => setTiers((ts) => ts.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} placeholder="Agent %" />
                <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))} aria-label="Remove tier">
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          <Button size="xs" className="mt-2" onClick={() => setTiers((ts) => [...ts, { min: "", pct: "" }])}>
            <Plus className="!size-3.5" /> Tier
          </Button>
        </div>
        <Field label="Annual cap on house share" hint="Once the company has collected this much from an agent in a calendar year, the agent receives 100%.">
          <Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={isDefault} onChange={setIsDefault} /> Default plan for agents without an assignment
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={active} onChange={setActive} /> Active
        </label>
      </div>
    </Sheet>
  );
}

export function SplitPlansTab() {
  const { can } = useAuth();
  const plans = useSplitPlans();
  const agents = useAgentPlans();
  const assign = useAssignPlan();
  const [editing, setEditing] = useState<SplitPlan | null>(null);
  const [open, setOpen] = useState(false);
  const canApprove = can("commissions", "approve");

  const agentCols: Column<AgentPlan & { id: string }>[] = [
    { id: "agent", header: "Agent", cell: (a) => <span className="font-medium">{a.agent_name ?? "—"}</span> },
    {
      id: "plan",
      header: "Plan",
      cell: (a) =>
        canApprove ? (
          <select
            value={a.plan_name?.endsWith("(default)") ? "" : a.plan_id ?? ""}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => assign.mutate({ agentId: a.agent_id, plan_id: e.target.value || null }, { onSuccess: () => toast.success("Plan assigned"), onError: (err) => toast.error(errorMessage(err)) })}
            className="h-7 rounded-md border border-line-strong/80 bg-surface px-2 text-sm"
          >
            <option value="">Default plan</option>
            {(plans.data ?? []).filter((p) => p.is_active).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-ink-2">{a.plan_name ?? "—"}</span>
        ),
    },
    { id: "ytd", header: "YTD GCI", align: "right", cell: (a) => formatCurrency(a.ytd_gci) },
    { id: "house", header: "YTD house share", align: "right", cell: (a) => formatCurrency(a.ytd_house) },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-2">Split plans determine the agent and house share of each commission.</p>
        {canApprove && (
          <Button variant="primary" onClick={() => { setEditing(null); setOpen(true); }}>
            <Plus /> New plan
          </Button>
        )}
      </div>
      {plans.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !plans.data?.length ? (
        <Card>
          <EmptyState title="No split plans" description="Without a plan, agents receive 100% of their GCI share." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {plans.data.map((p) => (
            <Card key={p.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {p.name} {p.is_default && <Badge tone="blue">Default</Badge>} {!p.is_active && <Badge>Inactive</Badge>}
                  </span>
                }
                description={`${p.agent_count} assigned · ${p.annual_cap != null ? `cap ${formatCurrency(p.annual_cap)}` : "no cap"}`}
                actions={
                  canApprove && (
                    <Button size="xs" variant="ghost" onClick={() => { setEditing(p); setOpen(true); }}>
                      <Pencil className="!size-3.5" /> Edit
                    </Button>
                  )
                }
              />
              <table className="w-full text-sm">
                <tbody>
                  {p.tiers.map((t, i) => (
                    <tr key={i} className="border-t border-line first:border-0">
                      <td className="px-4 py-1.5 text-ink-2">
                        {i === 0 ? "From $0" : `From ${formatCurrency(t.min_ytd_gci)}`} YTD GCI
                      </td>
                      <td className="px-4 py-1.5 text-right font-medium tabular">{formatNumber(t.agent_pct, 2)}% agent</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Agent assignments" description="Year-to-date figures from earned commissions" />
        <DataTable columns={agentCols} data={agents.data?.map((a) => ({ ...a, id: a.agent_id }))} loading={agents.isLoading} empty={<EmptyState icon={<Users />} title="No agents with commissions yet" />} />
      </Card>
      <PlanSheet open={open} onOpenChange={setOpen} plan={editing} />
    </div>
  );
}
