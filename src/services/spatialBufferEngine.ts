/**
 * Spatial Buffer Engine — Haversine distance calculations for point-based constraints.
 *
 * Pure math, no external dependencies. Handles:
 * - Exclusion buffers (candidate must be OUTSIDE radius of all user points)
 * - Inclusion buffers (candidate must be INSIDE radius of at least one user point)
 * - Distance counting (how many user points are within radius)
 */

import type { UserPoint } from '../types';

export interface BufferCheckResult {
  passed: boolean;
  nearestDistanceM: number;
  nearestPoint: UserPoint | null;
  pointsWithinRadius: number;
  detail: string;
}

const EARTH_RADIUS_M = 6_371_000; // meters

/** Haversine distance between two points in meters. */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_M * c;
}

/**
 * Check a candidate point against user-supplied buffers.
 *
 * @param mode 'exclude' — candidate must be OUTSIDE radiusM of ALL user points.
 *             'include' — candidate must be INSIDE radiusM of AT LEAST ONE user point.
 */
export function checkPointAgainstBuffers(
  candidateLat: number,
  candidateLng: number,
  userPoints: UserPoint[],
  radiusM: number,
  mode: 'exclude' | 'include',
): BufferCheckResult {
  if (userPoints.length === 0) {
    return {
      passed: true,
      nearestDistanceM: Infinity,
      nearestPoint: null,
      pointsWithinRadius: 0,
      detail: 'No user points provided.',
    };
  }

  let nearestDist = Infinity;
  let nearestPt: UserPoint | null = null;
  let withinCount = 0;

  for (const pt of userPoints) {
    const dist = haversineDistance(candidateLat, candidateLng, pt.lat, pt.lng);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestPt = pt;
    }
    if (dist <= radiusM) {
      withinCount++;
    }
  }

  const radiusKm = (radiusM / 1000).toFixed(1);
  const nearestKm = (nearestDist / 1000).toFixed(1);
  const nearestLabel = nearestPt?.name || `(${nearestPt?.lat.toFixed(4)}, ${nearestPt?.lng.toFixed(4)})`;

  if (mode === 'exclude') {
    // Must be OUTSIDE radius of ALL points
    const passed = withinCount === 0;
    return {
      passed,
      nearestDistanceM: nearestDist,
      nearestPoint: nearestPt,
      pointsWithinRadius: withinCount,
      detail: passed
        ? `Passed: nearest user point ${nearestLabel} is ${nearestKm}km away (outside ${radiusKm}km exclusion zone).`
        : `Failed: ${withinCount} user point(s) within ${radiusKm}km exclusion zone. Nearest: ${nearestLabel} at ${nearestKm}km.`,
    };
  } else {
    // Must be INSIDE radius of at least ONE point
    const passed = withinCount > 0;
    return {
      passed,
      nearestDistanceM: nearestDist,
      nearestPoint: nearestPt,
      pointsWithinRadius: withinCount,
      detail: passed
        ? `Passed: ${withinCount} user point(s) within ${radiusKm}km inclusion zone. Nearest: ${nearestLabel} at ${nearestKm}km.`
        : `Failed: nearest user point ${nearestLabel} is ${nearestKm}km away (outside ${radiusKm}km inclusion zone).`,
    };
  }
}

/** Count how many user points are within radiusM of a candidate. */
export function countPointsWithinRadius(
  candidateLat: number,
  candidateLng: number,
  userPoints: UserPoint[],
  radiusM: number,
): number {
  let count = 0;
  for (const pt of userPoints) {
    if (haversineDistance(candidateLat, candidateLng, pt.lat, pt.lng) <= radiusM) {
      count++;
    }
  }
  return count;
}
