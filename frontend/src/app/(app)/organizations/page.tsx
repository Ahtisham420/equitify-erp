"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, Download, GitMerge, MoreHorizontal, Plus, Tag, UserCog } from "lucide-react";
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
import { cn, formatNumber, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import { ORG_TYPE_LABELS, ORG_TYPES, STRENGTH_TONE, STRENGTHS, useBulkContacts, type OrganizationFacets, type OrganizationListItem } from "@/features/contacts/api";
import { DuplicateReviewSheet } from "@/features/contacts/duplicate-review";
import { OrganizationFormSheet } from "@/features/contacts/organization-form";

const MORE: MoreFilterField[] = [
  { type: "select", label: "Next action", key: "has_next_action", options: [{ value: "true", label: "Has a next action" }, { value: "false", label: "No next action" }] },
  { type: "text", label: "Tag", key: "tag" },
];
const CHIP_LABELS: Record<string, string> = { has_next_action: "Next action", tag: "Tag" };

const columns: Column<OrganizationListItem>[] = [
  {
    id: "name",
    header: "Organization",
    sortKey: "name",
    cell: (o) => (
      <div className="min-w-[220px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{o.name}</p>
        <p className="truncate text-xs text-ink-3">{o.legal_name && o.legal_name !== o.name ? o.legal_name : o.domain ?? "—"}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", sortKey: "org_type", hideable: true, cell: (o) => <span className="text-ink-2">{ORG_TYPE_LABELS[o.org_type] ?? titleCase(o.org_type)}</span> },
  { id: "location", header: "Location", sortKey: "state", hideable: true, cell: (o) => <span className="text-ink-2">{[o.city, o.state].filter(Boolean).join(", ") || "—"}</span> },
  { id: "phone", header: "Phone", hideable: true, defaultHidden: true, cell: (o) => <span className="whitespace-nowrap font-mono text-xs text-ink-2">{o.phone ?? "—"}</span> },
  { id: "domain", header: "Domain", hideable: true, defaultHidden: true, cell: (o) => <span className="text-xs text-ink-2">{o.domain ?? "—"}</span> },
  { id: "members", header: "People", align: "right", hideable: true, cell: (o) => formatNumber(o.member_count) },
  { id: "strength", header: "Relationship", hideable: true, cell: (o) => <Badge tone={STRENGTH_TONE[o.relationship_strength] ?? "neutral"} dot>{titleCase(o.relationship_strength)}</Badge> },
  { id: "last_touch", header: "Last touch", sortKey: "last_touch_at", hideable: true, cell: (o) => <span className="whitespace-nowrap text-xs text-ink-2">{formatRelative(o.last_touch_at)}</span> },
  {
    id: "next",
    header: "Next action",
    sortKey: "next_action_at",
    hideable: true,
    cell: (o) => <span className={cn("whitespace-nowrap text-xs", isOverdue(o.next_action_at) ? "font-medium text-negative" : "text-ink-2")}>{formatRelative(o.next_action_at)}</span>,
  },
];

function OrganizationsView() {
  const { can } = useAuth();
  const list = useListQuery<OrganizationListItem>("organizations", "/organizations");
  const { url } = list;
  const cols = useColumnVisibility("organizations", columns);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerValue, setOwnerValue] = useState<string | null>(null);
  const bulk = useBulkContacts("organization");

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["organizations", "facets", filterParams],
    queryFn: () => api.get<OrganizationFacets>("/organizations/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({
      key: k,
      label,
      value: k === "has_next_action" ? (url.get(k) === "true" ? "Yes" : "No") : url.get(k)!,
      onRemove: () => url.set({ [k]: null }),
    }));
  for (const [key, label] of [["org_type", "Type"], ["relationship_strength", "Relationship"], ["state", "State"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => (key === "org_type" ? ORG_TYPE_LABELS[v] ?? v : key === "state" ? v : titleCase(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const runBulk = (body: { owner_id?: string; relationship_strength?: string; add_tags?: string[] }) =>
    bulk.mutate(
      { ids: selected, ...body },
      {
        onSuccess: (r) => {
          toast.success(`${r.updated} organizations updated`);
          setSelected([]);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const exportCsv = async () => {
    try {
      await api.download("/organizations/export", filterParams, "organizations.csv");
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
        title="Organizations"
        description="Owner entities, brokerages, lenders, law and title firms, tenants, vendors and capital partners."
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
                <Plus /> New organization
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
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search name, domain, agent, city…" />
              <FacetFilter label="Type" options={opts(facets?.org_type, ORG_TYPES, (v) => ORG_TYPE_LABELS[v])} selected={url.getAll("org_type")} onChange={(v) => url.set({ org_type: v })} />
              <FacetFilter label="Relationship" options={opts(facets?.relationship_strength, STRENGTHS, titleCase)} selected={url.getAll("relationship_strength")} onChange={(v) => url.set({ relationship_strength: v })} />
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
          rowHref={(o) => `/organizations/${o.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Building2 />}
              title={filtered ? "No organizations match these filters" : "No organizations yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Add an organization manually or import a list."}
              action={
                can("contacts", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New organization
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
        title={`Tag ${selected.length} organizations`}
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
        <Input autoFocus value={tagValue} onChange={(e) => setTagValue(e.target.value)} placeholder="e.g. institutional, repeat-seller" />
      </Dialog>

      <Dialog
        open={ownerOpen}
        onOpenChange={setOwnerOpen}
        title={`Assign relationship owner for ${selected.length} organizations`}
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

      <OrganizationFormSheet open={creating} onOpenChange={setCreating} />
      <DuplicateReviewSheet kind="organization" open={dupesOpen} onOpenChange={setDupesOpen} />
    </>
  );
}

export default function OrganizationsPage() {
  return (
    <Suspense>
      <OrganizationsView />
    </Suspense>
  );
}
