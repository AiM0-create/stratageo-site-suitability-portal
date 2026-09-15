// vNext (v1.8.0) — screening presentation helpers: deterministic projections
// of the analysis payload (exec summary, zone reasons, rank deltas,
// methodology comparison, CTA copy summary).

import { describe, it, expect } from 'vitest';
import {
  topEvidenceReasons, keyRisk, buildExecutiveSummary,
  topFactorSignals,
} from '../services/screeningPresentation';
import type { AnalysisResult, LocationData } from '../types';

const crit = (name: string, score: number | null, weight: number, direction: 'positive' | 'negative' = 'positive', extra: Record<string, unknown> = {}) => ({
  name, score, weight, direction, rawValue: 10, justification: '', evidenceBasis: 'osm-observed' as const, ...extra,
});

const loc = (name: string, mcda: number, criteria: any[] = [], extra: Record<string, unknown> = {}): LocationData => ({
  name, lat: 12.9, lng: 77.6, mcda_score: mcda, criteria_breakdown: criteria,
  exclusions: [], excluded: false, reasoning: '', osmSignals: {}, pois: [], searchRadiusM: 800,
  ...extra,
} as unknown as LocationData);

describe('topEvidenceReasons', () => {
  it('phrases factors in their real-world direction', () => {
    const reasons = topEvidenceReasons(loc('Z', 7, [
      crit('Residential demand', 8.4, 0.4, 'positive'),
      crit('Competitor saturation', 7.9, 0.3, 'negative'),
      crit('Road access', 3.0, 0.3, 'positive'),
    ]));
    expect(reasons[0]).toContain('Strong residential demand');
    expect(reasons[1]).toContain('Low competitor saturation');
    expect(reasons.some(r => r.includes('road access'))).toBe(false); // weak factor is not a strength
  });

  it('target-band factor phrased as balanced, never "no competition"', () => {
    const reasons = topEvidenceReasons(loc('Z', 7, [
      crit('Competitor saturation', 9.0, 0.5, 'negative', { scoringCurve: 'target_band' }),
    ]));
    expect(reasons[0]).toContain('Balanced');
    expect(reasons[0]).not.toMatch(/low competitor/i);
  });

  it('zone with only weak factors still gets one honest reason', () => {
    const reasons = topEvidenceReasons(loc('Z', 3, [crit('Demand', 3.2, 1)]));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('strongest available factor');
  });
});

describe('keyRisk', () => {
  it('surfaces the weakest scored factor', () => {
    expect(keyRisk(loc('Z', 6, [crit('Demand', 2.1, 0.5), crit('Access', 8, 0.5)])))
      .toContain('Weak demand');
  });
  it('negative-direction risk names the real-world problem', () => {
    expect(keyRisk(loc('Z', 6, [crit('Competitor saturation', 1.5, 1, 'negative')])))
      .toContain('High competitor saturation');
  });
  it('falls back to failed checks, then no-data factors, then null', () => {
    const failing = loc('Z', 7, [crit('Demand', 8, 1)], {
      exclusions: [{ rule: 'route: metro', passed: false, detail: 'Too far from metro', evidenceBasis: 'constraint-rule' }],
    });
    expect(keyRisk(failing)).toBe('Too far from metro');
    expect(keyRisk(loc('Z', 7, [crit('Demand', 8, 1), crit('Rent', null, 0.2)])))
      .toContain('could not be evaluated');
    expect(keyRisk(loc('Z', 7, [crit('Demand', 8, 1)]))).toBeNull();
  });
});

const res = (over: Partial<AnalysisResult> & Record<string, unknown> = {}): AnalysisResult => ({
  summary: '', business_type: 'organic grocery store', target_location: 'Bengaluru',
  methodology: '', spec: {} as any, locations: [], grounding_sources: [],
  ...over,
} as unknown as AnalysisResult);

