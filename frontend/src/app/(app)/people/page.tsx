"use client";

import { useQuery } from "@tanstack/react-query";
import { BookUser, Download, GitMerge, Lock, MoreHorizontal, Plus, Tag, UserCog } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { UserPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import { RESPONSIVENESS, ROLE_LABELS, ROLES, STRENGTH_TONE, STRENGTHS, useBulkContacts, type PeopleFacets, type PersonListItem } from "@/features/contacts/api";
import { DuplicateReviewSheet } from "@/features/contacts/duplicate-review";
import { PersonFormSheet } from "@/features/contacts/person-form";

const MORE: MoreFilterField[] = [
  { type: "select", label: "Next action", key: "has_next_action", options: [{ value: "true", label: "Has a next action" }, { value: "false", label: "No next action" }] },
  { type: "select", label: "Overdue", key: "overdue", options: [{ value: "true", label: "Next action overdue" }] },
  { type: "text", label: "Not touched since", key: "touched_before", placeholder: "YYYY-MM-DD" },
  { type: "text", label: "Tag", key: "tag" },
];
const CHIP_LABELS: Record<string, string> = { has_next_action: "Next action", overdue: "Overdue", touched_before: "Not touched since", tag: "Tag" };

const columns: Column<PersonListItem>[] = [
  {
    id: "name",
    header: "Name",
    sortKey: "full_name",
    cell: (p) => (
      <div className="min-w-[200px] max-w-[300px]">
        <p className="truncate font-medium text-ink">{p.full_name}</p>
        <p className="truncate text-xs text-ink-3">{[p.title, p.organization_name].filter(Boolean).join(" · ") || "—"}</p>
      </div>
    ),
  },
  {
    id: "roles",
    header: "Roles",
    hideable: true,
    cell: (p) =>
      p.roles.length ? (
        <div className="flex flex-wrap gap-1">
          {p.roles.slice(0, 3).map((r) => (
            <Badge key={r} tone="outline">{ROLE_LABELS[r] ?? r}</Badge>
          ))}
        </div>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  {
    id: "email",
    header: "Email",
    hideable: true,
    cell: (p) => (
      <span className="flex items-center gap-1 font-mono text-xs text-ink-2">
        {p.primary_email ?? "—"}
        {p.masked && p.primary_email && <Lock className="size-3 text-ink-3" />}
      </span>
    ),
  },
  { id: "phone", header: "Phone", hideable: true, cell: (p) => <span className="whitespace-nowrap font-mono text-xs text-ink-2">{p.primary_phone ?? "—"}</span> },
  { id: "location", header: "Location", sortKey: "state", hideable: true, cell: (p) => <span className="text-ink-2">{[p.city, p.state].filter(Boolean).join(", ") || "—"}</span> },
  {
    id: "strength",
    header: "Relationship",
    sortKey: "relationship_strength",
    hideable: true,
    cell: (p) => <Badge tone={STRENGTH_TONE[p.relationship_strength] ?? "neutral"} dot>{titleCase(p.relationship_strength)}</Badge>,
  },
  { id: "last_touch", header: "Last touch", sortKey: "last_touch_at", hideable: true, cell: (p) => <span className="whitespace-nowrap text-xs text-ink-2">{formatRelative(p.last_touch_at)}</span> },
  {
    id: "next",
    header: "Next action",
    sortKey: "next_action_at",
    hideable: true,
    cell: (p) => <span className={cn("whitespace-nowrap text-xs", isOverdue(p.next_action_at) ? "font-medium text-negative" : "text-ink-2")}>{formatRelative(p.next_action_at)}</span>,
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (p) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(p.updated_at)}</span> },
];

function PeopleView() {
  const { can } = useAuth();
  const list = useListQuery<PersonListItem>("people", "/people");
  const { url } = list;
  const cols = useColumnVisibility("people", columns);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerValue, setOwnerValue] = useState<string | null>(null);
  const bulk = useBulkContacts("person");

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["people", "facets", filterParams],
    queryFn: () => api.get<PeopleFacets>("/people/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({
      key: k,
      label,
      value: k === "has_next_action" ? (url.get(k) === "true" ? "Yes" : "No") : k === "overdue" ? "Yes" : url.get(k)!,
      onRemove: () => url.set({ [k]: null }),
    }));
  for (const [key, label] of [["role", "Role"], ["relationship_strength", "Relationship"], ["responsiveness", "Responsiveness"], ["state", "State"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => (key === "role" ? ROLE_LABELS[v] ?? v : key === "state" ? v : titleCase(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const runBulk = (body: { owner_id?: string; relationship_strength?: string; add_tags?: string[] }) =>
    bulk.mutate(
      { ids: selected, ...body },
      {
        onSuccess: (r) => {
          toast.success(`${r.updated} people updated`);
          setSelected([]);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const exportCsv = async () => {
    try {
      await api.download("/people/export", filterParams, "people.csv");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const opts = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="People"
        description="One shared relationship database for owners, principals, brokers, tenants, lenders, attorneys and other counterparties."
        actions={
          <>
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<GitMerge />} onSelect={() => setDupesOpen(true)}>Review duplicates</MenuItem>
                {can("contacts", "export") && <MenuItem icon={<Download />} onSelect={exportCsv}>Export CSV</MenuItem>}
              </MenuContent>
            </Menu>
            {can("contacts", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New person
              </Button>
            )}
          </>
        }
      />

      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="contacts" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search name, title, city…" />
              <FacetFilter label="Role" options={opts(facets?.role, ROLES, (v) => ROLE_LABELS[v])} selected={url.getAll("role")} onChange={(v) => url.set({ role: v })} />
              <FacetFilter label="Relationship" options={opts(facets?.relationship_strength, STRENGTHS, titleCase)} selected={url.getAll("relationship_strength")} onChange={(v) => url.set({ relationship_strength: v })} />
              <FacetFilter label="Responsiveness" options={opts(facets?.responsiveness, RESPONSIVENESS, titleCase)} selected={url.getAll("responsiveness")} onChange={(v) => url.set({ responsiveness: v })} />
              <FacetFilter
                label="State"
                searchable
                options={Object.entries(facets?.state ?? {}).sort().map(([v, c]) => ({ value: v, label: v, count: c }))}
                selected={url.getAll("state")}
                onChange={(v) => url.set({ state: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={
          <TableFooter
            page={list.page}
            pageSize={list.pageSize}
            total={list.data?.total ?? 0}
            onPage={(page) => url.set({ page }, { resetPage: false })}
            onPageSize={(size) => url.set({ page_size: size })}
          />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          selectable={can("contacts", "edit")}
          selected={selected}
          onSelectedChange={setSelected}
          rowHref={(p) => `/people/${p.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<BookUser />}
              title={filtered ? "No people match these filters" : "No people yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Add a contact manually or import a list."}
              action={
                can("contacts", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New person
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <BulkButton icon={<UserCog />} onClick={() => setOwnerOpen(true)}>Assign owner</BulkButton>
        <Menu>
          <MenuTrigger asChild>
            <BulkButton>Set relationship</BulkButton>
          </MenuTrigger>
          <MenuContent align="center">
            {STRENGTHS.map((s) => (
              <MenuItem key={s} onSelect={() => runBulk({ relationship_strength: s })}>{titleCase(s)}</MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <BulkButton icon={<Tag />} onClick={() => setTagOpen(true)}>Add tag</BulkButton>
      </BulkBar>

      <Dialog
        open={tagOpen}
        onOpenChange={setTagOpen}
        title={`Tag ${selected.length} people`}
        footer={
          <>
            <Button onClick={() => setTagOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!tagValue.trim()}
              loading={bulk.isPending}
              onClick={() => {
                runBulk({ add_tags: tagValue.split(",").map((t) => t.trim()).filter(Boolean) });
                setTagOpen(false);
                setTagValue("");
              }}
            >
              Add tag
            </Button>
          </>
        }
      >
        <Input autoFocus value={tagValue} onChange={(e) => setTagValue(e.target.value)} placeholder="e.g. owner-outreach, 1031" />
      </Dialog>

      <Dialog
        open={ownerOpen}
        onOpenChange={setOwnerOpen}
        title={`Assign relationship owner for ${selected.length} people`}
        footer={
          <>
            <Button onClick={() => setOwnerOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!ownerValue}
              loading={bulk.isPending}
              onClick={() => {
                if (ownerValue) runBulk({ owner_id: ownerValue });
                setOwnerOpen(false);
                setOwnerValue(null);
              }}
            >
              Assign
            </Button>
          </>
        }
      >
        <UserPicker value={ownerValue} onChange={setOwnerValue} />
      </Dialog>

      <PersonFormSheet open={creating} onOpenChange={setCreating} />
      <DuplicateReviewSheet kind="person" open={dupesOpen} onOpenChange={setDupesOpen} />
    </>
  );
}

export default function PeoplePage() {
  return (
    <Suspense>
      <PeopleView />
    </Suspense>
  );
}
