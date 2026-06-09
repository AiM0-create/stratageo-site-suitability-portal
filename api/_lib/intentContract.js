/**
 * Site Suitability Intent Contract — v1.0
 *
 * Normalizes LLM-parsed intent into a bounded schema, classifies prompts
 * into a finite set of archetypes, and applies guardrails to prevent the
 * LLM from drifting into arbitrary scoring profiles across runs.
 *
 * The contract is a read-only diagnostic layer — it does NOT alter geocoding,
 * scoring, or exclusion logic. It exposes what the pipeline *decided* to do
 * and flags cases where the LLM output diverged from the expected archetype.
 */

export const CONTRACT_VERSION = '1.0';

// ─── Criteria families ────────────────────────────────────────────────────────
// Conceptual groupings of OSM criteria. Each archetype declares which families
// are semantically appropriate for it. Used to detect out-of-family LLM drift.

export const CRITERIA_FAMILIES = {
  foot_traffic: {
    tags: ['highway=pedestrian', 'highway=footway', 'highway=primary', 'highway=secondary'],
    description: 'Pedestrian flow and street-level foot traffic',
  },
  transit_access: {
    tags: ['public_transport=station', 'highway=bus_stop', 'railway=station', 'railway=halt'],
    description: 'Public transport access points',
  },
  residential_density: {
    tags: ['building=residential', 'landuse=residential', 'building=apartments'],
    description: 'Nearby residential population and housing',
  },
  competition: {
    tags: ['amenity=cafe', 'amenity=restaurant', 'shop=*', 'amenity=gym'],
    description: 'Competitor density (business-type-specific)',
  },
  parking: {
    tags: ['amenity=parking', 'amenity=fuel'],
    description: 'Parking and vehicle access',
  },
  industrial_land: {
    tags: ['landuse=industrial', 'building=industrial', 'building=warehouse'],
    description: 'Industrial land use and warehousing zones',
  },
  road_freight: {
    tags: ['highway=motorway', 'highway=trunk', 'highway=primary'],
    description: 'Major arterial roads and freight corridors',
  },
  office_commercial: {
    tags: ['building=commercial', 'building=office', 'office=*', 'landuse=commercial'],
    description: 'Office and commercial building density',
  },
  healthcare_signals: {
    tags: ['amenity=hospital', 'amenity=clinic', 'amenity=pharmacy'],
    description: 'Healthcare facilities',
  },
  education_signals: {
    tags: ['amenity=school', 'amenity=university', 'amenity=college', 'amenity=kindergarten'],
    description: 'Educational institutions',
  },
  open_land: {
    tags: ['landuse=farmland', 'landuse=meadow', 'natural=scrub', 'landuse=grass'],
    description: 'Open undeveloped land',
  },
  affluence_proxies: {
    tags: ['amenity=bank', 'shop=jewelry', 'building=commercial'],
    description: 'Urban affluence proxies',
  },
  // ── Extended families for large-footprint / infrastructure sectors ──
  power_infrastructure: {
    tags: ['power=line', 'power=substation', 'power=tower', 'power=generator'],
    description: 'Power grid infrastructure',
  },
  water_infrastructure: {
    tags: ['natural=water', 'waterway=river', 'man_made=reservoir', 'landuse=reservoir'],
    description: 'Water bodies and reservoirs',
  },
  hospitality_signals: {
    tags: ['tourism=hotel', 'tourism=guest_house', 'tourism=resort', 'amenity=hotel'],
    description: 'Hotel and hospitality infrastructure',
  },
  ev_charging: {
    tags: ['amenity=charging_station', 'amenity=fuel', 'highway=motorway_junction'],
    description: 'EV charging and fuel station density',
  },
  cold_chain_signals: {
    tags: ['landuse=industrial', 'building=warehouse', 'man_made=storage_tank'],
    description: 'Cold chain and temperature-controlled storage infrastructure',
  },
};

