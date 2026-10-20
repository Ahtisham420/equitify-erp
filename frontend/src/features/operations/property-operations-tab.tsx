"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Calculator, HardHat, Landmark, Umbrella } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { StatCard } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { api, type Page } from "@/lib/api";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import {
  useAssessmentsFor,
  usePoliciesFor,
  useProjectsFor,
  useTaxSummary,
  type BudgetListItem,
  type Protest,
  type TaxPayment,
} from "./api";
import { DaysLeft, OpsStatusBadge } from "./insurance-tabs";
import { ProjectStatusBadge, categoryLabel } from "./project-form";

const CLOSED_PROJECT = ["completed", "closed", "cancelled"];
const ACTIVE_PROTEST = ["considering", "filed", "evidence_submitted", "hearing_scheduled"];

function SectionCard({
  title,
  icon,
  href,
  linkLabel,
  loading,
  empty,
  count,
  children,
}: {
  title: string;
  icon: ReactNode;
  href: string;
  linkLabel: string;
  loading: boolean;
  empty: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <span className="text-ink-3 [&>svg]:size-4">{icon}</span>
            {title}
          </span>
        }
        actions={
          <Link href={href} className="flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            {linkLabel} <ArrowRight className="size-3" />
          </Link>
        }
      />
      {loading ? (
        <CardBody className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </CardBody>
      ) : count === 0 ? (
        <CardBody>
          <p className="text-sm text-ink-3">{empty}</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-line">{children}</ul>
      )}
    </Card>
  );
}

