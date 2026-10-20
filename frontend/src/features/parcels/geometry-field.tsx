"use client";

import { Field, Textarea } from "@/components/ui/input";
import { formatNumber } from "@/lib/utils";

import { formatBbox, parseGeoJson, summarizeGeoJson } from "./geojson";

/** Paste-GeoJSON input with live validation summary. The server (PostGIS) does the authoritative parse/repair. */
export function GeometryField({
  label = "Geometry (GeoJSON)",
  value,
  onChange,
  hint,
  className,
  placeholder = '{"type":"Polygon","coordinates":[[[-97.75,30.27],[-97.74,30.27],[-97.74,30.26],[-97.75,30.27]]]}',
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  className?: string;
  placeholder?: string;
}) {
  const { value: parsed, error } = parseGeoJson(value);
  const summary = summarizeGeoJson(parsed);
  return (
    <Field
      label={label}
      className={className}
      error={error}
      hint={
        summary
          ? `${summary.types.join(", ")} · ${formatNumber(summary.parts)} part${summary.parts === 1 ? "" : "s"} · ${formatNumber(summary.vertices)} vertices · bbox ${formatBbox(summary.bbox)}`
          : hint ?? "Paste a GeoJSON geometry, Feature or FeatureCollection (WGS84 lng/lat)."
      }
    >
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={!!error}
        className="font-mono text-xs"
      />
    </Field>
  );
}
