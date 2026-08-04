// vNext (v1.8.0) — screening presentation helpers: deterministic projections
// of the analysis payload (exec summary, zone reasons, rank deltas,
// methodology comparison, CTA copy summary).

import { describe, it, expect } from 'vitest';
import {
  topEvidenceReasons, keyRisk, computeRankDeltas,
  buildExecutiveSummary, buildMethodologyComparison, buildCopySummary,
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

describe('computeRankDeltas (§8.3)', () => {
  const A = loc('A', 8), B = loc('B', 7), C = loc('C', 6);
  it('tracks movement between original and reweighted lists', () => {
    const reweighted = [loc('B', 8.2), loc('A', 7.1), loc('C', 6.5)];
    const d = computeRankDeltas([A, B, C], reweighted);
    expect(d['B']).toEqual({ prevRank: 2, newRank: 1, moved: 1 });
    expect(d['A']).toEqual({ prevRank: 1, newRank: 2, moved: -1 });
    expect(d['C'].moved).toBe(0);
  });
  it('marks zones absent from the original shortlist as newly introduced', () => {
    const d = computeRankDeltas([A, B], [loc('NEW', 9), loc('A', 8), loc('B', 7)]);
    expect(d['NEW'].prevRank).toBeNull();
    expect(d['NEW'].moved).toBeNull();
  });
  it('excluded zones never get ranks', () => {
    const d = computeRankDeltas([A], [loc('A', 8), loc('X', 9, [], { excluded: true })]);
    expect(d['X']).toBeUndefined();
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
    expect(ex.claimLevel).toBe('investigation_zone'); // conservative default
  });
});

describe('buildMethodologyComparison (§9)', () => {
  const withFactors = (names: string[], scale: string | null, biz = 'organic grocery store') =>
    res({
      business_type: biz,
      dataQuality: names.map(n => ({ name: n, provider: 'osm', weight: 0.2, featureCount: 5, lowCoverage: false, nonDiscriminating: false })),
      ...(scale ? { analysisIntelligence: { spatialScale: scale } } : {}),
    });

  it('reports retained / added / removed criteria and the scale change', () => {
    const prev = withFactors(['Residential demand', 'Competition'], 'micro_market');
    const next = withFactors(['Residential demand', 'Competition', 'Arterial connectivity'], 'metro_region');
    const cmp = buildMethodologyComparison(prev, next)!;
    expect(cmp.retained).toEqual(['Residential demand', 'Competition']);
    expect(cmp.added).toEqual(['Arterial connectivity']);
    expect(cmp.removed).toEqual([]);
    expect(cmp.scaleChange).toEqual({ from: 'micro_market', to: 'metro_region' });
  });

  it('returns null for a different business or no previous run', () => {
    expect(buildMethodologyComparison(null, withFactors(['A'], null))).toBeNull();
    expect(buildMethodologyComparison(
      withFactors(['A'], null, 'gym'), withFactors(['A'], null, 'cafe'),
    )).toBeNull();
  });

  it('returns null when nothing actually changed', () => {
    const a = withFactors(['A', 'B'], 'locality');
    expect(buildMethodologyComparison(a, withFactors(['A', 'B'], 'locality'))).toBeNull();
  });
});

describe('buildCopySummary (§7 CTA)', () => {
  it('contains only computed values, never the raw prompt', () => {
    const zones = [
      loc('Zone One', 7.5, [], { screeningVerdict: 'Priority', nextValidation: ['Verify rent'] }),
      loc('Zone Two', 6.9, [], { screeningVerdict: 'Promising' }),
    ];
    const text = buildCopySummary(res({ jobRef: 'abc12345', unifiedConfidence: { level: 'Medium', reason: '', components: {} } }), zones);
    expect(text).toContain('organic grocery store');
    expect(text).toContain('1. Zone One — 7.5/10 [Priority]');
    expect(text).toContain('Verify rent');
    expect(text).toContain('abc12345');
    expect(text).toContain('not verified properties');
  });
});

// v1.11.2 — the scannable projection behind the sidebar's factor bars.
// Live feedback: "still a lot of info which I really have to read to
// understand what's going on". Same criteria the prose was built from,
// reduced to {label, score, tone} so the UI can draw a bar instead of a
// sentence the user has to parse word by word.
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