// ─── Archetype definitions ────────────────────────────────────────────────────
// Each archetype maps a class of business prompt to a bounded scoring profile.

export const ARCHETYPE_DEFINITIONS = {
  retail_high_street: {
    label: 'High Street / Premium Retail',
    allowedCriteriaFamilies: ['foot_traffic', 'transit_access', 'residential_density', 'competition', 'parking', 'affluence_proxies'],
    scoringMode: 'urban_footfall',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'low',
    typicalUrbanPreference: 'urban_core',
  },
  cafe_qsr: {
    label: 'Cafe / QSR / Coffee Shop',
    allowedCriteriaFamilies: ['foot_traffic', 'transit_access', 'residential_density', 'competition', 'parking'],
    scoringMode: 'urban_footfall',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'low',
    typicalUrbanPreference: 'urban',
  },
  grocery_daily_needs: {
    label: 'Grocery / Daily Needs Retail',
    allowedCriteriaFamilies: ['foot_traffic', 'residential_density', 'competition', 'parking', 'transit_access'],
    scoringMode: 'residential_catchment',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'low',
    typicalUrbanPreference: 'urban',
  },
  gym_fitness: {
    label: 'Gym / Fitness Center',
    allowedCriteriaFamilies: ['residential_density', 'transit_access', 'competition', 'parking', 'affluence_proxies'],
    scoringMode: 'residential_catchment',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'medium',
    typicalUrbanPreference: 'urban',
  },
  warehouse_industrial: {
    label: 'Warehouse / Industrial / Logistics',
    allowedCriteriaFamilies: ['industrial_land', 'road_freight', 'open_land', 'parking'],
    scoringMode: 'industrial_zone_fit',
    confidencePolicy: 'standard',
    typicalLandIntensity: 'high',
    typicalUrbanPreference: 'periurban',
  },
  office_commercial: {
    label: 'Office / Coworking / Commercial',
    allowedCriteriaFamilies: ['transit_access', 'office_commercial', 'parking', 'residential_density', 'foot_traffic'],
    scoringMode: 'urban_footfall',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'medium',
    typicalUrbanPreference: 'urban',
  },
  healthcare_clinic: {
    label: 'Clinic / Diagnostic / Healthcare',
    allowedCriteriaFamilies: ['residential_density', 'transit_access', 'healthcare_signals', 'parking', 'foot_traffic'],
    scoringMode: 'residential_catchment',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'medium',
    typicalUrbanPreference: 'urban',
  },
  education_facility: {
    label: 'School / Tutoring / Education Center',
    allowedCriteriaFamilies: ['residential_density', 'education_signals', 'transit_access', 'foot_traffic', 'parking'],
    scoringMode: 'residential_catchment',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'medium',
    typicalUrbanPreference: 'urban',
  },
  // ── Large-footprint / infrastructure archetypes ──────────────────────────
  energy_utility: {
    label: 'Solar / Wind / Power Plant / Utility',
    allowedCriteriaFamilies: ['open_land', 'power_infrastructure', 'water_infrastructure', 'road_freight'],
    scoringMode: 'open_land_utility',
    confidencePolicy: 'standard',
    typicalLandIntensity: 'high',
    typicalUrbanPreference: 'rural',
  },
  data_centre: {
    label: 'Data Centre / Server Farm',
    allowedCriteriaFamilies: ['power_infrastructure', 'road_freight', 'industrial_land', 'open_land'],
    scoringMode: 'industrial_zone_fit',
    confidencePolicy: 'standard',
    typicalLandIntensity: 'high',
    typicalUrbanPreference: 'periurban',
  },
  ev_fuel_station: {
    label: 'EV Charging Hub / Petrol / CNG Station',
    allowedCriteriaFamilies: ['road_freight', 'foot_traffic', 'parking', 'ev_charging'],
    scoringMode: 'highway_access',
    confidencePolicy: 'standard',
    typicalLandIntensity: 'medium',
    typicalUrbanPreference: 'suburban',
  },
  cold_chain_logistics: {
    label: 'Cold Chain / Refrigerated Storage / Food Processing',
    allowedCriteriaFamilies: ['industrial_land', 'road_freight', 'open_land', 'cold_chain_signals', 'water_infrastructure'],
    scoringMode: 'industrial_zone_fit',
    confidencePolicy: 'standard',
    typicalLandIntensity: 'high',
    typicalUrbanPreference: 'periurban',
  },
  hospitality_tourism: {
    label: 'Hotel / Resort / Serviced Apartment',
    allowedCriteriaFamilies: ['foot_traffic', 'transit_access', 'hospitality_signals', 'affluence_proxies', 'parking'],
    scoringMode: 'urban_footfall',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'medium',
    typicalUrbanPreference: 'urban',
  },
  large_hospital_campus: {
    label: 'Large Hospital / Medical Campus',
    allowedCriteriaFamilies: ['residential_density', 'transit_access', 'road_freight', 'parking', 'healthcare_signals', 'open_land'],
    scoringMode: 'residential_catchment',
    confidencePolicy: 'require_3_candidates',
    typicalLandIntensity: 'high',
    typicalUrbanPreference: 'suburban',
  },
  generic_site_suitability: {
    label: 'Generic Site Suitability',
    allowedCriteriaFamilies: Object.keys(CRITERIA_FAMILIES), // all families allowed
    scoringMode: 'generic',
    confidencePolicy: 'conservative',
    typicalLandIntensity: null,
    typicalUrbanPreference: 'flexible',
  },
};

