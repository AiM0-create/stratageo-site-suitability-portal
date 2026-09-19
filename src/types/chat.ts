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
  /** v2.0.0 — provenance: where this factor came from and what it measures.
   *  "framework" = the business family's spine; "brief" = composed by the AI
   *  from the customer's own words (validated by the engine); "user" = edited
   *  on the plan card. */
  origin?: 'framework' | 'brief' | 'answer' | 'user' | null;
  featureClass?: string | null;
  featureClasses?: string[];
  evidence?: string | null;
  weightBand?: 'low' | 'medium' | 'high' | null;
}

/** v2.0.0 — what the engine accepted and rejected from the AI's
 *  context-factor proposals, for the plan card's provenance note. */
export interface FactorComposition {
  accepted: Array<{ featureClass: string; name: string; direction: string; why?: string | null; evidence?: string | null }>;
  rejected: Array<{ featureClass: string; reason: string; detail: string }>;
  contextShare: number;
  contextShareCapped: boolean;
  /** generic proxies superseded because the brief named the real competitors */
  replaced?: string[];
  frameworkKey: string;
  frameworkName: string;
  genericFramework: boolean;
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
  scenarios?: Array<{
    name: string;
    description?: string;
    emphasis?: string;
    /** v1.12.6 — layer id -> weight multiplier, derived deterministically
     *  by the planner. Absent/empty means the scenario is descriptive only
     *  and its chip is not applicable. */
    weightMultipliers?: Record<string, number>;
  }>;
  validation?: string[];
  modelFailureRisks?: string[];
  /** v1.12.6 — optional, deterministic questions whose answers move factor
   *  weights. Built from the spec's own layers by the planner; the analysis is
   *  fully runnable with none of them answered. */
  clarifyingQuestions?: Array<{
    id: string;
    question: string;
    why?: string;
    options: Array<{ id: string; label: string; weightMultipliers?: Record<string, number> }>;
  }>;
}

export interface SpecV2 {
  /** v1.6.0 (Phase 2) — set true when the customer adjusts weight sliders on the
   *  plan card; the backend then preserves these weights across chat turns and
   *  reports them as user-adjusted in the weight audit. */
  weightsAdjustedByUser?: boolean;
  /** v1.6.0 (Phase 2) — archetype default weights (name → weight), recorded by
   *  the deterministic planner for the default-vs-adjusted audit. */
  canonicalWeights?: Record<string, number>;
  /** v2.0.0 — factor provenance record from the composer. */
  factorComposition?: FactorComposition | null;
  /** v2.4.0 — "check a spot": the customer's pin; the engine always re-verifies and reports that cell. */
  targetPoint?: { lat: number; lng: number } | null;
  /** v1.6.3 — set true when the customer picks an H3 grid level (7 or 8) on
   *  the plan card; the backend then preserves that resolution across chat
   *  turns instead of re-applying the archetype default. */
  gridResolutionAdjustedByUser?: boolean;
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
  /** v1.4.9 — PlannerLite preview: what will be verified / skipped / cannot
   * be verified for THIS prompt, shown before Start analysis. */
  plannerPreview?: PlannerPreview;
}

/** v1.4.9 — backend PlannerLite preview embedded in the spec at chat time. */
export interface PlannerPreview {
  willVerify: string[];
  skipped: Array<{ stage: string; reason: string }>;
  cannotVerify: string[];
  notes: string[];
}

export type ChatStage = 'chat' | 'framework' | 'ready';

/** v1.4.4/v1.4.6 — single source of truth for where the conversational flow is:
 * planning (LLM building a spec), spec_ready (valid spec awaiting confirmation),
 * executing (backend job running), completed/failed (last execution's outcome).
 * Lives here (not App.tsx) so presentational components and unit tests can
 * import it without pulling in the whole App component tree. */
export type AnalysisPhase = 'idle' | 'planning' | 'spec_ready' | 'executing' | 'completed' | 'failed';

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


// ─── v1.13.1 — the clarification turn (POST /api/v2/clarify) ───
//
// The AI chooses the questions; the engine owns what an answer can change. The
// frontend's only job is to show the accepted questions, collect answers, and
// hand them back with the chat turn as `clarifications`. Nothing here decides
// meaning — every option's `effect` arrived already validated.

export interface ClarifyOption {
  id: string;
  label: string;
  effect: Record<string, unknown>;
  /** The option is an invitation: the customer types the rest. */
  free_text: boolean;
}

export interface ClarifyQuestion {
  id: string;
  slot: string;
  impact: 'high' | 'medium' | 'low';
  question: string;
  why: string;
  options: ClarifyOption[];
}

/** One line of the "So far:" strip — what we know and where it came from. */
export interface UnderstandingItem {
  slot: string;
  label: string;
  value: string;
  source: string;     // prompt | you | assumed | default
  status: string;     // filled | low_confidence | skipped
}

export interface ClarifyResponse {
  ok: boolean;
  reply: string;
  questions: ClarifyQuestion[];
  understanding: UnderstandingItem[];
  slots: Record<string, unknown>;
  complete: boolean;
  archetypeKey: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

/** An answered question, exactly as the customer gave it. */
export interface ClarificationAnswer {
  slot: string;
  effect: Record<string, unknown>;
  free_text?: string | null;
  question?: string;
  label?: string;
}
