// ─── Backend-result normalization / sanitization layer (v1.4.6) ───
//
// Every AnalysisResult that reaches React components MUST pass through
// normalizeAnalysisResult() first. Rationale: during live dark-kitchen testing
// the analysis executed successfully but the results panel crashed with a
// render error, because ResultsDrawer/MapView dereference dozens of nested
// fields (candidates, lat/lng, mcda_score, criteria_breakdown, osmSignals,
// exclusions, traffic context, route/evidence data, map layers) that the
// backend may omit or malform in degraded runs. Per-line `??` guards can't
// keep up with a 1000+ line component — instead the data is repaired ONCE at
// the boundary: bad candidates are dropped or marked incomplete, missing
// arrays/objects become empty, non-finite numbers get safe defaults, and an
// irreparable evidence trail is removed (the drawer renders "(unavailable)").
//
// Repairs are recorded in `normalizationWarnings` so degraded data is visible
// in the UI instead of silently patched.

import type { AnalysisResult, LocationData } from '../types';

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const asArr = <T = any>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const asStr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

const asNum = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Finite number or null — for fields where null is meaningful ("no data"). */
const asNumOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalizeLocation(raw: unknown, index: number, warnings: string[]): LocationData | null {
  if (!isObj(raw)) {
    warnings.push(`Candidate #${index + 1} was not an object — dropped.`);
    return null;
  }
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    warnings.push(`Candidate "${asStr(raw.name, `#${index + 1}`)}" has invalid coordinates — dropped.`);
    return null;
  }

  const out: any = { ...raw };
  out.lat = lat;
  out.lng = lng;
  out.name = asStr(raw.name) || `Zone-${index + 1}`;
  if (!Number.isFinite(Number(raw.mcda_score))) {
    warnings.push(`Candidate "${out.name}": missing score — shown as 0.0 (incomplete).`);
    out._incomplete = true;
  }
  out.mcda_score = asNum(raw.mcda_score, 0);
  // v1.5.2 — score-basis transparency (both optional; older payloads omit them)
  out.screeningScore = asNumOrNull(raw.screeningScore);
  out.rankingBasis = raw.rankingBasis === 'refined' ? 'refined' : (raw.rankingBasis === 'screening' ? 'screening' : undefined);
  out.excluded = raw.excluded === true;
  out.reasoning = asStr(raw.reasoning);
  out.searchRadiusM = asNum(raw.searchRadiusM, 0);
  out.osmSignals = isObj(raw.osmSignals) ? raw.osmSignals : {};
  out.pois = asArr(raw.pois);

  out.criteria_breakdown = asArr(raw.criteria_breakdown)
    .filter(isObj)
    .map((c: any) => ({
      ...c,
      name: asStr(c.name, 'factor'),
      score: asNumOrNull(c.score),           // null = "no data", must survive
      weight: asNum(c.weight, 0),
      direction: c.direction === 'negative' ? 'negative' : 'positive',
      rawValue: c.rawValue ?? '',
      justification: asStr(c.justification),
      evidenceBasis: asStr(c.evidenceBasis, 'template-default'),
    }));

  out.exclusions = asArr(raw.exclusions)
    .filter(isObj)
    .map((e: any) => ({
      ...e,
      rule: asStr(e.rule, 'exclusion'),
      passed: e.passed === true,
      evidenceBasis: asStr(e.evidenceBasis, 'constraint-rule'),
    }));

  if (raw.routeMetrics !== undefined && !isObj(raw.routeMetrics)) {
    out.routeMetrics = undefined;
  }
  // v1.5-Lite — per-candidate labels: strings or absent, never other shapes.
  if (raw.investigationLabel !== undefined) {
    out.investigationLabel = typeof raw.investigationLabel === 'string' ? raw.investigationLabel : undefined;
  }
  if (raw.stabilityLabel !== undefined) {
    out.stabilityLabel = typeof raw.stabilityLabel === 'string' ? raw.stabilityLabel : undefined;
  }
  if (raw.stabilityNote !== undefined) {
    out.stabilityNote = typeof raw.stabilityNote === 'string' ? raw.stabilityNote : undefined;
  }
  if (raw.trafficContext !== undefined) {
    out.trafficContext = isObj(raw.trafficContext)
      ? {
          ...raw.trafficContext,
          label: asStr(raw.trafficContext.label, 'unknown'),
          note: asStr(raw.trafficContext.note),
          congestionRatio: asNumOrNull(raw.trafficContext.congestionRatio),
        }
      : undefined;
  }
  // v1.5.1 — per-candidate hard-constraint warnings: well-formed entries kept,
  // anything else silently dropped (the analysis-level panel still shows the
  // full verification object).
  if (raw.hardConstraintWarnings !== undefined) {
    const warns = asArr(raw.hardConstraintWarnings)
      .filter(isObj)
      .filter((w: any) => typeof w.message === 'string' && w.message)
      .map((w: any) => ({
        constraintId: asStr(w.constraintId, 'constraint'),
        label: asStr(w.label, 'Hard constraint'),
        status: asStr(w.status, 'not_verifiable'),
        severity: w.severity === 'critical' ? 'critical' : 'warning',
        message: w.message as string,
      }));
    out.hardConstraintWarnings = warns.length > 0 ? warns : undefined;
  }
  return out as LocationData;
}

