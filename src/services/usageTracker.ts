/**
 * Usage Tracker — Logs every prompt to Firestore for admin analytics.
 */

import { collection, addDoc, serverTimestamp, query, orderBy, getDocs, where, limit as fbLimit, doc, setDoc } from 'firebase/firestore';
import { db } from '../config/firebase';

/** Compact per-candidate snapshot — enough to compare runs, not a full result dump. */
export interface CandidateSnapshot {
  name: string;
  score: number | null;
  investigationLabel?: string;
}

/** Compact hard-constraint-verification snapshot (counts only). */
export interface HardConstraintSnapshot {
  verified: number;
  proxyVerified: number;
  notVerifiable: number;
  unenforced: number;
  failed: number;
}

export interface PromptLog {
  userId: string;
  email: string;
  prompt: string;
  sector: string;
  city: string;
  timestamp: any;
  latencyMs: number;
  resultCount: number;
  topScore: number | null;
  pdfExported: boolean;
  isFollowUp: boolean;
  tokensUsed: number;
  dataSource: 'google-places' | 'osm' | 'hybrid' | 'demo';
  // ── Output snapshot (v1.5.3) — enough to compare two runs of the same
  // prompt and catch non-determinism, without storing the full hex grid /
  // evidence trail. All optional: older log calls (or the legacy demo path)
  // simply omit them.
  analysisStatus?: string;                    // success | no_viable_site | failed
  analysisRecommendation?: string;            // RECOMMENDED_INVESTIGATION_ZONE | ...
  planningFingerprint?: string;               // same prompt+archetype+schema => same value
  specFingerprint?: string;                   // same structural spec => same value
  requestedTopN?: number;
  candidates?: CandidateSnapshot[];            // top candidates, compact
  hardConstraints?: HardConstraintSnapshot;
  skippedStages?: string[];                    // PlannerLite stages skipped this run
}

/** Firestore rejects `undefined` field values — strip them before writing so
 * optional output-snapshot fields (and any future optional field) never
 * break the write for callers that don't have them yet. */