// ─── Follow-up detection ──────────────────────────────────────────────────────

// Patterns strongly suggesting the prompt is modifying a prior result
const FOLLOWUP_PATTERNS = [
  /\bactually\b/i,
  /\bnow\s+i\s+(care|want|prefer|need|think)\b/i,
  /\binstead\b/i,
  /\bchange\s+(my|the)\s+(mind|preference|priority|weight)/i,
  /\bmore\s+about\b/i,
  /\bless\s+about\b/i,
  /\bprioritize\b/i,
  /\bfocus\s+more\s+on\b/i,
  /\bi\s+meant\b/i,
  /\bcan\s+you\s+redo\b/i,
  /\badjust\s+(the\s+)?(weights?|criteria|scores?)\b/i,
  /\bgive\s+me\s+(more|less)\b/i,
];

// Patterns that indicate a clearly self-contained new prompt (not a follow-up)
const FRESH_PROMPT_PATTERNS = [
  /\bfind\s+(locations?|places?|sites?|areas?)\b/i,
  /\bsuggest\s+\d+\s+locations?\b/i,
  /\banalyze\b.*\bfor\b/i,
  /\bopen\s+a\b/i,
  /\bi\s+want\s+to\s+open\b/i,
  /\blooking\s+for\b/i,
  /\bwhere\s+(should|can)\s+i\b/i,
];

// Business-type signal words that indicate a prompt has its own use-case context.
const BUSINESS_SIGNALS =
  /\b(cafe|coffee\s*shop|qsr|fast.?food|bakery|gym|fitness|yoga|pilates|retail|store|shop|boutique|showroom|outlet|supermarket|grocery|kirana|restaurant|office|coworking|warehouse|clinic|pharmacy|hospital|school|tutoring|hotel|studio|salon|spa|bar|pub)\b/i;

/**
 * Returns true if the prompt supplies its own business type AND location context,
 * making it analysable independently of any prior session.
 *
 * Both conditions must be met:
 *   1. A recognisable business / use-case keyword is present.
 *   2. An "in <place>" pattern with a substantive place name (3+ chars) is present.
 *
 * Examples that pass:  "For a gym in South Mumbai, now penalize Colaba"
 *                      "Budget coffee shop in Pune, I now care more about affluence"
 * Examples that fail:  "Actually, I now care more about affluence"  (no business, no city)
 *                      "Now make the radius tighter."               (no business, no city)
 */
