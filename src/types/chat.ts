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
  // Consultant honesty fields (v1.0.1.2)
  confidence?: 'high' | 'medium' | 'low';
  whyItMatters?: string | null;
  proxyWarning?: string | null;
  notes?: string | null;
}

export interface ConstraintItem {
  constraint: string;
  type: 'hard' | 'soft';
  status: 'satisfiable' | 'conflicting' | 'unvalidatable';
  notes?: string;
}

export interface FeasibilityCheck {
  status: 'feasible' | 'tradeoffs' | 'not_feasible' | 'insufficient_data';
  explanation?: string;
  conflicts?: string[];
  relaxationOptions?: string[];
  unvalidatable?: string[];
}

export interface ConsultantPlan {
  businessArchetype?: string;
  spatialScale?: 'national' | 'city' | 'micro_market' | 'parcel' | 'network' | 'city_then_micro';
  methodology?: string;
  assumptions?: Array<{ assumption: string; basis?: string }>;
  misleadingVariables?: Array<{ variable: string; risk?: string }>;
  scenarios?: Array<{ name: string; description?: string; emphasis?: string }>;
  validation?: string[];
  modelFailureRisks?: string[];
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
  plan?: ConsultantPlan;
  constraints?: ConstraintItem[];
  feasibility?: FeasibilityCheck;
  meta?: {
    unsupportedRequests?: Array<{ requested: string; fallback: string }>;
    clarificationsResolved?: string[];
  };
}

export type ChatStage = 'chat' | 'framework' | 'ready';

export interface ChatTurnResponse {
  ok: boolean;
  reply: string;
  /** Conversation stage: chat = exploring (no framework shown), framework = plan visible, ready = run confirmed */
  stage: ChatStage;
  spec: SpecV2 | null;
  specStatus: 'empty' | 'draft' | 'complete';
  readyToExecute: boolean;
  feasibility?: FeasibilityCheck | null;
  unsupported: Array<{ requested: string; fallback: string }>;
  specValid: boolean;
  specValidationError: string | null;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface AnalysisJobStatus {
  ok: boolean;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'timeout';
  progress: number;
  phase: string;
  message: string;
  result: import('./index').AnalysisResult | null;
  error: string | null;
}

export interface CancelAnalysisResponse {
  ok: boolean;
  found: boolean;
  alreadyTerminal?: boolean;
  status?: string;
  message?: string;
}
