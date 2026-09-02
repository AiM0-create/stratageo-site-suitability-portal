// v1.12.6 — applying a plan-card scenario must re-weight predictably.
//
// The scenario chips ("Balanced premium cafe", "Destination-led premium",
// "White-space premium") already sat on the plan card at the right moment —
// after the methodology is visible, before anything is spent — each carrying an
// `emphasis` naming the factors that should matter more. They rendered as
// <span>s, so the choice was readable and completely inert.
//
// Now they apply. The contract pinned here:
//   - always recompute from the weights captured BEFORE the first scenario, so
//     clicking through A -> B -> A lands on the same numbers rather than
//     compounding a x1.5 each time;
//   - preserve ratios and renormalise to 1 (the v1.0.0 postmortem invariant:
//     scale layers, never clamp one);
//   - do nothing, visibly, when a scenario carries no multipliers.

import { describe, it, expect } from 'vitest';
import { applyScenarioWeights, restoreWeights } from '../services/factorEditing';

type L = { id: string; name: string; weight: number; direction?: string };

const LAYERS: L[] = [
  { id: 'footfall',  name: 'Pedestrian footfall',    weight: 0.35 },
  { id: 'transit',   name: 'Transit / metro access', weight: 0.25 },
  { id: 'comp',      name: 'Direct cafe competition', weight: 0.20 },
  { id: 'cotenancy', name: 'Commercial co-tenancy',  weight: 0.20 },
];

const BASE = Object.fromEntries(LAYERS.map(l => [l.id, l.weight]));
const w = (ls: any[], id: string) => ls.find(l => l.id === id)!.weight;
const sum = (ls: any[]) => ls.reduce((s, l) => s + l.weight, 0);

describe('applyScenarioWeights', () => {
  it('boosts the emphasised factor and renormalises to 1', () => {
    const out = applyScenarioWeights(LAYERS as any, BASE, { cotenancy: 1.5 });

    expect(sum(out)).toBeCloseTo(1, 10);
    expect(w(out, 'cotenancy')).toBeGreaterThan(0.20);
    // everything else is diluted, but keeps its ratios to the others
    expect(w(out, 'footfall')).toBeLessThan(0.35);
    expect(w(out, 'footfall') / w(out, 'transit')).toBeCloseTo(0.35 / 0.25, 10);
  });

  it('boosts several factors when the scenario names a whole family', () => {
    const out = applyScenarioWeights(LAYERS as any, BASE, { footfall: 1.5, transit: 1.5 });

    expect(sum(out)).toBeCloseTo(1, 10);
    expect(w(out, 'footfall')).toBeGreaterThan(0.35);
    expect(w(out, 'transit')).toBeGreaterThan(0.25);
    expect(w(out, 'comp')).toBeLessThan(0.20);
  });

  // ── the reason `base` exists ──
  it('does not compound when scenarios are clicked in sequence', () => {
    const once  = applyScenarioWeights(LAYERS as any, BASE, { cotenancy: 1.5 });
    const twice = applyScenarioWeights(once as any, BASE, { cotenancy: 1.5 });

    expect(w(twice, 'cotenancy')).toBeCloseTo(w(once, 'cotenancy'), 10);
  });

  it('switching between scenarios is order-independent', () => {
    const a = applyScenarioWeights(LAYERS as any, BASE, { cotenancy: 1.5 });
    const b = applyScenarioWeights(a as any, BASE, { comp: 1.5 });
    const backToA = applyScenarioWeights(b as any, BASE, { cotenancy: 1.5 });

    expect(w(backToA, 'cotenancy')).toBeCloseTo(w(a, 'cotenancy'), 10);
    expect(w(backToA, 'footfall')).toBeCloseTo(w(a, 'footfall'), 10);
  });

  it('is a no-op when the scenario carries no multipliers', () => {
    expect(applyScenarioWeights(LAYERS as any, BASE, {})).toBe(LAYERS);
    expect(applyScenarioWeights(LAYERS as any, BASE, undefined)).toBe(LAYERS);
  });

  it('never produces a zero or negative weight', () => {
    const lopsided = { footfall: 0.97, transit: 0.01, comp: 0.01, cotenancy: 0.01 };
    const out = applyScenarioWeights(LAYERS as any, lopsided, { footfall: 1.5 });

    for (const l of out) expect(l.weight).toBeGreaterThan(0);
    expect(sum(out)).toBeCloseTo(1, 10);
  });

  it('falls back to the layer\'s own weight when base is missing an id', () => {
    const out = applyScenarioWeights(LAYERS as any, { footfall: 0.35 }, { cotenancy: 1.5 });

    expect(sum(out)).toBeCloseTo(1, 10);
    expect(w(out, 'cotenancy')).toBeGreaterThan(0.20);
  });

  it('leaves direction and every other field untouched', () => {
    const withDir = LAYERS.map(l => ({ ...l, direction: 'positive' }));
    const out = applyScenarioWeights(withDir as any, BASE, { comp: 1.5 });

    expect(out.every(l => (l as any).direction === 'positive')).toBe(true);
    expect(out.map(l => l.id)).toEqual(LAYERS.map(l => l.id));
  });
});

describe('restoreWeights', () => {
  it('puts the defaults back exactly', () => {
    const shifted = applyScenarioWeights(LAYERS as any, BASE, { cotenancy: 1.5 });
    const back = restoreWeights(shifted as any, BASE);

    for (const l of LAYERS) expect(w(back, l.id)).toBeCloseTo(l.weight, 10);
  });

  it('ignores ids it has no baseline for', () => {
    const back = restoreWeights(LAYERS as any, { footfall: 0.5 });

    expect(w(back, 'footfall')).toBe(0.5);
    expect(w(back, 'transit')).toBe(0.25);
  });
});
