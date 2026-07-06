import React, { useState, useMemo } from 'react';
import type { LocationData, AnalysisResult, AnalysisSpec, HeatmapType, EvidenceTrail } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { compareToBenchmark } from '../services/benchmarks';

interface ResultsDrawerProps {
  open: boolean;
  onClose: () => void;
  result: AnalysisResult;
  spec: AnalysisSpec | null;
  locations: LocationData[];
  selectedLocations: LocationData[];
  onSelectLocation: (location: LocationData) => void;
  customWeights: Record<string, number>;
  onWeightChange: (name: string, weight: number) => void;
  heatmapType: HeatmapType;
  onHeatmapChange: (type: HeatmapType) => void;
  showBuffers?: boolean;
  onToggleBuffers?: () => void;
  csvPointCount?: number;
  /** v1.0.3 — re-run the analysis with a wider riverfront band (same area). */
  onWidenCorridor?: () => void;
}

const ComparisonChart: React.FC<{ locations: LocationData[] }> = ({ locations }) => {
  // v1.4.2: null-safe over a missing/malformed criteria_breakdown — this chart
  // renders unconditionally near the top of every results panel, so an
  // unguarded .map()/.find() here was a near-guaranteed crash for any
  // location whose breakdown was absent.
  const criteriaNames = useMemo(() =>
    Array.from(new Set(locations.flatMap(loc => (loc.criteria_breakdown ?? []).map(c => c.name)))),
    [locations]);

  const chartData = useMemo(() => criteriaNames.map(name => {
    const point: Record<string, any> = { criteria: name.length > 16 ? name.slice(0, 14) + '...' : name };
    locations.forEach((loc, i) => {
      const c = (loc.criteria_breakdown ?? []).find(cr => cr.name === name);
      point[`loc${i}`] = c?.score ?? 0;
    });
    return point;
  }), [criteriaNames, locations]);

  const colors = ['#1d4ed8', '#059669', '#d97706'];

  return (
    <div className="drawer-chart">
      <ResponsiveContainer width="100%" height={Math.max(180, criteriaNames.length * 32)}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 12, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
          <XAxis type="number" domain={[0, 10]} hide />
          <YAxis dataKey="criteria" type="category" tick={{ fill: '#64748b', fontSize: 10 }} width={110} />
          <Tooltip cursor={{ fill: 'transparent' }} contentStyle={{ borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '11px' }} />
          {locations.length > 1 && <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '4px' }} />}
          {locations.map((loc, i) => (
            <Bar key={loc.name} dataKey={`loc${i}`} name={loc.name} fill={colors[i % colors.length]} radius={[0, 3, 3, 0]} barSize={locations.length > 1 ? 10 : 14} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

function getScoreQualityLabel(score: number): string {
  if (score >= 8.5) return 'Excellent';
  if (score >= 7.5) return 'Strong';
  if (score >= 6.5) return 'Good';
  if (score >= 5.0) return 'Moderate';
  if (score >= 3.5) return 'Fair';
  return 'Weak';
}

// v1.1.0: resolve recommendation label from status field (or fall back to score)
// v1.4.6: `demoted` — when critical constraints are unverified, feasibility is
// compromised, or provider checks degraded, a backend "RECOMMENDED" must be
// downgraded to "Candidate Zone": an overconfident green badge over unverified
// rent/footprint/routing claims is a product-correctness bug, not a style choice.
// v1.5-Lite — investigation-zone taxonomy display text. Deliberately never
// says "site": these are candidate/investigation ZONES pending field checks.
const INVESTIGATION_TEXT: Record<string, string> = {
  RECOMMENDED_INVESTIGATION_ZONE: 'Recommended Investigation Zone',
  PROVISIONAL_CANDIDATE: 'Provisional Candidate',
  WEAK_CANDIDATE: 'Weak Candidate',
  NO_RELIABLE_RECOMMENDATION: 'Not recommended',
  EXCLUDED: 'Excluded',
};

const STABILITY_TEXT: Record<string, { text: string; color: string }> = {
  ROBUST_TOP_CANDIDATE: { text: 'Robust top candidate', color: '#059669' },
  STABLE_TOP_3: { text: 'Stable top 3', color: '#0369a1' },
  SCENARIO_SENSITIVE: { text: 'Scenario sensitive', color: '#d97706' },
  WEAK_UNSTABLE: { text: 'Weak / unstable ranking', color: '#dc2626' },
  NOT_ENOUGH_CANDIDATES: { text: 'Not enough candidates to compare', color: '#94a3b8' },
};

const ANALYSIS_RECO_META: Record<string, { text: string; bg: string; border: string; color: string }> = {
  RECOMMENDED_INVESTIGATION_ZONE: { text: 'Recommended Investigation Zones', bg: '#ecfdf5', border: '#059669', color: '#065f46' },
  PROVISIONAL_CANDIDATE: { text: 'Provisional Candidate Zones — field validation required', bg: '#fffbeb', border: '#f59e0b', color: '#92400e' },
  WEAK_CANDIDATE: { text: 'Weak Candidate Zones — treat with caution', bg: '#fffbeb', border: '#d97706', color: '#92400e' },
  NO_RELIABLE_RECOMMENDATION: { text: 'No Reliable Recommendation', bg: '#fef2f2', border: '#dc2626', color: '#991b1b' },
  NO_VIABLE_SITE_IN_CONSTRAINTS: { text: 'No Viable Site in the Stated Constraints', bg: '#fef2f2', border: '#dc2626', color: '#991b1b' },
};

// v1.5-Lite — data-sufficiency status chip colors (verified/proxy/unknown/degraded/not_required)
const DS_STATUS_META: Record<string, { text: string; color: string }> = {
  verified: { text: 'verified', color: '#059669' },
  proxy: { text: 'proxy', color: '#d97706' },
  unknown: { text: 'unknown', color: '#64748b' },
  degraded: { text: 'degraded', color: '#dc2626' },
  not_required: { text: 'not required', color: '#94a3b8' },
};

// v1.5.1 — per-constraint verification status display (fixed vocabulary).
// Language rule: never "site verified" / "buildable" — only what the data
// actually supports.
const HC_STATUS_META: Record<string, { text: string; color: string }> = {
  verified: { text: 'Verified', color: '#059669' },
  proxy_verified: { text: 'Proxy verified', color: '#d97706' },
  not_verifiable: { text: 'Not verifiable from available data', color: '#92400e' },
  requested_not_enforced: { text: 'Requested but not enforced', color: '#dc2626' },
  failed: { text: 'Failed', color: '#dc2626' },
  not_required: { text: 'Not required', color: '#94a3b8' },
};

const HC_SUMMARY_META: Record<string, { text: string; color: string }> = {
  verified: { text: 'all verified', color: '#059669' },
  partially_verified: { text: 'partially verified', color: '#d97706' },
  degraded: { text: 'degraded — see warnings', color: '#dc2626' },
  failed: { text: 'failed — see warnings', color: '#dc2626' },
  unknown: { text: 'unknown', color: '#64748b' },
};

function getRecommendationLabel(
  loc: import('../types').LocationData,
  withheld: boolean,
  raw: boolean,
  demoted: boolean,
): string {
  if (loc.excluded) return 'Excluded';
  if (raw || withheld) return 'Not recommended';
  // v1.5-Lite — the backend's investigation label is the preferred, already-
  // honesty-gated verdict; older payloads fall through to the legacy chain.
  const il = (loc as any).investigationLabel as string | undefined;
  if (il && INVESTIGATION_TEXT[il]) {
    if (il === 'RECOMMENDED_INVESTIGATION_ZONE' && demoted) return 'Provisional Candidate';
    return INVESTIGATION_TEXT[il];
  }
  const rs = loc.recommendationStatus;
  if (rs === 'RECOMMENDED') return demoted ? 'Candidate Zone' : 'Recommended';
  if (rs === 'CANDIDATE_ZONE') return 'Candidate Zone';
  if (rs === 'WEAK_CANDIDATE') return 'Weak Candidate';
  if (rs === 'RAW_DIAGNOSTIC') return 'Diagnostic Only';
  if (rs === 'NO_RELIABLE_RECOMMENDATION') return 'Not recommended';
  if (demoted && typeof loc.mcda_score === 'number' && loc.mcda_score >= 7.5) return 'Candidate Zone';
  return getScoreQualityLabel(loc.mcda_score);
}

const EvidenceTag: React.FC<{ basis: string }> = ({ basis }) => {
  const label =
    basis === 'osm-observed'        ? 'OSM + Places' :
    basis === 'osm-absent'          ? 'No Data' :
    basis === 'insufficient-data'   ? 'Insufficient Data' :
    basis === 'osm-derived'         ? 'Derived' :
    basis === 'google-corroborated' ? 'Google' :
    basis === 'constraint-rule'     ? 'Rule' :
    basis === 'ai-generated'        ? 'AI' :
    basis === 'template-default'    ? 'Template' : 'Default';
  const cls =
    basis === 'osm-observed'        ? 'evidence-osm' :
    basis === 'osm-absent'          ? 'evidence-absent' :
    basis === 'insufficient-data'   ? 'evidence-absent' :
    basis === 'google-corroborated' ? 'evidence-google' :
    basis === 'constraint-rule'     ? 'evidence-rule' :
    basis === 'ai-generated'        ? 'evidence-ai' : 'evidence-default';
  const title =
    basis === 'insufficient-data'   ? 'No data was available to evaluate this factor — it is excluded from the score, not scored 0 or 10' :
    basis === 'osm-absent'          ? 'Zero features observed in OSM — may be a coverage gap, not genuine absence' :
    basis === 'google-corroborated' ? 'OSM data sparse but Google Places confirms real-world activity here; score floor lifted' :
    basis === 'osm-observed'        ? 'Score based on features counted from OpenStreetMap Overpass data' : undefined;
  return <span className={`evidence-tag ${cls}`} title={title}>{label}</span>;
};

const DirectionIcon: React.FC<{ direction: string }> = ({ direction }) => (
  <span className={`direction-icon ${direction === 'positive' ? 'dir-positive' : 'dir-negative'}`} title={direction === 'positive' ? 'Positive — more is better' : 'Negative — less is better'}>
    {direction === 'positive' ? '▲' : '▼'}
  </span>
);

export const ResultsDrawer: React.FC<ResultsDrawerProps> = ({
  open,
  onClose,
  result,
  spec,
  locations,
  selectedLocations,
  onSelectLocation,
  customWeights,
  onWeightChange,
  heatmapType,
  onHeatmapChange,
  showBuffers,
  onToggleBuffers,
  csvPointCount = 0,
  onWidenCorridor,
}) => {
  const [expandedLoc, setExpandedLoc] = useState<string | null>(locations[0]?.name ?? null);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showChecklist, setShowChecklist] = useState(false);
  const [evidenceExpandedFactor, setEvidenceExpandedFactor] = useState<string | null>(null);
  const evidenceTrail: EvidenceTrail | undefined = (result as any).evidenceTrail;
  // v1.4.7 — three-state backend contract: an explicit no_viable_site payload
  // always renders the withheld/insufficient treatment, independent of the
  // legacy flags.
  const resultState: string | undefined = (result as any).status;
  // The critic judged this ranking untrustworthy → withhold the recommendation
  // (show the reasons, not a confident list). Raw candidates stay behind an opt-in.
  const withheld = (result as any).recommendationWithheld === true
    || resultState === 'no_viable_site';
  // Spatial Reliability Upgrade v1.0.3 — viability gate surfacing.
  const analysisStatus: string | undefined = (result as any).analysisStatus;
  const insufficient = analysisStatus === 'insufficient_viable_land'
    || resultState === 'no_viable_site';
  const suggestions: string[] = ((result as any).suggestions?.length
    ? (result as any).suggestions
    : (result as any).relaxationSuggestions) || [];
  const maskStats: Record<string, number> = (result as any).maskStats || {};
  // Phase 17 — critic and constraint enforcement transparency
  const criticEnabled: boolean = (result as any).criticEnabled === true;
  const constraintEnforcementLevel: string = (result as any).constraintEnforcementLevel || 'advisory';
  const untracedConstraints: string[] = (result as any).untracedConstraints || [];
  // v1.4.0 — constraint policy + validation checklist (must be before isProvisional)
  const constraintPolicy: any = (result as any).constraintPolicy || {};
  const unverifiedConstraints: string[] = constraintPolicy.unverifiedHardConstraints || [];
  const provisionalReasons: string[] = constraintPolicy.provisionalReasons || [];
  const validationChecklist: any[] = constraintPolicy.validationChecklist || [];
  // v1.4.0: provisional = constraintPolicy.hasUnverifiableConstraints, not analysisStatus.
  // det_critic sets verdict="weak" when constraints are unverifiable, so analysisStatus is
  // always "weak" — the provisional banner must read constraintPolicy directly.
  const isProvisional = (result as any).constraintPolicy?.hasUnverifiableConstraints === true
    || unverifiedConstraints.length > 0;
  const siteClaimLevel: string = (result as any).siteClaimLevel || 'micro_market_zone';
  const disclaimer: string = (result as any).disclaimer || '';
  // v1.4.6 — degraded provider checks (buildability masks skipped on timeout
  // in v1.4.2; generalised providerDegraded in v1.4.6) + normalization repairs
  const buildabilityDegraded: string[] = ((result as any).maskStats?.buildabilityDegraded as string[]) || [];
  const providerDegraded: string[] = ((result as any).maskStats?.providerDegraded as string[]) || [];
  const normalizationWarnings: string[] = (result as any).normalizationWarnings || [];
  // v1.4.9 — PlannerLite completeness payload (normalizer-guaranteed shape).
  const completeness = (result as any).analysisCompleteness as
    import('../types').AnalysisCompleteness | undefined;
  // v1.5-Lite — analysis verdict + granular data sufficiency (both optional;
  // an older payload without them renders exactly as before).
  const analysisReco = (result as any).analysisRecommendation as string | undefined;
  const analysisRecoMeta = analysisReco ? ANALYSIS_RECO_META[analysisReco] : undefined;
  const ds2 = (result as any).dataSufficiencyV2 as
    import('../types').DataSufficiencyV2 | undefined;
  // v1.5.1 — hard-constraint verification (optional; absent on older payloads).
  const hcv = (result as any).hardConstraintVerification as
    import('../types').HardConstraintVerification | undefined;
  const hcvWarnEntries = (hcv?.constraints ?? []).filter(c =>
    c.status === 'requested_not_enforced'
    || c.status === 'failed'
    || (c.status === 'not_verifiable' && c.affectsRecommendation));
  // v1.4.6 — gate the green "Recommended" badge: any unverified critical
  // constraint, non-verified enforcement level, or degraded provider check
  // demotes RECOMMENDED to "Candidate Zone" (see getRecommendationLabel).
  // v1.4.9 — a provisional completeness verdict (unsupported constraints or a
  // degraded RELEVANT stage) also demotes. Skipped-irrelevant stages do NOT.
  const demoteRecommended =
    unverifiedConstraints.length > 0
    || (result as any).constraintPolicy?.hasUnverifiableConstraints === true
    || buildabilityDegraded.length > 0
    || providerDegraded.length > 0
    || constraintEnforcementLevel === 'provisional'
    || constraintEnforcementLevel === 'failed'
    || completeness?.provisional === true;
  // v1.4.0 — data coverage
  const dataCoverage: any = (result as any).dataCoverage || {};
  const coverageRatio: number = dataCoverage.coverageRatio ?? 1.0;
  const missingCritical: string[] = dataCoverage.missingCriticalLayers || [];
  // v1.2.0 — deterministic planning transparency
  const planningMode: string = (result as any).planningMode || '';
  const planningFingerprint: string = (result as any).planningFingerprint || '';
  const specFp: string = (result as any).specFingerprint || '';
  const weightsSource: string = (result as any).weightsSource || '';
  const llmOverrides: any[] = (result as any).llmSuggestedButNotApplied || [];
  const relaxationOptions: any[] = (result as any).relaxationOptions || [];
  const noReliableRec = locations.length > 0 && locations.every(l => l.excluded);
  // Phase 18 — uploaded candidates mode
  const uploadedCandidatesOnly: boolean = (result as any).uploadedCandidatesOnly === true;
  const candidateSource: string = (result as any).candidateSource || 'h3_grid';
  const uploadedCount: number = (result as any).uploadedCandidateCount || 0;
  const rankedUploaded: number = (result as any).rankedUploadedCandidateCount || 0;
  const excludedUploaded: number = (result as any).excludedUploadedCandidateCount || 0;
  const uploadedWarnings: string[] = (result as any).uploadedCandidateWarnings || [];
  const MASK_LABELS: Record<string, string> = {
    corridorRemoved: 'Outside riverfront corridor',
    waterOverlapRemoved: 'Mostly water (>30% area)',
    railwayRemoved: 'Railway land / track buffer',
    ghatRemoved: 'Ghat (access/sacred) buffer',
    protectedOpenSpaceRemoved: 'Heritage / protected / open-space',
  };
  const ranked = useMemo(() => [...locations].sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.mcda_score - a.mcda_score;
  }), [locations]);

  // Collect unique POI types from locations for heatmap toggles
  // Factor names that have a real (non-null) score — each becomes a per-hex
  // suitability choropleth (green = favorable for that factor, direction applied).
  const poiTypes = useMemo(() => {
    const names = new Set<string>();
    locations.forEach(loc => (loc.criteria_breakdown ?? []).forEach(c => {
      if (c.score !== null && c.score !== undefined) names.add(c.name);
    }));
    return Array.from(names).slice(0, 8);
  }, [locations]);

  return (
    <div className={`drawer ${open ? 'drawer-open' : 'drawer-closed'}`}>
      <div className="drawer-header">
        <div>
          <div className="drawer-title">Ranked Candidate Zones</div>
          <div className="drawer-subtitle">{result.business_type} — {result.target_location}</div>
        </div>
        <button onClick={onClose} className="drawer-close" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-sm">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="drawer-body">
        {/* v1.5-Lite — analysis-level investigation verdict badge */}
        {analysisRecoMeta && (
          <div style={{
            background: analysisRecoMeta.bg, border: `1px solid ${analysisRecoMeta.border}`,
            color: analysisRecoMeta.color, borderRadius: 6, padding: '7px 12px',
            fontSize: '13px', fontWeight: 700, marginBottom: 8,
          }}>
            {analysisRecoMeta.text}
          </div>
        )}

        {/* Summary — suppressed when withheld (it may assert a winner the critic rejected) */}
        {!withheld && <p className="drawer-summary">{result.summary}</p>}

        {/* Ranking withheld — critic unreliable OR insufficient viable land */}
        {withheld && (
          <div className="withheld-notice">
            <div className="withheld-head">
              {insufficient ? '❌ No viable site in the strict corridor' : '❌ No reliable recommendation'}
            </div>
            <p className="withheld-body">
              {insufficient ? (
                <>No buildable site remained inside the strict riverfront corridor after removing
                water, railway, ghat, heritage and open-space land. Raw candidates (if any) are not
                a recommendation. You can relax the analysis as suggested below — the geographic area
                stays the same.</>
              ) : (
                <>The analyst review flagged this result as <b>unreliable</b>, so no ranked
                recommendation is shown. The reasons — and what would make a reliable analysis
                possible — are below.</>
              )}
            </p>
          </div>
        )}

        {/* Why hexes were removed (per-mask transparency) */}
        {withheld && Object.keys(maskStats).some(k => MASK_LABELS[k] && maskStats[k] > 0) && (
          <div className="withheld-masks">
            <div className="review-label">Hexes removed by safeguard</div>
            <ul>
              {Object.entries(maskStats)
                .filter(([k, v]) => MASK_LABELS[k] && v > 0)
                .map(([k, v]) => <li key={k}>{MASK_LABELS[k]}: <b>{v}</b></li>)}
            </ul>
          </div>
        )}

        {/* What to relax next — never widens the geographic hard constraint */}
        {withheld && suggestions.length > 0 && (
          <div className="withheld-suggestions">
            <div className="review-label">What to relax next</div>
            <ul>{suggestions.map((sug, i) => <li key={i}>{sug}</li>)}</ul>
            {onWidenCorridor && ((result as any).waterfront?.corridorWidthM ?? 0) < 500 && (
              <button
                className="assumptions-toggle"
                onClick={onWidenCorridor}
                title="Re-run keeping the same area, wider riverfront band"
              >
                <span>Try widening riverfront corridor to 500 m</span>
              </button>
            )}
          </div>
        )}

        {/* v1.4.0 — site claim level disclaimer (always visible) */}
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: '11px', color: '#64748b', marginBottom: 8 }}>
          <b>Screening-level candidate zones</b> — H3 micro-market areas, not exact parcels or leasable sites. Field validation required before any leasing or investment decision.
        </div>

        {/* v1.4.6 — data repaired by the normalization layer (incomplete backend fields) */}
        {normalizationWarnings.length > 0 && (
          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, padding: '6px 10px', fontSize: '11px', color: '#92400e', marginBottom: 8 }}>
            <b>Some result data was incomplete</b> and has been repaired or hidden:
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {normalizationWarnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {/* v1.4.6 — degraded provider checks (timeouts) that were skipped */}
        {(buildabilityDegraded.length > 0 || providerDegraded.length > 0) && (
          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, padding: '6px 10px', fontSize: '11px', color: '#92400e', marginBottom: 8 }}>
            <b>Degraded checks</b> (provider slow/unavailable — skipped, confidence reduced):{' '}
            {[...buildabilityDegraded, ...providerDegraded].join(', ')}
          </div>
        )}

        {/* v1.4.9 — PlannerLite completeness: skipped-irrelevant stages are a
            resource decision (neutral styling), unsupported constraints are
            "not scored" (amber), never presented as errors. */}
        {completeness && (
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: '11px', color: '#475569', marginBottom: 8 }}>
            <b>Analysis scope</b>
            {completeness.provisional && (
              <span style={{ marginLeft: 6, color: '#92400e', fontWeight: 700 }}>
                — Provisional Candidate Zones (confidence: {completeness.confidenceLevel})
              </span>
            )}
            {completeness.skippedStages.length > 0 && (
              <div style={{ marginTop: 4 }}>
                ⚡ <b>Skipped (not relevant — saved time):</b>
                <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
                  {completeness.skippedStages.slice(0, 6).map((s, i) => <li key={i}>{s.reason}</li>)}
                </ul>
              </div>
            )}
            {completeness.unsupportedConstraints.length > 0 && (
              <div style={{ marginTop: 4, color: '#92400e' }}>
                ⚠ <b>Field validation required — not scored (cannot be verified from data):</b>
                <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
                  {completeness.unsupportedConstraints.map((c, i) => <li key={i}>{c.displayLabel}</li>)}
                </ul>
              </div>
            )}
            {completeness.degradedStages.length > 0 && (
              <div style={{ marginTop: 4, color: '#92400e' }}>
                ⏱ <b>Degraded this run:</b> {completeness.degradedStages.join(', ')}
              </div>
            )}
          </div>
        )}

        {/* v1.5-Lite — granular data sufficiency panel */}
        {ds2 && (
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: '11px', color: '#475569', marginBottom: 8 }}>
            <b>Data sufficiency</b>
            <span style={{
              marginLeft: 6, fontWeight: 700,
              color: ds2.final_confidence === 'high' ? '#059669'
                : ds2.final_confidence === 'medium' ? '#d97706' : '#dc2626',
            }}>
              — {ds2.final_confidence} confidence
            </span>
            {ds2.confidence_reason && (
              <div style={{ marginTop: 2, color: '#64748b' }}>{ds2.confidence_reason}</div>
            )}
            <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
              {([
                ['Geocoding', ds2.geocoding],
                ['Boundary/corridor', ds2.boundary_or_corridor],
                ['Demand data', ds2.demand_data],
                ['Competition data', ds2.competition_data],
                ['Road access', ds2.road_access],
                ['Routing', ds2.routing],
                ['Buildability', ds2.buildability_lite],
              ] as Array<[string, string]>).map(([name, status], i) => {
                const meta = DS_STATUS_META[status] || DS_STATUS_META.unknown;
                return (
                  <span key={i} style={{ whiteSpace: 'nowrap' }}>
                    {name}: <b style={{ color: meta.color }}>{meta.text}</b>
                  </span>
                );
              })}
            </div>
            <div style={{ marginTop: 4, color: '#64748b' }}>
              Hard constraints: <b style={{ color: '#059669' }}>{ds2.hard_constraints.verified_count} verified</b>
              {' · '}<b style={{ color: '#d97706' }}>{ds2.hard_constraints.unknown_count} unknown</b>
              {' · '}<b style={{ color: '#dc2626' }}>{ds2.hard_constraints.failed_count} failed</b>
            </div>
          </div>
        )}

        {/* v1.5.1 — hard-constraint verification: which REQUESTED constraints
            were Verified / Proxy verified / Not verifiable / Requested but not
            enforced / Failed. Warning cards for anything unresolved. */}
        {hcv && hcv.constraints.length > 0 && (
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: '11px', color: '#475569', marginBottom: 8 }}>
            <b>Hard constraint verification</b>
            {HC_SUMMARY_META[hcv.summaryStatus] && (
              <span style={{ marginLeft: 6, fontWeight: 700, color: HC_SUMMARY_META[hcv.summaryStatus].color }}>
                — {HC_SUMMARY_META[hcv.summaryStatus].text}
              </span>
            )}
            <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
              <span style={{ color: hcv.verifiedCount > 0 ? '#059669' : '#94a3b8' }}>
                Verified: <b>{hcv.verifiedCount}</b>
              </span>
              <span style={{ color: hcv.proxyVerifiedCount > 0 ? '#d97706' : '#94a3b8' }}>
                Proxy verified: <b>{hcv.proxyVerifiedCount}</b>
              </span>
              <span style={{ color: hcv.unknownCount > 0 ? '#92400e' : '#94a3b8' }}>
                Not verifiable: <b>{hcv.unknownCount}</b>
              </span>
              <span style={{ color: hcv.unenforcedCount > 0 ? '#dc2626' : '#94a3b8' }}>
                Requested but not enforced: <b>{hcv.unenforcedCount}</b>
              </span>
              <span style={{ color: hcv.failedCount > 0 ? '#dc2626' : '#94a3b8' }}>
                Failed: <b>{hcv.failedCount}</b>
              </span>
            </div>
            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {hcv.constraints.filter(c => c.status !== 'not_required').map((c, i) => {
                const meta = HC_STATUS_META[c.status] || HC_STATUS_META.not_verifiable;
                return (
                  <span key={i} title={c.reason}>
                    {c.label}: <b style={{ color: meta.color }}>{meta.text}</b>
                    {c.fieldValidationRequired && (
                      <span style={{ color: '#94a3b8' }}> · field validation required</span>
                    )}
                  </span>
                );
              })}
            </div>
            {hcvWarnEntries.map((c, i) => (
              <div key={i} style={{
                marginTop: 6, borderRadius: 6, padding: '6px 10px', fontSize: '11px',
                background: c.status === 'failed' || c.severity === 'critical' ? '#fef2f2' : '#fffbeb',
                border: `1px solid ${c.status === 'failed' || c.severity === 'critical' ? '#fecaca' : '#fcd34d'}`,
                color: c.status === 'failed' || c.severity === 'critical' ? '#991b1b' : '#92400e',
              }}>
                <b>
                  {c.status === 'requested_not_enforced' ? 'Requested but not enforced'
                    : c.status === 'failed' ? 'Could not be enforced'
                    : 'Field validation required'}
                  : {c.label}.
                </b>{' '}
                {c.reason}
              </div>
            ))}
          </div>
        )}

        {/* v1.4.0 — provisional notice when hard constraints are unverifiable */}
        {isProvisional && unverifiedConstraints.length > 0 && (
          <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 12px', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, color: '#92400e', fontSize: '13px', marginBottom: 4 }}>
              ⚠ PROVISIONAL — field validation required
            </div>
            <p style={{ fontSize: '12px', color: '#78350f', margin: 0 }}>
              The following hard constraints <b>cannot be verified</b> from spatial data alone — they require broker confirmation, property surveys, or authority approvals:
            </p>
            <ul style={{ margin: '6px 0 4px', paddingLeft: 18, fontSize: '12px', color: '#78350f' }}>
              {unverifiedConstraints.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
            <p style={{ fontSize: '11px', color: '#92400e', margin: 0 }}>
              No candidate can be treated as <b>Recommended</b> until these are confirmed in the field.
            </p>
            <button className="assumptions-toggle" style={{ marginTop: 6, fontSize: '11px' }} onClick={() => setShowChecklist(!showChecklist)}>
              {showChecklist ? 'Hide' : 'Show'} validation checklist
            </button>
            {showChecklist && (
              <table style={{ width: '100%', marginTop: 6, fontSize: '11px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #fde68a' }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>Item</th>
                    <th style={{ textAlign: 'left', padding: '2px 4px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {validationChecklist.map((item: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid #fef3c7' }}>
                      <td style={{ padding: '2px 4px' }}>{item.item}</td>
                      <td style={{ padding: '2px 4px' }}>
                        <span style={{
                          color: item.status === 'verified' ? '#059669' :
                                 item.status === 'unverifiable' ? '#d97706' :
                                 item.status === 'failed' ? '#dc2626' :
                                 item.status === 'required' ? '#7c3aed' : '#64748b',
                          fontWeight: 600,
                        }}>
                          {item.status === 'verified' ? '✓ Verified' :
                           item.status === 'unverifiable' ? '? Unverifiable' :
                           item.status === 'failed' ? '✕ Failed' :
                           item.status === 'required' ? '! Required' :
                           item.status === 'not_applicable' ? '— N/A' : item.status}
                        </span>
                        <span style={{ color: '#94a3b8', fontSize: '10px', marginLeft: 4 }}>{item.detail}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* v1.4.0 — data coverage warning */}
        {coverageRatio < 0.65 && missingCritical.length > 0 && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 10px', marginBottom: 8, fontSize: '11px', color: '#991b1b' }}>
            <b>Low data coverage ({Math.round(coverageRatio * 100)}%)</b> — missing high-weight factor(s): {missingCritical.join(', ')}.
            Scores are lower-confidence proxy estimates.
          </div>
        )}

        {/* Senior-consultant self-critique of the computed result */}
        {result.critique && (
          <div className={`analyst-review review-${result.critique.verdict}`}>
            <div className="review-head">
              <span className="review-badge">
                {result.critique.verdict === 'reliable' ? '✅' : result.critique.verdict === 'unreliable' ? '❌' : '⚠️'}{' '}
                Analyst review — {result.critique.verdict}
              </span>
              <span className="review-conf">confidence: {result.critique.confidence}</span>
            </div>
            <p className="review-headline">{result.critique.headline}</p>
            {(result.critique.issues ?? []).length > 0 && (
              <div className="review-section">
                <div className="review-label">Issues</div>
                <ul>{(result.critique.issues ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {(result.critique.whatWouldStrengthen ?? []).length > 0 && (
              <div className="review-section">
                <div className="review-label">What would make this stronger</div>
                <ul>{(result.critique.whatWouldStrengthen ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
          </div>
        )}

        {/* Benchmark comparison — v1.4.6: score must be a real number */}
        {!withheld && spec && ranked[0] && !ranked[0].excluded && typeof ranked[0].mcda_score === 'number' && (() => {
          const bench = compareToBenchmark(ranked[0].mcda_score, spec.sectorId, spec.geography?.city);
          if (!bench) return null;
          const deltaClass = bench.delta > 0.5 ? 'above' : bench.delta < -0.5 ? 'below' : 'at';
          return (
            <div className="sg-benchmark">
              <span className="sg-benchmark-score">
                {ranked[0].mcda_score.toFixed(1)}/10
              </span>
              <span className={`sg-benchmark-delta ${deltaClass}`}>
                {bench.delta > 0 ? '+' : ''}{bench.delta.toFixed(1)} vs avg
              </span>
              <span className="sg-benchmark-insight">{bench.insight}</span>
            </div>
          );
        })()}

        {/* Analysis Assumptions Panel */}
        {spec && (
          <div className="drawer-assumptions">
            <button className="assumptions-toggle" onClick={() => setShowAssumptions(!showAssumptions)}>
              <span>Analysis Assumptions</span>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: showAssumptions ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showAssumptions && (
              <div className="assumptions-body">
                <div className="assumption-row">
                  <span className="assumption-label">Sector</span>
                  <span className="assumption-value">{spec.businessType}{spec.classificationMeta?.source === 'llm' ? '' : ` (${spec.sectorId})`}</span>
                </div>
                <div className="assumption-row">
                  <span className="assumption-label" title="Search radius is AI-inferred from your sector type and land intensity — not hardcoded. High-intensity sectors (warehouses, solar) get wider radii; high-street retail stays narrow.">Search Radius ⓘ</span>
                  <span className="assumption-value">{locations[0] ? `${(locations[0].searchRadiusM / 1000).toFixed(1)}km` : '—'}</span>
                </div>
                <p className="assumption-note" style={{ marginTop: '-2px', marginBottom: '6px', fontSize: '10px', color: '#64748b' }}>
                  AI-inferred from sector &amp; land intensity — not hardcoded
                </p>
                <div className="assumption-row">
                  <span className="assumption-label" title="Data Confidence measures pipeline quality — how much real-world data was collected. High = rich Places + OSM data. Medium = partial coverage. Low = mostly AI estimates. This is NOT a measure of how good the locations are.">Data Confidence ⓘ</span>
                  <span className={`assumption-value confidence-${spec.confidence}`} title="Data Confidence: high = rich real-world data collected; medium = partial; low = mostly AI estimates">{spec.confidence}</span>
                </div>
                <p className="assumption-note" style={{ marginTop: '-2px', marginBottom: '6px', fontSize: '10px', color: '#64748b' }}>
                  Measures data pipeline quality, not location quality
                </p>
                {(spec.constraints ?? []).length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Constraints</span>
                    <div className="assumption-chips">
                      {(spec.constraints ?? []).map((c, i) => (
                        <span key={i} className={`constraint-chip ${c.type}`}>
                          {c.direction === 'away' ? '✕ ' : '✓ '}{c.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {spec.userPointConstraints && spec.userPointConstraints.length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">CSV Spatial Constraints</span>
                    {spec.userPointConstraints.map((upc, i) => (
                      <div key={i} className="constraint-panel">
                        <div className="constraint-panel-row">
                          <span className={`constraint-chip ${upc.mode === 'exclude' ? 'exclusion' : 'proximity'}`}>
                            {upc.mode === 'exclude' ? '✕ Excluding' : upc.mode === 'include' ? '✓ Including' : '~ Penalizing'} areas within {(upc.radiusM / 1000).toFixed(1)}km of {upc.label}
                          </span>
                        </div>
                        <div className="constraint-panel-meta">
                          Radius: {(upc.radiusM / 1000).toFixed(1)}km ({upc.radiusSource === 'user' ? 'user-specified' : 'auto-inferred'})
                          {onToggleBuffers && (
                            <label className="buffer-toggle">
                              <input type="checkbox" checked={showBuffers} onChange={onToggleBuffers} />
                              Show buffers on map
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {(spec.positiveCriteria ?? []).length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Positive Signals</span>
                    <div className="assumption-chips">
                      {(spec.positiveCriteria ?? []).map((c, i) => <span key={i} className="constraint-chip proximity">▲ {c}</span>)}
                    </div>
                  </div>
                )}
                {(spec.negativeCriteria ?? []).length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Negative Signals</span>
                    <div className="assumption-chips">
                      {(spec.negativeCriteria ?? []).map((c, i) => <span key={i} className="constraint-chip exclusion">▼ {c}</span>)}
                    </div>
                  </div>
                )}
                {(spec.parsingNotes ?? []).length > 0 && (
                  <div className="assumption-section">
                    <span className="assumption-label">Notes</span>
                    {(spec.parsingNotes ?? []).map((n, i) => <p key={i} className="assumption-note">{n}</p>)}
                  </div>
                )}

                {/* AI vs Fixed parameters */}
                <div className="assumption-section">
                  <span className="assumption-label">How Parameters Are Set</span>
                  <p className="assumption-note"><strong>AI-driven:</strong> sector archetype, search radius, criteria weights, land intensity, neighborhood selection, score justifications.</p>
                  <p className="assumption-note"><strong>Fixed rules:</strong> deduplication distance (500m), score scale (0–10), MCDA weighted-sum formula, data source priority (Places → OSM → AI fallback).</p>
                </div>

                {/* Phase 18 — uploaded candidates disclosure (shown first when relevant) */}
                {uploadedCandidatesOnly && (
                  <div className="assumption-section" style={{ marginBottom: 8, background: '#f0fdf4', borderLeft: '3px solid #059669', paddingLeft: 8 }}>
                    <span className="assumption-label" style={{ color: '#059669' }}>Candidate Source</span>
                    <div style={{ fontSize: '0.84em', color: '#064e3b', lineHeight: 1.6 }}>
                      <b>Uploaded points only</b> — this analysis ranked user-supplied candidate sites, not a full study-area H3 search.
                      <br />
                      Total uploaded: <b>{uploadedCount}</b> · Ranked: <b>{rankedUploaded}</b> · Excluded: <b>{excludedUploaded}</b>
                      {uploadedWarnings.length > 0 && uploadedWarnings.map((w, i) => (
                        <div key={i} style={{ color: '#dc2626', marginTop: 2, fontSize: '0.9em' }}>⚠ {w}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* v1.2.0 — deterministic planning mode disclosure */}
                {planningMode === 'deterministic' && (
                  <div className="assumption-section" style={{ marginBottom: 8, background: '#f0fdf4', borderLeft: '3px solid #059669', paddingLeft: 8 }}>
                    <span className="assumption-label" style={{ color: '#059669' }}>Planning Mode</span>
                    <div style={{ fontSize: '0.82em', color: '#064e3b', lineHeight: 1.6 }}>
                      <b>Deterministic</b> — factor schema and weights from canonical archetype registry (not LLM).
                      {weightsSource === 'deterministic_registry' && <span> Weights: locked. </span>}
                      {planningFingerprint && <span title={`Planning: ${planningFingerprint} | Spec: ${specFp}`} style={{ color: '#64748b', fontSize: '0.9em' }}>ID: {planningFingerprint}</span>}
                      {llmOverrides.length > 0 && (
                        <div style={{ color: '#d97706', marginTop: 2, fontSize: '0.9em' }}>
                          {llmOverrides.length} LLM weight suggestion(s) overridden by canonical schema.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* No reliable recommendation banner (v1.2.0) */}
                {noReliableRec && (
                  <div style={{ background: '#fef2f2', border: '1px solid #dc2626', borderRadius: 6, padding: '8px 12px', marginBottom: 8 }}>
                    <b style={{ color: '#dc2626' }}>No recommendable sites found.</b>
                    <span style={{ color: '#7f1d1d', fontSize: '0.9em', marginLeft: 6 }}>Excluded candidates are shown below for inspection only.</span>
                    {relaxationOptions.length > 0 && (
                      <div style={{ marginTop: 6, color: '#92400e', fontSize: '0.85em' }}>
                        Relaxation options: {relaxationOptions.map(o => o.description).join(' | ')}
                      </div>
                    )}
                  </div>
                )}

                {/* v1.4.0 — reliability critic (always-on deterministic) */}
                <div className="assumption-section" style={{ marginBottom: 8 }}>
                  <span className="assumption-label">Analysis Quality</span>
                  <div style={{ fontSize: '0.82em', color: '#64748b', lineHeight: 1.5 }}>
                    <div>
                      Reliability critic: <b style={{ color: '#059669' }}>Deterministic (always-on)</b>
                    </div>
                    <div>
                      Constraint enforcement: <b style={{
                        color: constraintEnforcementLevel === 'verified' ? '#059669' :
                               constraintEnforcementLevel === 'provisional' ? '#d97706' : '#dc2626'
                      }}>
                        {constraintEnforcementLevel === 'verified' ? 'Verified' :
                         constraintEnforcementLevel === 'provisional' ? 'Provisional' :
                         constraintEnforcementLevel === 'failed' ? 'Failed' : constraintEnforcementLevel}
                      </b>
                    </div>
                    <div>
                      Site claim: <b style={{ color: '#64748b' }}>Micro-market zone</b>
                      <span style={{ fontSize: '0.88em', color: '#94a3b8', marginLeft: 4 }}>
                        (not parcel / building)
                      </span>
                    </div>
                    {dataCoverage.coverageRatio !== undefined && (
                      <div>
                        Data coverage: <b style={{
                          color: coverageRatio >= 0.75 ? '#059669' : coverageRatio >= 0.5 ? '#d97706' : '#dc2626'
                        }}>
                          {Math.round(coverageRatio * 100)}%
                        </b>
                        {missingCritical.length > 0 && (
                          <span style={{ color: '#dc2626', fontSize: '0.88em', marginLeft: 4 }}>
                            (missing: {missingCritical.join(', ')})
                          </span>
                        )}
                      </div>
                    )}
                    {untracedConstraints.length > 0 && (
                      <div style={{ color: '#dc2626', marginTop: 4 }}>
                        ⚠ {untracedConstraints.length} constraint phrase(s) not traced to a spec gate.
                      </div>
                    )}
                  </div>
                </div>

                {/* Sources */}
                <div className="assumption-section">
                  <span className="assumption-label">Data Sources</span>
                  {(result.grounding_sources ?? []).map((s, i) => (
                    <div key={i} className="source-row">
                      <a href={s.uri} target="_blank" rel="noopener noreferrer" className="source-link">{s.title}</a>
                      <span className="source-reliability">{s.reliability}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Suitability-by-factor choropleth toggles */}
        {poiTypes.length > 0 && (
          <div className="drawer-layers">
            <div className="drawer-layers-label">Map view: suitability by factor</div>
            <button
              className={`drawer-layer-btn ${!heatmapType ? 'active' : ''}`}
              onClick={() => onHeatmapChange(null)}
            >
              Overall
            </button>
            {poiTypes.map(t => (
              <button
                key={t}
                className={`drawer-layer-btn ${heatmapType === t ? 'active' : ''}`}
                onClick={() => onHeatmapChange(heatmapType === t ? null : t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {/* When withheld, the chart + ranked cards are hidden behind an explicit opt-in */}
        {withheld && (
          <button className="assumptions-toggle withheld-raw-toggle" onClick={() => setShowRaw(!showRaw)}>
            <span>{showRaw ? 'Hide raw candidates' : 'View raw candidates (not a recommendation)'}</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: showRaw ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
        )}
        {(!withheld || showRaw) && (
        <>
        {/* Persistent reminder that withheld results are diagnostic, not recommendations */}
        {withheld && showRaw && (
          <div className="withheld-raw-warning" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: '6px', padding: '8px 10px', fontSize: '12px', margin: '4px 0 8px' }}>
            ⚠ These are diagnostic <b>raw candidates, not site recommendations</b>. Scores and order are shown for inspection only.
          </div>
        )}
        {/* Comparison chart */}
        {selectedLocations.length >= 1
          ? <ComparisonChart locations={selectedLocations} />
          : <ComparisonChart locations={ranked.filter(l => !l.excluded).slice(0, 3)} />}

        {/* Location cards */}
        <div className="drawer-locations">
          {ranked.map((loc, index) => {
            const isSelected = selectedLocations.some(sl => sl.name === loc.name);
            const isExpanded = expandedLoc === loc.name;
            // v1.0.3.1 — when withheld, a non-excluded candidate is a RAW candidate,
            // not a recommendation: no #rank, no STRONG badge, muted styling.
            const raw = withheld && !loc.excluded;
            const scoreClass = loc.excluded ? 'score-excluded' : raw ? 'score-raw' : loc.mcda_score >= 7.5 ? 'score-high' : loc.mcda_score >= 5 ? 'score-mid' : 'score-low';
            const rankLabel = loc.excluded ? '✕' : raw ? `Raw ${String.fromCharCode(65 + index)}` : `#${index + 1}`;

            return (
              <div key={loc.name} className={`drawer-loc ${isSelected ? 'drawer-loc-selected' : ''} ${loc.excluded ? 'drawer-loc-excluded' : ''}`}>
                <div className="drawer-loc-header" onClick={() => onSelectLocation(loc)} role="button" tabIndex={0}>
                  <div className="drawer-loc-rank" style={raw ? { color: '#64748b', fontSize: '11px' } : undefined}>{rankLabel}</div>
                  <div className="drawer-loc-info">
                    <div className="drawer-loc-name">
                      {loc.name}
                      {loc.excluded && <span className="excluded-badge">EXCLUDED</span>}
                      {raw && <span className="excluded-badge" style={{ background: '#e2e8f0', color: '#475569' }}>RAW — NOT RECOMMENDED</span>}
                      {!loc.excluded && !raw && (loc as any).provisionalBadge && (
                        <span className="excluded-badge" style={{ background: '#fef3c7', color: '#92400e', borderColor: '#f59e0b' }}>
                          PROVISIONAL — field validation required
                        </span>
                      )}
                    </div>
                    <div className="drawer-loc-coords">
                      {typeof loc.lat === 'number' ? loc.lat.toFixed(4) : '—'}, {typeof loc.lng === 'number' ? loc.lng.toFixed(4) : '—'}
                    </div>
                  </div>
                  <div className={`drawer-loc-score ${scoreClass}`}>
                    {(loc as any).scoreWithheld ? (
                      <>
                        <span className="score-number" style={{ fontSize: '15px' }}>—</span>
                        <span className="score-quality-label" style={{ color: '#991b1b' }}>Withheld</span>
                      </>
                    ) : (
                      <>
                        {/* v1.4.0: show displayScore (rounded 0.5) instead of raw mcda_score.
                            v1.4.2: null-safe — a malformed/partial location must render "—"
                            rather than throw and blank the whole results panel. */}
                        <span className="score-number" style={raw ? { color: '#64748b' } : undefined}>
                          {typeof (loc as any).displayScore === 'number'
                            ? (loc as any).displayScore.toFixed(1)
                            : typeof loc.mcda_score === 'number'
                              ? loc.mcda_score.toFixed(1)
                              : '—'}
                        </span>
                        {!loc.excluded && (
                          <span className="score-quality-label" style={raw ? { color: '#64748b' } : undefined}>
                            {getRecommendationLabel(loc, withheld, raw, demoteRecommended)}
                          </span>
                        )}
                        {/* v1.4.0: confidence label */}
                        {!raw && !loc.excluded && (loc as any).confidenceLabel && (
                          <span style={{
                            fontSize: '0.70em',
                            color: (loc as any).confidenceLabel === 'High' ? '#059669' :
                                   (loc as any).confidenceLabel === 'Medium' ? '#d97706' : '#dc2626',
                            fontWeight: 600,
                          }}>
                            {(loc as any).confidenceLabel} confidence
                          </span>
                        )}
                        {/* v1.5-Lite: scenario ranking stability */}
                        {!raw && !loc.excluded && (loc as any).stabilityLabel
                          && STABILITY_TEXT[(loc as any).stabilityLabel] && (
                          <span
                            title={(loc as any).stabilityNote || 'Ranking stability under controlled weighting scenarios'}
                            style={{
                              fontSize: '0.70em', fontWeight: 600,
                              color: STABILITY_TEXT[(loc as any).stabilityLabel].color,
                            }}
                          >
                            {STABILITY_TEXT[(loc as any).stabilityLabel].text}
                          </span>
                        )}
                        {/* v1.4.0: score band */}
                        {!raw && !loc.excluded && (loc as any).scoreBand && (
                          <span style={{ fontSize: '0.68em', color: '#94a3b8' }}
                                title="Proxy-based screening score — band reflects data uncertainty">
                            ~{(loc as any).scoreBand}
                          </span>
                        )}
                        {/* v1.4.0: close-band warning */}
                        {!raw && !loc.excluded && (loc as any).closeBandWarning && (
                          <span style={{ fontSize: '0.68em', color: '#d97706' }}>
                            statistically similar
                          </span>
                        )}
                        {/* v1.1.0: show secondary score pills when available */}
                        {!raw && !loc.excluded && loc.relativeRankScore !== undefined && (
                          <span className="score-pills" style={{ fontSize: '0.72em', color: '#64748b', marginTop: 2, display: 'flex', gap: 4 }}>
                            <span title="Rank Score (vs peers)">R:{loc.relativeRankScore?.toFixed(1)}</span>
                            <span title="Absolute Viability">V:{loc.absoluteViabilityScore?.toFixed(1)}</span>
                            <span title="Data Confidence">C:{loc.confidenceScore?.toFixed(1)}</span>
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <button
                    className="drawer-expand"
                    onClick={(e) => { e.stopPropagation(); setExpandedLoc(isExpanded ? null : loc.name); }}
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                  </button>
                </div>

                {/* v1.5.1 — unresolved hard-constraint warnings for this
                    candidate zone (warning styling; red only for failed/critical) */}
                {!loc.excluded && (loc.hardConstraintWarnings ?? []).length > 0 && (
                  <div style={{ margin: '4px 12px 0', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {(loc.hardConstraintWarnings ?? []).slice(0, 3).map((w, i) => (
                      <div key={i} style={{
                        borderRadius: 5, padding: '3px 8px', fontSize: '10.5px',
                        background: w.severity === 'critical' || w.status === 'failed' ? '#fef2f2' : '#fffbeb',
                        border: `1px solid ${w.severity === 'critical' || w.status === 'failed' ? '#fecaca' : '#fde68a'}`,
                        color: w.severity === 'critical' || w.status === 'failed' ? '#991b1b' : '#92400e',
                      }}>
                        ⚠ {w.message}
                      </div>
                    ))}
                  </div>
                )}

                <p className="drawer-loc-reasoning">{loc.reasoning}</p>

                {isExpanded && (
                  <div className="drawer-loc-detail">
                    {/* Traffic context (typical-peak congestion — low confidence) */}
                    {loc.trafficContext && (
                      <div className={`traffic-context traffic-${loc.trafficContext.label}`} title={loc.trafficContext.note}>
                        <span className="traffic-badge">Traffic: {loc.trafficContext.label}</span>
                        <span className="traffic-ratio">
                          ×{typeof loc.trafficContext.congestionRatio === 'number' ? loc.trafficContext.congestionRatio.toFixed(2) : '—'} vs free-flow
                        </span>
                        <span className="traffic-conf">low-confidence area-activity signal</span>
                      </div>
                    )}

                    {/* Computed network routes (real ORS routing) */}
                    {loc.routeMetrics && Object.keys(loc.routeMetrics).length > 0 && (
                      <div className="drawer-routes">
                        <div className="drawer-routes-title">Network Routes (computed)</div>
                        {Object.entries(loc.routeMetrics).map(([cname, m]) => (
                          <div key={cname} className={`route-metric ${m.passed === true ? 'route-pass' : m.passed === false ? 'route-fail' : 'route-unavail'}`}>
                            <div className="route-metric-head">
                              <span>{m.passed === true ? '✓' : m.passed === false ? '✕' : '?'} {cname}</span>
                              <span className="route-metric-mode">{m.mode}</span>
                            </div>
                            {m.status === 'evaluated' ? (
                              <div className="route-metric-grid">
                                <span>Network dist: <b>{m.networkM}m</b></span>
                                <span>{m.mode === 'drive' ? 'Drive time' : 'Walk time'}: <b>{m.travelMin} min</b>{m.mode === 'drive' ? ' (free-flow)' : ''}</span>
                                <span>Straight-line: {m.straightLineM}m</span>
                                <span>Crosses railway: <b>{m.crossesRailway ? 'YES' : 'no'}</b></span>
                              </div>
                            ) : (
                              <div className="route-metric-unavail">Route unavailable — {m.reason}</div>
                            )}
                            <div className="route-metric-reason">{m.reason}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Exclusion checks — v1.4.2: null-safe, a missing/malformed
                        exclusions array must not crash the whole results panel. */}
                    {(loc.exclusions ?? []).length > 0 && (
                      <div className="drawer-exclusions">
                        {(loc.exclusions ?? []).map((ex, ei) => (
                          <div key={ei} className={`exclusion-item ${ex.passed ? 'exclusion-pass' : 'exclusion-fail'}`}>
                            <span>{ex.passed ? '✓' : '✕'} {ex.rule}</span>
                            <EvidenceTag basis={ex.evidenceBasis} />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Criteria — v1.4.2: null-safe over a missing breakdown array */}
                    <div className="drawer-criteria">
                      {(loc.criteria_breakdown ?? []).map((c, ci) => {
                        const noData = c.score === null || c.score === undefined;
                        return (
                        <div key={ci} className="drawer-criterion">
                          <div className="criterion-row">
                            <DirectionIcon direction={c.direction} />
                            <span className="criterion-name">{c.name}{(c as any).required && <span title="Required hard constraint" style={{ color: '#dc2626', marginLeft: 3 }}>*</span>}</span>
                            <EvidenceTag basis={c.evidenceBasis} />
                            <span className="criterion-score">{noData ? '—' : (c.score as number).toFixed(1)}</span>
                          </div>
                          {noData ? (
                            <div className="criterion-insufficient" style={{ fontSize: '11px', color: '#991b1b', padding: '2px 0' }}>
                              Insufficient data to evaluate this {(c as any).required ? 'required constraint' : 'factor'} — excluded from the score.
                            </div>
                          ) : (
                          <div className="criterion-bar-track">
                            <div className={`criterion-bar-fill ${c.direction === 'negative' ? 'bar-negative' : 'bar-positive'}`} style={{ width: `${(c.score as number) * 10}%` }} />
                          </div>
                          )}
                          <div className="criterion-meta">
                            <span className="criterion-raw">{noData ? 'no data' : `${c.rawValue} observed`}</span>
                            <span className="criterion-weight-label">weight: {Math.round(c.weight * 100)}%</span>
                            <input
                              type="range" min="0" max="0.5" step="0.05" value={c.weight}
                              onChange={(e) => onWeightChange(c.name, parseFloat(e.target.value))}
                              className="criterion-slider"
                            />
                          </div>
                          <p className="criterion-justification">{c.justification}</p>
                        </div>
                        );
                      })}
                    </div>

                    {/* OSM Signals — v1.4.2: null-safe over a missing signals object */}
                    <div className="drawer-signals">
                      <div className="signals-title">Observed OSM Signals</div>
                      <div className="signals-grid">
                        {Object.entries(loc.osmSignals ?? {}).map(([key, val]) => (
                          <div key={key} className="signal-item">
                            <span className="signal-key">{key.replace(/_/g, ' ')}</span>
                            <span className="signal-val">{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
        )}
        {/* v1.3.0 — Evidence Trail Section */}
        <div className="drawer-assumptions" style={{ marginTop: 12 }}>
          <button
            className="assumptions-toggle"
            onClick={() => setShowEvidence(!showEvidence)}
            style={{ background: showEvidence ? '#f0fdf4' : undefined }}
          >
            <span>🔍 Evidence Trail {evidenceTrail ? `(v${evidenceTrail.evidenceVersion})` : '(unavailable)'}</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="icon-xs" style={{ transform: showEvidence ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>

          {showEvidence && !evidenceTrail && (
            <div className="assumptions-body" style={{ color: '#64748b', fontSize: '0.85em', padding: '8px 0' }}>
              Evidence trail not available for this analysis (may be a saved or demo result).
            </div>
          )}

          {showEvidence && evidenceTrail && (
            <div className="assumptions-body">

              {/* 1. Analysis Identity */}
              <div className="assumption-section">
                <span className="assumption-label" style={{ color: '#059669', fontWeight: 600 }}>Analysis Identity</span>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '3px 8px', fontSize: '0.8em', color: '#374151' }}>
                  <span style={{ color: '#64748b' }}>Version</span><span>{evidenceTrail.appVersion} (engine {evidenceTrail.engineVersion})</span>
                  <span style={{ color: '#64748b' }}>Job ID</span><span style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{(evidenceTrail.jobId || '').slice(0, 16)}…</span>
                  <span style={{ color: '#64748b' }}>Analysis ID</span><span style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{evidenceTrail.analysisId}</span>
                  <span style={{ color: '#64748b' }}>Created</span><span>{(evidenceTrail.createdAt || '').replace('T', ' ').replace('Z', ' UTC')}</span>
                  <span style={{ color: '#64748b' }}>Archetype</span><span style={{ fontFamily: 'monospace' }}>{evidenceTrail.prompt.archetypeKey || '—'}</span>
                  <span style={{ color: '#64748b' }}>Planning</span><span>{evidenceTrail.prompt.planningMode}</span>
                  {evidenceTrail.prompt.planningFingerprint && (
                    <><span style={{ color: '#64748b' }}>Plan FP</span><span style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{evidenceTrail.prompt.planningFingerprint}</span></>
                  )}
                  <span style={{ color: '#64748b' }}>Study area</span><span>{evidenceTrail.studyArea.label || '—'}</span>
                  <span style={{ color: '#64748b' }}>H3 resolution</span><span>{evidenceTrail.studyArea.h3Resolution}</span>
                  <span style={{ color: '#64748b' }}>Cells before masks</span><span>{evidenceTrail.studyArea.h3CellCountBeforeMasks}</span>
                </div>
              </div>

              {/* 2. Data Sources */}
              {evidenceTrail.providerQueries.length > 0 && (
                <div className="assumption-section">
                  <span className="assumption-label" style={{ color: '#059669', fontWeight: 600 }}>Data Sources ({evidenceTrail.providerQueries.length} queries)</span>
                  <table style={{ width: '100%', fontSize: '0.75em', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: '#64748b', borderBottom: '1px solid #e2e8f0' }}>
                        <th style={{ textAlign: 'left', padding: '2px 4px' }}>Provider</th>
                        <th style={{ textAlign: 'left', padding: '2px 4px' }}>Purpose</th>
                        <th style={{ textAlign: 'right', padding: '2px 4px' }}>Features</th>
                        <th style={{ textAlign: 'center', padding: '2px 4px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evidenceTrail.providerQueries.map((q, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '2px 4px', color: '#1d4ed8' }}>{q.provider}</td>
                          <td style={{ padding: '2px 4px', color: '#374151' }}>{q.queryPurpose}</td>
                          <td style={{ padding: '2px 4px', textAlign: 'right', fontWeight: 600 }}>{q.featureCount}</td>
                          <td style={{ padding: '2px 4px', textAlign: 'center' }}>
                            <span style={{ color: q.responseStatus === 'ok' ? '#059669' : '#d97706', fontSize: '0.9em' }}>
                              {q.responseStatus === 'ok' ? '✓' : '⚠'}
                            </span>
                            {q.warning && <span title={q.warning} style={{ color: '#d97706', marginLeft: 2 }}>!</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 3. Factor Evidence */}
              {evidenceTrail.factors.length > 0 && (
                <div className="assumption-section">
                  <span className="assumption-label" style={{ color: '#059669', fontWeight: 600 }}>Factor Evidence</span>
                  {evidenceTrail.factors.map((f) => (
                    <div key={f.factorKey} style={{ marginBottom: 6, border: '1px solid #e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
                      <button
                        style={{ width: '100%', textAlign: 'left', background: '#f8fafc', border: 'none', padding: '4px 8px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                        onClick={() => setEvidenceExpandedFactor(evidenceExpandedFactor === f.factorKey ? null : f.factorKey)}
                      >
                        <span style={{ fontSize: '0.8em', fontWeight: 600, color: '#1e293b' }}>
                          {f.direction === 'positive' ? '▲' : '▼'} {f.displayName}
                        </span>
                        <span style={{ fontSize: '0.72em', color: '#64748b' }}>
                          weight {Math.round((f.weight ?? 0) * 100)}% · {f.catchment} · {f.dataSources?.[0] || 'Internal'}
                        </span>
                      </button>
                      {evidenceExpandedFactor === f.factorKey && (
                        <div style={{ padding: '4px 8px 8px', fontSize: '0.75em' }}>
                          <div style={{ color: '#64748b', marginBottom: 4 }}>
                            {f.rawValueDescription} · Normalization: {f.normalizationMethod} · Missing: {f.missingDataPolicy}
                          </div>
                          {(f.appliedToCandidates ?? []).length > 0 && (
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead>
                                <tr style={{ color: '#64748b', borderBottom: '1px solid #e2e8f0' }}>
                                  <th style={{ textAlign: 'left', padding: '2px 4px' }}>Candidate</th>
                                  <th style={{ textAlign: 'right', padding: '2px 4px' }}>Raw</th>
                                  <th style={{ textAlign: 'right', padding: '2px 4px' }}>Norm</th>
                                  <th style={{ textAlign: 'right', padding: '2px 4px' }}>Weighted</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(f.appliedToCandidates ?? []).map((cf, ci) => (
                                  <tr key={ci} title={cf.explanation} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                    <td style={{ padding: '2px 4px', color: '#374151' }}>{cf.candidateId}</td>
                                    <td style={{ padding: '2px 4px', textAlign: 'right' }}>{cf.rawCount ?? cf.rawValue ?? '—'}</td>
                                    <td style={{ padding: '2px 4px', textAlign: 'right' }}>{cf.normalizedScore != null ? cf.normalizedScore.toFixed(1) : '—'}</td>
                                    <td style={{ padding: '2px 4px', textAlign: 'right', fontWeight: 600 }}>{cf.weightedScore != null ? cf.weightedScore.toFixed(2) : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 4. Candidate Breakdown */}
              {evidenceTrail.candidates.length > 0 && (
                <div className="assumption-section">
                  <span className="assumption-label" style={{ color: '#059669', fontWeight: 600 }}>Candidate Evidence</span>
                  {evidenceTrail.candidates.map((c) => (
                    <div key={c.candidateId} style={{ marginBottom: 6, fontSize: '0.78em', padding: '4px 6px', background: c.recommendationStatus === 'excluded_candidate' ? '#fef2f2' : '#f0fdf4', borderRadius: 4, borderLeft: `3px solid ${c.recommendationStatus === 'excluded_candidate' ? '#dc2626' : c.recommendationStatus === 'recommended' ? '#059669' : '#d97706'}` }}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>
                        {c.rank ? `#${c.rank} ` : ''}{c.label} — {(c.recommendationStatus || 'unknown').replace(/_/g, ' ')}
                        {typeof c.totalScore === 'number' && <span style={{ float: 'right', color: '#64748b' }}>{c.totalScore.toFixed(1)}/10</span>}
                      </div>
                      {(c.exclusionReasons ?? []).length > 0 && (
                        <div style={{ color: '#dc2626' }}>Excluded: {(c.exclusionReasons ?? []).join('; ')}</div>
                      )}
                      {/* Top drivers */}
                      {(c.factorBreakdown ?? []).filter(f => f.weightedScore != null).sort((a, b) => Math.abs(b.weightedScore!) - Math.abs(a.weightedScore!)).slice(0, 3).map((f, i) => (
                        <div key={i} style={{ color: '#374151' }} title={f.explanation}>
                          {(f.weightedScore ?? 0) >= 0 ? '+' : ''}{f.weightedScore?.toFixed(2)} {f.candidateId.replace('cand_', 'layer ')}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* 5. Exclusion Ledger */}
              {evidenceTrail.exclusions.length > 0 && (
                <div className="assumption-section">
                  <span className="assumption-label" style={{ color: '#059669', fontWeight: 600 }}>Exclusion Ledger ({evidenceTrail.exclusions.length} events)</span>
                  {evidenceTrail.exclusions.map((ex, i) => (
                    <div key={i} style={{ fontSize: '0.78em', color: '#374151', padding: '2px 0', borderBottom: '1px solid #f1f5f9' }}>
                      <span style={{ background: '#fee2e2', color: '#991b1b', padding: '1px 4px', borderRadius: 3, marginRight: 4, fontSize: '0.85em' }}>{ex.targetType === 'h3_cell' ? 'Cells' : 'Candidate'}</span>
                      <span style={{ color: '#dc2626' }}>{ex.source}</span>
                      <span style={{ color: '#64748b', marginLeft: 4 }}>{ex.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* 6. Scoring Formula */}
              <div className="assumption-section">
                <span className="assumption-label" style={{ color: '#059669', fontWeight: 600 }}>Scoring Formula</span>
                <p className="assumption-note" style={{ fontFamily: 'monospace', fontSize: '0.8em', background: '#f8fafc', padding: '4px 6px', borderRadius: 4 }}>
                  {evidenceTrail.scoring.formulaDescription}
                </p>
                <div style={{ fontSize: '0.78em', color: '#64748b' }}>
                  Total weight: {(evidenceTrail.scoring.totalWeight ?? 0).toFixed(2)} · Present weight: {(evidenceTrail.scoring.totalPresentWeight ?? 0).toFixed(2)}
                  {evidenceTrail.scoring.minViableScore != null && <> · Min viable: {evidenceTrail.scoring.minViableScore}/10</>}
                  {' · '}{evidenceTrail.scoring.viableCandidates} viable candidate(s)
                </div>
                <div style={{ fontSize: '0.78em', color: '#64748b', marginTop: 2 }}>{evidenceTrail.scoring.missingDataHandling}</div>
              </div>

              {/* 7. Reproducibility */}
              <div className="assumption-section">
                <span className="assumption-label" style={{ color: '#059669', fontWeight: 600 }}>Reproducibility</span>
                <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '3px 8px', fontSize: '0.78em', color: '#374151' }}>
                  <span style={{ color: '#64748b' }}>Snapshot ID</span><span style={{ fontFamily: 'monospace' }}>{evidenceTrail.dataSnapshot.snapshotId}</span>
                  <span style={{ color: '#64748b' }}>Provider mode</span><span>{evidenceTrail.dataSnapshot.providerMode}</span>
                  <span style={{ color: '#64748b' }}>Geometry hash</span><span style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{evidenceTrail.studyArea.geometryHash || '—'}</span>
                  <span style={{ color: '#64748b' }}>Plan fingerprint</span><span style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{evidenceTrail.prompt.planningFingerprint || '—'}</span>
                </div>
                <p className="assumption-note" style={{ fontSize: '0.75em', color: '#64748b', marginTop: 4 }}>
                  ⚠ Audit reproducible — the plan and scoring formula are stable. Full data replay requires cached provider snapshots.
                </p>
                <button
                  className="assumptions-toggle"
                  style={{ marginTop: 6, fontSize: '0.8em', padding: '4px 10px' }}
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(evidenceTrail, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `stratageo-evidence-${(evidenceTrail.jobId || 'unknown').slice(0, 8)}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <span>↓ Export Evidence JSON</span>
                </button>
              </div>

              {/* Limitations */}
              {(evidenceTrail.limitations ?? []).length > 0 && (
                <div className="assumption-section">
                  <span className="assumption-label" style={{ color: '#d97706' }}>Known Limitations</span>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {(evidenceTrail.limitations ?? []).slice(0, 6).map((l, i) => (
                      <li key={i} className="assumption-note" style={{ fontSize: '0.75em', color: '#78350f' }}>{l}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
};
