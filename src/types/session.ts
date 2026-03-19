// ─── Session Memory Types ───

export interface WorkingMemory {
  businessType: string | null;
  city: string | null;
  coordinates: { lat: number; lng: number } | null;
  sectorId: string | null;
  constraints: string[];
  csvFileName: string | null;
  csvPointCount: number;
  lastResultCount: number;
  lastSearchRadiusM: number | null;
  lastAnalysisTimestamp: string | null;
  customContext: Record<string, string>;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  metadata?: {
    analysisId?: string;
    intent?: 'query' | 'followup' | 'clarification' | 'csv_upload';
  };
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  memory: WorkingMemory;
  archived: boolean;
}

export interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  archived: boolean;
}

export interface SessionIndex {
  activeSessionId: string | null;
  sessions: SessionIndexEntry[];
}

export function createEmptyMemory(): WorkingMemory {
  return {
    businessType: null,
    city: null,
    coordinates: null,
    sectorId: null,
    constraints: [],
    csvFileName: null,
    csvPointCount: 0,
    lastResultCount: 0,
    lastSearchRadiusM: null,
    lastAnalysisTimestamp: null,
    customContext: {},
  };
}
