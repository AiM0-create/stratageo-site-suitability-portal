/**
 * LLM Intent Extractor — Calls the enhanced /api/intent endpoint.
 *
 * Stage A of the pipeline: raw prompt → LLM → structured intent with profile.
 * Returns null if the LLM is unavailable or returns invalid data,
 * allowing the caller to fall back to the local regex-based parser.
 */

import { config } from '../config';
import type { LLMIntent } from './intentSchema';

const INTENT_TIMEOUT_MS = 15_000;

/**
 * Send user prompt to the LLM for structured intent extraction.
 * Returns null if API unavailable, times out, or response is invalid.
 */
export async function extractIntent(rawPrompt: string): Promise<LLMIntent | null> {
  if (!config.aiBackendUrl) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS);

    const response = await fetch(`${config.aiBackendUrl}/api/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: rawPrompt }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn('LLM intent endpoint returned:', response.status);
      return null;
    }

    const data = await response.json();
    return validateShape(data) ? data : null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.warn('LLM intent extraction timed out');
    } else {
      console.warn('LLM intent extraction failed:', err);
    }
    return null;
  }
}

/**
 * Basic shape validation — ensures the LLM returned required fields.
 * Deep semantic validation happens in intentValidator.
 */
function validateShape(data: unknown): data is LLMIntent {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;

  // Required string fields
  if (typeof d.businessType !== 'string' || !d.businessType) return false;
  if (typeof d.sector !== 'string' || !d.sector) return false;
  if (typeof d.anchorType !== 'string') return false;
  if (typeof d.confidence !== 'string') return false;

  // Required arrays
  if (!Array.isArray(d.positiveCriteria)) return false;
  if (!Array.isArray(d.negativeCriteria)) return false;
  if (!Array.isArray(d.exclusionCriteria)) return false;

  // Coordinates: if present, must have valid lat/lng
  if (d.coordinates != null) {
    const c = d.coordinates as Record<string, unknown>;
    if (typeof c.lat !== 'number' || typeof c.lng !== 'number') return false;
  }

  // osmCriteria: if present, must be an array
  if (d.osmCriteria != null && !Array.isArray(d.osmCriteria)) return false;

  // siteProfile: if present, must be an object
  if (d.siteProfile != null && typeof d.siteProfile !== 'object') return false;

  return true;
}
