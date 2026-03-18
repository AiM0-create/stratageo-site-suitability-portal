// ─── User-supplied point (from CSV upload) ───

export interface UserPoint {
  lat: number;
  lng: number;
  name?: string;
  category?: string;
}

export interface UserPointConstraint {
  points: UserPoint[];
  mode: 'exclude' | 'include' | 'penalty';
  radiusM: number;
  radiusSource: 'user' | 'inferred';
  label: string;
}

// ─── Analysis Specification (output of prompt parser) ───

export interface AnalysisSpec {
  businessType: string;
  sectorId: string;
  geography: {
    city: string;
    country?: string;
    neighborhoods?: string[];
    anchor?: { lat: number; lng: number; label?: string };
  };
  constraints: SpatialConstraint[];
  userPointConstraints: UserPointConstraint[];
  hasUserPointReference: boolean;
  positiveCriteria: string[];
  negativeCriteria: string[];
  inferredWeights: Record<string, number>;
  resultCount: number;
  parsingNotes: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface SpatialConstraint {
  type: 'proximity' | 'exclusion' | 'preference';
  target: string;
  osmTags: string[];
  distanceM?: number;
  direction: 'near' | 'away';
  hardRule: boolean;
  label: string;
}

// ─── MCDA Criteria (dynamic, directional) ───

export type CriterionDirection = 'positive' | 'negative';
export type EvidenceBasis = 'osm-observed' | 'osm-derived' | 'constraint-rule' | 'template-default' | 'ai-generated';

export interface MCDACriteria {
  name: string;
  weight: number;
  score: number;
  rawValue: number;
  direction: CriterionDirection;
  justification: string;
  evidenceBasis: EvidenceBasis;
  osmQuery?: string;
}

// ─── Exclusion result ───

export interface ExclusionCheck {
  rule: string;
  passed: boolean;
  detail: string;
  evidenceBasis: EvidenceBasis;
}

// ─── Location data ───

export interface POI {
  lat: number;
  lng: number;
  name?: string;
  type: string;
}

export interface LocationData {
  name: string;
  lat: number;
  lng: number;
  mcda_score: number;
  criteria_breakdown: MCDACriteria[];
  exclusions: ExclusionCheck[];
  excluded: boolean;
  reasoning: string;
  osmSignals: Record<string, number>;
  pois: POI[];
  searchRadiusM: number;
}

// ─── Analysis Result ───

export interface AnalysisResult {
  summary: string;
  business_type: string;
  target_location: string;
  methodology: string;
  spec: AnalysisSpec;
  locations: LocationData[];
  grounding_sources: GroundingSource[];
}

export interface GroundingSource {
  title: string;
  uri: string;
  retrievedAt: string;
  reliability: string;
}

// ─── Analysis Request (from UI) ───

export interface AnalysisRequest {
  rawPrompt: string;
  resultCount?: number;
}

export interface AnalysisStatus {
  message: string;
  progress: number;
}

// ─── App state ───

export type AppMode = 'demo' | 'live';
export type HeatmapType = string | null;

export interface DemoScenario {
  id: string;
  businessType: string;
  city: string;
  label: string;
  description: string;
  icon: string;
  result: AnalysisResult;
}
