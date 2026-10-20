"use client";

import { useQuery } from "@tanstack/react-query";
import { FileSignature, Plus, RefreshCw, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatNumber, toNumber } from "@/lib/utils";

import {
  OFFER_STATUSES,
  ORIGIN_LABELS,
  STATUS_LABELS,
  STRUCTURE_LABELS,
  STRUCTURES,
  useOfferSettings,
  useSaveOfferSettings,
  type OfferFacets,
  type OfferListItem,
  type OfferSettings,
} from "@/features/offers/api";
import { OfferCreateSheet } from "@/features/offers/offer-form";
import { offerColumns } from "@/features/offers/offer-table";

const MORE: MoreFilterField[] = [{ type: "range", label: "Price", minKey: "min_price", maxKey: "max_price", suffix: "$" }];
const CHIP_LABELS: Record<string, string> = { min_price: "Min price", max_price: "Max price" };
const DUE_CHIPS = [
  { key: "overdue", label: "Response overdue" },
  { key: "24h", label: "Due in 24h" },
  { key: "72h", label: "Due in 72h" },
] as const;

function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useOfferSettings();
  const save = useSaveOfferSettings();
  const [form, setForm] = useState<Record<string, string>>({});
  const [always, setAlways] = useState(false);
  const [structures, setStructures] = useState<string[]>([]);

  useEffect(() => {
    if (open && data) {
      setForm({
        price_threshold: data.price_threshold?.toString() ?? "",
        deviation_threshold_pct: String(data.deviation_threshold_pct),
        second_approval_deviation_pct: String(data.second_approval_deviation_pct),
        max_feasibility_days: data.max_feasibility_days?.toString() ?? "",
        max_earnest_money_pct: data.max_earnest_money_pct?.toString() ?? "",
        default_response_days: String(data.default_response_days),
      });
      setAlways(data.require_approval_always);
      setStructures(data.approval_structures);
    }
  }, [open, data]);

  const bind = (k: string) => ({ value: form[k] ?? "", onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })) });
  const submit = () => {
    const body: OfferSettings = {
      price_threshold: toNumber(form.price_threshold ?? ""),
      deviation_threshold_pct: toNumber(form.deviation_threshold_pct ?? "") ?? 0,
      second_approval_deviation_pct: toNumber(form.second_approval_deviation_pct ?? "") ?? 0,
      approval_structures: structures,
      max_feasibility_days: toNumber(form.max_feasibility_days ?? ""),
      max_earnest_money_pct: toNumber(form.max_earnest_money_pct ?? ""),
      require_approval_always: always,
      default_response_days: toNumber(form.default_response_days ?? "") ?? 3,
    };
    save.mutate(body, {
      onSuccess: () => {
        toast.success("Approval routing updated");
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Offer approval routing"
      description="Offers route for named approval by price, structure and deviation from the approved underwriting model."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>Save</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price threshold ($)" className="col-span-2" hint="Offers above this price need approval. Leave blank for none.">
          <Input {...bind("price_threshold")} inputMode="decimal" />
        </Field>
        <Field label="Deviation for one approval (%)"><Input {...bind("deviation_threshold_pct")} inputMode="decimal" /></Field>
        <Field label="Deviation for two approvals (%)"><Input {...bind("second_approval_deviation_pct")} inputMode="decimal" /></Field>
        <Field label="Max standard feasibility (days)"><Input {...bind("max_feasibility_days")} inputMode="numeric" /></Field>
        <Field label="Max standard earnest money (%)"><Input {...bind("max_earnest_money_pct")} inputMode="decimal" /></Field>
        <Field label="Default response window (days)"><Input {...bind("default_response_days")} inputMode="numeric" /></Field>
        <div className="col-span-2">
          <p className="mb-1.5 text-xs font-medium text-ink-2">Structures that always need approval</p>
          <div className="grid grid-cols-2 gap-1.5">
            {STRUCTURES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm text-ink-2">
                <Checkbox checked={structures.includes(s)} onChange={(v) => setStructures((prev) => (v ? [...prev, s] : prev.filter((x) => x !== s)))} />
                {STRUCTURE_LABELS[s]}
              </label>
            ))}
          </div>
        </div>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={always} onChange={setAlways} />
          Require approval for every offer
        </label>
      </div>
    </Dialog>
  );
}

