/**
 * Intent Schema — Structured types for LLM-extracted intent.
 *
 * v3: Profile-based architecture. The LLM generates site-seeking
 * profile dimensions AND dynamic OSM criteria, not just sector labels.
 */

// ─── Site-Seeking Profile (the heart of universal robustness) ───

export interface SiteProfile {
  marketPositioning: 'premium' | 'mid_market' | 'mass_market' | 'utility_scale' | 'industrial' | 'institutional' | 'unknown';
  landIntensity: 'high' | 'medium' | 'low';
  urbanPreference: 'urban_core' | 'urban' | 'suburban' | 'periurban' | 'rural' | 'flexible';
  infrastructureDependency: 'high' | 'medium' | 'low';
  footTrafficDependency: 'high' | 'medium' | 'low' | 'none';
  competitionSensitivity: 'avoid_competition' | 'tolerate_clustering' | 'prefer_clustering';
  accessProfile: 'pedestrian' | 'vehicle' | 'freight' | 'mixed' | 'minimal';
  environmentalSensitivity: 'high' | 'medium' | 'low';
  searchRadiusM: number;
  profileSummary: string;
}

// ─── Dynamic OSM Criterion (LLM-generated, not hardcoded) ───

export interface DynamicOsmCriterion {
  name: string;
  osmTags: string[];
  queryBothNodeAndWay: boolean;
  direction: 'positive' | 'negative';
  weight: number;
  scoringThresholds: number[];
  description: string;
}

// ─── LLM Intent (what the LLM returns) ───

export interface LLMIntent {
  businessType: string;
  sector: string;
  subSector?: string;
  brand?: string;
  useCaseSummary: string;

  // Site-seeking profile
  siteProfile: SiteProfile;

  // Dynamic criteria (LLM-generated for THIS specific request)
  osmCriteria: DynamicOsmCriterion[];

  // Geography
  coordinates?: { lat: number; lng: number };
  locationName?: string;
  anchorType: 'coordinate' | 'city' | 'none';
  neighborhoods?: string[];

  // Criteria
  positiveCriteria: Array<{ name: string; priority: 'high' | 'medium' | 'low' }>;
  negativeCriteria: Array<{ name: string; priority: 'high' | 'medium' | 'low' }>;
  exclusionCriteria: Array<{ name: string; distanceM?: number }>;

  // Constraints
  radiusConstraints?: Array<{ target: string; distanceM: number; direction: 'near' | 'away' }>;

  // Control
  requestedResultCount: number;
  uploadedDataReference: boolean;

  // Meta
  confidence: 'high' | 'medium' | 'low';
  ambiguities?: string[];
  reasoningSummary: string;
}

// ─── Sector ID mapping (fallback — maps LLM sector to existing template ID) ───
// Used ONLY when the LLM doesn't return osmCriteria (fallback to static templates)

export const SECTOR_ID_MAP: Record<string, string> = {
  energy: 'solar',
  solar: 'solar',
  solar_energy: 'solar',
  renewable_energy: 'solar',
  infrastructure: 'solar',
  data_center_infrastructure: 'solar',
  logistics: 'logistics',
  warehousing: 'logistics',
  cold_chain_logistics: 'logistics',
  last_mile_fulfillment: 'logistics',
  retail_food: 'cafe',
  food_beverage: 'cafe',
  qsr_fast_casual: 'cafe',
  premium_retail: 'retail',
  retail: 'retail',
  specialty_retail: 'retail',
  ev_mobility: 'ev',
  ev: 'ev',
  mobility: 'ev',
  education: 'preschool',
  early_childhood_education: 'preschool',
  healthcare: 'clinic',
  primary_healthcare: 'clinic',
  coworking: 'coworking',
  premium_coworking: 'coworking',
  real_estate: 'realestate',
  luxury_residential: 'realestate',
  affordable_housing: 'realestate',
  property: 'realestate',
  // Industrial / Manufacturing
  industrial: 'logistics',
  manufacturing: 'logistics',
  heavy_industry: 'logistics',
  light_manufacturing: 'logistics',
  factory: 'logistics',
  // Environmental / Waste
  environmental_services: 'logistics',
  waste_management: 'logistics',
  waste_processing: 'logistics',
  recycling: 'logistics',
};

export function resolveSectorId(llmSector: string): string | null {
  const key = llmSector.toLowerCase().replace(/[\s/\-]+/g, '_');
  if (SECTOR_ID_MAP[key]) return SECTOR_ID_MAP[key];

  // Fuzzy: check if any key is a substring
  for (const [mapKey, templateId] of Object.entries(SECTOR_ID_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) return templateId;
  }

  return null;
}
