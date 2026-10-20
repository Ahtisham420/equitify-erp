"use client";

import { Link2, MoreHorizontal, Pencil, Plus, Trash2, Unlink } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, formatPercent, titleCase } from "@/lib/utils";

import {
  PARCEL_RELATIONSHIPS,
  useBuildings,
  useDeleteBuilding,
  useDeleteSpace,
  usePropertyParcels,
  useSpaces,
  useUnlinkParcel,
  useUpdateParcelLink,
  type Building,
  type PropertyParcel,
  type Space,
} from "./api";
import { BuildingFormSheet, LinkParcelSheet, SpaceFormSheet } from "./structure-forms";

const OCCUPANCY_TONES: Record<string, "green" | "amber" | "neutral" | "blue" | "sky"> = {
  occupied: "green", vacant: "amber", pending: "blue", owner_occupied: "sky", unavailable: "neutral",
};

type LinkRow = PropertyParcel & { id: string };

type Confirm = { kind: "unlink"; item: LinkRow } | { kind: "building"; item: Building } | { kind: "space"; item: Space } | null;

/** Physical hierarchy beneath a property: parcels -> buildings -> spaces/suites. */
export function PropertyParcelsTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const parcels = usePropertyParcels(propertyId);
  const buildings = useBuildings(propertyId);
  const spaces = useSpaces(propertyId);
  const updateLink = useUpdateParcelLink(propertyId);
  const unlink = useUnlinkParcel(propertyId);
  const deleteBuilding = useDeleteBuilding(propertyId);
  const deleteSpace = useDeleteSpace(propertyId);

  const [linking, setLinking] = useState(false);
  const [building, setBuilding] = useState<{ open: boolean; item: Building | null }>({ open: false, item: null });
  const [space, setSpace] = useState<{ open: boolean; item: Space | null }>({ open: false, item: null });
  const [confirm, setConfirm] = useState<Confirm>(null);

  const canEdit = can("parcels", "edit");
  const canCreate = can("parcels", "create");
  const canDelete = can("parcels", "delete");
  const buildingNames = useMemo(() => Object.fromEntries((buildings.data ?? []).map((b) => [b.id, b.name])), [buildings.data]);

  const stats = useMemo(() => {
    const rows = spaces.data ?? [];
    const total = rows.reduce((s, r) => s + (r.area_sf ?? 0), 0);
    const occupied = rows.filter((r) => r.occupancy_status === "occupied" || r.occupancy_status === "owner_occupied").reduce((s, r) => s + (r.area_sf ?? 0), 0);
    const acres = (parcels.data ?? []).reduce((s, l) => s + (l.parcel.acreage ?? 0), 0);
    return { total, occupied, pct: total ? (occupied / total) * 100 : null, acres, vacantSuites: rows.filter((r) => r.occupancy_status === "vacant").length };
  }, [spaces.data, parcels.data]);

  const runConfirm = () => {
    if (!confirm) return;
    const done = (msg: string) => ({
      onSuccess: () => {
        toast.success(msg);
        setConfirm(null);
      },
      onError: (e: unknown) => toast.error(errorMessage(e)),
    });
    if (confirm.kind === "unlink") unlink.mutate(confirm.item.link_id, done("Parcel unlinked"));
    else if (confirm.kind === "building") deleteBuilding.mutate(confirm.item.id, done("Building removed"));
    else deleteSpace.mutate(confirm.item.id, done("Suite removed"));
  };

  const parcelCols: Column<LinkRow>[] = [
    {
      id: "apn",
      header: "APN",
      cell: (l) => (
        <div>
          <Link href={`/parcels/${l.parcel.id}`} className="font-mono text-[13px] font-medium text-ink hover:text-accent">
            {l.parcel.apn}
          </Link>
          <p className="text-xs text-ink-3">{[l.parcel.county, l.parcel.state].filter(Boolean).join(", ")}</p>
        </div>
      ),
    },
    {
      id: "relationship",
      header: "Relationship",
      cell: (l) =>
        canEdit ? (
          <Menu>
            <MenuTrigger asChild>
              <button className="rounded hover:bg-muted">
                <Badge tone={l.relationship === "primary" ? "blue" : "outline"}>{titleCase(l.relationship)}</Badge>
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuLabel>Relationship</MenuLabel>
              {PARCEL_RELATIONSHIPS.filter((r) => r !== l.relationship).map((r) => (
                <MenuItem
                  key={r}
                  onSelect={() =>
                    updateLink.mutate({ linkId: l.link_id, relationship: r }, { onError: (e) => toast.error(errorMessage(e)) })
                  }
                >
                  {titleCase(r)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : (
          <Badge tone={l.relationship === "primary" ? "blue" : "outline"}>{titleCase(l.relationship)}</Badge>
        ),
    },
    { id: "acres", header: "Acres", align: "right", cell: (l) => formatNumber(l.parcel.acreage, 2) },
    {
      id: "geometry",
      header: "Geometry",
      cell: (l) => (l.parcel.has_geometry ? <Badge tone="green" dot>Polygon</Badge> : <Badge tone="amber" dot>Missing</Badge>),
    },
    {
      id: "shared",
      header: "Other properties",
      align: "right",
      cell: (l) => (l.parcel.property_count > 1 ? formatNumber(l.parcel.property_count - 1) : <span className="text-ink-3">—</span>),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (l) =>
        canEdit ? (
          <Button size="icon-sm" variant="ghost" aria-label="Unlink parcel" onClick={() => setConfirm({ kind: "unlink", item: l })}>
            <Unlink />
          </Button>
        ) : null,
    },
  ];

  const rowMenu = (onEdit: () => void, onDelete: () => void) =>
    canEdit || canDelete ? (
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Row actions">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent>
          {canEdit && (
            <MenuItem icon={<Pencil />} onSelect={onEdit}>
              Edit
            </MenuItem>
          )}
          {canDelete && (
            <MenuItem icon={<Trash2 />} destructive onSelect={onDelete}>
              Remove
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
    ) : null;

  const buildingCols: Column<Building>[] = [
    { id: "name", header: "Building", cell: (b) => <span className="font-medium">{b.name}</span> },
    { id: "use", header: "Use", cell: (b) => <span className="text-ink-2">{b.use_type ?? "—"}</span> },
    { id: "area", header: "Area (SF)", align: "right", cell: (b) => formatNumber(b.building_area_sf) },
    { id: "year", header: "Built", align: "right", cell: (b) => b.year_built ?? "—" },
    { id: "floors", header: "Floors", align: "right", cell: (b) => b.floors ?? "—" },
    { id: "class", header: "Class", cell: (b) => <span className="text-ink-2">{b.construction_class ?? "—"}</span> },
    { id: "spaces", header: "Suites", align: "right", cell: (b) => formatNumber(b.space_count) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (b) => rowMenu(() => setBuilding({ open: true, item: b }), () => setConfirm({ kind: "building", item: b })),
    },
  ];

  const spaceCols: Column<Space>[] = [
    {
      id: "suite",
      header: "Suite",
      cell: (s) => (
        <div>
          <p className="font-medium">{s.suite}</p>
          <p className="text-xs text-ink-3">{[s.building_id ? buildingNames[s.building_id] : null, s.floor ? `Floor ${s.floor}` : null, s.location_note].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    { id: "area", header: "Area (SF)", align: "right", cell: (s) => formatNumber(s.area_sf) },
    { id: "use", header: "Use", cell: (s) => <span className="text-ink-2">{s.use_type ? titleCase(s.use_type) : "—"}</span> },
    {
      id: "occupancy",
      header: "Occupancy",
      cell: (s) => (
        <Badge tone={OCCUPANCY_TONES[s.occupancy_status] ?? "neutral"} dot>
          {titleCase(s.occupancy_status)}
        </Badge>
      ),
    },
    {
      id: "tenant",
      header: "Tenant",
      cell: (s) =>
        s.tenant_organization_id ? (
          <Link href={`/organizations/${s.tenant_organization_id}`} className="text-accent hover:underline">
            {s.tenant_name ?? "Organization"}
          </Link>
        ) : (
          <span className="text-ink-2">{s.tenant_name ?? "—"}</span>
        ),
    },
    { id: "lease", header: "Lease", cell: (s) => (s.lease_id ? <StatusBadge status="active" label="Linked" /> : <span className="text-ink-3">—</span>) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (s) => rowMenu(() => setSpace({ open: true, item: s }), () => setConfirm({ kind: "space", item: s })),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Parcels" value={formatNumber(parcels.data?.length ?? 0)} hint={`${formatNumber(stats.acres, 2)} ac combined`} />
        <StatCard label="Buildings" value={formatNumber(buildings.data?.length ?? 0)} />
        <StatCard label="Suites" value={formatNumber(spaces.data?.length ?? 0)} hint={`${stats.vacantSuites} vacant`} />
        <StatCard label="Suite occupancy" value={stats.pct != null ? formatPercent(stats.pct, 1) : "—"} hint={`${formatNumber(stats.occupied)} of ${formatNumber(stats.total)} SF`} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Parcels"
          description="Land beneath this property, including assemblage parcels"
          actions={
            canEdit && (
              <Button size="sm" onClick={() => setLinking(true)}>
                <Link2 /> Link parcel
              </Button>
            )
          }
        />
        <DataTable
          columns={parcelCols}
          data={parcels.data?.map((l): LinkRow => ({ ...l, id: l.link_id }))}
          loading={parcels.isLoading}
          dense
          empty={<EmptyState title="No parcels linked" description="Link the APN records that make up this site." />}
        />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Buildings"
          actions={
            canCreate && (
              <Button size="sm" onClick={() => setBuilding({ open: true, item: null })}>
                <Plus /> Add building
              </Button>
            )
          }
        />
        <DataTable
          columns={buildingCols}
          data={buildings.data}
          loading={buildings.isLoading}
          dense
          empty={<EmptyState title="No buildings recorded" description="Add a building for each structure on multi-building sites." />}
        />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Spaces & suites"
          description="Occupancy, tenant and lease linkage per suite"
          actions={
            canCreate && (
              <Button size="sm" onClick={() => setSpace({ open: true, item: null })}>
                <Plus /> Add suite
              </Button>
            )
          }
        />
        <DataTable
          columns={spaceCols}
          data={spaces.data}
          loading={spaces.isLoading}
          dense
          empty={<EmptyState title="No suites recorded" description="Add suites to track occupancy and tenants for multi-tenant assets." />}
        />
      </Card>

      <LinkParcelSheet open={linking} onOpenChange={setLinking} propertyId={propertyId} />
      <BuildingFormSheet
        open={building.open}
        onOpenChange={(o) => setBuilding((s) => ({ ...s, open: o }))}
        propertyId={propertyId}
        building={building.item}
        parcels={parcels.data ?? []}
      />
      <SpaceFormSheet
        open={space.open}
        onOpenChange={(o) => setSpace((s) => ({ ...s, open: o }))}
        propertyId={propertyId}
        space={space.item}
        buildings={buildings.data ?? []}
      />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === "unlink" ? "Unlink this parcel?" : confirm?.kind === "building" ? "Remove this building?" : "Remove this suite?"}
        description={
          confirm?.kind === "unlink"
            ? "The parcel record is kept; only its link to this property is removed. The change is audited."
            : "The record is archived with its history."
        }
        confirmLabel={confirm?.kind === "unlink" ? "Unlink" : "Remove"}
        destructive
        loading={unlink.isPending || deleteBuilding.isPending || deleteSpace.isPending}
        onConfirm={runConfirm}
      />
    </div>
  );
}
