"use client";

import * as CB from "@radix-ui/react-checkbox";
import * as T from "@radix-ui/react-tabs";
import * as TT from "@radix-ui/react-tooltip";
import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";

import { cn, initials } from "@/lib/utils";

export function Checkbox({
  checked,
  onChange,
  indeterminate,
  label,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  indeterminate?: boolean;
  label?: string;
  className?: string;
}) {
  const state = indeterminate ? "indeterminate" : checked;
  return (
    <CB.Root
      checked={state}
      onCheckedChange={(v) => onChange(v === true)}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border border-line-strong bg-surface transition-colors",
        "data-[state=checked]:border-ink data-[state=checked]:bg-ink data-[state=indeterminate]:border-ink data-[state=indeterminate]:bg-ink",
        className,
      )}
    >
      <CB.Indicator className="text-white">
        {indeterminate ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </CB.Indicator>
    </CB.Root>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  if (!content) return <>{children}</>;
  return (
    <TT.Root delayDuration={250}>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-md bg-ink px-2 py-1.5 text-xs text-white shadow-pop animate-fade-in">
          {content}
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}

export const TooltipProvider = TT.Provider;

export function Tabs({ value, onValueChange, children, className }: { value: string; onValueChange: (v: string) => void; children: ReactNode; className?: string }) {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={className}>
      {children}
    </T.Root>
  );
}

export function TabList({ tabs, className }: { tabs: { value: string; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <T.List className={cn("flex gap-5 border-b border-line", className)}>
      {tabs.map((t) => (
        <T.Trigger
          key={t.value}
          value={t.value}
          className={cn(
            "relative -mb-px flex h-10 items-center gap-1.5 border-b-2 border-transparent text-sm font-medium text-ink-3 transition-colors",
            "hover:text-ink data-[state=active]:border-ink data-[state=active]:text-ink",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded bg-muted px-1.5 text-2xs font-medium text-ink-2 tabular">{t.count}</span>}
        </T.Trigger>
      ))}
    </T.List>
  );
}

export const TabPanel = T.Content;

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-subtle px-1 font-sans text-2xs font-medium text-ink-3", className)}>
      {children}
    </kbd>
  );
}

const AVATAR_TONES = ["bg-[#e8eefc] text-[#1d45ab]", "bg-[#e6f4ec] text-[#15703a]", "bg-[#fdf1e3] text-[#9a4a07]", "bg-[#f1ecfa] text-[#5b3a9b]", "bg-[#e5f3f8] text-[#0a5e86]", "bg-[#fbeaea] text-[#a12f2f]"];

export function Avatar({ name, size = 24, className }: { name?: string | null; size?: number; className?: string }) {
  const hash = (name ?? "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return (
    <span
      title={name ?? undefined}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.4) }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", AVATAR_TONES[hash % AVATAR_TONES.length], className)}
    >
      {initials(name)}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn("inline-block size-4 animate-spin rounded-full border-2 border-line-strong border-t-ink", className)} />;
}

export function Progress({ value, className, tone }: { value: number; className?: string; tone?: "auto" | "accent" }) {
  const v = Math.max(0, Math.min(100, value));
  const color = tone === "accent" ? "bg-accent" : v >= 80 ? "bg-positive" : v >= 50 ? "bg-caution" : "bg-negative";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} />;
}
