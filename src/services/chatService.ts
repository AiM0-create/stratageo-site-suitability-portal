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

/** v1.6.0 (Phase 3) — attach the caller's Firebase ID token so the backend
 * can verify identity and enforce the analysis quota server-side (where the
 * cost is incurred). Harmless while backend enforcement is off. Lazy import
 * keeps firebase out of this module's static dependency graph. */
const authJsonHeaders = async (): Promise<Record<string, string>> => {
  const h = jsonHeaders();
  try {
    const { auth } = await import('../config/firebase');
    const token = await auth.currentUser?.getIdToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  } catch {
    // Signed-out or firebase unavailable — send without a token; the backend
    // decides (401 when enforcement is on).
  }
  return h;
};

/** v1.4.5 — chat.py now returns a structured `detail` object
 * ({message, errorCode, requestId}) for the chat/planning endpoint instead of
 * a bare string, so a provider outage (rate limit/quota, auth, timeout) is
 * distinguishable in the UI from a generic server exception. Older/other
 * endpoints may still return a plain string `detail` — handle both. */
export interface ApiError extends Error {
  httpStatus: number;
  errorCode?: string;
  requestId?: string;
}

function buildApiError(status: number, body: any, fallback: string): ApiError {
  const detail = body?.detail;
  const isStructured = detail && typeof detail === 'object';
  const message = isStructured ? (detail.message || fallback) : (typeof detail === 'string' ? detail : fallback);
  const err = new Error(message) as ApiError;
  err.httpStatus = status;
  if (isStructured) {
    err.errorCode = detail.errorCode;
    err.requestId = detail.requestId;
  }
  return err;
}

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
    headers: await authJsonHeaders(),
    body: JSON.stringify({ messages, spec, context: context ?? null }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw buildApiError(r.status, body, `Chat failed (HTTP ${r.status})`);
  }
  return r.json();
}

export async function startAnalysis(spec: SpecV2): Promise<string> {
  const r = await fetch(`${base()}/api/v2/analyses`, {
    method: 'POST',
    headers: await authJsonHeaders(),
    body: JSON.stringify({ spec }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    // v1.6.0 (Phase 3) — auth/quota rejections carry a structured detail
    // ({errorCode, message}); show the human message, never "[object Object]".
    const d = detail?.detail;
    const msg = typeof d === 'string' ? d : (d?.message || d?.error);
    throw new Error(msg || `Could not start analysis (HTTP ${r.status})`);
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
// v1.4.2 — watchdog: if neither progress% nor the status message changes for
// this long, treat the job as stalled client-side rather than waiting out the
// full MAX_POLL_MINUTES deadline.
//
// FIXED (was 100s, wrongly set BELOW the worst case it was meant to tolerate):
// the backend's own buildability sub-checkpoints (added in v1.4.1) can each
// take up to ~150s worst-case (3 Overpass mirror failovers × 50s + retry
// sleeps) before progress/message changes. A 100s threshold would false-
// positive on a perfectly healthy job mid-checkpoint. 220s gives ~70s of
// margin above that measured worst case while staying comfortably below the
// backend's own hard job ceiling (JOB_MAX_RUNTIME_SECONDS=240s — see
// backend-py/app/config.py), so in the normal case the backend's own clean
// "timeout" status arrives via polling before this client-side watchdog
// would ever need to fire. This watchdog is the fallback for the case where
// even the backend's own enforcement doesn't unstick things (e.g. polling
// itself silently stops getting fresh data) — not the first line of defense.
const WATCHDOG_STALL_MS = 220_000;

export class AnalysisCancelledError extends Error {
  constructor(message = 'Analysis cancelled.') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

export class AnalysisStalledError extends Error {
  constructor(message = 'Analysis interrupted — progress stalled. Please retry.') {
    super(message);
    this.name = 'AnalysisStalledError';
  }
}

/** v1.4.7 — structured FAILED payload from the backend's three-state result
 * contract. Carried on the poll error so the UI can show stage / errorCode /
 * jobRef and honour `retryable` instead of a bare string. */
export interface FailedAnalysisPayload {
  status: 'failed';
  stage?: string;
  errorCode?: string;
  userMessage?: string;
  retryable?: boolean;
  jobRef?: string;
}

export class AnalysisFailedError extends Error {
  failed?: FailedAnalysisPayload;
  constructor(message: string, failed?: FailedAnalysisPayload) {
    super(message);
    this.name = 'AnalysisFailedError';
    this.failed = failed;
  }
}

export async function cancelAnalysis(jobId: string): Promise<CancelAnalysisResponse> {
  const r = await fetch(`${base()}/api/v2/analyses/${jobId}/cancel`, {
    method: 'POST',
    headers: await authJsonHeaders(),
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
  // Watchdog state — local to this poll loop, no component-level ref needed.
  let lastProgress: number | null = null;
  let lastMessage: string | null = null;
  let lastChangeAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw new AnalysisCancelledError();
    if (Date.now() > deadline) {
      throw new Error(
        'Analysis is taking far longer than expected and the client gave up waiting. ' +
        'The server-side job may still be running — try again in a moment, or start a new analysis.',
      );
    }
    if (Date.now() - lastChangeAt > WATCHDOG_STALL_MS) {
      throw new AnalysisStalledError();
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
    if (s.progress !== lastProgress || s.message !== lastMessage) {
      lastProgress = s.progress;
      lastMessage = s.message;
      lastChangeAt = Date.now();
    }
    // Every terminal status must be handled explicitly here — silently
    // falling through to "keep polling" on an unrecognized terminal status
    // (this previously happened for 'cancelled'/'timeout', which the type
    // didn't even declare) is exactly how a finished job can still leave
    // the chat input locked until the client-side deadline above fires.
    if (s.status === 'done' && s.result) return s.result;
    if (s.status === 'error' || s.status === 'timeout') {
      // v1.4.7 — the backend now attaches a structured FAILED payload
      // (stage / errorCode / userMessage / retryable / jobRef) to failed and
      // timed-out jobs. Surface it so the UI can render an actionable error.
      const failed = (s.result && (s.result as any).status === 'failed')
        ? ((s.result as unknown) as FailedAnalysisPayload)
        : undefined;
      const fallback = s.status === 'timeout'
        ? 'Analysis timed out on the server — please try again.'
        : 'Analysis failed on the server.';
      throw new AnalysisFailedError(failed?.userMessage || s.error || fallback, failed);
    }
    if (s.status === 'cancelled') throw new AnalysisCancelledError(s.message || 'Analysis cancelled.');
    // status is 'queued' or 'running' — keep polling
  }
}
