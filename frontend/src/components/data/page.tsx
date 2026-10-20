"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn, formatNumber } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  meta?: ReactNode;
}) {
  return (
    <div className="mb-5">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="mb-2 flex items-center gap-1 text-xs text-ink-3">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3" />}
              {b.href ? (
                <Link href={b.href} className="hover:text-ink">
                  {b.label}
                </Link>
              ) : (
                <span className="text-ink-2">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-line bg-subtle text-ink-3 [&_svg]:size-5">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Card container for a list: toolbar on top, table, footer. */
export function ListCard({ toolbar, children, footer }: { toolbar?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="space-y-3">
      {toolbar}
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {children}
        {footer}
      </div>
    </div>
  );
}

export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-ink/10 bg-ink px-2 py-1.5 text-sm text-white shadow-pop animate-slide-up">
      <span className="px-2 font-medium tabular">{formatNumber(count)} selected</span>
      <span className="mx-1 h-4 w-px bg-white/20" />
      {children}
      <span className="mx-1 h-4 w-px bg-white/20" />
      <Button variant="ghost" size="sm" onClick={onClear} className="text-white/70 hover:bg-white/10 hover:text-white">
        Clear
      </Button>
    </div>
  );
}

export const BulkButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }>(
  ({ children, icon, className, ...props }, ref) => (
    <Button ref={ref} variant="ghost" size="sm" className={cn("text-white hover:bg-white/10 hover:text-white", className)} {...props}>
      {icon}
      {children}
    </Button>
  ),
);
BulkButton.displayName = "BulkButton";

/** Label/value grid used on record detail pages. */
export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-4", cols === 1 && "grid-cols-1", cols === 2 && "grid-cols-1 sm:grid-cols-2", cols === 3 && "grid-cols-2 lg:grid-cols-3")}>
      {children}
    </dl>
  );
}

export function FieldItem({ label, children, extra, className }: { label: string; children: ReactNode; extra?: ReactNode; className?: string }) {
  const empty = children === null || children === undefined || children === "" || children === "—";
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="flex items-center gap-1.5 text-xs text-ink-3">
        {label}
        {extra}
      </dt>
      <dd className={cn("mt-0.5 truncate text-sm", empty ? "text-ink-3" : "text-ink")}>{empty ? "—" : children}</dd>
    </div>
  );
}

export function StatCard({ label, value, hint, href, tone }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "default" | "negative" | "caution" | "positive" }) {
  const body = (
    <>
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-2xl font-semibold tracking-tight tabular",
          tone === "negative" && "text-negative",
          tone === "caution" && "text-caution",
          tone === "positive" && "text-positive",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </>
  );
  const cls = "block rounded-lg border border-line bg-surface p-4 shadow-card";
  return href ? (
    <Link href={href} className={cn(cls, "transition-colors hover:border-line-strong hover:bg-subtle/50")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
