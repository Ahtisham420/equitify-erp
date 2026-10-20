/** Small GeoJSON helpers for pasted geometry input and read-only summaries (map UI ships in a later release). */

export type GeoJsonObject = { type: string; [key: string]: unknown };

export function parseGeoJson(text: string): { value: GeoJsonObject | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, error: null };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      return { value: null, error: "Expected a GeoJSON object with a \"type\"" };
    }
    return { value: parsed as GeoJsonObject, error: null };
  } catch {
    return { value: null, error: "Not valid JSON" };
  }
}

function collectPositions(coords: unknown, out: number[][]) {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    out.push(coords as number[]);
    return;
  }
  for (const c of coords) collectPositions(c, out);
}

function geometries(g: GeoJsonObject | null | undefined): GeoJsonObject[] {
  if (!g) return [];
  if (g.type === "Feature") return geometries(g.geometry as GeoJsonObject);
  if (g.type === "FeatureCollection") return ((g.features as GeoJsonObject[]) ?? []).flatMap((f) => geometries(f));
  if (g.type === "GeometryCollection") return ((g.geometries as GeoJsonObject[]) ?? []).flatMap((x) => geometries(x));
  return [g];
}

export interface GeoSummary {
  types: string[];
  parts: number;
  vertices: number;
  bbox: [number, number, number, number] | null;
}

export function summarizeGeoJson(g: GeoJsonObject | null | undefined): GeoSummary | null {
  const geoms = geometries(g);
  if (!geoms.length) return null;
  const positions: number[][] = [];
  let parts = 0;
  for (const geom of geoms) {
    collectPositions(geom.coordinates, positions);
    parts += geom.type.startsWith("Multi") && Array.isArray(geom.coordinates) ? (geom.coordinates as unknown[]).length : 1;
  }
  const xs = positions.map((p) => p[0]);
  const ys = positions.map((p) => p[1]);
  return {
    types: Array.from(new Set(geoms.map((x) => x.type))),
    parts,
    vertices: positions.length,
    bbox: positions.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null,
  };
}

export function formatBbox(b: GeoSummary["bbox"]): string {
  if (!b) return "—";
  return b.map((n) => n.toFixed(5)).join(", ");
}

export function downloadGeoJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
