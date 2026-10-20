"use client";

import Link from "next/link";

import { DataTable, type Column as TableColumn } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/misc";
import { formatNumber } from "@/lib/utils";

import type { Column, Row, TableOut, Tile } from "./api";
import { formatCell, formatDelta, formatValue, ignoredText } from "./format";

const NUMERIC = new Set(["currency", "number", "percent", "days"]);

/** Generic record/summary columns: the title links to the record; summary cells link to their drill. */
export function reportColumns(columns: Column[], titleLabel = "Record"): TableColumn<Row>[] {
  return [
    {
      id: "title",
      header: titleLabel,
      cell: (r) => (
        <span className="flex items-center gap-2">
          {r.href ? (
            <Link href={r.href} className="truncate font-medium text-ink hover:text-accent hover:underline">
              {r.title}
            </Link>
          ) : (
            <span className="truncate font-medium">{r.title}</span>
          )}
          {r.restricted && (
            <Tooltip content={r.restriction_reason ?? "Restricted source"}>
              <span>
                <Badge tone="amber">Restricted</Badge>
              </span>
            </Tooltip>
          )}
        </span>
      ),
    },
    ...columns.map<TableColumn<Row>>((col) => ({
      id: col.key,
      header: col.label,
      align: NUMERIC.has(col.kind) ? "right" : "left",
      cell: (r) => {
        const value = r.cells[col.key];
        const content = col.kind === "status" && value ? <StatusBadge status={String(value)} /> : formatCell(value, col.kind);
        const href = r.hrefs?.[col.key];
        return href ? (
          <Link href={href} className="hover:text-accent hover:underline">
            {content}
          </Link>
        ) : (
          content
        );
      },
    })),
  ];
}

export function ReportTable({ t }: { t: TableOut }) {
  const summary = t.key === "team" || t.key === "sources";
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t.label}
        description={t.total !== null ? `${formatNumber(t.total)} ${summary ? "rows" : "records"}${t.description ? ` · ${t.description}` : ""}` : t.description ?? undefined}
        actions={
          t.href ? (
            <Link href={t.href} className="text-xs font-medium text-accent hover:underline">
              See all
            </Link>
          ) : undefined
        }
      />
      <DataTable
        columns={reportColumns(t.columns, t.key === "team" ? "User" : t.key === "sources" ? "Source" : "Record")}
        data={t.rows}
        dense
        empty={<EmptyState title="Nothing here" description="No records match these filters." />}
      />
    </Card>
  );
}

export function TileCard({ t }: { t: Tile }) {
  const delta = formatDelta(t.delta, t.unit);
  const ignored = ignoredText(t.ignored_filters.filter((f) => f !== "date"));
  const hint = [delta ?? (t.point_in_time ? "Current" : null), ignored].filter(Boolean).join(" · ");
  const tone =
    t.delta && t.better ? ((t.delta > 0) === (t.better === "up") ? "positive" : "negative") : "default";
  return (
    <div title={t.definition}>
      <StatCard label={t.label} value={formatValue(t.value, t.unit, { compact: true })} hint={hint || undefined} href={t.href} tone={tone} />
    </div>
  );
}
