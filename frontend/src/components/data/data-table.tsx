"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { Checkbox, Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** API sort key; enables click-to-sort on the header. */
  sortKey?: string;
  width?: number | string;
  align?: "left" | "right" | "center";
  /** Can be toggled from the Columns menu. */
  hideable?: boolean;
  defaultHidden?: boolean;
  className?: string;
}

interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[];
  data?: T[];
  loading?: boolean;
  fetching?: boolean;
  sort?: string | null;
  onSortChange?: (sort: string | null) => void;
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  onRowClick?: (row: T) => void;
  rowHref?: (row: T) => string;
  hidden?: string[];
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  dense?: boolean;
}

export function DataTable<T extends { id: string }>({
  columns,
  data,
  loading,
  fetching,
  sort,
  onSortChange,
  selectable,
  selected = [],
  onSelectedChange,
  onRowClick,
  rowHref,
  hidden = [],
  empty,
  rowClassName,
  dense,
}: DataTableProps<T>) {
  const router = useRouter();
  const visible = useMemo(() => columns.filter((c) => !hidden.includes(c.id)), [columns, hidden]);
  const rows = data ?? [];
  const pageIds = rows.map((r) => r.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const someSelected = !allSelected && pageIds.some((id) => selected.includes(id));

  const toggleAll = (checked: boolean) =>
    onSelectedChange?.(checked ? Array.from(new Set([...selected, ...pageIds])) : selected.filter((id) => !pageIds.includes(id)));
  const toggleOne = (id: string, checked: boolean) =>
    onSelectedChange?.(checked ? [...selected, id] : selected.filter((s) => s !== id));

  const cycleSort = (key: string) => {
    if (!onSortChange) return;
    if (sort === key) onSortChange(`-${key}`);
    else if (sort === `-${key}`) onSortChange(null);
    else onSortChange(key);
  };

  const handleRowClick = (row: T, e: MouseEvent) => {
    // React bubbles events from portaled content (row menus, dialogs) through the row; ignore those.
    if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest("a,button,[role=checkbox],input")) return;
    if (rowHref) {
      const href = rowHref(row);
      if (e.metaKey || e.ctrlKey) window.open(href, "_blank");
      else router.push(href);
    } else onRowClick?.(row);
  };

  const clickable = !!(rowHref || onRowClick);
  const cellPad = dense ? "px-3 py-1.5" : "px-3 py-2";

  return (
    <div className="relative overflow-hidden">
      {fetching && !loading && (
        <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-accent/10">
          <div className="h-full w-1/3 animate-progress bg-accent" />
        </div>
      )}
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {selectable && (
                <th className="sticky top-0 z-10 w-10 border-b border-line bg-subtle px-3 py-2">
                  <Checkbox checked={allSelected} indeterminate={someSelected} onChange={toggleAll} label="Select all" />
                </th>
              )}
              {visible.map((col) => {
                const active = col.sortKey && (sort === col.sortKey || sort === `-${col.sortKey}`);
                const desc = sort === `-${col.sortKey}`;
                return (
                  <th
                    key={col.id}
                    style={{ width: col.width, minWidth: col.width }}
                    className={cn(
                      "sticky top-0 z-10 whitespace-nowrap border-b border-line bg-subtle px-3 py-2 text-left text-xs font-medium text-ink-3",
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                    )}
                  >
                    {col.sortKey && onSortChange ? (
                      <button
                        onClick={() => cycleSort(col.sortKey!)}
                        className={cn(
                          "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-ink",
                          active && "text-ink",
                          col.align === "right" && "flex-row-reverse",
                        )}
                      >
                        {col.header}
                        {active ? (
                          desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-40" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className={cn(fetching && !loading && "opacity-70 transition-opacity")}>
            {loading && !data
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {selectable && <td className="border-b border-line px-3 py-3"><Skeleton className="size-4" /></td>}
                    {visible.map((col) => (
                      <td key={col.id} className="border-b border-line px-3 py-3">
                        <Skeleton className={cn("h-3.5", i % 2 ? "w-3/4" : "w-1/2", col.align === "right" && "ml-auto")} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => {
                  const isSelected = selected.includes(row.id);
                  return (
                    <tr
                      key={row.id}
                      onClick={(e) => handleRowClick(row, e)}
                      className={cn(
                        "group transition-colors",
                        clickable && "cursor-pointer",
                        isSelected ? "bg-accent-soft/60" : "hover:bg-subtle/80",
                        rowClassName?.(row),
                      )}
                    >
                      {selectable && (
                        <td className={cn("border-b border-line", cellPad)}>
                          <Checkbox checked={isSelected} onChange={(c) => toggleOne(row.id, c)} label="Select row" />
                        </td>
                      )}
                      {visible.map((col) => (
                        <td
                          key={col.id}
                          className={cn(
                            "border-b border-line align-middle text-ink",
                            cellPad,
                            col.align === "right" && "text-right tabular",
                            col.align === "center" && "text-center",
                            col.className,
                          )}
                        >
                          {col.cell(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && <div className="border-b border-line">{empty}</div>}
    </div>
  );
}

/** Persists hidden columns per table in localStorage. */
export function useColumnVisibility<T>(tableKey: string, columns: Column<T>[]) {
  const defaults = useMemo(() => columns.filter((c) => c.defaultHidden).map((c) => c.id), [columns]);
  const [hidden, setHidden] = useState<string[]>(defaults);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(`cols:${tableKey}`);
      if (stored) setHidden(JSON.parse(stored));
    } catch {
      /* storage unavailable */
    }
  }, [tableKey]);

  const toggle = (id: string, visible: boolean) => {
    setHidden((prev) => {
      const next = visible ? prev.filter((h) => h !== id) : [...prev, id];
      try {
        window.localStorage.setItem(`cols:${tableKey}`, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const reset = () => {
    setHidden(defaults);
    try {
      window.localStorage.removeItem(`cols:${tableKey}`);
    } catch {
      /* ignore */
    }
  };

  return { hidden, toggle, reset };
}
