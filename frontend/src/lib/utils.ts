import { clsx, type ClassValue } from "clsx";
import { format, formatDistanceToNowStrict, isValid, parseISO } from "date-fns";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const EMPTY = "—";

export function titleCase(value?: string | null): string {
  if (!value) return EMPTY;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b(stnl|loi|dd|apn|noi|dscr|ltv|sf|llc|wale|ti|lc|bov)\b/gi, (m) => m.toUpperCase())
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatNumber(value?: number | null, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

export function formatCurrency(value?: number | null, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: opts.compact ? 1 : 0,
  }).format(value);
}

export function formatPercent(value?: number | null, digits = 1): string {
  if (value === null || value === undefined) return EMPTY;
  return `${formatNumber(value, digits)}%`;
}

function toDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const d = typeof value === "string" ? parseISO(value) : value;
  return isValid(d) ? d : null;
}

export function formatDate(value?: string | Date | null, pattern = "MMM d, yyyy"): string {
  const d = toDate(value);
  return d ? format(d, pattern) : EMPTY;
}

export function formatDateTime(value?: string | Date | null): string {
  return formatDate(value, "MMM d, yyyy · h:mm a");
}

export function formatRelative(value?: string | Date | null): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const diff = Date.now() - d.getTime();
  if (diff >= 0 && diff < 60_000) return "just now";
  const rel = formatDistanceToNowStrict(d, { addSuffix: true });
  return rel;
}

export function initials(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

/** Parse an <input> value into a number or null (empty string -> null). */
export function toNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function isOverdue(value?: string | null): boolean {
  const d = toDate(value);
  return !!d && d.getTime() < Date.now();
}
