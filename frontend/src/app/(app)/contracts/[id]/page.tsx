"use client";

import { AlertOctagon, CheckCircle2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Progress, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, titleCase } from "@/lib/utils";

import { ContractActivity } from "@/features/contracts/activity-list";
import {
  ANCHOR_LABELS,
  CONTRACT_TYPE_LABELS,
  DATE_STATUS_LABELS,
  TERM_FIELDS,
  useCalendars,
  useContract,
  useContractStatus,
  useDeleteContract,
  type Blocker,
  type Contract,
  type ContractStatus,
} from "@/features/contracts/api";
import { ContractDatesTab } from "@/features/contracts/contract-dates-tab";
import { ContractFormSheet, ExecuteDialog } from "@/features/contracts/contract-form";
import { DDTab } from "@/features/contracts/dd-tab";
import { EstoppelsTab } from "@/features/contracts/estoppels-tab";
import { ReportsTab } from "@/features/contracts/reports-tab";
import { RisksTab } from "@/features/contracts/risks-tab";
import { TitleSurveyTab } from "@/features/contracts/title-tab";

const CONTRACT_TONES = { draft: "neutral", executed: "green", closed: "sky", terminated: "red" } as const;

const BLOCKER_TAB: Record<Blocker["kind"], string> = {
  critical_date: "dates",
  dd_item: "dd",
  risk: "risks",
  estoppel: "estoppels",
  title_exception: "title",
  third_party_report: "reports",
};

function Countdown({ label, days, date, sub, tone }: { label: string; days: number | null; date: string | null; sub?: ReactNode; tone?: "neutral" | "caution" | "negative" }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p className={cn("mt-1.5 text-2xl font-semibold tracking-tight tabular", tone === "negative" && "text-negative", tone === "caution" && "text-caution")}>
        {days === null ? (date ? formatDate(date) : "—") : days < 0 ? `${-days} days past` : days === 0 ? "Today" : `${days} days`}
      </p>
      <div className="mt-1 text-xs text-ink-3">{sub ?? (date ? formatDate(date) : "Not set")}</div>
    </div>
  );
}

