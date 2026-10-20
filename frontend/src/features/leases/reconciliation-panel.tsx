"use client";

import { Calculator, Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatPercent, titleCase, toNumber } from "@/lib/utils";

import { useFinalizeReconciliation, useReconciliations, useRunReconciliation, type Reconciliation } from "./api";

interface PoolRow { key: string; budgeted: string; actual: string }

const DEFAULT_POOL: PoolRow[] = [
  { key: "cam", budgeted: "", actual: "" },
  { key: "tax", budgeted: "", actual: "" },
  { key: "insurance", budgeted: "", actual: "" },
];

const STATUS_TONE = { draft: "neutral", final: "blue", billed: "green" } as const;

/** Annual recovery reconciliation for a property: recoverable pools in, tenant true-ups out. */
export function ReconciliationPanel({ propertyId }: { propertyId: string | null }) {
  const { can } = useAuth();
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [totalSf, setTotalSf] = useState("");
  const [pool, setPool] = useState<PoolRow[]>(DEFAULT_POOL);
  const y = toNumber(year);
  const { data, isLoading } = useReconciliations({ property_id: propertyId, year: y });
  const run = useRunReconciliation();
  const finalize = useFinalizeReconciliation();

  const submit = () => {
    if (!propertyId || !y) return;
    const budgeted: Record<string, number> = {};
    const actual: Record<string, number> = {};
    for (const r of pool) {
      if (!r.key.trim()) continue;
      const b = toNumber(r.budgeted);
      const a = toNumber(r.actual);
      if (b !== null) budgeted[r.key.trim()] = b;
      if (a !== null) actual[r.key.trim()] = a;
    }
    run.mutate(
      { property_id: propertyId, year: y, budgeted, actual, total_sf: toNumber(totalSf) },
      {
        onSuccess: (r) => toast.success(`${r.created} created, ${r.updated} updated${r.skipped_locked ? `, ${r.skipped_locked} already final` : ""}`),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const columns: Column<Reconciliation>[] = [
    { id: "tenant", header: "Tenant", cell: (r) => <span className="font-medium">{r.tenant_name}</span> },
    { id: "share", header: "Share", align: "right", cell: (r) => formatPercent(r.share_pct, 2) },
    { id: "budget", header: "Budgeted share", align: "right", cell: (r) => formatCurrency(r.budgeted_share) },
    { id: "actual", header: "Actual share", align: "right", cell: (r) => formatCurrency(r.actual_share) },
    { id: "cap", header: "Cap savings", align: "right", cell: (r) => formatCurrency(r.cap_reduction) },
    { id: "billed", header: "Estimates billed", align: "right", cell: (r) => formatCurrency(r.estimates_billed) },
    { id: "trueup", header: "True-up", align: "right", cell: (r) => <span className={cn("font-medium", r.true_up_amount < 0 && "text-positive")}>{formatCurrency(r.true_up_amount)}</span> },
    {
      id: "skipped",
      header: "",
      cell: (r) => {
        const skipped = r.details.filter((d) => "skipped" in d).length;
        return skipped ? <Badge tone="amber">{skipped} unverified skipped</Badge> : null;
      },
    },
    { id: "status", header: "Status", cell: (r) => <Badge tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? "neutral"} dot>{titleCase(r.status)}</Badge> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (r) =>
        r.status === "draft" && can("leases", "approve") ? (
          <Button size="xs" loading={finalize.isPending} onClick={() => finalize.mutate(r.id, { onSuccess: () => toast.success("Finalized for billing"), onError: (e) => toast.error(errorMessage(e)) })}>
            <Check className="!size-3.5" /> Finalize
          </Button>
        ) : null,
    },
  ];

  if (!propertyId) return <Card><EmptyState icon={<Calculator />} title="Choose a property" description="Reconciliations run per property and year." /></Card>;

  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Card>
        <CardHeader title="Recoverable expense pools" description="Budgeted vs actual by account. Use category prefixes (cam, tax, insurance, utilities) or sub-accounts like cam:landscaping." />
        <CardBody className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Year"><Input inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} /></Field>
            <Field label="Building SF" hint="Blank uses spaces / property"><Input inputMode="decimal" value={totalSf} onChange={(e) => setTotalSf(e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-[1.2fr_1fr_1fr_auto] gap-2 text-xs font-medium text-ink-3">
            <span>Account</span>
            <span>Budgeted</span>
            <span>Actual</span>
            <span />
          </div>
          {pool.map((r, i) => (
            <div key={i} className="grid grid-cols-[1.2fr_1fr_1fr_auto] items-center gap-2">
              <Input value={r.key} onChange={(e) => setPool((p) => p.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
              <Input inputMode="decimal" value={r.budgeted} onChange={(e) => setPool((p) => p.map((x, j) => (j === i ? { ...x, budgeted: e.target.value } : x)))} />
              <Input inputMode="decimal" value={r.actual} onChange={(e) => setPool((p) => p.map((x, j) => (j === i ? { ...x, actual: e.target.value } : x)))} />
              <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setPool((p) => p.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex justify-between">
            <Button size="sm" onClick={() => setPool((p) => [...p, { key: "", budgeted: "", actual: "" }])}>
              <Plus /> Account
            </Button>
            {can("leases", "edit") && (
              <Button size="sm" variant="primary" loading={run.isPending} disabled={!y} onClick={submit}>
                <Calculator /> Run reconciliation
              </Button>
            )}
          </div>
        </CardBody>
      </Card>
      <Card className="overflow-hidden xl:col-span-2">
        <CardHeader title={`Tenant true-ups${y ? ` · ${y}` : ""}`} description="Pro-rata share, exclusions and caps applied from verified recovery terms. Finalized true-ups are billed from Receivables." />
        <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No reconciliation for this year" description="Enter the expense pools and run the reconciliation." />} />
      </Card>
    </div>
  );
}
