/**
 * LLM Intent Extractor — Calls the /api/intent endpoint (OpenAI-backed).
 *
 * Stage A of the pipeline: raw prompt → LLM → structured intent with profile.
 *
 * CRITICAL: This module is LOUD about failures. It never silently returns null.
 * Every failure path logs explicitly and updates the diagnostic state so the
 * UI can show exactly why GPT was or wasn't used.
 */

import { config } from '../config';
import type { LLMIntent } from './intentSchema';

const INTENT_TIMEOUT_MS = 30_000;

// ─── Diagnostic state (readable by UI debug panel) ───

export interface IntentDiagnostics {
  attempted: boolean;
  succeeded: boolean;
  source: 'gpt' | 'local_fallback' | 'demo_mode' | 'not_attempted';
  backendUrl: string;
  failureReason: string;
  httpStatus: number | null;
  responseTimeMs: number | null;
  rawIntent: LLMIntent | null;
  timestamp: string;
}

let _lastDiagnostics: IntentDiagnostics = {
  attempted: false,
  succeeded: false,
  source: 'not_attempted',
  backendUrl: '',
  failureReason: '',
  httpStatus: null,
  responseTimeMs: null,
  rawIntent: null,
  timestamp: '',
};

export function getLastDiagnostics(): IntentDiagnostics {
  return { ..._lastDiagnostics };
}

function setDiagnostics(partial: Partial<IntentDiagnostics>): void {
  _lastDiagnostics = {
    ..._lastDiagnostics,
    ...partial,
    timestamp: new Date().toISOString(),
  };
}

// ─── Health check ───

export async function checkBackendHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!config.aiBackendUrl) {
    return { ok: false, detail: 'No backend URL configured (VITE_AI_BACKEND_URL is empty)' };
  }

  try {
    const response = await fetch(`${config.aiBackendUrl}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { ok: false, detail: `Backend returned HTTP ${response.status}` };
    }

    const data = await response.json();
    if (!data.openaiKeyConfigured) {
      return { ok: false, detail: 'Backend is reachable but OPENAI_API_KEY is not configured' };
    }

    return { ok: true, detail: `Backend healthy (v${data.version})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Backend unreachable: ${msg}` };
  }
}

// ─── Main intent extraction ───

export async function extractIntent(rawPrompt: string): Promise<LLMIntent | null> {
  const backendUrl = config.aiBackendUrl;

  // Guard: no backend URL = no GPT
  if (!backendUrl) {
    const reason = 'GPT SKIPPED: no backend URL (VITE_AI_BACKEND_URL is empty).';
    console.warn(`[Stratageo] ${reason}`);
    setDiagnostics({
      attempted: false,
      succeeded: false,
      source: 'demo_mode',
      backendUrl: '(not configured)',
      failureReason: reason,
      httpStatus: null,
      responseTimeMs: null,
      rawIntent: null,
    });
    return null;
  }

  // Attempt GPT intent extraction
  const startTime = performance.now();
  console.log(`[Stratageo] Calling GPT intent extraction: ${backendUrl}/api/intent`);

  setDiagnostics({
    attempted: true,
    succeeded: false,
    source: 'local_fallback',
    backendUrl,
    failureReason: 'In progress...',
    httpStatus: null,
    responseTimeMs: null,
    rawIntent: null,
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS);

    const response = await fetch(`${backendUrl}/api/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: rawPrompt }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const elapsed = Math.round(performance.now() - startTime);

    if (!response.ok) {
      const reason = `GPT intent extraction FAILED: backend returned HTTP ${response.status}. URL: ${backendUrl}/api/intent`;
      console.error(`[Stratageo] ${reason}`);

      // Try to get error body for more detail
      let errorDetail = '';
      try {
        const errorBody = await response.text();
        errorDetail = errorBody.substring(0, 200);
        console.error(`[Stratageo] Response body: ${errorDetail}`);
      } catch { /* ignore */ }

      setDiagnostics({
        attempted: true,
        succeeded: false,
        source: 'local_fallback',
        backendUrl,
        failureReason: `${reason}${errorDetail ? ` — ${errorDetail}` : ''}`,
        httpStatus: response.status,
        responseTimeMs: elapsed,
        rawIntent: null,
      });
      return null;
    }

    const data = await response.json();

    if (!validateShape(data)) {
      const reason = `GPT intent extraction FAILED: response shape validation failed. Got keys: ${Object.keys(data).join(', ')}`;
      console.error(`[Stratageo] ${reason}`);
      setDiagnostics({
        attempted: true,
        succeeded: false,
        source: 'local_fallback',
        backendUrl,
        failureReason: reason,
        httpStatus: response.status,
        responseTimeMs: elapsed,
        rawIntent: null,
      });
      return null;
    }

    // SUCCESS
    console.log(`[Stratageo] GPT intent extraction SUCCEEDED in ${elapsed}ms: ${data.businessType} / ${data.sector} (${data.confidence} confidence)`);
    setDiagnostics({
      attempted: true,
      succeeded: true,
      source: 'gpt',
      backendUrl,
      failureReason: '',
      httpStatus: response.status,
      responseTimeMs: elapsed,
      rawIntent: data,
    });
    return data;

  } catch (err) {
    const elapsed = Math.round(performance.now() - startTime);

    let reason: string;
    if (err instanceof DOMException && err.name === 'AbortError') {
      reason = `GPT intent extraction TIMED OUT after ${INTENT_TIMEOUT_MS}ms. Backend may be slow or unreachable.`;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      reason = `GPT intent extraction FAILED with error: ${msg}`;
    }

    console.error(`[Stratageo] ${reason}`);
    setDiagnostics({
      attempted: true,
      succeeded: false,
      source: 'local_fallback',
      backendUrl,
      failureReason: reason,
      httpStatus: null,
      responseTimeMs: elapsed,
      rawIntent: null,
    });
    return null;
  }
}

/**
 * Basic shape validation — ensures the LLM returned required fields.
 */
function validateShape(data: unknown): data is LLMIntent {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;

  if (typeof d.businessType !== 'string' || !d.businessType) return false;
  if (typeof d.sector !== 'string' || !d.sector) return false;
  if (typeof d.anchorType !== 'string') return false;
  if (typeof d.confidence !== 'string') return false;

  if (!Array.isArray(d.positiveCriteria)) return false;
  if (!Array.isArray(d.negativeCriteria)) return false;
  if (!Array.isArray(d.exclusionCriteria)) return false;

  if (d.coordinates != null) {
    const c = d.coordinates as Record<string, unknown>;
    if (typeof c.lat !== 'number' || typeof c.lng !== 'number') return false;
  }

  if (d.osmCriteria != null && !Array.isArray(d.osmCriteria)) return false;
  if (d.siteProfile != null && typeof d.siteProfile !== 'object') return false;

  return true;
}
