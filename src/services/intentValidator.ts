/**
 * Intent Validator — Cross-validation guard for business classification.
 *
 * Catches misclassifications by checking for contradictory signals.
 * If "solar farm" somehow got classified as "cafe", this layer detects
 * the contradiction and corrects it.
 */

import { classifyBusinessType, type ClassificationResult } from './businessClassifier';

// ─── Types ───

export interface ValidationResult {
  valid: boolean;
  correctedSectorId?: string;
  correctedLabel?: string;
  reason?: string;
}

// ─── Contradiction map ───
// For each sector, terms that should NEVER appear if that sector is correct.
// Key = sectorId, Value = array of terms that contradict it.

const CONTRADICTIONS: Record<string, string[]> = {
  cafe: [
    'solar farm', 'solar plant', 'solar', 'photovoltaic', 'pv',
    'warehouse', 'logistics', 'distribution center', 'fulfillment',
    'charging station', 'ev charging', 'electric vehicle',
    'preschool', 'kindergarten', 'daycare', 'school',
    'hospital', 'clinic', 'diagnostic', 'pharmacy',
    'coworking', 'co-working', 'shared office',
    'real estate', 'mixed-use', 'apartment complex', 'township',
    'wind farm', 'renewable energy',
  ],
  preschool: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'ev charging', 'charging station',
  ],
  ev: [
    'solar farm', 'solar plant', 'warehouse', 'preschool', 'school',
    'hospital', 'clinic',
  ],
  logistics: [
    'solar farm', 'solar plant', 'preschool', 'school',
    'cafe', 'restaurant', 'coffee',
  ],
  solar: [
    'cafe', 'restaurant', 'coffee shop', 'preschool', 'school',
    'daycare', 'coworking',
  ],
  retail: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'preschool', 'hospital',
  ],
  clinic: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'ev charging',
  ],
  coworking: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'preschool', 'hospital',
  ],
  realestate: [
    'solar farm', 'solar plant', 'warehouse', 'logistics',
    'ev charging',
  ],
};

// ─── Validator ───

export function validateClassification(
  classification: ClassificationResult,
  text: string,
): ValidationResult {
  const lower = text.toLowerCase();
  const contradictions = CONTRADICTIONS[classification.sectorId] || [];

  // Check if the prompt contains terms that contradict the classification
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

  // Contradiction found — re-classify to find the correct sector
  // Build a sub-prompt from just the contradicting terms to identify the right domain
  const reclassification = classifyBusinessType(text);

  // If reclassification gives a different sector with reasonable confidence, use it
  if (reclassification.sectorId !== classification.sectorId && reclassification.score >= 2) {
    return {
      valid: false,
      correctedSectorId: reclassification.sectorId,
      correctedLabel: reclassification.label,
      reason: `Contradiction detected: "${foundContradictions[0]}" conflicts with ${classification.label}. Corrected to ${reclassification.label}.`,
    };
  }

  // If reclassification agrees or can't improve, accept original
  return { valid: true };
}
