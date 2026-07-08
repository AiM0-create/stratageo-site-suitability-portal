/**
 * v1.6.0 (Phase 2) — weight-slider reweighting engine tests.
 *
 * Covers the three guarantees the paid product depends on:
 * 1. Reversing weights flips the ranking (canonical test-prompt scenario:
 *    "Reverse the weights and tell me how the ranking changes").
 * 2. A factor with NO data is excluded from the composite entirely —
 *    never counted as a fabricated zero (backend honesty-rule parity).
 * 3. The map surface recomputes from per-cell factor scores so the
 *    choropleth never contradicts the re-ranked candidate list.
 */
import { describe, it, expect } from 'vitest';
import { recalculateWithWeights, reweightHexGrid, weightsDiffer } from '../services/mcdaEngine';
import type { LocationData, HexGridCell } from '../types';

const mkLoc = (name: string, scores: Record<string, number | null>, weights: Record<string, number>): LocationData => ({
  name, lat: 0, lng: 0, mcda_score: 0, excluded: false, reasoning: '',
  osmSignals: {}, pois: [], searchRadiusM: 800, exclusions: [],
  criteria_breakdown: Object.entries(scores).map(([n, s]) => ({
    name: n, score: s, weight: weights[n] ?? 0, direction: 'positive' as const,
    rawValue: 0, justification: '', evidenceBasis: 'osm-data' as const,
  })) as any,
});

describe('recalculateWithWeights', () => {
  const w = { 'Student population': 0.7, 'Low rent': 0.3 };
  // Site A: strong on students, weak on rent. Site B: the reverse.
  const A = mkLoc('A', { 'Student population': 9, 'Low rent': 3 }, w);
  const B = mkLoc('B', { 'Student population': 3, 'Low rent': 9 }, w);

  it('reversing the weights flips the ranking (canonical test prompt)', () => {
    const original = recalculateWithWeights([A, B], { 'Student population': 0.7, 'Low rent': 0.3 });
    expect(original[0].mcda_score).toBeGreaterThan(original[1].mcda_score); // A wins

    const reversed = recalculateWithWeights([A, B], { 'Student population': 0.3, 'Low rent': 0.7 });
    expect(reversed[1].mcda_score).toBeGreaterThan(reversed[0].mcda_score); // B wins
  });

  it('weighted mean matches hand math', () => {
    const [a] = recalculateWithWeights([A], { 'Student population': 0.7, 'Low rent': 0.3 });
    // (9*0.7 + 3*0.3) / 1.0 = 7.2
    expect(a.mcda_score).toBeCloseTo(7.2, 5);
  });

  it('a no-data factor is EXCLUDED, never a fabricated zero', () => {
    const withNull = mkLoc('C', { 'Student population': 8, 'Low rent': null }, w);
    const [c] = recalculateWithWeights([withNull], { 'Student population': 0.7, 'Low rent': 0.3 });
    // Present-weight renormalization: score must be 8.0 (only the factor with
    // data counts), NOT (8*0.7 + 0*0.3)/1.0 = 5.6 — the old buggy behavior.
    expect(c.mcda_score).toBeCloseTo(8.0, 5);
  });

  it('all factors missing → original score preserved, not zero', () => {
    const allNull = mkLoc('D', { 'Student population': null, 'Low rent': null }, w);
    allNull.mcda_score = 6.5;
    const [d] = recalculateWithWeights([allNull], w);
    expect(d.mcda_score).toBe(6.5);
  });

  it('empty custom weights returns input untouched', () => {
    const out = recalculateWithWeights([A], {});
    expect(out[0]).toBe(A);
  });
});

describe('reweightHexGrid', () => {
  const cell = (id: string, ls: Record<string, number>): HexGridCell => ({
    h3: id, score: 5, excluded: false, boundary: [], layerScores: ls,
  });

  it('recomputes cell composites from per-factor scores', () => {
    const grid = [cell('a', { X: 10, Y: 0 }), cell('b', { X: 0, Y: 10 })];
    const out = reweightHexGrid(grid, { X: 1, Y: 0 })!;
    expect(out[0].score).toBeCloseTo(10, 5);
    expect(out[1].score).toBeCloseTo(0, 5);
  });

  it('weight reversal flips which cell is darkest', () => {
    const grid = [cell('a', { X: 9, Y: 2 }), cell('b', { X: 2, Y: 9 })];
    const w1 = reweightHexGrid(grid, { X: 0.8, Y: 0.2 })!;
    const w2 = reweightHexGrid(grid, { X: 0.2, Y: 0.8 })!;
    expect(w1[0].score).toBeGreaterThan(w1[1].score);
    expect(w2[1].score).toBeGreaterThan(w2[0].score);
  });

  it('cells without layerScores keep their original score (older payloads)', () => {
    const legacy: HexGridCell = { h3: 'x', score: 7.2, excluded: false, boundary: [] };
    const out = reweightHexGrid([legacy], { X: 1 })!;
    expect(out[0].score).toBe(7.2);
  });

  it('undefined/empty grid passes through', () => {
    expect(reweightHexGrid(undefined, { X: 1 })).toBeUndefined();
    expect(reweightHexGrid([], { X: 1 })).toEqual([]);
  });
});

