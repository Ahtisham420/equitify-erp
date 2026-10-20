"use client";

import { useQuery } from "@tanstack/react-query";
import { Archive, ListChecks, MoreHorizontal, Pencil, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, PageHeader } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Checkbox, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, formatNumber, formatRelative, titleCase } from "@/lib/utils";

import {
  EXCEPTION_LABELS,
  RESULT_LABELS,
  RESULTS,
  describeCriterion,
  useBuyBox,
  useBuyboxMeta,
  useBuyBoxVersions,
  useEvaluateAll,
  useReplaceCriteria,
  type BuyBox,
  type Evaluation,
} from "@/features/buybox/api";
import { BuyBoxFormSheet } from "@/features/buybox/buybox-form";
import { CriteriaBuilder } from "@/features/buybox/criteria-builder";
import { EvaluationDetails, ExceptionActions, ExceptionBadge, ResultBadge } from "@/features/buybox/evaluation";

function CriteriaTab({ box }: { box: BuyBox }) {
  const { can } = useAuth();
  const { data: meta } = useBuyboxMeta();
  const replace = useReplaceCriteria(box.id);
  const { data: oldest } = useQuery({
    queryKey: ["buybox-evaluations", box.id, "oldest"],
    queryFn: () => api.get<Page<Evaluation>>(`/buy-boxes/${box.id}/evaluations`, { page_size: 1, sort: "buy_box_version" }),
  });
  const stale = oldest?.items[0] && oldest.items[0].buy_box_version < box.version;
  const evaluateAll = useEvaluateAll(box.id);

  return (
    <div className="space-y-4">
      {stale && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-caution/30 bg-caution-soft px-4 py-3 text-sm">
          <p className="text-ink-2">
            Some current evaluations use an older version than v{box.version}. Re-run the buy box to apply the latest criteria.
          </p>
          {can("buybox", "edit") && (
            <Button
              size="sm"
              loading={evaluateAll.isPending}
              onClick={() =>
                evaluateAll.mutate(undefined, {
                  onSuccess: (r) => toast.success(`${formatNumber(r.evaluated)} properties evaluated`),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              <Play /> Evaluate all
            </Button>
          )}
        </div>
      )}
      <Card>
        <CardHeader
          title={`Criteria · version ${box.version}`}
          description="Mandatory misses fail, disqualifying matches fail, preferred misses are reported only. Saving creates a new version."
        />
        <CardBody>
          {meta ? (
            <CriteriaBuilder
              criteria={box.criteria}
              meta={meta}
              readOnly={!can("buybox", "edit")}
              saving={replace.isPending}
              onSave={(criteria, note) =>
                replace.mutate(
                  { criteria, change_note: note || null },
                  {
                    onSuccess: (b) => toast.success(`Saved as version ${b.version}`),
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            />
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function EvaluationsTab({ box }: { box: BuyBox }) {
  const list = useListQuery<Evaluation>("buybox-evaluations", `/buy-boxes/${box.id}/evaluations`);
  const { url } = list;
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.data?.items.find((e) => e.id === openId) ?? null;
  const history = url.get("current_only") === "false";

  const columns: Column<Evaluation>[] = [
    {
      id: "property",
      header: "Property",
      cell: (e) => (
        <div className="min-w-[200px] max-w-[320px]">
          <Link href={`/properties/${e.property_id}?tab=buybox`} className="block truncate font-medium text-ink hover:underline">
            {e.property_label ?? "—"}
          </Link>
          <p className="truncate text-xs text-ink-3">{[e.property_city, e.property_state].filter(Boolean).join(", ") || "—"}</p>
        </div>
      ),
    },
    {
      id: "result",
      header: "Result",
      sortKey: "result",
      cell: (e) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <ResultBadge result={e.result} />
          <ExceptionBadge status={e.exception_status} />
        </div>
      ),
    },
    {
      id: "why",
      header: "Explanation",
      cell: (e) => {
        const text =
          e.result === "insufficient_data"
            ? `Missing ${e.missing_fields.map(titleCase).join(", ")}`
            : e.details.filter((d) => d.outcome === "fail" && d.requirement !== "preferred").map((d) => d.explanation).join("; ");
        return <span className="line-clamp-2 max-w-[380px] text-xs text-ink-2">{text || "All gating criteria met"}</span>;
      },
    },
    { id: "version", header: "Version", sortKey: "buy_box_version", align: "right", cell: (e) => `v${e.buy_box_version}` },
    { id: "evaluated", header: "Evaluated", sortKey: "evaluated_at", cell: (e) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(e.evaluated_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      // Stop clicks inside the (portalled) exception dialog from bubbling to the row and opening the sheet.
      cell: (e) => (
        <div onClick={(ev) => ev.stopPropagation()}>
          <ExceptionActions evaluation={e} />
        </div>
      ),
    },
  ];

  const chips: FilterChip[] = [];
  for (const [key, label, labels] of [
    ["result", "Result", RESULT_LABELS],
    ["exception_status", "Exception", EXCEPTION_LABELS],
  ] as const) {
    const v = url.getAll(key);
    if (v.length) chips.push({ key, label, value: v.map((x) => labels[x] ?? x).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (history) chips.push({ key: "current_only", label: "Including", value: "superseded", onRemove: () => url.set({ current_only: null }) });

  return (
    <div className="space-y-3">
      <Toolbar>
        <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property…" shortcut={false} />
        <FacetFilter
          label="Result"
          options={RESULTS.map((r) => ({ value: r, label: RESULT_LABELS[r], count: box.result_counts[r] ?? 0 }))}
          selected={url.getAll("result")}
          onChange={(v) => url.set({ result: v })}
        />
        <FacetFilter
          label="Exception"
          options={["requested", "approved", "rejected"].map((s) => ({ value: s, label: EXCEPTION_LABELS[s] }))}
          selected={url.getAll("exception_status")}
          onChange={(v) => url.set({ exception_status: v })}
        />
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={history} onChange={(v) => url.set({ current_only: v ? "false" : null })} />
          Include superseded
        </label>
      </Toolbar>
      <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab") })} />
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={(e) => setOpenId(e.id)}
          rowClassName={(e) => (!e.is_current ? "bg-subtle/40" : undefined)}
          empty={<EmptyState icon={<ListChecks />} title="No evaluations" description="Evaluate all properties to see how they fit this buy box." />}
        />
        <TableFooter
          page={list.page}
          pageSize={list.pageSize}
          total={list.data?.total ?? 0}
          onPage={(page) => url.set({ page }, { resetPage: false })}
          onPageSize={(size) => url.set({ page_size: size })}
        />
      </Card>
      <Sheet
        open={!!open}
        onOpenChange={(o) => !o && setOpenId(null)}
        title={open?.property_label ?? "Evaluation"}
        description={open ? `${box.name} · v${open.buy_box_version}` : undefined}
        footer={open ? <ExceptionActions evaluation={open} size="sm" /> : undefined}
      >
        {open && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ResultBadge result={open.result} />
              <ExceptionBadge status={open.exception_status} />
            </div>
            <EvaluationDetails evaluation={open} />
          </div>
        )}
      </Sheet>
    </div>
  );
}

function VersionsTab({ box }: { box: BuyBox }) {
  const { data: meta } = useBuyboxMeta();
  const { data, isLoading } = useBuyBoxVersions(box.id);
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data?.length) return <EmptyState title="No versions recorded" />;
  return (
    <div className="space-y-3">
      {data.map((v) => (
        <Card key={v.id}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Version {v.version}
                {v.version === box.version && <Badge tone="blue">Current</Badge>}
              </span>
            }
            description={`${v.created_by_name ?? "System"} · ${formatDateTime(v.created_at)}${v.change_note ? ` · ${v.change_note}` : ""}`}
          />
          <CardBody className="py-3">
            {v.criteria.length === 0 ? (
              <p className="text-sm text-ink-3">No criteria</p>
            ) : (
              <ul className="space-y-1">
                {v.criteria.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm">
                    <Badge tone={c.requirement === "disqualifying" ? "red" : c.requirement === "preferred" ? "outline" : "neutral"}>{titleCase(c.requirement)}</Badge>
                    <span className="text-ink">{describeCriterion(c, meta)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function BuyBoxDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: box, isLoading, error } = useBuyBox(id);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const evaluateAll = useEvaluateAll(id);
  const tab = url.get("tab") ?? (url.get("result") ? "evaluations" : "criteria");

  const { data: pending } = useQuery({
    queryKey: ["buybox-evaluations", id, "pending"],
    queryFn: () => api.get<Page<Evaluation>>(`/buy-boxes/${id}/evaluations`, { exception_status: "requested", page_size: 1 }),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !box) {
    return <EmptyState title="Buy box not found" description={errorMessage(error)} action={<Link href="/buy-boxes"><Button>Back to buy boxes</Button></Link>} />;
  }

  const runAll = () =>
    evaluateAll.mutate(undefined, {
      onSuccess: (r) =>
        toast.success(`${formatNumber(r.evaluated)} properties evaluated`, {
          description: `${formatNumber(r.changed)} changed · ${RESULTS.map((k) => `${RESULT_LABELS[k]} ${r.by_result[k] ?? 0}`).join(" · ")}`,
        }),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const archive = async () => {
    try {
      await api.delete(`/buy-boxes/${id}`);
      toast.success("Buy box archived");
      router.replace("/buy-boxes");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const total = Object.values(box.result_counts).reduce((a, b) => a + b, 0);
  const pendingCount = pending?.total ?? 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Buy boxes", href: "/buy-boxes" }, { label: box.name }]}
        title={box.name}
        description={box.description ?? undefined}
        meta={
          <>
            <StatusBadge status={box.is_active ? "active" : "inactive"} />
            <Badge tone="outline">{titleCase(box.strategy)}</Badge>
            <span className="text-xs text-ink-3">v{box.version}</span>
            <span className="text-xs text-ink-3">
              · {box.active_from || box.active_to ? `${box.active_from ? formatDate(box.active_from) : "…"} – ${box.active_to ? formatDate(box.active_to) : "…"}` : "Open-ended"}
            </span>
            {box.owner_name && <span className="text-xs text-ink-3">· Owner {box.owner_name}</span>}
          </>
        }
        actions={
          <>
            {can("buybox", "edit") && (
              <Button onClick={runAll} loading={evaluateAll.isPending}>
                <Play />
                Evaluate all
              </Button>
            )}
            {can("buybox", "edit") && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            )}
            {can("buybox", "delete") && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                    Archive buy box
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {RESULTS.map((r) => (
          <button
            key={r}
            onClick={() => url.set({ tab: "evaluations", result: [r] })}
            className="rounded-lg border border-line bg-surface p-3 text-left shadow-card transition-colors hover:border-line-strong hover:bg-subtle/50"
          >
            <p className="text-xs font-medium text-ink-3">{RESULT_LABELS[r]}</p>
            <p className="mt-1 text-xl font-semibold tracking-tight tabular">{formatNumber(box.result_counts[r] ?? 0)}</p>
            <p className="text-xs text-ink-3">{total ? `${Math.round(((box.result_counts[r] ?? 0) / total) * 100)}% of evaluated` : "—"}</p>
          </button>
        ))}
        <button
          onClick={() => url.set({ tab: "evaluations", exception_status: ["requested"], result: null })}
          className="rounded-lg border border-line bg-surface p-3 text-left shadow-card transition-colors hover:border-line-strong hover:bg-subtle/50"
        >
          <p className="text-xs font-medium text-ink-3">Pending exceptions</p>
          <p className={`mt-1 text-xl font-semibold tracking-tight tabular ${pendingCount ? "text-caution" : ""}`}>{formatNumber(pendingCount)}</p>
          <p className="text-xs text-ink-3">{can("buybox", "approve") ? "Awaiting your decision" : "Awaiting approver"}</p>
        </button>
      </div>

      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "criteria" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "criteria", label: "Criteria", count: box.criteria.length },
            { value: "evaluations", label: "Evaluations", count: total },
            { value: "versions", label: "Versions", count: box.version },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="criteria">
          <CriteriaTab box={box} />
        </TabPanel>
        <TabPanel value="evaluations">
          <EvaluationsTab box={box} />
        </TabPanel>
        <TabPanel value="versions">
          <VersionsTab box={box} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="buy_box" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <BuyBoxFormSheet open={editing} onOpenChange={setEditing} buyBox={box} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this buy box?"
        description="It stops evaluating properties. Its versions and evaluation history are retained."
        confirmLabel="Archive"
        destructive
        onConfirm={archive}
      />
    </>
  );
}

export default function BuyBoxPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <BuyBoxDetail id={params.id} />
    </Suspense>
  );
}
