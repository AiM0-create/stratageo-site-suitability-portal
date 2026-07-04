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

  // ── v1.4.9 PlannerLite analysisCompleteness ──

  it('normalizes a well-formed analysisCompleteness payload', () => {
    const r = normalizeAnalysisResult({
      summary: 's', locations: [],
      analysisCompleteness: {
        coreScoringComplete: true, buildabilityVerified: false,
        waterVerified: false, routeVerified: true, placesVerified: true,
        provisional: true, confidenceLevel: 'M',
        skippedStages: [{ stage: 'water_geometry', reason: 'not a waterfront analysis', savedCost: 'high' }, 'junk'],
        degradedStages: ['places_primary_x', 42],
        unsupportedConstraints: [
          { constraint: 'rent_or_lease_price', reason: 'r', shouldScore: false, displayLabel: 'Rent: unverified — not scored.' },
        ],
      },
    }) as any;
    const ac = r.analysisCompleteness;
    expect(ac.provisional).toBe(true);
    expect(ac.confidenceLevel).toBe('M');
    expect(ac.skippedStages).toHaveLength(1);           // junk dropped
    expect(ac.skippedStages[0].reason).toContain('waterfront');
    expect(ac.degradedStages).toEqual(['places_primary_x']);   // non-strings dropped
    expect(ac.unsupportedConstraints[0].shouldScore).toBe(false);
    expect(ac.unsupportedConstraints[0].displayLabel).toContain('not scored');
  });

  it('hides a malformed analysisCompleteness instead of crashing the drawer', () => {
    const r = normalizeAnalysisResult({
      summary: 's', locations: [], analysisCompleteness: 'oops',
    }) as any;
    expect(r.analysisCompleteness).toBeUndefined();
    expect(r.normalizationWarnings.join(' ')).toContain('analysisCompleteness');
  });

  it('provisional candidate zones payload renders shape without crash-prone fields', () => {
    const r = normalizeAnalysisResult({
      summary: 's',
      locations: [{ name: 'Z1', lat: 22.5, lng: 88.3, mcda_score: 6.5 }],
      analysisCompleteness: {
        provisional: true, confidenceLevel: 'L',
        skippedStages: [], degradedStages: [], unsupportedConstraints: [],
      },
    }) as any;
    expect(r.analysisCompleteness.coreScoringComplete).toBe(true);  // defaulted
    expect(Array.isArray(r.analysisCompleteness.skippedStages)).toBe(true);
    expect(r.locations).toHaveLength(1);
  });

  // ── v1.5-Lite: analysisRecommendation / dataSufficiencyV2 / candidate labels ──

  it('old payload without v1.5 keys renders with no v1.5 fields and no warnings', () => {
    const r = normalizeAnalysisResult({
      summary: 's', locations: [{ name: 'Z', lat: 22.5, lng: 88.3, mcda_score: 7 }],
    }) as any;
    expect(r.analysisRecommendation).toBeUndefined();
    expect(r.dataSufficiencyV2).toBeUndefined();
    expect(r.normalizationWarnings).toBeUndefined();
    expect(r.locations[0].investigationLabel).toBeUndefined();
  });

  it('normalizes a well-formed v1.5 payload', () => {
    const r = normalizeAnalysisResult({
      summary: 's',
      analysisRecommendation: 'PROVISIONAL_CANDIDATE',
      dataSufficiencyV2: {
        geocoding: 'verified', boundary_or_corridor: 'verified',
        demand_data: 'proxy', competition_data: 'verified',
        road_access: 'verified', routing: 'not_required',
        buildability_lite: 'not_required',
        hard_constraints: { verified_count: 2, unknown_count: 2, failed_count: 0 },
        external_provider_health: 'ok',
        final_confidence: 'medium',
        confidence_reason: '2 constraint(s) cannot be verified from data.',
      },
      locations: [{
        name: 'Z1', lat: 22.5, lng: 88.3, mcda_score: 6.8,
        investigationLabel: 'PROVISIONAL_CANDIDATE',
        stabilityLabel: 'STABLE_TOP_3',
        stabilityNote: 'Stays in the top 3 under every weighting scenario.',
      }],
    }) as any;
    expect(r.analysisRecommendation).toBe('PROVISIONAL_CANDIDATE');
    expect(r.dataSufficiencyV2.final_confidence).toBe('medium');
    expect(r.dataSufficiencyV2.demand_data).toBe('proxy');
    expect(r.dataSufficiencyV2.hard_constraints.unknown_count).toBe(2);
    expect(r.locations[0].investigationLabel).toBe('PROVISIONAL_CANDIDATE');
    expect(r.locations[0].stabilityLabel).toBe('STABLE_TOP_3');
  });

  it('drops malformed v1.5 fields instead of crashing the drawer', () => {
    const r = normalizeAnalysisResult({
      summary: 's', locations: [{
        name: 'Z', lat: 22.5, lng: 88.3, mcda_score: 5,
        investigationLabel: { nope: true }, stabilityLabel: 42,
      }],
      analysisRecommendation: 'TOTALLY_INVALID_VALUE',
      dataSufficiencyV2: 'oops',
    }) as any;
    expect(r.analysisRecommendation).toBeUndefined();      // unknown enum → dropped
    expect(r.dataSufficiencyV2).toBeUndefined();
    expect(r.normalizationWarnings.join(' ')).toContain('dataSufficiencyV2');
    expect(r.locations[0].investigationLabel).toBeUndefined();
    expect(r.locations[0].stabilityLabel).toBeUndefined();
  });

  it('fills safe defaults for a partial dataSufficiencyV2', () => {
    const r = normalizeAnalysisResult({
      summary: 's', locations: [],
      dataSufficiencyV2: { final_confidence: 'low' },
    }) as any;
    expect(r.dataSufficiencyV2.geocoding).toBe('unknown');
    expect(r.dataSufficiencyV2.hard_constraints).toEqual(
      { verified_count: 0, unknown_count: 0, failed_count: 0 });
    expect(r.dataSufficiencyV2.final_confidence).toBe('low');
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
