"use client";

import { Archive, Download, ExternalLink, GitMerge, MoreHorizontal, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker } from "@/components/data/entity-picker";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { ConfidencePill, ProvenanceDot } from "@/components/data/provenance";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, formatNumber, titleCase } from "@/lib/utils";

import type { Observation } from "@/features/properties/api";
import {
  parcelTitle,
  useAdjacentParcels,
  useAssemblage,
  useMergeParcel,
  useParcel,
  useParcelHistory,
  useParcelProperties,
  useParcelVersions,
  type AdjacentParcel,
  type OwnerRef,
  type Parcel,
  type ParcelListItem,
  type ParcelVersion,
} from "@/features/parcels/api";
import { downloadGeoJson, formatBbox, summarizeGeoJson } from "@/features/parcels/geojson";
import { ParcelFormSheet } from "@/features/parcels/parcel-form";

function ownerHref(o: OwnerRef) {
  return o.kind === "person" ? `/people/${o.id}` : `/organizations/${o.id}`;
}

function OwnerLinks({ owners }: { owners: OwnerRef[] }) {
  if (!owners.length) return <span className="text-ink-3">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {owners.map((o) => (
        <Link key={`${o.kind}-${o.id}`} href={ownerHref(o)} className="text-accent hover:underline">
          {o.name ?? titleCase(o.kind)}
        </Link>
      ))}
    </span>
  );
}

