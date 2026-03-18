/**
 * Intent Validator — Validates LLM-extracted intent and legacy local classification.
 *
 * 1. validateLLMIntent(): Validates LLM intent including profile + dynamic criteria.
 * 2. validateClassification(): Legacy local classifier cross-validation (fallback).
 */

import type { LLMIntent } from './intentSchema';
import { resolveSectorId } from './intentSchema';
import { classifyBusinessType, type ClassificationResult } from './businessClassifier';

// ═══════════════════════════════════════════════════════
// Part 1: LLM Intent Validation (profile-based)
// ═══════════════════════════════════════════════════════

export interface LLMIntentValidationResult {
  valid: boolean;
  sectorId: string | null;
  hasDynamicCriteria: boolean;
  warnings: string[];
  errors: string[];
}

export function validateLLMIntent(intent: LLMIntent): LLMIntentValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Sector mapping (fallback — not critical if dynamic criteria exist)
  const sectorId = resolveSectorId(intent.sector);
  if (!sectorId && (!intent.osmCriteria || intent.osmCriteria.length < 3)) {
    warnings.push(`Unknown sector "${intent.sector}" and insufficient dynamic criteria — will use local classifier.`);
  }

  // 2. Dynamic criteria validation
  const hasDynamicCriteria = Array.isArray(intent.osmCriteria) && intent.osmCriteria.length >= 3;
  if (hasDynamicCriteria) {
    let validCriteria = 0;
    for (const c of intent.osmCriteria) {
      if (c.name && Array.isArray(c.osmTags) && c.osmTags.length > 0 && c.direction) {
        validCriteria++;
      }
    }
    if (validCriteria < 3) {
      warnings.push(`Only ${validCriteria} valid dynamic criteria (need at least 3).`);
    }
  }

  // 3. Profile validation
  if (intent.siteProfile) {
    const p = intent.siteProfile;
    if (p.searchRadiusM && (p.searchRadiusM < 100 || p.searchRadiusM > 50_000)) {
      warnings.push(`Search radius ${p.searchRadiusM}m seems unusual — will clamp to 500-20000m.`);
    }
  }

  // 4. Geography checks
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
    errors.push('No location information — neither coordinates nor city name.');
  }

  // 5. Result count bounds
  if (typeof intent.requestedResultCount !== 'number' || intent.requestedResultCount < 1) {
    warnings.push('Invalid requestedResultCount — defaulting to 3.');
  } else if (intent.requestedResultCount > 5) {
    warnings.push('requestedResultCount exceeds 5 — capping at 5.');
  }

  // 6. Distance constraint sanity
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

  // 7. Low-confidence surfacing
  if (intent.confidence === 'low' && intent.ambiguities && intent.ambiguities.length > 0) {
    warnings.push(`Low confidence. Ambiguities: ${intent.ambiguities.join('; ')}`);
  }

  return {
    valid: errors.length === 0,
    sectorId,
    hasDynamicCriteria,
    warnings,
    errors,
  };
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
    'wind farm', 'renewable energy', 'data center', 'cold chain',
  ],
  preschool: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'ev charging', 'charging station', 'data center', 'cold chain',
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
