"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Building2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, toQuery } from "@/lib/api";
import { formatCurrency, formatNumber, titleCase } from "@/lib/utils";

import type { NLQueryResult, PropertyResult } from "./api";

const FILTER_LABELS: Record<string, string> = {
  q: "Keywords", status: "Status", property_type: "Type", state: "State", county: "County", city: "City", tag: "Tag",
  min_area: "Min SF", max_area: "Max SF", min_acres: "Min acres", max_acres: "Max acres", min_price: "Min price",
  max_price: "Max price", min_year: "Built after", max_year: "Built before", min_completeness: "Min completeness",
  near_lat: "Near lat", near_lng: "Near lng", radius_miles: "Radius (mi)", sort: "Sort",
};

function filterValue(key: string, value: unknown): string {
  const list = Array.isArray(value) ? value : [value];
  if (key === "min_price" || key === "max_price") return formatCurrency(Number(value), { compact: true });
  if (key === "min_area" || key === "max_area") return `${formatNumber(Number(value))} SF`;
  if (key === "sort") {
    const s = String(value);
    return `${titleCase(s.replace(/^-/, ""))} ${s.startsWith("-") ? "(desc)" : "(asc)"}`;
  }
  return list.map((v) => (key === "status" || key === "property_type" ? titleCase(String(v)) : String(v))).join(", ");
}

const EXAMPLES = [
  "Industrial buildings in Texas over 50,000 SF built after 2000",
  "Retail properties in Dallas County asking under $5M",
  "Land over 10 acres in Florida, largest first",
];

const columns: Column<PropertyResult>[] = [
  {
    id: "property",
    header: "Property",
    cell: (p) => (
      <div className="min-w-[220px]">
        <p className="truncate font-medium text-ink">{p.name || p.address_line}</p>
        <p className="truncate text-xs text-ink-3">{[p.address_line, p.city, p.state].filter(Boolean).join(", ")}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", cell: (p) => <span className="text-ink-2">{titleCase(p.property_type)}</span> },
  { id: "status", header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
  { id: "area", header: "Building SF", align: "right", cell: (p) => formatNumber(p.building_area_sf) },
  { id: "acres", header: "Acres", align: "right", cell: (p) => formatNumber(p.land_area_acres, 2) },
  { id: "price", header: "Asking", align: "right", cell: (p) => formatCurrency(p.asking_price, { compact: true }) },
  { id: "year", header: "Built", align: "right", cell: (p) => p.year_built ?? "—" },
];

/** Natural-language property search: question → interpreted structured filters → permission-aware records. */
export function NLSearch() {
  const url = useUrlState();
  const question = url.get("question") ?? "";
  const page = url.getNumber("page", 1);
  const pageSize = url.getNumber("page_size", 25);
  const [draft, setDraft] = useState(question);

  useEffect(() => setDraft(question), [question]);

  const query = useQuery({
    queryKey: ["platform", "nl-query", question, page, pageSize],
    queryFn: () => api.post<NLQueryResult>("/platform/ai/nl-query", { question, page, page_size: pageSize }),
    enabled: question.trim().length >= 3,
    staleTime: 600_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = query.data;

  const submit = (q: string) => {
    const text = q.trim();
    if (text.length < 3) return;
    url.set({ question: text, page: null, page_size: null });
  };

  const propertiesHref = data
    ? `/properties${toQuery(data.filters)}`
    : "/properties";

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="flex gap-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about properties, e.g. industrial over 50,000 SF in Texas built after 2000"
          leading={<Sparkles />}
          className="flex-1"
          maxLength={500}
        />
        <Button type="submit" variant="primary" disabled={draft.trim().length < 3} loading={query.isFetching}>
          Ask <ArrowRight />
        </Button>
      </form>

      {!question && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => submit(ex)} className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 shadow-card hover:bg-subtle hover:text-ink">
              {ex}
            </button>
          ))}
        </div>
      )}

      {query.isError && <p className="rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-sm text-negative">{errorMessage(query.error)}</p>}

      {data && (
        <div className="space-y-2 rounded-lg border border-line bg-surface p-3 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-3">
              {data.ai_used ? "Interpreted as" : "Searched as"}
              {data.ai_used && <span className="ml-1.5 font-normal">· structured filters, not AI-written answers</span>}
            </p>
            <Link href={propertiesHref} className="inline-flex items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink hover:underline">
              Open in Properties <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(data.filters).length === 0 && <span className="text-sm text-ink-3">No filters — showing all permitted properties.</span>}
            {Object.entries(data.filters).map(([k, v]) => (
              <span key={k} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-subtle px-2 text-xs">
                <span className="text-ink-3">{FILTER_LABELS[k] ?? titleCase(k)}:</span>
                <span className="font-medium text-ink">{filterValue(k, v)}</span>
              </span>
            ))}
          </div>
          {data.unmapped.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-caution">Not applied (no matching filter):</span>
              {data.unmapped.map((u) => (
                <Badge key={u} tone="amber">{u}</Badge>
              ))}
            </div>
          )}
          {data.message && <p className="text-xs text-ink-3">{data.message}</p>}
        </div>
      )}

      {question && (
        <ListCard
          footer={
            <TableFooter
              page={page}
              pageSize={pageSize}
              total={data?.total ?? 0}
              onPage={(p) => url.set({ page: p }, { resetPage: false })}
              onPageSize={(s) => url.set({ page_size: s })}
            />
          }
        >
          <DataTable
            columns={columns}
            data={data?.items}
            loading={query.isLoading}
            fetching={query.isFetching}
            rowHref={(p) => `/properties/${p.id}`}
            empty={<EmptyState icon={<Building2 />} title="No properties match" description="Try fewer constraints or rephrase the question." />}
          />
        </ListCard>
      )}
    </div>
  );
}
