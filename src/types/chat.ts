// ─── Conversational analysis (v1.0.1, Python backend /api/v2) ───

export interface SpecLayer {
  id: string;
  name: string;
  weight: number;
  direction: 'positive' | 'negative';
  source: {
    provider: 'osm' | 'google_places' | 'custom';
    tags?: string[];
    types?: string[];
    keyword?: string | null;
    code?: string;
    inputLayerIds?: string[];
  };
  catchment: {
    type: 'euclidean' | 'walk' | 'drive';
    meters?: number;
    minutes?: number;
  };
  normalization?: { method: 'percentile' | 'minmax'; pLow?: number; pHigh?: number };
  notes?: string | null;
}

export interface SpecV2 {
  version: '2.0';
  objective: string;
  businessType: string;
  studyArea: {
    type: 'places' | 'bbox' | 'point_radius';
    places?: string[];
    bbox?: number[];
    point?: { lat: number; lng: number };
    radiusM?: number;
    hullBufferM?: number;
  };
  grid: { type: 'h3'; resolution: number };
  layers: SpecLayer[];
  exclusions?: Array<{ name: string; source: { provider: 'osm'; tags: string[] }; bufferM?: number }>;
  output?: { topN: number; minCandidateSeparationHexRings?: number };
  execution?: { isochroneRefinement: boolean; refineTopK?: number };
  meta?: {
    unsupportedRequests?: Array<{ requested: string; fallback: string }>;
    clarificationsResolved?: string[];
  };
}

export interface ChatTurnResponse {
  ok: boolean;
  reply: string;
  spec: SpecV2 | null;
  specStatus: 'empty' | 'draft' | 'complete';
  readyToExecute: boolean;
  unsupported: Array<{ requested: string; fallback: string }>;
  specValid: boolean;
  specValidationError: string | null;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface AnalysisJobStatus {
  ok: boolean;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  phase: string;
  message: string;
  result: import('./index').AnalysisResult | null;
  error: string | null;
}
