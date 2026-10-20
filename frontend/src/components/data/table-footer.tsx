"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/utils";

const SIZES = [25, 50, 100];

export function TableFooter({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-ink-3">
      <span className="tabular">
        {total === 0 ? "No results" : (
          <>
            <span className="font-medium text-ink-2">{formatNumber(from)}–{formatNumber(to)}</span> of{" "}
            <span className="font-medium text-ink-2">{formatNumber(total)}</span>
          </>
        )}
      </span>
      <div className="flex items-center gap-3">
        {onPageSize && (
          <label className="flex items-center gap-1.5">
            Rows
            <select
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-7 rounded-md border border-line-strong/80 bg-surface px-1.5 text-xs text-ink focus:outline-none"
            >
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="tabular">
          Page {page} of {pages}
        </span>
        <div className="flex gap-1">
          <Button size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          <Button size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
