// Regression tests for the v1.4.6 results-crash fix: ResultsDrawer/MapView
// must never receive malformed data — the normalizer repairs it first.
import { describe, it, expect } from 'vitest';
import { normalizeAnalysisResult } from '../services/resultNormalizer';

describe('normalizeAnalysisResult', () => {
  it('survives a completely garbage payload', () => {
    for (const garbage of [null, undefined, 'oops', 42, []]) {
      const r = normalizeAnalysisResult(garbage) as any;
      expect(typeof r.summary).toBe('string');
      expect(Array.isArray(r.locations)).toBe(true);
      expect(r.locations).toHaveLength(0);
      expect(Array.isArray(r.grounding_sources)).toBe(true);
      expect(Array.isArray(r.spec.constraints)).toBe(true);
      expect(r.normalizationWarnings.length).toBeGreaterThan(0);
    }
  });

  it('drops candidates with missing/invalid coordinates and records a warning', () => {
    const r = normalizeAnalysisResult({
      summary: 's', business_type: 'b', target_location: 't',
      locations: [
        { name: 'Good', lat: 22.5, lng: 88.3, mcda_score: 7.1 },
        { name: 'NoCoords', mcda_score: 6.0 },
        { name: 'BadLat', lat: 'x', lng: 88.3 },
      ],
    }) as any;
    expect(r.locations).toHaveLength(1);
    expect(r.locations[0].name).toBe('Good');
    expect(r.normalizationWarnings.join(' ')).toContain('NoCoords');
  });

  it('repairs a candidate with missing score/breakdown instead of crashing later', () => {
    const r = normalizeAnalysisResult({
      locations: [{ name: 'Partial', lat: 22.5, lng: 88.3 }],
    }) as any;
    const loc = r.locations[0];
    expect(loc.mcda_score).toBe(0);
    expect(loc._incomplete).toBe(true);
    expect(Array.isArray(loc.criteria_breakdown)).toBe(true);
    expect(Array.isArray(loc.exclusions)).toBe(true);
    expect(loc.osmSignals).toEqual({});
    // The exact expressions ResultsDrawer renders must not throw:
    expect(() => loc.mcda_score.toFixed(1)).not.toThrow();
    expect(() => Object.entries(loc.osmSignals)).not.toThrow();
    expect(() => loc.criteria_breakdown.map((c: any) => c.name)).not.toThrow();
  });

  it('preserves null factor scores (meaningful "no data") but coerces weights', () => {
    const r = normalizeAnalysisResult({
      locations: [{
        name: 'Z', lat: 1, lng: 2, mcda_score: 5,
        criteria_breakdown: [{ name: 'f1', score: null, weight: 'bad' }],
      }],
    }) as any;
    const c = r.locations[0].criteria_breakdown[0];
    expect(c.score).toBeNull();
    expect(c.weight).toBe(0);
  });

  it('hides an irreparable evidence trail instead of letting the drawer crash', () => {
    const r = normalizeAnalysisResult({ evidenceTrail: 'not-an-object' }) as any;
    expect(r.evidenceTrail).toBeUndefined();
  });

  it('repairs a partial evidence trail to the shape the drawer dereferences', () => {
    const r = normalizeAnalysisResult({ evidenceTrail: { evidenceVersion: '1.4.0' } }) as any;
    const t = r.evidenceTrail;
    // Every hot dereference in ResultsDrawer's evidence section:
    expect(() => t.jobId.slice(0, 16)).not.toThrow();
    expect(() => t.createdAt.replace('T', ' ')).not.toThrow();
    expect(() => t.scoring.totalWeight.toFixed(2)).not.toThrow();
    expect(Array.isArray(t.providerQueries)).toBe(true);
    expect(Array.isArray(t.factors)).toBe(true);
    expect(Array.isArray(t.candidates)).toBe(true);
    expect(Array.isArray(t.exclusions)).toBe(true);
    expect(Array.isArray(t.limitations)).toBe(true);
  });

  // ── v1.4.7 three-state contract ──

  it('flags a content-free payload as malformed with the job reference', () => {
    const r = normalizeAnalysisResult({ jobRef: 'abc12345' }) as any;
    expect(r.status).toBe('malformed');
    expect(r.jobRef).toBe('abc12345');
    expect(r.normalizationWarnings.join(' ')).toContain('abc12345');
    expect(r.normalizationWarnings.join(' ')).toContain('Malformed backend result');
  });

  it('normalizes a legacy payload (no status field) to success', () => {
    const r = normalizeAnalysisResult({ summary: 's', locations: [] }) as any;
    expect(r.status).toBe('success');
  });

  it('preserves a no_viable_site payload with gates and relaxations', () => {
    const r = normalizeAnalysisResult({
      status: 'no_viable_site',
      jobRef: 'j1',
      reason: 'All hexes were water.',
      failedGates: [{ gate: 'waterMask', hexesRemoved: 120 }, 'not-an-object'],
      relaxationSuggestions: ['Widen the band to 500 m', 42],
      degradationNotes: ['water fetch degraded', { bad: true }],
      locations: [],
      summary: 'no viable site',
    }) as any;
    expect(r.status).toBe('no_viable_site');
    expect(r.reason).toBe('All hexes were water.');
    expect(r.failedGates).toHaveLength(1);
    expect(r.relaxationSuggestions).toEqual(['Widen the band to 500 m']);
    expect(r.degradationNotes).toEqual(['water fetch degraded']);
  });

  it('preserves a failed payload with stage/errorCode/jobRef and retryable', () => {
    const r = normalizeAnalysisResult({
      status: 'failed', stage: 'score_pass_a', errorCode: 'TypeError',
      userMessage: 'boom', retryable: false, jobRef: 'ref9',
    }) as any;
    expect(r.status).toBe('failed');
    expect(r.stage).toBe('score_pass_a');
    expect(r.errorCode).toBe('TypeError');
    expect(r.retryable).toBe(false);
    expect(r.jobRef).toBe('ref9');
  });

  it('an unknown status string does not crash and degrades sensibly', () => {
    const r = normalizeAnalysisResult({ status: 'wat', summary: 's', locations: [] }) as any;
    expect(r.status).toBe('success');
  });

  it('leaves a healthy result essentially untouched (no spurious warnings)', () => {
    const healthy = {
      summary: 'ok', business_type: 'cafe', target_location: 'Kolkata',
      methodology: 'm', grounding_sources: [{ title: 'OSM', uri: 'u', reliability: 'r' }],
      locations: [{
        name: 'Zone A', lat: 22.5, lng: 88.3, mcda_score: 8.2, excluded: false,
        reasoning: 'good', searchRadiusM: 1200, osmSignals: { cafes: 4 }, pois: [],
        criteria_breakdown: [{ name: 'f', score: 8, weight: 0.4, direction: 'positive', rawValue: '4', justification: 'j', evidenceBasis: 'osm-observed' }],
        exclusions: [{ rule: 'water', passed: true, evidenceBasis: 'constraint-rule' }],
      }],
      spec: { businessType: 'cafe', constraints: [], positiveCriteria: [], negativeCriteria: [], parsingNotes: [], confidence: 'high' },
    };
    const r = normalizeAnalysisResult(healthy) as any;
    expect(r.normalizationWarnings).toBeUndefined();
    expect(r.locations[0].mcda_score).toBe(8.2);
    expect(r.locations[0].criteria_breakdown[0].score).toBe(8);
  });
});