function Header({ c, s, onTab }: { c: Contract; s: ContractStatus | undefined; onTab: (t: string) => void }) {
  const feasTone = s?.days_to_feasibility == null ? "neutral" : s.days_to_feasibility < 0 ? "negative" : s.days_to_feasibility <= 7 ? "caution" : "neutral";
  const closeTone = s?.days_to_closing == null ? "neutral" : s.days_to_closing < 0 ? "negative" : s.days_to_closing <= 7 ? "caution" : "neutral";
  const counts = s?.counts ?? {};
  const ddPct = counts.dd_total ? (100 * (counts.dd_done ?? 0)) / counts.dd_total : 0;
  const blockers = s?.blockers ?? [];
  return (
    <div className="mb-5 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Countdown
          label="Feasibility deadline"
          days={s?.days_to_feasibility ?? null}
          date={s?.feasibility_on ?? null}
          tone={feasTone}
          sub={
            s?.feasibility_on ? (
              <span className="flex items-center gap-1.5">
                {formatDate(s.feasibility_on)}
                {s.feasibility_status && s.feasibility_status !== "confirmed" && (
                  <Badge tone={s.feasibility_status === "proposed" ? "amber" : s.feasibility_status === "missed" ? "red" : "neutral"}>
                    {s.feasibility_status === "proposed" ? "Unconfirmed" : DATE_STATUS_LABELS[s.feasibility_status] ?? s.feasibility_status}
                  </Badge>
                )}
              </span>
            ) : c.status === "draft" ? (
              "Set when the contract is executed"
            ) : (
              "Not set"
            )
          }
        />
        <Countdown label="Closing" days={s?.days_to_closing ?? null} date={s?.closing_on ?? null} tone={closeTone} />
        <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
          <p className="text-xs font-medium text-ink-3">Due diligence</p>
          <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular">
            {counts.dd_done ?? 0}
            <span className="text-base font-normal text-ink-3"> / {counts.dd_total ?? 0}</span>
          </p>
          <Progress value={ddPct} className="mt-2" tone="accent" />
          <p className="mt-1 text-xs text-ink-3">
            {counts.reports_delivered ?? 0} of {counts.reports_total ?? 0} reports in · {counts.dates_proposed ?? 0} dates unconfirmed
          </p>
        </div>
        <button type="button" onClick={() => blockers.length && onTab(BLOCKER_TAB[blockers[0].kind])} className="rounded-lg border border-line bg-surface p-4 text-left shadow-card transition-colors hover:bg-subtle/50">
          <p className="text-xs font-medium text-ink-3">Blockers</p>
          <p className={cn("mt-1.5 text-2xl font-semibold tracking-tight tabular", blockers.length ? "text-negative" : "text-positive")}>{blockers.length}</p>
          <p className="mt-1 text-xs text-ink-3">{counts.risks_need_decision ? `${counts.risks_need_decision} risks need a decision` : blockers.length ? "Open items need attention" : "Nothing blocking"}</p>
        </button>
      </div>

      {blockers.length > 0 && (
        <Card className="border-negative/30">
          <CardHeader title={<span className="flex items-center gap-2"><AlertOctagon className="size-4 text-negative" /> Blockers</span>} description="Unconfirmed or missed deadlines, open high-severity findings, risks without a decision and unresolved discrepancies." />
          <ul className="divide-y divide-line">
            {blockers.slice(0, 12).map((b) => (
              <li key={`${b.kind}-${b.id}`}>
                <button type="button" onClick={() => onTab(BLOCKER_TAB[b.kind])} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-subtle/60">
                  <StatusBadge status={b.severity} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{b.label}</span>
                  {b.detail && <span className="hidden max-w-[40%] truncate text-xs text-ink-3 md:inline">{b.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
          {blockers.length > 12 && <p className="border-t border-line px-4 py-2 text-xs text-ink-3">{blockers.length - 12} more</p>}
        </Card>
      )}
    </div>
  );
}

function TermsTab({ c }: { c: Contract }) {
  const { data: calendars } = useCalendars();
  const terms = c.key_terms ?? {};
  const calendar = calendars?.find((x) => x.id === c.calendar_id) ?? calendars?.find((x) => x.is_default);
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Key terms" description="Inputs to the date engine. Blank core terms fall back to defaults that must be verified." />
        <CardBody>
          <FieldGrid cols={3}>
            <FieldItem label="Purchase price">{c.purchase_price != null ? formatCurrency(c.purchase_price) : null}</FieldItem>
            <FieldItem label="Earnest money">{c.earnest_money != null ? formatCurrency(c.earnest_money) : null}</FieldItem>
            <FieldItem label="Additional deposit">{c.additional_deposit != null ? formatCurrency(c.additional_deposit) : null}</FieldItem>
            <FieldItem label="Effective">{c.effective_on ? formatDate(c.effective_on) : null}</FieldItem>
            <FieldItem label="Executed">{c.executed_on ? formatDate(c.executed_on) : null}</FieldItem>
            <FieldItem label="Holiday calendar">{calendar?.name}</FieldItem>
            {TERM_FIELDS.map((f) => (
              <FieldItem key={f.key} label={f.label}>
                {terms[f.key] !== undefined && terms[f.key] !== null ? String(terms[f.key]) : null}
              </FieldItem>
            ))}
            <FieldItem label="Closing counted from">{ANCHOR_LABELS[String(terms.closing_from ?? "feasibility_expiry")]}</FieldItem>
            <FieldItem label="Day convention">{terms.business_days ? "Business days" : "Calendar days"}</FieldItem>
          </FieldGrid>
          {c.notes && (
            <div className="mt-4 border-t border-line pt-4 text-sm">
              <p className="text-xs text-ink-3">Notes</p>
              <p className="whitespace-pre-wrap text-ink-2">{c.notes}</p>
            </div>
          )}
        </CardBody>
      </Card>
      <div className="space-y-5">
        <Card>
          <CardHeader title="Parties" />
          <CardBody>
            {c.parties.length === 0 ? (
              <p className="text-sm text-ink-3">No parties recorded.</p>
            ) : (
              <ul className="space-y-2">
                {c.parties.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink">{p.name}</span>
                    <Badge tone="outline">{titleCase(p.role)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Source and linkage" />
          <CardBody>
            <FieldGrid cols={1}>
              <FieldItem label="Contract document">{c.document_id ? <Badge tone="outline">Linked</Badge> : null}</FieldItem>
              <FieldItem label="Opportunity">
                {c.opportunity_id ? (
                  <Link className="text-accent hover:underline" href={`/pipeline/${c.opportunity_id}`}>
                    {c.opportunity_label ?? "Open"}
                  </Link>
                ) : null}
              </FieldItem>
              <FieldItem label="Offer">{c.offer_id ? <Badge tone="outline">Linked</Badge> : null}</FieldItem>
              <FieldItem label="Executed at">{c.executed_at ? formatDateTime(c.executed_at) : null}</FieldItem>
              <FieldItem label="Created">{formatDateTime(c.created_at)}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function ContractDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: c, isLoading, error } = useContract(id);
  const { data: s } = useContractStatus(id);
  const remove = useDeleteContract();
  const [editing, setEditing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const tab = url.get("tab") ?? "dates";
  const setTab = (t: string) => url.set({ tab: t === "dates" ? null : t });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !c) {
    return <EmptyState title="Contract not found" description={errorMessage(error)} action={<Link href="/contracts"><Button>Back to contracts</Button></Link>} />;
  }

  const editable = can("contracts", "edit") && !["closed", "terminated"].includes(c.status);
  const counts = s?.counts ?? {};

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: c.title }]}
        title={c.title}
        description={
          c.property_id ? (
            <Link href={`/properties/${c.property_id}`} className="hover:underline">
              {c.property_label ?? "Property"}
            </Link>
          ) : undefined
        }
        meta={
          <>
            <Badge tone={CONTRACT_TONES[c.status as keyof typeof CONTRACT_TONES] ?? "neutral"} dot>
              {titleCase(c.status)}
            </Badge>
            <Badge tone="outline">{CONTRACT_TYPE_LABELS[c.contract_type] ?? titleCase(c.contract_type)}</Badge>
            {c.purchase_price != null && <span className="text-xs text-ink-2 tabular">{formatCurrency(c.purchase_price)}</span>}
            {c.effective_on && <span className="text-xs text-ink-3">Effective {formatDate(c.effective_on)}</span>}
            {c.owner_name && (
              <span className="flex items-center gap-1 text-xs text-ink-3">
                <Avatar name={c.owner_name} size={18} /> {c.owner_name}
              </span>
            )}
          </>
        }
        actions={
          <>
            {editable && c.status === "draft" && (
              <Button variant="primary" onClick={() => setExecuting(true)}>
                <CheckCircle2 /> Mark executed
              </Button>
            )}
            {editable && (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can("contracts", "delete") && c.status === "draft" && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<Trash2 />} destructive onSelect={() => setDeleting(true)}>
                    Delete draft
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      {c.status === "terminated" && (
        <div className="mb-5 rounded-lg border border-negative/30 bg-negative-soft px-4 py-3 text-sm">
          <p className="font-medium text-negative">Terminated {c.terminated_at ? formatDate(c.terminated_at) : ""}</p>
          <p className="text-ink-2">Open deadlines were waived. See Risks &amp; decisions for the recorded reasoning.</p>
        </div>
      )}

      <Header c={c} s={s} onTab={setTab} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList
          className="mb-5 overflow-x-auto scrollbar-thin"
          tabs={[
            { value: "dates", label: "Critical dates", count: counts.dates_proposed || undefined },
            { value: "dd", label: "DD checklist", count: counts.dd_total ? counts.dd_total - (counts.dd_done ?? 0) : undefined },
            { value: "reports", label: "Third-party reports", count: counts.reports_total || undefined },
            { value: "title", label: "Title & survey", count: counts.title_open || undefined },
            { value: "estoppels", label: "Estoppels / SNDA", count: counts.discrepancies || undefined },
            { value: "risks", label: "Risks & decisions", count: counts.risks_need_decision || undefined },
            { value: "terms", label: "Terms" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="dates">
          <ContractDatesTab contract={c} />
        </TabPanel>
        <TabPanel value="dd">
          <DDTab contract={c} />
        </TabPanel>
        <TabPanel value="reports">
          <ReportsTab contract={c} />
        </TabPanel>
        <TabPanel value="title">
          <TitleSurveyTab contract={c} />
        </TabPanel>
        <TabPanel value="estoppels">
          <EstoppelsTab contract={c} />
        </TabPanel>
        <TabPanel value="risks">
          <RisksTab contract={c} feasibilityOn={s?.feasibility_on ?? null} />
        </TabPanel>
        <TabPanel value="terms">
          <TermsTab c={c} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <ContractActivity contractId={c.id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      {editable && <ContractFormSheet open={editing} onOpenChange={setEditing} contract={c} />}
      {editable && c.status === "draft" && <ExecuteDialog open={executing} onOpenChange={setExecuting} contract={c} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this draft contract?"
        description="Only drafts can be deleted. The record is retained for audit."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(c.id, {
            onSuccess: () => {
              toast.success("Contract deleted");
              router.replace("/contracts");
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

export default function ContractPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <ContractDetail id={params.id} />
    </Suspense>
  );
}
