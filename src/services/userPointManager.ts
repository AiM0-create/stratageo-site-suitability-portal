/**
 * User Point Manager — Bridges CSV-uploaded points with the MCDA pipeline.
 *
 * Converts user points + intent into:
 * - ExclusionCheck results (for hard constraints)
 * - MCDACriteria entries (for soft penalty/anchor scoring)
 */

import type { ExclusionCheck, MCDACriteria, UserPoint, UserPointConstraint } from '../types';
import { checkPointAgainstBuffers, haversineDistance } from './spatialBufferEngine';

export type { UserPointConstraint } from '../types';

/**
 * Run exclusion checks for a candidate location against user-supplied points.
 * Used for hard exclude/include constraints.
 */
export function buildUserPointExclusions(
  candidateLat: number,
  candidateLng: number,
  constraint: UserPointConstraint,
): ExclusionCheck[] {
  if (constraint.mode === 'penalty') {
    // Soft penalty doesn't produce exclusion checks
    return [];
  }

  const bufferMode = constraint.mode === 'exclude' ? 'exclude' : 'include';
  const result = checkPointAgainstBuffers(
    candidateLat, candidateLng,
    constraint.points, constraint.radiusM,
    bufferMode,
  );

  const radiusKm = (constraint.radiusM / 1000).toFixed(1);
  const ruleLabel = constraint.mode === 'exclude'
    ? `Not within ${radiusKm}km of ${constraint.label}`
    : `Within ${radiusKm}km of ${constraint.label}`;

  return [{
    rule: ruleLabel,
    passed: result.passed,
    detail: result.detail,
    evidenceBasis: 'constraint-rule' as const,
  }];
}

/**
 * Score user-point proximity as an MCDA criterion (soft penalty or anchor).
 * Used when mode is 'penalty' (prefer away) or 'include' (prefer near).
 */
export function scoreUserPointProximity(
  candidateLat: number,
  candidateLng: number,
  constraint: UserPointConstraint,
): MCDACriteria {
  const { points, mode, radiusM, label } = constraint;

  // Find nearest distance
  let nearestDist = Infinity;
  for (const pt of points) {
    const dist = haversineDistance(candidateLat, candidateLng, pt.lat, pt.lng);
    if (dist < nearestDist) nearestDist = dist;
  }

  const nearestKm = (nearestDist / 1000).toFixed(1);
  const radiusKm = (radiusM / 1000).toFixed(1);

  if (mode === 'penalty' || mode === 'exclude') {
    // Negative direction: farther away = better score
    const ratio = Math.min(nearestDist / radiusM, 2); // cap at 2x radius
    const score = Math.min(9, Math.max(1, Math.round(ratio * 4.5)));
    return {
      name: `Distance from ${label}`,
      weight: 0.15,
      score,
      rawValue: Math.round(nearestDist),
      direction: 'negative',
      justification: `Nearest uploaded point is ${nearestKm}km away. Target exclusion radius: ${radiusKm}km. Farther = better.`,
      evidenceBasis: 'constraint-rule',
    };
  } else {
    // Positive direction: closer = better score
    const ratio = nearestDist <= radiusM
      ? 1 - (nearestDist / radiusM)
      : 0;
    const score = Math.min(9, Math.max(1, Math.round(1 + ratio * 8)));
    return {
      name: `Proximity to ${label}`,
      weight: 0.15,
      score,
      rawValue: Math.round(nearestDist),
      direction: 'positive',
      justification: `Nearest uploaded point is ${nearestKm}km away. Target inclusion radius: ${radiusKm}km. Closer = better.`,
      evidenceBasis: 'constraint-rule',
    };
  }
}
