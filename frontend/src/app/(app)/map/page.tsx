"use client";

import { Crosshair, Download, Footprints, Layers, ListChecks, Lock, MapPinned, Plus, Route, Save, Send, Target, Trash2, Users, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EntityPicker } from "@/components/data/entity-picker";
import { FacetFilter, FilterChips, type FilterChip } from "@/components/data/filters";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Spinner } from "@/components/ui/misc";
import { useDebounce } from "@/hooks/use-debounce";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatNumber, titleCase } from "@/lib/utils";

import {
  DEFAULT_LAYERS,
  LAYER_ORDER,
  OPPORTUNITY_STAGES,
  SIGNAL_CATEGORIES,
  useAssemblage,
  useMapConfig,
  useMapLayers,
  useSaveTerritory,
  useSelectRecords,
  type AssemblageResult,
  type BulkAction,
  type DrawnShape,
  type FeatureProps,
  type LayerKey,
  type Selection,
} from "@/features/map/api";
import { BulkActionDialog } from "@/features/map/bulk-dialog";
import { cssStatusColor, LAYER_TOKEN } from "@/features/map/colors";
import { ObservationDialog, QueueDialog, type GeoFix } from "@/features/map/field-panel";
import { useFieldQueue } from "@/features/map/field-queue";
import type { MapView } from "@/features/map/map-canvas";
import { RecordCardPanel } from "@/features/map/record-card";
import { PROPERTY_STATUSES, PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/features/properties/api";

const MapCanvas = dynamic(() => import("@/features/map/map-canvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-subtle">
      <Spinner />
    </div>
  ),
});

const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILES || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_CENTER: [number, number] = [39.5, -98.35];
const DEFAULT_ZOOM = 5;
const M_PER_MILE = 1609.344;

const LAYER_LABELS: Record<LayerKey, string> = {
  properties: "Properties",
  parcels: "Parcels",
  opportunities: "Opportunities",
  assets: "Assets",
  listings: "Listings",
  comps: "Sale comps",
  territories: "Territories",
  signals: "Signals",
  observations: "Field observations",
};

interface CorridorLite { id: string; name: string; road_name: string | null; city: string | null }

function Swatch({ layer }: { layer: LayerKey }) {
  const color = `rgb(var(--${LAYER_TOKEN[layer]}))`;
  const ring = layer === "opportunities" || layer === "listings" || layer === "signals";
  const area = layer === "parcels" || layer === "territories";
  return (
    <span
      className={cn("inline-block size-3 shrink-0", area ? "rounded-sm" : "rounded-full", layer === "territories" && "border-dashed")}
      style={ring || area ? { border: `2px solid ${color}`, background: area ? `rgb(var(--${LAYER_TOKEN[layer]}) / 0.12)` : "transparent" } : { background: color }}
    />
  );
}

