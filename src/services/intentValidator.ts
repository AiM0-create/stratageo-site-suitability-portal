/**
 * Intent Validator — Two-purpose validation module.
 *
 * 1. validateLLMIntent(): Validates the LLM-extracted intent before
 *    it enters the deterministic analysis pipeline. (Stage A → Stage B gate)
 *
 * 2. validateClassification(): Legacy cross-validation guard for the
 *    local regex-based classifier (used as fallback when LLM is unavailable).
 */

import type { LLMIntent } from './intentSchema';
import { resolveSectorId } from './intentSchema';
import { classifyBusinessType, type ClassificationResult } from './businessClassifier';

// ═══════════════════════════════════════════════════════
// Part 1: LLM Intent Validation (new — for LLM-first pipeline)
// ═══════════════════════════════════════════════════════

export interface LLMIntentValidationResult {
  valid: boolean;
  sectorId: string | null;
  warnings: string[];
  errors: string[];
}

export function validateLLMIntent(intent: LLMIntent): LLMIntentValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Sector must map to a known template
  const sectorId = resolveSectorId(intent.sector);
  if (!sectorId) {
    warnings.push(`Unknown sector "${intent.sector}" — will attempt local classification.`);
  }

  // 2. Geography checks
  if (intent.anchorType === 'coordinate') {
    if (!intent.coordinates) {
      errors.push('anchorType is "coordinate" but no coordinates provided.');
    } else {
      const { lat, lng } = intent.coordinates;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        errors.push(`Invalid coordinates: lat=${lat}, lng=${lng}.`);
      }
    }
  }

  if (intent.anchorType === 'city' && !intent.locationName) {
    warnings.push('anchorType is "city" but no locationName provided.');
  }

  if (intent.anchorType === 'none' && !intent.coordinates && !intent.locationName) {
    errors.push('No location information extracted — neither coordinates nor city name.');
  }

  // 3. Result count bounds
  if (typeof intent.requestedResultCount !== 'number' || intent.requestedResultCount < 1) {
    warnings.push('Invalid requestedResultCount — defaulting to 3.');
  } else if (intent.requestedResultCount > 5) {
    warnings.push('requestedResultCount exceeds 5 — capping at 5.');
  }

  // 4. Distance constraint sanity
  if (intent.radiusConstraints) {
    for (const rc of intent.radiusConstraints) {
      if (rc.distanceM <= 0) {
        warnings.push(`Invalid distance for "${rc.target}": ${rc.distanceM}m.`);
      }
      if (rc.distanceM > 100_000) {
        warnings.push(`Very large distance for "${rc.target}": ${(rc.distanceM / 1000).toFixed(0)}km.`);
      }
    }
  }

  for (const ec of intent.exclusionCriteria) {
    if (ec.distanceM != null && ec.distanceM <= 0) {
      warnings.push(`Invalid exclusion distance for "${ec.name}": ${ec.distanceM}m.`);
    }
  }

  // 5. Contradiction check
  const positiveNames = new Set(intent.positiveCriteria.map(c => c.name.toLowerCase()));
  for (const exc of intent.exclusionCriteria) {
    if (positiveNames.has(exc.name.toLowerCase())) {
      warnings.push(`"${exc.name}" in both positive and exclusion criteria.`);
    }
  }

  // 6. Low-confidence ambiguity surfacing
  if (intent.confidence === 'low' && intent.ambiguities && intent.ambiguities.length > 0) {
    warnings.push(`Low confidence. Ambiguities: ${intent.ambiguities.join('; ')}`);
  }

  return { valid: errors.length === 0, sectorId, warnings, errors };
}


// ═══════════════════════════════════════════════════════
// Part 2: Local classification validation (legacy fallback)
// ═══════════════════════════════════════════════════════

export interface ValidationResult {
  valid: boolean;
  correctedSectorId?: string;
  correctedLabel?: string;
  reason?: string;
}

const CONTRADICTIONS: Record<string, string[]> = {
  cafe: [
    'solar farm', 'solar plant', 'solar', 'photovoltaic', 'pv',
    'warehouse', 'logistics', 'distribution center', 'fulfillment',
    'charging station', 'ev charging', 'electric vehicle',
    'preschool', 'kindergarten', 'daycare', 'school',
    'hospital', 'clinic', 'diagnostic', 'pharmacy',
    'coworking', 'co-working', 'shared office',
    'real estate', 'mixed-use', 'apartment complex', 'township',
    'wind farm', 'renewable energy', 'data center',
  ],
  preschool: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'ev charging', 'charging station', 'data center',
  ],
  ev: [
    'solar farm', 'solar plant', 'warehouse', 'preschool', 'school',
    'hospital', 'clinic', 'data center',
  ],
  logistics: [
    'solar farm', 'solar plant', 'preschool', 'school',
    'cafe', 'restaurant', 'coffee', 'data center',
  ],
  solar: [
    'cafe', 'restaurant', 'coffee shop', 'preschool', 'school',
    'daycare', 'coworking',
  ],
  retail: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'preschool', 'hospital', 'data center',
  ],
  clinic: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'ev charging', 'data center',
  ],
  coworking: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'preschool', 'hospital', 'data center',
  ],
  realestate: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'ev charging', 'data center',
  ],
};

export function validateClassification(
  classification: ClassificationResult,
  text: string,
): ValidationResult {
  const lower = text.toLowerCase();
  const contradictions = CONTRADICTIONS[classification.sectorId] || [];

  const foundContradictions: string[] = [];
  for (const term of contradictions) {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(lower)) {
      foundContradictions.push(term);
    }
  }

  if (foundContradictions.length === 0) {
    return { valid: true };
  }

  const reclassification = classifyBusinessType(text);

  if (reclassification.sectorId !== classification.sectorId && reclassification.score >= 2) {
    return {
      valid: false,
      correctedSectorId: reclassification.sectorId,
      correctedLabel: reclassification.label,
      reason: `Contradiction: "${foundContradictions[0]}" conflicts with ${classification.label}. Corrected to ${reclassification.label}.`,
    };
  }

  return { valid: true };
}