describe('weightsDiffer', () => {
  it('detects a real ratio change', () => {
    expect(weightsDiffer({ X: 0.7, Y: 0.3 }, { X: 0.3, Y: 0.7 })).toBe(true);
  });
  it('scale-equivalent sets are NOT different (only ratios rank)', () => {
    expect(weightsDiffer({ X: 0.7, Y: 0.3 }, { X: 1.4, Y: 0.6 })).toBe(false);
  });
  it('identical sets are not different', () => {
    expect(weightsDiffer({ X: 0.5, Y: 0.5 }, { X: 0.5, Y: 0.5 })).toBe(false);
  });
  it('both empty → not different', () => {
    expect(weightsDiffer({}, {})).toBe(false);
  });
});

// ── v1.6.6 — critique confidence field-mismatch regression ──────────────────
// The deterministic critic emits `confidenceLabel`; the UI read `confidence`
// and DEFAULTED the missing field to 'low', so every analysis displayed
// "CONFIDENCE: LOW" even when the verdict was Reliable/High (user-reported).
import { normalizeAnalysisResult } from '../services/resultNormalizer';

describe('critique confidence normalization (v1.6.6)', () => {
  const base = {
    status: 'success', locations: [], summary: '', hexGrid: [],
  };

  it('reads confidenceLabel from the deterministic critic', () => {
    const out = normalizeAnalysisResult({
      ...base,
      critique: { verdict: 'reliable', confidenceLabel: 'High', reasons: ['All deterministic checks passed.'] },
    } as any);
    expect((out as any).critique.confidence).toBe('High');
  });

  it('never invents "low" when no confidence field exists', () => {
    const out = normalizeAnalysisResult({
      ...base,
      critique: { verdict: 'reliable' },
    } as any);
    expect((out as any).critique.confidence).toBe('');
  });

  it('deterministic critic reasons surface as issues for display', () => {
    const out = normalizeAnalysisResult({
      ...base,
      critique: { verdict: 'weak', confidenceLabel: 'Medium', reasons: ['Coverage thin in the north.'] },
    } as any);
    expect((out as any).critique.issues).toEqual(['Coverage thin in the north.']);
  });

  it('an explicit LLM-critic confidence still wins', () => {
    const out = normalizeAnalysisResult({
      ...base,
      critique: { verdict: 'reliable', confidence: 'high', confidenceLabel: 'High' },
    } as any);
    expect((out as any).critique.confidence).toBe('high');
  });
});

// ── v1.6.7 — grid ranks + client-side top-X re-selection ────────────────────
import { computeGridRanks, selectTopCellsFromGrid } from '../services/mcdaEngine';

const gridCell = (h3: string, score: number, lat: number, lng: number, excluded = false): HexGridCell => ({
  h3, score, excluded,
  // ~350m-wide pseudo-hex around the centroid
  boundary: [
    [lat + 0.0016, lng], [lat + 0.0008, lng + 0.0014], [lat - 0.0008, lng + 0.0014],
    [lat - 0.0016, lng], [lat - 0.0008, lng - 0.0014], [lat + 0.0008, lng - 0.0014],
  ] as [number, number][],
});

describe('computeGridRanks (v1.6.7)', () => {
  it('ranks eligible cells 1..n by score, excluded cells unranked', () => {
    const g = [gridCell('a', 8, 22.50, 88.30), gridCell('b', 9, 22.52, 88.32),
               gridCell('c', 3, 22.54, 88.34), gridCell('x', 10, 22.56, 88.36, true)];
    const { ranks, total } = computeGridRanks(g);
    expect(total).toBe(3);
    expect(ranks['b']).toBe(1);
    expect(ranks['a']).toBe(2);
    expect(ranks['c']).toBe(3);
    expect(ranks['x']).toBeUndefined();
  });

  it('re-ranking responds to reweighted scores (the whole point)', () => {
    const g1 = [gridCell('a', 8, 22.5, 88.3), gridCell('b', 6, 22.6, 88.4)];
    const g2 = [gridCell('a', 4, 22.5, 88.3), gridCell('b', 6, 22.6, 88.4)];
    expect(computeGridRanks(g1).ranks['a']).toBe(1);
    expect(computeGridRanks(g2).ranks['b']).toBe(1);
  });
});

describe('selectTopCellsFromGrid (v1.6.7)', () => {
  it('picks the best-scoring, spatially separated cells', () => {
    const g = [
      gridCell('best', 9.5, 22.500, 88.300),
      gridCell('neighbour', 9.4, 22.503, 88.300),   // ~330m away → within 2-ring sep
      gridCell('far', 8.0, 22.560, 88.360),          // ~9km away
      gridCell('weak', 2.0, 22.700, 88.500),
    ];
    const picks = selectTopCellsFromGrid(g, 2, 2);
    expect(picks.map(p => p.h3)).toEqual(['best', 'far']);  // near-duplicate skipped
    expect(picks[0].rank).toBe(1);
  });

  it('never selects excluded cells and respects topX', () => {
    const g = [gridCell('a', 9, 22.5, 88.3, true), gridCell('b', 8, 22.6, 88.4), gridCell('c', 7, 22.7, 88.5)];
    const picks = selectTopCellsFromGrid(g, 5, 2);
    expect(picks.map(p => p.h3)).toEqual(['b', 'c']);
  });

  it('empty/undefined grid → empty selection', () => {
    expect(selectTopCellsFromGrid(undefined, 3)).toEqual([]);
    expect(selectTopCellsFromGrid([], 3)).toEqual([]);
  });
});
