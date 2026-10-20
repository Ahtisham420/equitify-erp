"use client";

import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, FileText, Layers, MoreHorizontal, Pencil, Plus, Scale, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { PropertyPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Checkbox, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import { CandidateSearchDialog } from "@/features/comps/candidate-search";
import { CompFormSheet, VerifyCompDialog } from "@/features/comps/comp-forms";
import {
  BASIS_LABELS,
  TENANT_CREDIT,
  TENANT_CREDIT_LABELS,
  VALUATION_METHOD_LABELS,
  VALUATION_METHODS,
  VERIFICATION_STATUSES,
  compLabel,
  formatMetric,
  useArchiveComp,
  useBovs,
  useCreateCompSet,
  type CompFacets,
  type CompKind,
  type CompSetListItem,
  type LeaseComp,
  type SaleComp,
  type Valuation,
} from "@/features/comps/api";
import { ValuationFormSheet } from "@/features/comps/valuation-form";
import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/features/properties/api";

const facetOptions = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
  values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

function useFilterParams(params: Record<string, string | string[]>) {
  return useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = params;
    return rest;
  }, [params]);
}

/* ------------------------------------------------------------------ new comp set dialog */

function NewCompSetDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: { kind?: CompKind; subject_property_id?: string | null; comp_ids?: string[]; criteria?: Record<string, unknown> };
}) {
  const router = useRouter();
  const create = useCreateCompSet();
  const [state, setState] = useState({ name: "", kind: initial?.kind ?? "sale", subject: initial?.subject_property_id ?? null, purpose: "valuation" });
  const key = `${open}-${initial?.kind}-${initial?.subject_property_id}-${initial?.comp_ids?.length}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    if (open) setState({ name: "", kind: initial?.kind ?? "sale", subject: initial?.subject_property_id ?? null, purpose: "valuation" });
  }

  const submit = () =>
    create.mutate(
      { name: state.name.trim(), kind: state.kind, subject_property_id: state.subject, purpose: state.purpose, comp_ids: initial?.comp_ids ?? [], criteria: initial?.criteria ?? {} },
      {
        onSuccess: (cs) => {
          toast.success("Comp set created");
          onOpenChange(false);
          router.push(`/comps/sets/${cs.id}`);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New comp set"
      description={initial?.comp_ids?.length ? `${initial.comp_ids.length} comps will be added.` : "Build the set, then add candidates and adjust."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!state.name.trim() || !state.subject} loading={create.isPending} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Subject property" required>
          <PropertyPicker value={state.subject} onChange={(id) => setState((s) => ({ ...s, subject: id }))} />
        </Field>
        <Field label="Name" required>
          <Input autoFocus value={state.name} onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. 2026 STNL sale comps, 5 mi" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Comp type">
            <Select
              value={state.kind}
              disabled={!!initial?.kind}
              onChange={(e) => setState((s) => ({ ...s, kind: e.target.value as CompKind }))}
              options={[{ value: "sale", label: "Sale comps" }, { value: "lease", label: "Lease comps" }]}
            />
          </Field>
          <Field label="Purpose">
            <Select value={state.purpose} onChange={(e) => setState((s) => ({ ...s, purpose: e.target.value }))} options={["valuation", "underwriting", "bov", "mark"].map((p) => ({ value: p, label: titleCase(p) }))} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ comps tab (sale / lease) */

function CompsTab({ kind }: { kind: CompKind }) {
  const { can } = useAuth();
  const path = kind === "sale" ? "/sale-comps" : "/lease-comps";
  const list = useListQuery<SaleComp | LeaseComp>("comps", path);
  const { url } = list;
  const filterParams = useFilterParams(url.params);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<SaleComp | LeaseComp | null>(null);
  const [creating, setCreating] = useState(false);
  const [verifying, setVerifying] = useState<SaleComp | LeaseComp | null>(null);
  const [archiving, setArchiving] = useState<SaleComp | LeaseComp | null>(null);
  const [newSet, setNewSet] = useState(false);
  const archive = useArchiveComp(kind);

  const { data: facets } = useQuery({
    queryKey: ["comps", "facets", kind, filterParams],
    queryFn: () => api.get<CompFacets>(`${path}/facets`, filterParams),
    placeholderData: (prev) => prev,
  });

  const more: MoreFilterField[] = [
    { type: "text", label: "County", key: "county" },
    { type: "text", label: "Corridor", key: "corridor" },
    { type: "date-range", label: kind === "sale" ? "Sale date" : "Commencement", minKey: "date_from", maxKey: "date_to" },
    ...(kind === "sale"
      ? ([
          { type: "range", label: "Sale price", minKey: "min_price", maxKey: "max_price", suffix: "$" },
          { type: "range", label: "Cap rate", minKey: "min_cap", maxKey: "max_cap", suffix: "%" },
        ] as MoreFilterField[])
      : ([{ type: "range", label: "Base rent", minKey: "min_rent", maxKey: "max_rent", suffix: "$/SF" }] as MoreFilterField[])),
  ];
  const chipLabels: Record<string, string> = {
    county: "County", corridor: "Corridor", date_from: "From", date_to: "To", min_price: "Min price", max_price: "Max price",
    min_cap: "Min cap", max_cap: "Max cap", min_rent: "Min rent", max_rent: "Max rent",
  };
  const chips: FilterChip[] = Object.entries(chipLabels)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label, labels] of [
    ["property_type", "Type", PROPERTY_TYPE_LABELS],
    ["verification_status", "Verification", {} as Record<string, string>],
    ["tenant_credit", "Credit", TENANT_CREDIT_LABELS],
    ["state", "State", {} as Record<string, string>],
  ] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => labels[v] ?? titleCase(v)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const rowMenu = (c: SaleComp | LeaseComp) => (
    <div onClick={(e) => e.stopPropagation()}>
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Actions">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent>
          {can("comps", "edit") && (
            <MenuItem icon={<Pencil />} onSelect={() => setEditing(c)}>
              Edit
            </MenuItem>
          )}
          {can("comps", "edit") && (
            <MenuItem icon={<BadgeCheck />} onSelect={() => setVerifying(c)}>
              Record verification
            </MenuItem>
          )}
          {can("comps", "delete") && (
            <MenuItem icon={<Trash2 />} destructive onSelect={() => setArchiving(c)}>
              Archive
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
    </div>
  );

  const verificationCell = (c: SaleComp | LeaseComp) => (
    <div className="min-w-[120px]">
      <StatusBadge status={c.verification_status} />
      {c.verification_status !== "unverified" && (
        <p className="mt-0.5 truncate text-2xs text-ink-3">
          {[c.verification_method ? titleCase(c.verification_method) : null, c.verified_by_name, formatDate(c.verified_at)].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );

  const identity = (c: SaleComp | LeaseComp) => (
    <div className="min-w-[200px] max-w-[300px]">
      <p className="truncate font-medium text-ink">{compLabel(c)}</p>
      <p className="truncate text-xs text-ink-3">{[c.city, c.state, c.corridor].filter(Boolean).join(", ") || "—"}</p>
      {c.property_id && (
        <Link href={`/properties/${c.property_id}`} onClick={(e) => e.stopPropagation()} className="text-2xs text-accent hover:underline">
          Linked property
        </Link>
      )}
    </div>
  );

  const saleColumns: Column<SaleComp>[] = [
    { id: "comp", header: "Property", sortKey: "name", cell: identity },
    { id: "type", header: "Type", hideable: true, cell: (c) => <span className="text-ink-2">{c.property_type ? PROPERTY_TYPE_LABELS[c.property_type] ?? titleCase(c.property_type) : "—"}</span> },
    { id: "date", header: "Sale date", sortKey: "sale_date", cell: (c) => <span className="whitespace-nowrap text-ink-2">{formatDate(c.sale_date)}</span> },
    { id: "price", header: "Price", sortKey: "sale_price", align: "right", cell: (c) => formatCurrency(c.sale_price, { compact: true }) },
    { id: "psf", header: "$/SF", sortKey: "price_psf", align: "right", hideable: true, cell: (c) => (c.price_psf !== null ? `$${formatNumber(c.price_psf, 2)}` : "—") },
    { id: "acre", header: "$/acre", align: "right", hideable: true, defaultHidden: true, cell: (c) => formatCurrency(c.price_per_acre, { compact: true }) },
    { id: "cap", header: "Cap", sortKey: "cap_rate", align: "right", hideable: true, cell: (c) => formatPercent(c.cap_rate, 2) },
    { id: "noi", header: "NOI", align: "right", hideable: true, defaultHidden: true, cell: (c) => formatCurrency(c.noi, { compact: true }) },
    { id: "tenant", header: "Tenant", hideable: true, cell: (c) => <span className="text-ink-2">{c.tenant_name ?? "—"}{c.tenant_credit ? <span className="ml-1 text-xs text-ink-3">({TENANT_CREDIT_LABELS[c.tenant_credit]})</span> : null}</span> },
    { id: "term", header: "Term left", align: "right", hideable: true, cell: (c) => (c.lease_term_remaining_years !== null ? `${formatNumber(c.lease_term_remaining_years, 1)} yrs` : "—") },
    { id: "parties", header: "Buyer / seller", hideable: true, defaultHidden: true, cell: (c) => <span className="text-xs text-ink-2">{[c.buyer_name, c.seller_name].filter(Boolean).join(" ← ") || "—"}</span> },
    { id: "financing", header: "Financing", hideable: true, defaultHidden: true, cell: (c) => <span className="text-xs text-ink-2">{c.financing ?? "—"}</span> },
    { id: "verification", header: "Verification", sortKey: "verification_status", hideable: true, cell: verificationCell },
    { id: "actions", header: "", align: "right", cell: rowMenu },
  ];

  const leaseColumns: Column<LeaseComp>[] = [
    { id: "comp", header: "Property / tenant", sortKey: "tenant_name", cell: (c) => (
      <div className="min-w-[200px] max-w-[300px]">
        <p className="truncate font-medium text-ink">{c.tenant_name ?? compLabel(c)}</p>
        <p className="truncate text-xs text-ink-3">{[c.name || c.address_line, c.suite ? `Suite ${c.suite}` : null, c.city].filter(Boolean).join(" · ") || "—"}</p>
      </div>
    ) },
    { id: "start", header: "Commenced", sortKey: "commencement_on", cell: (c) => <span className="whitespace-nowrap text-ink-2">{formatDate(c.commencement_on)}</span> },
    { id: "term", header: "Term", sortKey: "term_months", align: "right", cell: (c) => (c.term_months !== null ? `${c.term_months} mo` : "—") },
    { id: "area", header: "SF", sortKey: "area_sf", align: "right", hideable: true, cell: (c) => formatNumber(c.area_sf) },
    { id: "rent", header: "Base rent", sortKey: "base_rent_psf", align: "right", cell: (c) => (c.base_rent_psf !== null ? `$${formatNumber(c.base_rent_psf, 2)}` : "—") },
    { id: "esc", header: "Escalation", align: "right", hideable: true, cell: (c) => (c.escalation_pct !== null ? formatPercent(c.escalation_pct, 1) : c.escalation_structure ?? "—") },
    { id: "recov", header: "Recoveries", hideable: true, cell: (c) => <span className="text-xs text-ink-2">{c.recovery_type ? titleCase(c.recovery_type) : "—"}</span> },
    { id: "conc", header: "Free / TI", align: "right", hideable: true, cell: (c) => <span className="text-xs">{[c.free_rent_months ? `${c.free_rent_months} mo free` : null, c.ti_psf ? `$${c.ti_psf} TI` : null].filter(Boolean).join(" · ") || "—"}</span> },
    { id: "eff", header: "Effective", sortKey: "effective_rent_psf", align: "right", hideable: true, cell: (c) => (c.effective_rent_psf !== null ? `$${formatNumber(c.effective_rent_psf, 2)}` : "—") },
    { id: "credit", header: "Credit", hideable: true, cell: (c) => <span className="text-xs text-ink-2">{c.tenant_credit ? TENANT_CREDIT_LABELS[c.tenant_credit] : "—"}</span> },
    { id: "verification", header: "Verification", sortKey: "verification_status", hideable: true, cell: verificationCell },
    { id: "actions", header: "", align: "right", cell: rowMenu },
  ];

  const columns = (kind === "sale" ? saleColumns : leaseColumns) as Column<SaleComp | LeaseComp>[];
  const cols = useColumnVisibility(`comps-${kind}`, columns);
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="comps" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                  {can("comps", "create") && (
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Plus /> {kind === "sale" ? "Sale comp" : "Lease comp"}
                    </Button>
                  )}
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder={kind === "sale" ? "Search name, address, buyer, seller…" : "Search tenant, address, city…"} />
              <FacetFilter label="Type" options={facetOptions(facets?.property_type, PROPERTY_TYPES, (v) => PROPERTY_TYPE_LABELS[v])} selected={url.getAll("property_type")} onChange={(v) => url.set({ property_type: v })} />
              <FacetFilter label="Verification" options={facetOptions(facets?.verification_status, VERIFICATION_STATUSES, titleCase)} selected={url.getAll("verification_status")} onChange={(v) => url.set({ verification_status: v })} />
              <FacetFilter label="Credit" options={facetOptions(facets?.tenant_credit, TENANT_CREDIT, (v) => TENANT_CREDIT_LABELS[v])} selected={url.getAll("tenant_credit")} onChange={(v) => url.set({ tenant_credit: v })} />
              <FacetFilter label="State" searchable options={Object.entries(facets?.state ?? {}).sort().map(([v, c]) => ({ value: v, label: v, count: c }))} selected={url.getAll("state")} onChange={(v) => url.set({ state: v })} />
              <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={
          <TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          selectable={can("comps", "create")}
          selected={selected}
          onSelectedChange={setSelected}
          onRowClick={(c) => can("comps", "edit") && setEditing(c)}
          hidden={cols.hidden}
          rowClassName={(c) => (c.verification_status === "disputed" ? "bg-negative-soft/30" : undefined)}
          empty={
            <EmptyState
              icon={<Scale />}
              title={filtered ? "No comps match these filters" : kind === "sale" ? "No sale comps yet" : "No lease comps yet"}
              description={filtered ? "Try removing a filter." : "Add verified transactions to build defensible comp sets."}
              action={can("comps", "create") && !filtered ? <Button variant="primary" onClick={() => setCreating(true)}><Plus /> Add comp</Button> : undefined}
            />
          }
        />
      </ListCard>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <BulkButton icon={<Layers />} onClick={() => setNewSet(true)}>
          New comp set from selection
        </BulkButton>
      </BulkBar>

      <CompFormSheet kind={kind} open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} comp={editing} />
      <VerifyCompDialog kind={kind} comp={verifying} open={!!verifying} onOpenChange={(o) => !o && setVerifying(null)} />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this comp?"
        description="It disappears from searches. Comp sets that used it keep the reference and history."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() =>
          archiving &&
          archive.mutate(archiving.id, {
            onSuccess: () => { toast.success("Comp archived"); setArchiving(null); },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
      <NewCompSetDialog open={newSet} onOpenChange={(o) => { setNewSet(o); if (!o) setSelected([]); }} initial={{ kind, comp_ids: selected }} />
    </>
  );
}

/* ------------------------------------------------------------------ comp sets tab */

function CompSetsTab({ onNew }: { onNew: () => void }) {
  const { can } = useAuth();
  const list = useListQuery<CompSetListItem>("comp-sets", "/comp-sets");
  const { url } = list;
  const filterParams = useFilterParams(url.params);
  const { data: facets } = useQuery({
    queryKey: ["comp-sets", "facets", filterParams],
    queryFn: () => api.get<{ kind: Record<string, number>; status: Record<string, number>; purpose: Record<string, number> }>("/comp-sets/facets", filterParams),
    placeholderData: (prev) => prev,
  });
  const columns: Column<CompSetListItem>[] = [
    { id: "name", header: "Comp set", sortKey: "name", cell: (s) => (
      <div className="min-w-[220px]">
        <p className="font-medium text-ink">{s.name}</p>
        <p className="text-xs text-ink-3">{s.subject_label ?? "—"}</p>
      </div>
    ) },
    { id: "kind", header: "Type", sortKey: "kind", cell: (s) => <Badge tone="outline">{s.kind === "sale" ? "Sale" : "Lease"}</Badge> },
    { id: "basis", header: "Basis", cell: (s) => <span className="text-ink-2">{BASIS_LABELS[s.value_basis] ?? titleCase(s.value_basis)}</span> },
    { id: "comps", header: "Comps", align: "right", cell: (s) => <span>{s.included_count}{s.excluded_count ? <span className="text-xs text-ink-3"> (+{s.excluded_count} excl.)</span> : null}</span> },
    { id: "range", header: "Indicated range", align: "right", cell: (s) =>
      s.indicated?.value_low != null ? (
        <span className="whitespace-nowrap">{formatCurrency(s.indicated.value_low, { compact: true })} – {formatCurrency(s.indicated.value_high, { compact: true })}</span>
      ) : s.indicated?.metric_low != null ? (
        <span className="whitespace-nowrap">{formatMetric(s.indicated.metric_low, s.value_basis)} – {formatMetric(s.indicated.metric_high, s.value_basis)}</span>
      ) : "—" },
    { id: "purpose", header: "Purpose", hideable: true, cell: (s) => <span className="text-ink-2">{titleCase(s.purpose)}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (s) => <StatusBadge status={s.status === "final" ? "completed" : "draft"} label={titleCase(s.status)} /> },
    { id: "updated", header: "Updated", sortKey: "updated_at", cell: (s) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(s.updated_at)}</span> },
  ];
  const cols = useColumnVisibility("comp-sets", columns);
  const chips: FilterChip[] = [];
  for (const [key, label] of [["kind", "Type"], ["status", "Status"], ["purpose", "Purpose"]] as const) {
    const v = url.getAll(key);
    if (v.length) chips.push({ key, label, value: v.map(titleCase).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="comps" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search comp sets…" />
            <FacetFilter label="Type" options={facetOptions(facets?.kind, ["sale", "lease"], titleCase)} selected={url.getAll("kind")} onChange={(v) => url.set({ kind: v })} />
            <FacetFilter label="Status" options={facetOptions(facets?.status, ["draft", "final"], titleCase)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Purpose" options={facetOptions(facets?.purpose, ["valuation", "underwriting", "bov", "mark"], titleCase)} selected={url.getAll("purpose")} onChange={(v) => url.set({ purpose: v })} />
          </Toolbar>
          <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q") })} />
        </div>
      }
      footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
    >
      <DataTable
        columns={columns}
        data={list.data?.items}
        loading={list.isLoading}
        fetching={list.isFetching}
        sort={url.get("sort")}
        onSortChange={(sort) => url.set({ sort })}
        rowHref={(s) => `/comps/sets/${s.id}`}
        hidden={cols.hidden}
        empty={
          <EmptyState
            icon={<Layers />}
            title={chips.length || url.get("q") ? "No comp sets match" : "No comp sets yet"}
            description="A comp set ties comps to a subject property with an adjustment grid and indicated value range."
            action={can("comps", "create") ? <Button variant="primary" onClick={onNew}><Plus /> New comp set</Button> : undefined}
          />
        }
      />
    </ListCard>
  );
}

/* ------------------------------------------------------------------ valuations tab */

function ValuationsTab() {
  const list = useListQuery<Valuation>("valuations", "/valuations");
  const { url } = list;
  const filterParams = useFilterParams(url.params);
  const { data: facets } = useQuery({
    queryKey: ["valuations", "facets", filterParams],
    queryFn: () => api.get<{ method: Record<string, number>; is_mark: Record<string, number> }>("/valuations/facets", filterParams),
    placeholderData: (prev) => prev,
  });
  const bovs = useBovs({ page_size: 8, sort: "-created_at" });
  const columns: Column<Valuation>[] = [
    { id: "property", header: "Property", cell: (v) => (
      <Link href={`/properties/${v.property_id}?tab=comps`} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:underline">
        {v.property_label ?? "—"}
      </Link>
    ) },
    { id: "method", header: "Method", sortKey: "method", cell: (v) => (
      <div className="flex items-center gap-1.5">
        <span className="text-ink-2">{VALUATION_METHOD_LABELS[v.method] ?? titleCase(v.method)}</span>
        {v.is_mark && <Badge tone="blue">Mark</Badge>}
      </div>
    ) },
    { id: "range", header: "Range", align: "right", cell: (v) => <span className="whitespace-nowrap text-ink-2">{formatCurrency(v.value_low, { compact: true })} – {formatCurrency(v.value_high, { compact: true })}</span> },
    { id: "point", header: "Point", sortKey: "value_point", align: "right", cell: (v) => <span className="font-medium">{formatCurrency(v.value_point, { compact: true })}</span> },
    { id: "change", header: "Vs prior mark", align: "right", hideable: true, cell: (v) => (v.change_pct !== null ? <span className={cn(v.change_pct >= 0 ? "text-positive" : "text-negative")}>{v.change_pct >= 0 ? "+" : ""}{formatPercent(v.change_pct, 1)}</span> : "—") },
    { id: "asof", header: "As of", sortKey: "as_of", cell: (v) => <span className="whitespace-nowrap text-ink-2">{formatDate(v.as_of)}</span> },
    { id: "analyst", header: "Analyst", hideable: true, cell: (v) => <span className="text-ink-2">{v.analyst_name ?? "—"}</span> },
    { id: "evidence", header: "Evidence", hideable: true, cell: (v) => (
      <span className="text-xs text-ink-3">
        {[v.comp_set_id ? "Comp set" : null, v.uw_model_id ? "UW model" : null, v.document_id ? "Document" : null].filter(Boolean).join(" · ") || "Inputs"}
        {v.unsourced.length > 0 && <span className="ml-1 text-caution">· {v.unsourced.length} unsourced</span>}
      </span>
    ) },
  ];
  const cols = useColumnVisibility("valuations", columns);
  const chips: FilterChip[] = [];
  if (url.getAll("method").length) chips.push({ key: "method", label: "Method", value: url.getAll("method").map((m) => VALUATION_METHOD_LABELS[m] ?? m).join(", "), onRemove: () => url.set({ method: null }) });
  if (url.get("is_mark")) chips.push({ key: "is_mark", label: "Marks", value: url.get("is_mark") === "true" ? "Only marks" : "Excluding marks", onRemove: () => url.set({ is_mark: null }) });
  if (url.get("latest_only")) chips.push({ key: "latest_only", label: "Showing", value: "Latest per property", onRemove: () => url.set({ latest_only: null }) });
  for (const [k, label] of [["as_of_from", "From"], ["as_of_to", "To"]] as const) if (url.get(k)) chips.push({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) });

  return (
    <div className="space-y-5">
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar right={<><SavedViewsMenu module="comps" /><ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} /></>}>
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property…" />
              <FacetFilter label="Method" options={facetOptions(facets?.method, VALUATION_METHODS, (m) => VALUATION_METHOD_LABELS[m])} selected={url.getAll("method")} onChange={(v) => url.set({ method: v })} />
              <FacetFilter
                label="Marks"
                single
                options={[{ value: "true", label: "Portfolio marks", count: facets?.is_mark?.True ?? 0 }, { value: "false", label: "Other valuations", count: facets?.is_mark?.False ?? 0 }]}
                selected={url.get("is_mark") ? [url.get("is_mark")!] : []}
                onChange={(v) => url.set({ is_mark: v[0] ?? null })}
              />
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <Checkbox checked={url.get("latest_only") === "true"} onChange={(v) => url.set({ latest_only: v ? "true" : null })} />
                Latest per property
              </label>
              <MoreFilters fields={[{ type: "date-range", label: "As of", minKey: "as_of_from", maxKey: "as_of_to" }]} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab") })} />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          hidden={cols.hidden}
          rowHref={(v) => (v.comp_set_id ? `/comps/sets/${v.comp_set_id}` : `/properties/${v.property_id}?tab=comps`)}
          empty={<EmptyState icon={<Scale />} title="No valuations" description="Save a dated valuation or portfolio mark. Marks are never overwritten; each one is kept as history." />}
        />
      </ListCard>

      <Card>
        <CardHeader title="Recent broker opinions of value" description="Generated from a comp set and its adjustment grid." />
        {bovs.data?.items.length ? (
          <ul className="divide-y divide-line">
            {bovs.data.items.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <Link href={`/comps/bov/${b.id}`} className="font-medium text-ink hover:underline">{b.title}</Link>
                  <p className="truncate text-xs text-ink-3">{[b.property_label, b.prepared_for, formatDate(b.generated_at)].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-ink-2 tabular">{formatCurrency(b.value_low, { compact: true })} – {formatCurrency(b.value_high, { compact: true })}</span>
                  <StatusBadge status={b.status === "draft" ? "draft" : "completed"} label={titleCase(b.status)} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<FileText />} title="No BOVs yet" description="Open a comp set and choose Generate BOV." />
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

const TABS = ["sale", "lease", "sets", "valuations"] as const;

function CompsView() {
  const { can } = useAuth();
  const url = useUrlState();
  const tab = (TABS as readonly string[]).includes(url.get("tab") ?? "") ? url.get("tab")! : "sale";
  const [finding, setFinding] = useState(false);
  const [newSet, setNewSet] = useState<{ kind?: CompKind; subject_property_id?: string | null; comp_ids?: string[]; criteria?: Record<string, unknown> } | null>(null);
  const [valuing, setValuing] = useState<{ mark: boolean } | null>(null);

  return (
    <>
      <PageHeader
        title="Comparables & valuation"
        description="Verified sale and lease evidence, comp sets with adjustment grids, dated valuations and portfolio marks."
        actions={
          <>
            <Button onClick={() => setFinding(true)}>
              <Search /> Find candidates
            </Button>
            {can("comps", "create") && (
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="primary">
                    <Plus /> New
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<Layers />} onSelect={() => setNewSet({})}>Comp set</MenuItem>
                  <MenuItem icon={<Scale />} onSelect={() => setValuing({ mark: false })}>Valuation</MenuItem>
                  <MenuItem icon={<BadgeCheck />} onSelect={() => setValuing({ mark: true })}>Portfolio mark</MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "sale" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "sale", label: "Sale comps" },
            { value: "lease", label: "Lease comps" },
            { value: "sets", label: "Comp sets" },
            { value: "valuations", label: "Valuations & marks" },
          ]}
        />
        <TabPanel value="sale">
          <CompsTab kind="sale" />
        </TabPanel>
        <TabPanel value="lease">
          <CompsTab kind="lease" />
        </TabPanel>
        <TabPanel value="sets">
          <CompSetsTab onNew={() => setNewSet({})} />
        </TabPanel>
        <TabPanel value="valuations">
          <ValuationsTab />
        </TabPanel>
      </Tabs>

      <CandidateSearchDialog
        open={finding}
        onOpenChange={setFinding}
        kind={tab === "lease" ? "lease" : undefined}
        confirmLabel="Create comp set"
        onConfirm={(ids, criteria) => {
          setFinding(false);
          setNewSet({ kind: criteria.kind, subject_property_id: criteria.subject_property_id, comp_ids: ids, criteria: { ...criteria } });
        }}
      />
      <NewCompSetDialog open={!!newSet} onOpenChange={(o) => !o && setNewSet(null)} initial={newSet ?? undefined} />
      <ValuationFormSheet open={!!valuing} onOpenChange={(o) => !o && setValuing(null)} defaultMark={valuing?.mark ?? false} />
    </>
  );
}

export default function CompsPage() {
  return (
    <Suspense>
      <CompsView />
    </Suspense>
  );
}
