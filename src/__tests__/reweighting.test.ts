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
