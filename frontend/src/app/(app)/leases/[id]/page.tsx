"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, CalendarClock, Check, MoreHorizontal, Pencil, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, PageHeader } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatDateTime, formatNumber, titleCase } from "@/lib/utils";
import { RecordCriticalDates } from "@/features/contracts/record-critical-dates";
import { RecordDocuments } from "@/features/documents/record-documents";
import type { Observation } from "@/features/properties/api";

import { LEASE_TYPE_LABELS, useLease, useLeaseHistory, type Lease } from "@/features/leases/api";
import { UnverifiedBanner } from "@/features/leases/citation";
import { LeaseFormSheet } from "@/features/leases/lease-form";
import { AbstractSection, AmendmentsSection, ClausesSection, GuarantiesSection, OptionsSection, RentSection } from "@/features/leases/lease-sections";

function SourcedFacts({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useLeaseHistory(id);
  const verify = useMutation({
    mutationFn: ({ obsId, verified }: { obsId: string; verified: boolean }) => api.post<Observation>(`/leases/observations/${obsId}/verify`, { verified }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leases", id] }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns: Column<Observation>[] = [
    { id: "field", header: "Term", cell: (o) => <span className="font-medium">{titleCase(o.field.replace(/^amended\./, ""))}{o.field.startsWith("amended.") && <Badge tone="blue" className="ml-1.5">Amendment</Badge>}</span> },
    {
      id: "value",
      header: "Value",
      cell: (o) => <span className={o.is_current ? "text-ink" : "text-ink-3 line-through decoration-ink-3/40"}>{typeof o.value === "number" ? formatNumber(o.value, 2) : String(o.value ?? "—")}</span>,
    },
    { id: "source", header: "Source", cell: (o) => <span className="text-ink-2">{o.source}</span> },
    { id: "observed", header: "Observed", cell: (o) => <span className="text-ink-2">{formatDate(o.observed_on)}</span> },
    { id: "confidence", header: "Confidence", align: "right", cell: (o) => <ConfidencePill value={o.confidence} /> },
    {
      id: "state",
      header: "Verification",
      cell: (o) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={o.verification} />
          {o.ai_derived && <Badge tone="sky">AI</Badge>}
          {!o.is_current && <Badge tone="outline">Superseded</Badge>}
        </div>
      ),
    },
    { id: "recorded", header: "Recorded", cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(o.recorded_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (o) =>
        o.is_current && o.verification === "unverified" && can("leases", "edit") ? (
          <div className="flex justify-end gap-1">
            <Button size="xs" onClick={() => verify.mutate({ obsId: o.id, verified: true })}>
              <Check className="!size-3.5" /> Verify
            </Button>
            <Button size="xs" variant="ghost" aria-label="Reject" onClick={() => verify.mutate({ obsId: o.id, verified: false })}>
              <X className="!size-3.5" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <Card className="overflow-hidden">
      <DataTable
        columns={columns}
        data={data}
        loading={isLoading}
        dense
        rowClassName={(o) => (!o.is_current ? "bg-subtle/40" : undefined)}
        empty={<EmptyState title="No sourced terms yet" description="Material lease terms record their source and history when set." />}
      />
    </Card>
  );
}

function LeaseDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { data: lease, isLoading, error } = useLease(id);
  const [editing, setEditing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const tab = url.get("tab") ?? "abstract";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["leases"] });
    qc.invalidateQueries({ queryKey: ["timeline", "lease", id] });
    qc.invalidateQueries({ queryKey: ["critical-dates"] });
  };
  const verify = useMutation({
    mutationFn: (verified: boolean) => api.post<Lease>(`/leases/${id}/verify`, { verified }),
    onSuccess: (_, verified) => {
      toast.success(verified ? "Abstract verified; critical dates updated" : "Abstract marked unverified");
      setVerifying(false);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const genDates = useMutation({
    mutationFn: () => api.post<{ generated: number; skipped_unverified: number; available: boolean }>(`/leases/${id}/critical-dates/generate`),
    onSuccess: (r) => {
      toast.success(r.available ? `${r.generated} critical dates generated${r.skipped_unverified ? ` · ${r.skipped_unverified} unverified terms skipped` : ""}` : "The critical-date engine is not available");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const importAi = useMutation({
    mutationFn: () => api.post<{ fields: number; clauses: number }>(`/leases/${id}/import-extractions`),
    onSuccess: (r) => {
      toast.success(`${r.fields} terms and ${r.clauses} clauses imported as unverified`);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !lease) {
    return <EmptyState title="Lease not found" description={errorMessage(error)} action={<Link href="/leases"><Button>Back to leases</Button></Link>} />;
  }

  const archive = async () => {
    try {
      await api.delete(`/leases/${id}`);
      toast.success("Lease archived");
      router.replace("/leases");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Leases", href: "/leases" }, { label: lease.tenant_name }]}
        title={lease.tenant_name}
        description={
          <>
            <Link href={`/properties/${lease.property_id}`} className="hover:underline">{lease.property_name}</Link>
            {lease.suite ? ` · Suite ${lease.suite}` : ""}
            {lease.rentable_sf ? ` · ${formatNumber(lease.rentable_sf)} SF` : ""}
          </>
        }
        meta={
          <>
            <StatusBadge status={lease.status} />
            <Badge tone="outline">{LEASE_TYPE_LABELS[lease.lease_type] ?? titleCase(lease.lease_type)}</Badge>
            {lease.verified ? <Badge tone="green" dot>Abstract verified</Badge> : <Badge tone="amber" dot>{lease.ai_extracted ? "AI-extracted · unverified" : "Unverified"}</Badge>}
            <span className="text-xs text-ink-3">
              {formatDate(lease.commencement_on)} – {formatDate(lease.expiration_on)}
              {lease.current_annual_rent != null ? ` · ${formatCurrency(lease.current_annual_rent)}/yr` : ""}
            </span>
          </>
        }
        actions={
          <>
            {can("receivables") && (
              <Link href={`/receivables/tenants/${id}`}>
                <Button>Ledger</Button>
              </Link>
            )}
            {can("leases", "edit") && (
              <>
                {lease.verified ? (
                  <Button onClick={() => verify.mutate(false)} loading={verify.isPending}>Mark unverified</Button>
                ) : (
                  <Button onClick={() => setVerifying(true)}>
                    <Check /> Verify abstract
                  </Button>
                )}
                <Button variant="primary" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon" aria-label="More actions">
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent width={240}>
                    <MenuItem icon={<CalendarClock />} onSelect={() => genDates.mutate()}>Regenerate critical dates</MenuItem>
                    <MenuItem icon={<Sparkles />} onSelect={() => importAi.mutate()}>Import AI extractions</MenuItem>
                    {can("leases", "delete") && (
                      <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>Archive lease</MenuItem>
                    )}
                  </MenuContent>
                </Menu>
              </>
            )}
          </>
        }
      />

      <UnverifiedBanner count={lease.unverified_items} leaseVerified={lease.verified} />

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "abstract" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "abstract", label: "Abstract" },
            { value: "rent", label: "Rent & recoveries" },
            { value: "options", label: "Options" },
            { value: "clauses", label: "Clauses" },
            { value: "amendments", label: "Amendments" },
            { value: "guaranties", label: "Guaranties" },
            ...(can("contracts") ? [{ value: "dates", label: "Critical dates" }] : []),
            ...(can("documents") ? [{ value: "documents", label: "Documents" }] : []),
            { value: "history", label: "Sourced terms" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="abstract">
          <AbstractSection lease={lease} />
        </TabPanel>
        <TabPanel value="rent">
          <RentSection lease={lease} />
        </TabPanel>
        <TabPanel value="options">
          <OptionsSection leaseId={id} />
        </TabPanel>
        <TabPanel value="clauses">
          <ClausesSection leaseId={id} />
        </TabPanel>
        <TabPanel value="amendments">
          <AmendmentsSection lease={lease} />
        </TabPanel>
        <TabPanel value="guaranties">
          <GuarantiesSection leaseId={id} />
        </TabPanel>
        <TabPanel value="dates">
          <div className="space-y-3">
            <p className="text-sm text-ink-2">Generated from verified terms only: expiration, escalations, option notice windows, estoppel / certificate deliveries, reporting and landlord obligations.</p>
            <RecordCriticalDates relatedType="lease" relatedId={id} relatedLabel={lease.tenant_name} propertyId={lease.property_id} />
          </div>
        </TabPanel>
        <TabPanel value="documents">
          <RecordDocuments entityType="lease" entityId={id} />
        </TabPanel>
        <TabPanel value="history">
          <SourcedFacts id={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="lease" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <LeaseFormSheet open={editing} onOpenChange={setEditing} lease={lease} />
      <ConfirmDialog
        open={verifying}
        onOpenChange={setVerifying}
        title="Verify this lease abstract?"
        description="Confirm the parties, premises, term and economics match the executed lease. Verified terms drive critical dates, billing and valuation. Recoveries, options, clauses and amendments are verified individually."
        confirmLabel="Verify abstract"
        loading={verify.isPending}
        onConfirm={() => verify.mutate(true)}
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this lease?"
        description="The abstract, its history and its ledger are retained. It will no longer appear in lists or the rent roll."
        confirmLabel="Archive"
        destructive
        onConfirm={archive}
      />
    </>
  );
}

export default function LeasePage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <LeaseDetail id={params.id} />
    </Suspense>
  );
}
