"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, FileBarChart, Play, Plus, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker } from "@/components/data/entity-picker";
import { FacetFilter, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, titleCase } from "@/lib/utils";

import { FREQUENCIES, PACKAGE_LABELS, PACKAGE_TYPES, useAssetOptions, useGeneratePackages, useIssuePackage, usePackage, useSaveSchedule, useSchedules, type PackageListItem, type PartnerListItem, type Schedule } from "./api";
import { StateBadge } from "./events-tab";
import { PackageView } from "./package-view";

export function PartnerPicker({ value, onChange, placeholder }: { value: string | null; onChange: (id: string | null) => void; placeholder?: string }) {
  return (
    <EntityPicker<PartnerListItem>
      endpoint="/investors/partners"
      value={value}
      onChange={(id) => onChange(id)}
      placeholder={placeholder ?? "Select partner"}
      toOption={(p) => ({ id: p.id, label: p.name, sublabel: titleCase(p.type) })}
    />
  );
}

function PackageTypesField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {PACKAGE_TYPES.map((t) => (
        <label key={t} className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={value.includes(t)} onChange={(v) => onChange(v ? [...value, t] : value.filter((x) => x !== t))} />
          {PACKAGE_LABELS[t]}
        </label>
      ))}
    </div>
  );
}

const quarterStart = () => {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), q - 3, 1).toISOString().slice(0, 10);
};
const quarterEnd = () => {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), q, 0).toISOString().slice(0, 10);
};

export function GenerateDialog({ open, onOpenChange, partnerId }: { open: boolean; onOpenChange: (o: boolean) => void; partnerId?: string }) {
  const gen = useGeneratePackages();
  const assets = useAssetOptions(open);
  const [partner, setPartner] = useState<string | null>(partnerId ?? null);
  const [asset, setAsset] = useState("");
  const [start, setStart] = useState(quarterStart());
  const [end, setEnd] = useState(quarterEnd());
  const [types, setTypes] = useState<string[]>([...PACKAGE_TYPES]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-xl"
      title="Generate reporting package"
      description="Packages are assembled only from posted, approved and verified data and frozen as a snapshot."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!types.length || !start || !end}
            loading={gen.isPending}
            onClick={() =>
              gen.mutate(
                { partner_id: partnerId ?? partner, asset_id: asset || null, period_start: start, period_end: end, package_types: types },
                {
                  onSuccess: (r) => {
                    toast.success(`${r.length} package${r.length === 1 ? "" : "s"} generated`);
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Generate
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {!partnerId && (
          <Field label="Partner" className="col-span-2" hint="Leave empty to generate for every active partner">
            <PartnerPicker value={partner} onChange={setPartner} placeholder="All active partners" />
          </Field>
        )}
        <Field label="Asset" className="col-span-2">
          <Select value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="All of the partner's assets" options={(assets.data ?? []).map((a) => ({ value: a.id, label: a.label }))} />
        </Field>
        <Field label="Period start">
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Period end">
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <div className="col-span-2">
          <p className="mb-1.5 text-xs font-medium text-ink-2">Sections</p>
          <PackageTypesField value={types} onChange={setTypes} />
        </div>
      </div>
    </Dialog>
  );
}

export function PackageSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, user } = useAuth();
  const { data, isLoading } = usePackage(id);
  const issue = useIssuePackage();
  const portal = user?.role.key === "capital_partner";
  return (
    <Sheet
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      className="max-w-4xl"
      title={data?.title ?? "Reporting package"}
      description={data ? `${data.partner_name ?? ""} · generated ${formatDateTime(data.generated_at)}` : undefined}
      footer={
        data && data.status !== "issued" && can("investors", "edit") && !portal ? (
          <Button variant="primary" loading={issue.isPending} onClick={() => issue.mutate(data.id, { onSuccess: () => toast.success("Issued — now visible in the partner portal"), onError: (e) => toast.error(errorMessage(e)) })}>
            <Send /> Issue to partner
          </Button>
        ) : undefined
      }
    >
      {isLoading || !data ? <Skeleton className="h-64 w-full" /> : <PackageView pkg={data} />}
    </Sheet>
  );
}

function ScheduleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const save = useSaveSchedule();
  const [name, setName] = useState("");
  const [partner, setPartner] = useState<string | null>(null);
  const [frequency, setFrequency] = useState("quarterly");
  const [next, setNext] = useState("");
  const [types, setTypes] = useState<string[]>(["capital_accounts", "distributions", "property_performance"]);
  const [autoIssue, setAutoIssue] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-xl"
      title="New report schedule"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !next || !types.length}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { name: name.trim(), partner_id: partner, frequency, next_run_on: next, package_types: types, auto_issue: autoIssue, is_active: true },
                { onSuccess: () => { toast.success("Schedule created"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Create schedule
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required className="col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Quarterly investor reporting" />
        </Field>
        <Field label="Partner" className="col-span-2" hint="Empty = every active partner">
          <PartnerPicker value={partner} onChange={setPartner} placeholder="All active partners" />
        </Field>
        <Field label="Frequency">
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value)} options={FREQUENCIES.map((f) => ({ value: f, label: titleCase(f) }))} />
        </Field>
        <Field label="Next run" required hint="Covers the period ending the day before">
          <Input type="date" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <div className="col-span-2">
          <p className="mb-1.5 text-xs font-medium text-ink-2">Sections</p>
          <PackageTypesField value={types} onChange={setTypes} />
        </div>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={autoIssue} onChange={setAutoIssue} /> Issue to the portal automatically (otherwise packages wait for review)
        </label>
      </div>
    </Dialog>
  );
}