function OffersView() {
  const { can } = useAuth();
  const router = useRouter();
  const list = useListQuery<OfferListItem>("offers", "/offers");
  const { url } = list;
  const cols = useColumnVisibility("offers", offerColumns);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["offers", "facets", filterParams],
    queryFn: () => api.get<OfferFacets>("/offers/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const allVersions = url.get("latest_only") === "false";
  const due = url.get("due");

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  if (url.getAll("status").length)
    chips.unshift({ key: "status", label: "Status", value: url.getAll("status").map((s) => STATUS_LABELS[s] ?? s).join(", "), onRemove: () => url.set({ status: null }) });
  if (url.getAll("origin").length)
    chips.unshift({ key: "origin", label: "Origin", value: url.getAll("origin").map((s) => ORIGIN_LABELS[s] ?? s).join(", "), onRemove: () => url.set({ origin: null }) });
  if (due) chips.unshift({ key: "due", label: "Response", value: DUE_CHIPS.find((d) => d.key === due)?.label ?? due, onRemove: () => url.set({ due: null }) });
  if (allVersions) chips.push({ key: "latest_only", label: "Versions", value: "All", onRemove: () => url.set({ latest_only: null }) });

  const runScan = async () => {
    setScanning(true);
    try {
      const r = await api.post<{ expired: number }>("/offers/expire-scan");
      toast.success(r.expired ? `${r.expired} offer(s) expired and escalated` : "No offers past their response time");
      list.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };

  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="Offers"
        description="Offers and LOIs prepared from approved underwriting, with approvals, counters and response clocks."
        actions={
          <>
            {can("offers", "edit") && (
              <Button onClick={runScan} loading={scanning}>
                <RefreshCw /> Check expirations
              </Button>
            )}
            {can("offers", "approve") && (
              <Button onClick={() => setSettingsOpen(true)}>
                <Settings2 /> Approval routing
              </Button>
            )}
            {can("offers", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New offer
              </Button>
            )}
          </>
        }
      />

      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="offers" />
                  <ColumnsMenu columns={offerColumns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search opportunity, property, seller…" />
              <FacetFilter
                label="Status"
                options={OFFER_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s], count: facets?.status?.[s] ?? 0 }))}
                selected={url.getAll("status")}
                onChange={(v) => url.set({ status: v })}
              />
              <FacetFilter
                label="Origin"
                options={Object.entries(ORIGIN_LABELS).map(([v, label]) => ({ value: v, label, count: facets?.origin?.[v] ?? 0 }))}
                selected={url.getAll("origin")}
                onChange={(v) => url.set({ origin: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
              <label className="ml-1 flex items-center gap-1.5 text-xs text-ink-2">
                <Checkbox checked={allVersions} onChange={(v) => url.set({ latest_only: v ? "false" : null })} label="Show all versions" />
                All versions
              </label>
            </Toolbar>
            <div className="flex flex-wrap items-center gap-1.5">
              {DUE_CHIPS.map((d) => {
                const count = facets?.due?.[d.key] ?? 0;
                const active = due === d.key;
                return (
                  <button
                    key={d.key}
                    onClick={() => url.set({ due: active ? null : d.key })}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium shadow-card transition-colors",
                      active ? "border-accent/30 bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:bg-subtle",
                      d.key === "overdue" && count > 0 && !active && "border-negative/30 text-negative",
                    )}
                  >
                    {d.label}
                    <span className="tabular">{formatNumber(count)}</span>
                  </button>
                );
              })}
            </div>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={
          <TableFooter
            page={list.page}
            pageSize={list.pageSize}
            total={list.data?.total ?? 0}
            onPage={(page) => url.set({ page }, { resetPage: false })}
            onPageSize={(size) => url.set({ page_size: size })}
          />
        }
      >
        <DataTable
          columns={offerColumns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowHref={(o) => `/offers/${o.id}`}
          hidden={cols.hidden}
          rowClassName={(o) => (o.overdue ? "bg-negative-soft/40" : undefined)}
          empty={
            <EmptyState
              icon={<FileSignature />}
              title={filtered ? "No offers match these filters" : "No offers yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Offers are prepared from an approved underwriting model on an opportunity."}
              action={
                can("offers", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New offer
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <OfferCreateSheet open={creating} onOpenChange={setCreating} onCreated={(o) => router.push(`/offers/${o.id}`)} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default function OffersPage() {
  return (
    <Suspense>
      <OffersView />
    </Suspense>
  );
}
