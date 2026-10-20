"use client";

import * as D from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { ArrowRight, Building2, FileText, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Kbd, Spinner } from "@/components/ui/misc";
import { useDebounce } from "@/hooks/use-debounce";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { NAV } from "@/lib/nav";
import { titleCase } from "@/lib/utils";

export interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

const itemCls =
  "flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2 text-sm text-ink data-[selected=true]:bg-muted [&_svg]:size-4 [&_svg]:text-ink-3";

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { can } = useAuth();
  const [query, setQuery] = useState("");
  const q = useDebounce(query.trim(), 200);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  const { data: hits = [], isFetching } = useQuery({
    queryKey: ["global-search", q],
    queryFn: () => api.get<SearchHit[]>("/search", { q, limit: 20 }),
    enabled: open && q.length >= 2,
    staleTime: 15_000,
  });

  const go = (href: string) => {
    onOpenChange(false);
    setQuery("");
    router.push(href);
  };

  const pages = NAV.flatMap((g) => g.items).filter((i) => !i.module || can(i.module));
  const grouped = hits.reduce<Record<string, SearchHit[]>>((acc, h) => {
    (acc[h.type] ??= []).push(h);
    return acc;
  }, {});

  return (
    <D.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setQuery(""); }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink/25 animate-fade-in" />
        <D.Content className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-pop animate-pop-in">
          <D.Title className="sr-only">Search</D.Title>
          <D.Description className="sr-only">Search records or jump to a page</D.Description>
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="size-4 text-ink-3" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search properties, people, owners, deals…"
                className="h-12 flex-1 bg-transparent text-[15px] placeholder:text-ink-3 focus:outline-none"
              />
              {isFetching ? <Spinner className="size-3.5" /> : <Kbd>esc</Kbd>}
            </div>
            <Command.List className="max-h-[420px] overflow-y-auto p-1.5 scrollbar-thin">
              {q.length >= 2 && !isFetching && hits.length === 0 && (
                <Command.Empty className="px-3 py-8 text-center text-sm text-ink-3">No records match “{q}”</Command.Empty>
              )}
              {Object.entries(grouped).map(([type, items]) => (
                <Command.Group key={type} heading={titleCase(type)} className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
                  {items.map((h) => (
                    <Command.Item key={`${h.type}-${h.id}`} value={`${h.type}-${h.id}`} onSelect={() => go(h.href)} className={itemCls}>
                      {h.type === "property" ? <Building2 /> : <FileText />}
                      <span className="truncate">{h.title}</span>
                      {h.subtitle && <span className="ml-auto max-w-[45%] truncate text-xs text-ink-3">{h.subtitle}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              {q.length < 2 && (
                <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
                  {pages
                    .filter((p) => p.label.toLowerCase().includes(query.toLowerCase()))
                    .map((p) => (
                      <Command.Item key={p.href} value={p.href} onSelect={() => go(p.href)} className={itemCls}>
                        <p.icon />
                        <span>{p.label}</span>
                        <ArrowRight className="ml-auto opacity-0 [[data-selected=true]_&]:opacity-100" />
                      </Command.Item>
                    ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
