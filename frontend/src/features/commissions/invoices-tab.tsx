"use client";

import { Receipt } from "lucide-react";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { useListQuery } from "@/hooks/use-list-query";
import { formatCurrency, formatDate, isOverdue } from "@/lib/utils";

import type { Invoice } from "./api";
import { CStatus } from "./commission-sheet";

export function InvoicesTab({ onOpenCommission }: { onOpenCommission: (id: string) => void }) {
  const list = useListQuery<Invoice>("commissions", "/commissions/invoices");
  const { url } = list;
  const [view, setView] = useState<Invoice | null>(null);

  const columns: Column<Invoice>[] = [
    { id: "number", header: "Invoice", sortKey: "invoice_number", cell: (i) => <span className="font-medium">{i.invoice_number}</span> },
    {
      id: "commission",
      header: "Commission",
      cell: (i) => (
        <button className="max-w-[280px] truncate text-left text-accent hover:underline" onClick={() => onOpenCommission(i.commission_id)}>
          {i.commission_title ?? "Open"}
        </button>
      ),
    },
    { id: "bill_to", header: "Bill to", cell: (i) => <span className="block max-w-[220px] truncate text-ink-2">{i.bill_to}</span> },
    { id: "issued", header: "Issued", sortKey: "issued_on", cell: (i) => formatDate(i.issued_on) },
    {
      id: "due",
      header: "Due",
      sortKey: "due_on",
      cell: (i) => (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          {formatDate(i.due_on)}
          {i.status === "issued" && isOverdue(i.due_on) && <Badge tone="red">Overdue</Badge>}
        </span>
      ),
    },
    { id: "status", header: "Status", sortKey: "status", cell: (i) => <CStatus status={i.status} /> },
    { id: "amount", header: "Amount", sortKey: "amount", align: "right", cell: (i) => formatCurrency(i.amount) },
  ];

  return (
    <>
      <ListCard
        toolbar={
          <Toolbar>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search invoice number, bill to…" />
            <FacetFilter label="Status" options={["issued", "paid", "void"].map((s) => ({ value: s, label: s === "issued" ? "Open" : s === "paid" ? "Paid" : "Void" }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Overdue" single options={[{ value: "true", label: "Overdue only" }]} selected={url.get("overdue") ? ["true"] : []} onChange={(v) => url.set({ overdue: v[0] ?? null })} />
          </Toolbar>
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
          onRowClick={setView}
          empty={<EmptyState icon={<Receipt />} title="No invoices" description="Invoices are issued from earned commissions." />}
        />
      </ListCard>
      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)} title={view?.invoice_number ?? "Invoice"} className="max-w-2xl">
        <pre className="whitespace-pre-wrap rounded-md border border-line bg-subtle p-3 font-mono text-xs text-ink">{view?.rendered_text}</pre>
      </Dialog>
    </>
  );
}
