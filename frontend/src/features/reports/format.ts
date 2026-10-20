import { formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import type { Unit } from "./api";

export function formatValue(value: number | null | undefined, unit: Unit | string, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined) return "—";
  switch (unit) {
    case "currency":
      return formatCurrency(value, { compact: opts.compact });
    case "percent":
      return formatPercent(value, 1);
    case "days":
      return `${formatNumber(value, 1)} d`;
    case "count":
      return formatNumber(value);
    default:
      return formatNumber(value, 2);
  }
}

export function formatDelta(delta: number | null | undefined, unit: Unit): string | null {
  if (delta === null || delta === undefined) return null;
  if (delta === 0) return "No change vs previous period";
  const sign = delta > 0 ? "+" : "−";
  const abs = Math.abs(delta);
  const text = unit === "percent" ? `${formatNumber(abs, 1)} pts` : formatValue(abs, unit, { compact: true });
  return `${sign}${text} vs previous period`;
}

/** Cell formatting by column kind (record tables). */
export function formatCell(value: unknown, kind: string): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (kind) {
    case "currency":
      return formatCurrency(Number(value));
    case "number":
      return formatNumber(Number(value), 2);
    case "percent":
      return formatPercent(Number(value), 1);
    case "days":
      return `${formatNumber(Number(value), 1)} d`;
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    case "bool":
      return value ? "Yes" : "No";
    case "status":
      return titleCase(String(value));
    default:
      return String(value);
  }
}

export const FILTER_LABELS: Record<string, string> = {
  date: "date range",
  user: "user / team",
  geography: "property type / geography / territory",
  source: "source",
  stage: "stage",
};

export function ignoredText(ignored: string[]): string | null {
  const names = ignored.filter((i) => !i.startsWith("f_")).map((i) => FILTER_LABELS[i] ?? i);
  return names.length ? `Not filtered by ${names.join(", ")}` : null;
}
