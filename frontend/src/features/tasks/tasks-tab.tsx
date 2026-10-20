"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckSquare, Lock, Plus } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Tooltip } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPE_LABELS, TASK_TYPES, useTaskAction, type Task, type TaskFacets } from "./api";
import { TaskSheet, taskErrorDetail } from "./task-sheet";

const OPEN = ["open", "in_progress"];

const QUICK_VIEWS: { key: string; label: string; params: Record<string, string | string[] | null> }[] = [
  { key: "mine", label: "My open", params: { assignee: "me", status: OPEN, due: null } },
  { key: "overdue", label: "Overdue", params: { assignee: "me", status: null, due: "overdue" } },
  { key: "today", label: "Due today", params: { assignee: "me", status: OPEN, due: "today" } },
  { key: "all", label: "All", params: { assignee: null, status: null, due: null } },
];

const MORE: MoreFilterField[] = [
  {
    type: "select",
    label: "Due",
    key: "due",
    options: [
      { value: "overdue", label: "Overdue" },
      { value: "today", label: "Due today" },
      { value: "this_week", label: "Next 7 days" },
      { value: "none", label: "No due date" },
    ],
  },
  {
    type: "select",
    label: "Owner",
    key: "assignee",
    options: [
      { value: "me", label: "Me" },
      { value: "none", label: "Unassigned" },
    ],
  },
  {
    type: "select",
    label: "Related to",
    key: "related_type",
    options: ["property", "person", "organization", "opportunity", "task"].map((t) => ({ value: t, label: titleCase(t) })),
  },
];

const DUE_LABELS: Record<string, string> = { overdue: "Overdue", today: "Due today", this_week: "Next 7 days", none: "No due date" };

function CompleteBox({ task }: { task: Task }) {
  const run = useTaskAction();
  const { can } = useAuth();
  const done = task.status === "done";
  const disabled = !can("tasks", "edit") || task.status === "cancelled" || run.isPending;
  const box = (
    <span className={cn(disabled && "pointer-events-none opacity-50")}>
      <Checkbox
        checked={done}
        label={done ? "Reopen task" : "Complete task"}
        onChange={(checked) => {
          if (checked && task.blocked) {
            toast.error("This task depends on work that is still open");
            return;
          }
          run.mutate(
            { id: task.id, action: checked ? "complete" : "reopen" },
            { onSuccess: () => toast.success(checked ? "Task completed" : "Task reopened"), onError: (e) => toast.error(taskErrorDetail(e)) },
          );
        }}
      />
    </span>
  );
  return task.blocked ? <Tooltip content="Blocked by an open dependency">{box}</Tooltip> : box;
}

const columns: Column<Task>[] = [
  { id: "done", header: "", width: 36, cell: (t) => <CompleteBox task={t} /> },
  {
    id: "title",
    header: "Task",
    sortKey: "title",
    cell: (t) => (
      <div className="min-w-[240px] max-w-[420px]">
        <p className={cn("flex items-center gap-1.5 truncate font-medium", t.status === "done" || t.status === "cancelled" ? "text-ink-3 line-through" : "text-ink")}>
          {t.blocked && <Lock className="size-3.5 shrink-0 text-caution" />}
          <span className="truncate">{t.title}</span>
        </p>
        <p className="truncate text-xs text-ink-3">{t.related_label ? `${titleCase(t.related_type)} · ${t.related_label}` : t.source !== "manual" ? `From ${titleCase(t.source)}` : "—"}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", sortKey: "task_type", hideable: true, cell: (t) => <span className="text-ink-2">{TASK_TYPE_LABELS[t.task_type] ?? titleCase(t.task_type)}</span> },
  {
    id: "priority",
    header: "Priority",
    sortKey: "priority",
    hideable: true,
    cell: (t) => (
      <span className="flex items-center gap-1">
        <StatusBadge status={t.priority} />
        {t.escalation_level > 0 && <Badge tone="red">Escalated</Badge>}
      </span>
    ),
  },
  {
    id: "due",
    header: "Due",
    sortKey: "due_at",
    hideable: true,
    cell: (t) => {
      const late = !!t.due_at && OPEN.includes(t.status) && isOverdue(t.due_at);
      return (
        <span title={formatDateTime(t.due_at)} className={cn("whitespace-nowrap text-xs", late ? "font-medium text-negative" : "text-ink-2")}>
          {t.due_at ? formatRelative(t.due_at) : "—"}
        </span>
      );
    },
  },
  { id: "owner", header: "Owner", hideable: true, cell: (t) => <span className="text-ink-2">{t.assignee_name ?? "Unassigned"}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (t) => <StatusBadge status={t.status} /> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (t) => <span className="text-xs text-ink-3">{formatRelative(t.updated_at)}</span> },
];

export function TasksTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const list = useListQuery<Task>("tasks", "/tasks");
  const { url } = list;
  const cols = useColumnVisibility("tasks", columns);
  const openTask = url.get("task");

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, task: _k, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["tasks", "facets", filterParams],
    queryFn: () => api.get<TaskFacets>("/tasks/facets", filterParams),
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

  const chips: FilterChip[] = [];
  for (const [key, label] of [["status", "Status"], ["priority", "Priority"], ["task_type", "Type"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map((v) => TASK_TYPE_LABELS[v] ?? titleCase(v)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (url.get("due")) chips.push({ key: "due", label: "Due", value: DUE_LABELS[url.get("due")!] ?? url.get("due")!, onRemove: () => url.set({ due: null }) });
  if (url.getAll("assignee").length)
    chips.push({ key: "assignee", label: "Owner", value: url.getAll("assignee").map((a) => (a === "me" ? "Me" : a === "none" ? "Unassigned" : "Selected user")).join(", "), onRemove: () => url.set({ assignee: null }) });
  if (url.get("related_type")) chips.push({ key: "related_type", label: "Related to", value: titleCase(url.get("related_type")), onRemove: () => url.set({ related_type: null, related_id: null }) });

  const opts = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

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
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="tasks" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search tasks…" />
              <FacetFilter label="Status" options={opts(facets?.status, TASK_STATUSES, titleCase)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Priority" options={opts(facets?.priority, TASK_PRIORITIES, titleCase)} selected={url.getAll("priority")} onChange={(v) => url.set({ priority: v })} />
              <FacetFilter label="Type" options={opts(facets?.task_type, TASK_TYPES, (v) => TASK_TYPE_LABELS[v])} selected={url.getAll("task_type")} onChange={(v) => url.set({ task_type: v })} />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
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
          onRowClick={(t) => url.set({ task: t.id }, { resetPage: false })}
          hidden={cols.hidden}
          rowClassName={(t) => (t.status === "done" || t.status === "cancelled" ? "opacity-70" : undefined)}
          empty={
            <EmptyState
              icon={<CheckSquare />}
              title={chips.length || url.get("q") ? "No tasks match these filters" : "No tasks"}
              description={activeView === "overdue" ? "Nothing overdue. Nice work." : "Tasks come from automations, follow-ups and manual entry."}
              action={
                can("tasks", "create") ? (
                  <Button variant="primary" onClick={() => onCreatingChange(true)}>
                    <Plus /> New task
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <TaskSheet open={creating} onOpenChange={onCreatingChange} />
      <TaskSheet open={!!openTask} onOpenChange={(o) => !o && url.set({ task: null }, { resetPage: false })} taskId={openTask} />
    </>
  );
}
