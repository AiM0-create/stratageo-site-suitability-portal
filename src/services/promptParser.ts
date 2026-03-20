/**
 * Prompt Parser — Deterministic NLU for site suitability queries.
 *
 * Extracts structured AnalysisSpec from freeform user input.
 * Conservative: marks uncertain inferences, never overclaims.
 *
 * Uses the scoring-based businessClassifier for sector detection
 * instead of naive keyword matching. Cross-validates via intentValidator.
 */

import type { AnalysisSpec, SpatialConstraint } from '../types';
import { SECTOR_TEMPLATES, getSectorById, type SectorTemplate } from './sectorTemplates';
import { classifyBusinessType, extractBusinessLabel } from './businessClassifier';
import { validateClassification } from './intentValidator';
import { extractDomainSignals } from './domainSignalExtractor';

// ─── Coordinate extraction ───

function extractCoordinates(text: string): { lat: number; lng: number } | null {
  // Pattern 1: "latitude X and longitude Y" / "latitude X longitude Y" / "lat X lon Y"
  const latAndLon = text.match(/lat(?:itude)?\s*[:=]?\s*(-?\d+\.?\d*)\s*(?:and\s+)?lon(?:gitude)?\s*[:=]?\s*(-?\d+\.?\d*)/i);
  if (latAndLon) {
    const lat = parseFloat(latAndLon[1]);
    const lng = parseFloat(latAndLon[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // Pattern 2: "latitude X, longitude Y" with comma separator
  const latCommaLon = text.match(/lat(?:itude)?\s*[:=]?\s*(-?\d+\.?\d*)\s*,\s*lon(?:gitude)?\s*[:=]?\s*(-?\d+\.?\d*)/i);
  if (latCommaLon) {
    const lat = parseFloat(latCommaLon[1]);
    const lng = parseFloat(latCommaLon[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // Pattern 3: "use lat X lon Y" / "lat X lon Y as anchor"
  const latLonSpaced = text.match(/lat\s+(-?\d+\.?\d+)\s+lon\s+(-?\d+\.?\d+)/i);
  if (latLonSpaced) {
    const lat = parseFloat(latLonSpaced[1]);
    const lng = parseFloat(latLonSpaced[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // Pattern 4: coordinate pairs in spatial context ("near X, Y", "within Xkm of X, Y", "of the lat/lng")
  const spatialMatch = text.match(/(?:around|near|at|check|of|from)\s+(?:the\s+)?(?:lat\/?lng\.?\s+)?(-?\d{1,3}\.\d{2,})[,\s]+(-?\d{1,3}\.\d{2,})/i);
  if (spatialMatch) {
    const lat = parseFloat(spatialMatch[1]);
    const lng = parseFloat(spatialMatch[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // Pattern 5: Bare coordinate pair (must have decimals to avoid matching distances)
  const bare = text.match(/\b(-?\d{1,3}\.\d{3,})[,\s]+(-?\d{1,3}\.\d{3,})\b/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lng = parseFloat(bare[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  return null;
}

function isValidCoord(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ─── Spatial constraint extraction ───

// Feature-to-OSM-tag mapping for constraint targets
const FEATURE_OSM_MAP: Record<string, { tags: string[]; label: string }> = {
  metro: { tags: ['railway=station', 'station=subway'], label: 'Metro/Rail Station' },
  'metro station': { tags: ['railway=station', 'station=subway'], label: 'Metro Station' },
  'railway station': { tags: ['railway=station'], label: 'Railway Station' },
  highway: { tags: ['highway=trunk', 'highway=motorway', 'highway=primary'], label: 'Highway' },
  school: { tags: ['amenity=school'], label: 'School' },
  schools: { tags: ['amenity=school'], label: 'Schools' },
  hospital: { tags: ['amenity=hospital'], label: 'Hospital' },
  hospitals: { tags: ['amenity=hospital'], label: 'Hospitals' },
  'water body': { tags: ['natural=water', 'waterway=river'], label: 'Water Body' },
  'water bodies': { tags: ['natural=water', 'waterway=river'], label: 'Water Bodies' },
  river: { tags: ['waterway=river'], label: 'River' },
  lake: { tags: ['natural=water'], label: 'Lake' },
  park: { tags: ['leisure=park'], label: 'Park' },
  parks: { tags: ['leisure=park'], label: 'Parks' },
  substation: { tags: ['power=substation'], label: 'Power Substation' },
  substations: { tags: ['power=substation'], label: 'Power Substations' },
  'transmission line': { tags: ['power=line'], label: 'Transmission Line' },
  'power line': { tags: ['power=line'], label: 'Power Line' },
  'bus stop': { tags: ['highway=bus_stop'], label: 'Bus Stop' },
  'public transport': { tags: ['public_transport=station', 'highway=bus_stop', 'railway=station'], label: 'Public Transport' },
  'industrial zone': { tags: ['landuse=industrial'], label: 'Industrial Zone' },
  'industrial zones': { tags: ['landuse=industrial'], label: 'Industrial Zones' },
  landfill: { tags: ['landuse=landfill'], label: 'Landfill' },
  'protected area': { tags: ['boundary=protected_area', 'leisure=nature_reserve'], label: 'Protected Area' },
  'protected areas': { tags: ['boundary=protected_area', 'leisure=nature_reserve'], label: 'Protected Areas' },
  forest: { tags: ['landuse=forest', 'natural=wood'], label: 'Forest' },
  market: { tags: ['amenity=marketplace', 'shop=supermarket'], label: 'Market' },
  markets: { tags: ['amenity=marketplace', 'shop=supermarket'], label: 'Markets' },
  'fuel station': { tags: ['amenity=fuel'], label: 'Fuel Station' },
  'charging station': { tags: ['amenity=charging_station'], label: 'Charging Station' },
  competitor: { tags: [], label: 'Competitors' },
  competitors: { tags: [], label: 'Competitors' },
  road: { tags: ['highway=primary', 'highway=secondary', 'highway=tertiary'], label: 'Major Road' },
  'major road': { tags: ['highway=primary', 'highway=secondary'], label: 'Major Road' },
  residential: { tags: ['building=apartments', 'building=residential', 'landuse=residential'], label: 'Residential Area' },
  'residential area': { tags: ['building=apartments', 'building=residential', 'landuse=residential'], label: 'Residential Area' },
};

function extractConstraints(text: string): SpatialConstraint[] {
  const constraints: SpatialConstraint[] = [];

  // Extract distance-based constraints
  // Pattern: "[must/not/avoid] within X km/m of [feature]"
  const distConstraintRe = /(?:must\s+(?:not\s+)?be\s+|not\s+|avoid\s+(?:anything\s+)?)?within\s+(\d+(?:\.\d+)?)\s*(?:km|m|meters?|kilometres?|kilometers?)\s+(?:of|from)\s+(?:a\s+|the\s+)?([a-z\s]+?)(?:\.|,|$)/gi;
  let match;
  while ((match = distConstraintRe.exec(text)) !== null) {
    const fullMatch = match[0].toLowerCase();
    const value = parseFloat(match[1]);
    const unit = fullMatch.includes('km') || fullMatch.includes('kilomet') ? 'km' : 'm';
    const distanceM = unit === 'km' ? value * 1000 : value;
    const target = match[2].trim();

    const isNegative = /(?:not|avoid|must\s+not)/.test(fullMatch);
    const isHard = /(?:must|avoid)/.test(fullMatch);

    const featureInfo = findFeature(target);
    constraints.push({
      type: isNegative ? 'exclusion' : 'proximity',
      target: featureInfo.label,
      osmTags: featureInfo.tags,
      distanceM,
      direction: isNegative ? 'away' : 'near',
      hardRule: isHard,
      label: match[0].trim(),
    });
  }

  // Extract non-distance spatial preferences
  // "near metro", "close to highway", "away from schools", "avoid competitors"
  const prefRe = /(?:close\s+to|near(?:by)?|adjacent\s+to|away\s+from|far\s+from|avoid(?:ing)?)\s+(?:a\s+|the\s+)?([a-z\s]+?)(?:\.|,|and\s|$)/gi;
  while ((match = prefRe.exec(text)) !== null) {
    const target = match[1].trim();
    // Skip if already captured as distance constraint
    if (constraints.some(c => c.target.toLowerCase() === target)) continue;

    const fullMatch = match[0].toLowerCase();
    const isNegative = /(?:away|far|avoid)/.test(fullMatch);
    const featureInfo = findFeature(target);

    constraints.push({
      type: 'preference',
      target: featureInfo.label,
      osmTags: featureInfo.tags,
      direction: isNegative ? 'away' : 'near',
      hardRule: false,
      label: match[0].trim(),
    });
  }

  // Named area exclusions: "not in Koramangala", "but NOT Chandni Chowk", "excluding HSR Layout"
  const namedExclusionRe = /(?:not\s+(?:in|near)\s+|but\s+not\s+|excluding?\s+|except\s+)([A-Z][a-zA-Z\s]+?)(?:\s*[,.]|\s+and\s+|\s+or\s+|$)/gi;
  while ((match = namedExclusionRe.exec(text)) !== null) {
    const area = match[1].trim();
    // Skip if it looks like a generic feature we already handle
    if (FEATURE_OSM_MAP[area.toLowerCase()]) continue;
    // Skip if already captured
    if (constraints.some(c => c.target.toLowerCase() === area.toLowerCase())) continue;
    constraints.push({
      type: 'exclusion',
      target: area,
      osmTags: [], // empty = named area, will be geocoded by analysisService
      direction: 'away',
      hardRule: true,
      label: `Exclude area: ${area}`,
    });
  }

  return constraints;
}

function findFeature(target: string): { tags: string[]; label: string } {
  const t = target.toLowerCase().trim();
  // Exact match
  if (FEATURE_OSM_MAP[t]) return FEATURE_OSM_MAP[t];
  // Partial match
  for (const [key, val] of Object.entries(FEATURE_OSM_MAP)) {
    if (t.includes(key) || key.includes(t)) return val;
  }
  // Fallback: unknown feature
  return { tags: [], label: target.charAt(0).toUpperCase() + target.slice(1) };
}

// ─── City extraction ───

const KNOWN_CITIES = [
  'Delhi NCR', 'NCR', // Must be before 'Delhi' to match first
  'Bengaluru', 'Bangalore', 'Mumbai', 'Delhi', 'New Delhi', 'Hyderabad', 'Pune', 'Chennai',
  'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow', 'Chandigarh', 'Kochi', 'Indore', 'Nagpur',
  'Noida', 'Gurugram', 'Gurgaon', 'Mysore', 'Mysuru', 'Vizag', 'Visakhapatnam',
  'Coimbatore', 'Thiruvananthapuram', 'Bhopal', 'Surat', 'Vadodara', 'Patna', 'Ranchi',
];

function extractCity(text: string): string {
  // "in [city]" pattern
  const inMatch = text.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
  if (inMatch) {
    const candidate = inMatch[1].trim();
    const known = KNOWN_CITIES.find(c => c.toLowerCase() === candidate.toLowerCase());
    if (known) return known;
    return candidate; // Accept unknown cities too
  }

  // Check for known city names anywhere in text
  const lower = text.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (lower.includes(city.toLowerCase())) return city;
  }

  // "at [city]" / "around [city]"
  const atMatch = text.match(/(?:at|around|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
  if (atMatch) return atMatch[1].trim();

  return '';
}

// ─── Priority / weight extraction ───

function extractPriorities(text: string, sector: SectorTemplate): { positive: string[]; negative: string[]; weights: Record<string, number> } {
  const lower = text.toLowerCase();
  const positive: string[] = [];
  const negative: string[] = [];
  const weights: Record<string, number> = {};

  // Copy baseline weights
  for (const c of sector.criteria) {
    weights[c.name] = c.defaultWeight;
  }

  // Detect priority-shifting language
  if (/prioriti[sz]e\s+accessibility|good\s+(?:road|transport)\s+access/i.test(lower)) {
    const key = sector.criteria.find(c => /transit|transport|access/i.test(c.name))?.name;
    if (key) { weights[key] = Math.min(0.35, (weights[key] || 0.15) + 0.10); positive.push('transit accessibility'); }
  }
  if (/(?:low|less|reduce|minimal)\s+competition/i.test(lower)) {
    const key = sector.criteria.find(c => /compet/i.test(c.name))?.name;
    if (key) { weights[key] = Math.min(0.35, (weights[key] || 0.15) + 0.10); positive.push('low competition'); }
  }
  if (/(?:high|dense|strong)\s+residential|family/i.test(lower)) {
    const key = sector.criteria.find(c => /residential|family/i.test(c.name))?.name;
    if (key) { weights[key] = Math.min(0.35, (weights[key] || 0.15) + 0.10); positive.push('residential density'); }
  }
  if (/visibility|prominent|visible/i.test(lower)) {
    positive.push('visibility');
  }
  if (/(?:away|avoid|not near)\s+.*(?:traffic|congestion)/i.test(lower)) {
    negative.push('heavy traffic');
  }

  return { positive, negative, weights };
}

// ─── User-point reference detection ───

export interface UserPointIntent {
  detected: boolean;
  mode: 'exclude' | 'include' | 'penalty';
  radiusM?: number;
}

const USER_POINT_PHRASES = [
  'these locations', 'uploaded points', 'uploaded locations', 'my csv',
  'csv locations', 'my stores', 'my locations', 'existing stores',
  'existing locations', 'given coordinates', 'given points', 'these points',
  'these coordinates', 'provided locations', 'our stores', 'our locations',
  'my branches', 'our branches', 'competitor locations', 'their stores',
];

export function parseUserPointIntent(text: string): UserPointIntent {
  const lower = text.toLowerCase();

  // Check if user references uploaded points
  const hasReference = USER_POINT_PHRASES.some(phrase => lower.includes(phrase));
  if (!hasReference) {
    return { detected: false, mode: 'exclude' };
  }

  // Determine mode: exclude, include, or penalty
  const isExclude = /(?:not\s+within|away\s+from|avoid|outside|at\s+least\s+\d|beyond)\s/.test(lower);
  const isInclude = /(?:within|near|close\s+to|around|inside)\s/.test(lower) && !isExclude;

  // Extract radius if specified
  let radiusM: number | undefined;
  const radiusMatch = lower.match(
    /(?:not\s+within|within|at\s+least|beyond|away\s+from.*?)\s+(\d+(?:\.\d+)?)\s*(?:km|m|meters?|kilometres?|kilometers?)/i,
  );
  if (radiusMatch) {
    const value = parseFloat(radiusMatch[1]);
    const isKm = /km|kilomet/.test(radiusMatch[0]);
    radiusM = isKm ? value * 1000 : value;
  }

  const mode = isExclude ? 'exclude' : isInclude ? 'include' : 'penalty';

  return { detected: true, mode, radiusM };
}

// ─── Neighborhood extraction ───

const KNOWN_NEIGHBORHOODS: Record<string, string[]> = {
  bengaluru: ['Koramangala', 'Indiranagar', 'HSR Layout', 'Whitefield', 'Jayanagar', 'JP Nagar', 'Malleshwaram', 'Marathahalli', 'Electronic City', 'Yelahanka', 'Hebbal', 'Rajajinagar', 'Banashankari', 'BTM Layout', 'Sarjapur Road'],
  mumbai: ['Bandra', 'Andheri', 'Powai', 'Lower Parel', 'BKC', 'Malad', 'Goregaon', 'Juhu', 'Dadar', 'Worli', 'Colaba', 'Navi Mumbai', 'Thane', 'Borivali', 'Kurla'],
  delhi: ['Connaught Place', 'Dwarka', 'Hauz Khas', 'Saket', 'Lajpat Nagar', 'Karol Bagh', 'Chandni Chowk', 'Rohini', 'Vasant Kunj', 'Defence Colony', 'Greater Kailash', 'Nehru Place', 'Janakpuri'],
  pune: ['Koregaon Park', 'Viman Nagar', 'Hinjewadi', 'Kothrud', 'Baner', 'Aundh', 'Hadapsar', 'Wakad', 'Shivajinagar', 'Deccan'],
  hyderabad: ['Madhapur', 'Gachibowli', 'Banjara Hills', 'Jubilee Hills', 'Kondapur', 'HITEC City', 'Secunderabad', 'Ameerpet'],
  chennai: ['T. Nagar', 'Anna Nagar', 'Adyar', 'Velachery', 'Nungambakkam', 'OMR', 'Guindy', 'Mylapore'],
  gurgaon: ['Cyber City', 'Sohna Road', 'Golf Course Road', 'MG Road', 'Sector 29', 'Huda City Centre', 'DLF Phase'],
  noida: ['Sector 18', 'Sector 62', 'Sector 137', 'Greater Noida', 'Noida Expressway'],
};

function extractNeighborhoods(text: string, city: string): string[] {
  const lower = text.toLowerCase();
  const cityKey = city.toLowerCase().replace(/\s+/g, '');
  const neighborhoods: string[] = [];

  // Check known neighborhoods for the detected city
  for (const [key, areas] of Object.entries(KNOWN_NEIGHBORHOODS)) {
    if (cityKey.includes(key) || key.includes(cityKey)) {
      for (const area of areas) {
        if (lower.includes(area.toLowerCase())) {
          neighborhoods.push(area);
        }
      }
    }
  }

  // Also try "near [Area]" or "in [Area]" patterns for unknown neighborhoods
  const nearAreaRe = /(?:near|in|around|at)\s+([A-Z][a-zA-Z\s]{2,20}?)(?:\s*[,.]|\s+(?:area|locality|neighborhood|in|near|for|and|but|with))/g;
  let match;
  while ((match = nearAreaRe.exec(text)) !== null) {
    const candidate = match[1].trim();
    // Skip city name itself and known cities
    if (candidate.toLowerCase() === city.toLowerCase()) continue;
    if (KNOWN_CITIES.some(c => c.toLowerCase() === candidate.toLowerCase())) continue;
    // Skip if already found
    if (neighborhoods.some(n => n.toLowerCase() === candidate.toLowerCase())) continue;
    // Skip if it's a business type word
    if (/^(cafe|store|shop|clinic|warehouse|office|farm|station|center|hub)$/i.test(candidate)) continue;
    neighborhoods.push(candidate);
  }

  return neighborhoods;
}

// ─── Result count extraction ───

function extractResultCount(text: string): number {
  const match = text.match(/(?:show|give|return|find|top)\s+(\d+)\s+(?:results?|locations?|places?|areas?|options?)/i);
  if (match) {
    const n = parseInt(match[1]);
    return Math.min(5, Math.max(1, n));
  }
  return 3; // default
}

// ─── Main parser ───

export function parsePrompt(rawPrompt: string): AnalysisSpec {
  const text = rawPrompt.trim();
  const notes: string[] = [];
  let confidence: AnalysisSpec['confidence'] = 'high';

  // 1. Classify business type using scoring-based classifier
  let classification = classifyBusinessType(text);

  // 2. Cross-validate the classification
  const validation = validateClassification(classification, text);
  if (!validation.valid && validation.correctedSectorId) {
    // Re-classify was needed — use corrected result
    notes.push(validation.reason || 'Classification corrected by validator.');
    classification = classifyBusinessType(text); // re-run to get full result
    // Force the corrected sector if validator identified it
    if (validation.correctedSectorId !== classification.sectorId) {
      classification = {
        ...classification,
        sectorId: validation.correctedSectorId,
        label: validation.correctedLabel || classification.label,
      };
    }
  }

  // 3. Get the sector template
  const sector = getSectorById(classification.sectorId);

  // 4. Extract business type label from prompt text
  const businessType = extractBusinessLabel(text, classification);

  // 5. Extract coordinates (before city — coords can substitute for city)
  const coords = extractCoordinates(text);

  // 6. Extract city
  let city = extractCity(text);
  if (!city && coords) {
    // Coordinates provided — city will be resolved via reverse geocoding downstream
    city = '';
    notes.push(`Coordinates detected (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}). Will use as anchor point.`);
    // Don't downgrade confidence — coordinates are a valid anchor
  } else if (!city && !coords) {
    city = '';
    notes.push('No city or coordinates detected. Please specify a location.');
    confidence = 'low';
  }
  if (city.toLowerCase() === 'bangalore') city = 'Bengaluru';
  if (city.toLowerCase() === 'gurgaon') city = 'Gurugram';

  // 7. Extract constraints
  const constraints = extractConstraints(text);

  // 8. Extract domain-specific signals and merge as additional constraints
  const domainSignals = extractDomainSignals(text, classification.sectorId, constraints);
  const allConstraints = [...constraints, ...domainSignals];

  // 9. Extract priorities
  const { positive, negative, weights } = extractPriorities(text, sector);

  // 10. Extract result count
  const resultCount = extractResultCount(text);

  // 11. Detect user-point references
  const userPointIntent = parseUserPointIntent(text);

  // 12. Build notes
  // Add classification info
  notes.push(`Detected: ${classification.label} (Confidence: ${classification.confidence.charAt(0).toUpperCase() + classification.confidence.slice(1)}, Keywords: ${classification.matchedKeywords.join(', ') || 'none'})`);

  if (allConstraints.length > 0) {
    notes.push(`Detected ${allConstraints.length} spatial constraint(s).`);
  }
  if (allConstraints.some(c => c.osmTags.length === 0 && c.target !== 'Competitors')) {
    notes.push('Some constraint targets could not be mapped to OSM tags and may not be checkable.');
    if (confidence === 'high') confidence = 'medium';
  }
  if (userPointIntent.detected) {
    notes.push(`Detected reference to user-supplied locations (mode: ${userPointIntent.mode}${userPointIntent.radiusM ? `, radius: ${(userPointIntent.radiusM / 1000).toFixed(1)}km` : ''}).`);
  }

  // Use the lower confidence between classifier and geo extraction
  if (classification.confidence === 'low' && confidence !== 'low') {
    confidence = 'low';
  } else if (classification.confidence === 'medium' && confidence === 'high') {
    confidence = 'medium';
  }

  // 13. Extract neighborhoods mentioned in the prompt
  const neighborhoods = extractNeighborhoods(text, city);

  return {
    businessType,
    sectorId: classification.sectorId,
    geography: {
      city,
      anchor: coords || undefined,
      neighborhoods: neighborhoods.length > 0 ? neighborhoods : undefined,
    },
    constraints: allConstraints,
    userPointConstraints: [],
    hasUserPointReference: userPointIntent.detected,
    positiveCriteria: positive,
    negativeCriteria: negative,
    inferredWeights: weights,
    resultCount,
    parsingNotes: notes,
    confidence,
    classificationMeta: {
      confidence: classification.confidence,
      matchedKeywords: classification.matchedKeywords,
      reasoning: classification.reasoning,
      score: classification.score,
      source: 'local' as const,
    },
  };
}

/**
 * Parse a simple "BusinessType in City" shorthand from UI chips.
 */
export function parseChipInput(businessType: string, city: string): AnalysisSpec {
  // Use the classifier to find the right sector
  const classification = classifyBusinessType(businessType);
  const sector = getSectorById(classification.sectorId);
  const weights: Record<string, number> = {};
  for (const c of sector.criteria) {
    weights[c.name] = c.defaultWeight;
  }
  return {
    businessType,
    sectorId: classification.sectorId,
    geography: { city },
    constraints: [],
    userPointConstraints: [],
    hasUserPointReference: false,
    positiveCriteria: [],
    negativeCriteria: [],
    inferredWeights: weights,
    resultCount: 3,
    parsingNotes: [],
    confidence: 'high',
    classificationMeta: {
      confidence: classification.confidence,
      matchedKeywords: classification.matchedKeywords,
      reasoning: classification.reasoning,
      score: classification.score,
      source: 'local' as const,
    },
  };
}
