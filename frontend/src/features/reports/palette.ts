/**
 * Fixed, ordered categorical palette for multi-series charts. Six distinct, colorblind-separable hues,
 * assigned in order and never cycled: charts show at most six series. Single-series charts use the
 * accent token instead (see SINGLE_SERIES).
 */
export const CATEGORICAL = ["#2557d6", "#e07b39", "#1f9d74", "#b9408f", "#8a6d1f", "#5b6b7d"] as const;

export const SINGLE_SERIES = "rgb(var(--accent))";

export const MAX_SERIES = CATEGORICAL.length;

/** Colour for series `index` of `count`; one series always uses the accent hue. */
export function seriesColor(index: number, count: number): string {
  if (count <= 1) return SINGLE_SERIES;
  return CATEGORICAL[Math.min(index, CATEGORICAL.length - 1)];
}

/** Recessive axis styling shared by every chart. */
export const AXIS_TICK = { fontSize: 11, fill: "rgb(var(--ink-3))" };
export const GRID_STROKE = "rgb(var(--line))";
