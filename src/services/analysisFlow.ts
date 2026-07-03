// ─── Pure analysis-flow logic (v1.4.6) ───
// Extracted from App.tsx so it can be unit-tested without importing the whole
// component tree (App.tsx pulls in Firebase, Leaflet, recharts, ...).

import type { SpecV2 } from '../types/chat';

/** v1.4.3 — a DOM/React event object must never be treated as an analysis
 * spec. A bare `onClick={handleConfirmExecute}` (or `onClick={onConfirmExecute}`
 * one layer up) passes the click's SyntheticEvent as the first argument;
 * without this guard it flows straight into the backend payload and
 * JSON.stringify() throws "Converting circular structure to JSON" on the
 * event's `__reactFiber...`/`nativeEvent` back-references. Checks for the
 * event's own shape first (cheap, catches the bug even if `layers` is ever
 * renamed), then confirms the real SpecV2 shape. */
export function isAnalysisSpecWithPoints(value: unknown): value is SpecV2 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if ('nativeEvent' in v || 'currentTarget' in v || 'target' in v || 'preventDefault' in v) {
    return false;
  }
  return typeof v.objective === 'string' && typeof v.businessType === 'string' && Array.isArray(v.layers);
}

/** v1.4.4 — exact phrases that, when a valid spec is ready (or a failed run is
 * retryable), execute directly instead of being sent to the LLM as a new
 * planning turn. Case-insensitive, matched after trim. */
export const CONFIRMATION_PHRASES = new Set([
  'yes', 'y', 'ok', 'okay', 'run', 'start', 'start analysis', 'proceed', 'go ahead',
]);

export function isConfirmationPhrase(text: string): boolean {
  return CONFIRMATION_PHRASES.has(text.trim().toLowerCase());
}
