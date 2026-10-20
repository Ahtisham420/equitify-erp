"use client";

import { Check, ChevronDown, Columns3, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Column } from "@/components/data/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuCheckItem, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { Kbd } from "@/components/ui/misc";
import { useDebounce } from "@/hooks/use-debounce";
import { cn, formatNumber } from "@/lib/utils";

/* ---------------------------------------------------------------- search */

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  shortcut = true,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  shortcut?: boolean;
}) {
  const [text, setText] = useState(value);
  const debounced = useDebounce(text, 300);
  const ref = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (debounced !== value) onChangeRef.current(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  useEffect(() => {
    if (!shortcut) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) && !target.isContentEditable) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcut]);

  return (
    <Input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setText("");
          onChange("");
          ref.current?.blur();
        }
      }}
      placeholder={placeholder}
      leading={<Search />}
      trailing={
        text ? (
          <button onClick={() => { setText(""); onChange(""); }} className="rounded p-0.5 hover:bg-muted hover:text-ink" aria-label="Clear search">
            <X className="size-3.5" />
          </button>
        ) : shortcut ? (
          <Kbd>/</Kbd>
        ) : null
      }
      className={cn("w-72", className)}
    />
  );
}

/* ---------------------------------------------------------------- facet */

export interface FacetOption {
  value: string;
  label: string;
  count?: number;
  icon?: ReactNode;
}