function Overview({ p }: { p: Parcel }) {
  const prov = (field: string) => <ProvenanceDot obs={p.provenance[field]} />;
  const summary = summarizeGeoJson(p.geojson);
  const { data: linked, isLoading } = useParcelProperties(p.id);
  const facts = Object.entries(p.facts ?? {}).filter(([k]) => k !== "merged_into");

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Parcel facts" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="County">{p.county}</FieldItem>
              <FieldItem label="State">{p.state}</FieldItem>
              <FieldItem label="APN" extra={prov("apn")}>
                <span className="font-mono">{p.apn}</span>
              </FieldItem>
              <FieldItem label="Normalized APN">
                <span className="font-mono text-ink-2">{p.apn_normalized}</span>
              </FieldItem>
              <FieldItem label="Situs address">{p.situs_address}</FieldItem>
              <FieldItem label="Acreage" extra={prov("acreage")}>{p.acreage != null ? `${formatNumber(p.acreage, 4)} ac` : null}</FieldItem>
              <FieldItem label="Source">{p.source}</FieldItem>
              <FieldItem label="Observed">{p.observed_on ? formatDate(p.observed_on) : null}</FieldItem>
              {facts.map(([k, v]) => (
                <FieldItem key={k} label={titleCase(k)}>
                  {typeof v === "number" ? formatNumber(v, 2) : typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}
                </FieldItem>
              ))}
            </FieldGrid>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Legal description" actions={prov("legal_description")} />
          <CardBody>
            {p.legal_description ? (
              <p className="whitespace-pre-wrap text-sm text-ink-2">{p.legal_description}</p>
            ) : (
              <p className="text-sm text-ink-3">No legal description recorded.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Linked properties" description="A parcel can belong to several properties (assemblages, multi-parcel sites)." />
          {isLoading ? (
            <CardBody>
              <Skeleton className="h-10 w-full" />
            </CardBody>
          ) : linked && linked.length ? (
            <ul className="divide-y divide-line">
              {linked.map((l) => (
                <li key={l.link_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <Link href={`/properties/${l.property_id}`} className="truncate text-sm font-medium text-ink hover:text-accent">
                      {l.name || l.address_line}
                    </Link>
                    <p className="truncate text-xs text-ink-3">{[l.address_line, l.city, l.state].filter(Boolean).join(", ")}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone="outline">{titleCase(l.relationship)}</Badge>
                    <StatusBadge status={l.status} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Not linked to a property" description="Select this parcel in the parcel list and use “Associate to property”." />
          )}
        </Card>

        {p.notes && (
          <Card>
            <CardHeader title="Notes" />
            <CardBody>
              <p className="whitespace-pre-wrap text-sm text-ink-2">{p.notes}</p>
            </CardBody>
          </Card>
        )}
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Geometry"
            description="PostGIS is the source of truth"
            actions={
              p.geojson ? (
                <Button size="xs" onClick={() => downloadGeoJson({ type: "Feature", geometry: p.geojson, properties: { id: p.id, apn: p.apn, county: p.county } }, `parcel-${p.apn_normalized}.geojson`)}>
                  <Download className="!size-3.5" /> GeoJSON
                </Button>
              ) : undefined
            }
          />
          <CardBody>
            {summary ? (
              <FieldGrid cols={1}>
                <FieldItem label="Type">{summary.types.join(", ")}</FieldItem>
                <FieldItem label="Parts / vertices">
                  <span className="tabular">
                    {formatNumber(summary.parts)} / {formatNumber(summary.vertices)}
                  </span>
                </FieldItem>
                <FieldItem label="Calculated area">{p.geometry_acreage != null ? `${formatNumber(p.geometry_acreage, 4)} ac` : null}</FieldItem>
                <FieldItem label="Centroid">
                  {p.centroid_lat != null && p.centroid_lng != null ? (
                    <a
                      href={`https://www.google.com/maps?q=${p.centroid_lat},${p.centroid_lng}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 tabular text-accent hover:underline"
                    >
                      {p.centroid_lat.toFixed(6)}, {p.centroid_lng.toFixed(6)} <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </FieldItem>
                <FieldItem label="Bounding box">
                  <span className="font-mono text-xs">{formatBbox(summary.bbox)}</span>
                </FieldItem>
              </FieldGrid>
            ) : (
              <div className="rounded-md border border-caution/30 bg-caution-soft px-3 py-2 text-sm text-caution">
                Geometry missing. Parcel geometry is a first-release data requirement — edit the parcel to paste its GeoJSON.
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Record" />
          <CardBody>
            <FieldGrid cols={1}>
              <FieldItem label="Created">{formatDateTime(p.created_at)}</FieldItem>
              <FieldItem label="Last updated">{formatDateTime(p.updated_at)}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Neighbors({ p }: { p: Parcel }) {
  const adjacent = useAdjacentParcels(p.id, p.has_geometry);
  const assemblage = useAssemblage(p.id);

  const columns: Column<AdjacentParcel>[] = [
    {
      id: "apn",
      header: "APN",
      cell: (a) => (
        <div>
          <p className="font-mono text-[13px] font-medium">{a.apn}</p>
          <p className="text-xs text-ink-3">{a.situs_address ?? a.county}</p>
        </div>
      ),
    },
    { id: "acres", header: "Acres", align: "right", cell: (a) => formatNumber(a.acreage, 2) },
    { id: "relation", header: "Relation", cell: (a) => (a.touches ? <Badge tone="blue">Shares boundary</Badge> : <Badge tone="outline">{formatNumber(a.distance_m, 1)} m gap</Badge>) },
    {
      id: "owners",
      header: "Common owner",
      cell: (a) => (a.shared_owners.length ? <OwnerLinks owners={a.shared_owners} /> : <span className="text-ink-3">—</span>),
    },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="overflow-hidden lg:col-span-2">
        <CardHeader title="Adjacent parcels" description="Parcels touching or within 1 m of this parcel" />
        {!p.has_geometry ? (
          <EmptyState title="No geometry" description="Adjacency is computed from parcel geometry." />
        ) : (
          <DataTable
            columns={columns}
            data={adjacent.data?.items}
            loading={adjacent.isLoading}
            dense
            rowHref={(a) => `/parcels/${a.id}`}
            empty={<EmptyState title="No adjacent parcels on file" description="Neighbouring parcels appear once their geometry is loaded." />}
          />
        )}
        {adjacent.data?.owners_hidden && <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Ownership columns require ownership view permission.</p>}
      </Card>

      <Card>
        <CardHeader title="Common ownership & assemblage" description="Contiguous parcels sharing a current owner" />
        <CardBody className="space-y-4">
          {assemblage.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : assemblage.data?.owners_hidden ? (
            <p className="text-sm text-ink-3">You do not have permission to view ownership.</p>
          ) : !assemblage.data?.ownership_available ? (
            <p className="text-sm text-ink-3">Ownership records are not available yet.</p>
          ) : !assemblage.data.owners.length ? (
            <p className="text-sm text-ink-3">No current owner is recorded on the properties linked to this parcel.</p>
          ) : (
            <>
              <div>
                <p className="mb-1 text-xs text-ink-3">Current owners</p>
                <OwnerLinks owners={assemblage.data.owners} />
              </div>
              {assemblage.data.groups.length === 0 ? (
                <p className="text-sm text-ink-3">No contiguous parcels share these owners.</p>
              ) : (
                assemblage.data.groups.map((g) => (
                  <div key={`${g.owner.kind}-${g.owner.id}`} className="rounded-md border border-line">
                    <div className="flex items-center justify-between gap-2 border-b border-line bg-subtle/60 px-3 py-2">
                      <span className="truncate text-sm font-medium">{g.owner.name ?? titleCase(g.owner.kind)}</span>
                      <Badge tone="green">
                        {g.parcels.length} parcels · {formatNumber(g.total_acreage, 2)} ac
                      </Badge>
                    </div>
                    <ul className="divide-y divide-line">
                      {g.parcels.map((x: ParcelListItem) => (
                        <li key={x.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                          <Link href={`/parcels/${x.id}`} className={x.id === p.id ? "font-mono text-xs font-semibold text-ink" : "font-mono text-xs text-accent hover:underline"}>
                            {x.apn}
                          </Link>
                          <span className="text-xs tabular text-ink-3">{formatNumber(x.acreage, 2)} ac</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function History({ id }: { id: string }) {
  const versions = useParcelVersions(id);
  const facts = useParcelHistory(id);

  const versionCols: Column<ParcelVersion>[] = [
    { id: "v", header: "Version", cell: (v) => <span className="tabular font-medium">v{v.version}</span> },
    { id: "changed", header: "Changed", cell: (v) => <span className="text-ink-2">{v.changed_fields.map(titleCase).join(", ") || "—"}</span> },
    { id: "legal", header: "Legal description", cell: (v) => <span className="block max-w-[320px] truncate text-xs text-ink-2">{v.legal_description ?? "—"}</span> },
    { id: "geom", header: "Geometry", cell: (v) => {
      const s = summarizeGeoJson(v.geojson);
      return s ? <span className="text-xs text-ink-2 tabular">{s.vertices} vertices</span> : <span className="text-ink-3">—</span>;
    } },
    { id: "acres", header: "Acres", align: "right", cell: (v) => formatNumber(v.acreage, 4) },
    { id: "source", header: "Source", cell: (v) => <span className="text-xs text-ink-2">{v.source ?? "—"}{v.observed_on ? ` · ${formatDate(v.observed_on)}` : ""}</span> },
    { id: "recorded", header: "Recorded", cell: (v) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(v.recorded_at)}</span> },
    {
      id: "dl",
      header: "",
      align: "right",
      cell: (v) =>
        v.geojson ? (
          <Button size="xs" variant="ghost" aria-label="Download geometry" onClick={() => downloadGeoJson(v.geojson, `parcel-${id}-v${v.version}.geojson`)}>
            <Download className="!size-3.5" />
          </Button>
        ) : null,
    },
  ];

  const factCols: Column<Observation>[] = [
    { id: "field", header: "Field", cell: (o) => <span className="font-medium">{titleCase(o.field)}</span> },
    {
      id: "value",
      header: "Value",
      cell: (o) => <span className={o.is_current ? "text-ink" : "text-ink-3 line-through decoration-ink-3/40"}>{String(o.value ?? "—")}</span>,
    },
    { id: "source", header: "Source", cell: (o) => <span className="text-ink-2">{o.source}</span> },
    { id: "observed", header: "Observed", cell: (o) => <span className="text-ink-2">{formatDate(o.observed_on)}</span> },
    { id: "confidence", header: "Confidence", align: "right", cell: (o) => <ConfidencePill value={o.confidence} /> },
    { id: "state", header: "Verification", cell: (o) => <StatusBadge status={o.verification} /> },
  ];

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader title="Legal description & geometry versions" description="Every source change is kept; nothing is overwritten." />
        <DataTable columns={versionCols} data={versions.data} loading={versions.isLoading} dense empty={<EmptyState title="No versions yet" />} />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Sourced facts" description="Original APN observations are retained alongside the normalized key." />
        <DataTable
          columns={factCols}
          data={facts.data}
          loading={facts.isLoading}
          dense
          rowClassName={(o) => (!o.is_current ? "bg-subtle/40" : undefined)}
          empty={<EmptyState title="No sourced facts yet" />}
        />
      </Card>
    </div>
  );
}

function ParcelDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: p, isLoading, error } = useParcel(id);
  const merge = useMergeParcel(id);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const tab = url.get("tab") ?? "overview";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !p) {
    return <EmptyState title="Parcel not found" description={errorMessage(error)} action={<Link href="/parcels"><Button>Back to parcels</Button></Link>} />;
  }

  const archive = async () => {
    try {
      await api.delete(`/parcels/${id}`);
      toast.success("Parcel archived");
      router.replace("/parcels");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const runMerge = () => {
    if (!mergeTarget) return;
    merge.mutate(mergeTarget, {
      onSuccess: (target) => {
        toast.success("Parcels merged");
        router.replace(`/parcels/${target.id}`);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Parcels", href: "/parcels" }, { label: parcelTitle(p) }]}
        title={<span className="font-mono">{p.apn}</span>}
        description={[p.situs_address, p.county, p.state].filter(Boolean).join(", ")}
        meta={
          <>
            {p.has_geometry ? <Badge tone="green" dot>Geometry</Badge> : <Badge tone="amber" dot>No geometry</Badge>}
            {p.acreage != null && <span className="text-xs text-ink-3">{formatNumber(p.acreage, 2)} ac</span>}
            <span className="text-xs text-ink-3">· {p.property_count} linked propert{p.property_count === 1 ? "y" : "ies"}</span>
          </>
        }
        actions={
          <>
            {can("parcels", "edit") && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            )}
            {(can("parcels", "approve") || can("parcels", "delete")) && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {can("parcels", "approve") && (
                    <MenuItem icon={<GitMerge />} onSelect={() => setMerging(true)}>
                      Merge duplicate into…
                    </MenuItem>
                  )}
                  {can("parcels", "delete") && (
                    <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                      Archive parcel
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "neighbors", label: "Adjacency & ownership" },
            { value: "history", label: "History" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="overview">
          <Overview p={p} />
        </TabPanel>
        <TabPanel value="neighbors">
          <Neighbors p={p} />
        </TabPanel>
        <TabPanel value="history">
          <History id={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="parcel" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <ParcelFormSheet open={editing} onOpenChange={setEditing} parcel={p} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this parcel?"
        description="The parcel, its versions and history are retained. It will no longer appear in lists or adjacency results."
        confirmLabel="Archive"
        destructive
        onConfirm={archive}
      />
      <Dialog
        open={merging}
        onOpenChange={setMerging}
        title="Merge duplicate parcel"
        description="Property links and buildings move to the parcel you choose; this parcel is archived. Review both records first — merges are audited."
        footer={
          <>
            <Button onClick={() => setMerging(false)}>Cancel</Button>
            <Button variant="danger" disabled={!mergeTarget || mergeTarget === id} loading={merge.isPending} onClick={runMerge}>
              Merge
            </Button>
          </>
        }
      >
        <Field label="Keep this parcel">
          <EntityPicker<ParcelListItem>
            endpoint="/parcels"
            value={mergeTarget}
            onChange={(v) => setMergeTarget(v)}
            placeholder="Search APN or county"
            toOption={(x) => ({ id: x.id, label: `${x.county} · ${x.apn}`, sublabel: x.situs_address ?? undefined })}
          />
        </Field>
      </Dialog>
    </>
  );
}

export default function ParcelPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <ParcelDetail id={params.id} />
    </Suspense>
  );
}
