/**
 * v1.11.4 — plan-card factor editing.
 *
 * Pure helpers so the weight arithmetic is testable away from React. They exist
 * because the plan card's weight input was silently destroying the framework:
 * the handler assigned the typed PERCENTAGE straight onto `layer.weight`, while
 * the display renders `weight / sum(weights) * 100`. Archetype weights are
 * fractions (0.35, 0.25, …) summing to ~1, so typing "25" set one layer to 25
 * against a total of ~25.65 — that layer showed 97% and every other factor
 * collapsed to 0%. One edit wrecked the whole plan, which is what the live
 * "00% / 0% / 0% / 0%" screenshot was showing.
 */
import type { SpecV2 } from '../types/chat';

type Layer = SpecV2['layers'][number];

/** Layer.weight must stay strictly positive (the backend validator enforces gt=0). */
const MIN_WEIGHT = 0.01;

/**
 * Percent shares that always sum to exactly 100.
 *
 * Rounding each share independently does not: 0.35/0.25/0.25 renders as
 * 41 + 29 + 29 = 99%, and a plan card that labels a column "Wt" owes the reader
 * percentages that add up. Largest-remainder (Hare quota) apportionment fixes
 * that — floor everything, then hand the leftover points to the rows with the
 * biggest truncated fractions.
 */
export function weightPercents(layers: Layer[]): number[] {
  const total = layers.reduce((s, l) => s + (l.weight || 0), 0);
  if (!(total > 0) || layers.length === 0) return layers.map(() => 0);

  const exact = layers.map(l => ((l.weight || 0) / total) * 100);
  const floors = exact.map(Math.floor);
  let remaining = 100 - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  const out = [...floors];
  for (let k = 0; remaining > 0 && k < order.length; k++, remaining--) {
    out[order[k].i] += 1;
  }
  return out;
}

/** Percent share of one layer, consistent with weightPercents(). */
export function weightPercent(layer: Layer, layers: Layer[]): number {
  const idx = layers.findIndex(l => l.id === layer.id);
  if (idx < 0) return 0;
  return weightPercents(layers)[idx];
}

/**
 * Set one layer to `pct`% of the total, holding every other layer's weight
 * fixed so their ratios to each other are preserved.
 *
 * Solve w / (w + rest) = pct/100  →  w = rest * pct / (100 - pct).
 * This is what "others renormalize proportionally" was always meant to mean.
 */
export function setLayerWeightPercent(
  layers: Layer[], layerId: string, pct: number,
): Layer[] {
  if (!Number.isFinite(pct)) return layers;
  const target = layers.find(l => l.id === layerId);
  if (!target) return layers;

  // 1..99: a factor can be neither absent (use remove) nor the only one.
  const p = Math.min(99, Math.max(1, Math.round(pct)));
  const rest = layers.reduce((s, l) => (l.id === layerId ? s : s + (l.weight || 0)), 0);

  // Sole layer: nothing to renormalize against — it is 100% by definition.
  if (rest <= 0) return layers.map(l => (l.id === layerId ? { ...l, weight: 1 } : l));

  const w = Math.max(MIN_WEIGHT, (rest * p) / (100 - p));
  return layers.map(l => (l.id === layerId ? { ...l, weight: w } : l));
}

/**
 * v1.12.6 — apply a plan-card scenario's emphasis to the factor weights.
 *
 * Always computed from `base` (the weights before any scenario was applied),
 * never from the current weights, so clicking through Destination-led ->
 * White-space -> Destination-led lands on the same numbers every time instead
 * of compounding. Ratios are preserved and renormalised to sum 1 — the same
 * rule as the sliders, and the v1.0.0 postmortem's invariant: never clamp a
 * layer, scale it.
 *
 * Returns `layers` unchanged when there is nothing applicable, so callers can
 * treat "no multipliers" and "no-op" identically.
 */
export function applyScenarioWeights(
  layers: Layer[],
  base: Record<string, number>,
  multipliers: Record<string, number> | undefined,
): Layer[] {
  if (!multipliers || Object.keys(multipliers).length === 0) return layers;

  const scaled = layers.map(l => {
    const b = Number.isFinite(base[l.id]) ? base[l.id] : (l.weight || 0);
    const m = Number.isFinite(multipliers[l.id]) ? multipliers[l.id] : 1;
    return { layer: l, w: Math.max(MIN_WEIGHT, b * m) };
  });

  const total = scaled.reduce((s, x) => s + x.w, 0);
  if (!(total > 0)) return layers;

  return scaled.map(({ layer, w }) => ({ ...layer, weight: w / total }));
}

/** Restore the weights captured before any scenario was applied. */
export function restoreWeights(layers: Layer[], base: Record<string, number>): Layer[] {
  return layers.map(l => (Number.isFinite(base[l.id]) ? { ...l, weight: base[l.id] } : l));
}

/** Flip a factor between "more is better" and "less is better". */
export function toggleLayerDirection(layers: Layer[], layerId: string): Layer[] {
  return layers.map(l =>
    l.id === layerId
      ? { ...l, direction: l.direction === 'negative' ? 'positive' : 'negative' }
      : l,
  );
}

/**
 * Drop a factor. The remaining weights keep their ratios (they are only ever
 * read as a share of the total), so no rescaling is needed. Never removes the
 * last factor — a zero-layer spec fails backend validation.
 */
export function removeLayer(layers: Layer[], layerId: string): Layer[] {
  if (layers.length <= 1) return layers;
  return layers.filter(l => l.id !== layerId);
}

/**
 * The message sent to the planner when the user asks for a brand-new factor.
 *
 * Adding a factor is NOT a pure frontend edit: a layer needs a real data source
 * (OSM tags or Google Places types) and a catchment, and inventing those in the
 * browser would produce a layer that either matches nothing or silently
 * measures the wrong thing. So the request goes through the planner, which
 * owns source selection — the user still just types what they care about.
 */
export function buildAddFactorPrompt(name: string, direction: 'positive' | 'negative'): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  const sense = direction === 'negative'
    ? 'Less of it should score higher.'
    : 'More of it should score higher.';
  return `Add a scoring factor for "${clean}". ${sense} Pick a suitable data source and weight, and keep the rest of the plan unchanged.`;
}
