/**
 * Feasibility Validator — Validates analysis results against the site-seeking profile.
 *
 * Checks whether the results make sense given the user's intent.
 * Generates honest warnings when data is insufficient, constraints
 * are too restrictive, or the location is misaligned with the profile.
 */

import type { LocationData, AnalysisSpec } from '../types';
import type { SiteProfile } from './intentSchema';

export interface FeasibilityResult {
  feasible: boolean;
  warnings: string[];
  suggestions: string[];
  overallQuality: 'strong' | 'moderate' | 'weak' | 'infeasible';
}

export function validateFeasibility(
  locations: LocationData[],
  spec: AnalysisSpec,
  profile: SiteProfile,
): FeasibilityResult {
  const warnings: string[] = [];
  const suggestions: string[] = [];

  const nonExcluded = locations.filter(l => !l.excluded);
  const excludedCount = locations.length - nonExcluded.length;

  // 1. No results at all
  if (locations.length === 0) {
    return {
      feasible: false,
      warnings: ['No candidate areas could be analyzed. The location may not have sufficient OpenStreetMap coverage.'],
      suggestions: ['Try a different city or provide coordinates closer to mapped areas.'],
      overallQuality: 'infeasible',
    };
  }

  // 2. All excluded
  if (nonExcluded.length === 0) {
    warnings.push(`All ${locations.length} candidate areas were excluded by constraints.`);
    if (spec.constraints.length > 2) {
      suggestions.push('Consider relaxing some constraints — the combination may be too restrictive for this area.');
    }
    if (spec.userPointConstraints.length > 0) {
      const upc = spec.userPointConstraints[0];
      suggestions.push(`Try reducing the ${(upc.radiusM / 1000).toFixed(1)}km exclusion radius around uploaded points.`);
    }
    return { feasible: false, warnings, suggestions, overallQuality: 'infeasible' };
  }

  // 3. Too few passed
  if (nonExcluded.length < spec.resultCount && excludedCount > 0) {
    warnings.push(`Only ${nonExcluded.length} of ${spec.resultCount} requested locations passed constraints (${excludedCount} excluded).`);
  }

  // 4. Scores are universally low
  const avgScore = nonExcluded.reduce((s, l) => s + l.mcda_score, 0) / nonExcluded.length;
  if (avgScore < 3.5) {
    warnings.push(`Average suitability score is low (${avgScore.toFixed(1)}/10). This area may not be well-suited for ${spec.businessType}.`);

    // Profile-specific suggestions
    if (profile.urbanPreference === 'urban_core' || profile.urbanPreference === 'urban') {
      suggestions.push('Consider searching in a more densely developed urban area.');
    }
    if (profile.infrastructureDependency === 'high') {
      suggestions.push('This area may lack the required infrastructure. Try near industrial zones or established utility corridors.');
    }
    if (profile.footTrafficDependency === 'high') {
      suggestions.push('For high foot-traffic businesses, try near transit hubs or commercial districts.');
    }
  }

  // 5. Top score check
  const topScore = nonExcluded[0]?.mcda_score || 0;
  if (topScore < 4.0) {
    warnings.push(`Best candidate scores only ${topScore}/10. Results should be treated as exploratory.`);
  }

  // 6. Evidence quality check — look for criteria with zero raw values
  if (nonExcluded.length > 0) {
    const top = nonExcluded[0];
    const zeroCriteria = top.criteria_breakdown.filter(c => c.rawValue === 0);
    if (zeroCriteria.length > top.criteria_breakdown.length * 0.5) {
      warnings.push(`Many criteria have zero observed features — OSM data coverage may be limited in this area.`);
      suggestions.push('Results may improve in areas with better OpenStreetMap coverage.');
    }
  }

  // 7. Profile alignment — check if location type fundamentally mismatches business needs
  const landCriteria = nonExcluded[0]?.criteria_breakdown.find(c => c.name === 'Land availability');
  const locationFitCriteria = nonExcluded[0]?.criteria_breakdown.find(c => c.name === 'Location-type fit');

  if (landCriteria && landCriteria.score <= 2.0 && profile.landIntensity === 'high') {
    warnings.push(
      `⚠ Site feasibility concern: This ${spec.businessType} requires large open land, but all candidate areas are densely developed. ` +
      `Scores reflect amenity proximity but do not guarantee land availability. Consider periurban or rural locations.`,
    );
  }

  if (locationFitCriteria && locationFitCriteria.score <= 3.0) {
    warnings.push(
      `Location type mismatch: The area's development pattern doesn't align with what a ${spec.businessType} typically needs.`,
    );
  }

  if (profile.marketPositioning === 'premium' && avgScore < 5) {
    warnings.push('Premium positioning may be challenging in this area based on observed commercial and transit signals.');
  }

  // Determine overall quality — profile alignment can override raw scores
  let overallQuality: FeasibilityResult['overallQuality'];
  const hasLandMismatch = landCriteria && landCriteria.score <= 2.0 && profile.landIntensity === 'high';
  const hasLocationMismatch = locationFitCriteria && locationFitCriteria.score <= 2.5;

  if (hasLandMismatch) {
    // Land-intensive business in dense urban = weak regardless of other scores
    overallQuality = 'weak';
  } else if (avgScore >= 6 && nonExcluded.length >= spec.resultCount && !hasLocationMismatch) {
    overallQuality = 'strong';
  } else if (avgScore >= 4 && nonExcluded.length >= 1) {
    overallQuality = 'moderate';
  } else {
    overallQuality = 'weak';
  }

  return {
    feasible: true,
    warnings,
    suggestions,
    overallQuality,
  };
}
