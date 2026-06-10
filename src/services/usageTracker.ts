/**
 * Usage Tracker — Logs every prompt to Firestore for admin analytics.
 */

import { collection, addDoc, serverTimestamp, query, orderBy, getDocs, where, limit as fbLimit } from 'firebase/firestore';
import { db } from '../config/firebase';

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
}

export async function logPrompt(data: Omit<PromptLog, 'timestamp'>): Promise<void> {
  try {
    await addDoc(collection(db, 'prompts'), {
      ...data,
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
}

export interface AdminStats {
  totalUsers: number;
  totalPrompts: number;
  totalTokens: number;
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
      isAdmin: data.isAdmin || false,
      lastLogin: data.lastLogin?.toDate?.() || null,
      createdAt: data.createdAt?.toDate?.() || null,
    };
    users.push(u);
    if (!u.isAdmin && u.promptsUsed >= 4) usersAtLimit++;
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
    });

    if (data.sector) sectorCounts[data.sector] = (sectorCounts[data.sector] || 0) + 1;
    if (data.city) cityCounts[data.city] = (cityCounts[data.city] || 0) + 1;
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  });

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
