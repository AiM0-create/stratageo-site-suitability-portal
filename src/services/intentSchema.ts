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
  // Energy / Solar / Data Centers
  energy: 'solar',
  solar: 'solar',
  solar_energy: 'solar',
  renewable_energy: 'solar',
  infrastructure: 'solar',
  data_center: 'logistics',
  data_center_infrastructure: 'logistics',
  // Logistics / Warehousing
  logistics: 'logistics',
  warehousing: 'logistics',
  cold_chain: 'logistics',
  cold_chain_logistics: 'logistics',
  last_mile_fulfillment: 'logistics',
  cold_storage: 'logistics',
  // Food & Beverage
  retail_food: 'cafe',
  food_beverage: 'cafe',
  food_service: 'cafe',
  qsr: 'cafe',
  qsr_fast_casual: 'cafe',
  restaurant: 'cafe',
  cloud_kitchen: 'cafe',
  // Retail
  premium_retail: 'retail',
  retail: 'retail',
  specialty_retail: 'retail',
  luxury_retail: 'retail',
  mass_market_retail: 'retail',
  grocery_retail: 'retail',
  automotive_retail: 'retail',
  sports_retail: 'retail',
  // EV / Transport / Fuel
  ev_mobility: 'ev',
  ev: 'ev',
  ev_charging: 'ev',
  electric_vehicle: 'ev',
  electric_vehicle_infrastructure: 'ev',
  mobility: 'ev',
  fuel_retail: 'ev',
  fuel_station: 'ev',
  transport: 'ev',
  // Education
  education: 'preschool',
  early_childhood_education: 'preschool',
  early_childhood: 'preschool',
  // Healthcare
  healthcare: 'clinic',
  primary_healthcare: 'clinic',
  diagnostic: 'clinic',
  pharmacy: 'clinic',
  // Fitness (maps to retail — physical location with foot traffic)
  health_fitness: 'retail',
  fitness: 'retail',
  gym: 'retail',
  // Coworking
  coworking: 'coworking',
  premium_coworking: 'coworking',
  office: 'coworking',
  // Real Estate
  real_estate: 'realestate',
  residential: 'realestate',
  luxury_residential: 'realestate',
  affordable_housing: 'realestate',
  property: 'realestate',
  co_living: 'realestate',
  coliving: 'realestate',
  // Hospitality (uses retail template — foot traffic + commercial area)
  hospitality: 'retail',
  hotel: 'retail',
  boutique_hotel: 'retail',
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
