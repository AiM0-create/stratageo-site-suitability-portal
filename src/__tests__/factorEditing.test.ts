// v1.11.4 — plan-card factor editing.
//
// The bug these pin down: the weight input assigned the typed PERCENTAGE
// directly onto layer.weight while the card renders weight/sum*100. Archetype
// weights are fractions summing to ~1, so typing "25" set one layer to 25
// against a total of ~25.65 — it showed 97% and every other factor collapsed
// to 0%. A single edit destroyed the framework (the live "00% / 0% / 0% / 0%").

import { describe, it, expect } from 'vitest';
import {
  weightPercent, weightPercents, setLayerWeightPercent, toggleLayerDirection, removeLayer,
  buildAddFactorPrompt,
} from '../services/factorEditing';
import type { SpecV2 } from '../types/chat';

type Layer = SpecV2['layers'][number];

const layer = (id: string, weight: number, direction: 'positive' | 'negative' = 'positive'): Layer => ({
  id, name: id, weight, direction,
  source: { provider: 'osm', tags: ['amenity=cafe'] },
  catchment: { type: 'walk', minutes: 10 },
} as unknown as Layer);

// Typical archetype output: fractions summing to 1.
const FRACTIONS = () => [
  layer('demand', 0.35), layer('transit', 0.25),
  layer('competition', 0.25, 'negative'), layer('cotenancy', 0.15),
];

const pcts = (ls: Layer[]) => ls.map(l => weightPercent(l, ls));

describe('weightPercent', () => {
  it('renders each layer as its share of the total', () => {
    expect(pcts(FRACTIONS())).toEqual([35, 25, 25, 15]);
  });

  it('is unit-agnostic — same ratios in any scale', () => {
    const scaled = [layer('a', 35), layer('b', 25), layer('c', 25), layer('d', 15)];
    expect(pcts(scaled)).toEqual([35, 25, 25, 15]);
  });

  it('does not divide by zero on a degenerate spec', () => {
    expect(weightPercent(layer('a', 0), [layer('a', 0)])).toBe(0);
  });
});

