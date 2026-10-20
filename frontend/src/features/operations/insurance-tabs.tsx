"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowRight, Gavel, Landmark, MoreHorizontal, Pencil, Plus, Receipt, ShieldCheck, Umbrella } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { EntityPicker, PropertyPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, FieldGrid, FieldItem, ListCard, StatCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Checkbox, Tooltip } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, ApiError, errorMessage, type Page, type Params } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, titleCase, toNumber } from "@/lib/utils";

import { OrganizationPicker } from "@/features/contacts/pickers";
import { RecordCriticalDates } from "@/features/contracts/record-critical-dates";
import { RecordDocuments } from "@/features/documents/record-documents";

import {
  CERTIFICATE_STATUSES,
  CLAIM_STATUSES,
  COVERAGE_TYPES,
  HEARING_RESULTS,
  PAYMENT_STATUSES,
  POLICY_STATUSES,
  PROTEST_STATUSES,
  expiryTone,
  useArchiveCertificate,
  useArchivePolicy,
  useClaimStatus,
  useConfirmPayment,
  useCreatePayment,
  useRecordHearing,
  useSaveAssessment,
  useSaveCertificate,
  useSaveClaim,
  useSavePolicy,
  useSaveProtest,
  useTaxSummary,
  type Assessment,
  type AssessmentInput,
  type Certificate,
  type CertificateInput,
  type Claim,
  type ClaimInput,
  type Policy,
  type PolicyInput,
  type Protest,
  type TaxPayment,
  type VendorListItem,
} from "./api";

/* ================================================================== shared helpers */

const STATE_TONES: Record<string, Tone> = {
  pending_renewal: "amber",
  requested: "sky",
  compliant: "green",
  deficient: "amber",
  reported: "sky",
  under_review: "amber",
  denied: "red",
  paid: "green",
  considering: "neutral",
  filed: "blue",
  evidence_submitted: "blue",
  hearing_scheduled: "sky",
  settled: "green",
  won: "green",
  lost: "red",
  withdrawn: "neutral",
  scheduled: "neutral",
  confirmed: "green",
  late: "red",
  submitted: "amber",
  superseded: "neutral",
  pending_approval: "amber",
  bidding: "sky",
  awarded: "blue",
};

/** Status badge for operations workflow states (falls back to the shared StatusBadge). */
export function OpsStatusBadge({ status }: { status?: string | null }) {
  if (status && STATE_TONES[status]) {
    return (
      <Badge tone={STATE_TONES[status]} dot>
        {titleCase(status)}
      </Badge>
    );
  }
  return <StatusBadge status={status} />;
}

export function DaysLeft({ days }: { days: number | null | undefined }) {
  if (days === null || days === undefined) return <span className="text-ink-3">—</span>;
  const label = days < 0 ? `${Math.abs(days)}d ago` : days === 0 ? "Today" : `${days}d`;
  return <Badge tone={expiryTone(days)}>{label}</Badge>;
}

