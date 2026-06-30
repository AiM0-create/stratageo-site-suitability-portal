// ─── Conversational analysis client (v1.0.1, Python backend /api/v2) ───
import { config } from '../config';
import type { AnalysisResult, AnalysisStatus } from '../types';
import type { AnalysisJobStatus, CancelAnalysisResponse, ChatTurnResponse, SpecV2 } from '../types/chat';

const base = () => config.pyBackendUrl;

// Build-time app token. Not a true secret (it ships in the bundle) but a
// rotatable kill-switch: requests without the current build's token are
// rejected, so a scraped Cloud Run URL alone can't drive cost. Paired with
// per-IP rate limiting on the server.
const jsonHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.appToken) h['X-App-Token'] = config.appToken;
  return h;
};

export async function checkPyHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return !!j?.ok;
  } catch {
    return false;
  }
}

export async function sendChatTurn(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  spec: SpecV2 | null,
  context?: { resultCount?: number; csvPointCount?: number },
): Promise<ChatTurnResponse> {
  const r = await fetch(`${base()}/api/v2/chat`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ messages, spec, context: context ?? null }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    throw new Error(detail?.detail || `Chat failed (HTTP ${r.status})`);
  }
  return r.json();
}

export async function startAnalysis(spec: SpecV2): Promise<string> {
  const r = await fetch(`${base()}/api/v2/analyses`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ spec }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    throw new Error(detail?.detail || `Could not start analysis (HTTP ${r.status})`);
  }
  const j = await r.json();
  return j.jobId;
}

const POLL_INTERVAL_MS = 2500;
// v1.4.1 — the backend now enforces its own hard per-job runtime ceiling
// (JOB_MAX_RUNTIME_SECONDS, default 240s — see backend-py/app/config.py) and
// always reaches a terminal status (done/error/cancelled/timeout). This
// client-side ceiling is a safety net for the case where the backend itself
// is unreachable/misbehaving, not the primary timeout mechanism — it no
// longer needs to be (and must not be) the only thing standing between a
// stuck job and a locked chat input. Previously this was 20 minutes, which
// meant a hung job could lock the UI for 20 minutes before ever recovering.
const MAX_POLL_MINUTES = 6;

export class AnalysisCancelledError extends Error {
  constructor(message = 'Analysis cancelled.') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

export async function cancelAnalysis(jobId: string): Promise<CancelAnalysisResponse> {
  const r = await fetch(`${base()}/api/v2/analyses/${jobId}/cancel`, {
    method: 'POST',
    headers: jsonHeaders(),
  });
  // The endpoint is designed to always return 200 with a safe payload, but
  // guard anyway — cancellation must never throw and block the UI cleanup.
  if (!r.ok) return { ok: false, found: false };
  return r.json();
}

export async function pollAnalysis(
  jobId: string,
  onStatus: (s: AnalysisStatus) => void,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  const deadline = Date.now() + MAX_POLL_MINUTES * 60_000;
  for (;;) {
    if (signal?.aborted) throw new AnalysisCancelledError();
    if (Date.now() > deadline) {
      throw new Error(
        'Analysis is taking far longer than expected and the client gave up waiting. ' +
        'The server-side job may still be running — try again in a moment, or start a new analysis.',
      );
    }
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
    if (signal?.aborted) throw new AnalysisCancelledError();
    let s: AnalysisJobStatus;
    try {
      const r = await fetch(`${base()}/api/v2/analyses/${jobId}`, { signal });
      if (r.status === 404) throw new Error('Analysis job expired on the server.');
      s = await r.json();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new AnalysisCancelledError();
      if (e instanceof Error && e.message.includes('expired')) throw e;
      continue; // transient network blip — keep polling
    }
    onStatus({ message: s.message, progress: s.progress });
    // Every terminal status must be handled explicitly here — silently
    // falling through to "keep polling" on an unrecognized terminal status
    // (this previously happened for 'cancelled'/'timeout', which the type
    // didn't even declare) is exactly how a finished job can still leave
    // the chat input locked until the client-side deadline above fires.
    if (s.status === 'done' && s.result) return s.result;
    if (s.status === 'error') throw new Error(s.error || 'Analysis failed on the server.');
    if (s.status === 'cancelled') throw new AnalysisCancelledError(s.message || 'Analysis cancelled.');
    if (s.status === 'timeout') {
      throw new Error(s.error || 'Analysis timed out on the server — please try again.');
    }
    // status is 'queued' or 'running' — keep polling
  }
}
