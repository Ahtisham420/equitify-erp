import * as Leaflet from "leaflet";

type LeafletNS = typeof Leaflet;

// Works for both the CommonJS and ESM builds of Leaflet.
const mod = Leaflet as LeafletNS & { default?: LeafletNS };
const base: LeafletNS = mod.default ?? mod;

// leaflet-draw is a classic plugin that assigns onto the global `L` (L.Draw, L.drawLocal, ...). An ESM module
// namespace is frozen, so in that case expose a mutable copy; the classes inside are shared, so maps created by
// react-leaflet still pick up the plugin's init hooks. This module is imported (client-only) before "leaflet-draw",
// and the map uses this same object, so `L.Draw` / `L.Control.Draw` are always defined on what it reads.
function globalLeaflet(): LeafletNS {
  if (typeof window === "undefined") return base;
  const w = window as unknown as { L?: LeafletNS };
  if (!w.L) w.L = Object.isExtensible(base) ? base : ({ ...base } as LeafletNS);
  return w.L;
}

const L: LeafletNS = globalLeaflet();

export default L;