/** Compact segmented control (local, not URL-bound). */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface p-0.5 shadow-card">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn("h-7 rounded px-3 text-sm font-medium transition-colors", value === o.value ? "bg-ink text-white" : "text-ink-2 hover:bg-muted hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function daysUntil(d?: string | null): number | null {
  if (!d) return null;
  const target = new Date(`${d.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 86_400_000);
}

const todayIso = () => formatDate(new Date(), "yyyy-MM-dd");
const compact = (v?: number | null) => formatCurrency(v, { compact: true });
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const txt = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const num = (v: string | undefined) => toNumber(v ?? "");

function signedClass(v: number | null | undefined, positiveIsGood = true) {
  if (v === null || v === undefined || v === 0) return "text-ink-2";
  return (v > 0) === positiveIsGood ? "text-positive" : "text-negative";
}

type FormState = Record<string, string>;

function useFormState(open: boolean, init: () => FormState) {
  const [form, setForm] = useState<FormState>(init);
  useEffect(() => {
    if (open) setForm(init());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const setField = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const bind = (key: string) => ({
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setField(key, e.target.value),
  });
  return { form, setField, bind };
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function StopClick({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ list state (URL or local) */

type Val = string | number | boolean | null | undefined | (string | number)[];

export interface ListState {
  params: Record<string, string | string[]>;
  get: (key: string) => string | null;
  getAll: (key: string) => string[];
  set: (updates: Record<string, Val>, opts?: { resetPage?: boolean }) => void;
  replaceAll: (values: Record<string, Val>) => void;
}

function normalize(v: Val): string | string[] | null {
  if (v === null || v === undefined || v === "" || v === false) return null;
  if (Array.isArray(v)) return v.length ? v.map(String) : null;
  return String(v);
}

function useLocalListState(): ListState {
  const [params, setParams] = useState<Record<string, string | string[]>>({});
  const get = (key: string) => {
    const v = params[key];
    if (v === undefined) return null;
    return Array.isArray(v) ? v[0] ?? null : v;
  };
  const getAll = (key: string) => {
    const v = params[key];
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  };
  const set = (updates: Record<string, Val>, opts: { resetPage?: boolean } = {}) =>
    setParams((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(updates)) {
        delete next[k];
        const n = normalize(v);
        if (n !== null) next[k] = n;
      }
      if (opts.resetPage !== false && !("page" in updates)) delete next.page;
      return next;
    });
  const replaceAll = (values: Record<string, Val>) => {
    const next: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(values)) {
      const n = normalize(v);
      if (n !== null) next[k] = n;
    }
    setParams(next);
  };
  return { params, get, getAll, set, replaceAll };
}

interface ListCtx<T> {
  state: ListState;
  scoped: boolean;
  fixed: Params;
  data?: Page<T>;
  isLoading: boolean;
  isFetching: boolean;
  page: number;
  pageSize: number;
}

interface HostProps<T> {
  qk: string;
  path: string;
  fixed?: Params;
  children: (ctx: ListCtx<T>) => ReactNode;
}

function UrlHost<T>({ qk, path, children }: HostProps<T>) {
  const list = useListQuery<T>(qk, path);
  return (
    <>
      {children({
        state: list.url,
        scoped: false,
        fixed: {},
        data: list.data,
        isLoading: list.isLoading,
        isFetching: list.isFetching,
        page: list.page,
        pageSize: list.pageSize,
      })}
    </>
  );
}

function LocalHost<T>({ qk, path, fixed, children }: HostProps<T>) {
  const state = useLocalListState();
  const page = Math.max(1, Number(state.get("page")) || 1);
  const pageSize = Number(state.get("page_size")) || 25;
  const params: Params = { ...state.params, ...fixed, page, page_size: pageSize };
  const query = useQuery({
    queryKey: [qk, "list", path, params],
    queryFn: () => api.get<Page<T>>(path, params),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      {children({
        state,
        scoped: true,
        fixed: fixed ?? {},
        data: query.data,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        page,
        pageSize,
      })}
    </>
  );
}

/** URL-backed list when unscoped; local state + fixed params when scoped to a record. */
function ListHost<T>(props: HostProps<T>) {
  return props.fixed ? <LocalHost<T> {...props} /> : <UrlHost<T> {...props} />;
}

function filterParams(state: ListState, fixed: Params): Params {
  const { page: _p, page_size: _s, sort: _o, tab: _t, section: _x, ...rest } = state.params;
  return { ...rest, ...fixed };
}

function chipsFor(state: ListState, defs: { key: string; label: string; format?: (v: string) => string }[]): FilterChip[] {
  const out: FilterChip[] = [];
  for (const d of defs) {
    const values = state.getAll(d.key);
    if (values.length) {
      out.push({
        key: d.key,
        label: d.label,
        value: values.map((v) => (d.format ? d.format(v) : titleCase(v))).join(", "),
        onRemove: () => state.set({ [d.key]: null }),
      });
    }
  }
  return out;
}

function options(values: readonly string[], counts?: Record<string, number>) {
  return values.map((v) => ({ value: v, label: titleCase(v), count: counts ? counts[v] ?? 0 : undefined }));
}

function TabToolbar({
  state,
  scoped,
  placeholder,
  chips,
  filters,
  right,
}: {
  state: ListState;
  scoped: boolean;
  placeholder: string;
  chips: FilterChip[];
  filters?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <Toolbar
        right={
          <>
            {!scoped && <SavedViewsMenu module="operations" />}
            {right}
          </>
        }
      >
        <SearchInput value={state.get("q") ?? ""} onChange={(q) => state.set({ q })} placeholder={placeholder} shortcut={!scoped} className={scoped ? "w-56" : undefined} />
        {filters}
      </Toolbar>
      <FilterChips
        chips={chips}
        onClear={() =>
          state.replaceAll(scoped ? { q: state.get("q"), sort: state.get("sort") } : { tab: state.get("tab"), section: state.get("section"), q: state.get("q"), sort: state.get("sort") })
        }
      />
    </div>
  );
}

function Pager<T>({ ctx }: { ctx: ListCtx<T> }) {
  return (
    <TableFooter
      page={ctx.page}
      pageSize={ctx.pageSize}
      total={ctx.data?.total ?? 0}
      onPage={(page) => ctx.state.set({ page }, { resetPage: false })}
      onPageSize={(size) => ctx.state.set({ page_size: size })}
    />
  );
}

export interface TabProps {
  /** Scope the list to one property (local filter state, no URL params). */
  propertyId?: string;
  /** Controlled "create" sheet (page header primary action). When omitted, the tab shows its own button. */
  creating?: boolean;
  onCreatingChange?: (open: boolean) => void;
}

function useCreating(creating?: boolean, onChange?: (o: boolean) => void): [boolean, (o: boolean) => void] {
  const [local, setLocal] = useState(false);
  return onChange ? [!!creating, onChange] : [local, setLocal];
}

interface ViewProps<T> {
  ctx: ListCtx<T>;
  propertyId?: string;
  creating: boolean;
  setCreating: (o: boolean) => void;
  /** Show an in-toolbar create button (when the page header does not provide one). */
  showCreate: boolean;
}

const MORE_TAX_YEAR: MoreFilterField[] = [{ type: "number", label: "Tax year", key: "tax_year" }];

/* ================================================================== policies */

const POLICY_MORE: MoreFilterField[] = [{ type: "number", label: "Expiring within", key: "expiring_within_days", suffix: "days" }];

const policyColumns: Column<Policy>[] = [
  {
    id: "property",
    header: "Property",
    cell: (p) => (
      <div className="min-w-[160px] max-w-[240px]">
        <p className={cn("truncate font-medium", p.property_name ? "text-ink" : "text-ink-2")}>{p.property_name ?? "Portfolio policy"}</p>
        {p.named_insured && <p className="truncate text-xs text-ink-3">{p.named_insured}</p>}
      </div>
    ),
  },
  { id: "coverage", header: "Coverage", sortKey: "coverage_type", hideable: true, cell: (p) => <span className="whitespace-nowrap text-ink-2">{titleCase(p.coverage_type)}</span> },
  {
    id: "carrier",
    header: "Carrier",
    sortKey: "carrier",
    cell: (p) => (
      <div className="min-w-[120px] max-w-[200px]">
        <p className="truncate text-ink">{p.carrier}</p>
        {p.broker && <p className="truncate text-xs text-ink-3">via {p.broker}</p>}
      </div>
    ),
  },
  { id: "number", header: "Policy #", hideable: true, cell: (p) => <span className="whitespace-nowrap font-mono text-xs text-ink-2">{p.policy_number}</span> },
  { id: "limit", header: "Limit", sortKey: "limit_amount", align: "right", hideable: true, cell: (p) => compact(p.limit_amount) },
  { id: "aggregate", header: "Aggregate", align: "right", hideable: true, cell: (p) => compact(p.aggregate_limit) },
  { id: "deductible", header: "Deductible", align: "right", hideable: true, cell: (p) => compact(p.deductible) },
  { id: "premium", header: "Premium", sortKey: "premium", align: "right", hideable: true, cell: (p) => formatCurrency(p.premium) },
  {
    id: "term",
    header: "Term",
    sortKey: "effective_on",
    hideable: true,
    cell: (p) => (
      <span className="whitespace-nowrap text-xs text-ink-2">
        {formatDate(p.effective_on, "MMM d, yy")} – {formatDate(p.expires_on, "MMM d, yy")}
      </span>
    ),
  },
  {
    id: "expiry",
    header: "Expires in",
    sortKey: "expires_on",
    cell: (p) => (p.status === "cancelled" ? <span className="text-ink-3">—</span> : <DaysLeft days={p.days_to_expiry} />),
  },
  { id: "status", header: "Status", hideable: true, cell: (p) => <OpsStatusBadge status={p.status} /> },
  {
    id: "claims",
    header: "Open claims",
    align: "right",
    hideable: true,
    cell: (p) => (p.open_claims > 0 ? <Badge tone="amber">{p.open_claims}</Badge> : <span className="text-ink-3">0</span>),
  },
];

export function PoliciesTab({ propertyId, creating, onCreatingChange }: TabProps) {
  const [create, setCreate] = useCreating(creating, onCreatingChange);
  return (
    <ListHost<Policy> qk="insurance" path="/insurance/policies" fixed={propertyId ? { property_id: propertyId } : undefined}>
      {(ctx) => <PoliciesView ctx={ctx} propertyId={propertyId} creating={create} setCreating={setCreate} showCreate={!onCreatingChange} />}
    </ListHost>
  );
}

function PoliciesView({ ctx, propertyId, creating, setCreating, showCreate }: ViewProps<Policy>) {
  const { can } = useAuth();
  const { state, scoped } = ctx;
  const cols = useColumnVisibility(scoped ? "ops-policies-property" : "ops-policies", policyColumns);
  const fp = filterParams(state, ctx.fixed);
  const { data: facets } = useQuery({
    queryKey: ["insurance", "policies", "facets", fp],
    queryFn: () => api.get<Record<string, Record<string, number>>>("/insurance/policies/facets", fp),
    placeholderData: (prev) => prev,
  });
  const [selected, setSelected] = useState<Policy | null>(null);
  const [editing, setEditing] = useState<Policy | null>(null);
  const current = selected ? ctx.data?.items.find((p) => p.id === selected.id) ?? selected : null;

  const chips = chipsFor(state, [
    { key: "coverage_type", label: "Coverage" },
    { key: "status", label: "Status" },
    { key: "expiring_within_days", label: "Expiring within", format: (v) => `${v} days` },
  ]);
  const filtered = chips.length > 0 || !!state.get("q");
  const newButton = (
    <Button variant={scoped ? "secondary" : "primary"} onClick={() => setCreating(true)}>
      <Plus /> New policy
    </Button>
  );

  return (
    <>
      <ListCard
        toolbar={
          <TabToolbar
            state={state}
            scoped={scoped}
            placeholder="Search carrier, policy #, broker…"
            chips={chips}
            filters={
              <>
                <FacetFilter label="Coverage" options={options(COVERAGE_TYPES, facets?.coverage_type)} selected={state.getAll("coverage_type")} onChange={(v) => state.set({ coverage_type: v })} />
                <FacetFilter label="Status" options={options(POLICY_STATUSES, facets?.status)} selected={state.getAll("status")} onChange={(v) => state.set({ status: v })} />
                <MoreFilters fields={POLICY_MORE} values={state.params} onApply={(v) => state.set(v)} />
              </>
            }
            right={
              <>
                <ColumnsMenu columns={policyColumns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {showCreate && can("operations", "create") && newButton}
              </>
            }
          />
        }
        footer={<Pager ctx={ctx} />}
      >
        <DataTable
          columns={policyColumns}
          data={ctx.data?.items}
          loading={ctx.isLoading}
          fetching={ctx.isFetching}
          sort={state.get("sort")}
          onSortChange={(sort) => state.set({ sort })}
          onRowClick={(p) => setSelected(p)}
          hidden={cols.hidden}
          dense={scoped}
          rowClassName={(p) => (p.status === "cancelled" || p.status === "expired" ? "opacity-70" : undefined)}
          empty={
            <EmptyState
              icon={<Umbrella />}
              title={filtered ? "No policies match these filters" : "No insurance policies yet"}
              description={filtered ? "Try removing a filter." : "Record each policy with its coverage, limits, deductible, premium and term so expirations are tracked."}
              action={!filtered && can("operations", "create") ? newButton : undefined}
            />
          }
        />
      </ListCard>

      <PolicyFormSheet
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        policy={editing}
        propertyId={propertyId}
        onSaved={(p) => setSelected(p)}
      />
      <PolicyDetailSheet
        policy={current}
        onClose={() => setSelected(null)}
        onEdit={(p) => {
          setSelected(null);
          setEditing(p);
        }}
      />
    </>
  );
}

function PolicyFormSheet({
  open,
  onOpenChange,
  policy,
  propertyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  policy: Policy | null;
  propertyId?: string;
  onSaved?: (p: Policy) => void;
}) {
  const save = useSavePolicy(policy?.id);
  const { form, bind, setField } = useFormState(open, () => ({
    property_id: policy ? str(policy.property_id) : propertyId ?? "",
    coverage_type: policy?.coverage_type ?? "property",
    status: policy?.status ?? "active",
    carrier: str(policy?.carrier),
    policy_number: str(policy?.policy_number),
    broker: str(policy?.broker),
    named_insured: str(policy?.named_insured),
    limit_amount: str(policy?.limit_amount),
    aggregate_limit: str(policy?.aggregate_limit),
    deductible: str(policy?.deductible),
    premium: str(policy?.premium),
    effective_on: str(policy?.effective_on),
    expires_on: str(policy?.expires_on),
    notes: str(policy?.notes),
  }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: PolicyInput = {
      property_id: txt(form.property_id),
      asset_id: policy?.asset_id ?? null,
      policy_number: form.policy_number.trim(),
      coverage_type: form.coverage_type,
      carrier: form.carrier.trim(),
      broker: txt(form.broker),
      named_insured: txt(form.named_insured),
      limit_amount: num(form.limit_amount),
      aggregate_limit: num(form.aggregate_limit),
      deductible: num(form.deductible),
      premium: num(form.premium),
      effective_on: form.effective_on,
      expires_on: form.expires_on,
      status: form.status,
      document_id: policy?.document_id ?? null,
      renewal_of_id: policy?.renewal_of_id ?? null,
      notes: txt(form.notes),
    };
    save.mutate(data, {
      onSuccess: (p) => {
        toast.success(policy ? "Policy updated" : "Policy added");
        onOpenChange(false);
        onSaved?.(p);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={policy ? "Edit policy" : "New policy"}
      description={policy ? `${policy.carrier} · ${policy.policy_number}` : "Expiration alerts and a critical date are created from the term."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="policy-form" loading={save.isPending}>
            {policy ? "Save changes" : "Add policy"}
          </Button>
        </>
      }
    >
      <form id="policy-form" onSubmit={submit} className="space-y-6">
        <FormSection title="Coverage">
          <Field label="Property" hint="Leave empty for a portfolio-wide policy" className="col-span-2">
            <PropertyPicker value={form.property_id || null} onChange={(id) => setField("property_id", id ?? "")} placeholder="Portfolio (all properties)" />
          </Field>
          <Field label="Coverage type">
            <Select {...bind("coverage_type")} options={COVERAGE_TYPES.map((c) => ({ value: c, label: titleCase(c) }))} />
          </Field>
          <Field label="Status">
            <Select {...bind("status")} options={POLICY_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Carrier" required>
            <Input {...bind("carrier")} required />
          </Field>
          <Field label="Policy number" required>
            <Input {...bind("policy_number")} required />
          </Field>
          <Field label="Broker">
            <Input {...bind("broker")} />
          </Field>
          <Field label="Named insured">
            <Input {...bind("named_insured")} />
          </Field>
        </FormSection>
        <FormSection title="Limits & cost">
          <Field label="Per-occurrence limit ($)">
            <Input {...bind("limit_amount")} inputMode="decimal" />
          </Field>
          <Field label="Aggregate limit ($)">
            <Input {...bind("aggregate_limit")} inputMode="decimal" />
          </Field>
          <Field label="Deductible ($)">
            <Input {...bind("deductible")} inputMode="decimal" />
          </Field>
          <Field label="Annual premium ($)">
            <Input {...bind("premium")} inputMode="decimal" />
          </Field>
        </FormSection>
        <FormSection title="Term">
          <Field label="Effective on" required>
            <Input type="date" {...bind("effective_on")} required />
          </Field>
          <Field label="Expires on" required>
            <Input type="date" {...bind("expires_on")} required />
          </Field>
          <Field label="Notes" className="col-span-2">
            <Textarea {...bind("notes")} />
          </Field>
        </FormSection>
      </form>
    </Sheet>
  );
}

function PolicyDetailSheet({ policy, onClose, onEdit }: { policy: Policy | null; onClose: () => void; onEdit: (p: Policy) => void }) {
  const { can } = useAuth();
  const archive = useArchivePolicy();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <Sheet
        open={!!policy}
        onOpenChange={(o) => !o && onClose()}
        title={policy ? `${policy.carrier} · ${policy.policy_number}` : "Policy"}
        description={policy ? `${titleCase(policy.coverage_type)} · ${policy.property_name ?? "Portfolio policy"}` : undefined}
        className="max-w-2xl"
        footer={
          policy ? (
            <>
              {can("operations", "delete") && (
                <Button variant="ghost" className="mr-auto" onClick={() => setConfirming(true)}>
                  <Archive /> Archive
                </Button>
              )}
              <Button onClick={onClose}>Close</Button>
              {can("operations", "edit") && (
                <Button variant="primary" onClick={() => onEdit(policy)}>
                  <Pencil /> Edit
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {policy && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <OpsStatusBadge status={policy.status} />
              <span className="text-xs text-ink-3">Expires {formatDate(policy.expires_on)}</span>
              <DaysLeft days={policy.days_to_expiry} />
              {policy.open_claims > 0 && <Badge tone="amber">{policy.open_claims} open claims</Badge>}
            </div>
            <FieldGrid cols={3}>
              <FieldItem label="Coverage">{titleCase(policy.coverage_type)}</FieldItem>
              <FieldItem label="Carrier">{policy.carrier}</FieldItem>
              <FieldItem label="Broker">{policy.broker}</FieldItem>
              <FieldItem label="Policy number">{policy.policy_number}</FieldItem>
              <FieldItem label="Named insured">{policy.named_insured}</FieldItem>
              <FieldItem label="Property">{policy.property_name ?? "Portfolio"}</FieldItem>
              <FieldItem label="Limit">{policy.limit_amount != null ? formatCurrency(policy.limit_amount) : null}</FieldItem>
              <FieldItem label="Aggregate">{policy.aggregate_limit != null ? formatCurrency(policy.aggregate_limit) : null}</FieldItem>
              <FieldItem label="Deductible">{policy.deductible != null ? formatCurrency(policy.deductible) : null}</FieldItem>
              <FieldItem label="Premium">{policy.premium != null ? formatCurrency(policy.premium) : null}</FieldItem>
              <FieldItem label="Effective">{formatDate(policy.effective_on)}</FieldItem>
              <FieldItem label="Expires">{formatDate(policy.expires_on)}</FieldItem>
            </FieldGrid>
            {policy.notes && <p className="whitespace-pre-wrap rounded-md border border-line bg-subtle/60 px-3 py-2 text-sm text-ink-2">{policy.notes}</p>}
            <RecordCriticalDates relatedType="insurance_policy" relatedId={policy.id} propertyId={policy.property_id} title="Expiration & renewal dates" />
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-ink">Policy documents</h4>
              <RecordDocuments entityType="insurance_policy" entityId={policy.id} />
            </div>
          </div>
        )}
      </Sheet>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Archive this policy?"
        description="The policy and its history are retained but it will no longer appear in the inventory or expiration scans."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() =>
          policy &&
          archive.mutate(policy.id, {
            onSuccess: () => {
              toast.success("Policy archived");
              setConfirming(false);
              onClose();
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

/* ================================================================== certificates */

const certificateColumns: Column<Certificate>[] = [
  {
    id: "holder",
    header: "Holder",
    cell: (c) => (
      <div className="min-w-[180px] max-w-[260px]">
        <p className="flex items-center gap-1.5">
          <span className="truncate font-medium text-ink">{c.holder_name ?? c.tenant_name ?? "—"}</span>
          <Badge tone="outline">{titleCase(c.holder_kind)}</Badge>
        </p>
        {c.policy_number && <p className="truncate font-mono text-xs text-ink-3">{c.policy_number}</p>}
      </div>
    ),
  },
  { id: "property", header: "Property", hideable: true, cell: (c) => <span className="text-ink-2">{c.property_name ?? "—"}</span> },
  { id: "coverage", header: "Coverage", hideable: true, cell: (c) => <span className="whitespace-nowrap text-ink-2">{titleCase(c.coverage_type)}</span> },
  { id: "carrier", header: "Carrier", hideable: true, cell: (c) => <span className="text-ink-2">{c.carrier ?? "—"}</span> },
  {
    id: "limit",
    header: "Limit / required",
    align: "right",
    hideable: true,
    cell: (c) => {
      const short = c.required_limit != null && (c.limit_amount ?? 0) < c.required_limit;
      return (
        <span className="whitespace-nowrap">
          <span className={short ? "font-medium text-negative" : "text-ink"}>{compact(c.limit_amount)}</span>
          <span className="text-ink-3"> / {compact(c.required_limit)}</span>
        </span>
      );
    },
  },
  {
    id: "ai",
    header: "Additional insured",
    hideable: true,
    cell: (c) =>
      c.additional_insured ? (
        <span className="text-ink-2">Yes</span>
      ) : c.additional_insured_required ? (
        <span className="font-medium text-negative">Missing</span>
      ) : (
        <span className="text-ink-3">Not required</span>
      ),
  },
  {
    id: "received",
    header: "Received",
    hideable: true,
    cell: (c) =>
      c.received_on ? (
        <span className="whitespace-nowrap text-xs text-ink-2">{formatDate(c.received_on)}</span>
      ) : (
        <span className="whitespace-nowrap text-xs text-ink-3">{c.requested_on ? `Requested ${formatDate(c.requested_on)}` : "Not received"}</span>
      ),
  },
  {
    id: "expires",
    header: "Expires",
    sortKey: "expires_on",
    cell: (c) => (
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-xs text-ink-2">{formatDate(c.expires_on)}</span>
        {c.expires_on && <DaysLeft days={c.days_to_expiry} />}
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    sortKey: "status",
    cell: (c) =>
      c.deficiencies.length > 0 ? (
        <Tooltip
          content={
            <ul className="list-disc space-y-0.5 pl-3.5">
              {c.deficiencies.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          }
        >
          <span className="inline-flex cursor-help">
            <OpsStatusBadge status={c.status} />
          </span>
        </Tooltip>
      ) : (
        <OpsStatusBadge status={c.status} />
      ),
  },
];

export function CertificatesTab({ propertyId, creating, onCreatingChange }: TabProps) {
  const [create, setCreate] = useCreating(creating, onCreatingChange);
  return (
    <ListHost<Certificate> qk="insurance" path="/insurance/certificates" fixed={propertyId ? { property_id: propertyId } : undefined}>
      {(ctx) => <CertificatesView ctx={ctx} propertyId={propertyId} creating={create} setCreating={setCreate} showCreate={!onCreatingChange} />}
    </ListHost>
  );
}

function CertificatesView({ ctx, propertyId, creating, setCreating, showCreate }: ViewProps<Certificate>) {
  const { can } = useAuth();
  const { state, scoped } = ctx;
  const cols = useColumnVisibility(scoped ? "ops-certificates-property" : "ops-certificates", certificateColumns);
  const fp = filterParams(state, ctx.fixed);
  const { data: facets } = useQuery({
    queryKey: ["insurance", "certificates", "facets", fp],
    queryFn: () => api.get<Record<string, Record<string, number>>>("/insurance/certificates/facets", fp),
    placeholderData: (prev) => prev,
  });
  const [editing, setEditing] = useState<Certificate | null>(null);

  const chips = chipsFor(state, [
    { key: "holder_kind", label: "Holder" },
    { key: "status", label: "Status" },
  ]);
  const filtered = chips.length > 0 || !!state.get("q");
  const newButton = (
    <Button variant={scoped ? "secondary" : "primary"} onClick={() => setCreating(true)}>
      <Plus /> New certificate
    </Button>
  );

  return (
    <>
      <ListCard
        toolbar={
          <TabToolbar
            state={state}
            scoped={scoped}
            placeholder="Search tenant, carrier, policy #…"
            chips={chips}
            filters={
              <>
                <FacetFilter label="Holder" options={options(["tenant", "vendor"], facets?.holder_kind)} selected={state.getAll("holder_kind")} onChange={(v) => state.set({ holder_kind: v })} />
                <FacetFilter label="Status" options={options(CERTIFICATE_STATUSES, facets?.status)} selected={state.getAll("status")} onChange={(v) => state.set({ status: v })} />
              </>
            }
            right={
              <>
                <ColumnsMenu columns={certificateColumns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {showCreate && can("operations", "create") && newButton}
              </>
            }
          />
        }
        footer={<Pager ctx={ctx} />}
      >
        <DataTable
          columns={certificateColumns}
          data={ctx.data?.items}
          loading={ctx.isLoading}
          fetching={ctx.isFetching}
          sort={state.get("sort")}
          onSortChange={(sort) => state.set({ sort })}
          onRowClick={(c) => setEditing(c)}
          hidden={cols.hidden}
          dense={scoped}
          empty={
            <EmptyState
              icon={<ShieldCheck />}
              title={filtered ? "No certificates match these filters" : "No certificates collected yet"}
              description={filtered ? "Try removing a filter." : "Track tenant and vendor certificates of insurance so lapses and deficiencies are caught."}
              action={!filtered && can("operations", "create") ? newButton : undefined}
            />
          }
        />
      </ListCard>
      <CertificateSheet
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        certificate={editing}
        propertyId={propertyId}
        onSaved={(c, wasNew) => {
          if (wasNew) {
            // Stay open in edit mode so the certificate document can be attached.
            setCreating(false);
            setEditing(c);
          } else setEditing(null);
        }}
      />
    </>
  );
}

function CertificateSheet({
  open,
  onOpenChange,
  certificate,
  propertyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  certificate: Certificate | null;
  propertyId?: string;
  onSaved: (c: Certificate, wasNew: boolean) => void;
}) {
  const { can } = useAuth();
  const save = useSaveCertificate(certificate?.id);
  const archive = useArchiveCertificate();
  const [confirming, setConfirming] = useState(false);
  const { form, bind, setField } = useFormState(open, () => ({
    holder_kind: certificate?.holder_kind ?? "tenant",
    vendor_id: str(certificate?.vendor_id),
    tenant_name: str(certificate?.tenant_name),
    tenant_organization_id: str(certificate?.tenant_organization_id),
    lease_id: str(certificate?.lease_id),
    property_id: certificate ? str(certificate.property_id) : propertyId ?? "",
    coverage_type: certificate?.coverage_type ?? "general_liability",
    carrier: str(certificate?.carrier),
    policy_number: str(certificate?.policy_number),
    limit_amount: str(certificate?.limit_amount),
    required_limit: str(certificate?.required_limit),
    additional_insured: certificate?.additional_insured ? "true" : "false",
    additional_insured_required: certificate ? (certificate.additional_insured_required ? "true" : "false") : "true",
    effective_on: str(certificate?.effective_on),
    expires_on: str(certificate?.expires_on),
    requested_on: str(certificate?.requested_on),
    received_on: str(certificate?.received_on),
    notes: str(certificate?.notes),
  }));
  const isVendor = form.holder_kind === "vendor";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: CertificateInput = {
      holder_kind: isVendor ? "vendor" : "tenant",
      vendor_id: isVendor ? txt(form.vendor_id) : null,
      tenant_name: isVendor ? null : txt(form.tenant_name),
      tenant_organization_id: isVendor ? null : txt(form.tenant_organization_id),
      lease_id: isVendor ? null : txt(form.lease_id),
      property_id: txt(form.property_id),
      coverage_type: form.coverage_type,
      carrier: txt(form.carrier),
      policy_number: txt(form.policy_number),
      limit_amount: num(form.limit_amount),
      required_limit: num(form.required_limit),
      additional_insured: form.additional_insured === "true",
      additional_insured_required: form.additional_insured_required === "true",
      effective_on: txt(form.effective_on),
      expires_on: txt(form.expires_on),
      received_on: txt(form.received_on),
      requested_on: txt(form.requested_on),
      document_id: certificate?.document_id ?? null,
      notes: txt(form.notes),
    };
    save.mutate(data, {
      onSuccess: (c) => {
        toast.success(`Certificate saved · ${titleCase(c.status)}`);
        onSaved(c, !certificate);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={certificate ? "Certificate of insurance" : "New certificate"}
        description={certificate ? `${certificate.holder_name ?? "Holder"} · ${titleCase(certificate.coverage_type)}` : "Record a tenant or vendor certificate of insurance."}
        footer={
          <>
            {certificate && can("operations", "delete") && (
              <Button variant="ghost" className="mr-auto" onClick={() => setConfirming(true)}>
                <Archive /> Archive
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)}>{certificate ? "Close" : "Cancel"}</Button>
            {(certificate ? can("operations", "edit") : can("operations", "create")) && (
              <Button variant="primary" type="submit" form="certificate-form" loading={save.isPending}>
                {certificate ? "Save changes" : "Add certificate"}
              </Button>
            )}
          </>
        }
      >
        <form id="certificate-form" onSubmit={submit} className="space-y-6">
          {certificate ? (
            <div className="space-y-2 rounded-lg border border-line bg-subtle/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <OpsStatusBadge status={certificate.status} />
                {certificate.expires_on && <DaysLeft days={certificate.days_to_expiry} />}
                <span className="text-xs text-ink-3">Status is computed on save.</span>
              </div>
              {certificate.deficiencies.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink-2">
                  {certificate.deficiencies.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="rounded-lg border border-line bg-subtle/60 p-3 text-xs text-ink-2">
              Status is computed on save: requested until the certificate is received, then compliant, deficient (limit below requirement, owner not named as additional insured, or no expiry date) or expired.
            </p>
          )}

          <section className="space-y-3">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Holder</h4>
            <Segmented
              value={isVendor ? "vendor" : "tenant"}
              onChange={(v) => setField("holder_kind", v)}
              options={[
                { value: "tenant", label: "Tenant" },
                { value: "vendor", label: "Vendor" },
              ]}
            />
            {isVendor ? (
              <Field label="Vendor" required>
                <EntityPicker<VendorListItem>
                  endpoint="/vendors"
                  value={form.vendor_id || null}
                  onChange={(id) => setField("vendor_id", id ?? "")}
                  placeholder="Select vendor"
                  toOption={(v) => ({ id: v.id, label: v.name, sublabel: v.services.map((s) => titleCase(s)).join(", ") || undefined })}
                />
              </Field>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tenant name" className="col-span-2">
                  <Input {...bind("tenant_name")} placeholder="As shown on the certificate" />
                </Field>
                <Field label="Tenant organization">
                  <OrganizationPicker value={form.tenant_organization_id || null} onChange={(id) => setField("tenant_organization_id", id ?? "")} />
                </Field>
                <Field label="Lease ID" hint="Optional">
                  <Input {...bind("lease_id")} placeholder="Lease record ID" />
                </Field>
              </div>
            )}
            <Field label="Property">
              <PropertyPicker value={form.property_id || null} onChange={(id) => setField("property_id", id ?? "")} />
            </Field>
          </section>

          <FormSection title="Coverage">
            <Field label="Coverage type">
              <Select {...bind("coverage_type")} options={COVERAGE_TYPES.map((c) => ({ value: c, label: titleCase(c) }))} />
            </Field>
            <Field label="Carrier">
              <Input {...bind("carrier")} />
            </Field>
            <Field label="Policy number">
              <Input {...bind("policy_number")} />
            </Field>
            <div />
            <Field label="Limit ($)">
              <Input {...bind("limit_amount")} inputMode="decimal" />
            </Field>
            <Field label="Required limit ($)">
              <Input {...bind("required_limit")} inputMode="decimal" />
            </Field>
            <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={form.additional_insured === "true"} onChange={(v) => setField("additional_insured", v ? "true" : "false")} />
              Owner is named as additional insured
            </label>
            <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={form.additional_insured_required === "true"} onChange={(v) => setField("additional_insured_required", v ? "true" : "false")} />
              Additional insured status is required
            </label>
          </FormSection>

          <FormSection title="Dates">
            <Field label="Requested on">
              <Input type="date" {...bind("requested_on")} />
            </Field>
            <Field label="Received on">
              <Input type="date" {...bind("received_on")} />
            </Field>
            <Field label="Effective on">
              <Input type="date" {...bind("effective_on")} />
            </Field>
            <Field label="Expires on">
              <Input type="date" {...bind("expires_on")} />
            </Field>
            <Field label="Notes" className="col-span-2">
              <Textarea {...bind("notes")} />
            </Field>
          </FormSection>
        </form>

        {certificate && (
          <div className="mt-6 space-y-2">
            <h4 className="text-sm font-semibold text-ink">Certificate documents</h4>
            <RecordDocuments entityType="insurance_certificate" entityId={certificate.id} />
          </div>
        )}
      </Sheet>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Archive this certificate?"
        description="It will no longer count toward compliance or appear in lapse tracking. History is retained."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() =>
          certificate &&
          archive.mutate(certificate.id, {
            onSuccess: () => {
              toast.success("Certificate archived");
              setConfirming(false);
              onOpenChange(false);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

/* ================================================================== claims */

const claimColumns: Column<Claim>[] = [
  {
    id: "claim",
    header: "Claim #",
    cell: (c) => (
      <div className="min-w-[110px]">
        <p className="whitespace-nowrap font-medium text-ink">{c.claim_number ?? "Unnumbered"}</p>
        {c.adjuster_name && <p className="truncate text-xs text-ink-3">{c.adjuster_name}</p>}
      </div>
    ),
  },
  { id: "property", header: "Property", hideable: true, cell: (c) => <span className="text-ink-2">{c.property_name ?? "—"}</span> },
  { id: "policy", header: "Policy", hideable: true, cell: (c) => <span className="whitespace-nowrap text-ink-2">{c.policy_label ?? "—"}</span> },
  { id: "incident", header: "Incident", sortKey: "incident_on", cell: (c) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDate(c.incident_on)}</span> },
  { id: "cause", header: "Cause", hideable: true, cell: (c) => <span className="block max-w-[200px] truncate text-ink-2">{c.cause ?? "—"}</span> },
  { id: "status", header: "Status", sortKey: "status", cell: (c) => <OpsStatusBadge status={c.status} /> },
  { id: "claimed", header: "Claimed", sortKey: "claimed_amount", align: "right", hideable: true, cell: (c) => formatCurrency(c.claimed_amount) },
  { id: "reserve", header: "Reserve", align: "right", hideable: true, cell: (c) => formatCurrency(c.reserve_amount) },
  { id: "paid", header: "Paid", sortKey: "paid_amount", align: "right", hideable: true, cell: (c) => formatCurrency(c.paid_amount) },
];

export function ClaimsTab({ propertyId, creating, onCreatingChange }: TabProps) {
  const [create, setCreate] = useCreating(creating, onCreatingChange);
  return (
    <ListHost<Claim> qk="insurance" path="/insurance/claims" fixed={propertyId ? { property_id: propertyId } : undefined}>
      {(ctx) => <ClaimsView ctx={ctx} propertyId={propertyId} creating={create} setCreating={setCreate} showCreate={!onCreatingChange} />}
    </ListHost>
  );
}

function ClaimsView({ ctx, propertyId, creating, setCreating, showCreate }: ViewProps<Claim>) {
  const { can } = useAuth();
  const { state, scoped } = ctx;
  const cols = useColumnVisibility(scoped ? "ops-claims-property" : "ops-claims", claimColumns);
  const fp = filterParams(state, ctx.fixed);
  const { data: facets } = useQuery({
    queryKey: ["insurance", "claims", "facets", fp],
    queryFn: () => api.get<Record<string, Record<string, number>>>("/insurance/claims/facets", fp),
    placeholderData: (prev) => prev,
  });
  const [selected, setSelected] = useState<Claim | null>(null);
  const [editing, setEditing] = useState<Claim | null>(null);
  const current = selected ? ctx.data?.items.find((c) => c.id === selected.id) ?? selected : null;

  const chips = chipsFor(state, [{ key: "status", label: "Status" }]);
  const filtered = chips.length > 0 || !!state.get("q");
  const newButton = (
    <Button variant={scoped ? "secondary" : "primary"} onClick={() => setCreating(true)}>
      <Plus /> New claim
    </Button>
  );

  return (
    <>
      <ListCard
        toolbar={
          <TabToolbar
            state={state}
            scoped={scoped}
            placeholder="Search claim #, cause, adjuster…"
            chips={chips}
            filters={<FacetFilter label="Status" options={options(CLAIM_STATUSES, facets?.status)} selected={state.getAll("status")} onChange={(v) => state.set({ status: v })} />}
            right={
              <>
                <ColumnsMenu columns={claimColumns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {showCreate && can("operations", "create") && newButton}
              </>
            }
          />
        }
        footer={<Pager ctx={ctx} />}
      >
        <DataTable
          columns={claimColumns}
          data={ctx.data?.items}
          loading={ctx.isLoading}
          fetching={ctx.isFetching}
          sort={state.get("sort")}
          onSortChange={(sort) => state.set({ sort })}
          onRowClick={(c) => setSelected(c)}
          hidden={cols.hidden}
          dense={scoped}
          rowClassName={(c) => (c.status === "closed" ? "opacity-70" : undefined)}
          empty={
            <EmptyState
              icon={<Umbrella />}
              title={filtered ? "No claims match these filters" : "No insurance claims"}
              description={filtered ? "Try removing a filter." : "Record claims against a policy and track them through to payment and closure."}
              action={!filtered && can("operations", "create") ? newButton : undefined}
            />
          }
        />
      </ListCard>
      <ClaimFormSheet
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        claim={editing}
        propertyId={propertyId}
        onSaved={(c) => setSelected(c)}
      />
      <ClaimDetailSheet
        claim={current}
        onClose={() => setSelected(null)}
        onChanged={(c) => setSelected(c)}
        onEdit={(c) => {
          setSelected(null);
          setEditing(c);
        }}
      />
    </>
  );
}

function ClaimFormSheet({
  open,
  onOpenChange,
  claim,
  propertyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  claim: Claim | null;
  propertyId?: string;
  onSaved?: (c: Claim) => void;
}) {
  const save = useSaveClaim(claim?.id);
  const { form, bind, setField } = useFormState(open, () => ({
    policy_id: str(claim?.policy_id),
    property_id: claim ? str(claim.property_id) : propertyId ?? "",
    claim_number: str(claim?.claim_number),
    incident_on: str(claim?.incident_on),
    reported_on: claim ? str(claim.reported_on) : todayIso(),
    cause: str(claim?.cause),
    description: str(claim?.description),
    claimed_amount: str(claim?.claimed_amount),
    reserve_amount: str(claim?.reserve_amount),
    paid_amount: str(claim?.paid_amount),
    deductible_applied: str(claim?.deductible_applied),
    adjuster_name: str(claim?.adjuster_name),
    adjuster_contact: str(claim?.adjuster_contact),
  }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: ClaimInput = {
      policy_id: txt(form.policy_id),
      property_id: txt(form.property_id),
      claim_number: txt(form.claim_number),
      incident_on: form.incident_on,
      reported_on: txt(form.reported_on),
      cause: txt(form.cause),
      description: txt(form.description),
      claimed_amount: num(form.claimed_amount),
      reserve_amount: num(form.reserve_amount),
      paid_amount: num(form.paid_amount),
      deductible_applied: num(form.deductible_applied),
      adjuster_name: txt(form.adjuster_name),
      adjuster_contact: txt(form.adjuster_contact),
      work_order_id: claim?.work_order_id ?? null,
    };
    save.mutate(data, {
      onSuccess: (c) => {
        toast.success(claim ? "Claim updated" : "Claim recorded");
        onOpenChange(false);
        onSaved?.(c);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={claim ? "Edit claim" : "New claim"}
      description={claim ? claim.claim_number ?? undefined : "New claims start as reported; change status as the carrier responds."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="claim-form" loading={save.isPending}>
            {claim ? "Save changes" : "Record claim"}
          </Button>
        </>
      }
    >
      <form id="claim-form" onSubmit={submit} className="space-y-6">
        <FormSection title="Policy & property">
          <Field label="Policy" className="col-span-2">
            <EntityPicker<Policy>
              endpoint="/insurance/policies"
              value={form.policy_id || null}
              onChange={(id, item) => {
                setField("policy_id", id ?? "");
                if (item?.property_id && !form.property_id) setField("property_id", item.property_id);
              }}
              placeholder="Select policy"
              toOption={(p) => ({ id: p.id, label: `${p.carrier} · ${p.policy_number}`, sublabel: [titleCase(p.coverage_type), p.property_name ?? "Portfolio"].join(" · ") })}
            />
          </Field>
          <Field label="Property" className="col-span-2" hint="Defaults to the policy property when left empty">
            <PropertyPicker value={form.property_id || null} onChange={(id) => setField("property_id", id ?? "")} />
          </Field>
        </FormSection>
        <FormSection title="Incident">
          <Field label="Claim number">
            <Input {...bind("claim_number")} />
          </Field>
          <Field label="Cause">
            <Input {...bind("cause")} placeholder="e.g. Water damage, wind, slip and fall" />
          </Field>
          <Field label="Incident date" required>
            <Input type="date" {...bind("incident_on")} required />
          </Field>
          <Field label="Reported on">
            <Input type="date" {...bind("reported_on")} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea {...bind("description")} />
          </Field>
        </FormSection>
        <FormSection title="Amounts">
          <Field label="Claimed ($)">
            <Input {...bind("claimed_amount")} inputMode="decimal" />
          </Field>
          <Field label="Reserve ($)">
            <Input {...bind("reserve_amount")} inputMode="decimal" />
          </Field>
          <Field label="Paid ($)">
            <Input {...bind("paid_amount")} inputMode="decimal" />
          </Field>
          <Field label="Deductible applied ($)">
            <Input {...bind("deductible_applied")} inputMode="decimal" />
          </Field>
        </FormSection>
        <FormSection title="Adjuster">
          <Field label="Adjuster name">
            <Input {...bind("adjuster_name")} />
          </Field>
          <Field label="Adjuster contact">
            <Input {...bind("adjuster_contact")} placeholder="Phone or email" />
          </Field>
        </FormSection>
      </form>
    </Sheet>
  );
}

function ClaimDetailSheet({
  claim,
  onClose,
  onEdit,
  onChanged,
}: {
  claim: Claim | null;
  onClose: () => void;
  onEdit: (c: Claim) => void;
  onChanged: (c: Claim) => void;
}) {
  const { can } = useAuth();
  const [statusOpen, setStatusOpen] = useState(false);
  const history = claim ? [...claim.status_history].reverse() : [];

  return (
    <>
      <Sheet
        open={!!claim}
        onOpenChange={(o) => !o && onClose()}
        title={claim ? `Claim ${claim.claim_number ?? ""}`.trim() : "Claim"}
        description={claim ? [claim.property_name, claim.policy_label].filter(Boolean).join(" · ") || undefined : undefined}
        className="max-w-2xl"
        footer={
          claim ? (
            <>
              <Button onClick={onClose}>Close</Button>
              {can("operations", "edit") && claim.status !== "closed" && <Button onClick={() => setStatusOpen(true)}>Change status</Button>}
              {can("operations", "edit") && (
                <Button variant="primary" onClick={() => onEdit(claim)}>
                  <Pencil /> Edit
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {claim && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <OpsStatusBadge status={claim.status} />
              {claim.closed_on && <span className="text-xs text-ink-3">Closed {formatDate(claim.closed_on)}</span>}
            </div>
            <FieldGrid cols={3}>
              <FieldItem label="Incident">{formatDate(claim.incident_on)}</FieldItem>
              <FieldItem label="Reported">{claim.reported_on ? formatDate(claim.reported_on) : null}</FieldItem>
              <FieldItem label="Cause">{claim.cause}</FieldItem>
              <FieldItem label="Claimed">{claim.claimed_amount != null ? formatCurrency(claim.claimed_amount) : null}</FieldItem>
              <FieldItem label="Reserve">{claim.reserve_amount != null ? formatCurrency(claim.reserve_amount) : null}</FieldItem>
              <FieldItem label="Paid">{claim.paid_amount != null ? formatCurrency(claim.paid_amount) : null}</FieldItem>
              <FieldItem label="Deductible applied">{claim.deductible_applied != null ? formatCurrency(claim.deductible_applied) : null}</FieldItem>
              <FieldItem label="Adjuster">{claim.adjuster_name}</FieldItem>
              <FieldItem label="Adjuster contact">{claim.adjuster_contact}</FieldItem>
            </FieldGrid>
            {claim.description && <p className="whitespace-pre-wrap rounded-md border border-line bg-subtle/60 px-3 py-2 text-sm text-ink-2">{claim.description}</p>}

            <Card>
              <CardHeader title="Status history" />
              <CardBody>
                {history.length === 0 ? (
                  <p className="text-sm text-ink-3">No status changes yet.</p>
                ) : (
                  <ol className="relative space-y-4 before:absolute before:bottom-1 before:left-[5px] before:top-1 before:w-px before:bg-line">
                    {history.map((h, i) => (
                      <li key={`${h.at}-${i}`} className="relative flex gap-3">
                        <span className="relative z-10 mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-surface bg-ink-3" />
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-1.5 text-sm">
                            {h.from ? (
                              <>
                                <OpsStatusBadge status={h.from} />
                                <ArrowRight className="size-3 text-ink-3" />
                              </>
                            ) : null}
                            <OpsStatusBadge status={h.to} />
                            <span className="text-xs text-ink-3">
                              {h.by_name ?? "System"} · {formatDateTime(h.at)}
                            </span>
                          </p>
                          {h.note && <p className="mt-1 text-sm text-ink-2">{h.note}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </CardBody>
            </Card>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-ink">Claim documents</h4>
              <RecordDocuments entityType="insurance_claim" entityId={claim.id} />
            </div>
          </div>
        )}
      </Sheet>
      {claim && <ClaimStatusDialog claim={claim} open={statusOpen} onOpenChange={setStatusOpen} onSaved={onChanged} />}
    </>
  );
}

function ClaimStatusDialog({ claim, open, onOpenChange, onSaved }: { claim: Claim; open: boolean; onOpenChange: (o: boolean) => void; onSaved: (c: Claim) => void }) {
  const change = useClaimStatus(claim.id);
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [paid, setPaid] = useState("");

  useEffect(() => {
    if (open) {
      setStatus(CLAIM_STATUSES.find((s) => s !== claim.status) ?? "open");
      setNote("");
      setPaid(str(claim.paid_amount));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () =>
    change.mutate(
      { status, note: txt(note), paid_amount: num(paid) },
      {
        onSuccess: (c) => {
          toast.success(`Claim set to ${titleCase(c.status)}`);
          onOpenChange(false);
          onSaved(c);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change claim status"
      description={`Currently ${titleCase(claim.status)}. Every change is kept in the status history.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!status} loading={change.isPending} onClick={submit}>
            Update status
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="New status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} options={CLAIM_STATUSES.filter((s) => s !== claim.status).map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Paid amount ($)" hint="Updates the total paid on the claim">
          <Input value={paid} onChange={(e) => setPaid(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Adjuster approved partial payment" />
        </Field>
      </div>
    </Dialog>
  );
}

/* ================================================================== property tax */

type TaxSection = "assessments" | "protests" | "payments";
const TAX_SECTIONS: TaxSection[] = ["assessments", "protests", "payments"];

export function PropertyTaxTab({ propertyId, creating, onCreatingChange }: TabProps) {
  const [create, setCreate] = useCreating(creating, onCreatingChange);
  return propertyId ? (
    <TaxScoped propertyId={propertyId} creating={create} setCreating={setCreate} showCreate={!onCreatingChange} />
  ) : (
    <TaxUrl creating={create} setCreating={setCreate} showCreate={!onCreatingChange} />
  );
}

interface TaxHostProps {
  creating: boolean;
  setCreating: (o: boolean) => void;
  showCreate: boolean;
}

function TaxScoped({ propertyId, ...rest }: TaxHostProps & { propertyId: string }) {
  const [section, setSection] = useState<TaxSection>("assessments");
  return <TaxView {...rest} propertyId={propertyId} section={section} onSection={setSection} />;
}

function TaxUrl(props: TaxHostProps) {
  const url = useUrlState();
  const raw = url.get("section");
  const section = TAX_SECTIONS.includes(raw as TaxSection) ? (raw as TaxSection) : "assessments";
  return <TaxView {...props} section={section} onSection={(s) => url.replaceAll({ tab: url.get("tab"), section: s === "assessments" ? null : s })} />;
}

function TaxSummaryCards({ propertyId }: { propertyId?: string }) {
  const { data: s } = useTaxSummary(propertyId ? { property_id: propertyId } : {});
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <StatCard label="Protests" value={s ? formatNumber(s.protests) : "—"} />
      <StatCard label="Resolved" value={s ? formatNumber(s.resolved) : "—"} />
      <StatCard label="Success rate" value={s ? formatPercent(s.success_rate, 0) : "—"} hint="Resolved with a value reduction" />
      <StatCard label="Value reduction" value={s ? compact(s.total_value_reduction) : "—"} />
      <StatCard label="Tax savings" value={s ? compact(s.total_tax_savings) : "—"} tone={s && s.total_tax_savings > 0 ? "positive" : "default"} />
      <StatCard label="Consultant fees" value={s ? compact(s.total_consultant_fees) : "—"} />
      <StatCard
        label="Net savings"
        value={s ? compact(s.total_net_savings) : "—"}
        tone={s ? (s.total_net_savings > 0 ? "positive" : s.total_net_savings < 0 ? "negative" : "default") : "default"}
      />
    </div>
  );
}

