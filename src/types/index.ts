export interface MCDACriteria {
  name: string;
  weight: number;
  score: number;
  justification: string;
}

export interface POI {
  lat: number;
  lng: number;
  name?: string;
  type: 'competitor' | 'transport' | 'commercial' | 'residential';
}

export interface LocationData {
  name: string;
  lat: number;
  lng: number;
  reasoning: string;
  footfall: string;
  demographics: string;
  marketing_radius_km: number;
  marketing_strategy: string;
  public_transport?: string;
  local_initiatives?: string;
  mcda_score: number;
  criteria_breakdown: MCDACriteria[];
  pois?: POI[];
}

export interface GroundingSource {
  title: string;
  uri: string;
  retrievedAt: string;
  reliability: string;
}

export interface AnalysisResult {
  summary: string;
  business_type: string;
  target_location: string;
  methodology: string;
  locations: LocationData[];
  grounding_sources?: GroundingSource[];
}

export interface AnalysisRequest {
  businessType: string;
  city: string;
  priorities?: Record<string, number>;
}

export interface AnalysisStatus {
  message: string;
  progress: number;
}

export type AppMode = 'demo' | 'live';

export type AppView = 'landing' | 'analysis' | 'results';

export type HeatmapType = 'competitor' | 'transport' | 'commercial' | null;

export interface DemoScenario {
  id: string;
  businessType: string;
  city: string;
  label: string;
  description: string;
  icon: string;
  result: AnalysisResult;
}