function Row({ href, primary, secondary, right }: { href: string; primary: ReactNode; secondary?: ReactNode; right?: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-subtle">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{primary}</p>
          {secondary && <p className="truncate text-xs text-ink-3">{secondary}</p>}
        </div>
        {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
      </Link>
    </li>
  );
}

/** Operations summary for a property: insurance, property tax, capital projects and budgets. */
export function PropertyOperationsTab({ propertyId }: { propertyId: string }) {
  const policies = usePoliciesFor({ property_id: propertyId, sort: "expires_on" });
  const assessments = useAssessmentsFor({ property_id: propertyId, sort: "-tax_year" });
  const taxSummary = useTaxSummary({ property_id: propertyId });
  const projects = useProjectsFor({ property_id: propertyId, sort: "-updated_at" });
  const protests = useQuery({
    queryKey: ["tax", "protests", "embedded", { property_id: propertyId }],
    queryFn: () => api.get<Page<Protest>>("/tax/protests", { property_id: propertyId, page_size: 50, sort: "-tax_year" }),
  });
  const payments = useQuery({
    queryKey: ["tax", "payments", "embedded", { property_id: propertyId }],
    queryFn: () => api.get<Page<TaxPayment>>("/tax/payments", { property_id: propertyId, page_size: 50, sort: "-due_on" }),
  });
  const budgets = useQuery({
    queryKey: ["budgets", "list", "embedded", { property_id: propertyId }],
    queryFn: () => api.get<Page<BudgetListItem>>("/budgets", { property_id: propertyId, page_size: 50, sort: "-fiscal_year" }),
  });

  const policyItems = (policies.data?.items ?? []).filter((p) => p.status !== "cancelled");
  const activePolicies = policyItems.filter((p) => p.status === "active" || p.status === "pending_renewal");
  const expiringSoon = activePolicies.filter((p) => p.days_to_expiry != null && p.days_to_expiry <= 60).length;
  const lapsed = policyItems.filter((p) => p.status === "expired" || (p.days_to_expiry != null && p.days_to_expiry < 0)).length;

  const projectItems = projects.data?.items ?? [];
  const openProjects = projectItems.filter((p) => !CLOSED_PROJECT.includes(p.status));
  const openBudget = openProjects.reduce((a, p) => a + (p.current_budget ?? 0), 0);

  const protestItems = protests.data?.items ?? [];
  const paymentItems = payments.data?.items ?? [];
  const unpaid = paymentItems.filter((p) => p.status === "scheduled" || p.status === "late");
  const assessmentItems = assessments.data?.items ?? [];
  const latestAssessment = assessmentItems.reduce<(typeof assessmentItems)[number] | undefined>((best, a) => (!best || a.tax_year > best.tax_year ? a : best), undefined);

  const budgetItems = budgets.data?.items ?? [];
  const yearsShown = new Set<number>();
  // One row per fiscal year: the approved version if any, otherwise the latest.
  const budgetRows = [...budgetItems]
    .sort((a, b) => b.fiscal_year - a.fiscal_year || (a.status === "approved" ? -1 : b.status === "approved" ? 1 : b.version - a.version))
    .filter((b) => (yearsShown.has(b.fiscal_year) ? false : (yearsShown.add(b.fiscal_year), true)));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Active policies"
          value={policies.isLoading ? "—" : formatNumber(activePolicies.length)}
          hint={lapsed ? `${lapsed} lapsed` : expiringSoon ? `${expiringSoon} expiring within 60 days` : undefined}
          tone={lapsed ? "negative" : expiringSoon ? "caution" : "default"}
        />
        <StatCard
          label="Tax payments due"
          value={payments.isLoading ? "—" : formatCurrency(unpaid.reduce((a, p) => a + p.amount_due, 0))}
          hint={unpaid.length ? `${unpaid.length} unpaid installment${unpaid.length === 1 ? "" : "s"}` : undefined}
          tone={unpaid.some((p) => p.status === "late") ? "negative" : "default"}
        />
        <StatCard label="Open capital projects" value={projects.isLoading ? "—" : formatNumber(openProjects.length)} hint={openProjects.length ? `${formatCurrency(openBudget, { compact: true })} budgeted` : undefined} />
        <StatCard
          label="Protest net savings"
          value={taxSummary.data ? formatCurrency(taxSummary.data.total_net_savings, { compact: true }) : "—"}
          hint={taxSummary.data?.success_rate != null ? `${formatPercent(taxSummary.data.success_rate, 0)} success rate` : undefined}
          tone={taxSummary.data && taxSummary.data.total_net_savings > 0 ? "positive" : "default"}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard
          title="Insurance policies"
          icon={<Umbrella />}
          href={`/insurance?property_id=${propertyId}`}
          linkLabel="Insurance"
          loading={policies.isLoading}
          count={policyItems.length}
          empty="No policies recorded for this property."
        >
          {policyItems.slice(0, 8).map((p) => (
            <Row
              key={p.id}
              href={`/insurance?property_id=${propertyId}`}
              primary={`${titleCase(p.coverage_type)} · ${p.carrier}`}
              secondary={[p.policy_number, p.limit_amount != null ? `${formatCurrency(p.limit_amount, { compact: true })} limit` : null, `Expires ${formatDate(p.expires_on)}`]
                .filter(Boolean)
                .join(" · ")}
              right={
                <>
                  {p.open_claims > 0 && <Badge tone="amber">{p.open_claims} claim{p.open_claims === 1 ? "" : "s"}</Badge>}
                  {p.status === "active" || p.status === "pending_renewal" ? <DaysLeft days={p.days_to_expiry} /> : <OpsStatusBadge status={p.status} />}
                </>
              }
            />
          ))}
        </SectionCard>

        <SectionCard
          title="Property tax"
          icon={<Landmark />}
          href={`/insurance?tab=tax&property_id=${propertyId}`}
          linkLabel="Property tax"
          loading={assessments.isLoading || protests.isLoading || payments.isLoading}
          count={assessmentItems.length + protestItems.length + paymentItems.length}
          empty="No assessments, protests or tax payments recorded."
        >
          {latestAssessment && (
            <Row
              href={`/insurance?tab=tax&property_id=${propertyId}`}
              primary={`${latestAssessment.tax_year} assessment · ${formatCurrency(latestAssessment.assessed_total)}`}
              secondary={[
                latestAssessment.jurisdiction,
                latestAssessment.change_pct != null ? `${latestAssessment.change_pct > 0 ? "+" : ""}${formatPercent(latestAssessment.change_pct)} vs prior` : null,
                latestAssessment.estimated_tax != null ? `Est. tax ${formatCurrency(latestAssessment.estimated_tax)}` : null,
                latestAssessment.protest_deadline_on ? `Protest by ${formatDate(latestAssessment.protest_deadline_on)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              right={latestAssessment.protest_status ? <OpsStatusBadge status={latestAssessment.protest_status} /> : undefined}
            />
          )}
          {protestItems
            .filter((p) => ACTIVE_PROTEST.includes(p.status) || p.id !== latestAssessment?.protest_id)
            .slice(0, 3)
            .map((p) => (
              <Row
                key={p.id}
                href={`/insurance?tab=tax&property_id=${propertyId}`}
                primary={`${p.tax_year} protest${p.consultant_name ? ` · ${p.consultant_name}` : ""}`}
                secondary={
                  ACTIVE_PROTEST.includes(p.status)
                    ? [p.deadline_on ? `Deadline ${formatDate(p.deadline_on)}` : null, p.hearing_on ? `Hearing ${formatDate(p.hearing_on)}` : null].filter(Boolean).join(" · ") || undefined
                    : p.net_savings != null
                      ? `Net savings ${formatCurrency(p.net_savings)}`
                      : undefined
                }
                right={
                  <>
                    {ACTIVE_PROTEST.includes(p.status) && p.days_to_deadline != null && p.days_to_deadline >= 0 && !p.filed_on && <DaysLeft days={p.days_to_deadline} />}
                    <OpsStatusBadge status={p.status} />
                  </>
                }
              />
            ))}
          {(unpaid.length ? unpaid : paymentItems).slice(0, 3).map((p) => (
            <Row
              key={p.id}
              href={`/insurance?tab=tax&property_id=${propertyId}`}
              primary={`${p.tax_year} tax${p.installment ? ` · ${p.installment}` : ""} · ${formatCurrency(p.amount_due)}`}
              secondary={p.paid_on ? `Paid ${formatDate(p.paid_on)}${p.confirmation_number ? ` · ${p.confirmation_number}` : ""}` : `Due ${formatDate(p.due_on)}`}
              right={<OpsStatusBadge status={p.status} />}
            />
          ))}
        </SectionCard>

        <SectionCard
          title="Capital projects"
          icon={<HardHat />}
          href={`/capital-projects?property_id=${propertyId}`}
          linkLabel="Capital projects"
          loading={projects.isLoading}
          count={projectItems.length}
          empty="No capital projects for this property."
        >
          {projectItems.slice(0, 8).map((p) => {
            const pct = p.current_budget > 0 ? (p.spent / p.current_budget) * 100 : null;
            return (
              <Row
                key={p.id}
                href={`/capital-projects/${p.id}`}
                primary={p.name}
                secondary={[categoryLabel(p.category), p.contractor_name, p.target_completion_on ? `Target ${formatDate(p.target_completion_on)}` : null].filter(Boolean).join(" · ")}
                right={
                  <>
                    <span className="text-right text-xs tabular text-ink-3">
                      <span className={cn("font-medium", pct != null && pct > 100 ? "text-negative" : "text-ink")}>{formatCurrency(p.spent, { compact: true })}</span>
                      {" / "}
                      {formatCurrency(p.current_budget, { compact: true })}
                    </span>
                    <ProjectStatusBadge status={p.status} />
                  </>
                }
              />
            );
          })}
        </SectionCard>

        <SectionCard
          title="Budgets"
          icon={<Calculator />}
          href={`/budgets?property_id=${propertyId}`}
          linkLabel="Budgets"
          loading={budgets.isLoading}
          count={budgetRows.length}
          empty="No operating budgets for this property."
        >
          {budgetRows.slice(0, 6).map((b) => (
            <Row
              key={b.id}
              href={`/budgets/${b.id}`}
              primary={`FY${b.fiscal_year} · v${b.version}${b.kind === "reforecast" ? " reforecast" : ""}`}
              secondary={`Income ${formatCurrency(b.total_income, { compact: true })} · Expenses ${formatCurrency(b.total_expense, { compact: true })}`}
              right={
                <>
                  <span className="text-right text-xs text-ink-3">
                    NOI <span className={cn("font-medium tabular", b.noi < 0 ? "text-negative" : "text-ink")}>{formatCurrency(b.noi, { compact: true })}</span>
                  </span>
                  <OpsStatusBadge status={b.status} />
                </>
              }
            />
          ))}
        </SectionCard>
      </div>
    </div>
  );
}
