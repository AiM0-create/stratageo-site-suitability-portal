/**
 * Session Store — localStorage CRUD for session persistence.
 *
 * Storage keys:
 *   sg_session_index  → SessionIndex (lightweight list)
 *   sg_session_{id}   → full Session JSON
 *
 * Max 20 sessions. Oldest archived sessions auto-purged on save.
 */

import type { Session, SessionIndex, SessionIndexEntry } from '../types/session';
import { createEmptyMemory } from '../types/session';

const INDEX_KEY = 'sg_session_index';
const SESSION_PREFIX = 'sg_session_';
const MAX_SESSIONS = 20;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Session CRUD ───

export function createSession(): Session {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title: 'New Analysis',
    createdAt: now,
    updatedAt: now,
    messages: [],
    memory: createEmptyMemory(),
    archived: false,
  };
}

export function loadSession(id: string): Session | null {
  try {
    const raw = localStorage.getItem(`${SESSION_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    session.updatedAt = new Date().toISOString();
    localStorage.setItem(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session));

    // Update index
    const index = loadSessionIndex();
    const existing = index.sessions.findIndex(s => s.id === session.id);
    const entry: SessionIndexEntry = {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      archived: session.archived,
    };

    if (existing >= 0) {
      index.sessions[existing] = entry;
    } else {
      index.sessions.unshift(entry);
    }

    index.activeSessionId = session.id;
    pruneIndex(index);
    saveSessionIndex(index);
  } catch (err) {
    console.warn('[Stratageo] Failed to save session:', err);
  }
}

export function deleteSession(id: string): void {
  try {
    localStorage.removeItem(`${SESSION_PREFIX}${id}`);
    const index = loadSessionIndex();
    index.sessions = index.sessions.filter(s => s.id !== id);
    if (index.activeSessionId === id) {
      index.activeSessionId = index.sessions[0]?.id || null;
    }
    saveSessionIndex(index);
  } catch (err) {
    console.warn('[Stratageo] Failed to delete session:', err);
  }
}

// ─── Index CRUD ───

export function loadSessionIndex(): SessionIndex {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return { activeSessionId: null, sessions: [] };
    return JSON.parse(raw) as SessionIndex;
  } catch {
    return { activeSessionId: null, sessions: [] };
  }
}

export function saveSessionIndex(index: SessionIndex): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch (err) {
    console.warn('[Stratageo] Failed to save session index:', err);
  }
}

// ─── Pruning ───

function pruneIndex(index: SessionIndex): void {
  if (index.sessions.length <= MAX_SESSIONS) return;

  // Sort: active first, then by updatedAt desc
  index.sessions.sort((a, b) => {
    if (a.id === index.activeSessionId) return -1;
    if (b.id === index.activeSessionId) return 1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  // Remove excess sessions from storage
  const removed = index.sessions.splice(MAX_SESSIONS);
  for (const entry of removed) {
    try {
      localStorage.removeItem(`${SESSION_PREFIX}${entry.id}`);
    } catch { /* ignore */ }
  }
}
