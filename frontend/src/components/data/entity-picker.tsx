"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/misc";
import { useDebounce } from "@/hooks/use-debounce";
import { api, type Page } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Option {
  id: string;
  label: string;
  sublabel?: string;
}

/**
 * Async single-select for linking records (property, person, organization, user...).
 * `endpoint` must support `?q=` and return Page<T> (or T[] when `list` is true).
 */
export function EntityPicker<T extends { id: string }>({
  endpoint,
  value,
  onChange,
  toOption,
  placeholder = "Select…",
  list,
  disabled,
  className,
}: {
  endpoint: string;
  value: string | null | undefined;
  onChange: (id: string | null, item: T | null) => void;
  toOption: (item: T) => Option;
  placeholder?: string;
  list?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDebounce(query, 250);

  const results = useQuery({
    queryKey: ["picker", endpoint, q],
    queryFn: async () => {
      if (list) {
        const rows = await api.get<T[]>(endpoint);
        return rows.filter((r) => toOption(r).label.toLowerCase().includes(q.toLowerCase()));
      }
      return (await api.get<Page<T>>(endpoint, { q, page_size: 15 })).items;
    },
    enabled: open,
    staleTime: 30_000,
  });

  const selected = useQuery({
    queryKey: ["picker-item", endpoint, value],
    queryFn: async () => {
      if (list) return (await api.get<T[]>(endpoint)).find((r) => r.id === value) ?? null;
      return api.get<T>(`${endpoint}/${value}`);
    },
    enabled: !!value,
    staleTime: 5 * 60_000,
  });

  const current = selected.data ? toOption(selected.data) : null;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-left text-sm shadow-card",
            "hover:border-line-strong focus:border-accent/60 focus:outline-none focus:ring-[3px] focus:ring-accent/15 disabled:bg-subtle",
            className,
          )}
        >
          <span className={cn("flex-1 truncate", !current && "text-ink-3")}>{current?.label ?? (value ? "Loading…" : placeholder)}</span>
          {value && !disabled ? (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onChange(null, null);
              }}
              className="rounded p-0.5 text-ink-3 hover:bg-muted hover:text-ink"
            >
              <X className="size-3.5" />
            </span>
          ) : (
            <ChevronsUpDown className="size-3.5 text-ink-3" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[260px]">
        <div className="flex items-center gap-2 border-b border-line px-2.5">
          <Search className="size-4 text-ink-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-9 flex-1 bg-transparent text-sm placeholder:text-ink-3 focus:outline-none"
          />
          {results.isFetching && <Spinner className="size-3.5" />}
        </div>
        <div className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
          {results.data?.length === 0 && <p className="px-2 py-4 text-center text-xs text-ink-3">No matches</p>}
          {results.data?.map((item) => {
            const o = toOption(item);
            return (
              <button
                type="button"
                key={o.id}
                onClick={() => {
                  onChange(o.id, item);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{o.label}</p>
                  {o.sublabel && <p className="truncate text-xs text-ink-3">{o.sublabel}</p>}
                </div>
                {o.id === value && <Check className="size-4 text-ink" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* Ready-made pickers for shared master records. */

interface UserLite { id: string; full_name: string; email: string }
export function UserPicker(props: { value: string | null | undefined; onChange: (id: string | null) => void; placeholder?: string }) {
  return (
    <EntityPicker<UserLite>
      endpoint="/users/options"
      list
      value={props.value}
      onChange={(id) => props.onChange(id)}
      placeholder={props.placeholder ?? "Select user"}
      toOption={(u) => ({ id: u.id, label: u.full_name, sublabel: u.email })}
    />
  );
}

interface PropertyLite { id: string; name: string | null; address_line: string; city: string | null; state: string | null }
export function PropertyPicker(props: { value: string | null | undefined; onChange: (id: string | null, item: PropertyLite | null) => void; placeholder?: string }) {
  return (
    <EntityPicker<PropertyLite>
      endpoint="/properties"
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder ?? "Select property"}
      toOption={(p) => ({ id: p.id, label: p.name || p.address_line, sublabel: [p.address_line, p.city, p.state].filter(Boolean).join(", ") })}
    />
  );
}