/** v1.5.1 — statuses the backend contract allows per constraint entry. */
const HC_STATUSES = [
  'verified', 'proxy_verified', 'not_verifiable',
  'requested_not_enforced', 'failed', 'not_required',
];

/** v1.5.1 — repair hardConstraintVerification, or return undefined when the
 * object is irreparable (the drawer simply omits the panel). */
function normalizeHardConstraintVerification(raw: unknown, warnings: string[]): any {
  if (raw === null || raw === undefined) return undefined;
  if (!isObj(raw)) {
    warnings.push('Hard-constraint verification data was malformed — hidden.');
    return undefined;
  }
  const constraints = asArr(raw.constraints)
    .filter(isObj)
    .filter((c: any) => HC_STATUSES.includes(c.status))
    .map((c: any) => ({
      id: asStr(c.id, 'constraint'),
      label: asStr(c.label, asStr(c.id, 'Hard constraint')),
      requested: c.requested !== false,
      category: asStr(c.category, 'other'),
      status: c.status as string,
      severity: c.severity === 'critical' ? 'critical' : c.severity === 'info' ? 'info' : 'warning',
      affectsRecommendation: c.affectsRecommendation === true,
      candidateScope: asStr(c.candidateScope, 'analysis'),
      reason: asStr(c.reason),
      fieldValidationRequired: c.fieldValidationRequired === true,
    }));
  return {
    summaryStatus: asStr(raw.summaryStatus, 'unknown'),
    requestedCount: asNum(raw.requestedCount, constraints.filter(c => c.requested).length),
    verifiedCount: asNum(raw.verifiedCount, 0),
    proxyVerifiedCount: asNum(raw.proxyVerifiedCount, 0),
    unknownCount: asNum(raw.unknownCount, 0),
    unenforcedCount: asNum(raw.unenforcedCount, 0),
    failedCount: asNum(raw.failedCount, 0),
    constraints,
  };
}

/** Repair the evidence trail in place, or return undefined when irreparable
 * (the drawer then shows "Evidence Trail (unavailable)" instead of crashing). */
function normalizeEvidenceTrail(raw: unknown, warnings: string[]): any {
  if (raw === null || raw === undefined) return undefined;
  if (!isObj(raw)) {
    warnings.push('Evidence trail was malformed — hidden.');
    return undefined;
  }
  const t: any = { ...raw };
  t.evidenceVersion = asStr(t.evidenceVersion, '?');
  t.appVersion = asStr(t.appVersion, '?');
  t.engineVersion = asStr(t.engineVersion, '?');
  t.jobId = asStr(t.jobId);
  t.analysisId = asStr(t.analysisId);
  t.createdAt = asStr(t.createdAt);
  t.prompt = isObj(t.prompt) ? t.prompt : {};
  t.studyArea = isObj(t.studyArea) ? t.studyArea : {};
  t.dataSnapshot = isObj(t.dataSnapshot) ? t.dataSnapshot : {};
  t.providerQueries = asArr(t.providerQueries).filter(isObj);
  t.factors = asArr(t.factors).filter(isObj).map((f: any) => ({
    ...f,
    factorKey: asStr(f.factorKey, 'factor'),
    displayName: asStr(f.displayName, f.factorKey || 'factor'),
    weight: asNum(f.weight, 0),
    dataSources: asArr(f.dataSources),
    appliedToCandidates: asArr(f.appliedToCandidates).filter(isObj),
  }));
  t.candidates = asArr(t.candidates).filter(isObj).map((c: any) => ({
    ...c,
    candidateId: asStr(c.candidateId, 'candidate'),
    label: asStr(c.label, c.candidateId || 'candidate'),
    recommendationStatus: asStr(c.recommendationStatus, 'unknown'),
    exclusionReasons: asArr(c.exclusionReasons),
    factorBreakdown: asArr(c.factorBreakdown).filter(isObj),
  }));
  t.exclusions = asArr(t.exclusions).filter(isObj);
  t.limitations = asArr(t.limitations);
  const sc = isObj(t.scoring) ? t.scoring : {};
  t.scoring = {
    ...sc,
    formulaDescription: asStr(sc.formulaDescription),
    totalWeight: asNum(sc.totalWeight, 0),
    totalPresentWeight: asNum(sc.totalPresentWeight, 0),
    viableCandidates: asNum(sc.viableCandidates, 0),
    missingDataHandling: asStr(sc.missingDataHandling),
  };
  return t;
}