function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export async function logPrompt(data: Omit<PromptLog, 'timestamp'>): Promise<void> {
  try {
    await addDoc(collection(db, 'prompts'), {
      ...stripUndefined(data),
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    console.error('Failed to log prompt:', err);
  }
}

// ─── Admin analytics queries ───

export interface UserSummary {
  uid: string;
  email: string;
  displayName: string;
  promptsUsed: number;
  /** v1.6.1 — admin-granted per-customer allotment (undefined = global default). */
  maxPrompts?: number;
  isAdmin: boolean;
  lastLogin: Date | null;
  createdAt: Date | null;
}

export interface PromptEntry {
  id: string;
  userId: string;
  email: string;
  prompt: string;
  sector: string;
  city: string;
  timestamp: Date | null;
  latencyMs: number;
  resultCount: number;
  topScore: number | null;
  isFollowUp: boolean;
  pdfExported: boolean;
  tokensUsed: number;
  dataSource: string;
  // ── Output snapshot (v1.5.3) — all optional, absent on older log entries.
  analysisStatus?: string;
  analysisRecommendation?: string;
  planningFingerprint?: string;
  specFingerprint?: string;
  requestedTopN?: number;
  candidates?: CandidateSnapshot[];
  hardConstraints?: HardConstraintSnapshot;
  skippedStages?: string[];
}

export interface AdminStats {
  totalUsers: number;
  totalPrompts: number;
  totalTokens: number;
  /** Estimated INR spend, priced per-model: hybrid rows = gpt-4o, rest = gpt-4o-mini */
  estCostINR: number;
  usersAtLimit: number;
  // Aggregate quality/throughput metrics (over the recent-prompts window)
  avgLatencyMs: number;
  avgTopScore: number | null;
  promptsLast7d: number;
  followUpCount: number;
  pdfExportCount: number;
  scoreDistribution: { band: string; count: number }[];
  dataSourceBreakdown: { name: string; count: number }[];
  topSectors: { name: string; count: number }[];
  topCities: { name: string; count: number }[];
  users: UserSummary[];
  recentPrompts: PromptEntry[];
}

export async function fetchAdminStats(): Promise<AdminStats> {
  // Fetch all users
  const usersSnap = await getDocs(collection(db, 'users'));
  const users: UserSummary[] = [];
  let usersAtLimit = 0;

  usersSnap.forEach((d) => {
    const data = d.data();
    const u: UserSummary = {
      uid: d.id,
      email: data.email || '',
      displayName: data.displayName || '',
      promptsUsed: data.promptsUsed || 0,
      maxPrompts: (typeof data.maxPrompts === 'number' && Number.isFinite(data.maxPrompts) && data.maxPrompts >= 0) ? data.maxPrompts : undefined,
      isAdmin: data.isAdmin || false,
      lastLogin: data.lastLogin?.toDate?.() || null,
      createdAt: data.createdAt?.toDate?.() || null,
    };
    users.push(u);
    // v1.6.1 — at-limit is per the user's OWN allotment (was a hardcoded 4)
    if (!u.isAdmin && u.promptsUsed >= (u.maxPrompts ?? 10)) usersAtLimit++;
  });

  // Fetch recent prompts (last 100)
  const promptsQuery = query(
    collection(db, 'prompts'),
    orderBy('timestamp', 'desc'),
    fbLimit(100),
  );
  const promptsSnap = await getDocs(promptsQuery);
  const recentPrompts: PromptEntry[] = [];
  const sectorCounts: Record<string, number> = {};
  const cityCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  let totalTokens = 0;

  promptsSnap.forEach((d) => {
    const data = d.data();
    const tokens = data.tokensUsed || 0;
    totalTokens += tokens;
    const source = data.dataSource || 'osm';
    recentPrompts.push({
      id: d.id,
      userId: data.userId || '',
      email: data.email || '',
      prompt: data.prompt || '',
      sector: data.sector || '',
      city: data.city || '',
      timestamp: data.timestamp?.toDate?.() || null,
      latencyMs: data.latencyMs || 0,
      resultCount: data.resultCount || 0,
      topScore: data.topScore ?? null,
      isFollowUp: data.isFollowUp || false,
      pdfExported: data.pdfExported || false,
      tokensUsed: tokens,
      dataSource: source,
      analysisStatus: data.analysisStatus || undefined,
      analysisRecommendation: data.analysisRecommendation || undefined,
      planningFingerprint: data.planningFingerprint || undefined,
      specFingerprint: data.specFingerprint || undefined,
      requestedTopN: data.requestedTopN ?? undefined,
      candidates: Array.isArray(data.candidates) ? data.candidates : undefined,
      hardConstraints: data.hardConstraints || undefined,
      skippedStages: Array.isArray(data.skippedStages) ? data.skippedStages : undefined,
    });

    if (data.sector) sectorCounts[data.sector] = (sectorCounts[data.sector] || 0) + 1;
    if (data.city) cityCounts[data.city] = (cityCounts[data.city] || 0) + 1;
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  });

  // ── Cost estimate: per-model blended INR/1M tokens ──
  // gpt-4o ≈ $2.50/M in + $10/M out → input-heavy blend ≈ $3.5/M ≈ ₹300/M
  // gpt-4o-mini ≈ $0.15/M in + $0.60/M out → blend ≈ $0.25/M ≈ ₹21/M
  const RATE_INR_PER_M = { gpt4o: 300, mini: 21 };
  const estCostINR = recentPrompts.reduce((sum, p) => {
    const rate = p.dataSource === 'hybrid' ? RATE_INR_PER_M.gpt4o : RATE_INR_PER_M.mini;
    return sum + (p.tokensUsed / 1_000_000) * rate;
  }, 0);

  // ── Aggregates over the recent-prompts window ──
  const withLatency = recentPrompts.filter(p => p.latencyMs > 0);
  const avgLatencyMs = withLatency.length
    ? withLatency.reduce((s, p) => s + p.latencyMs, 0) / withLatency.length
    : 0;

  const withScore = recentPrompts.filter(p => p.topScore != null);
  const avgTopScore = withScore.length
    ? withScore.reduce((s, p) => s + (p.topScore as number), 0) / withScore.length
    : null;

  const weekAgo = Date.now() - 7 * 86400_000;
  const promptsLast7d = recentPrompts.filter(p => (p.timestamp?.getTime() || 0) > weekAgo).length;
  const followUpCount = recentPrompts.filter(p => p.isFollowUp).length;
  const pdfExportCount = recentPrompts.filter(p => p.pdfExported).length;

  const scoreBands: Record<string, number> = { '8+': 0, '6.5–8': 0, '5–6.5': 0, '3.5–5': 0, '<3.5': 0 };
  withScore.forEach(p => {
    const s = p.topScore as number;
    if (s >= 8) scoreBands['8+']++;
    else if (s >= 6.5) scoreBands['6.5–8']++;
    else if (s >= 5) scoreBands['5–6.5']++;
    else if (s >= 3.5) scoreBands['3.5–5']++;
    else scoreBands['<3.5']++;
  });
  const scoreDistribution = Object.entries(scoreBands).map(([band, count]) => ({ band, count }));

  const dataSourceBreakdown = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const topSectors = Object.entries(sectorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const topCities = Object.entries(cityCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    totalUsers: users.length,
    totalPrompts: recentPrompts.length,
    totalTokens,
    estCostINR,
    usersAtLimit,
    avgLatencyMs,
    avgTopScore,
    promptsLast7d,
    followUpCount,
    pdfExportCount,
    scoreDistribution,
    dataSourceBreakdown,
    topSectors,
    topCities,
    users: users.sort((a, b) => (b.lastLogin?.getTime() || 0) - (a.lastLogin?.getTime() || 0)),
    recentPrompts,
  };
}

// ─── v1.6.1 (Phase 3) — admin quota controls ───
// Both writes are admin-only in practice: firestore.rules reject them for
// non-admin tokens, so these helpers fail safely if ever reached otherwise.

/** Grant/replace a customer's analysis allotment (the contract tie-in:
 *  ₹50,000 engagement → grantAllotment(uid, 5)). */
export async function grantAllotment(uid: string, maxPrompts: number): Promise<void> {
  if (!Number.isFinite(maxPrompts) || maxPrompts < 0) throw new Error('Invalid allotment');
  await setDoc(doc(db, 'users', uid), { maxPrompts: Math.floor(maxPrompts) }, { merge: true });
}

/** Reset a customer's usage counter (e.g. a renewed engagement). */
export async function resetUsage(uid: string): Promise<void> {
  await setDoc(doc(db, 'users', uid), { promptsUsed: 0 }, { merge: true });
}
