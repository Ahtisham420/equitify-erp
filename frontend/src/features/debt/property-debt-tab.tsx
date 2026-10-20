"use client";

import { Landmark, Plus } from "lucide-react";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import { useLoansByProperty, type LoanListItem } from "./api";
import { CovenantStateBadge, LoanFormSheet } from "./loan-forms";

function MaturityCell({ l }: { l: LoanListItem }) {
  if (!l.maturity_on) return <span className="text-ink-3">—</span>;
  const m = l.months_to_maturity;
  const tone = m !== null && m <= 6 ? "font-medium text-negative" : l.in_refi_window ? "font-medium text-caution" : "text-ink-3";
  return (
    <div className="whitespace-nowrap">
      <p className="text-ink">{formatDate(l.maturity_on)}</p>
      <p className={cn("text-xs", tone)}>
        {m === null ? "" : m < 0 ? "Matured" : `${formatNumber(m)} mo`}
        {l.in_refi_window && m !== null && m >= 0 ? " · refi window" : ""}
      </p>
    </div>
  );
}

const columns: Column<LoanListItem>[] = [
  {
    id: "loan",
    header: "Loan",
    cell: (l) => (
      <div className="min-w-[180px] max-w-[300px]">
        <p className="truncate font-medium text-ink">{l.label}</p>
        <p className="truncate text-xs text-ink-3">{titleCase(l.loan_type)}</p>
      </div>
    ),
  },
  { id: "lender", header: "Lender", cell: (l) => <span className="text-ink-2">{l.lender_name ?? "—"}</span> },
  { id: "balance", header: "Balance", align: "right", cell: (l) => formatCurrency(l.current_balance) },
  {
    id: "rate",
    header: "Rate",
    align: "right",
    cell: (l) => (
      <div className="whitespace-nowrap">
        <p>{formatPercent(l.rate, 2)}</p>
        {l.rate_type === "floating" && <p className="text-xs text-ink-3">floating</p>}
      </div>
    ),
  },
  { id: "maturity", header: "Maturity", cell: (l) => <MaturityCell l={l} /> },
  { id: "covenants", header: "Covenants", cell: (l) => <CovenantStateBadge state={l.covenant_state} /> },
  { id: "status", header: "Status", cell: (l) => <StatusBadge status={l.status} /> },
];

/** Property detail tab: loans secured by this property, with maturity countdown and covenant state. */
export function PropertyDebtTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useLoansByProperty(propertyId);
  const active = (data ?? []).filter((l) => l.status === "active");
  const total = active.reduce((s, l) => s + (l.current_balance ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          {data && data.length > 0
            ? `${formatNumber(active.length)} active ${active.length === 1 ? "loan" : "loans"} · ${formatCurrency(total)} outstanding`
            : "Loans secured by this property."}
        </p>
        {can("debt", "create") && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New loan
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          dense
          rowHref={(l) => `/loans/${l.id}`}
          rowClassName={(l) => (l.status !== "active" ? "bg-subtle/40" : undefined)}
          empty={
            <EmptyState
              icon={<Landmark />}
              title="No loans"
              description="Add a loan to track its terms, maturity, covenants and lender reporting."
              action={
                can("debt", "create") ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New loan
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Card>
      <LoanFormSheet open={creating} onOpenChange={setCreating} propertyId={propertyId} />
    </div>
  );
}