function SchedulesCard() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useSchedules();
  const [creating, setCreating] = useState(false);
  const runDue = useMutation({
    mutationFn: () => api.post<{ schedules: number; packages: number }>("/investors/report-schedules/run-due"),
    onSuccess: (r) => {
      toast.success(`${r.packages} package${r.packages === 1 ? "" : "s"} generated from ${r.schedules} due schedule${r.schedules === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["investors"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cols: Column<Schedule>[] = [
    { id: "name", header: "Schedule", cell: (s) => <span className="font-medium">{s.name}</span> },
    { id: "partner", header: "Partners", cell: (s) => <span className="text-ink-2">{s.partner_name ?? "All active"}</span> },
    { id: "freq", header: "Frequency", cell: (s) => titleCase(s.frequency) },
    { id: "next", header: "Next run", cell: (s) => formatDate(s.next_run_on) },
    { id: "sections", header: "Sections", cell: (s) => <span className="text-xs text-ink-3">{s.package_types.map((t) => PACKAGE_LABELS[t] ?? t).join(", ")}</span> },
    { id: "state", header: "", cell: (s) => (s.is_active ? (s.auto_issue ? <Badge tone="blue">Auto-issue</Badge> : <Badge tone="outline">Review first</Badge>) : <Badge>Paused</Badge>) },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Scheduled reporting"
        description="Due schedules generate packages for the period that just ended."
        actions={
          can("investors", "edit") && (
            <>
              <Button size="sm" loading={runDue.isPending} onClick={() => runDue.mutate()}>
                <Play /> Run due now
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> Schedule
              </Button>
            </>
          )
        }
      />
      <DataTable columns={cols} data={data} loading={isLoading} dense empty={<EmptyState icon={<CalendarClock />} title="No schedules" />} />
      <ScheduleDialog open={creating} onOpenChange={setCreating} />
    </Card>
  );
}

const packageColumns: Column<PackageListItem>[] = [
  {
    id: "title",
    header: "Package",
    sortKey: "title",
    cell: (p) => (
      <div className="min-w-[220px]">
        <p className="truncate font-medium text-ink">{p.title}</p>
        <p className="truncate text-xs text-ink-3">{p.package_types.map((t) => PACKAGE_LABELS[t] ?? t).join(", ")}</p>
      </div>
    ),
  },
  { id: "partner", header: "Partner", cell: (p) => <span className="text-ink-2">{p.partner_name}</span> },
  { id: "period", header: "Period", sortKey: "period_end", cell: (p) => <span className="whitespace-nowrap text-ink-2">{formatDate(p.period_start)} – {formatDate(p.period_end)}</span> },
  { id: "status", header: "Status", cell: (p) => <StateBadge status={p.status} /> },
  { id: "generated", header: "Generated", sortKey: "generated_at", cell: (p) => <span className="text-xs text-ink-3">{formatDateTime(p.generated_at)}</span> },
];

export function ReportsTab() {
  const { can } = useAuth();
  const list = useListQuery<PackageListItem>("investors", "/investors/report-packages");
  const { url } = list;
  const [generating, setGenerating] = useState(false);

  return (
    <div className="space-y-5">
      <ListCard
        toolbar={
          <Toolbar
            right={
              can("investors", "create") && (
                <Button variant="primary" onClick={() => setGenerating(true)}>
                  <FileBarChart /> Generate package
                </Button>
              )
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search packages…" />
            <FacetFilter label="Status" options={[{ value: "generated", label: "Generated" }, { value: "issued", label: "Issued" }]} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
          </Toolbar>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
      >
        <DataTable
          columns={packageColumns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={(p) => url.set({ package: p.id }, { resetPage: false })}
          empty={<EmptyState icon={<FileBarChart />} title="No reporting packages yet" description="Generate one now or set up a schedule." />}
        />
      </ListCard>
      <SchedulesCard />
      <GenerateDialog open={generating} onOpenChange={setGenerating} />
      <PackageSheet id={url.get("package")} onClose={() => url.set({ package: null }, { resetPage: false })} />
    </div>
  );
}
