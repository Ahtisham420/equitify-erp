"use client";

import { useQuery } from "@tanstack/react-query";
import { BellOff, Check, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/input";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import { ALERT_RESOLUTIONS, ALERT_SEVERITIES, ALERT_STATUSES, relatedHref, useAlertAction, type Alert, type AlertFacets } from "./api";

const QUICK_VIEWS: { key: string; label: string; params: Record<string, string | string[] | null> }[] = [
  { key: "mine", label: "My open", params: { owner: "me", status: ["open", "acknowledged"], subscribed: null } },
  { key: "subscribed", label: "Subscribed", params: { owner: null, status: null, subscribed: "true" } },
  { key: "all", label: "All", params: { owner: null, status: null, subscribed: null } },
];

function AlertActionDialog({ alert, mode, onClose }: { alert: Alert | null; mode: "acknowledge" | "resolve"; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("actioned");
  const run = useAlertAction();
  const resolve = mode === "resolve";
  const close = () => {
    setNote("");
    setKind("actioned");
    onClose();
  };
  return (
    <Dialog
      open={!!alert}
      onOpenChange={(o) => !o && close()}
      title={resolve ? "Resolve alert" : "Acknowledge alert"}
      description={alert?.title}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={resolve && note.trim().length < 3}
            loading={run.isPending}
            onClick={() =>
              alert &&
              run.mutate(
                { id: alert.id, action: mode, note: note.trim(), kind },
                {
                  onSuccess: () => {
                    toast.success(resolve ? "Alert resolved" : "Alert acknowledged");
                    close();
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            {resolve ? "Resolve" : "Acknowledge"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {alert && <p className="rounded-md border border-line bg-subtle/60 px-3 py-2 text-sm text-ink-2">{alert.reason}</p>}
        {resolve && (
          <Field label="Outcome" hint="Outcomes other than “Actioned” count toward this rule’s noise rate.">
            <Select value={kind} onChange={(e) => setKind(e.target.value)} options={ALERT_RESOLUTIONS.map((r) => ({ value: r.value, label: r.label }))} />
          </Field>
        )}
        <Field label={resolve ? "Resolution note" : "Note"} required={resolve} hint={resolve ? "Alerts are worked to a recorded resolution — they cannot be silently dismissed." : "Optional"}>
          <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export function AlertsTab() {
  const { can } = useAuth();
  const list = useListQuery<Alert>("alerts", "/alerts");
  const { url } = list;
  const [acting, setActing] = useState<{ alert: Alert; mode: "acknowledge" | "resolve" } | null>(null);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["alerts", "facets", filterParams],
    queryFn: () => api.get<AlertFacets>("/alerts/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const activeView = QUICK_VIEWS.find((v) =>
    Object.entries(v.params).every(([k, val]) => {
      const cur = url.getAll(k);
      if (val === null) return cur.length === 0;
      const want = Array.isArray(val) ? val : [val];
      return cur.length === want.length && want.every((x) => cur.includes(x));
    }),
  )?.key;

  const columns: Column<Alert>[] = [
    {
      id: "severity",
      header: "Severity",
      sortKey: "severity",
      width: 100,
      cell: (a) => <StatusBadge status={a.severity} />,
    },
    {
      id: "alert",
      header: "Alert",
      sortKey: "title",
      cell: (a) => {
        const href = relatedHref(a.related_type, a.related_id);
        return (
          <div className="min-w-[280px] max-w-[520px]">
            <p className="truncate font-medium text-ink">{a.title}</p>
            <p className="line-clamp-2 text-xs text-ink-2">{a.reason}</p>
            {a.related_label && (
              <p className="mt-0.5 truncate text-xs text-ink-3">
                {titleCase(a.related_type)} ·{" "}
                {href ? (
                  <Link href={href} className="text-accent hover:underline">
                    {a.related_label}
                  </Link>
                ) : (
                  a.related_label
                )}
              </p>
            )}
          </div>
        );
      },
    },
    { id: "rule", header: "Rule", cell: (a) => <span className="font-mono text-2xs text-ink-3">{a.rule_key ?? "manual"}</span> },
    { id: "owner", header: "Owner", cell: (a) => <span className="text-ink-2">{a.owner_name ?? "Unassigned"}</span> },
    {
      id: "status",
      header: "Status",
      sortKey: "status",
      cell: (a) => (
        <div>
          <span className="flex items-center gap-1">
            <StatusBadge status={a.status} />
            {a.escalation_level > 0 && <Badge tone="red">Escalated</Badge>}
          </span>
          {a.resolution_note && <p className="mt-0.5 max-w-[220px] truncate text-xs text-ink-3" title={a.resolution_note}>{titleCase(a.resolution_kind)}: {a.resolution_note}</p>}
        </div>
      ),
    },
    { id: "created", header: "Raised", sortKey: "created_at", cell: (a) => <span className="whitespace-nowrap text-xs text-ink-3" title={formatDateTime(a.created_at)}>{formatRelative(a.created_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (a) =>
        a.status !== "resolved" && can("tasks", "edit") ? (
          <div className="flex justify-end gap-1">
            {a.status === "open" && (
              <Button size="xs" variant="ghost" onClick={() => setActing({ alert: a, mode: "acknowledge" })}>
                <Check /> Acknowledge
              </Button>
            )}
            <Button size="xs" onClick={() => setActing({ alert: a, mode: "resolve" })}>
              <CheckCheck /> Resolve
            </Button>
          </div>
        ) : null,
    },
  ];

  const chips: FilterChip[] = [];
  for (const [key, label] of [["severity", "Severity"], ["status", "Status"], ["rule_key", "Rule"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map((v) => (key === "rule_key" ? v : titleCase(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const opts = (counts: Record<string, number> | undefined, values: readonly string[]) =>
    values.map((v) => ({ value: v, label: titleCase(v), count: counts?.[v] ?? 0 }));

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <div className="inline-flex rounded-md border border-line bg-surface p-0.5 shadow-card">
              {QUICK_VIEWS.map((v) => (
                <button
                  key={v.key}
                  onClick={() => url.set(v.params)}
                  className={cn("h-7 rounded px-3 text-sm font-medium transition-colors", activeView === v.key ? "bg-ink text-white" : "text-ink-2 hover:bg-muted hover:text-ink")}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <Toolbar right={<SavedViewsMenu module="tasks" />}>
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search alerts…" />
              <FacetFilter label="Severity" options={opts(facets?.severity, ALERT_SEVERITIES)} selected={url.getAll("severity")} onChange={(v) => url.set({ severity: v })} />
              <FacetFilter label="Status" options={opts(facets?.status, ALERT_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter
                label="Rule"
                searchable
                options={Object.entries(facets?.rule_key ?? {}).map(([v, c]) => ({ value: v, label: v, count: c }))}
                selected={url.getAll("rule_key")}
                onChange={(v) => url.set({ rule_key: v })}
              />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q"), sort: url.get("sort") })} />
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
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowClassName={(a) => (a.severity === "critical" && a.status !== "resolved" ? "bg-negative-soft/40" : undefined)}
          empty={<EmptyState icon={<BellOff />} title="No alerts here" description="Alerts are raised by automations and must be worked to a resolution." />}
        />
      </ListCard>
      <AlertActionDialog alert={acting?.alert ?? null} mode={acting?.mode ?? "acknowledge"} onClose={() => setActing(null)} />
    </>
  );
}
