"use client";

import { FileText, Landmark } from "lucide-react";
import { Suspense, useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, PageHeader, StatCard } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatCurrency, formatDate, formatNumber, titleCase } from "@/lib/utils";

import { PACKAGE_LABELS, TIER_LABELS, usePortal, type Allocation, type Investment, type PackageListItem } from "@/features/investors/api";
import { StateBadge } from "@/features/investors/events-tab";
import { PackageSheet } from "@/features/investors/reports-tab";
import { StatementTable } from "@/features/investors/statement-table";

type Doc = { id: string; title: string; doc_class: string | null; filename: string | null; created_at: string; entity_type: string };

function PortalView() {
  const { data, isLoading, error } = usePortal();
  const [pkg, setPkg] = useState<string | null>(null);
  const [notice, setNotice] = useState<Allocation | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !data) return <EmptyState title="Investor portal unavailable" description={errorMessage(error)} />;
  if (!data.partners.length) {
    return (
      <>
        <PageHeader title="Investor portal" />
        <Card>
          <EmptyState icon={<Landmark />} title="No investor accounts are linked to your login" description="Contact your relationship manager to enable portal access." />
        </Card>
      </>
    );
  }

  const t = data.totals;
  const investmentCols: Column<Investment>[] = [
    { id: "asset", header: "Investment", cell: (i) => <span className="font-medium">{i.asset_label}</span> },
    { id: "partner", header: "Account", cell: (i) => <span className="text-ink-2">{i.partner_name}</span> },
    { id: "status", header: "Status", cell: (i) => <Badge tone={i.status === "active" ? "green" : "neutral"} dot>{titleCase(i.status)}</Badge> },
    { id: "ownership", header: "Ownership", align: "right", cell: (i) => `${formatNumber(i.ownership_pct, 4)}%` },
    { id: "commitment", header: "Commitment", align: "right", cell: (i) => formatCurrency(i.commitment) },
    { id: "funded", header: "Funded", align: "right", cell: (i) => formatCurrency(i.funded) },
    { id: "unfunded", header: "Unfunded", align: "right", cell: (i) => formatCurrency(i.unfunded) },
    { id: "pref", header: "Preferred return", align: "right", cell: (i) => (i.pref_rate ? `${formatNumber(i.pref_rate, 2)}%` : "—") },
  ];
  const distCols: Column<Allocation>[] = [
    { id: "date", header: "Date", cell: (a) => formatDate(a.paid_on ?? a.event_date) },
    { id: "asset", header: "Investment", cell: (a) => a.asset_label },
    { id: "type", header: "Type", cell: (a) => titleCase(a.event_type) },
    { id: "components", header: "Components", cell: (a) => <span className="text-xs text-ink-2">{a.tiers.map((x) => `${TIER_LABELS[x.component] ?? titleCase(x.component)} ${formatCurrency(x.amount)}`).join(" · ")}</span> },
    { id: "status", header: "Status", cell: (a) => <StateBadge status={a.status} /> },
    { id: "amount", header: "Amount", align: "right", cell: (a) => formatCurrency(a.amount) },
  ];
  const callCols: Column<Allocation>[] = [
    { id: "date", header: "Notice date", cell: (a) => formatDate(a.event_date) },
    { id: "asset", header: "Investment", cell: (a) => a.asset_label },
    { id: "due", header: "Due", cell: (a) => formatDate(a.due_on) },
    { id: "status", header: "Status", cell: (a) => <StateBadge status={a.status} /> },
    { id: "amount", header: "Amount due", align: "right", cell: (a) => formatCurrency(a.amount) },
    { id: "funded", header: "Received", align: "right", cell: (a) => formatCurrency(a.funded_amount) },
    {
      id: "notice",
      header: "",
      align: "right",
      cell: (a) => (
        <Button size="xs" variant="ghost" onClick={() => setNotice(a)}>
          <FileText className="!size-3.5" /> Notice
        </Button>
      ),
    },
  ];
  const reportCols: Column<PackageListItem>[] = [
    { id: "title", header: "Report", cell: (p) => <span className="font-medium">{p.title}</span> },
    { id: "period", header: "Period", cell: (p) => `${formatDate(p.period_start)} – ${formatDate(p.period_end)}` },
    { id: "sections", header: "Contents", cell: (p) => <span className="text-xs text-ink-3">{p.package_types.map((x) => PACKAGE_LABELS[x] ?? x).join(", ")}</span> },
    { id: "issued", header: "Issued", cell: (p) => formatDate(p.issued_at) },
  ];
  const docCols: Column<Doc>[] = [
    { id: "title", header: "Document", cell: (d) => <span className="font-medium">{d.title}</span> },
    { id: "class", header: "Type", cell: (d) => titleCase(d.doc_class) },
    { id: "file", header: "File", cell: (d) => <span className="text-ink-2">{d.filename ?? "—"}</span> },
    { id: "date", header: "Added", cell: (d) => formatDate(d.created_at) },
  ];

  return (
    <>
      <PageHeader title="Investor portal" description={data.partners.map((p) => p.name).join(" · ")} />
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total commitment" value={formatCurrency(t.commitment)} hint={`${formatCurrency(t.unfunded)} unfunded`} />
          <StatCard label="Contributed" value={formatCurrency(t.contributions)} />
          <StatCard label="Distributed" value={formatCurrency(t.distributions)} />
          <StatCard label="Capital account balance" value={formatCurrency(t.ending_balance)} hint={`${formatCurrency(t.accrued_pref)} accrued preferred return`} />
        </div>

        <Card className="overflow-hidden">
          <CardHeader title="Investments" />
          <DataTable columns={investmentCols} data={data.investments} empty={<EmptyState title="No investments" />} />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Capital accounts" description="As of today" />
          <StatementTable accounts={data.capital_accounts} totals={data.totals} />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Distributions" />
          <DataTable columns={distCols} data={data.distributions} empty={<EmptyState title="No distributions yet" />} />
        </Card>

        {data.capital_calls.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader title="Capital calls" />
            <DataTable columns={callCols} data={data.capital_calls} />
          </Card>
        )}

        <Card className="overflow-hidden">
          <CardHeader title="Reports" />
          <DataTable columns={reportCols} data={data.reports} onRowClick={(p) => setPkg(p.id)} empty={<EmptyState title="No reports issued yet" />} />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Documents" />
          <DataTable columns={docCols} data={data.documents} empty={<EmptyState title="No documents shared yet" />} />
        </Card>
      </div>

      <PackageSheet id={pkg} onClose={() => setPkg(null)} />
      <Dialog open={!!notice} onOpenChange={(o) => !o && setNotice(null)} title="Capital call notice" className="max-w-2xl">
        <pre className="whitespace-pre-wrap rounded-md border border-line bg-subtle p-3 font-mono text-xs text-ink">{notice?.notice_text}</pre>
      </Dialog>
    </>
  );
}

export default function InvestorPortalPage() {
  return (
    <Suspense>
      <PortalView />
    </Suspense>
  );
}
