/**
 * Analysis Store — Save and retrieve analyses from Firestore.
 * Powers "My Analyses" and shareable links.
 */

import { collection, doc, setDoc, getDoc, getDocs, query, where, limit as fbLimit, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { nanoid } from 'nanoid';
import type { AnalysisResult, AnalysisSpec } from '../types';

export interface SavedAnalysis {
  id: string;
  shareId: string;
  userId: string;
  email: string;
  businessType: string;
  city: string;
  topScore: number | null;
  locationCount: number;
  prompt: string;
  result: AnalysisResult;
  spec: AnalysisSpec;
  createdAt: Date | null;
}

/**
 * Save an analysis to Firestore (user's collection + shareable).
 * Returns the shareId for the shareable link.
 */
export async function saveAnalysis(
  userId: string,
  email: string,
  prompt: string,
  result: AnalysisResult,
  spec: AnalysisSpec,
): Promise<string> {
  const shareId = nanoid(10); // Short, URL-safe ID
  const docId = `${userId}_${Date.now()}`;
  const topLoc = result.locations.filter(l => !l.excluded)[0];

  await setDoc(doc(db, 'analyses', docId), {
    shareId,
    userId,
    email,
    businessType: result.business_type,
    city: result.target_location,
    topScore: topLoc?.mcda_score ?? null,
    locationCount: result.locations.length,
    prompt,
    // Store result and spec as JSON strings to avoid Firestore nested object limits
    resultJSON: JSON.stringify(result),
    specJSON: JSON.stringify(spec),
    createdAt: serverTimestamp(),
  });

  return shareId;
}

/**
 * Fetch all saved analyses for a user (most recent first, max 20).
 */
export async function fetchUserAnalyses(userId: string): Promise<SavedAnalysis[]> {
  // NOTE: intentionally NO orderBy. `where(userId==) + orderBy(createdAt desc)` needs a
  // composite Firestore index that was never provisioned for this project, so the whole
  // query failed with failed-precondition — surfacing as "Failed to load analyses". Each
  // user has at most a few dozen analyses (10-prompt quota), so we fetch by userId
  // (single-field index, auto-created) and sort client-side. Index-free and correct.
  const q = query(
    collection(db, 'analyses'),
    where('userId', '==', userId),
    fbLimit(50),
  );
  const snap = await getDocs(q);
  const analyses: SavedAnalysis[] = [];

  snap.forEach((d) => {
    const data = d.data();
    try {
      analyses.push({
        id: d.id,
        shareId: data.shareId || '',
        userId: data.userId || '',
        email: data.email || '',
        businessType: data.businessType || '',
        city: data.city || '',
        topScore: data.topScore ?? null,
        locationCount: data.locationCount || 0,
        prompt: data.prompt || '',
        result: JSON.parse(data.resultJSON || '{}'),
        spec: JSON.parse(data.specJSON || '{}'),
        createdAt: data.createdAt?.toDate?.() || null,
      });
    } catch {
      // Skip corrupt entries
    }
  });

  // Most-recent first, then cap (done client-side since the query has no orderBy).
  analyses.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return analyses.slice(0, 20);
}

/**
 * Fetch a shared analysis by its shareId (public, no auth needed).
 */
export async function fetchSharedAnalysis(shareId: string): Promise<SavedAnalysis | null> {
  const q = query(
    collection(db, 'analyses'),
    where('shareId', '==', shareId),
    fbLimit(1),
  );
  const snap = await getDocs(q);

  if (snap.empty) return null;

  const d = snap.docs[0];
  const data = d.data();

  try {
    return {
      id: d.id,
      shareId: data.shareId || '',
      userId: data.userId || '',
      email: data.email || '',
      businessType: data.businessType || '',
      city: data.city || '',
      topScore: data.topScore ?? null,
      locationCount: data.locationCount || 0,
      prompt: data.prompt || '',
      result: JSON.parse(data.resultJSON || '{}'),
      spec: JSON.parse(data.specJSON || '{}'),
      createdAt: data.createdAt?.toDate?.() || null,
    };
  } catch {
    return null;
  }
}
