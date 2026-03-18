/**
 * Intent Schema — Structured types for LLM-extracted intent.
 *
 * The LLM returns this shape. The deterministic pipeline
 * operates on it after validation.
 */

// ─── LLM Intent (what the LLM returns) ───

export interface LLMIntent {
  businessType: string;
  sector: string;
  subSector?: string;
  useCaseSummary: string;

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

// ─── Sector ID mapping (LLM sector string → existing template ID) ───

export const SECTOR_ID_MAP: Record<string, string> = {
  energy: 'solar',
  solar: 'solar',
  renewable_energy: 'solar',
  infrastructure: 'solar',
  logistics: 'logistics',
  warehousing: 'logistics',
  retail_food: 'cafe',
  food_beverage: 'cafe',
  retail: 'retail',
  ev_mobility: 'ev',
  ev: 'ev',
  mobility: 'ev',
  education: 'preschool',
  healthcare: 'clinic',
  coworking: 'coworking',
  real_estate: 'realestate',
  property: 'realestate',
};

/**
 * The JSON schema description sent to the LLM as part of the system prompt.
 * Kept as a constant so it's defined once and reused.
 */
export const LLM_INTENT_SCHEMA_DESCRIPTION = `{
  "businessType": "string — exact business/project type (e.g. Solar Farm, Warehouse, Cafe, Data Center, EV Charging Station, Preschool, Clinic, Coworking Space)",
  "sector": "string — one of: energy, solar, logistics, retail_food, retail, ev_mobility, education, healthcare, coworking, real_estate, infrastructure",
  "subSector": "string|null — optional sub-category (e.g. photovoltaic, cold_storage, quick_service)",
  "useCaseSummary": "string — 1 sentence summary of what the user wants to achieve",
  "coordinates": {"lat": "number|null", "lng": "number|null"},
  "locationName": "string|null — city or region name if mentioned",
  "anchorType": "string — coordinate|city|none",
  "neighborhoods": ["string — 3-5 real neighborhood names if city-based analysis, empty array if coordinate-based"],
  "positiveCriteria": [{"name": "string — what the user wants nearby", "priority": "high|medium|low"}],
  "negativeCriteria": [{"name": "string — what the user wants to avoid or minimize", "priority": "high|medium|low"}],
  "exclusionCriteria": [{"name": "string — hard exclusion rule", "distanceM": "number|null — distance in meters if specified"}],
  "radiusConstraints": [{"target": "string", "distanceM": "number", "direction": "near|away"}],
  "requestedResultCount": "number — how many results requested, default 3, max 5",
  "uploadedDataReference": "boolean — true if prompt references CSV/uploaded/my locations",
  "confidence": "high|medium|low",
  "ambiguities": ["string — things you are uncertain about"],
  "reasoningSummary": "string — 1-2 sentence explanation of your interpretation"
}`;

export function resolveSectorId(llmSector: string): string | null {
  const key = llmSector.toLowerCase().replace(/[\s/-]+/g, '_');
  if (SECTOR_ID_MAP[key]) return SECTOR_ID_MAP[key];

  // Fuzzy: check if any key is a substring
  for (const [mapKey, templateId] of Object.entries(SECTOR_ID_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) return templateId;
  }

  return null;
}