function TaxView({
  propertyId,
  section,
  onSection,
  creating,
  setCreating,
  showCreate,
}: TaxHostProps & { propertyId?: string; section: TaxSection; onSection: (s: TaxSection) => void }) {
  const [protest, setProtest] = useState<Protest | null>(null);
  const fixed = propertyId ? { property_id: propertyId } : undefined;

  return (
    <div className="space-y-4">
      <TaxSummaryCards propertyId={propertyId} />
      <Segmented
        value={section}
        onChange={onSection}
        options={[
          { value: "assessments", label: "Assessments" },
          { value: "protests", label: "Protests" },
          { value: "payments", label: "Payments" },
        ]}
      />
      {section === "assessments" && (
        <ListHost<Assessment> qk="tax" path="/tax/assessments" fixed={fixed}>
          {(ctx) => <AssessmentsView ctx={ctx} propertyId={propertyId} onCreate={() => setCreating(true)} showCreate={showCreate} onOpenProtest={setProtest} />}
        </ListHost>
      )}
      {section === "protests" && (
        <ListHost<Protest> qk="tax" path="/tax/protests" fixed={fixed}>
          {(ctx) => <ProtestsView ctx={ctx} onOpen={setProtest} />}
        </ListHost>
      )}
      {section === "payments" && (
        <ListHost<TaxPayment> qk="tax" path="/tax/payments" fixed={fixed}>
          {(ctx) => <PaymentsView ctx={ctx} propertyId={propertyId} />}
        </ListHost>
      )}

      <AssessmentSheet open={creating} onOpenChange={setCreating} assessment={null} propertyId={propertyId} />
      <ProtestSheet protest={protest} onChange={setProtest} onClose={() => setProtest(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ assessments */

function useArchiveAssessment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tax/assessments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tax"] }),
  });
}

function AssessmentsView({
  ctx,
  propertyId,
  onCreate,
  showCreate,
  onOpenProtest,
}: {
  ctx: ListCtx<Assessment>;
  propertyId?: string;
  onCreate: () => void;
  showCreate: boolean;
  onOpenProtest: (p: Protest) => void;
}) {
  const { can } = useAuth();
  const { state, scoped } = ctx;
  const [editing, setEditing] = useState<Assessment | null>(null);
  const [starting, setStarting] = useState<Assessment | null>(null);
  const [archiving, setArchiving] = useState<Assessment | null>(null);
  const archive = useArchiveAssessment();

  const columns: Column<Assessment>[] = [
    { id: "year", header: "Year", sortKey: "tax_year", cell: (a) => <span className="font-medium tabular">{a.tax_year}</span> },
    { id: "property", header: "Property", cell: (a) => <span className="block max-w-[200px] truncate text-ink-2">{a.property_name ?? "—"}</span> },
    {
      id: "jurisdiction",
      header: "Jurisdiction",
      cell: (a) => (
        <div className="max-w-[200px]">
          <p className="truncate text-ink-2">{a.jurisdiction ?? "—"}</p>
          {a.account_number && <p className="truncate font-mono text-xs text-ink-3">{a.account_number}</p>}
        </div>
      ),
    },
    { id: "land", header: "Land", align: "right", hideable: true, cell: (a) => compact(a.assessed_land) },
    { id: "improvements", header: "Improvements", align: "right", hideable: true, cell: (a) => compact(a.assessed_improvements) },
    { id: "total", header: "Total", sortKey: "assessed_total", align: "right", cell: (a) => <span className="font-medium">{formatCurrency(a.assessed_total)}</span> },
    {
      id: "change",
      header: "vs prior",
      align: "right",
      cell: (a) =>
        a.change_pct == null ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className={cn(a.change_pct > 0 ? "font-medium text-negative" : a.change_pct < 0 ? "text-positive" : "text-ink-2")}>
            {a.change_pct > 0 ? "+" : ""}
            {formatPercent(a.change_pct, 1)}
          </span>
        ),
    },
    { id: "rate", header: "Tax rate", align: "right", hideable: true, cell: (a) => (a.tax_rate != null ? `${formatNumber(a.tax_rate, 4)}%` : "—") },
    { id: "tax", header: "Est. tax", align: "right", hideable: true, cell: (a) => formatCurrency(a.estimated_tax) },
    {
      id: "deadline",
      header: "Protest deadline",
      sortKey: "protest_deadline_on",
      cell: (a) => {
        const d = daysUntil(a.protest_deadline_on);
        return (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-xs text-ink-2">{formatDate(a.protest_deadline_on)}</span>
            {!a.protest_id && d !== null && d >= 0 && <span className={cn("text-xs tabular", d <= 14 ? "font-medium text-negative" : "text-ink-3")}>{d}d left</span>}
          </span>
        );
      },
    },
    {
      id: "protest",
      header: "Protest",
      cell: (a) =>
        a.protest_status ? (
          <OpsStatusBadge status={a.protest_status} />
        ) : can("operations", "create") ? (
          <Button
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              setStarting(a);
            }}
          >
            <Gavel className="!size-3.5" /> Start protest
          </Button>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      width: 44,
      cell: (a) =>
        can("operations", "edit") || can("operations", "delete") ? (
          <StopClick>
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Assessment actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {can("operations", "edit") && (
                  <MenuItem icon={<Pencil />} onSelect={() => setEditing(a)}>
                    Edit assessment
                  </MenuItem>
                )}
                {!a.protest_id && can("operations", "create") && (
                  <MenuItem icon={<Gavel />} onSelect={() => setStarting(a)}>
                    Start protest
                  </MenuItem>
                )}
                {can("operations", "delete") && (
                  <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(a)}>
                    Archive
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </StopClick>
        ) : null,
    },
  ];

  const chips = chipsFor(state, [{ key: "tax_year", label: "Tax year", format: (v) => v }]);
  const filtered = chips.length > 0 || !!state.get("q");

  return (
    <>
      <ListCard
        toolbar={
          <TabToolbar
            state={state}
            scoped={scoped}
            placeholder="Search jurisdiction or account #…"
            chips={chips}
            filters={<MoreFilters fields={MORE_TAX_YEAR} values={state.params} onApply={(v) => state.set(v)} />}
            right={
              showCreate && can("operations", "create") ? (
                <Button onClick={onCreate}>
                  <Plus /> New assessment
                </Button>
              ) : undefined
            }
          />
        }
        footer={<Pager ctx={ctx} />}
      >
        <DataTable
          columns={columns}
          data={ctx.data?.items}
          loading={ctx.isLoading}
          fetching={ctx.isFetching}
          sort={state.get("sort")}
          onSortChange={(sort) => state.set({ sort })}
          onRowClick={can("operations", "edit") ? (a) => setEditing(a) : undefined}
          dense={scoped}
          empty={
            <EmptyState
              icon={<Landmark />}
              title={filtered ? "No assessments match these filters" : "No assessments recorded"}
              description={filtered ? "Try removing a filter." : "Record each year's assessment notice to track value changes and protest deadlines."}
              action={
                !filtered && can("operations", "create") ? (
                  <Button onClick={onCreate}>
                    <Plus /> New assessment
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>
      <AssessmentSheet open={!!editing} onOpenChange={(o) => !o && setEditing(null)} assessment={editing} propertyId={propertyId} />
      <StartProtestDialog
        assessment={starting}
        onClose={() => setStarting(null)}
        onStarted={(p) => {
          setStarting(null);
          onOpenProtest(p);
        }}
      />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this assessment?"
        description="It is removed from the assessment history. Corrections should be made by editing instead; edits keep before/after values in the audit trail."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() =>
          archiving &&
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast.success("Assessment archived");
              setArchiving(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

function AssessmentSheet({
  open,
  onOpenChange,
  assessment,
  propertyId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  assessment: Assessment | null;
  propertyId?: string;
}) {
  const save = useSaveAssessment(assessment?.id);
  const [conflict, setConflict] = useState<string | null>(null);
  const { form, bind, setField } = useFormState(open, () => ({
    property_id: assessment ? assessment.property_id : propertyId ?? "",
    tax_year: assessment ? String(assessment.tax_year) : String(new Date().getFullYear()),
    jurisdiction: str(assessment?.jurisdiction),
    account_number: str(assessment?.account_number),
    assessed_land: str(assessment?.assessed_land),
    assessed_improvements: str(assessment?.assessed_improvements),
    assessed_total: str(assessment?.assessed_total),
    market_value: str(assessment?.market_value),
    taxable_value: str(assessment?.taxable_value),
    tax_rate: str(assessment?.tax_rate),
    estimated_tax: str(assessment?.estimated_tax),
    notice_received_on: str(assessment?.notice_received_on),
    protest_deadline_on: str(assessment?.protest_deadline_on),
    source: assessment ? str(assessment.source) : "Assessment notice",
    observed_on: str(assessment?.observed_on),
    notes: str(assessment?.notes),
  }));

  useEffect(() => {
    if (open) setConflict(null);
  }, [open]);

  const land = num(form.assessed_land);
  const impr = num(form.assessed_improvements);
  const sum = land !== null && impr !== null ? land + impr : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setConflict(null);
    const total = num(form.assessed_total) ?? sum;
    const year = num(form.tax_year);
    if (!form.property_id) return toast.error("Select the property");
    if (total === null) return toast.error("Enter the total assessed value");
    if (year === null) return toast.error("Enter the tax year");
    const data: AssessmentInput = {
      property_id: form.property_id,
      parcel_id: assessment?.parcel_id ?? null,
      tax_year: year,
      jurisdiction: txt(form.jurisdiction),
      account_number: txt(form.account_number),
      assessed_land: land,
      assessed_improvements: impr,
      assessed_total: total,
      market_value: num(form.market_value),
      taxable_value: num(form.taxable_value),
      tax_rate: num(form.tax_rate),
      estimated_tax: num(form.estimated_tax),
      notice_received_on: txt(form.notice_received_on),
      protest_deadline_on: txt(form.protest_deadline_on),
      source: txt(form.source),
      observed_on: txt(form.observed_on),
      notes: txt(form.notes),
    };
    save.mutate(data, {
      onSuccess: () => {
        toast.success(assessment ? "Assessment updated" : "Assessment recorded");
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) setConflict(err.message);
        else toast.error(errorMessage(err));
      },
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={assessment ? `Edit ${assessment.tax_year} assessment` : "New assessment"}
      description={assessment ? "Corrections keep before and after values in the activity log." : "A protest deadline creates a blocking critical date."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="assessment-form" loading={save.isPending}>
            {assessment ? "Save changes" : "Record assessment"}
          </Button>
        </>
      }
    >
      <form id="assessment-form" onSubmit={submit} className="space-y-6">
        {conflict && <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm text-caution">{conflict}</div>}
        <FormSection title="Notice">
          <Field label="Property" required className="col-span-2">
            <PropertyPicker value={form.property_id || null} onChange={(id) => setField("property_id", id ?? "")} />
          </Field>
          <Field label="Tax year" required>
            <Input {...bind("tax_year")} inputMode="numeric" required />
          </Field>
          <Field label="Jurisdiction">
            <Input {...bind("jurisdiction")} placeholder="e.g. Travis CAD" />
          </Field>
          <Field label="Account number">
            <Input {...bind("account_number")} />
          </Field>
          <Field label="Notice received on">
            <Input type="date" {...bind("notice_received_on")} />
          </Field>
          <Field label="Protest deadline">
            <Input type="date" {...bind("protest_deadline_on")} />
          </Field>
        </FormSection>
        <FormSection title="Values">
          <Field label="Land ($)">
            <Input {...bind("assessed_land")} inputMode="decimal" />
          </Field>
          <Field label="Improvements ($)">
            <Input {...bind("assessed_improvements")} inputMode="decimal" />
          </Field>
          <Field label="Total assessed ($)" required hint={sum !== null && !form.assessed_total ? `Land + improvements = ${formatCurrency(sum)}` : undefined}>
            <Input {...bind("assessed_total")} inputMode="decimal" placeholder={sum !== null ? String(sum) : undefined} />
          </Field>
          <Field label="Market value ($)">
            <Input {...bind("market_value")} inputMode="decimal" />
          </Field>
          <Field label="Taxable value ($)">
            <Input {...bind("taxable_value")} inputMode="decimal" />
          </Field>
          <Field label="Tax rate (%)" hint="Percent of taxable value">
            <Input {...bind("tax_rate")} inputMode="decimal" placeholder="e.g. 2.15" />
          </Field>
          <Field label="Estimated tax ($)" hint="Calculated from the rate when left empty" className="col-span-2">
            <Input {...bind("estimated_tax")} inputMode="decimal" />
          </Field>
        </FormSection>
        <FormSection title="Source">
          <Field label="Source">
            <Input {...bind("source")} />
          </Field>
          <Field label="Observed on">
            <Input type="date" {...bind("observed_on")} />
          </Field>
          <Field label="Notes" className="col-span-2">
            <Textarea {...bind("notes")} />
          </Field>
        </FormSection>
      </form>
    </Sheet>
  );
}

function StartProtestDialog({ assessment, onClose, onStarted }: { assessment: Assessment | null; onClose: () => void; onStarted: (p: Protest) => void }) {
  const create = useSaveProtest();
  const { form, bind, setField } = useFormState(!!assessment, () => ({
    deadline_on: str(assessment?.protest_deadline_on),
    consultant_organization_id: "",
    consultant_name: "",
    consultant_fee_pct: "",
    consultant_fee_flat: "",
    owner_opinion_value: "",
  }));

  const submit = () => {
    if (!assessment) return;
    create.mutate(
      {
        assessment_id: assessment.id,
        status: "considering",
        deadline_on: txt(form.deadline_on),
        consultant_organization_id: txt(form.consultant_organization_id),
        consultant_name: txt(form.consultant_name),
        consultant_fee_pct: num(form.consultant_fee_pct),
        consultant_fee_flat: num(form.consultant_fee_flat),
        owner_opinion_value: num(form.owner_opinion_value),
      },
      {
        onSuccess: (p) => {
          toast.success("Protest started");
          onStarted(p);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={!!assessment}
      onOpenChange={(o) => !o && onClose()}
      title={assessment ? `Start ${assessment.tax_year} protest` : "Start protest"}
      description={assessment ? `${assessment.property_name ?? "Property"} · assessed at ${formatCurrency(assessment.assessed_total)}` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Start protest
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Filing deadline" className="col-span-2" hint="Tracked as a blocking critical date">
          <Input type="date" {...bind("deadline_on")} />
        </Field>
        <Field label="Consultant firm">
          <OrganizationPicker value={form.consultant_organization_id || null} onChange={(id) => setField("consultant_organization_id", id ?? "")} />
        </Field>
        <Field label="Consultant contact">
          <Input {...bind("consultant_name")} />
        </Field>
        <Field label="Contingency fee (%)">
          <Input {...bind("consultant_fee_pct")} inputMode="decimal" />
        </Field>
        <Field label="Flat fee ($)">
          <Input {...bind("consultant_fee_flat")} inputMode="decimal" />
        </Field>
        <Field label="Owner opinion of value ($)" className="col-span-2">
          <Input {...bind("owner_opinion_value")} inputMode="decimal" />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ protests */

const protestColumns: Column<Protest>[] = [
  { id: "year", header: "Year", sortKey: "tax_year", cell: (p) => <span className="font-medium tabular">{p.tax_year}</span> },
  { id: "property", header: "Property", cell: (p) => <span className="block max-w-[200px] truncate text-ink-2">{p.property_name ?? "—"}</span> },
  { id: "status", header: "Status", cell: (p) => <OpsStatusBadge status={p.status} /> },
  {
    id: "deadline",
    header: "Deadline",
    sortKey: "deadline_on",
    cell: (p) => (
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-xs text-ink-2">{formatDate(p.deadline_on)}</span>
        {p.days_to_deadline != null && (
          <span className={cn("text-xs tabular", p.days_to_deadline <= 14 ? "font-medium text-negative" : "text-ink-3")}>
            {p.days_to_deadline < 0 ? `${Math.abs(p.days_to_deadline)}d past` : `${p.days_to_deadline}d left`}
          </span>
        )}
      </span>
    ),
  },
  { id: "consultant", header: "Consultant", cell: (p) => <span className="block max-w-[160px] truncate text-ink-2">{p.consultant_name ?? "—"}</span> },
  {
    id: "values",
    header: "Assessed → final",
    align: "right",
    cell: (p) => (
      <span className="whitespace-nowrap">
        {compact(p.assessed_total)}
        <span className="text-ink-3"> → </span>
        {p.final_value != null ? compact(p.final_value) : <span className="text-ink-3">—</span>}
      </span>
    ),
  },
  { id: "reduction", header: "Value reduction", align: "right", cell: (p) => <span className={signedClass(p.value_reduction)}>{formatCurrency(p.value_reduction)}</span> },
  { id: "savings", header: "Tax savings", align: "right", cell: (p) => <span className={signedClass(p.tax_savings)}>{formatCurrency(p.tax_savings)}</span> },
  { id: "fee", header: "Fee", align: "right", cell: (p) => formatCurrency(p.consultant_fee) },
  { id: "net", header: "Net savings", sortKey: "net_savings", align: "right", cell: (p) => <span className={cn("font-medium", signedClass(p.net_savings))}>{formatCurrency(p.net_savings)}</span> },
];

function ProtestsView({ ctx, onOpen }: { ctx: ListCtx<Protest>; onOpen: (p: Protest) => void }) {
  const { state, scoped } = ctx;
  const chips = chipsFor(state, [
    { key: "status", label: "Status" },
    { key: "tax_year", label: "Tax year", format: (v) => v },
  ]);
  const filtered = chips.length > 0 || !!state.get("q");
  return (
    <ListCard
      toolbar={
        <TabToolbar
          state={state}
          scoped={scoped}
          placeholder="Search consultant or notes…"
          chips={chips}
          filters={
            <>
              <FacetFilter label="Status" options={options(PROTEST_STATUSES)} selected={state.getAll("status")} onChange={(v) => state.set({ status: v })} />
              <MoreFilters fields={MORE_TAX_YEAR} values={state.params} onApply={(v) => state.set(v)} />
            </>
          }
        />
      }
      footer={<Pager ctx={ctx} />}
    >
      <DataTable
        columns={protestColumns}
        data={ctx.data?.items}
        loading={ctx.isLoading}
        fetching={ctx.isFetching}
        sort={state.get("sort")}
        onSortChange={(sort) => state.set({ sort })}
        onRowClick={onOpen}
        dense={scoped}
        empty={
          <EmptyState
            icon={<Gavel />}
            title={filtered ? "No protests match these filters" : "No tax protests"}
            description={filtered ? "Try removing a filter." : "Start a protest from an assessment to track the deadline, consultant, evidence and outcome."}
          />
        }
      />
    </ListCard>
  );
}

function ProtestSheet({ protest, onChange, onClose }: { protest: Protest | null; onChange: (p: Protest) => void; onClose: () => void }) {
  const [hearingOpen, setHearingOpen] = useState(false);
  return (
    <>
      <Sheet
        open={!!protest}
        onOpenChange={(o) => !o && onClose()}
        title={protest ? `${protest.tax_year} tax protest` : "Tax protest"}
        description={protest?.property_name ?? undefined}
        className="max-w-2xl"
      >
        {protest && <ProtestEditor key={`${protest.id}:${protest.updated_at}`} protest={protest} onChange={onChange} onRecordHearing={() => setHearingOpen(true)} />}
      </Sheet>
      {protest && <HearingDialog protest={protest} open={hearingOpen} onOpenChange={setHearingOpen} onSaved={onChange} />}
    </>
  );
}

function ProtestEditor({ protest, onChange, onRecordHearing }: { protest: Protest; onChange: (p: Protest) => void; onRecordHearing: () => void }) {
  const { can } = useAuth();
  const save = useSaveProtest(protest.id);
  const editable = can("operations", "edit");
  const [form, setForm] = useState<FormState>(() => ({
    status: protest.status,
    filed_on: str(protest.filed_on),
    deadline_on: str(protest.deadline_on),
    hearing_on: str(protest.hearing_on),
    consultant_organization_id: str(protest.consultant_organization_id),
    consultant_name: str(protest.consultant_name),
    consultant_fee_pct: str(protest.consultant_fee_pct),
    consultant_fee_flat: str(protest.consultant_fee_flat),
    owner_opinion_value: str(protest.owner_opinion_value),
    evidence_notes: str(protest.evidence_notes),
    notes: str(protest.notes),
  }));
  const setField = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const bind = (k: string) => ({ value: form[k] ?? "", onChange: (e: { target: { value: string } }) => setField(k, e.target.value), disabled: !editable });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        status: form.status,
        filed_on: txt(form.filed_on),
        deadline_on: txt(form.deadline_on),
        hearing_on: txt(form.hearing_on),
        consultant_organization_id: txt(form.consultant_organization_id),
        consultant_name: txt(form.consultant_name),
        consultant_fee_pct: num(form.consultant_fee_pct),
        consultant_fee_flat: num(form.consultant_fee_flat),
        owner_opinion_value: num(form.owner_opinion_value),
        evidence_notes: txt(form.evidence_notes),
        notes: txt(form.notes),
      },
      {
        onSuccess: (p) => {
          toast.success("Protest updated");
          onChange(p);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const deadlineDays = protest.days_to_deadline;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <OpsStatusBadge status={protest.status} />
        {protest.deadline_on && <span className="text-xs text-ink-3">Deadline {formatDate(protest.deadline_on)}</span>}
        {deadlineDays != null && (
          <span className={cn("text-xs tabular", deadlineDays <= 14 ? "font-medium text-negative" : "text-ink-3")}>
            {deadlineDays < 0 ? `${Math.abs(deadlineDays)} days past` : `${deadlineDays} days left`}
          </span>
        )}
      </div>

      <Card>
        <CardHeader
          title="Outcome"
          description="Savings = value reduction × tax rate, net of consultant fees."
          actions={
            editable ? (
              <Button size="sm" onClick={onRecordHearing}>
                <Gavel /> {protest.hearing_result ? "Update hearing result" : "Record hearing result"}
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          {protest.hearing_result ? (
            <FieldGrid cols={3}>
              <FieldItem label="Hearing result">{titleCase(protest.hearing_result)}</FieldItem>
              <FieldItem label="Assessed value">{formatCurrency(protest.assessed_total)}</FieldItem>
              <FieldItem label="Final value">{formatCurrency(protest.final_value)}</FieldItem>
              <FieldItem label="Value reduction">
                <span className={signedClass(protest.value_reduction)}>{formatCurrency(protest.value_reduction)}</span>
              </FieldItem>
              <FieldItem label="Tax savings">
                <span className={signedClass(protest.tax_savings)}>{formatCurrency(protest.tax_savings)}</span>
              </FieldItem>
              <FieldItem label="Consultant fee">{formatCurrency(protest.consultant_fee)}</FieldItem>
              <FieldItem label="Net savings">
                <span className={cn("font-medium", signedClass(protest.net_savings))}>{formatCurrency(protest.net_savings)}</span>
              </FieldItem>
              <FieldItem label="Resolved on">{formatDate(protest.resolved_on)}</FieldItem>
            </FieldGrid>
          ) : (
            <p className="text-sm text-ink-3">No hearing result yet. Assessed at {formatCurrency(protest.assessed_total)}.</p>
          )}
        </CardBody>
      </Card>

      <form onSubmit={submit} className="space-y-4">
        <FormSection title="Protest details">
          <Field label="Status">
            <Select {...bind("status")} options={PROTEST_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Filed on" hint="Set automatically when marked filed">
            <Input type="date" {...bind("filed_on")} />
          </Field>
          <Field label="Filing deadline">
            <Input type="date" {...bind("deadline_on")} />
          </Field>
          <Field label="Hearing date">
            <Input type="date" {...bind("hearing_on")} />
          </Field>
          <Field label="Consultant firm">
            {editable ? (
              <OrganizationPicker value={form.consultant_organization_id || null} onChange={(id) => setField("consultant_organization_id", id ?? "")} />
            ) : (
              <Input value={form.consultant_organization_id ? "Linked organization" : ""} disabled />
            )}
          </Field>
          <Field label="Consultant contact">
            <Input {...bind("consultant_name")} />
          </Field>
          <Field label="Contingency fee (%)">
            <Input {...bind("consultant_fee_pct")} inputMode="decimal" />
          </Field>
          <Field label="Flat fee ($)">
            <Input {...bind("consultant_fee_flat")} inputMode="decimal" />
          </Field>
          <Field label="Owner opinion of value ($)" className="col-span-2">
            <Input {...bind("owner_opinion_value")} inputMode="decimal" />
          </Field>
          <Field label="Evidence notes" className="col-span-2">
            <Textarea {...bind("evidence_notes")} placeholder="Comparable sales, income approach, condition issues…" />
          </Field>
          <Field label="Notes" className="col-span-2">
            <Textarea {...bind("notes")} />
          </Field>
        </FormSection>
        {editable && (
          <div className="flex justify-end">
            <Button variant="primary" type="submit" loading={save.isPending}>
              Save protest
            </Button>
          </div>
        )}
      </form>

      <RecordCriticalDates relatedType="tax_protest" relatedId={protest.id} propertyId={protest.property_id} title="Deadlines & hearing" />
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-ink">Evidence package</h4>
        <RecordDocuments entityType="tax_protest" entityId={protest.id} />
      </div>
    </div>
  );
}

function HearingDialog({ protest, open, onOpenChange, onSaved }: { protest: Protest; open: boolean; onOpenChange: (o: boolean) => void; onSaved: (p: Protest) => void }) {
  const record = useRecordHearing(protest.id);
  const [result, setResult] = useState<string>("reduced");
  const [finalValue, setFinalValue] = useState("");
  const [resolvedOn, setResolvedOn] = useState("");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<Protest | null>(null);

  useEffect(() => {
    if (open) {
      setResult(protest.hearing_result ?? "reduced");
      setFinalValue(str(protest.final_value));
      setResolvedOn(protest.resolved_on ?? todayIso());
      setNote("");
      setSaved(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const needsValue = ["reduced", "increased", "settled"].includes(result);

  const submit = () =>
    record.mutate(
      { hearing_result: result, final_value: num(finalValue), resolved_on: txt(resolvedOn), note: txt(note) },
      {
        onSuccess: (p) => {
          toast.success("Hearing result recorded");
          setSaved(p);
          onSaved(p);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={saved ? "Protest outcome" : "Record hearing result"}
      description={saved ? `${saved.tax_year} protest · ${titleCase(saved.status)}` : `Assessed at ${formatCurrency(protest.assessed_total)}. Savings are computed from the assessment tax rate.`}
      footer={
        saved ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={record.isPending} disabled={needsValue && !finalValue.trim()} onClick={submit}>
              Save result
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Value reduction" value={formatCurrency(saved.value_reduction)} />
          <StatCard label="Tax savings" value={formatCurrency(saved.tax_savings)} tone={(saved.tax_savings ?? 0) > 0 ? "positive" : "default"} />
          <StatCard label="Consultant fee" value={formatCurrency(saved.consultant_fee)} />
          <StatCard
            label="Net savings"
            value={formatCurrency(saved.net_savings)}
            tone={(saved.net_savings ?? 0) > 0 ? "positive" : (saved.net_savings ?? 0) < 0 ? "negative" : "default"}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Result">
            <Select value={result} onChange={(e) => setResult(e.target.value)} options={HEARING_RESULTS.map((r) => ({ value: r, label: titleCase(r) }))} />
          </Field>
          <Field label="Resolved on">
            <Input type="date" value={resolvedOn} onChange={(e) => setResolvedOn(e.target.value)} />
          </Field>
          <Field label="Final assessed value ($)" required={needsValue} hint={needsValue ? undefined : "Defaults to the assessed value"} className="col-span-2">
            <Input value={finalValue} onChange={(e) => setFinalValue(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Note" className="col-span-2">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ payments */

const PAYMENT_METHODS = ["check", "ach", "wire", "online", "escrow", "other"];

function paymentLate(p: TaxPayment) {
  if (p.status === "late") return true;
  if (p.status !== "scheduled") return false;
  const d = daysUntil(p.due_on);
  return d !== null && d < 0;
}

function PaymentsView({ ctx, propertyId }: { ctx: ListCtx<TaxPayment>; propertyId?: string }) {
  const { can } = useAuth();
  const { state, scoped } = ctx;
  const [scheduling, setScheduling] = useState(false);
  const [active, setActive] = useState<TaxPayment | null>(null);

  const columns: Column<TaxPayment>[] = [
    { id: "year", header: "Year", sortKey: "tax_year", cell: (p) => <span className="font-medium tabular">{p.tax_year}</span> },
    { id: "installment", header: "Installment", cell: (p) => <span className="text-ink-2">{p.installment ?? "—"}</span> },
    { id: "property", header: "Property", cell: (p) => <span className="block max-w-[200px] truncate text-ink-2">{p.property_name ?? "—"}</span> },
    { id: "due", header: "Amount due", sortKey: "amount_due", align: "right", cell: (p) => formatCurrency(p.amount_due) },
    {
      id: "due_on",
      header: "Due on",
      sortKey: "due_on",
      cell: (p) => <span className={cn("whitespace-nowrap text-xs", paymentLate(p) ? "font-medium text-negative" : "text-ink-2")}>{formatDate(p.due_on)}</span>,
    },
    { id: "status", header: "Status", sortKey: "status", cell: (p) => <OpsStatusBadge status={paymentLate(p) && p.status === "scheduled" ? "late" : p.status} /> },
    { id: "paid", header: "Paid", align: "right", cell: (p) => formatCurrency(p.amount_paid) },
    { id: "paid_on", header: "Paid on", cell: (p) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDate(p.paid_on)}</span> },
    { id: "confirmation", header: "Confirmation #", cell: (p) => <span className="font-mono text-xs text-ink-2">{p.confirmation_number ?? "—"}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (p) =>
        p.status !== "confirmed" && can("operations", "edit") ? (
          <StopClick>
            <Button size="xs" onClick={() => setActive(p)}>
              <Receipt className="!size-3.5" /> Confirm
            </Button>
          </StopClick>
        ) : null,
    },
  ];

  const chips = chipsFor(state, [
    { key: "status", label: "Status" },
    { key: "tax_year", label: "Tax year", format: (v) => v },
  ]);
  const filtered = chips.length > 0 || !!state.get("q");

  return (
    <>
      <ListCard
        toolbar={
          <TabToolbar
            state={state}
            scoped={scoped}
            placeholder="Search confirmation # or installment…"
            chips={chips}
            filters={
              <>
                <FacetFilter label="Status" options={options(PAYMENT_STATUSES)} selected={state.getAll("status")} onChange={(v) => state.set({ status: v })} />
                <MoreFilters fields={MORE_TAX_YEAR} values={state.params} onApply={(v) => state.set(v)} />
              </>
            }
            right={
              can("operations", "create") ? (
                <Button onClick={() => setScheduling(true)}>
                  <Plus /> Schedule payment
                </Button>
              ) : undefined
            }
          />
        }
        footer={<Pager ctx={ctx} />}
      >
        <DataTable
          columns={columns}
          data={ctx.data?.items}
          loading={ctx.isLoading}
          fetching={ctx.isFetching}
          sort={state.get("sort")}
          onSortChange={(sort) => state.set({ sort })}
          onRowClick={(p) => setActive(p)}
          dense={scoped}
          empty={
            <EmptyState
              icon={<Receipt />}
              title={filtered ? "No payments match these filters" : "No tax payments scheduled"}
              description={filtered ? "Try removing a filter." : "Schedule each installment so due dates are tracked and payments are confirmed with a receipt."}
            />
          }
        />
      </ListCard>
      <SchedulePaymentDialog open={scheduling} onOpenChange={setScheduling} propertyId={propertyId} />
      <PaymentDialog payment={active} onClose={() => setActive(null)} />
    </>
  );
}

function SchedulePaymentDialog({ open, onOpenChange, propertyId }: { open: boolean; onOpenChange: (o: boolean) => void; propertyId?: string }) {
  const create = useCreatePayment();
  const { form, bind, setField } = useFormState(open, () => ({
    property_id: propertyId ?? "",
    tax_year: String(new Date().getFullYear()),
    installment: "",
    amount_due: "",
    due_on: "",
    notes: "",
  }));
  const year = num(form.tax_year);
  const amount = num(form.amount_due);
  const valid = !!form.property_id && year !== null && amount !== null && !!form.due_on;

  const submit = () => {
    if (!valid || year === null || amount === null) return;
    create.mutate(
      { property_id: form.property_id, tax_year: year, installment: txt(form.installment), amount_due: amount, due_on: form.due_on, notes: txt(form.notes) },
      {
        onSuccess: () => {
          toast.success("Payment scheduled");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Schedule tax payment"
      description="The due date becomes a blocking critical date until the payment is confirmed."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={create.isPending} onClick={submit}>
            Schedule payment
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {!propertyId && (
          <Field label="Property" required className="col-span-2">
            <PropertyPicker value={form.property_id || null} onChange={(id) => setField("property_id", id ?? "")} />
          </Field>
        )}
        <Field label="Tax year" required>
          <Input {...bind("tax_year")} inputMode="numeric" />
        </Field>
        <Field label="Installment">
          <Input {...bind("installment")} placeholder="e.g. 1st half" />
        </Field>
        <Field label="Amount due ($)" required>
          <Input {...bind("amount_due")} inputMode="decimal" />
        </Field>
        <Field label="Due on" required>
          <Input type="date" {...bind("due_on")} />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea {...bind("notes")} />
        </Field>
      </div>
    </Dialog>
  );
}

function PaymentDialog({ payment, onClose }: { payment: TaxPayment | null; onClose: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirmPayment(payment?.id ?? "");
  const [done, setDone] = useState<TaxPayment | null>(null);
  const { form, bind } = useFormState(!!payment, () => ({
    amount_paid: str(payment?.amount_due),
    paid_on: todayIso(),
    method: "ach",
    confirmation_number: "",
  }));

  useEffect(() => {
    if (payment) setDone(null);
  }, [payment]);

  const shown = done ?? payment;
  const confirmed = shown?.status === "confirmed";
  const canConfirm = !confirmed && can("operations", "edit");
  const amount = num(form.amount_paid);
  const valid = amount !== null && !!form.paid_on && !!form.confirmation_number.trim();

  const submit = () => {
    if (!payment || amount === null) return;
    confirm.mutate(
      { amount_paid: amount, paid_on: form.paid_on, method: txt(form.method), confirmation_number: form.confirmation_number.trim() },
      {
        onSuccess: (p) => {
          toast.success("Payment confirmed");
          setDone(p);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={!!payment}
      onOpenChange={(o) => !o && onClose()}
      className="max-w-xl"
      title={shown ? `${shown.tax_year} property tax${shown.installment ? ` · ${shown.installment}` : ""}` : "Tax payment"}
      description={shown ? `${shown.property_name ?? "Property"} · ${formatCurrency(shown.amount_due)} due ${formatDate(shown.due_on)}` : undefined}
      footer={
        canConfirm ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!valid} loading={confirm.isPending} onClick={submit}>
              Confirm payment
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )
      }
    >
      {shown && (
        <div className="space-y-4">
          {canConfirm ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount paid ($)" required>
                <Input {...bind("amount_paid")} inputMode="decimal" />
              </Field>
              <Field label="Paid on" required>
                <Input type="date" {...bind("paid_on")} />
              </Field>
              <Field label="Method">
                <Select {...bind("method")} options={PAYMENT_METHODS.map((m) => ({ value: m, label: m === "ach" ? "ACH" : titleCase(m) }))} />
              </Field>
              <Field label="Confirmation #" required>
                <Input {...bind("confirmation_number")} />
              </Field>
              <p className="col-span-2 text-xs text-ink-3">Attach the receipt after confirming.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <OpsStatusBadge status={shown.status} />
                {shown.confirmed_at && <span className="text-xs text-ink-3">Confirmed {formatDateTime(shown.confirmed_at)}</span>}
              </div>
              <FieldGrid cols={2}>
                <FieldItem label="Amount paid">{formatCurrency(shown.amount_paid)}</FieldItem>
                <FieldItem label="Paid on">{formatDate(shown.paid_on)}</FieldItem>
                <FieldItem label="Method">{shown.method ? (shown.method === "ach" ? "ACH" : titleCase(shown.method)) : null}</FieldItem>
                <FieldItem label="Confirmation #">{shown.confirmation_number}</FieldItem>
              </FieldGrid>
              {confirmed && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-ink">Receipts</h4>
                  <RecordDocuments entityType="tax_payment" entityId={shown.id} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
