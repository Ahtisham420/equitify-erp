"use client";

import { MoreHorizontal, Pencil, Plus, Quote, Trash2, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem } from "@/components/data/page";
import { ProvenanceDot } from "@/components/data/provenance";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import {
  LEASE_TYPE_LABELS,
  OPTION_LABELS,
  PRICING_METHODS,
  RECOVERY_METHODS,
  useLeaseChildren,
  useLeaseMutation,
  useOperativeTerms,
  useReconciliations,
  type Amendment,
  type Clause,
  type Guaranty,
  type Lease,
  type LeaseOption,
  type OperativeField,
  type Recovery,
  type RentStep,
} from "./api";
import { CitationChip, VerifyControl } from "./citation";
import { AmendmentSheet, ClauseSheet, EscalationGenerator, FieldCitationDialog, GuarantySheet, OptionSheet, RecoverySheet, RentStepDialog } from "./term-forms";

/* ------------------------------------------------------------------ helpers */

function fmtValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field.endsWith("_on")) return formatDate(String(v));
  if (["base_rent_annual", "security_deposit", "late_fee_flat"].includes(field)) return formatCurrency(Number(v));
  if (field === "rentable_sf") return `${formatNumber(Number(v))} SF`;
  if (["pro_rata_share", "late_fee_pct"].includes(field)) return formatPercent(Number(v), 2);
  if (field === "lease_type") return LEASE_TYPE_LABELS[String(v)] ?? String(v);
  if (field === "status") return titleCase(String(v));
  return String(v);
}

function RowMenu({ onEdit, onRemove }: { onEdit?: () => void; onRemove?: () => void }) {
  const { can } = useAuth();
  if (!can("leases", "edit")) return null;
  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Actions">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent>
          {onEdit && <MenuItem icon={<Pencil />} onSelect={onEdit}>Edit</MenuItem>}
          {onRemove && <MenuItem icon={<Trash2 />} destructive onSelect={onRemove}>Remove</MenuItem>}
        </MenuContent>
      </Menu>
    </div>
  );
}

function useChildActions(leaseId: string, kind: string) {
  const m = useLeaseMutation(leaseId);
  const verify = (id: string, verified: boolean) =>
    m.mutate({ method: "post", path: `${kind}/${id}/verify`, body: { verified } }, {
      onSuccess: () => toast.success(verified ? "Verified" : "Marked unverified"),
      onError: (e) => toast.error(errorMessage(e)),
    });
  const remove = (id: string) =>
    m.mutate({ method: "delete", path: `${kind}/${id}` }, { onSuccess: () => toast.success("Removed"), onError: (e) => toast.error(errorMessage(e)) });
  return { verify, remove, pending: m.isPending };
}

function SectionCard({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} description={description} actions={actions} />
      {children}
    </Card>
  );
}

/* ------------------------------------------------------------------ abstract */

