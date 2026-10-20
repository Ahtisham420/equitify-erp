"use client";

/**
 * Client-only Leaflet map. Load it with `next/dynamic(..., { ssr: false })` — Leaflet touches `window` on import.
 */
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";

import type * as LT from "leaflet";
import L from "@/features/map/leaflet-global";
import "leaflet-draw";

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";

import type { DrawnShape, FeatureProps, LayerKey, LayersResponse } from "@/features/map/api";
import { LAYER_ORDER } from "@/features/map/api";
import { statusColor, token } from "@/features/map/colors";

export interface MapView {
  bbox: string;
  lat: number;
  lng: number;
  zoom: number;
}

export interface MapCanvasProps {
  tileUrl: string;
  attribution: string;
  initialCenter: [number, number];
  initialZoom: number;
  data: LayersResponse["layers"] | undefined;
  visible: LayerKey[];
  selectedPropertyIds: Set<string>;
  activeId: string | null;
  shape: DrawnShape | null;
  radius: { lat: number; lng: number; radius_m: number } | null;
  highlight: GeoJSON.Geometry | null;
  position: { lat: number; lng: number; accuracy: number | null } | null;
  pending: { lat: number; lng: number }[];
  picking: boolean;
  drawEnabled: boolean;
  flyTo: { lat: number; lng: number; zoom?: number; seq: number } | null;
  onView: (view: MapView) => void;
  onFeature: (props: FeatureProps) => void;
  onMapClick: (lat: number, lng: number) => void;
  onDrawn: (shape: DrawnShape) => void;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function ViewWatcher({ onView, onMapClick }: Pick<MapCanvasProps, "onView" | "onMapClick">) {
  const viewRef = useLatest(onView);
  const clickRef = useLatest(onMapClick);
  const map = useMapEvents({
    moveend: () => emit(),
    click: (e) => clickRef.current(e.latlng.lat, e.latlng.lng),
  });

  function emit() {
    const b = map.getBounds();
    const c = map.getCenter();
    const bbox = [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)]
      .map((v) => v.toFixed(5))
      .join(",");
    viewRef.current({ bbox, lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  }

  useEffect(() => {
    emit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function SizeWatcher() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function markerStyle(key: LayerKey, p: FeatureProps, active: boolean, selected: boolean): LT.CircleMarkerOptions {
  const surface = token("surface");
  let o: LT.CircleMarkerOptions;
  switch (key) {
    case "opportunities":
      o = { radius: 9, color: statusColor(p.status), weight: 2.5, fillColor: statusColor(p.status), fillOpacity: 0.1 };
      break;
    case "assets":
      o = { radius: 6, color: token("ink"), weight: 1, fillColor: token("positive"), fillOpacity: 0.9 };
      break;
    case "listings":
      o = { radius: 8, color: token("caution"), weight: 2, dashArray: "3 3", fillColor: token("caution"), fillOpacity: 0.08 };
      break;
    case "comps":
      o = { radius: 4.5, color: surface, weight: 1, fillColor: token("ink-2"), fillOpacity: 0.75 };
      break;
    case "signals": {
      const sev = Number(p.severity ?? 3);
      o = { radius: 12, color: token("negative", 0.7), weight: 1, fillColor: token("negative"), fillOpacity: 0.05 + sev * 0.04 };
      break;
    }
    case "observations":
      o = { radius: 5, color: surface, weight: 1.5, fillColor: token("info"), fillOpacity: 0.9 };
      break;
    default:
      o = { radius: 6, color: surface, weight: 1.5, fillColor: statusColor(p.status), fillOpacity: 0.9 };
  }
  if (selected) o = { ...o, color: token("accent"), weight: 3 };
  if (active) o = { ...o, color: token("ink"), weight: 3 };
  return o;
}

function pathStyle(key: LayerKey, p: FeatureProps | undefined, active: boolean): LT.PathOptions {
  if (key === "territories") {
    return { color: token("accent", 0.8), weight: active ? 2.5 : 1.5, dashArray: "5 4", fillColor: token("accent"), fillOpacity: 0.04 };
  }
  const linked = p?.status === "linked";
  return {
    color: active ? token("ink") : linked ? token("accent", 0.75) : token("ink-3", 0.8),
    weight: active ? 2.5 : 1,
    fillColor: linked ? token("accent") : token("ink-3"),
    fillOpacity: active ? 0.18 : 0.06,
  };
}

function tooltip(label: string) {
  const el = document.createElement("span");
  el.textContent = label;
  return el;
}

function DataLayers({
  data, visible, selectedPropertyIds, activeId, picking, onFeature,
}: Pick<MapCanvasProps, "data" | "visible" | "selectedPropertyIds" | "activeId" | "picking" | "onFeature">) {
  const map = useMap();
  const featureRef = useLatest(onFeature);
  const pickingRef = useLatest(picking);

  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    for (const key of LAYER_ORDER) {
      const fc = data?.[key];
      if (!fc || !visible.includes(key)) continue;
      L.geoJSON<FeatureProps>(fc as unknown as GeoJSON.FeatureCollection, {
        style: (f) => pathStyle(key, f?.properties, !!f && f.properties.id === activeId),
        pointToLayer: (f, latlng) =>
          L.circleMarker(latlng, markerStyle(key, f.properties, f.properties.id === activeId,
            !!f.properties.property_id && selectedPropertyIds.has(String(f.properties.property_id)))),
        onEachFeature: (f, layer) => {
          layer.bindTooltip(tooltip(f.properties.label), { direction: "top", offset: [0, -6], opacity: 0.95 });
          layer.on("click", () => {
            if (!pickingRef.current) featureRef.current(f.properties);
          });
        },
      }).addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [map, data, visible, selectedPropertyIds, activeId, featureRef, pickingRef]);
  return null;
}

function Overlays({ shape, radius, highlight, position, pending }: Pick<MapCanvasProps, "shape" | "radius" | "highlight" | "position" | "pending">) {
  const map = useMap();
  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    const accent = { color: token("accent"), weight: 2, dashArray: "6 4", fillColor: token("accent"), fillOpacity: 0.06, interactive: false };
    if (shape?.type === "polygon") {
      L.geoJSON(shape.geometry, { style: () => accent, interactive: false }).addTo(group);
    } else if (shape?.type === "circle") {
      L.circle([shape.lat, shape.lng], { ...accent, radius: shape.radius_m }).addTo(group);
    }
    if (radius) {
      L.circle([radius.lat, radius.lng], { color: token("accent"), weight: 1.5, fillColor: token("accent"), fillOpacity: 0.05, radius: radius.radius_m, interactive: false }).addTo(group);
      L.circleMarker([radius.lat, radius.lng], { radius: 3, color: token("accent"), fillOpacity: 1, interactive: false }).addTo(group);
    }
    if (highlight) {
      L.geoJSON(highlight as GeoJSON.GeoJsonObject, {
        style: () => ({ color: token("caution"), weight: 3, fillColor: token("caution"), fillOpacity: 0.15 }),
        interactive: false,
      }).addTo(group);
    }
    for (const p of pending) {
      L.circleMarker([p.lat, p.lng], { radius: 5, color: token("info"), weight: 2, dashArray: "2 2", fillOpacity: 0, interactive: false }).addTo(group);
    }
    if (position) {
      if (position.accuracy) {
        L.circle([position.lat, position.lng], { radius: position.accuracy, color: token("info", 0.4), weight: 1, fillColor: token("info"), fillOpacity: 0.08, interactive: false }).addTo(group);
      }
      L.circleMarker([position.lat, position.lng], { radius: 7, color: token("surface"), weight: 2.5, fillColor: token("info"), fillOpacity: 1, interactive: false }).addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [map, shape, radius, highlight, position, pending]);
  return null;
}

function DrawControl({ enabled, onDrawn }: { enabled: boolean; onDrawn: (shape: DrawnShape) => void }) {
  const map = useMap();
  const drawnRef = useLatest(onDrawn);

  useEffect(() => {
    if (!enabled) return;
    const shapeOptions: LT.PathOptions = { color: token("accent"), weight: 2, fillColor: token("accent"), fillOpacity: 0.08 };
    // showArea is disabled: leaflet-draw 1.0.4 throws while measuring rectangles with it on.
    const control = new L.Control.Draw({
      position: "topleft",
      draw: {
        polyline: false,
        marker: false,
        circlemarker: false,
        polygon: { allowIntersection: false, showArea: false, shapeOptions } as LT.DrawOptions.PolygonOptions,
        rectangle: { showArea: false, shapeOptions } as LT.DrawOptions.RectangleOptions,
        circle: { shapeOptions } as LT.DrawOptions.CircleOptions,
      },
    });
    map.addControl(control);
    const created = (e: LT.LeafletEvent) => {
      const ev = e as LT.LeafletEvent & { layer: LT.Layer; layerType: string };
      if (ev.layerType === "circle") {
        const c = ev.layer as LT.Circle;
        const ll = c.getLatLng();
        drawnRef.current({ type: "circle", lat: ll.lat, lng: ll.lng, radius_m: c.getRadius() });
        return;
      }
      const geometry = (ev.layer as LT.Polygon).toGeoJSON().geometry;
      if (geometry.type === "Polygon") drawnRef.current({ type: "polygon", geometry });
    };
    map.on(L.Draw.Event.CREATED, created);
    return () => {
      map.off(L.Draw.Event.CREATED, created);
      map.removeControl(control);
    };
  }, [map, enabled, drawnRef]);
  return null;
}

function FlyTo({ target }: { target: MapCanvasProps["flyTo"] }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], target.zoom ?? Math.max(map.getZoom(), 16), { duration: 0.6 });
    // Re-fly only when a new request (seq) arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, target?.seq]);
  return null;
}

function Cursor({ picking }: { picking: boolean }) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    el.style.cursor = picking ? "crosshair" : "";
    return () => {
      el.style.cursor = "";
    };
  }, [map, picking]);
  return null;
}

export default function MapCanvas(props: MapCanvasProps) {
  return (
    <MapContainer center={props.initialCenter} zoom={props.initialZoom} preferCanvas className="h-full w-full" style={{ background: token("subtle") }}>
      <TileLayer url={props.tileUrl} attribution={props.attribution} maxZoom={19} />
      <ViewWatcher onView={props.onView} onMapClick={props.onMapClick} />
      <SizeWatcher />
      <Cursor picking={props.picking} />
      <DataLayers
        data={props.data}
        visible={props.visible}
        selectedPropertyIds={props.selectedPropertyIds}
        activeId={props.activeId}
        picking={props.picking}
        onFeature={props.onFeature}
      />
      <Overlays shape={props.shape} radius={props.radius} highlight={props.highlight} position={props.position} pending={props.pending} />
      <DrawControl enabled={props.drawEnabled} onDrawn={props.onDrawn} />
      <FlyTo target={props.flyTo} />
    </MapContainer>
  );
}
