// ─── Conversational analysis client (v1.0.1, Python backend /api/v2) ───
import { config } from '../config';
import type { AnalysisResult, AnalysisStatus } from '../types';
import type { AnalysisJobStatus, ChatTurnResponse, SpecV2 } from '../types/chat';

const base = () => config.pyBackendUrl;

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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
const MAX_POLL_MINUTES = 20;

export async function pollAnalysis(
  jobId: string,
  onStatus: (s: AnalysisStatus) => void,
): Promise<AnalysisResult> {
  const deadline = Date.now() + MAX_POLL_MINUTES * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Analysis timed out — please try again.');
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
    let s: AnalysisJobStatus;
    try {
      const r = await fetch(`${base()}/api/v2/analyses/${jobId}`);
      if (r.status === 404) throw new Error('Analysis job expired on the server.');
      s = await r.json();
    } catch (e) {
      if (e instanceof Error && e.message.includes('expired')) throw e;
      continue; // transient network blip — keep polling
    }
    onStatus({ message: s.message, progress: s.progress });
    if (s.status === 'done' && s.result) return s.result;
    if (s.status === 'error') throw new Error(s.error || 'Analysis failed on the server.');
  }
}