export function AbstractSection({ lease }: { lease: Lease }) {
  const { can } = useAuth();
  const { data: op } = useOperativeTerms(lease.id);
  const [citing, setCiting] = useState<string | null>(null);

  const field = (name: string, label: string, raw: unknown) => {
    const f: OperativeField | undefined = op?.fields[name];
    const value = f ? f.operative : raw;
    return (
      <FieldItem
        label={label}
        extra={
          <span className="flex items-center gap-1">
            <ProvenanceDot obs={lease.provenance[name]} />
            <CitationChip citation={lease.citations?.[name]} />
            {can("leases", "edit") && !lease.citations?.[name] && (
              <button type="button" onClick={() => setCiting(name)} className="text-ink-3 hover:text-ink" aria-label={`Cite ${label}`}>
                <Quote className="size-3" />
              </button>
            )}
          </span>
        }
      >
        {value === null || value === undefined || value === "" ? null : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{fmtValue(name, value)}</span>
            {f?.changed && (
              <span className="truncate text-xs text-ink-3">
                <span className="line-through">{fmtValue(name, f.original)}</span> · {f.amendment_title}
              </span>
            )}
          </span>
        )}
      </FieldItem>
    );
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Parties & premises" description="Operative values reflect the amendment chain; originals are shown struck through." />
        <CardBody>
          <FieldGrid cols={3}>
            {field("tenant_name", "Tenant", lease.tenant_name)}
            {field("landlord_name", "Landlord", lease.landlord_name)}
            <FieldItem label="Property">{lease.property_name}</FieldItem>
            <FieldItem label="Suite">{lease.suite}</FieldItem>
            {field("rentable_sf", "Rentable area", lease.rentable_sf)}
            {field("pro_rata_share", "Pro-rata share", lease.pro_rata_share)}
            {field("premises_description", "Premises", lease.premises_description)}
          </FieldGrid>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Term" />
        <CardBody>
          <FieldGrid cols={3}>
            {field("lease_type", "Lease type", lease.lease_type)}
            {field("status", "Status", lease.status)}
            <FieldItem label="Executed">{lease.execution_on ? formatDate(lease.execution_on) : null}</FieldItem>
            {field("commencement_on", "Commencement", lease.commencement_on)}
            <FieldItem label="Rent commencement">{lease.rent_commencement_on ? formatDate(lease.rent_commencement_on) : null}</FieldItem>
            {field("expiration_on", "Expiration", lease.expiration_on)}
          </FieldGrid>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Economics & default terms" />
        <CardBody>
          <FieldGrid cols={3}>
            <FieldItem label="Current annual rent">{lease.current_annual_rent != null ? formatCurrency(lease.current_annual_rent) : null}</FieldItem>
            {field("base_rent_annual", "Base rent (abstract)", lease.base_rent_annual)}
            {field("security_deposit", "Security deposit", lease.security_deposit)}
            {field("late_fee_grace_days", "Late fee grace (days)", lease.late_fee_grace_days)}
            {field("late_fee_pct", "Late fee %", lease.late_fee_pct)}
            {field("late_fee_flat", "Late fee flat", lease.late_fee_flat)}
            <FieldItem label="Market rent / SF">{lease.market_rent_psf != null ? `$${formatNumber(lease.market_rent_psf, 2)}` : null}</FieldItem>
            <FieldItem label="Renewal probability">{lease.renewal_probability != null ? formatPercent(lease.renewal_probability * 100, 0) : null}</FieldItem>
            <FieldItem label="Downtime / re-leasing">
              {lease.downtime_months != null || lease.releasing_cost_psf != null
                ? `${lease.downtime_months ?? "—"} mo · $${formatNumber(lease.releasing_cost_psf ?? 0, 2)}/SF`
                : null}
            </FieldItem>
          </FieldGrid>
        </CardBody>
      </Card>
      <FieldCitationDialog open={!!citing} onOpenChange={(o) => !o && setCiting(null)} lease={lease} field={citing} />
    </div>
  );
}

/* ------------------------------------------------------------------ rent schedule */

