/**
 * MCDA Engine — Dynamic Multi-Criteria Decision Analysis with directional scoring.
 *
 * Supports:
 * - Positive variables (more = better)
 * - Negative variables (more = worse, inverted scoring)
 * - Hard exclusion rules
 * - Dynamic weight adjustment
 * - Evidence-tagged justifications
 */

import type { MCDACriteria, ExclusionCheck, LocationData, AnalysisSpec, SpatialConstraint, UserPointConstraint } from '../types';
import type { CriterionTemplate, SectorTemplate } from './sectorTemplates';
import { getSectorById } from './sectorTemplates';
import { buildUserPointExclusions, scoreUserPointProximity } from './userPointManager';

interface OsmSignals {
  [key: string]: number;
}

// ─── Score a single criterion ───

function scoreCriterion(template: CriterionTemplate, rawValue: number, radiusM: number): MCDACriteria {
  const { scoringThresholds: t, direction, name, evidenceBasis } = template;

  let score: number;
  if (direction === 'positive') {
    // More = better
    if (rawValue <= t[0]) score = 1;
    else if (rawValue <= t[1]) score = 3;
    else if (rawValue <= t[2]) score = 5;
    else if (rawValue <= t[3]) score = 7;
    else if (rawValue <= t[4]) score = 8;
    else score = 9;
  } else {
    // Negative direction: fewer = better (inverted)
    if (rawValue === 0) score = 8; // None found — good for negative criteria
    else if (rawValue <= t[1]) score = 7;
    else if (rawValue <= t[2]) score = 6;
    else if (rawValue <= t[3]) score = 4;
    else if (rawValue <= t[4]) score = 3;
    else score = 2;
  }

  const radiusKm = (radiusM / 1000).toFixed(1);
  const dirLabel = direction === 'positive' ? '' : ' (inverted — lower count = higher score)';
  const justification = `${rawValue} ${name.toLowerCase()} features observed within ${radiusKm}km via OSM.${dirLabel}`;

  return {
    name,
    weight: template.defaultWeight,
    score: Math.round(score * 10) / 10,
    rawValue,
    direction,
    justification,
    evidenceBasis,
    osmQuery: template.osmQuery.tags.join(', '),
  };
}

// ─── Score all criteria for a neighborhood ───

export function scoreNeighborhood(
  osmSignals: OsmSignals,
  sector: SectorTemplate,
  spec: AnalysisSpec,
): MCDACriteria[] {
  const criteria: MCDACriteria[] = [];

  for (const template of sector.criteria) {
    const raw = osmSignals[template.osmSignalKey] ?? 0;
    const weight = spec.inferredWeights[template.name] ?? template.defaultWeight;
    const criterion = scoreCriterion(template, raw, sector.searchRadiusM);
    criterion.weight = weight;
    criteria.push(criterion);
  }

  // Add constraint-derived criteria
  for (const constraint of spec.constraints) {
    if (constraint.type !== 'preference') continue;
    // Check if already covered by sector criteria
    const alreadyCovered = criteria.some(c =>
      c.name.toLowerCase().includes(constraint.target.toLowerCase()) ||
      constraint.target.toLowerCase().includes(c.name.toLowerCase().split(' ')[0])
    );
    if (alreadyCovered) continue;

    // Add as dynamic criterion if we have OSM signal for it
    const signalKey = constraint.target.toLowerCase().replace(/\s+/g, '_');
    const raw = osmSignals[signalKey] ?? 0;
    if (raw > 0 || constraint.direction === 'away') {
      criteria.push({
        name: constraint.target,
        weight: 0.10,
        score: constraint.direction === 'near'
          ? Math.min(9, Math.max(1, Math.round(raw * 1.5)))
          : Math.min(9, Math.max(1, 10 - Math.round(raw * 1.5))),
        rawValue: raw,
        direction: constraint.direction === 'near' ? 'positive' : 'negative',
        justification: `${raw} features observed for "${constraint.label}" constraint.`,
        evidenceBasis: raw > 0 ? 'osm-observed' : 'constraint-rule',
      });
    }
  }

  return criteria;
}

/**
 * Score neighborhood with user-point proximity as additional criterion.
 * Call this after scoreNeighborhood() to append user-point criteria.
 */
export function addUserPointCriteria(
  criteria: MCDACriteria[],
  candidateLat: number,
  candidateLng: number,
  userPointConstraints: UserPointConstraint[],
): MCDACriteria[] {
  for (const upc of userPointConstraints) {
    if (upc.points.length === 0) continue;
    criteria.push(scoreUserPointProximity(candidateLat, candidateLng, upc));
  }
  return criteria;
}

// ─── Compute weighted MCDA score ───

export function computeMCDAScore(criteria: MCDACriteria[]): number {
  let totalWeighted = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    if (c.weight <= 0) continue;
    totalWeighted += c.score * c.weight;
    totalWeight += c.weight;
  }
  return totalWeight > 0 ? Math.round((totalWeighted / totalWeight) * 10) / 10 : 0;
}

// ─── Exclusion checks ───

