import { statusTone, type Tone } from "@/components/ui/badge";

/** Map styling reads the design tokens (CSS variables) so markers match badges and the rest of the UI. */
const TONE_TOKEN: Record<Tone, string> = {
  neutral: "ink-3",
  outline: "ink-3",
  blue: "accent",
  green: "positive",
  amber: "caution",
  red: "negative",
  sky: "info",
};

const cache = new Map<string, string>();

/** Resolves `rgb(var(--name) / alpha)` to a concrete colour string usable by SVG/canvas renderers. */
export function token(name: string, alpha = 1): string {
  const key = `${name}:${alpha}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let triplet = "138 138 147";
  if (typeof window !== "undefined") {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    if (raw) triplet = raw;
  }
  const [r, g, b] = triplet.split(/[\s,]+/);
  const value = alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  cache.set(key, value);
  return value;
}

export function toneToken(status?: string | null): string {
  return TONE_TOKEN[statusTone(status)];
}

export function statusColor(status?: string | null, alpha = 1): string {
  return token(toneToken(status), alpha);
}

/** CSS (not canvas) colour for legend swatches. */
export function cssStatusColor(status?: string | null): string {
  return `rgb(var(--${toneToken(status)}))`;
}

/** Layer identity colours (token names) used for legend swatches and non-status styling. */
export const LAYER_TOKEN: Record<string, string> = {
  properties: "ink-2",
  parcels: "ink-3",
  opportunities: "accent",
  assets: "positive",
  listings: "caution",
  comps: "ink-2",
  territories: "accent",
  signals: "negative",
  observations: "info",
};
