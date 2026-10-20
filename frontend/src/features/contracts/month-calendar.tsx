"use client";

import { useQuery } from "@tanstack/react-query";
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, isToday, parseISO, startOfMonth, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { api, type Params } from "@/lib/api";
import { cn } from "@/lib/utils";

import { isOverdueDate, type CriticalDate } from "./api";

const CHIP: Record<string, string> = {
  proposed: "border-caution/30 bg-caution-soft text-caution",
  confirmed: "border-accent/20 bg-accent-soft text-accent-ink",
  missed: "border-negative/30 bg-negative-soft text-negative",
  completed: "border-positive/20 bg-positive-soft text-positive",
  waived: "border-line bg-muted text-ink-3",
};

/** Compact month grid (pure CSS grid). `month` is YYYY-MM; filters are the same as the list. */
export function MonthCalendar({
  month,
  onMonth,
  filters,
  onSelect,
}: {
  month: string;
  onMonth: (m: string) => void;
  filters: Params;
  onSelect: (d: CriticalDate) => void;
}) {
  const first = useMemo(() => {
    const d = parseISO(`${month}-01`);
    return Number.isNaN(d.getTime()) ? startOfMonth(new Date()) : d;
  }, [month]);
  const gridStart = startOfWeek(first, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(first), { weekStartsOn: 1 });
  const start = format(gridStart, "yyyy-MM-dd");
  const end = format(gridEnd, "yyyy-MM-dd");
  const [openDay, setOpenDay] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["critical-dates", "calendar", start, end, filters],
    queryFn: () => api.get<CriticalDate[]>("/critical-dates/calendar", { ...filters, start, end }),
    placeholderData: (prev) => prev,
  });

  const byDay = useMemo(() => {
    const map = new Map<string, CriticalDate[]>();
    for (const d of data ?? []) map.set(d.due_on, [...(map.get(d.due_on) ?? []), d]);
    return map;
  }, [data]);

  const days: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);
  const dayItems = openDay ? byDay.get(openDay) ?? [] : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" aria-label="Previous month" onClick={() => onMonth(format(addMonths(first, -1), "yyyy-MM"))}>
            <ChevronLeft />
          </Button>
          <Button size="icon-sm" aria-label="Next month" onClick={() => onMonth(format(addMonths(first, 1), "yyyy-MM"))}>
            <ChevronRight />
          </Button>
          <h2 className="ml-2 text-sm font-semibold text-ink">{format(first, "MMMM yyyy")}</h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onMonth(format(new Date(), "yyyy-MM"))}>
          Today
        </Button>
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-line bg-subtle text-2xs font-medium uppercase tracking-wide text-ink-3">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="px-2 py-1.5">
              {d}
            </div>
          ))}
        </div>
        {isLoading && !data ? (
          <Skeleton className="m-4 h-64" />
        ) : (
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const items = byDay.get(key) ?? [];
              const overdue = items.some(isOverdueDate);
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => setOpenDay(items.length ? (openDay === key ? null : key) : null)}
                  className={cn(
                    "min-h-[96px] border-b border-r border-line p-1.5 text-left align-top transition-colors hover:bg-subtle/60 [&:nth-child(7n)]:border-r-0",
                    !isSameMonth(day, first) && "bg-subtle/40",
                    openDay === key && "bg-accent-soft/40",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded-full text-2xs tabular",
                        isToday(day) ? "bg-ink font-semibold text-white" : isSameMonth(day, first) ? "text-ink-2" : "text-ink-3",
                      )}
                    >
                      {format(day, "d")}
                    </span>
                    {overdue && <span className="size-1.5 rounded-full bg-negative" />}
                  </div>
                  <div className="space-y-0.5">
                    {items.slice(0, 3).map((d) => (
                      <span
                        key={d.id}
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(d);
                        }}
                        className={cn("block truncate rounded border px-1 py-px text-2xs", isOverdueDate(d) ? CHIP.missed : CHIP[d.status] ?? CHIP.waived)}
                        title={`${d.label}${d.related_label ? ` — ${d.related_label}` : ""}`}
                      >
                        {d.is_blocking ? "• " : ""}
                        {d.label}
                      </span>
                    ))}
                    {items.length > 3 && <span className="block px-1 text-2xs text-ink-3">+{items.length - 3} more</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>
      {openDay && dayItems.length > 0 && (
        <Card>
          <div className="border-b border-line px-4 py-2 text-sm font-medium text-ink">{format(parseISO(openDay), "EEEE, MMMM d")}</div>
          <ul className="divide-y divide-line">
            {dayItems.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => onSelect(d)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-subtle/60">
                  <span className={cn("size-2 shrink-0 rounded-full", isOverdueDate(d) ? "bg-negative" : d.status === "proposed" ? "bg-caution" : d.status === "completed" ? "bg-positive" : "bg-accent")} />
                  <span className="min-w-0 flex-1 truncate text-ink">{d.label}</span>
                  <span className="truncate text-xs text-ink-3">{d.related_label}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
