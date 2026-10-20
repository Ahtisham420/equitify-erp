"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Pencil, Plus, Undo2 } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, titleCase, toNumber } from "@/lib/utils";

import {
  PACKAGE_LABELS,
  TIER_LABELS,
  useAllocations,
  useInvestments,
  usePartner,
  usePartnerPackages,
  useReverseEntry,
  useStatement,
  type Allocation,
  type Entry,
  type Investment,
  type PackageListItem,
  type Partner,
} from "@/features/investors/api";
import { FundDialog, StateBadge } from "@/features/investors/events-tab";
import { StatementTable } from "@/features/investors/statement-table";
import { InvestmentFormSheet } from "@/features/investors/investment-form";
import { PartnerFormSheet } from "@/features/investors/partner-form";
import { GenerateDialog, PackageSheet } from "@/features/investors/reports-tab";

/* ------------------------------------------------------------------ overview */

function Overview({ p }: { p: Partner }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Commitment" value={formatCurrency(p.commitment)} />
        <StatCard label="Funded" value={formatCurrency(p.funded)} />
        <StatCard label="Unfunded" value={formatCurrency(p.unfunded)} tone={p.in_default ? "negative" : "default"} hint={p.in_default ? "A capital call is in default" : undefined} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Profile" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Type">{titleCase(p.type)}</FieldItem>
              <FieldItem label="Organization">{p.organization_id ? <Link className="text-accent hover:underline" href={`/organizations/${p.organization_id}`}>{p.organization_name ?? "Organization"}</Link> : null}</FieldItem>
              <FieldItem label="Primary contact">{p.person_id ? <Link className="text-accent hover:underline" href={`/people/${p.person_id}`}>{p.person_name ?? "Person"}</Link> : null}</FieldItem>
              <FieldItem label="Email">{p.email}</FieldItem>
              <FieldItem label="Phone">{p.phone}</FieldItem>
              <FieldItem label="Relationship owner">{p.owner_name}</FieldItem>
              <FieldItem label="Portal access">{p.portal_user_id ? p.portal_user_name ?? "Enabled" : "Not enabled"}</FieldItem>
              <FieldItem label="Tags">{p.tags.length ? p.tags.join(", ") : null}</FieldItem>
            </FieldGrid>
            {p.notes && <p className="mt-4 whitespace-pre-wrap border-t border-line pt-3 text-sm text-ink-2">{p.notes}</p>}
          </CardBody>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Reporting" />
            <CardBody>
              <FieldGrid cols={1}>
                <FieldItem label="Frequency">{titleCase(p.reporting_prefs?.frequency)}</FieldItem>
                <FieldItem label="Delivery">{titleCase(p.reporting_prefs?.delivery)}</FieldItem>
                <FieldItem label="Packages">{(p.reporting_prefs?.packages ?? []).map((x) => PACKAGE_LABELS[x] ?? x).join(", ") || null}</FieldItem>
              </FieldGrid>
              {p.reporting_requirements && <p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">{p.reporting_requirements}</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Communication" />
            <CardBody>
              <FieldGrid cols={1}>
                <FieldItem label="Preferred channel">{titleCase(p.communication_prefs?.channel)}</FieldItem>
                <FieldItem label="Recipients">{(p.communication_prefs?.recipients ?? []).join(", ") || null}</FieldItem>
                <FieldItem label="Do not contact">{p.communication_prefs?.do_not_contact ? "Required notices only" : "No restriction"}</FieldItem>
              </FieldGrid>
              {p.communication_prefs?.notes && <p className="mt-3 text-sm text-ink-2">{p.communication_prefs.notes}</p>}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ investments */

function AllocateIncomeDialog({ inv, onClose }: { inv: Investment | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<{ entries: number }>(`/investors/assets/${inv?.asset_id}/allocate-income`, { amount: toNumber(amount), effective_on: date, memo: memo || null }),
    onSuccess: (r) => {
      toast.success(`Allocated across ${r.entries} investments by ownership`);
      qc.invalidateQueries({ queryKey: ["investors"] });
      setAmount("");
      setMemo("");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open={!!inv}
      onOpenChange={(o) => !o && onClose()}
      title={`Allocate income or loss — ${inv?.asset_label ?? ""}`}
      description="Net income (positive) or loss (negative) for the asset is allocated to every active investment pro rata to ownership."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!toNumber(amount)} loading={m.isPending} onClick={() => m.mutate()}>
            Post allocation
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Asset net income / (loss)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 125000 or -40000" />
        </Field>
        <Field label="Effective date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Memo" className="col-span-2">
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Q3 net income per approved financials" />
        </Field>
      </div>
    </Dialog>
  );
}

function InvestmentsTab({ partnerId }: { partnerId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useInvestments({ partner_id: partnerId });
  const [editing, setEditing] = useState<Investment | null>(null);
  const [open, setOpen] = useState(false);
  const [allocating, setAllocating] = useState<Investment | null>(null);

  const cols: Column<Investment>[] = [
    { id: "asset", header: "Asset", cell: (i) => <span className="font-medium">{i.asset_label ?? "—"}</span> },
    { id: "position", header: "Position", cell: (i) => <Badge tone={i.waterfall_position === "gp" ? "blue" : "outline"}>{i.waterfall_position.toUpperCase()}</Badge> },
    { id: "status", header: "Status", cell: (i) => <StatusBadge status={i.status === "exited" ? "closed" : "active"} label={titleCase(i.status)} /> },
    { id: "ownership", header: "Ownership", align: "right", cell: (i) => `${formatNumber(i.ownership_pct, 4)}%` },
    { id: "commitment", header: "Commitment", align: "right", cell: (i) => formatCurrency(i.commitment) },
    { id: "funded", header: "Funded", align: "right", cell: (i) => formatCurrency(i.funded) },
    { id: "unfunded", header: "Unfunded", align: "right", cell: (i) => formatCurrency(i.unfunded) },
    { id: "pref", header: "Pref", align: "right", cell: (i) => `${formatNumber(i.pref_rate, 2)}% ${i.pref_compounding === "annual" ? "cmp" : ""}` },
    { id: "waterfall", header: "Waterfall", cell: (i) => <span className="text-ink-2">{i.waterfall_name ?? "Asset default"}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (i) => (
        <div className="flex justify-end gap-1">
          {can("investors", "approve") && i.status === "active" && (
            <Button size="xs" variant="ghost" onClick={() => setAllocating(i)}>
              Allocate income
            </Button>
          )}
          {can("investors", "edit") && (
            <Button size="xs" variant="ghost" onClick={() => { setEditing(i); setOpen(true); }} aria-label="Edit investment">
              <Pencil className="!size-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Investments"
        description="Commitment, ownership and waterfall terms per asset"
        actions={
          can("investors", "create") && (
            <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}>
              <Plus /> Add investment
            </Button>
          )
        }
      />
      <DataTable columns={cols} data={data} loading={isLoading} empty={<EmptyState title="No investments yet" description="Record this partner's commitment to an owned asset." />} />
      <InvestmentFormSheet open={open} onOpenChange={setOpen} partnerId={partnerId} investment={editing} />
      <AllocateIncomeDialog inv={allocating} onClose={() => setAllocating(null)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ statement */

function StatementTab({ partnerId }: { partnerId: string }) {
  const { can } = useAuth();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const { data, isLoading } = useStatement(partnerId, asOf);
  const reverse = useReverseEntry();
  const [reversing, setReversing] = useState<Entry | null>(null);
  const [reason, setReason] = useState("");

  const cols: Column<Entry>[] = [
    { id: "date", header: "Date", cell: (e) => <span className="whitespace-nowrap">{formatDate(e.effective_on)}</span> },
    { id: "type", header: "Entry", cell: (e) => <span>{titleCase(e.entry_type)}{e.component ? <span className="text-ink-3"> · {TIER_LABELS[e.component] ?? titleCase(e.component)}</span> : null}</span> },
    { id: "memo", header: "Memo", cell: (e) => <span className="block max-w-[360px] truncate text-ink-2">{e.memo ?? "—"}</span> },
    {
      id: "flags",
      header: "",
      cell: (e) => (e.reverses_entry_id ? <Badge tone="amber">Reversal</Badge> : e.reversed ? <Badge>Reversed</Badge> : null),
    },
    { id: "amount", header: "Amount", align: "right", cell: (e) => <span className={cn(e.amount < 0 && "text-negative")}>{formatCurrency(e.amount)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (e) =>
        can("investors", "approve") && !e.reverses_entry_id && !e.reversed ? (
          <Button size="xs" variant="ghost" onClick={() => setReversing(e)}>
            <Undo2 className="!size-3.5" /> Reverse
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Capital account statement"
          description="Accrued preferred return is computed from the ledger by day count as of the statement date."
          actions={<Input type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}
        />
        {isLoading || !data ? <Skeleton className="m-4 h-24" /> : <StatementTable accounts={data.accounts} totals={data.totals} />}
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Ledger" description="Entries are immutable; corrections post reversing entries." />
        <DataTable columns={cols} data={data?.entries ? [...data.entries].reverse() : undefined} loading={isLoading} dense rowClassName={(e) => (e.reversed ? "text-ink-3" : undefined)} empty={<EmptyState title="No entries" />} />
      </Card>
      <Dialog
        open={!!reversing}
        onOpenChange={(o) => !o && setReversing(null)}
        title="Reverse ledger entry"
        description={reversing ? `${titleCase(reversing.entry_type)} of ${formatCurrency(reversing.amount)} on ${formatDate(reversing.effective_on)}` : undefined}
        footer={
          <>
            <Button onClick={() => setReversing(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 3}
              loading={reverse.isPending}
              onClick={() =>
                reversing &&
                reverse.mutate(
                  { id: reversing.id, reason: reason.trim() },
                  { onSuccess: () => { toast.success("Reversing entry posted"); setReversing(null); setReason(""); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              Post reversal
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ distributions & calls */

function DistributionsTab({ partnerId }: { partnerId: string }) {
  const { data, isLoading } = useAllocations({ partner_id: partnerId, event_type: ["distribution", "liquidation"] });
  const cols: Column<Allocation>[] = [
    { id: "date", header: "Date", cell: (a) => formatDate(a.event_date) },
    { id: "event", header: "Event", cell: (a) => <span className="font-medium">{a.event_name}</span> },
    { id: "asset", header: "Asset", cell: (a) => <span className="text-ink-2">{a.asset_label}</span> },
    { id: "type", header: "Type", cell: (a) => titleCase(a.event_type) },
    { id: "status", header: "Status", cell: (a) => <StateBadge status={a.status} /> },
    { id: "components", header: "Components", cell: (a) => <span className="text-xs text-ink-2">{a.tiers.map((t) => `${TIER_LABELS[t.component] ?? titleCase(t.component)} ${formatCurrency(t.amount)}`).join(" · ")}</span> },
    { id: "amount", header: "Amount", align: "right", cell: (a) => formatCurrency(a.amount) },
  ];
  return (
    <Card className="overflow-hidden">
      <DataTable columns={cols} data={data} loading={isLoading} empty={<EmptyState title="No distributions yet" />} />
    </Card>
  );
}

function CallsTab({ partnerId }: { partnerId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useAllocations({ partner_id: partnerId, event_type: ["call"] });
  const [funding, setFunding] = useState<Allocation | null>(null);
  const [notice, setNotice] = useState<Allocation | null>(null);
  const cols: Column<Allocation>[] = [
    { id: "event", header: "Call", cell: (a) => <span className="font-medium">{a.event_name}</span> },
    { id: "asset", header: "Asset", cell: (a) => <span className="text-ink-2">{a.asset_label}</span> },
    { id: "status", header: "Status", cell: (a) => <div className="flex gap-1"><StateBadge status={a.status} />{a.penalty_flag && <Badge tone="red">Penalty</Badge>}</div> },
    { id: "due", header: "Due", cell: (a) => <span className="whitespace-nowrap">{formatDate(a.due_on)}{a.days_late > 0 && <span className="ml-1 text-negative">· {a.days_late}d late</span>}</span> },
    { id: "amount", header: "Called", align: "right", cell: (a) => formatCurrency(a.amount) },
    { id: "funded", header: "Funded", align: "right", cell: (a) => formatCurrency(a.funded_amount) },
    { id: "interest", header: "Late interest", align: "right", cell: (a) => formatCurrency(Math.max(a.late_interest, a.accrued_late_interest)) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (a) => (
        <div className="flex justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={() => setNotice(a)}>
            <FileText className="!size-3.5" /> Notice
          </Button>
          {can("investors", "edit") && !["funded", "reversed"].includes(a.status) && (
            <Button size="xs" onClick={() => setFunding(a)}>
              <Check className="!size-3.5" /> Fund
            </Button>
          )}
        </div>
      ),
    },
  ];
  return (
    <Card className="overflow-hidden">
      <DataTable columns={cols} data={data} loading={isLoading} empty={<EmptyState title="No capital calls" />} />
      <FundDialog item={funding} onClose={() => setFunding(null)} />
      <Dialog open={!!notice} onOpenChange={(o) => !o && setNotice(null)} title="Capital call notice" className="max-w-2xl">
        <pre className="whitespace-pre-wrap rounded-md border border-line bg-subtle p-3 font-mono text-xs text-ink">{notice?.notice_text}</pre>
      </Dialog>
    </Card>
  );
}

function ReportsPanel({ partnerId }: { partnerId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = usePartnerPackages(partnerId);
  const [open, setOpen] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const cols: Column<PackageListItem>[] = [
    { id: "title", header: "Package", cell: (p) => <span className="font-medium">{p.title}</span> },
    { id: "period", header: "Period", cell: (p) => `${formatDate(p.period_start)} – ${formatDate(p.period_end)}` },
    { id: "sections", header: "Sections", cell: (p) => <span className="text-xs text-ink-3">{p.package_types.map((t) => PACKAGE_LABELS[t] ?? t).join(", ")}</span> },
    { id: "status", header: "Status", cell: (p) => <StateBadge status={p.status} /> },
    { id: "generated", header: "Generated", cell: (p) => <span className="text-xs text-ink-3">{formatDateTime(p.generated_at)}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Reporting packages"
        actions={
          can("investors", "create") && (
            <Button size="sm" onClick={() => setGenerating(true)}>
              <Plus /> Generate
            </Button>
          )
        }
      />
      <DataTable columns={cols} data={data?.items} loading={isLoading} onRowClick={(p) => setOpen(p.id)} empty={<EmptyState title="No packages yet" />} />
      <GenerateDialog open={generating} onOpenChange={setGenerating} partnerId={partnerId} />
      <PackageSheet id={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

function PartnerDetail({ id }: { id: string }) {
  const url = useUrlState();
  const { can, user } = useAuth();
  const { data: p, isLoading, error } = usePartner(id);
  const [editing, setEditing] = useState(false);
  const tab = url.get("tab") ?? "overview";
  const portal = user?.role.key === "capital_partner";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !p) {
    return <EmptyState title="Partner not found" description={errorMessage(error)} action={<Link href={portal ? "/investors/portal" : "/investors"}><Button>Back</Button></Link>} />;
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Capital partners", href: portal ? "/investors/portal" : "/investors" }, { label: p.name }]}
        title={p.name}
        description={[titleCase(p.type), p.organization_name, p.email].filter(Boolean).join(" · ")}
        meta={
          <>
            <StatusBadge status={p.status} />
            {p.in_default && <Badge tone="red">Call in default</Badge>}
            {p.portal_user_id && <Badge tone="sky">Portal enabled</Badge>}
          </>
        }
        actions={
          can("investors", "edit") &&
          !portal && (
            <Button variant="primary" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "investments", label: "Investments" },
            { value: "statement", label: "Capital account" },
            { value: "distributions", label: "Distributions" },
            { value: "calls", label: "Capital calls" },
            { value: "reports", label: "Reports" },
            ...(portal ? [] : [{ value: "activity", label: "Activity" }]),
          ]}
        />
        <TabPanel value="overview">
          <Overview p={p} />
        </TabPanel>
        <TabPanel value="investments">
          <InvestmentsTab partnerId={id} />
        </TabPanel>
        <TabPanel value="statement">
          <StatementTab partnerId={id} />
        </TabPanel>
        <TabPanel value="distributions">
          <DistributionsTab partnerId={id} />
        </TabPanel>
        <TabPanel value="calls">
          <CallsTab partnerId={id} />
        </TabPanel>
        <TabPanel value="reports">
          <ReportsPanel partnerId={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="capital_partner" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>
      <PartnerFormSheet open={editing} onOpenChange={setEditing} partner={p} />
    </>
  );
}

export default function PartnerPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <PartnerDetail id={params.id} />
    </Suspense>
  );
}