const RESULT_STATES = ['success', 'no_viable_site', 'failed'] as const;

export function normalizeAnalysisResult(raw: unknown): AnalysisResult {
  const warnings: string[] = [];
  const src: Record<string, any> = isObj(raw) ? raw : {};
  if (!isObj(raw)) {
    warnings.push('Analysis result payload was not an object — showing an empty result.');
  }

  const out: any = { ...src };

  // ── v1.4.7: three-state backend result contract ──
  // status ∈ success | no_viable_site | failed. A payload with no recognizable
  // state AND no usable content is flagged 'malformed' so the UI can show
  // "Malformed backend result" with the job reference instead of a blank panel.
  out.jobRef = asStr(src.jobRef) || asStr(src.analysisId) || undefined;
  if (RESULT_STATES.includes(src.status)) {
    out.status = src.status;
  } else {
    const hasContent =
      Array.isArray(src.locations) || typeof src.summary === 'string';
    out.status = hasContent ? 'success' : 'malformed';   // legacy payloads = success shape
    if (!hasContent) {
      warnings.push(
        `Malformed backend result${out.jobRef ? ` (ref: ${out.jobRef})` : ''} — no status, candidates, or summary.`,
      );
    }
  }
  out.degradationNotes = asArr(src.degradationNotes).filter(n => typeof n === 'string');
  out.providerDiagnostics = isObj(src.providerDiagnostics)
    ? { ...src.providerDiagnostics, degraded: asArr(src.providerDiagnostics.degraded) }
    : undefined;
  if (out.status === 'no_viable_site') {
    out.reason = asStr(src.reason, 'No viable site satisfied the hard constraints.');
    out.failedGates = asArr(src.failedGates).filter(isObj);
    out.relaxationSuggestions = asArr(src.relaxationSuggestions).filter(s => typeof s === 'string');
  }
  if (out.status === 'failed') {
    out.stage = asStr(src.stage, 'unknown');
    out.errorCode = asStr(src.errorCode, 'UNKNOWN');
    out.userMessage = asStr(src.userMessage, 'The analysis failed on the server.');
    out.retryable = src.retryable !== false;
  }

  // ── v1.4.9: analysisCompleteness (PlannerLite) — arrays/booleans guaranteed
  // so ResultsDrawer can render it unconditionally without crashing.
  if (isObj(src.analysisCompleteness)) {
    const ac = src.analysisCompleteness;
    out.analysisCompleteness = {
      coreScoringComplete: ac.coreScoringComplete !== false,
      buildabilityVerified: ac.buildabilityVerified === true,
      waterVerified: ac.waterVerified === true,
      routeVerified: ac.routeVerified === true,
      placesVerified: ac.placesVerified === true,
      provisional: ac.provisional === true,
      confidenceLevel: asStr(ac.confidenceLevel, 'M'),
      skippedStages: asArr(ac.skippedStages).filter(isObj).map((s: any) => ({
        stage: asStr(s.stage, 'stage'),
        reason: asStr(s.reason),
        savedCost: asStr(s.savedCost),
      })),
      degradedStages: asArr(ac.degradedStages).filter(d => typeof d === 'string'),
      unsupportedConstraints: asArr(ac.unsupportedConstraints).filter(isObj).map((c: any) => ({
        constraint: asStr(c.constraint, 'constraint'),
        reason: asStr(c.reason),
        shouldScore: c.shouldScore === true,
        displayLabel: asStr(c.displayLabel, asStr(c.constraint, 'constraint')),
      })),
    };
  } else if (src.analysisCompleteness !== undefined) {
    warnings.push('analysisCompleteness was malformed — hidden.');
    out.analysisCompleteness = undefined;
  }

  // ── v1.5-Lite: analysis verdict + granular data sufficiency ──
  // All optional — an old payload without these keys renders exactly as before.
  const VALID_RECO = [
    'RECOMMENDED_INVESTIGATION_ZONE', 'PROVISIONAL_CANDIDATE', 'WEAK_CANDIDATE',
    'NO_RELIABLE_RECOMMENDATION', 'NO_VIABLE_SITE_IN_CONSTRAINTS',
  ];
  out.analysisRecommendation = VALID_RECO.includes(src.analysisRecommendation)
    ? src.analysisRecommendation
    : undefined;
  if (isObj(src.dataSufficiencyV2)) {
    const d = src.dataSufficiencyV2;
    const st = (v: unknown) => asStr(v, 'unknown');
    const hc = isObj(d.hard_constraints) ? d.hard_constraints : {};
    out.dataSufficiencyV2 = {
      geocoding: st(d.geocoding),
      boundary_or_corridor: st(d.boundary_or_corridor),
      demand_data: st(d.demand_data),
      competition_data: st(d.competition_data),
      road_access: st(d.road_access),
      routing: st(d.routing),
      buildability_lite: st(d.buildability_lite),
      hard_constraints: {
        verified_count: asNum(hc.verified_count, 0),
        unknown_count: asNum(hc.unknown_count, 0),
        failed_count: asNum(hc.failed_count, 0),
      },
      external_provider_health: st(d.external_provider_health),
      final_confidence: st(d.final_confidence),
      confidence_reason: asStr(d.confidence_reason),
    };
  } else if (src.dataSufficiencyV2 !== undefined) {
    warnings.push('dataSufficiencyV2 was malformed — hidden.');
    out.dataSufficiencyV2 = undefined;
  }
  if (src.analysisIntelligence !== undefined && !isObj(src.analysisIntelligence)) {
    out.analysisIntelligence = undefined;
  }
  // v1.5.1 — hard-constraint verification (optional; absent on older payloads).
  out.hardConstraintVerification =
    normalizeHardConstraintVerification(src.hardConstraintVerification, warnings);

  out.summary = asStr(src.summary, 'Analysis completed, but the summary could not be read.');
  out.business_type = asStr(src.business_type, '—');
  out.target_location = asStr(src.target_location, '—');
  out.methodology = asStr(src.methodology);
  out.grounding_sources = asArr(src.grounding_sources).filter(isObj).map((s: any) => ({
    ...s,
    title: asStr(s.title, 'Source'),
    uri: asStr(s.uri),
    reliability: asStr(s.reliability),
  }));

  const rawLocs = asArr(src.locations);
  out.locations = rawLocs
    .map((l, i) => normalizeLocation(l, i, warnings))
    .filter((l): l is LocationData => l !== null);
  if (rawLocs.length > 0 && out.locations.length === 0) {
    warnings.push('All candidates were malformed — no candidate zones can be shown.');
  }

  // spec — ResultsDrawer iterates these arrays unconditionally
  const spec = isObj(src.spec) ? { ...src.spec } : {};
  spec.businessType = asStr(spec.businessType, out.business_type);
  spec.constraints = asArr(spec.constraints).filter(isObj);
  spec.positiveCriteria = asArr(spec.positiveCriteria);
  spec.negativeCriteria = asArr(spec.negativeCriteria);
  spec.parsingNotes = asArr(spec.parsingNotes);
  spec.confidence = asStr(spec.confidence, 'low');
  if (spec.userPointConstraints !== undefined) {
    spec.userPointConstraints = asArr(spec.userPointConstraints).filter(isObj);
  }
  out.spec = spec;

  // critique — issues/whatWouldStrengthen are mapped unconditionally
  if (isObj(src.critique) && typeof src.critique.verdict === 'string') {
    out.critique = {
      ...src.critique,
      headline: asStr(src.critique.headline),
      confidence: asStr(src.critique.confidence, 'low'),
      issues: asArr(src.critique.issues),
      whatWouldStrengthen: asArr(src.critique.whatWouldStrengthen),
    };
  } else if (src.critique !== undefined && src.critique !== null) {
    out.critique = null;
    warnings.push('Analyst critique was malformed — hidden.');
  }

  // map layers — MapView guards per-cell, but the containers must be arrays
  if (src.hexGrid !== undefined) out.hexGrid = asArr(src.hexGrid).filter(isObj);
  // v1.6.0 (Phase 2) — weight audit (default vs executed weights, user-adjusted flag)
  if (isObj(src.weightAudit)) {
    out.weightAudit = {
      adjustedByUser: src.weightAudit.adjustedByUser === true,
      defaultWeights: isObj(src.weightAudit.defaultWeights) ? src.weightAudit.defaultWeights : null,
      executedWeights: isObj(src.weightAudit.executedWeights) ? src.weightAudit.executedWeights : {},
    };
  }
  if (src.catchments !== undefined) out.catchments = asArr(src.catchments).filter(isObj);
  if (src.studyAreaBoundary !== undefined && !Array.isArray(src.studyAreaBoundary)) {
    out.studyAreaBoundary = undefined;
  }
  out.maskStats = isObj(src.maskStats) ? src.maskStats : {};
  out.suggestions = asArr(src.suggestions);

  out.evidenceTrail = normalizeEvidenceTrail(src.evidenceTrail, warnings);

  if (warnings.length > 0) {
    out.normalizationWarnings = warnings;
  }
  return out as AnalysisResult;
}