export function checkExclusions(
  osmSignals: OsmSignals,
  constraints: SpatialConstraint[],
  radiusM: number,
  candidateLat?: number,
  candidateLng?: number,
  userPointConstraints?: UserPointConstraint[],
): ExclusionCheck[] {
  const checks: ExclusionCheck[] = [];

  // OSM-based exclusions
  for (const constraint of constraints) {
    if (constraint.type !== 'exclusion' && !constraint.hardRule) continue;

    const signalKey = constraint.target.toLowerCase().replace(/\s+/g, '_');
    const count = osmSignals[signalKey] ?? 0;

    if (constraint.direction === 'away') {
      const passed = count === 0;
      checks.push({
        rule: constraint.label,
        passed,
        detail: passed
          ? `No ${constraint.target.toLowerCase()} found within search radius — exclusion passed.`
          : `${count} ${constraint.target.toLowerCase()} found within search radius — exclusion failed.`,
        evidenceBasis: 'osm-observed',
      });
    } else if (constraint.direction === 'near' && constraint.hardRule) {
      const passed = count > 0;
      checks.push({
        rule: constraint.label,
        passed,
        detail: passed
          ? `${count} ${constraint.target.toLowerCase()} found within search radius — proximity requirement met.`
          : `No ${constraint.target.toLowerCase()} found within search radius — proximity requirement not met.`,
        evidenceBasis: 'osm-observed',
      });
    }
  }

  // User-point-based exclusions (haversine distance checks)
  if (candidateLat != null && candidateLng != null && userPointConstraints) {
    for (const upc of userPointConstraints) {
      if (upc.mode === 'penalty') continue; // soft penalty, not exclusion
      const upcExclusions = buildUserPointExclusions(candidateLat, candidateLng, upc);
      checks.push(...upcExclusions);
    }
  }

  return checks;
}

// ─── Recalculate with custom weights ───

export function recalculateWithWeights(locations: LocationData[], customWeights: Record<string, number>): LocationData[] {
  if (Object.keys(customWeights).length === 0) return locations;

  return locations.map(loc => {
    let totalWeighted = 0;
    let totalWeight = 0;

    const newCriteria = loc.criteria_breakdown.map(c => {
      const weight = Math.max(0, Math.min(1, customWeights[c.name] ?? c.weight));
      totalWeighted += c.score * weight;
      totalWeight += weight;
      return { ...c, weight };
    });

    const newScore = totalWeight > 0 ? Math.round((totalWeighted / totalWeight) * 10) / 10 : 0;
    return { ...loc, mcda_score: newScore, criteria_breakdown: newCriteria };
  });
}

// ─── Generate evidence-backed reasoning ───

export function generateReasoning(
  name: string,
  criteria: MCDACriteria[],
  exclusions: ExclusionCheck[],
  radiusM: number,
): string {
  const radiusKm = (radiusM / 1000).toFixed(1);
  const parts: string[] = [];

  // Top positive signals
  const positives = criteria
    .filter(c => c.direction === 'positive' && c.score >= 6)
    .sort((a, b) => b.score * b.weight - a.score * a.weight);

  if (positives.length > 0) {
    const topSignals = positives.slice(0, 2).map(c =>
      `${c.name.toLowerCase()} (${c.rawValue} features, score ${c.score}/10)`
    ).join(' and ');
    parts.push(`${name} shows strong signals in ${topSignals} within ${radiusKm}km.`);
  }

  // Key negatives
  const negatives = criteria
    .filter(c => c.direction === 'negative' && c.score <= 4)
    .sort((a, b) => a.score - b.score);

  if (negatives.length > 0) {
    const concern = negatives[0];
    parts.push(`Note: ${concern.name.toLowerCase()} is high (${concern.rawValue} found), which may indicate saturation.`);
  }

  // Exclusion notes
  const failed = exclusions.filter(e => !e.passed);
  if (failed.length > 0) {
    parts.push(`Warning: ${failed.length} exclusion rule(s) not met.`);
  }

  if (parts.length === 0) {
    parts.push(`${name}: ${criteria.length} criteria evaluated within ${radiusKm}km radius using OSM data.`);
  }

  return parts.join(' ');
}

// ─── Generate summary ───

export function generateSummary(
  businessType: string,
  city: string,
  locations: LocationData[],
  spec: AnalysisSpec,
): string {
  const nonExcluded = locations.filter(l => !l.excluded);
  if (nonExcluded.length === 0) {
    return `No candidate locations passed all constraints for ${businessType} in ${city}. Consider relaxing exclusion criteria.`;
  }

  const top = nonExcluded[0];
  const parts = [
    `Screened ${locations.length} candidate areas in ${city} for ${businessType} using ${spec.constraints.length > 0 ? spec.constraints.length + ' spatial constraint(s) and ' : ''}${top.criteria_breakdown.length} scoring criteria.`,
    `${top.name} ranks highest at ${top.mcda_score}/10.`,
  ];

  if (nonExcluded.length > 1) {
    parts.push(`${nonExcluded[1].name} follows at ${nonExcluded[1].mcda_score}/10.`);
  }

  const excludedCount = locations.filter(l => l.excluded).length;
  if (excludedCount > 0) {
    parts.push(`${excludedCount} location(s) excluded by hard constraint rules.`);
  }

  parts.push(`All scores derived from OSM spatial data within ${(getSectorById(spec.sectorId).searchRadiusM / 1000).toFixed(1)}km radius. This is a screening-level assessment.`);

  return parts.join(' ');
}
