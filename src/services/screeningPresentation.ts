/**
 * Screening presentation helpers — vNext (v1.8.0).
 *
 * Pure, deterministic projections of the analysis payload into the
 * investigation-zone product surface: executive summary, evidence-backed zone
 * reasons, key risks, reweight rank deltas, micro↔macro methodology
 * comparison, and the copyable analysis summary used by the conversion CTA.
 *
 * No fabrication: every string is computed from fields the engine actually
 * returned. Anything missing renders as absent, never as a made-up value.
 */

import type { AnalysisResult, LocationData, MCDACriteria } from '../types';

// ─── Evidence-backed zone reasons ───

/** Top N strongest evidence-backed reasons for a zone, direction-aware.
 * Only factors WITH data qualify; ordered by weighted contribution. */
export function topEvidenceReasons(loc: LocationData, n = 3): string[] {
  const scored = (loc.criteria_breakdown ?? [])
    .filter(c => c.score !== null && c.score !== undefined)
    .sort((a, b) => (b.score! * b.weight) - (a.score! * a.weight));
  const reasons: string[] = [];
  for (const c of scored) {
    if (reasons.length >= n) break;
    if (c.score! < 5.5) continue;                       // only genuine strengths
    reasons.push(phraseCriterion(c));
  }
  // A zone with no strong factor still gets its single best, honestly phrased.
  if (reasons.length === 0 && scored.length > 0) {
    const best = scored[0];
    reasons.push(`${best.name}: ${best.score!.toFixed(1)}/10 — the strongest available factor here`);
  }
  return reasons;
}

/** One factor phrased in its real-world direction (never raw score-speak). */
function phraseCriterion(c: MCDACriteria): string {
  const s = c.score!.toFixed(1);
  if (c.scoringCurve === 'target_band') {
    return `Balanced ${c.name.toLowerCase()} (${s}/10 — moderate presence, per your brief)`;
  }
  if (c.direction === 'negative') {
    // pre-inverted: a high score means LITTLE of the measured thing nearby
    return `Low ${c.name.toLowerCase()} (${s}/10)`;
  }
  return `Strong ${c.name.toLowerCase()} (${s}/10)`;
}

/** The zone's most important weakness or uncertainty, or null when the
 * evidence shows none. Checks weak factors, then failed checks, then
 * no-data factors. */
export function keyRisk(loc: LocationData): string | null {
  const withData = (loc.criteria_breakdown ?? [])
    .filter(c => c.score !== null && c.score !== undefined)
    .sort((a, b) => a.score! - b.score!);
  const weakest = withData[0];
  if (weakest && weakest.score! <= 4.0) {
    if (weakest.scoringCurve === 'target_band') {
      return `${weakest.name} is outside the desired band (${weakest.score!.toFixed(1)}/10 — either saturated or empty)`;
    }
    return weakest.direction === 'negative'
      ? `High ${weakest.name.toLowerCase()} (${weakest.score!.toFixed(1)}/10 after inversion)`
      : `Weak ${weakest.name.toLowerCase()} (${weakest.score!.toFixed(1)}/10)`;
  }
  const failed = (loc.exclusions ?? []).find(e => e.passed === false);
  if (failed) return failed.detail || `Failed check: ${failed.rule}`;
  const noData = (loc.criteria_breakdown ?? []).find(c => c.score === null || c.score === undefined);
  if (noData) return `${noData.name} could not be evaluated (no usable data)`;
  return null;
}

// ─── Executive summary ───

export interface ExecutiveSummary {
  screenedCells: number | null;      // total grid cells screened
  eligibleCells: number | null;      // cells surviving exclusion masks
  businessType: string;
  targetLocation: string;
  topZoneName: string | null;
  topZoneVerdict: string | null;
  topZoneScore: number | null;
  confidenceLevel: string | null;    // unified confidence, when present
  reasons: string[];                 // why the top zone stands out
  criticalNextCheck: string | null;  // first next-validation action
  claimLevel: string;                // investigation_zone | uploaded_candidate…
  spatialScale: string | null;
}

export function buildExecutiveSummary(
  result: AnalysisResult,
  locations: LocationData[],
): ExecutiveSummary {
  const grid = result.hexGrid ?? [];
  const top = locations.find(l => !l.excluded) ?? null;
  const intel = (result.analysisIntelligence ?? {}) as Record<string, unknown>;
  return {
    screenedCells: grid.length > 0 ? grid.length : null,
    eligibleCells: grid.length > 0 ? grid.filter(c => !c.excluded).length : null,
    businessType: result.business_type || '',
    targetLocation: result.target_location || '',
    topZoneName: top?.name ?? null,
    topZoneVerdict: top?.screeningVerdict ?? null,
    topZoneScore: top && !top.scoreWithheld ? top.mcda_score : null,
    confidenceLevel: (result as any).unifiedConfidence?.level ?? null,
    reasons: top ? topEvidenceReasons(top) : [],
    criticalNextCheck: top?.nextValidation?.[0] ?? null,
    claimLevel: (result as any).claimLevel
      || (result.siteClaimLevel === 'point_candidate' ? 'uploaded_candidate' : 'investigation_zone'),
    spatialScale: typeof intel.spatialScale === 'string' ? intel.spatialScale : null,
  };
}

// ─── Reweight rank deltas (§8.3) ───

export interface RankDelta {
  prevRank: number | null;   // null = newly introduced (not in original shortlist)
  newRank: number;
  moved: number | null;      // positive = moved up
}