export function RentSection({ lease }: { lease: Lease }) {
  const { can } = useAuth();
  const { data: op, isLoading } = useOperativeTerms(lease.id);
  const { data: raw } = useLeaseChildren<RentStep>(lease.id, "rent-steps");
  const [generating, setGenerating] = useState(false);
  const [adding, setAdding] = useState(false);
  const m = useLeaseMutation(lease.id);
  const operativeIds = new Set(op?.rent_steps.map((s) => s.id));
  const superseded = (raw ?? []).filter((s) => !operativeIds.has(s.id));
  const esc = lease.escalation as Record<string, unknown>;

  const columns: Column<RentStep>[] = [
    { id: "period", header: "Period", cell: (s) => <span className="whitespace-nowrap">{formatDate(s.start_on)} – {formatDate(s.end_on)}</span> },
    { id: "annual", header: "Annual", align: "right", cell: (s) => formatCurrency(s.annual_rent) },
    { id: "monthly", header: "Monthly", align: "right", cell: (s) => formatCurrency(s.monthly_rent) },
    { id: "psf", header: "$/SF", align: "right", cell: (s) => (s.rent_psf != null ? `$${formatNumber(s.rent_psf, 2)}` : "—") },
    { id: "type", header: "Charge", cell: (s) => <span className="text-ink-2">{titleCase(s.charge_type)}</span> },
    {
      id: "source",
      header: "Source",
      cell: (s) => (
        <span className="flex items-center gap-1.5">
          <Badge tone={s.source === "amendment" ? "blue" : s.source === "generated" ? "neutral" : "outline"}>{titleCase(s.source)}</Badge>
          {s.note && <span className="text-xs text-ink-3">{s.note}</span>}
          <CitationChip citation={s} />
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (s) =>
        can("leases", "edit") ? (
          <Button size="icon-sm" variant="ghost" aria-label="Remove step" onClick={() => m.mutate({ method: "delete", path: `rent-steps/${s.id}` }, { onError: (e) => toast.error(errorMessage(e)) })}>
            <Trash2 />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <SectionCard
        title="Operative rent schedule"
        description={
          esc?.method
            ? `Escalation: ${titleCase(String(esc.method))}${esc.pct ? ` ${esc.pct}%` : ""}${esc.amount ? ` +$${esc.amount}` : ""}${esc.method === "cpi" ? ` (assumed ${esc.cpi_assumed_pct ?? "—"}%, floor ${esc.cpi_floor_pct ?? "—"}%, cap ${esc.cpi_cap_pct ?? "—"}%)` : ""} every ${esc.frequency_months ?? 12} months`
            : "Original steps with amendment steps applied from their effective dates"
        }
        actions={
          can("leases", "edit") && (
            <>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus /> Step
              </Button>
              <Button size="sm" variant="primary" onClick={() => setGenerating(true)}>
                <Wand2 /> Escalation generator
              </Button>
            </>
          )
        }
      >
        <DataTable
          columns={columns}
          data={op?.rent_steps}
          loading={isLoading}
          dense
          empty={<EmptyState title="No rent schedule" description="Use the escalation generator to build steps from the base rent and escalation terms." />}
        />
      </SectionCard>
      {superseded.length > 0 && (
        <SectionCard title="Superseded steps" description="Kept for history; replaced by later amendments.">
          <DataTable columns={columns.filter((c) => c.id !== "actions")} data={superseded} dense rowClassName={() => "text-ink-3"} />
        </SectionCard>
      )}
      <RecoveriesSection leaseId={lease.id} />
      <ReconciliationsForLease leaseId={lease.id} />
      <EscalationGenerator open={generating} onOpenChange={setGenerating} lease={lease} />
      <RentStepDialog open={adding} onOpenChange={setAdding} leaseId={lease.id} />
    </div>
  );
}

/* ------------------------------------------------------------------ recoveries */

export function RecoveriesSection({ leaseId }: { leaseId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useLeaseChildren<Recovery>(leaseId, "recoveries");
  const { verify, remove, pending } = useChildActions(leaseId, "recoveries");
  const [editing, setEditing] = useState<Recovery | null | undefined>(undefined);

  const columns: Column<Recovery>[] = [
    { id: "method", header: "Method", cell: (r) => <span className="font-medium">{RECOVERY_METHODS.find((m) => m.value === r.method)?.label ?? r.method}</span> },
    { id: "category", header: "Category", cell: (r) => (r.category === "all" ? "All recoverable" : titleCase(r.category)) },
    { id: "share", header: "Share", align: "right", cell: (r) => (r.pro_rata_share != null ? formatPercent(r.pro_rata_share, 2) : "Lease / SF") },
    {
      id: "terms",
      header: "Base / stop / fixed",
      cell: (r) => (
        <span className="text-ink-2">
          {r.method === "base_year" || r.method === "modified_gross" ? `${r.base_year ?? "—"} · ${formatCurrency(r.base_amount)}` : r.method === "expense_stop" ? `$${formatNumber(r.expense_stop_psf, 2)}/SF` : r.method === "fixed_cam" ? `${formatCurrency(r.fixed_amount_annual)}/yr` : "—"}
        </span>
      ),
    },
    { id: "cap", header: "Cap", cell: (r) => (r.cap_type === "none" ? <span className="text-ink-3">None</span> : `${formatPercent(r.cap_pct, 1)} ${r.cap_type === "cumulative" ? "cumulative" : "non-cumulative"}`) },
    { id: "exclusions", header: "Exclusions", cell: (r) => <span className="text-xs text-ink-2">{r.exclusions.length ? r.exclusions.join(", ") : "—"}</span> },
    { id: "est", header: "Est. monthly", align: "right", cell: (r) => formatCurrency(r.estimated_monthly) },
    { id: "cite", header: "Source", cell: (r) => <CitationChip citation={r} /> },
    { id: "verified", header: "Verification", cell: (r) => <VerifyControl verified={r.verified} aiExtracted={r.ai_extracted} verifiedAt={r.verified_at} pending={pending} onToggle={(v) => verify(r.id, v)} compact /> },
    { id: "actions", header: "", align: "right", cell: (r) => <RowMenu onEdit={() => setEditing(r)} onRemove={() => remove(r.id)} /> },
  ];

  return (
    <SectionCard
      title="Recoveries"
      description="Recovery method, exclusions, caps and expense stops. Only verified recoveries are billed or reconciled."
      actions={can("leases", "edit") && <Button size="sm" onClick={() => setEditing(null)}><Plus /> Recovery</Button>}
    >
      <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No recovery terms" description="Gross leases may have none." />} />
      <RecoverySheet open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} leaseId={leaseId} row={editing} />
    </SectionCard>
  );
}

function ReconciliationsForLease({ leaseId }: { leaseId: string }) {
  const { data } = useReconciliations({ lease_id: leaseId });
  if (!data?.length) return null;
  return (
    <SectionCard title="Recovery reconciliations" description="Annual true-ups computed from recoverable expense pools.">
      <DataTable
        dense
        data={data}
        columns={[
          { id: "year", header: "Year", cell: (r) => <span className="font-medium tabular">{r.year}</span> },
          { id: "share", header: "Share", align: "right", cell: (r) => formatPercent(r.share_pct, 2) },
          { id: "budget", header: "Budgeted", align: "right", cell: (r) => formatCurrency(r.budgeted_share) },
          { id: "actual", header: "Actual", align: "right", cell: (r) => formatCurrency(r.actual_share) },
          { id: "cap", header: "Cap savings", align: "right", cell: (r) => formatCurrency(r.cap_reduction) },
          { id: "billed", header: "Estimates billed", align: "right", cell: (r) => formatCurrency(r.estimates_billed) },
          { id: "trueup", header: "True-up", align: "right", cell: (r) => <span className={cn("font-medium", r.true_up_amount < 0 && "text-positive")}>{formatCurrency(r.true_up_amount)}</span> },
          { id: "status", header: "Status", cell: (r) => <StatusBadge status={r.status === "final" ? "approved" : r.status === "billed" ? "completed" : "draft"} label={titleCase(r.status)} /> },
        ]}
      />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ options */

function Economics({ o }: { o: LeaseOption }) {
  const e = o.economics;
  if (!e) return <span className="text-ink-3">—</span>;
  if (o.option_type === "renewal" || o.option_type === "expansion") {
    if (e.option_rent_psf == null || e.market_rent_psf == null) return <span className="text-xs text-ink-3">{e.note}</span>;
    return (
      <div className="text-xs">
        <p className="tabular text-ink">
          ${formatNumber(e.option_rent_psf, 2)} option vs ${formatNumber(e.market_rent_psf, 2)} market
        </p>
        <p className={cn("tabular", e.favors === "tenant" ? "text-caution" : "text-ink-3")}>
          {e.term_value != null ? `${formatCurrency(Math.abs(e.term_value), { compact: true })} over term ${e.favors === "tenant" ? "to tenant" : e.favors === "landlord" ? "to landlord" : ""}` : e.note}
        </p>
      </div>
    );
  }
  if (o.option_type === "termination")
    return (
      <div className="text-xs">
        <p className="tabular text-ink">Fee {formatCurrency(e.fee_amount)} · remaining rent {formatCurrency(e.remaining_rent, { compact: true })}</p>
        {e.note && <p className="text-ink-3">{e.note}</p>}
      </div>
    );
  if (o.option_type === "purchase")
    return (
      <div className="text-xs">
        <p className="tabular text-ink">Price {formatCurrency(e.purchase_price, { compact: true })} · mark {formatCurrency(e.market_value, { compact: true })}</p>
        {e.note && <p className="text-ink-3">{e.note}</p>}
      </div>
    );
  return <span className="text-xs text-ink-3">{e.note}</span>;
}

export function OptionsSection({ leaseId }: { leaseId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useLeaseChildren<LeaseOption>(leaseId, "options");
  const { verify, remove, pending } = useChildActions(leaseId, "options");
  const [editing, setEditing] = useState<LeaseOption | null | undefined>(undefined);

  const columns: Column<LeaseOption>[] = [
    { id: "type", header: "Option", cell: (o) => <span className="font-medium">{OPTION_LABELS[o.option_type] ?? o.option_type} #{o.sequence}</span> },
    { id: "term", header: "Term", cell: (o) => (o.term_months ? `${o.term_months} mo` : "—") },
    {
      id: "notice",
      header: "Notice window",
      cell: (o) => <span className="whitespace-nowrap text-ink-2">{o.notice_start_on || o.notice_end_on ? `${formatDate(o.notice_start_on)} – ${formatDate(o.notice_end_on)}` : "—"}</span>,
    },
    { id: "pricing", header: "Pricing", cell: (o) => <span className="text-ink-2">{PRICING_METHODS.find((p) => p.value === o.pricing_method)?.label ?? o.pricing_method}</span> },
    { id: "economics", header: "Economics", cell: (o) => <Economics o={o} /> },
    { id: "status", header: "Status", cell: (o) => <StatusBadge status={o.status === "exercised" ? "completed" : o.status === "open" ? "open" : "expired"} label={titleCase(o.status)} /> },
    { id: "cite", header: "Source", cell: (o) => <CitationChip citation={o} /> },
    { id: "verified", header: "Verification", cell: (o) => <VerifyControl verified={o.verified} aiExtracted={o.ai_extracted} verifiedAt={o.verified_at} pending={pending} onToggle={(v) => verify(o.id, v)} compact /> },
    { id: "actions", header: "", align: "right", cell: (o) => <RowMenu onEdit={() => setEditing(o)} onRemove={() => remove(o.id)} /> },
  ];

  return (
    <SectionCard
      title="Options"
      description="Renewal, expansion, termination, purchase, ROFR and ROFO with notice windows. Verified notice deadlines become critical dates."
      actions={can("leases", "edit") && <Button size="sm" onClick={() => setEditing(null)}><Plus /> Option</Button>}
    >
      <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No options abstracted" />} />
      <OptionSheet open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} leaseId={leaseId} row={editing} />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ clauses */

const CLAUSE_GROUPS: { title: string; categories: string[] }[] = [
  { title: "Use, exclusives & co-tenancy", categories: ["use", "exclusive", "cotenancy", "kickout", "radius", "relocation"] },
  { title: "Assignment & subletting", categories: ["assignment", "subletting", "sna"] },
  { title: "Maintenance, insurance & holdover", categories: ["maintenance", "replacement", "insurance", "holdover"] },
  { title: "Default & remedies", categories: ["default", "remedies"] },
  { title: "Estoppels, certificates, reporting & landlord obligations", categories: ["estoppel", "certificate", "reporting", "landlord_obligation"] },
  { title: "Other", categories: ["other"] },
];

export function ClausesSection({ leaseId }: { leaseId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useLeaseChildren<Clause>(leaseId, "clauses");
  const { verify, remove, pending } = useChildActions(leaseId, "clauses");
  const [editing, setEditing] = useState<Clause | null | undefined>(undefined);
  const [defaultCategory, setDefaultCategory] = useState<string | undefined>();

  const columns: Column<Clause>[] = [
    {
      id: "clause",
      header: "Clause",
      cell: (c) => (
        <div className="min-w-[240px] max-w-[520px] py-0.5">
          <p className="flex items-center gap-1.5 font-medium text-ink">
            {c.title}
            <Badge tone="outline">{c.category === "sna" ? "SNDA" : titleCase(c.category)}</Badge>
          </p>
          {c.summary && <p className="whitespace-normal text-xs text-ink-2">{c.summary}</p>}
          {Object.keys(c.terms ?? {}).length > 0 && (
            <p className="mt-0.5 whitespace-normal text-xs text-ink-3">
              {Object.entries(c.terms).map(([k, v]) => `${titleCase(k)}: ${String(v)}`).join(" · ")}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "due",
      header: "Obligation",
      cell: (c) => (c.due_on || c.obligated_party ? <span className="whitespace-nowrap text-xs text-ink-2">{[c.obligated_party ? titleCase(c.obligated_party) : null, c.due_on ? `due ${formatDate(c.due_on)}` : null, c.recurrence].filter(Boolean).join(" · ")}</span> : <span className="text-ink-3">—</span>),
    },
    { id: "cite", header: "Source", cell: (c) => <CitationChip citation={c} /> },
    { id: "verified", header: "Verification", cell: (c) => <VerifyControl verified={c.verified} aiExtracted={c.ai_extracted} verifiedAt={c.verified_at} pending={pending} onToggle={(v) => verify(c.id, v)} compact /> },
    { id: "actions", header: "", align: "right", cell: (c) => <RowMenu onEdit={() => setEditing(c)} onRemove={() => remove(c.id)} /> },
  ];

  if (!isLoading && !data?.length) {
    return (
      <Card>
        <EmptyState
          icon={<Quote />}
          title="No clauses abstracted"
          description="Record use, exclusive, co-tenancy, assignment, maintenance, insurance, holdover and default terms with their citations."
          action={can("leases", "edit") ? <Button variant="primary" onClick={() => setEditing(null)}><Plus /> Add clause</Button> : undefined}
        />
        <ClauseSheet open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} leaseId={leaseId} row={editing} />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {CLAUSE_GROUPS.map((g) => {
        const rows = (data ?? []).filter((c) => g.categories.includes(c.category));
        return (
          <SectionCard
            key={g.title}
            title={g.title}
            actions={
              can("leases", "edit") && (
                <Button size="sm" onClick={() => { setDefaultCategory(g.categories[0]); setEditing(null); }}>
                  <Plus /> Clause
                </Button>
              )
            }
          >
            <DataTable columns={columns} data={rows} loading={isLoading} dense empty={<p className="px-4 py-4 text-sm text-ink-3">Nothing abstracted.</p>} />
          </SectionCard>
        );
      })}
      <ClauseSheet open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} leaseId={leaseId} row={editing} defaultCategory={defaultCategory} />
    </div>
  );
}

/* ------------------------------------------------------------------ guaranties */

export function GuarantiesSection({ leaseId }: { leaseId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useLeaseChildren<Guaranty>(leaseId, "guaranties");
  const { verify, remove, pending } = useChildActions(leaseId, "guaranties");
  const [editing, setEditing] = useState<Guaranty | null | undefined>(undefined);

  const columns: Column<Guaranty>[] = [
    { id: "name", header: "Guarantor", cell: (g) => <span className="font-medium">{g.guarantor_name}</span> },
    { id: "type", header: "Type", cell: (g) => titleCase(g.guaranty_type) },
    { id: "cap", header: "Cap", align: "right", cell: (g) => (g.cap_amount != null ? formatCurrency(g.cap_amount) : "Unlimited") },
    { id: "term", header: "Term", cell: (g) => <span className="whitespace-nowrap text-ink-2">{formatDate(g.effective_on)} – {formatDate(g.expires_on)}</span> },
    {
      id: "obligations",
      header: "Obligations",
      cell: (g) => (
        <span className="text-xs text-ink-2">
          {[g.financials_required ? `Financials due ${formatDate(g.financials_due_on)}` : null, g.estoppel_days ? `Estoppel within ${g.estoppel_days} days` : null].filter(Boolean).join(" · ") || "—"}
        </span>
      ),
    },
    { id: "status", header: "Status", cell: (g) => <StatusBadge status={g.status} /> },
    { id: "cite", header: "Source", cell: (g) => <CitationChip citation={g} /> },
    { id: "verified", header: "Verification", cell: (g) => <VerifyControl verified={g.verified} aiExtracted={g.ai_extracted} verifiedAt={g.verified_at} pending={pending} onToggle={(v) => verify(g.id, v)} compact /> },
    { id: "actions", header: "", align: "right", cell: (g) => <RowMenu onEdit={() => setEditing(g)} onRemove={() => remove(g.id)} /> },
  ];

  return (
    <SectionCard
      title="Guaranties"
      description="Guarantors, caps, burn-downs and their estoppel / financial reporting obligations."
      actions={can("leases", "edit") && <Button size="sm" onClick={() => setEditing(null)}><Plus /> Guaranty</Button>}
    >
      <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No guaranties" />} />
      <GuarantySheet open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} leaseId={leaseId} row={editing} />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ amendment chain */

export function AmendmentsSection({ lease }: { lease: Lease }) {
  const { can } = useAuth();
  const { data: chain, isLoading } = useLeaseChildren<Amendment>(lease.id, "amendments");
  const { data: op } = useOperativeTerms(lease.id);
  const m = useLeaseMutation(lease.id);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Amendment | null>(null);
  const changed = Object.entries(op?.fields ?? {}).filter(([, f]) => f.changed);
  const pending = new Set(op?.pending_amendments ?? []);

  const verify = (a: Amendment, verified: boolean) =>
    m.mutate({ method: "post", path: `amendments/${a.id}/verify`, body: { verified } }, {
      onSuccess: () => { toast.success(verified ? "Amendment verified" : "Marked unverified"); setConfirm(null); },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title="Document chain"
          description="Lease, amendments, assignments, guaranties and side letters in effective-date order. Nothing is deleted."
          actions={can("leases", "edit") && <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add document</Button>}
        />
        <CardBody>
          <ol className="relative space-y-5 border-l border-line pl-5">
            <li className="relative">
              <span className="absolute -left-[25px] top-1 size-2.5 rounded-full border-2 border-surface bg-ink" />
              <p className="text-sm font-medium text-ink">Original lease</p>
              <p className="text-xs text-ink-3">
                {lease.execution_on ? `Executed ${formatDate(lease.execution_on)} · ` : ""}Commenced {formatDate(lease.commencement_on)}
              </p>
            </li>
            {isLoading && <li className="text-sm text-ink-3">Loading…</li>}
            {(chain ?? []).map((a) => (
              <li key={a.id} className="relative">
                <span className={cn("absolute -left-[25px] top-1 size-2.5 rounded-full border-2 border-surface", pending.has(a.id) ? "bg-line-strong" : "bg-accent")} />
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-ink">{a.title}</p>
                  <Badge tone="outline">{titleCase(a.kind)}</Badge>
                  {pending.has(a.id) && <Badge tone="sky">Future effective</Badge>}
                  <VerifyControl verified={a.verified} verifiedAt={a.verified_at} pending={m.isPending} onToggle={(v) => (v ? setConfirm(a) : verify(a, false))} compact />
                  <CitationChip citation={{ document_id: a.document_id, page: a.page, clause_ref: a.clause_ref, quoted_text: null }} />
                </div>
                <p className="text-xs text-ink-3">
                  Effective {formatDate(a.effective_on)}
                  {a.executed_on ? ` · executed ${formatDate(a.executed_on)}` : ""}
                </p>
                {a.summary && <p className="mt-1 text-sm text-ink-2">{a.summary}</p>}
                {Object.keys(a.overrides).length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-xs">
                    {Object.entries(a.overrides).map(([k, v]) => (
                      <li key={k} className="text-ink-2">
                        <span className="text-ink-3">{titleCase(k)}:</span> {fmtValue(k, v)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Operative vs original" description={op ? `As of ${formatDate(op.as_of)}` : undefined} />
        <CardBody className="space-y-3">
          {changed.length === 0 && <p className="text-sm text-ink-3">No terms changed by amendments.</p>}
          {changed.map(([k, f]) => (
            <div key={k} className="text-sm">
              <p className="text-xs text-ink-3">{titleCase(k)}</p>
              <p className="tabular">
                <span className="text-ink-3 line-through">{fmtValue(k, f.original)}</span> <span className="text-ink">{fmtValue(k, f.operative)}</span>
              </p>
              <p className="text-xs text-ink-3">
                {f.amendment_title} · {formatDate(f.effective_on)} {!f.verified && <Badge tone="amber">Unverified</Badge>}
              </p>
            </div>
          ))}
        </CardBody>
      </Card>
      <AmendmentSheet open={adding} onOpenChange={setAdding} leaseId={lease.id} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Verify this amendment?"
        description="Confirm the overrides and replacement rent steps match the executed document. Verified amendments drive critical dates and billing."
        confirmLabel="Verify"
        loading={m.isPending}
        onConfirm={() => confirm && verify(confirm, true)}
      />
    </div>
  );
}

export { fmtValue };