function isSelfSufficientPrompt(prompt) {
  const hasBusiness = BUSINESS_SIGNALS.test(prompt);
  // "in <word(s)>" where the place name is at least 3 characters — broad enough to
  // catch "in Pune", "in South Mumbai", "in HSR Layout", "in the Thar Desert", etc.
  const hasLocation = /\bin\s+(?:the\s+)?[a-zA-Z]{3}/i.test(prompt);
  return hasBusiness && hasLocation;
}

/**
 * Detect whether a prompt looks like a follow-up modification of a prior result.
 * Returns { followupMode, requiresPriorContext }.
 */
export function detectFollowupMode(prompt) {
  const looksLikeFollowup = FOLLOWUP_PATTERNS.some(p => p.test(prompt));
  const looksLikeFresh    = FRESH_PROMPT_PATTERNS.some(p => p.test(prompt));

  if (!looksLikeFollowup) return { followupMode: 'none', requiresPriorContext: false };

  // If it also matches a fresh prompt pattern (e.g. "Actually, find me a cafe..."),
  // treat as fresh — the fresh pattern takes precedence.
  if (looksLikeFresh) return { followupMode: 'none', requiresPriorContext: false };

  // Self-sufficiency check: if the prompt provides its own business + location context
  // it can run independently even when follow-up language is present.
  // e.g. "For a gym in South Mumbai, now penalize Colaba" is fully self-contained.
  if (isSelfSufficientPrompt(prompt)) return { followupMode: 'none', requiresPriorContext: false };

  // Classify the type of modification
  if (/weight|priority|care\s+more|care\s+less|focus\s+more|prioritize|importance/i.test(prompt)) {
    return { followupMode: 'modifies_weights', requiresPriorContext: true };
  }
  if (/exclud|avoid|not\s+near|away\s+from|no\s+more\s+\w+/i.test(prompt)) {
    return { followupMode: 'modifies_exclusions', requiresPriorContext: true };
  }
  if (/instead\s+of|different\s+(area|city|location|place)|move\s+to/i.test(prompt)) {
    return { followupMode: 'modifies_geography', requiresPriorContext: true };
  }
  return { followupMode: 'ambiguous_followup', requiresPriorContext: true };
}

// ─── Archetype classification ─────────────────────────────────────────────────

/**
 * Map LLM-parsed intent to one of the bounded archetypes.
 * Returns the archetype key string.
 */