const rankByScore = (list: LocationData[]): Map<string, number> => {
  const m = new Map<string, number>();
  list
    .filter(l => !l.excluded && typeof l.mcda_score === 'number')
    .sort((a, b) => b.mcda_score - a.mcda_score)
    .forEach((l, i) => m.set(l.name, i + 1));
  return m;
};

/** Compare the ORIGINAL (backend-verified) shortlist against the current
 * (client-reweighted) one. Zones only in the new list are newly introduced —
 * they must NOT inherit the old shortlist's verification evidence. */
export function computeRankDeltas(
  original: LocationData[],
  current: LocationData[],
): Record<string, RankDelta> {
  const prev = rankByScore(original);
  const next = rankByScore(current);
  const out: Record<string, RankDelta> = {};
  for (const [name, newRank] of next) {
    const prevRank = prev.get(name) ?? null;
    out[name] = {
      prevRank,
      newRank,
      moved: prevRank === null ? null : prevRank - newRank,
    };
  }
  return out;
}

// ─── Micro↔macro methodology comparison (§9) ───

export interface MethodologyComparison {
  retained: string[];
  added: string[];
  removed: string[];
  scaleChange: { from: string; to: string } | null;
  radiusChange: { fromM: number; toM: number } | null;
}

const factorNames = (r: AnalysisResult): string[] => {
  const dq = (r as any).dataQuality as Array<{ name?: string }> | undefined;
  if (Array.isArray(dq) && dq.length > 0) {
    return dq.map(d => d.name).filter((n): n is string => typeof n === 'string');
  }
  return (r.locations?.[0]?.criteria_breakdown ?? []).map(c => c.name);
};

/** Compare two runs of the SAME business (e.g. JP Nagar micro → South
 * Bengaluru macro). Returns null when the runs aren't comparable. */
export function buildMethodologyComparison(
  prev: AnalysisResult | null | undefined,
  next: AnalysisResult,
): MethodologyComparison | null {
  if (!prev) return null;
  const sameBiz = (prev.business_type || '').toLowerCase().trim()
    === (next.business_type || '').toLowerCase().trim();
  if (!sameBiz || !prev.business_type) return null;

  const prevF = new Set(factorNames(prev));
  const nextF = new Set(factorNames(next));
  if (prevF.size === 0 || nextF.size === 0) return null;

  const retained = [...nextF].filter(f => prevF.has(f));
  const added = [...nextF].filter(f => !prevF.has(f));
  const removed = [...prevF].filter(f => !nextF.has(f));

  const scaleOf = (r: AnalysisResult): string | null => {
    const v = (r.analysisIntelligence as Record<string, unknown> | undefined)?.spatialScale;
    return typeof v === 'string' ? v : null;
  };
  const ps = scaleOf(prev), ns = scaleOf(next);
  const scaleChange = ps && ns && ps !== ns ? { from: ps, to: ns } : null;

  const radiusOf = (r: AnalysisResult): number | null =>
    r.locations?.find(l => !l.excluded)?.searchRadiusM ?? null;
  const pr = radiusOf(prev), nr = radiusOf(next);
  const radiusChange = pr !== null && nr !== null && pr !== nr
    ? { fromM: pr, toM: nr } : null;

  // Nothing changed AND same scale → no comparison worth showing.
  if (added.length === 0 && removed.length === 0 && !scaleChange && !radiusChange) return null;
  return { retained, added, removed, scaleChange, radiusChange };
}

// ─── Copyable analysis summary (conversion CTA, §7) ───

/** Deterministic plain-text summary safe to paste into an email or contact
 * form. Uses only computed values; never exposes the raw prompt. */
export function buildCopySummary(
  result: AnalysisResult,
  locations: LocationData[],
  shareUrl?: string | null,
): string {
  const ex = buildExecutiveSummary(result, locations);
  const lines: string[] = [];
  lines.push('StrataGeo screening summary');
  lines.push(`Business: ${ex.businessType || 'n/a'}`);
  if (ex.targetLocation) lines.push(`Geography: ${ex.targetLocation}`);
  if (ex.screenedCells !== null) {
    const cellWord = ex.screenedCells === 1 ? 'grid cell' : 'grid cells';
    lines.push(`Screened: ${ex.screenedCells} ${cellWord} (${ex.eligibleCells} eligible after exclusions)`);
  }
  lines.push(`Output type: ${ex.claimLevel.replace(/_/g, ' ')} (screening-level; not verified properties)`);
  if (ex.confidenceLevel) lines.push(`Screening confidence: ${ex.confidenceLevel}`);
  const ranked = locations.filter(l => !l.excluded).slice(0, 3);
  if (ranked.length > 0) {
    lines.push('Priority investigation zones:');
    ranked.forEach((l, i) => {
      const v = l.screeningVerdict ? ` [${l.screeningVerdict}]` : '';
      const s = l.scoreWithheld ? 'score withheld' : `${l.mcda_score}/10`;
      lines.push(`  ${i + 1}. ${l.name} — ${s}${v}`);
    });
  }
  const nextChecks = ranked[0]?.nextValidation?.slice(0, 3) ?? [];
  if (nextChecks.length > 0) {
    lines.push('Outstanding validation before site selection:');
    nextChecks.forEach(a => lines.push(`  - ${a}`));
  }
  if (result.jobRef) lines.push(`Analysis ref: ${result.jobRef}`);
  if (shareUrl) lines.push(`Shared analysis: ${shareUrl}`);
  return lines.join('\n');
}