describe('buildExecutiveSummary', () => {
  it('computes from actual payload values', () => {
    const top = loc('JP Nagar Cluster', 7.8, [crit('Demand', 8.5, 0.6)], {
      screeningVerdict: 'Priority',
      nextValidation: ['Verify rent with brokers', 'Walk the zone'],
    });
    const r = res({
      hexGrid: [
        { h3: 'a', score: 5, excluded: false, boundary: [] },
        { h3: 'b', score: 0, excluded: true, boundary: [] },
      ] as any,
      unifiedConfidence: { level: 'Medium', reason: '', components: {} },
      claimLevel: 'investigation_zone',
      analysisIntelligence: { spatialScale: 'micro_market' },
    });
    const ex = buildExecutiveSummary(r, [top]);
    expect(ex.screenedCells).toBe(2);
    expect(ex.eligibleCells).toBe(1);
    expect(ex.topZoneName).toBe('JP Nagar Cluster');
    expect(ex.topZoneVerdict).toBe('Priority');
    expect(ex.confidenceLevel).toBe('Medium');
    expect(ex.criticalNextCheck).toBe('Verify rent with brokers');
    expect(ex.claimLevel).toBe('investigation_zone');
    expect(ex.spatialScale).toBe('micro_market');
  });

  it('degrades gracefully on older payloads (nothing invented)', () => {
    const ex = buildExecutiveSummary(res(), []);
    expect(ex.topZoneName).toBeNull();
    expect(ex.screenedCells).toBeNull();
    expect(ex.verifiedCells).toBeNull();
    expect(ex.claimLevel).toBe('investigation_zone'); // conservative default
  });

  // v2.0.0 — "best of 112 eligible" over a 6.5 beside 8+ map cells read as a
  // contradiction; the number on a card is the best of the re-verified
  // shortlist, and the header must say so when the payload carries it.
  it('reports the verified shortlist size when the engine sends it', () => {
    const r = res({ shortlist: { size: 12, verified: 3, screened: 112, eligible: 112, separationRings: 2, basis: 'x' } });
    expect(buildExecutiveSummary(r, []).verifiedCells).toBe(12);
  });
});

describe('topFactorSignals (v1.11.2 scannable drivers)', () => {
  it('orders by weighted contribution and caps at n', () => {
    const signals = topFactorSignals(loc('Z', 7, [
      crit('Road access', 6.0, 0.1),
      crit('Residential demand', 9.0, 0.5),
      crit('Footfall', 7.0, 0.3),
      crit('Parking', 5.0, 0.05),
    ]), 3);
    expect(signals).toHaveLength(3);
    expect(signals[0].label).toBe('Residential demand');
    expect(signals.map(s => s.label)).not.toContain('Parking');
  });

  it('labels a negative factor so the bar needs no legend', () => {
    // Engine pre-inverts negatives: a HIGH score means LITTLE of it nearby.
    const [s] = topFactorSignals(loc('Z', 7, [
      crit('Competitor saturation', 8.0, 0.5, 'negative'),
    ]));
    expect(s.label).toBe('Competitor saturation — low nearby');
    expect(s.score).toBe(8.0);
  });

  it('labels a target-band factor as balance, never "low"', () => {
    const [s] = topFactorSignals(loc('Z', 7, [
      crit('Competitor saturation', 8.0, 0.5, 'negative', { scoringCurve: 'target_band' }),
    ]));
    expect(s.label).toBe('Competitor saturation — balance');
    expect(s.label).not.toMatch(/low/i);
  });

  it('strips noise suffixes so labels read plainly', () => {
    const [s] = topFactorSignals(loc('Z', 7, [crit('Demand density proxy', 7.0, 0.5)]));
    expect(s.label).toBe('Demand');
  });

  it('tones map to the traffic-light the bar colours use', () => {
    const signals = topFactorSignals(loc('Z', 7, [
      crit('A', 8.0, 0.4), crit('B', 5.0, 0.3), crit('C', 2.0, 0.3),
    ]), 3);
    expect(signals.find(s => s.label === 'A')!.tone).toBe('good');
    expect(signals.find(s => s.label === 'B')!.tone).toBe('mixed');
    expect(signals.find(s => s.label === 'C')!.tone).toBe('weak');
  });

  it('skips factors with no data rather than scoring them zero', () => {
    const signals = topFactorSignals(loc('Z', 7, [
      crit('Has data', 6.0, 0.3),
      crit('No data', null, 0.7),
    ]), 3);
    expect(signals).toHaveLength(1);
    expect(signals[0].label).toBe('Has data');
  });

  it('returns an empty list for a zone with no breakdown', () => {
    expect(topFactorSignals(loc('Z', 7, []))).toEqual([]);
  });
});