describe('setLayerWeightPercent — the regression', () => {
  it('sets the edited factor to exactly the requested percent', () => {
    const out = setLayerWeightPercent(FRACTIONS(), 'demand', 50);
    expect(weightPercent(out[0], out)).toBe(50);
  });

  it('does NOT collapse the other factors to 0% (the reported bug)', () => {
    const out = setLayerWeightPercent(FRACTIONS(), 'demand', 25);
    const others = pcts(out).slice(1);
    expect(others.every(p => p > 0)).toBe(true);
    expect(others.reduce((a, b) => a + b, 0)).toBe(75);
  });

  it('preserves the ratios between the untouched factors', () => {
    const before = FRACTIONS();
    const out = setLayerWeightPercent(before, 'demand', 60);
    // transit:competition was 25:25 = 1.0 and must stay 1.0
    const r = (ls: Layer[]) => ls[1].weight / ls[2].weight;
    expect(r(out)).toBeCloseTo(r(before), 10);
    // cotenancy:transit was 15:25 = 0.6
    expect(out[3].weight / out[1].weight).toBeCloseTo(0.6, 10);
  });

  it('percentages still sum to 100 after an edit', () => {
    const out = setLayerWeightPercent(FRACTIONS(), 'competition', 40);
    expect(pcts(out).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('clamps out-of-range input to a valid, still-solvable spec', () => {
    // Every layer must keep a strictly positive weight (backend validator is
    // gt=0). At the 99% ceiling the other factors legitimately DISPLAY as 0%,
    // but their weights must never actually reach zero.
    for (const bad of [0, -20, 100, 150]) {
      const out = setLayerWeightPercent(FRACTIONS(), 'demand', bad);
      expect(out.every(l => Number.isFinite(l.weight) && l.weight > 0)).toBe(true);
      const p = pcts(out);
      expect(p.reduce((a, b) => a + b, 0)).toBe(100);
      expect(p[0]).toBeGreaterThanOrEqual(1);
      expect(p[0]).toBeLessThanOrEqual(99);
    }
  });

  it('ignores NaN and unknown ids rather than corrupting the spec', () => {
    const before = FRACTIONS();
    expect(setLayerWeightPercent(before, 'demand', NaN)).toBe(before);
    expect(setLayerWeightPercent(before, 'nope', 30)).toBe(before);
  });

  it('a sole factor is simply 100%', () => {
    const out = setLayerWeightPercent([layer('only', 0.4)], 'only', 30);
    expect(weightPercent(out[0], out)).toBe(100);
    expect(out[0].weight).toBeGreaterThan(0);
  });

  it('repeated edits stay stable (no drift toward zero)', () => {
    let ls = FRACTIONS();
    for (const p of [40, 20, 55, 30, 45]) ls = setLayerWeightPercent(ls, 'demand', p);
    expect(weightPercent(ls[0], ls)).toBe(45);
    expect(pcts(ls).every(x => x > 0)).toBe(true);
  });
});

describe('toggleLayerDirection', () => {
  it('flips only the named factor', () => {
    const out = toggleLayerDirection(FRACTIONS(), 'demand');
    expect(out[0].direction).toBe('negative');
    expect(out[1].direction).toBe('positive');
    expect(out[2].direction).toBe('negative');
  });

  it('round-trips back to the original', () => {
    const once = toggleLayerDirection(FRACTIONS(), 'competition');
    expect(once[2].direction).toBe('positive');
    expect(toggleLayerDirection(once, 'competition')[2].direction).toBe('negative');
  });

  it('leaves weights untouched', () => {
    const out = toggleLayerDirection(FRACTIONS(), 'demand');
    expect(out.map(l => l.weight)).toEqual(FRACTIONS().map(l => l.weight));
  });
});

describe('removeLayer', () => {
  it('drops the factor and keeps the rest summing to 100%', () => {
    const out = removeLayer(FRACTIONS(), 'cotenancy');
    expect(out).toHaveLength(3);
    expect(pcts(out).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('preserves the surviving factors ratios', () => {
    const out = removeLayer(FRACTIONS(), 'cotenancy');
    expect(out[0].weight / out[1].weight).toBeCloseTo(0.35 / 0.25, 10);
  });

  it('refuses to remove the last factor (backend requires >= 1 layer)', () => {
    const one = [layer('only', 1)];
    expect(removeLayer(one, 'only')).toBe(one);
  });
});

describe('buildAddFactorPrompt', () => {
  it('states the direction so the planner encodes it correctly', () => {
    expect(buildAddFactorPrompt('parking availability', 'positive'))
      .toContain('More of it should score higher');
    expect(buildAddFactorPrompt('crime rate', 'negative'))
      .toContain('Less of it should score higher');
  });

  it('keeps the rest of the plan intact and names the factor', () => {
    const p = buildAddFactorPrompt('  student   density ', 'positive');
    expect(p).toContain('"student density"');
    expect(p).toContain('keep the rest of the plan unchanged');
  });
});

describe('weightPercents — displayed shares always total 100', () => {
  it('fixes the 41+29+29=99 rounding gap', () => {
    const three = [layer('a', 0.35), layer('b', 0.25), layer('c', 0.25)];
    const p = weightPercents(three);
    expect(p.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('totals 100 across many awkward splits', () => {
    const splits = [
      [1, 1, 1], [1, 1, 1, 1, 1, 1, 1], [0.333, 0.333, 0.334],
      [0.07, 0.07, 0.07, 0.79], [2, 3, 5, 7, 11],
    ];
    for (const s of splits) {
      const ls = s.map((w, i) => layer(`l${i}`, w));
      expect(weightPercents(ls).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });

  it('gives the spare point to the largest remainder, not the first row', () => {
    // 1/3 each -> 33.33 each; one row must get 34.
    const p = weightPercents([layer('a', 1), layer('b', 1), layer('c', 1)]);
    expect(p.filter(x => x === 34)).toHaveLength(1);
    expect(p.filter(x => x === 33)).toHaveLength(2);
  });

  it('keeps ordering — a heavier factor never shows a smaller share', () => {
    const ls = [layer('big', 0.5), layer('mid', 0.3), layer('small', 0.2)];
    const p = weightPercents(ls);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[1]).toBeGreaterThan(p[2]);
  });

  it('degenerate specs return zeros rather than NaN', () => {
    expect(weightPercents([])).toEqual([]);
    expect(weightPercents([layer('a', 0)])).toEqual([0]);
  });
});