export function FacetFilter({
  label,
  options,
  selected,
  onChange,
  searchable,
  single,
}: {
  label: string;
  options: FacetOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  searchable?: boolean;
  single?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())),
    [options, query],
  );
  const active = selected.length > 0;
  const summary =
    selected.length === 1 ? options.find((o) => o.value === selected[0])?.label ?? selected[0] : `${selected.length} selected`;

  const toggle = (value: string) => {
    if (single) onChange(selected.includes(value) ? [] : [value]);
    else onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <Popover onOpenChange={(o) => !o && setQuery("")}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm shadow-card transition-colors",
            active
              ? "border-accent/30 bg-accent-soft text-accent-ink hover:bg-accent-soft/70"
              : "border-dashed border-line-strong bg-surface text-ink-2 hover:bg-subtle hover:text-ink",
          )}
        >
          <span className={cn(active && "text-accent-ink/70")}>{label}</span>
          {active && <span className="max-w-[140px] truncate font-medium">{summary}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60">
        {(searchable || options.length > 8) && (
          <div className="border-b border-line p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${label.toLowerCase()}…`}
              className="h-7 w-full rounded bg-transparent px-1.5 text-sm placeholder:text-ink-3 focus:outline-none"
            />
          </div>
        )}
        <div className="max-h-72 overflow-y-auto p-1 scrollbar-thin">
          {filtered.length === 0 && <p className="px-2 py-3 text-center text-xs text-ink-3">No options</p>}
          {filtered.map((o) => {
            const checked = selected.includes(o.value);
            return (
              <button
                key={o.value}
                onClick={() => toggle(o.value)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-ink hover:bg-muted"
              >
                <span className={cn("flex size-4 shrink-0 items-center justify-center border", single ? "rounded-full" : "rounded", checked ? "border-ink bg-ink text-white" : "border-line-strong")}>
                  {checked && <Check className="size-3" strokeWidth={3} />}
                </span>
                {o.icon}
                <span className="flex-1 truncate">{o.label}</span>
                {o.count !== undefined && <span className="text-xs text-ink-3 tabular">{formatNumber(o.count)}</span>}
              </button>
            );
          })}
        </div>
        {active && (
          <div className="border-t border-line p-1">
            <button onClick={() => onChange([])} className="h-7 w-full rounded-md text-xs font-medium text-ink-2 hover:bg-muted">
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* ---------------------------------------------------------------- more filters */

export type MoreFilterField =
  | { type: "range"; label: string; minKey: string; maxKey: string; prefix?: string; suffix?: string }
  | { type: "text"; label: string; key: string; placeholder?: string }
  | { type: "number"; label: string; key: string; suffix?: string }
  | { type: "date-range"; label: string; minKey: string; maxKey: string }
  | { type: "select"; label: string; key: string; options: { value: string; label: string }[] };

function fieldKeys(f: MoreFilterField): string[] {
  return "key" in f ? [f.key] : [f.minKey, f.maxKey];
}

export function MoreFilters({
  fields,
  values,
  onApply,
}: {
  fields: MoreFilterField[];
  values: Record<string, string | string[] | undefined>;
  onApply: (values: Record<string, string | null>) => void;
}) {
  const keys = fields.flatMap(fieldKeys);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const activeCount = fields.filter((f) => fieldKeys(f).some((k) => values[k])).length;

  useEffect(() => {
    if (open) setDraft(Object.fromEntries(keys.map((k) => [k, (values[k] as string) ?? ""])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const apply = () => {
    onApply(Object.fromEntries(keys.map((k) => [k, draft[k]?.trim() ? draft[k].trim() : null])));
    setOpen(false);
  };
  const reset = () => {
    onApply(Object.fromEntries(keys.map((k) => [k, null])));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" className={cn(activeCount > 0 && "border-accent/30 bg-accent-soft text-accent-ink")}>
          <SlidersHorizontal />
          Filters
          {activeCount > 0 && <span className="rounded bg-accent px-1 text-2xs font-semibold text-white">{activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="max-h-[60vh] space-y-3 overflow-y-auto p-3 scrollbar-thin">
            {fields.map((f) => (
              <div key={fieldKeys(f).join("-")}>
                <p className="mb-1 text-xs font-medium text-ink-2">{f.label}</p>
                {f.type === "range" && (
                  <div className="flex items-center gap-2">
                    <Input inputMode="decimal" placeholder={`Min${f.suffix ? ` ${f.suffix}` : ""}`} value={draft[f.minKey] ?? ""} onChange={(e) => set(f.minKey, e.target.value)} />
                    <span className="text-ink-3">–</span>
                    <Input inputMode="decimal" placeholder={`Max${f.suffix ? ` ${f.suffix}` : ""}`} value={draft[f.maxKey] ?? ""} onChange={(e) => set(f.maxKey, e.target.value)} />
                  </div>
                )}
                {f.type === "date-range" && (
                  <div className="flex items-center gap-2">
                    <Input type="date" value={draft[f.minKey] ?? ""} onChange={(e) => set(f.minKey, e.target.value)} />
                    <span className="text-ink-3">–</span>
                    <Input type="date" value={draft[f.maxKey] ?? ""} onChange={(e) => set(f.maxKey, e.target.value)} />
                  </div>
                )}
                {f.type === "text" && <Input placeholder={f.placeholder} value={draft[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />}
                {f.type === "number" && <Input inputMode="decimal" placeholder={f.suffix} value={draft[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} />}
                {f.type === "select" && (
                  <select
                    value={draft[f.key] ?? ""}
                    onChange={(e) => set(f.key, e.target.value)}
                    className="h-8 w-full rounded-md border border-line-strong/80 bg-surface px-2 text-sm focus:outline-none"
                  >
                    <option value="">Any</option>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between border-t border-line px-3 py-2">
            <Button variant="ghost" size="sm" onClick={reset}>
              Reset
            </Button>
            <Button variant="primary" size="sm" type="submit">
              Apply filters
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------------------------------------------------------- chips */

export interface FilterChip {
  key: string;
  label: string;
  value: string;
  onRemove: () => void;
}

export function FilterChips({ chips, onClear }: { chips: FilterChip[]; onClear: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span key={c.key} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface pl-2 pr-1 text-xs shadow-card">
          <span className="text-ink-3">{c.label}:</span>
          <span className="font-medium text-ink">{c.value}</span>
          <button onClick={c.onRemove} className="ml-0.5 rounded p-0.5 text-ink-3 hover:bg-muted hover:text-ink" aria-label={`Remove ${c.label} filter`}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <button onClick={onClear} className="h-6 rounded-md px-1.5 text-xs font-medium text-ink-2 hover:bg-muted hover:text-ink">
        Clear all
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- columns */

export function ColumnsMenu<T>({
  columns,
  hidden,
  onToggle,
  onReset,
}: {
  columns: Column<T>[];
  hidden: string[];
  onToggle: (id: string, visible: boolean) => void;
  onReset: () => void;
}) {
  const hideable = columns.filter((c) => c.hideable);
  if (hideable.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="secondary" size="icon" aria-label="Columns">
          <Columns3 />
        </Button>
      </MenuTrigger>
      <MenuContent width={210}>
        <MenuLabel>Visible columns</MenuLabel>
        {hideable.map((c) => (
          <MenuCheckItem key={c.id} checked={!hidden.includes(c.id)} onChange={(v) => onToggle(c.id, v)}>
            {c.header}
          </MenuCheckItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={onReset}>Reset to default</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/* ---------------------------------------------------------------- toolbar layout */

export function Toolbar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}
