"use client";

import { Archive, Check, ExternalLink, MoreHorizontal, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { ConfidencePill, ProvenanceDot } from "@/components/data/provenance";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Progress, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import {
  PROPERTY_STATUSES,
  PROPERTY_TYPE_LABELS,
  propertyTitle,
  usePropertyHistory,
  useProperty,
  useSaveProperty,
  useVerifyObservation,
  type Observation,
  type Property,
} from "@/features/properties/api";
import { PropertyFormSheet } from "@/features/properties/property-form";
import { PropertyAssetsTab } from "@/features/assets/property-assets-tab";
import { PropertyBrokerageTab } from "@/features/brokerage/property-brokerage-tab";
import { PropertyBuyboxTab } from "@/features/buybox/property-buybox-tab";
import { PropertyCompsTab } from "@/features/comps/property-comps-tab";
import { PropertyContractsTab } from "@/features/contracts/property-contracts-tab";
import { PropertyDebtTab } from "@/features/debt/property-debt-tab";
import { PropertyDocumentsTab } from "@/features/documents/property-documents-tab";
import { PropertyLeasesTab } from "@/features/leases/property-leases-tab";
import { PropertyMaintenanceTab } from "@/features/maintenance/property-maintenance-tab";
import { PropertyOffersTab } from "@/features/offers/property-offers-tab";
import { PropertyOperationsTab } from "@/features/operations/property-operations-tab";
import { RecordInteractions } from "@/features/outreach/record-interactions";
import { PropertyOwnershipTab } from "@/features/ownership/property-ownership-tab";
import { PropertyParcelsTab } from "@/features/parcels/property-parcels-tab";
import { PropertyOpportunitiesTab } from "@/features/pipeline/property-opportunities-tab";
import { PropertyReceivablesTab } from "@/features/receivables/property-receivables-tab";
import { PropertyScoringTab } from "@/features/scoring/property-scoring-tab";
import { PropertySignalsTab } from "@/features/signals/property-signals-tab";
import { PropertyUnderwritingTab } from "@/features/underwriting/property-underwriting-tab";

function Overview({ p }: { p: Property }) {
  const prov = (field: string) => <ProvenanceDot obs={p.provenance[field]} />;
  const mapsUrl = p.latitude != null && p.longitude != null ? `https://www.google.com/maps?q=${p.latitude},${p.longitude}` : null;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Identity & physical" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Property type" extra={prov("property_type")}>{PROPERTY_TYPE_LABELS[p.property_type] ?? titleCase(p.property_type)}</FieldItem>
              <FieldItem label="Subtype">{p.property_subtype}</FieldItem>
              <FieldItem label="Construction class" extra={prov("construction_class")}>{p.construction_class}</FieldItem>
              <FieldItem label="Building area" extra={prov("building_area_sf")}>{p.building_area_sf != null ? `${formatNumber(p.building_area_sf)} SF` : null}</FieldItem>
              <FieldItem label="Land area" extra={prov("land_area_acres")}>{p.land_area_acres != null ? `${formatNumber(p.land_area_acres, 2)} ac` : null}</FieldItem>
              <FieldItem label="Parking" extra={prov("parking_spaces")}>{p.parking_spaces != null ? formatNumber(p.parking_spaces) : null}</FieldItem>
              <FieldItem label="Year built" extra={prov("year_built")}>{p.year_built}</FieldItem>
              <FieldItem label="Year renovated" extra={prov("year_renovated")}>{p.year_renovated}</FieldItem>
              <FieldItem label="County">{p.county}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Market & income" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Asking price" extra={prov("asking_price")}>{p.asking_price != null ? formatCurrency(p.asking_price) : null}</FieldItem>
              <FieldItem label="NOI" extra={prov("noi")}>{p.noi != null ? formatCurrency(p.noi) : null}</FieldItem>
              <FieldItem label="Implied cap rate">
                {p.asking_price && p.noi ? formatPercent((p.noi / p.asking_price) * 100, 2) : null}
              </FieldItem>
              <FieldItem label="Last sale price" extra={prov("last_sale_price")}>{p.last_sale_price != null ? formatCurrency(p.last_sale_price) : null}</FieldItem>
              <FieldItem label="Last sale date" extra={prov("last_sale_date")}>{p.last_sale_date ? formatDate(p.last_sale_date) : null}</FieldItem>
              <FieldItem label="Occupancy" extra={prov("occupancy_pct")}>{p.occupancy_pct != null ? formatPercent(p.occupancy_pct, 1) : null}</FieldItem>
              <FieldItem label="WALE" extra={prov("wale_years")}>{p.wale_years != null ? `${formatNumber(p.wale_years, 1)} yrs` : null}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Site & location" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Zoning" extra={prov("zoning")}>{p.zoning}</FieldItem>
              <FieldItem label="Future land use" extra={prov("future_land_use")}>{p.future_land_use}</FieldItem>
              <FieldItem label="Flood zone" extra={prov("flood_zone")}>{p.flood_zone}</FieldItem>
              <FieldItem label="Traffic count" extra={prov("traffic_count")}>{p.traffic_count != null ? `${formatNumber(p.traffic_count)} VPD` : null}</FieldItem>
              <FieldItem label="Corridor">{p.corridor}</FieldItem>
              <FieldItem label="Coordinates">
                {p.latitude != null && p.longitude != null ? `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}` : null}
              </FieldItem>
            </FieldGrid>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                Open in Google Maps <ExternalLink className="size-3" />
              </a>
            )}
          </CardBody>
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
          <CardHeader title="Data quality" description="Completeness for this property type" />
          <CardBody className="space-y-4">
            <div className="flex items-end justify-between">
              <span className="text-3xl font-semibold tracking-tight tabular">{Math.round(p.completeness_score)}%</span>
              <span className="text-xs text-ink-3">{p.missing_fields.length} missing</span>
            </div>
            <Progress value={p.completeness_score} />
            {p.missing_fields.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {p.missing_fields.map((f) => (
                  <Badge key={f} tone="outline">
                    {titleCase(f)}
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-3 border-t border-line pt-3 text-xs text-ink-3">
              <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-positive" />Verified</span>
              <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-caution" />Unverified</span>
              <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-negative" />Rejected</span>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Address" />
          <CardBody className="space-y-3 text-sm">
            <div>
              <p className="text-ink">{p.address_line}</p>
              <p className="text-ink-2">{[p.city, p.state, p.postal_code].filter(Boolean).join(", ")}</p>
            </div>
            <div>
              <p className="text-xs text-ink-3">Normalized key</p>
              <p className="font-mono text-xs text-ink-2">{p.normalized_address}</p>
            </div>
            {p.alternate_addresses.length > 0 && (
              <div>
                <p className="text-xs text-ink-3">Alternate addresses</p>
                {p.alternate_addresses.map((a) => (
                  <p key={a} className="font-mono text-xs text-ink-2">{a}</p>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Record" />
          <CardBody>
            <FieldGrid cols={1}>
              <FieldItem label="Tags">
                {p.tags.length ? (
                  <div className="flex flex-wrap gap-1">
                    {p.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                ) : null}
              </FieldItem>
              <FieldItem label="Created">{formatDateTime(p.created_at)}</FieldItem>
              <FieldItem label="Last updated">{formatDateTime(p.updated_at)}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function FieldHistory({ id }: { id: string }) {
  const { can } = useAuth();
  const { data, isLoading } = usePropertyHistory(id);
  const verify = useVerifyObservation(id);

  const act = (obs: Observation, state: "verified" | "rejected") =>
    verify.mutate(
      { id: obs.id, state },
      {
        onSuccess: () => toast.success(`${titleCase(obs.field)} ${state}`),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const columns: Column<Observation>[] = [
    { id: "field", header: "Field", cell: (o) => <span className="font-medium">{titleCase(o.field)}</span> },
    {
      id: "value",
      header: "Value",
      cell: (o) => (
        <span className={o.is_current ? "text-ink" : "text-ink-3 line-through decoration-ink-3/40"}>
          {typeof o.value === "number" ? formatNumber(o.value, 2) : String(o.value ?? "—")}
        </span>
      ),
    },
    { id: "source", header: "Source", cell: (o) => <span className="text-ink-2">{o.source}</span> },
    { id: "observed", header: "Observed", cell: (o) => <span className="text-ink-2">{formatDate(o.observed_on)}</span> },
    { id: "confidence", header: "Confidence", align: "right", cell: (o) => <ConfidencePill value={o.confidence} /> },
    {
      id: "state",
      header: "Verification",
      cell: (o) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={o.verification} />
          {o.ai_derived && <Badge tone="sky">AI</Badge>}
          {!o.is_current && <Badge tone="outline">Superseded</Badge>}
        </div>
      ),
    },
    { id: "recorded", header: "Recorded", cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(o.recorded_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (o) =>
        o.is_current && o.verification === "unverified" && can("properties", "edit") ? (
          <div className="flex justify-end gap-1">
            <Button size="xs" onClick={() => act(o, "verified")}>
              <Check className="!size-3.5" /> Verify
            </Button>
            <Button size="xs" variant="ghost" onClick={() => act(o, "rejected")} aria-label="Reject">
              <X className="!size-3.5" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <Card className="overflow-hidden">
      <DataTable
        columns={columns}
        data={data}
        loading={isLoading}
        dense
        rowClassName={(o) => (!o.is_current ? "bg-subtle/40" : undefined)}
        empty={<EmptyState title="No sourced facts yet" description="Material fields record their source and history when set." />}
      />
    </Card>
  );
}

interface Section {
  value: string;
  label: string;
  module?: string;
  render: () => ReactNode;
}

/**
 * Every module that hangs off a property contributes a sub-tab. Sub-tabs are grouped so the page stays
 * scannable; `?tab=<sub-tab>` deep links keep working because the group is derived from the sub-tab.
 */
function PropertySections({ p, id, tab, onTab }: { p: Property; id: string; tab: string; onTab: (v: string) => void }) {
  const { can } = useAuth();

  // Typed before .map/.filter so the literal is contextually typed (otherwise `s.module` is missing on some union members).
  const allGroups: { value: string; label: string; sections: Section[] }[] = [
    {
      value: "overview",
      label: "Overview",
      sections: [{ value: "overview", label: "Overview", render: () => <Overview p={p} /> }],
    },
    {
      value: "intelligence",
      label: "Intelligence",
      sections: [
        { value: "ownership", label: "Ownership", module: "ownership", render: () => <PropertyOwnershipTab propertyId={id} /> },
        { value: "signals", label: "Signals", module: "signals", render: () => <PropertySignalsTab propertyId={id} /> },
        { value: "scoring", label: "Score", module: "scoring", render: () => <PropertyScoringTab propertyId={id} /> },
        { value: "buybox", label: "Buy Box", module: "buybox", render: () => <PropertyBuyboxTab propertyId={id} /> },
        { value: "comps", label: "Comps & value", module: "comps", render: () => <PropertyCompsTab propertyId={id} /> },
      ],
    },
    {
      value: "deals",
      label: "Deals",
      sections: [
        { value: "opportunities", label: "Opportunities", module: "pipeline", render: () => <PropertyOpportunitiesTab propertyId={id} /> },
        { value: "underwriting", label: "Underwriting", module: "underwriting", render: () => <PropertyUnderwritingTab propertyId={id} /> },
        { value: "offers", label: "Offers", module: "offers", render: () => <PropertyOffersTab propertyId={id} /> },
        { value: "contracts", label: "Contracts & DD", module: "contracts", render: () => <PropertyContractsTab propertyId={id} /> },
        { value: "brokerage", label: "Brokerage", module: "brokerage", render: () => <PropertyBrokerageTab propertyId={id} /> },
      ],
    },
    {
      value: "operations",
      label: "Operations",
      sections: [
        { value: "assets", label: "Asset", module: "assets", render: () => <PropertyAssetsTab propertyId={id} /> },
        { value: "leases", label: "Leases", module: "leases", render: () => <PropertyLeasesTab propertyId={id} /> },
        { value: "receivables", label: "Receivables", module: "receivables", render: () => <PropertyReceivablesTab propertyId={id} /> },
        { value: "debt", label: "Debt", module: "debt", render: () => <PropertyDebtTab propertyId={id} /> },
        { value: "maintenance", label: "Maintenance", module: "maintenance", render: () => <PropertyMaintenanceTab propertyId={id} /> },
        { value: "operations-costs", label: "Insurance, tax & CapEx", module: "operations", render: () => <PropertyOperationsTab propertyId={id} /> },
      ],
    },
    {
      value: "records",
      label: "Records",
      sections: [
        { value: "parcels", label: "Parcels & spaces", module: "parcels", render: () => <PropertyParcelsTab propertyId={id} /> },
        { value: "documents", label: "Documents", module: "documents", render: () => <PropertyDocumentsTab propertyId={id} /> },
        { value: "interactions", label: "Interactions", module: "outreach", render: () => <RecordInteractions filter={{ property_id: id }} /> },
        { value: "history", label: "Sourced facts", render: () => <FieldHistory id={id} /> },
        {
          value: "activity",
          label: "Activity",
          render: () => (
            <Card>
              <CardBody>
                <RecordTimeline entityType="property" entityId={id} />
              </CardBody>
            </Card>
          ),
        },
      ],
    },
  ];
  const groups = allGroups
    .map((g) => ({ ...g, sections: g.sections.filter((s) => !s.module || can(s.module)) }))
    .filter((g) => g.sections.length > 0);

  const activeGroup = groups.find((g) => g.sections.some((s) => s.value === tab)) ?? groups[0];
  const active = activeGroup.sections.find((s) => s.value === tab) ?? activeGroup.sections[0];

  return (
    <Tabs value={activeGroup.value} onValueChange={(v) => onTab(groups.find((g) => g.value === v)?.sections[0].value ?? "overview")}>
      <TabList className="mb-4" tabs={groups.map((g) => ({ value: g.value, label: g.label }))} />
      {activeGroup.sections.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-1" role="tablist" aria-label={`${activeGroup.label} sections`}>
          {activeGroup.sections.map((s) => (
            <button
              key={s.value}
              role="tab"
              aria-selected={s.value === active.value}
              onClick={() => onTab(s.value)}
              className={cn(
                "h-7 rounded-md px-2.5 text-sm transition-colors",
                s.value === active.value ? "bg-ink text-white" : "text-ink-2 hover:bg-muted hover:text-ink",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <TabPanel value={activeGroup.value}>{active.render()}</TabPanel>
    </Tabs>
  );
}

function PropertyDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: p, isLoading, error } = useProperty(id);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const save = useSaveProperty(id);
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
    return <EmptyState title="Property not found" description={errorMessage(error)} action={<Link href="/properties"><Button>Back to properties</Button></Link>} />;
  }

  const changeStatus = (status: string) =>
    save.mutate(
      { data: { status, provenance: { source: "Status change", observed_on: null, confidence: 1, verified: true } } },
      { onSuccess: () => toast.success(`Status set to ${titleCase(status)}`), onError: (e) => toast.error(errorMessage(e)) },
    );

  const archive = async () => {
    try {
      await api.delete(`/properties/${id}`);
      toast.success("Property archived");
      router.replace("/properties");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Properties", href: "/properties" }, { label: propertyTitle(p) }]}
        title={propertyTitle(p)}
        description={[p.name ? p.address_line : null, p.city, p.state, p.postal_code].filter(Boolean).join(", ")}
        meta={
          <>
            <StatusBadge status={p.status} />
            <Badge tone="outline">{PROPERTY_TYPE_LABELS[p.property_type] ?? titleCase(p.property_type)}</Badge>
            {p.building_area_sf != null && <span className="text-xs text-ink-3">{formatNumber(p.building_area_sf)} SF</span>}
            {p.land_area_acres != null && <span className="text-xs text-ink-3">· {formatNumber(p.land_area_acres, 2)} ac</span>}
          </>
        }
        actions={
          can("properties", "edit") && (
            <>
              <Menu>
                <MenuTrigger asChild>
                  <Button>Status: {titleCase(p.status)}</Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuLabel>Change status</MenuLabel>
                  {PROPERTY_STATUSES.filter((s) => s !== p.status).map((s) => (
                    <MenuItem key={s} onSelect={() => changeStatus(s)}>
                      <StatusBadge status={s} />
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
              {can("properties", "delete") && (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon" aria-label="More actions">
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                      Archive property
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </>
          )
        }
      />

      <PropertySections p={p} id={id} tab={tab} onTab={(v) => url.set({ tab: v === "overview" ? null : v })} />

      <PropertyFormSheet open={editing} onOpenChange={setEditing} property={p} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this property?"
        description="The record and its history are retained and can be restored by an administrator. It will no longer appear in lists."
        confirmLabel="Archive"
        destructive
        onConfirm={archive}
      />
    </>
  );
}

export default function PropertyPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <PropertyDetail id={params.id} />
    </Suspense>
  );
}
