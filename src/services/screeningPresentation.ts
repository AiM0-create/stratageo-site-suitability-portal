/**
 * Screening presentation helpers — vNext (v1.8.0).
 *
 * Pure, deterministic projections of the analysis payload into the
 * investigation-zone product surface: executive summary, evidence-backed zone
 * reasons and key risks. (v2.1.0 removed the reweight rank deltas, the
 * methodology comparison and the copyable summary along with their panels.)
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

/** v1.11.2 — a factor reduced to something the eye can read without parsing a
 * sentence. Live feedback: "still a lot of info which I really have to READ to
 * understand what's going on". `topEvidenceReasons` returns prose like
 * "Strong road / transit accessibility (9.8/10) · Strong demand density proxy
 * (6.1/10)" — accurate, but it has to be read word by word. The same facts as
 * {label, score, tone} render as a labelled bar the user takes in at a glance.
 * No new data, no recomputation — a presentation projection of the same
 * criteria the prose was built from. */
export interface FactorSignal {
  label: string;                 // plain, direction-aware ("Road / transit access")
  score: number;                 // 0-10, already direction-corrected by the engine
  tone: 'good' | 'mixed' | 'weak';
}

export function topFactorSignals(loc: LocationData, n = 3): FactorSignal[] {
  return (loc.criteria_breakdown ?? [])
    .filter(c => c.score !== null && c.score !== undefined)
    .sort((a, b) => (b.score! * b.weight) - (a.score! * a.weight))
    .slice(0, n)
    .map(c => ({
      label: signalLabel(c),
      score: c.score!,
      tone: c.score! >= 6.5 ? 'good' : c.score! >= 4.0 ? 'mixed' : 'weak',
    }));
}

/** Direction-aware plain label — says what the score MEANS on the ground, so
 * the bar needs no legend ("Rivals nearby" reads correctly whether the raw
 * factor was inverted or not). */
function signalLabel(c: MCDACriteria): string {
  // Strip trailing analyst jargon repeatedly: "Demand density proxy" → "Demand".
  // Never strip down to nothing — a factor named only "Score" keeps its name.
  let name = c.name.trim();
  for (;;) {
    const next = name.replace(/\s*(proxy|density|index|score)\s*$/i, '').trim();
    if (!next || next === name) break;
    name = next;
  }
  if (c.scoringCurve === 'target_band') return `${name} — balance`;
  if (c.direction === 'negative') return `${name} — low nearby`;
  return name;
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
  verifiedCells: number | null;      // v2.0.0 — shortlist re-verified and ranked
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
    verifiedCells: typeof result.shortlist?.size === 'number' ? result.shortlist.size : null,
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
