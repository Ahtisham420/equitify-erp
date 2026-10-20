"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, MoreHorizontal, Pencil, Plus, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { PropertyPicker } from "@/components/data/entity-picker";
import { FacetFilter, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { TableFooter } from "@/components/data/table-footer";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, formatRelative, titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";
import { downloadGeoJson, formatBbox, summarizeGeoJson } from "@/features/parcels/geojson";
import {
  RULE_LABELS,
  VISIBILITY_LABELS,
  useAddTerritoryMembers,
  useRecomputeTerritory,
  useRemoveTerritoryMember,
  useTerritory,
  useTerritoryOverlaps,
  type Corridor,
  type Node,
  type Overlap,
  type Territory,
  type TerritoryListItem,
  type TerritoryMember,
} from "@/features/territories/api";
import { TerritoryFormSheet } from "@/features/territories/territory-form";

function RuleSummary({ t }: { t: Territory }) {
  const r = t.rule as Record<string, unknown>;
  const corridor = useQuery({
    queryKey: ["corridors", "detail", r.corridor_id],
    queryFn: () => api.get<Corridor>(`/corridors/${r.corridor_id}`),
    enabled: t.rule_type === "corridor" && !!r.corridor_id,
  });
  const node = useQuery({
    queryKey: ["nodes", "detail", r.node_id],
    queryFn: () => api.get<Node>(`/nodes/${r.node_id}`),
    enabled: t.rule_type === "radius" && !!r.node_id,
  });

  let text: string;
  switch (t.rule_type) {
    case "boundary":
      text = "Properties located inside the drawn boundary.";
      break;
    case "radius":
      text = `Within ${formatNumber(Number(r.radius_miles), 2)} mi of ${
        r.node_id ? node.data?.name ?? "a node" : r.property_id ? "a property" : `${r.lat}, ${r.lng}`
      }.`;
      break;
    case "corridor":
      text = `Within ${formatNumber(Number(r.buffer_ft))} ft of ${corridor.data?.name ?? "the corridor"}.`;
      break;
    case "county":
    case "city":
      text = `${titleCase(t.rule_type)} is ${((r.values as string[]) ?? []).join(", ")}${r.state ? ` (${r.state})` : ""}.`;
      break;
    case "saved_query":
      text = `Matches the saved property view “${String(r.saved_view_name ?? "saved view")}”.`;
      break;
    default:
      text = "Members are assigned manually.";
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="text-ink">{text}</p>
      {r.property_id ? (
        <Link href={`/properties/${String(r.property_id)}`} className="text-xs text-accent hover:underline">
          View center property
        </Link>
      ) : null}
      <p className="text-xs text-ink-3">Manual members are kept when the rule is recomputed.</p>
    </div>
  );
}

function Members({ t }: { t: Territory }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const key = `territory-members-${t.id}`;
  const list = useListQuery<TerritoryMember>(key, `/territories/${t.id}/members`);
  const { url } = list;
  const remove = useRemoveTerritoryMember(t.id);
  const add = useAddTerritoryMembers();
  const [adding, setAdding] = useState(false);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const editable = t.can_edit && can("territories", "edit");

  const refresh = () => qc.invalidateQueries({ queryKey: [key] });

  const columns: Column<TerritoryMember & { id: string }>[] = [
    {
      id: "property",
      header: "Property",
      sortKey: "address_line",
      cell: (m) => (
        <div className="min-w-[220px]">
          <p className="truncate font-medium text-ink">{m.name || m.address_line}</p>
          <p className="truncate text-xs text-ink-3">{[m.name ? m.address_line : null, m.city, m.state].filter(Boolean).join(", ") || "—"}</p>
        </div>
      ),
    },
    { id: "type", header: "Type", cell: (m) => <span className="text-ink-2">{PROPERTY_TYPE_LABELS[m.property_type] ?? titleCase(m.property_type)}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (m) => <StatusBadge status={m.status} /> },
    { id: "county", header: "County", cell: (m) => <span className="text-ink-2">{m.county ?? "—"}</span> },
    { id: "source", header: "Source", sortKey: "source", cell: (m) => <Badge tone={m.source === "manual" ? "blue" : "outline"}>{m.source === "manual" ? "Manual" : "Rule"}</Badge> },
    { id: "added", header: "Added", sortKey: "added_at", cell: (m) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(m.added_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (m) =>
        editable ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Remove from territory"
            onClick={() =>
              remove.mutate(m.property_id, {
                onSuccess: () => {
                  toast.success(m.source === "rule" ? "Removed — the rule may add it back on recompute" : "Removed from territory");
                  refresh();
                },
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            <X />
          </Button>
        ) : null,
    },
  ];

  const submitAdd = () => {
    if (!propertyId) return;
    add.mutate(
      { territoryId: t.id, property_ids: [propertyId] },
      {
        onSuccess: () => {
          toast.success("Property added");
          setAdding(false);
          setPropertyId(null);
          refresh();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <div className="space-y-3">
      <Toolbar
        right={
          editable && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add property
            </Button>
          )
        }
      >
        <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search member properties…" />
        <FacetFilter
          label="Source"
          options={[
            { value: "rule", label: "Rule" },
            { value: "manual", label: "Manual" },
          ]}
          selected={url.getAll("source")}
          onChange={(v) => url.set({ source: v })}
        />
      </Toolbar>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        <DataTable
          columns={columns}
          data={list.data?.items.map((m) => ({ ...m, id: m.property_id }))}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowHref={(m) => `/properties/${m.property_id}`}
          empty={
            <EmptyState
              title={url.get("q") || url.getAll("source").length ? "No members match" : "No member properties"}
              description={t.rule_type === "explicit" ? "Add properties manually or assign them from the parcel or property lists." : "Recompute the rule, or check that properties have coordinates and matching fields."}
            />
          }
        />
        <TableFooter
          page={list.page}
          pageSize={list.pageSize}
          total={list.data?.total ?? 0}
          onPage={(page) => url.set({ page }, { resetPage: false })}
          onPageSize={(size) => url.set({ page_size: size })}
        />
      </div>
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add property to territory"
        description="Manual members stay in the territory regardless of the rule."
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" disabled={!propertyId} loading={add.isPending} onClick={submitAdd}>
              Add
            </Button>
          </>
        }
      >
        <Field label="Property">
          <PropertyPicker value={propertyId} onChange={(id) => setPropertyId(id)} />
        </Field>
      </Dialog>
    </div>
  );
}

function Structure({ t, onAddChild }: { t: Territory; onAddChild: () => void }) {
  const { can } = useAuth();
  const overlaps = useTerritoryOverlaps(t.id);
  const overlapCols: Column<Overlap>[] = [
    { id: "name", header: "Territory", cell: (o) => <span className="font-medium">{o.name}</span> },
    { id: "rule", header: "Rule", cell: (o) => <Badge tone="outline">{RULE_LABELS[o.rule_type] ?? o.rule_type}</Badge> },
    { id: "shared", header: "Shared properties", align: "right", cell: (o) => formatNumber(o.shared) },
  ];
  const childCols: Column<TerritoryListItem>[] = [
    { id: "name", header: "Sub-territory", cell: (c) => <span className="font-medium">{c.name}</span> },
    { id: "rule", header: "Rule", cell: (c) => <Badge tone="outline">{RULE_LABELS[c.rule_type] ?? c.rule_type}</Badge> },
    { id: "members", header: "Members", align: "right", cell: (c) => formatNumber(c.member_count) },
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="overflow-hidden">
        <CardHeader
          title="Nested territories"
          description={t.parent_id ? (
            <>
              Inside <Link href={`/territories/${t.parent_id}`} className="text-accent hover:underline">{t.parent_name ?? "parent"}</Link>
            </>
          ) : "Top-level territory"}
          actions={
            can("territories", "create") && (
              <Button size="sm" onClick={onAddChild}>
                <Plus /> Sub-territory
              </Button>
            )
          }
        />
        <DataTable columns={childCols} data={t.children} dense rowHref={(c) => `/territories/${c.id}`} empty={<EmptyState title="No sub-territories" />} />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Overlapping territories" description="Visible territories that share member properties" />
        <DataTable
          columns={overlapCols}
          data={overlaps.data}
          loading={overlaps.isLoading}
          dense
          rowHref={(o) => `/territories/${o.id}`}
          empty={<EmptyState title="No overlaps" />}
        />
      </Card>
    </div>
  );
}

function TerritoryDetail({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: t, isLoading, error } = useTerritory(id);
  const recompute = useRecomputeTerritory(id);
  const [editing, setEditing] = useState(false);
  const [creatingChild, setCreatingChild] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const tab = url.get("tab") ?? "members";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !t) {
    return <EmptyState title="Territory not found" description={errorMessage(error)} action={<Link href="/territories"><Button>Back to territories</Button></Link>} />;
  }

  const summary = summarizeGeoJson(t.geojson);
  const editable = t.can_edit && can("territories", "edit");

  const runRecompute = () =>
    recompute.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(`${r.total} members (+${r.added} / −${r.removed})`);
        qc.invalidateQueries({ queryKey: [`territory-members-${id}`] });
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const archive = async () => {
    try {
      await api.delete(`/territories/${id}`);
      toast.success("Territory archived");
      router.replace("/territories");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Territories", href: "/territories" },
          ...(t.parent_id ? [{ label: t.parent_name ?? "Parent", href: `/territories/${t.parent_id}` }] : []),
          { label: t.name },
        ]}
        title={t.name}
        description={t.description ?? undefined}
        meta={
          <>
            <Badge tone="outline">{RULE_LABELS[t.rule_type] ?? t.rule_type}</Badge>
            <Badge tone={t.visibility === "company" ? "green" : t.visibility === "role" ? "sky" : "neutral"}>{VISIBILITY_LABELS[t.visibility] ?? t.visibility}</Badge>
            <span className="text-xs text-ink-3 tabular">{formatNumber(t.member_count)} members</span>
            <span className="text-xs text-ink-3">· recomputed {formatRelative(t.last_computed_at)}</span>
          </>
        }
        actions={
          editable && (
            <>
              <Button onClick={runRecompute} loading={recompute.isPending}>
                <RefreshCw />
                Recompute
              </Button>
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
              {can("territories", "delete") && (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon" aria-label="More actions">
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                      Archive territory
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </>
          )
        }
      />

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "members" ? null : v, q: null, source: null, sort: null })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "members", label: "Members", count: t.member_count },
            { value: "rule", label: "Rule & shape" },
            { value: "structure", label: "Nesting & overlap", count: t.children.length || undefined },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="members">
          <Members t={t} />
        </TabPanel>
        <TabPanel value="rule">
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Membership rule" />
              <CardBody>
                <RuleSummary t={t} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader
                title="Shape"
                actions={
                  t.geojson ? (
                    <Button size="xs" onClick={() => downloadGeoJson({ type: "Feature", geometry: t.geojson, properties: { id: t.id, name: t.name } }, `territory-${t.id}.geojson`)}>
                      <Download className="!size-3.5" /> GeoJSON
                    </Button>
                  ) : undefined
                }
              />
              <CardBody>
                {summary ? (
                  <FieldGrid cols={1}>
                    <FieldItem label="Type">{summary.types.join(", ")}</FieldItem>
                    <FieldItem label="Vertices">{formatNumber(summary.vertices)}</FieldItem>
                    <FieldItem label="Bounding box">
                      <span className="font-mono text-xs">{formatBbox(summary.bbox)}</span>
                    </FieldItem>
                  </FieldGrid>
                ) : (
                  <p className="text-sm text-ink-3">This rule type has no shape.</p>
                )}
              </CardBody>
            </Card>
            <Card className="lg:col-span-3">
              <CardHeader title="Access & routing" />
              <CardBody>
                <FieldGrid cols={3}>
                  <FieldItem label="Visibility">{VISIBILITY_LABELS[t.visibility]}</FieldItem>
                  <FieldItem label="Allowed roles">{t.visibility === "role" ? t.allowed_roles.map(titleCase).join(", ") : null}</FieldItem>
                  <FieldItem label="Owner">{t.owner_name}</FieldItem>
                  <FieldItem label="Default assignee">{t.assignee_name}</FieldItem>
                  <FieldItem label="Created">{formatDateTime(t.created_at)}</FieldItem>
                  <FieldItem label="Last recomputed">{formatDateTime(t.last_computed_at)}</FieldItem>
                </FieldGrid>
              </CardBody>
            </Card>
          </div>
        </TabPanel>
        <TabPanel value="structure">
          <Structure t={t} onAddChild={() => setCreatingChild(true)} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="territory" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <TerritoryFormSheet open={editing} onOpenChange={setEditing} territory={t} />
      <TerritoryFormSheet open={creatingChild} onOpenChange={setCreatingChild} defaultParentId={t.id} onSaved={(c) => router.push(`/territories/${c.id}`)} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this territory?"
        description="Sub-territories move up to this territory's parent. History is retained."
        confirmLabel="Archive"
        destructive
        onConfirm={archive}
      />
    </>
  );
}

export default function TerritoryPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <TerritoryDetail id={params.id} />
    </Suspense>
  );
}