export function classifyArchetype(intent) {
  const bt  = (intent.businessType  || '').toLowerCase();
  const sec = (intent.sector        || '').toLowerCase();
  const mp  = (intent.siteProfile?.marketPositioning || '').toLowerCase();
  const ap  = (intent.siteProfile?.accessProfile     || '').toLowerCase();

  // ── Energy / utility infrastructure — check first (very specific, landIntensity=high) ──
  if (
    /solar\s*(farm|park|plant|power)|wind\s*(farm|park|turbine)|solar\s*energy|wind\s*energy|photovoltaic|pv\s*plant|utility.?scale\s*(solar|wind|power)|power\s*plant|biomass\s*plant|hydropower/i.test(bt) ||
    /solar|wind.?energy|power.?plant|renewable.?energy/i.test(sec)
  ) return 'energy_utility';

  // ── Data centre ──────────────────────────────────────────────────────────────
  if (/data.?cent(er|re)|server\s*farm|colocation|colo\s*facilit/i.test(bt)) return 'data_centre';

  // ── EV / fuel station ────────────────────────────────────────────────────────
  if (
    /ev\s*(charging|station|hub)|electric\s*vehicle\s*charg|charging\s*station|petrol\s*station|cng\s*station|fuel\s*station|pump\s*station/i.test(bt) ||
    /ev|fuel.?station|charging/i.test(sec)
  ) return 'ev_fuel_station';

  // ── Cold chain / food processing ─────────────────────────────────────────────
  if (/cold.?chain|cold\s*storage|refrigerat|frozen|temperature.?controlled|food\s*processing|agri.?processing|perishable/i.test(bt)) {
    return 'cold_chain_logistics';
  }

  // ── Large hospital campus (separate from outpatient clinic) ─────────────────
  if (/\b(hospital\s*campus|medical\s*campus|multi.?specialit|large\s*hospital|super.?specialit|tertiary\s*care|trauma\s*cent(er|re)|cancer\s*cent(er|re))\b/i.test(bt)) {
    return 'large_hospital_campus';
  }

  // ── Hospitality / tourism ────────────────────────────────────────────────────
  if (
    /\b(hotel|resort|serviced\s*apartment|boutique\s*hotel|lodge|motel|inn|hostel|homestay)\b/i.test(bt) ||
    /\b(hospitality|tourism)\b/i.test(sec)
  ) return 'hospitality_tourism';

  // ── Warehouse / industrial (broad: covers logistics, distribution, manufacturing) ──
  if (
    /warehouse|industrial|logistic|freight|godown|distribution\s*cent(er|re)|manufactur|spare.?part|storage\s*facilit/i.test(bt) ||
    /warehouse|industrial|logistic|freight/i.test(sec) ||
    mp === 'industrial' || ap === 'freight'
  ) return 'warehouse_industrial';

  // ── Gym / fitness ────────────────────────────────────────────────────────────
  if (/\b(gym|fitness|crossfit|yoga|pilates|sports?\s*cent(er|re)|wellness\s*cent(er|re))\b/i.test(bt)) return 'gym_fitness';

  // ── Cafe / QSR / food & beverage ─────────────────────────────────────────────
  if (
    /\b(cafe|coffee\s*shop|qsr|fast.?food|food\s*court|chai|tapri|tea\s*stall|bakery|patisserie|juice\s*bar)\b/i.test(bt) ||
    /\b(cafe|coffee|qsr|food.?bev)/i.test(sec)
  ) return 'cafe_qsr';

  // ── Grocery / daily needs ────────────────────────────────────────────────────
  if (/\b(grocery|supermarket|kirana|general\s*store|provisions?|daily\s*needs|hypermarket)\b/i.test(bt)) return 'grocery_daily_needs';

  // ── Healthcare (clinic / pharmacy / outpatient) ──────────────────────────────
  if (
    /\b(clinic|hospital|pharmacy|diagnostic|health\s*cent(er|re)|medical|dental|doctor|nursing\s*home|dialysis)\b/i.test(bt) ||
    /\b(healthcare|medical)\b/i.test(sec)
  ) return 'healthcare_clinic';

  // ── Education ────────────────────────────────────────────────────────────────
  if (
    /\b(school|tutoring|coaching|preschool|kindergarten|college|university|tuition|coaching\s*cent(er|re))\b/i.test(bt) ||
    /\beducation\b/i.test(sec)
  ) return 'education_facility';

  // ── Office / coworking ───────────────────────────────────────────────────────
  if (
    /\b(office|coworking|co.?working|it\s*park|business\s*cent(er|re)|workspace)\b/i.test(bt) ||
    /\b(office|commercial)\b/i.test(sec)
  ) return 'office_commercial';

  // ── Retail — classify last (broad match) ────────────────────────────────────
  if (/\b(retail|store|shop|boutique|showroom|outlet)\b/i.test(bt) || /\bretail\b/i.test(sec)) {
    return 'retail_high_street';
  }

  // Fallback: low-confidence or unrecognized intent
  if (intent.confidence === 'low' || (intent.ambiguities || []).length > 2) {
    return 'generic_site_suitability';
  }

  return 'generic_site_suitability';
}

// ─── Intent contract builder ──────────────────────────────────────────────────

/**
 * Build a normalized, bounded intent contract from LLM-parsed intent.
 *
 * @param {object} intent       — parsed LLM intent object
 * @param {string} prompt       — raw user prompt
 * @param {string|null} sessionContext — prior session context (if any)
 * @returns {object}            — normalized intent contract
 */
