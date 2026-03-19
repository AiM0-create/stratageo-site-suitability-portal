import React, { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';
import type { Session, SessionIndex, SessionMessage, WorkingMemory } from '../types/session';
import { createEmptyMemory } from '../types/session';
import { createSession, loadSession, saveSession, loadSessionIndex } from '../services/sessionStore';

// ─── State & Actions ───

interface SessionState {
  currentSession: Session;
  sessionIndex: SessionIndex;
}

type SessionAction =
  | { type: 'LOAD_SESSION'; session: Session }
  | { type: 'NEW_SESSION' }
  | { type: 'ADD_MESSAGE'; message: SessionMessage }
  | { type: 'UPDATE_MEMORY'; updates: Partial<WorkingMemory> }
  | { type: 'SWITCH_SESSION'; sessionId: string }
  | { type: 'SET_TITLE'; title: string }
  | { type: 'CLEAR_MEMORY_FIELD'; field: keyof WorkingMemory };

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'LOAD_SESSION':
      return {
        ...state,
        currentSession: action.session,
        sessionIndex: {
          ...state.sessionIndex,
          activeSessionId: action.session.id,
        },
      };

    case 'NEW_SESSION': {
      const newSess = createSession();
      // Update the old session's entry in the index with latest title/messageCount
      const updatedOldSessions = state.sessionIndex.sessions.map(s =>
        s.id === state.currentSession.id
          ? { ...s, title: state.currentSession.title, messageCount: state.currentSession.messages.length, updatedAt: state.currentSession.updatedAt }
          : s,
      );
      return {
        currentSession: newSess,
        sessionIndex: {
          activeSessionId: newSess.id,
          sessions: [
            { id: newSess.id, title: newSess.title, updatedAt: newSess.updatedAt, messageCount: 0, archived: false },
            ...updatedOldSessions,
          ],
        },
      };
    }

    case 'ADD_MESSAGE':
      return {
        ...state,
        currentSession: {
          ...state.currentSession,
          messages: [...state.currentSession.messages, action.message],
          updatedAt: new Date().toISOString(),
        },
      };

    case 'UPDATE_MEMORY':
      return {
        ...state,
        currentSession: {
          ...state.currentSession,
          memory: { ...state.currentSession.memory, ...action.updates },
          updatedAt: new Date().toISOString(),
        },
      };

    case 'SWITCH_SESSION': {
      const loaded = loadSession(action.sessionId);
      if (!loaded) return state;
      return {
        ...state,
        currentSession: loaded,
        sessionIndex: {
          ...state.sessionIndex,
          activeSessionId: loaded.id,
        },
      };
    }

    case 'SET_TITLE': {
      const newTitle = action.title.slice(0, 40);
      return {
        ...state,
        currentSession: {
          ...state.currentSession,
          title: newTitle,
        },
        sessionIndex: {
          ...state.sessionIndex,
          sessions: state.sessionIndex.sessions.map(s =>
            s.id === state.currentSession.id ? { ...s, title: newTitle } : s,
          ),
        },
      };
    }

    case 'CLEAR_MEMORY_FIELD': {
      const mem = { ...state.currentSession.memory };
      const field = action.field;
      if (field === 'constraints') {
        mem.constraints = [];
      } else if (field === 'csvPointCount') {
        mem.csvPointCount = 0;
        mem.csvFileName = null;
      } else if (field === 'coordinates') {
        mem.coordinates = null;
      } else if (field === 'customContext') {
        mem.customContext = {};
      } else {
        (mem as Record<string, unknown>)[field] = null;
      }
      return {
        ...state,
        currentSession: {
          ...state.currentSession,
          memory: mem,
          updatedAt: new Date().toISOString(),
        },
      };
    }

    default:
      return state;
  }
}

// ─── Context ───

interface SessionContextValue {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
  addMessage: (role: 'user' | 'assistant', text: string, metadata?: SessionMessage['metadata']) => void;
  updateMemory: (updates: Partial<WorkingMemory>) => void;
  newSession: () => void;
  switchSession: (id: string) => void;
  clearMemoryField: (field: keyof WorkingMemory) => void;
}

const SessionCtx = createContext<SessionContextValue | null>(null);

// ─── Provider ───

function initState(): SessionState {
  const index = loadSessionIndex();
  let session: Session | null = null;

  if (index.activeSessionId) {
    session = loadSession(index.activeSessionId);
  }

  if (!session) {
    session = createSession();
    index.activeSessionId = session.id;
    if (!index.sessions.some(s => s.id === session!.id)) {
      index.sessions.unshift({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: 0,
        archived: false,
      });
    }
  }

  return { currentSession: session, sessionIndex: index };
}

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(sessionReducer, undefined, initState);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save debounced
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveSession(state.currentSession);
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state.currentSession]);

  const addMessage = useCallback((role: 'user' | 'assistant', text: string, metadata?: SessionMessage['metadata']) => {
    const msg: SessionMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role,
      text,
      timestamp: new Date().toISOString(),
      metadata,
    };
    dispatch({ type: 'ADD_MESSAGE', message: msg });
  }, []);

  const updateMemory = useCallback((updates: Partial<WorkingMemory>) => {
    dispatch({ type: 'UPDATE_MEMORY', updates });
  }, []);

  const newSession = useCallback(() => {
    // Save current session before creating new one
    saveSession(state.currentSession);
    dispatch({ type: 'NEW_SESSION' });
  }, [state.currentSession]);

  const switchSession = useCallback((id: string) => {
    saveSession(state.currentSession);
    dispatch({ type: 'SWITCH_SESSION', sessionId: id });
  }, [state.currentSession]);

  const clearMemoryField = useCallback((field: keyof WorkingMemory) => {
    dispatch({ type: 'CLEAR_MEMORY_FIELD', field });
  }, []);

  const value: SessionContextValue = {
    state,
    dispatch,
    addMessage,
    updateMemory,
    newSession,
    switchSession,
    clearMemoryField,
  };

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
};

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
