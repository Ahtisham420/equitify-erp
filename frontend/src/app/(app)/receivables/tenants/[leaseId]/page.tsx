"use client";

import { Banknote, CalendarRange, Plus } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton, TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase } from "@/lib/utils";

import { CHARGE_TYPE_LABELS, SOURCE_LABELS, useLedger, type LedgerEntry } from "@/features/receivables/api";
import { NoticesTable, PlansTab } from "@/features/receivables/collections";
import { AgingCards } from "@/features/receivables/dashboard";
import { ManualChargeSheet, PlanSheet, RecordPaymentSheet } from "@/features/receivables/forms";
import { ChargesTab, PaymentsTab, RxStatus } from "@/features/receivables/ledger-tabs";

const KIND_TONE = { charge: "neutral", payment: "green", reversal: "red", void: "outline" } as const;

const columns: Column<LedgerEntry>[] = [
  { id: "on", header: "Date", cell: (e) => <span className="whitespace-nowrap text-ink-2">{formatDate(e.on)}</span> },
  { id: "kind", header: "Entry", cell: (e) => <Badge tone={KIND_TONE[e.kind]}>{titleCase(e.kind)}</Badge> },
  {
    id: "desc",
    header: "Description",
    cell: (e) => (
      <div className="min-w-[200px]">
        <p className="truncate text-ink">{e.description}</p>
        {e.charge_type && (
          <p className="truncate text-xs text-ink-3">
            {CHARGE_TYPE_LABELS[e.charge_type] ?? e.charge_type}
            {e.source ? ` · ${SOURCE_LABELS[e.source] ?? e.source}` : ""}
          </p>
        )}
      </div>
    ),
  },
  {
    id: "trace",
    header: "Traces to",
    cell: (e) =>
      Object.keys(e.source_ref ?? {}).length ? (
        <Tooltip content={<pre className="whitespace-pre-wrap text-2xs">{JSON.stringify(e.source_ref, null, 2)}</pre>}>
          <span className="cursor-help text-xs text-ink-2 underline decoration-dotted">Source</span>
        </Tooltip>
      ) : null,
  },
  { id: "debit", header: "Charges", align: "right", cell: (e) => (e.debit ? formatCurrency(e.debit) : "") },
  { id: "credit", header: "Credits", align: "right", cell: (e) => (e.credit ? formatCurrency(e.credit) : "") },
  { id: "balance", header: "Balance", align: "right", cell: (e) => <span className={cn("font-medium", e.balance < 0 && "text-positive")}>{formatCurrency(e.balance)}</span> },
  { id: "status", header: "Status", cell: (e) => (e.status ? <RxStatus status={e.status} /> : null) },
];

function TenantLedger({ leaseId }: { leaseId: string }) {
  const { can } = useAuth();
  const url = useUrlState();
  const { data, isLoading, error } = useLedger(leaseId);
  const [paying, setPaying] = useState(false);
  const [charging, setCharging] = useState(false);
  const [planning, setPlanning] = useState(false);
  const tab = url.get("tab") ?? "ledger";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return <EmptyState title="Ledger not found" description={errorMessage(error)} action={<Link href="/receivables"><Button>Back to receivables</Button></Link>} />;
  }
  const t = data.tenant;
  const terms = data.late_fee_terms;
  const entries = [...data.entries].reverse();

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Receivables", href: "/receivables?tab=tenants" }, { label: t.tenant_name }]}
        title={t.tenant_name}
        description={
          <>
            <Link href={`/leases/${leaseId}`} className="hover:underline">Lease abstract</Link>
            {t.property_name ? <> · <Link href={`/properties/${t.property_id}`} className="hover:underline">{t.property_name}</Link></> : null}
          </>
        }
        meta={
          <>
            <RxStatus status={t.collection_status} />
            {t.step_key && <Badge tone="outline">{titleCase(t.step_key)}</Badge>}
            {t.has_plan && <Badge tone="sky">Payment plan</Badge>}
            <span className="text-xs text-ink-3">Lease {titleCase(t.lease_status)}</span>
          </>
        }
        actions={
          <>
            {can("receivables", "approve") && t.past_due > 0 && !t.has_plan && (
              <Button onClick={() => setPlanning(true)}><CalendarRange /> Payment plan</Button>
            )}
            {can("receivables", "create") && (
              <>
                <Button onClick={() => setCharging(true)}><Plus /> One-time charge</Button>
                <Button variant="primary" onClick={() => setPaying(true)}><Banknote /> Record payment</Button>
              </>
            )}
          </>
        }
      />

      <div className="mb-5 space-y-3">
        <AgingCards totals={t.buckets} compact />
        <Card>
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Net balance">{formatCurrency(t.balance)}</FieldItem>
              <FieldItem label="Unapplied cash">{formatCurrency(t.unapplied)}</FieldItem>
              <FieldItem label="Late-fee terms">
                {`${terms.pct ? `${terms.pct}%` : ""}${terms.pct && terms.flat ? " + " : ""}${terms.flat ? formatCurrency(terms.flat) : ""}${!terms.pct && !terms.flat ? "None" : ""} after ${terms.grace_days ?? 0} days · ${terms.basis === "lease_terms" ? "per verified lease" : "receivables defaults"}`}
              </FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "ledger" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "ledger", label: "Ledger", count: data.entries.length },
            { value: "charges", label: "Charges" },
            { value: "payments", label: "Payments" },
            { value: "notices", label: "Notices" },
            { value: "plans", label: "Payment plans" },
          ]}
        />
        <TabPanel value="ledger">
          <Card className="overflow-hidden">
            <CardHeader title="Tenant ledger" description="Newest first. Voids and reversals are separate entries; nothing is deleted." />
            <DataTable columns={columns} data={entries} dense rowClassName={(e) => (e.kind === "reversal" || e.kind === "void" ? "bg-subtle/40" : undefined)} empty={<EmptyState title="No ledger activity" />} />
          </Card>
        </TabPanel>
        <TabPanel value="charges">
          <ChargesTab leaseId={leaseId} />
        </TabPanel>
        <TabPanel value="payments">
          <PaymentsTab leaseId={leaseId} />
        </TabPanel>
        <TabPanel value="notices">
          <NoticesTable leaseId={leaseId} />
        </TabPanel>
        <TabPanel value="plans">
          <PlansTab leaseId={leaseId} />
        </TabPanel>
      </Tabs>

      <RecordPaymentSheet open={paying} onOpenChange={setPaying} leaseId={leaseId} />
      <ManualChargeSheet open={charging} onOpenChange={setCharging} leaseId={leaseId} />
      <PlanSheet open={planning} onOpenChange={setPlanning} leaseId={leaseId} />
    </>
  );
}

export default function TenantLedgerPage({ params }: { params: { leaseId: string } }) {
  return (
    <Suspense>
      <TenantLedger leaseId={params.leaseId} />
    </Suspense>
  );
}