export function buildIntentContract(intent, prompt, sessionContext) {
  const guardrails = [];
  const missingContextFlags = [];

  // ── Follow-up detection ──────────────────────────────────────────────────
  const hasSessionContext = !!sessionContext;
  const { followupMode, requiresPriorContext } = detectFollowupMode(prompt);

  if (requiresPriorContext && !hasSessionContext) {
    missingContextFlags.push('prior_session_context_required');
  }

  // ── Archetype classification ─────────────────────────────────────────────
  const archetype     = classifyArchetype(intent);
  const archetypeDef  = ARCHETYPE_DEFINITIONS[archetype];
  const archetypeSource = archetype === 'generic_site_suitability' ? 'fallback' : 'matched';

  // ── Geography mode ───────────────────────────────────────────────────────
  let geographyMode = 'unknown';
  if (intent.anchorType === 'coordinate')     geographyMode = 'coordinate_anchored';
  else if (intent.locationName?.includes(',')) geographyMode = 'micro_locality';
  else if (intent.locationName)               geographyMode = 'city_named';

  // ── Missing context flags ────────────────────────────────────────────────
  if (!intent.locationName && intent.anchorType !== 'coordinate') {
    missingContextFlags.push('no_location_identified');
  }
  if (!intent.businessType) missingContextFlags.push('no_business_type');
  if (intent.confidence === 'low')            missingContextFlags.push('low_llm_confidence');
  if ((intent.ambiguities || []).length > 0) {
    missingContextFlags.push('has_ambiguities');
  }

  // ── Constraints from intent ───────────────────────────────────────────────
  const hardConstraints = (intent.exclusionCriteria || []).map(e => ({
    type: 'exclusion_zone',
    target: e.name,
    distanceM: e.distanceM || 2000,
  }));

  const softPreferences = (intent.positiveCriteria || []).map(p => ({
    type: 'preference',
    target: p.name,
    strength: p.priority || 'medium',
  }));

  // ── Guardrail: out-of-family criteria ────────────────────────────────────
  // Check whether LLM-generated osmCriteria use OSM tag keys that are entirely
  // outside the archetype's expected criteria families.
  const allowedFamilies    = archetypeDef.allowedCriteriaFamilies;
  const allAllowedTagKeys  = allowedFamilies
    .flatMap(f => CRITERIA_FAMILIES[f]?.tags || [])
    .map(t => t.split('=')[0]);

  const llmCriteria = intent.osmCriteria || [];
  const outOfFamily = llmCriteria.filter(c => {
    const critTagKeys = (c.osmTags || []).map(t => t.split('=')[0]);
    // If EVERY tag key in this criterion is outside the allowed set → flag it
    return critTagKeys.length > 0 && critTagKeys.every(k => !allAllowedTagKeys.includes(k));
  });

  if (outOfFamily.length > 0 && archetype !== 'generic_site_suitability') {
    guardrails.push(
      `criteria_outside_archetype_family: ${outOfFamily.map(c => c.name).join(', ')}`,
    );
  }

  // ── Guardrail: LLM confidence low → downgrade to conservative ────────────
  if (intent.confidence === 'low') {
    guardrails.push('archetype_downgraded_due_to_low_llm_confidence');
  }

  return {
    contractVersion: CONTRACT_VERSION,
    businessArchetype: archetype,
    archetypeLabel: archetypeDef.label,
    archetypeSource,
    sectorFamily: intent.sector || intent.subSector || 'unknown',
    geographyMode,
    targetLocation: intent.locationName || null,
    hardConstraints,
    softPreferences,
    exclusions: (intent.exclusionCriteria || []).map(e => e.name),
    profileSelection: archetype,
    allowedCriteriaFamilies: allowedFamilies,
    scoringMode: archetypeDef.scoringMode,
    confidencePolicy: archetypeDef.confidencePolicy,
    followupMode,
    requiresPriorContext,
    missingContextFlags,
    intentGuardrailsApplied: guardrails,
  };
}