function PanelSection({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

function MapWorkspace() {
  const { can } = useAuth();
  const url = useUrlState();
  const urlRef = useRef(url);
  urlRef.current = url;
  const config = useMapConfig();
  const queue = useFieldQueue();

  const [initial] = useState<{ center: [number, number]; zoom: number }>(() => {
    const c = (url.get("c") ?? "").split(",").map(Number);
    return c.length === 3 && c.every(Number.isFinite) ? { center: [c[0], c[1]], zoom: c[2] } : { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  });

  const [view, setView] = useState<MapView | null>(null);
  const debouncedView = useDebounce(view, 300);
  const [panelOpen, setPanelOpen] = useState(false);
  const [active, setActive] = useState<FeatureProps | null>(null);
  const [shape, setShape] = useState<DrawnShape | null>(null);
  const [areaFilter, setAreaFilter] = useState<GeoJSON.Polygon | null>(null);
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [assemblage, setAssemblage] = useState<AssemblageResult | null>(null);
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number; zoom?: number; seq: number } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [territoryName, setTerritoryName] = useState("");
  const [territoryDesc, setTerritoryDesc] = useState("");
  const [territoryVisibility, setTerritoryVisibility] = useState("private");
  const [obsOpen, setObsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [radiusDraft, setRadiusDraft] = useState(url.get("radius_miles") ?? "1");
  const [bufferDraft, setBufferDraft] = useState(url.get("buffer_ft") ?? "500");

  const selectRecords = useSelectRecords();
  const saveTerritory = useSaveTerritory();
  const findAssemblage = useAssemblage();

  const fieldMode = url.get("field") === "1";

  // Keep the viewport in the URL so saved views and shared links reopen the same place.
  const lastC = useRef<string | null>(url.get("c"));
  useEffect(() => {
    if (!debouncedView) return;
    const c = `${debouncedView.lat.toFixed(5)},${debouncedView.lng.toFixed(5)},${debouncedView.zoom}`;
    lastC.current = c;
    if (urlRef.current.get("c") !== c) urlRef.current.set({ c }, { resetPage: false });
  }, [debouncedView]);

  // A saved view (or back/forward) changed the viewport in the URL: move the map there.
  const cParam = url.get("c");
  useEffect(() => {
    if (!cParam || cParam === lastC.current) return;
    lastC.current = cParam;
    const [lat, lng, zoom] = cParam.split(",").map(Number);
    if ([lat, lng, zoom].every(Number.isFinite)) setFlyTo({ lat, lng, zoom, seq: Date.now() });
  }, [cParam]);

  /* ------------------------------------------------------------------ layers & filters */

  const allowed = useMemo(() => new Set((config.data?.layers ?? []).filter((l) => l.allowed).map((l) => l.key)), [config.data]);
  const layersParam = url.get("layers");
  const chosen = useMemo<LayerKey[]>(() => {
    if (layersParam === null) return DEFAULT_LAYERS;
    if (layersParam === "none") return [];
    return layersParam.split(",").filter((k): k is LayerKey => (LAYER_ORDER as string[]).includes(k));
  }, [layersParam]);
  const visible = useMemo<LayerKey[]>(() => {
    const s = new Set(chosen.filter((k) => allowed.has(k)));
    if (fieldMode && allowed.has("observations")) s.add("observations");
    return LAYER_ORDER.filter((k) => s.has(k));
  }, [chosen, allowed, fieldMode]);

  const toggleLayer = (key: LayerKey, on: boolean) => {
    const next = on ? [...chosen.filter((k) => k !== key), key] : chosen.filter((k) => k !== key);
    url.set({ layers: next.length ? LAYER_ORDER.filter((k) => next.includes(k)).join(",") : "none" }, { resetPage: false });
  };

  const nearLat = url.get("near_lat");
  const nearLng = url.get("near_lng");
  const radiusMiles = url.get("radius_miles");
  const radius = useMemo(
    () => (nearLat && nearLng && radiusMiles && Number(radiusMiles) > 0
      ? { lat: Number(nearLat), lng: Number(nearLng), radius_m: Number(radiusMiles) * M_PER_MILE }
      : null),
    [nearLat, nearLng, radiusMiles],
  );

  const filterKey = url.params;
  const filterParams = useMemo(() => ({
    status: url.getAll("status"),
    property_type: url.getAll("property_type"),
    stage: url.getAll("stage"),
    signal_category: url.getAll("signal_category"),
    near_lat: radius ? nearLat : null,
    near_lng: radius ? nearLng : null,
    radius_miles: radius ? radiusMiles : null,
    corridor_id: url.get("corridor_id"),
    buffer_ft: url.get("corridor_id") ? url.get("buffer_ft") : null,
    adjacent_to: url.get("adjacent_to"),
    polygon: areaFilter ? JSON.stringify(areaFilter) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filterKey, areaFilter]);

  const layerParams = useMemo(() => {
    if (!debouncedView || !visible.length) return null;
    return { bbox: debouncedView.bbox, layers: visible.join(","), ...filterParams };
  }, [debouncedView, visible, filterParams]);
  const layers = useMapLayers(layerParams);
  const data = layers.data;

  const facetOptions = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

  const chips: FilterChip[] = [];
  for (const [key, label, fmt] of [
    ["status", "Status", titleCase],
    ["property_type", "Type", (v: string) => PROPERTY_TYPE_LABELS[v] ?? titleCase(v)],
    ["stage", "Stage", titleCase],
    ["signal_category", "Signal", titleCase],
  ] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map((v) => fmt(v)).join(", "), onRemove: () => url.set({ [key]: null }, { resetPage: false }) });
  }
  if (radius) chips.push({ key: "radius", label: "Within", value: `${radiusMiles} mi`, onRemove: () => url.set({ near_lat: null, near_lng: null, radius_miles: null }, { resetPage: false }) });
  if (url.get("corridor_id")) chips.push({ key: "corridor", label: "Corridor buffer", value: `${url.get("buffer_ft") ?? 500} ft`, onRemove: () => url.set({ corridor_id: null, buffer_ft: null }, { resetPage: false }) });
  if (url.get("adjacent_to")) chips.push({ key: "adjacent", label: "Adjacent to", value: "selected parcel", onRemove: () => url.set({ adjacent_to: null }, { resetPage: false }) });
  if (areaFilter) chips.push({ key: "area", label: "Area", value: "drawn shape", onRemove: () => setAreaFilter(null) });

  const clearFilters = () => {
    setAreaFilter(null);
    url.replaceAll({ layers: url.get("layers"), c: url.get("c"), field: url.get("field") });
  };

  /* ------------------------------------------------------------------ interactions */

  const onFeature = useCallback((p: FeatureProps) => {
    setActive(p);
    setAssemblage(null);
    setPanelOpen(false);
  }, []);

  const onMapClick = useCallback((lat: number, lng: number) => {
    if (!picking) return;
    setPicking(false);
    const miles = Number(radiusDraft) > 0 ? radiusDraft : "1";
    url.set({ near_lat: lat.toFixed(6), near_lng: lng.toFixed(6), radius_miles: miles }, { resetPage: false });
  }, [picking, radiusDraft, url]);

  const onDrawn = useCallback((s: DrawnShape) => {
    setShape(s);
    setActive(null);
  }, []);

  const runSelect = (body: Parameters<typeof selectRecords.mutate>[0]) =>
    selectRecords.mutate(body, {
      onSuccess: (r) => {
        setSelection(r);
        if (r.truncated) toast.warning("Large selection: only the first 2,000 records were included");
        if (!r.properties.length && !r.parcels.length) toast.info("No records inside that area");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const selectShape = () => {
    if (!shape) return;
    runSelect(shape.type === "polygon" ? { polygon: shape.geometry } : { circle: { lat: shape.lat, lng: shape.lng, radius_m: shape.radius_m } });
  };

  const filterToShape = () => {
    if (!shape) return;
    if (shape.type === "polygon") setAreaFilter(shape.geometry);
    else {
      const miles = (shape.radius_m / M_PER_MILE).toFixed(2);
      setRadiusDraft(miles);
      url.set({ near_lat: shape.lat.toFixed(6), near_lng: shape.lng.toFixed(6), radius_miles: miles }, { resetPage: false });
    }
    setShape(null);
  };

  const addToSelection = (propertyId: string) => {
    const ids = new Set(selection?.properties.map((p) => p.id) ?? []);
    ids.add(propertyId);
    runSelect({ property_ids: Array.from(ids) });
  };

  const removeFromSelection = (propertyId: string) =>
    setSelection((s) => (s ? { ...s, properties: s.properties.filter((p) => p.id !== propertyId) } : s));

  const selectedIds = useMemo(() => new Set(selection?.properties.map((p) => p.id) ?? []), [selection]);
  const selectionPropertyIds = useMemo(() => Array.from(selectedIds), [selectedIds]);

  const onAssemblage = (parcelId: string) =>
    findAssemblage.mutate(parcelId, {
      onSuccess: (r) => {
        setAssemblage(r);
        if (r.result.groups.length === 0 && !r.result.owners_hidden) toast.info("No contiguous parcels share an owner with this parcel");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const onAdjacent = (parcelId: string) => {
    const next = chosen.includes("parcels") ? chosen : [...chosen, "parcels" as LayerKey];
    url.set({ adjacent_to: parcelId, layers: LAYER_ORDER.filter((k) => next.includes(k)).join(",") }, { resetPage: false });
  };

  const doSaveTerritory = () => {
    if (!shape) return;
    saveTerritory.mutate(
      {
        name: territoryName.trim(),
        description: territoryDesc.trim() || null,
        visibility: territoryVisibility,
        ...(shape.type === "polygon" ? { polygon: shape.geometry } : { circle: { lat: shape.lat, lng: shape.lng, radius_m: shape.radius_m } }),
      },
      {
        onSuccess: (t) => {
          toast.success(`Territory "${t.name}" saved with ${formatNumber(t.member_count)} properties`);
          setSaveOpen(false);
          setShape(null);
          setTerritoryName("");
          setTerritoryDesc("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  /* ------------------------------------------------------------------ field mode */

  const watchId = useRef<number | null>(null);
  useEffect(() => {
    if (!fieldMode || typeof navigator === "undefined" || !navigator.geolocation) {
      if (fieldMode) setGeoError("This device does not provide location");
      return;
    }
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null, at: pos.timestamp });
        setGeoError(null);
      },
      (err) => setGeoError(err.code === err.PERMISSION_DENIED ? "Location permission was denied" : "Could not get a location fix"),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [fieldMode]);

  const locate = () => {
    if (!navigator.geolocation) return setGeoError("This device does not provide location");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const f = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null, at: pos.timestamp };
        setFix(f);
        setGeoError(null);
        setFlyTo({ lat: f.lat, lng: f.lng, zoom: 17, seq: Date.now() });
      },
      (err) => setGeoError(err.code === err.PERMISSION_DENIED ? "Location permission was denied" : "Could not get a location fix"),
      { enableHighAccuracy: true, timeout: 30_000 },
    );
  };

  const pendingPoints = useMemo(() => queue.items.map((i) => ({ lat: i.lat, lng: i.lng })), [queue.items]);
  const cardProperty = active && active.kind !== "territory" && active.property_id ? { id: String(active.property_id), label: active.label } : null;

  /* ------------------------------------------------------------------ render */

  const truncated = visible.filter((k) => data?.layers[k]?.truncated);
  const canSelect = can("properties");
  const canSaveTerritory = can("territories", "create");
  const configLayers = config.data?.layers ?? [];

  return (
    <div className="relative flex h-[calc(100vh-6rem)] min-h-[520px] overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      {/* ------------------------------------------------ left panel */}
      <aside
        className={cn(
          "z-20 w-72 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface scrollbar-thin",
          panelOpen ? "absolute inset-y-0 left-0 flex shadow-pop" : "hidden",
          "md:static md:flex md:shadow-none",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h1 className="text-base font-semibold text-ink">Map</h1>
            <p className="text-xs text-ink-3">Search, select and act on records spatially</p>
          </div>
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Close panel" onClick={() => setPanelOpen(false)}>
            <X />
          </Button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <SavedViewsMenu module="map" />
          <Button
            variant={fieldMode ? "primary" : "secondary"}
            onClick={() => url.set({ field: fieldMode ? null : "1" }, { resetPage: false })}
            aria-pressed={fieldMode}
          >
            <Footprints />
            Field mode
          </Button>
        </div>

        <PanelSection title="Layers">
          <div className="space-y-1.5">
            {configLayers.length === 0 && config.isLoading && <Spinner className="size-3.5" />}
            {LAYER_ORDER.filter((k) => configLayers.some((l) => l.key === k)).map((k) => {
              const ok = allowed.has(k);
              const on = visible.includes(k);
              const count = data?.layers[k]?.count;
              return (
                <label key={k} className={cn("flex items-center gap-2 text-sm", ok ? "cursor-pointer text-ink" : "text-ink-3")}>
                  {ok ? <Checkbox checked={on} onChange={(v) => toggleLayer(k, v)} label={LAYER_LABELS[k]} /> : <Lock className="size-4 text-ink-3" />}
                  <Swatch layer={k} />
                  <span className="flex-1 truncate">{LAYER_LABELS[k]}</span>
                  {ok && on && count !== undefined && <span className="text-xs text-ink-3 tabular">{formatNumber(count)}</span>}
                  {!ok && <span className="text-2xs text-ink-3">No access</span>}
                </label>
              );
            })}
          </div>
          {truncated.length > 0 && (
            <p className="mt-2 text-xs text-caution">Zoom in to see every feature in: {truncated.map((k) => LAYER_LABELS[k].toLowerCase()).join(", ")}.</p>
          )}
        </PanelSection>

        <PanelSection title="Filters">
          <div className="flex flex-wrap gap-1.5">
            <FacetFilter label="Status" options={facetOptions(data?.facets.status, PROPERTY_STATUSES, titleCase)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v }, { resetPage: false })} />
            <FacetFilter label="Type" options={facetOptions(data?.facets.property_type, PROPERTY_TYPES, (v) => PROPERTY_TYPE_LABELS[v])} selected={url.getAll("property_type")} onChange={(v) => url.set({ property_type: v }, { resetPage: false })} />
            {allowed.has("opportunities") && (
              <FacetFilter label="Stage" options={facetOptions(data?.facets.stage, OPPORTUNITY_STAGES, titleCase)} selected={url.getAll("stage")} onChange={(v) => url.set({ stage: v }, { resetPage: false })} />
            )}
            {allowed.has("signals") && (
              <FacetFilter label="Signal" options={SIGNAL_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} selected={url.getAll("signal_category")} onChange={(v) => url.set({ signal_category: v }, { resetPage: false })} />
            )}
          </div>
          <p className="mt-2 text-2xs text-ink-3">Status applies to properties; type applies to every property-based layer.</p>
        </PanelSection>

        <PanelSection title="Spatial filters">
          <div className="space-y-3">
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2"><Target className="size-3.5" /> Radius</p>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0.05}
                  step={0.25}
                  value={radiusDraft}
                  onChange={(e) => setRadiusDraft(e.target.value)}
                  onBlur={() => radius && Number(radiusDraft) > 0 && url.set({ radius_miles: radiusDraft }, { resetPage: false })}
                  className="w-20"
                  aria-label="Radius in miles"
                />
                <span className="text-xs text-ink-3">mi</span>
                <Button size="sm" variant={picking ? "primary" : "secondary"} onClick={() => setPicking((p) => !p)}>
                  <Crosshair /> {picking ? "Click map" : "Pick center"}
                </Button>
              </div>
              {fix && (
                <button
                  className="mt-1 text-xs text-accent hover:underline"
                  onClick={() => url.set({ near_lat: fix.lat.toFixed(6), near_lng: fix.lng.toFixed(6), radius_miles: Number(radiusDraft) > 0 ? radiusDraft : "1" }, { resetPage: false })}
                >
                  Use my location
                </button>
              )}
            </div>
            {can("territories") && (
              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2"><Route className="size-3.5" /> Corridor buffer</p>
                <EntityPicker<CorridorLite>
                  endpoint="/corridors"
                  value={url.get("corridor_id")}
                  onChange={(id) => url.set({ corridor_id: id, buffer_ft: id ? bufferDraft : null }, { resetPage: false })}
                  placeholder="Choose a corridor"
                  toOption={(c) => ({ id: c.id, label: c.name, sublabel: [c.road_name, c.city].filter(Boolean).join(" · ") })}
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    step={50}
                    value={bufferDraft}
                    onChange={(e) => setBufferDraft(e.target.value)}
                    onBlur={() => url.get("corridor_id") && Number(bufferDraft) > 0 && url.set({ buffer_ft: bufferDraft }, { resetPage: false })}
                    className="w-24"
                    aria-label="Buffer in feet"
                  />
                  <span className="text-xs text-ink-3">ft each side</span>
                </div>
              </div>
            )}
            <p className="text-2xs text-ink-3">Draw a polygon, rectangle or circle with the tools on the map to select records, filter the map or save a territory. Use a parcel card for adjacency and assemblage.</p>
          </div>
        </PanelSection>

        {chips.length > 0 && (
          <div className="border-b border-line px-4 py-3">
            <FilterChips chips={chips} onClear={clearFilters} />
          </div>
        )}

        <PanelSection title="Legend">
          <p className="mb-1.5 text-xs text-ink-2">Property status</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {PROPERTY_STATUSES.map((s) => (
              <span key={s} className="flex items-center gap-1.5 text-xs text-ink-2">
                <span className="size-2.5 rounded-full" style={{ background: cssStatusColor(s) }} />
                {titleCase(s)}
              </span>
            ))}
          </div>
          <p className="mt-2 text-2xs text-ink-3">Opportunities are rings coloured by stage; signals are soft red halos, stronger with severity; selected records are outlined in blue.</p>
        </PanelSection>
      </aside>

      {/* ------------------------------------------------ map */}
      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-0 isolate">
          <MapCanvas
            tileUrl={TILE_URL}
            attribution={ATTRIBUTION}
            initialCenter={initial.center}
            initialZoom={initial.zoom}
            data={data?.layers}
            visible={visible}
            selectedPropertyIds={selectedIds}
            activeId={active?.id ?? null}
            shape={shape}
            radius={radius}
            highlight={assemblage?.geometry ?? null}
            position={fieldMode && fix ? fix : null}
            pending={fieldMode ? pendingPoints : []}
            picking={picking}
            drawEnabled={canSelect || canSaveTerritory}
            flyTo={flyTo}
            onView={setView}
            onFeature={onFeature}
            onMapClick={onMapClick}
            onDrawn={onDrawn}
          />
        </div>

        {/* top bar overlays */}
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-14">
          <div className="pointer-events-auto flex items-center gap-2 md:hidden">
            <Button onClick={() => setPanelOpen(true)}>
              <Layers /> Layers and filters
            </Button>
          </div>
          {(layers.isFetching || !queue.online) && (
            <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 shadow-card">
              {layers.isFetching && <><Spinner className="size-3" /> Loading</>}
              {!queue.online && <Badge tone="amber">Offline — showing last loaded data</Badge>}
            </div>
          )}
          {layers.isError && <div className="pointer-events-auto rounded-md border border-negative/30 bg-negative-soft px-2.5 py-1 text-xs text-negative">{errorMessage(layers.error)}</div>}
          {picking && (
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink shadow-pop">
              Click the map to set the search center
              <Button size="xs" variant="ghost" onClick={() => setPicking(false)}>Cancel</Button>
            </div>
          )}
          {shape && (
            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 shadow-pop">
              <span className="px-1 text-xs font-medium text-ink-2">Drawn {shape.type === "circle" ? `circle (${(shape.radius_m / M_PER_MILE).toFixed(2)} mi)` : "area"}</span>
              {canSelect && (
                <Button size="sm" variant="primary" loading={selectRecords.isPending} onClick={selectShape}>
                  <ListChecks /> Select records
                </Button>
              )}
              <Button size="sm" onClick={filterToShape}>
                <MapPinned /> Filter map
              </Button>
              {canSaveTerritory && (
                <Button size="sm" onClick={() => setSaveOpen(true)}>
                  <Save /> Save as territory
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" aria-label="Discard shape" onClick={() => setShape(null)}>
                <X />
              </Button>
            </div>
          )}
        </div>

        {/* right column: record card + selection */}
        {(active || selection) && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex max-h-[60%] flex-col gap-2 md:inset-x-auto md:bottom-3 md:right-3 md:top-3 md:max-h-none md:w-[340px]">
            {active && (
              <div className="pointer-events-auto flex min-h-0 flex-1 flex-col">
                <RecordCardPanel
                  feature={active}
                  onClose={() => {
                    setActive(null);
                    setAssemblage(null);
                  }}
                  onAddToSelection={addToSelection}
                  onAssemblage={onAssemblage}
                  onAdjacent={onAdjacent}
                  assemblage={assemblage}
                  assemblageLoading={findAssemblage.isPending}
                />
              </div>
            )}
            {selection && (
              <div className={cn("pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop", active ? "max-h-[45%]" : "flex-1")}>
                <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
                  <div>
                    <p className="text-sm font-semibold text-ink">Selection</p>
                    <p className="text-xs text-ink-3 tabular">
                      {formatNumber(selection.properties.length)} properties
                      {!selection.parcels_hidden && ` · ${formatNumber(selection.parcels.length)} parcels`}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={() => setSelection(null)}>
                    <Trash2 />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5 px-4 pb-2">
                  {can("pipeline", "create") && (
                    <Button size="xs" disabled={!selection.properties.length} onClick={() => setBulk("opportunities")}>
                      <Plus /> Opportunities
                    </Button>
                  )}
                  {can("territories", "edit") && (
                    <Button size="xs" disabled={!selection.properties.length} onClick={() => setBulk("territory")}>
                      <MapPinned /> Territory
                    </Button>
                  )}
                  {can("outreach", "create") && can("ownership") && (
                    <Button size="xs" disabled={!selection.properties.length} onClick={() => setBulk("sequence")}>
                      <Send /> Sequence
                    </Button>
                  )}
                  {can("contacts", "export") && can("ownership") && (
                    <Button size="xs" disabled={!selection.properties.length} onClick={() => setBulk("export")}>
                      <Download /> Mailing list
                    </Button>
                  )}
                </div>
                <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto border-t border-line scrollbar-thin">
                  {selection.properties.length === 0 && (
                    <li className="px-4 py-4 text-sm text-ink-3">
                      No properties in this selection{selection.parcels.length ? " (the parcels are not linked to properties yet)" : ""}.
                    </li>
                  )}
                  {selection.properties.map((p) => (
                    <li key={p.id} className="group flex items-center gap-2 px-4 py-2">
                      <button className="min-w-0 flex-1 text-left" onClick={() => onFeature({ id: p.id, kind: "property", label: p.label, status: p.status, property_id: p.id })}>
                        <p className="truncate text-sm text-ink">{p.label}</p>
                        <p className="truncate text-xs text-ink-3">{[p.city, p.state].filter(Boolean).join(", ") || p.address_line}</p>
                      </button>
                      {p.opportunity_stage ? <StatusBadge status={p.opportunity_stage} /> : <StatusBadge status={p.status} />}
                      <button aria-label="Remove from selection" className="rounded p-0.5 text-ink-3 hover:bg-muted hover:text-ink" onClick={() => removeFromSelection(p.id)}>
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* field mode controls */}
        {fieldMode && (
          <div className="absolute bottom-8 left-3 z-10 flex flex-col items-start gap-2">
            {queue.pending > 0 && (
              <button
                onClick={() => setQueueOpen(true)}
                className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink shadow-pop"
              >
                {queue.syncing ? <Spinner className="size-3" /> : <span className="size-2 rounded-full bg-caution" />}
                {formatNumber(queue.pending)} pending sync
              </button>
            )}
            {geoError && <span className="rounded-md bg-surface px-2 py-1 text-xs text-negative shadow-card">{geoError}</span>}
            <div className="flex gap-2">
              <Button size="icon" onClick={locate} aria-label="Center on my location" className="size-11 rounded-full shadow-pop">
                <Crosshair />
              </Button>
              {can("map", "create") && (
                <Button variant="primary" onClick={() => setObsOpen(true)} className="h-11 rounded-full px-4 shadow-pop">
                  <Plus /> Add observation
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <BulkActionDialog action={bulk} onClose={() => setBulk(null)} propertyIds={selectionPropertyIds} parcelIds={[]} />

      <Dialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save as territory"
        description={shape?.type === "circle" ? "The circle becomes a radius territory; membership is computed from it." : "The drawn polygon becomes the territory boundary; membership is computed from it."}
        footer={
          <>
            <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!territoryName.trim()} loading={saveTerritory.isPending} onClick={doSaveTerritory}>
              Save territory
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input autoFocus value={territoryName} onChange={(e) => setTerritoryName(e.target.value)} placeholder="e.g. North corridor infill" />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={territoryDesc} onChange={(e) => setTerritoryDesc(e.target.value)} />
          </Field>
          <Field label="Visibility">
            <Select
              value={territoryVisibility}
              onChange={(e) => setTerritoryVisibility(e.target.value)}
              options={[
                { value: "private", label: "Only me" },
                { value: "company", label: "Company-wide" },
              ]}
            />
          </Field>
          <p className="text-xs text-ink-3">
            Manage rules, nesting and role visibility later in <Link href="/territories" className="text-accent hover:underline">Territories</Link>.
          </p>
        </div>
      </Dialog>

      <ObservationDialog
        open={obsOpen}
        onOpenChange={setObsOpen}
        fix={fix}
        geoError={geoError}
        onLocate={locate}
        property={cardProperty}
        categories={config.data?.observation_categories}
        queue={queue}
      />
      <QueueDialog open={queueOpen} onOpenChange={setQueueOpen} queue={queue} />

      {!can("map") && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-surface/90">
          <div className="text-center">
            <Users className="mx-auto mb-2 size-5 text-ink-3" />
            <p className="text-sm font-medium text-ink">You do not have access to the map</p>
            <p className="text-sm text-ink-3">Ask an administrator for map view permission.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MapPage() {
  return (
    <Suspense>
      <MapWorkspace />
    </Suspense>
  );
}
