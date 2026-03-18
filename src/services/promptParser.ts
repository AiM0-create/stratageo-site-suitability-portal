/**
 * Prompt Parser — Deterministic NLU for site suitability queries.
 *
 * Extracts structured AnalysisSpec from freeform user input.
 * Conservative: marks uncertain inferences, never overclaims.
 */

import type { AnalysisSpec, SpatialConstraint } from '../types';
import { SECTOR_TEMPLATES, findSectorTemplate, type SectorTemplate } from './sectorTemplates';

// ─── Coordinate extraction ───

const COORD_PATTERN = /(-?\d{1,3}\.?\d*)[,\s]+(-?\d{1,3}\.?\d*)/;

function extractCoordinates(text: string): { lat: number; lng: number } | null {
  // Look for explicit lat/lon mentions
  const latLon = text.match(/lat(?:itude)?\s*[:=]?\s*(-?\d+\.?\d*)[,\s]+lon(?:gitude)?\s*[:=]?\s*(-?\d+\.?\d*)/i);
  if (latLon) {
    const lat = parseFloat(latLon[1]);
    const lng = parseFloat(latLon[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // Look for coordinate pairs in context of spatial language
  const aroundMatch = text.match(/(?:around|near|at|check|within.*of)\s+(-?\d{1,3}\.\d{2,})[,\s]+(-?\d{1,3}\.\d{2,})/i);
  if (aroundMatch) {
    const lat = parseFloat(aroundMatch[1]);
    const lng = parseFloat(aroundMatch[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // Bare coordinate pair (must have decimals to avoid matching distances)
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

// ─── Distance extraction ───

interface DistanceMatch {
  valueM: number;
  original: string;
}

function parseDistance(text: string): DistanceMatch | null {
  // "500m", "500 meters", "0.5km", "2 km", "1.5 kilometers"
  const mMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)\b/i);
  if (mMatch) return { valueM: parseFloat(mMatch[1]), original: mMatch[0] };

  const kmMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?|kms?)\b/i);
  if (kmMatch) return { valueM: parseFloat(kmMatch[1]) * 1000, original: kmMatch[0] };

  return null;
}

// ─── Spatial constraint extraction ───

interface ConstraintPattern {
  pattern: RegExp;
  type: SpatialConstraint['type'];
  direction: SpatialConstraint['direction'];
  hardRule: boolean;
}

const CONSTRAINT_PATTERNS: ConstraintPattern[] = [
  // Hard exclusions
  { pattern: /must\s+not\s+(?:be\s+)?within\s+/i, type: 'exclusion', direction: 'away', hardRule: true },
  { pattern: /not\s+within\s+/i, type: 'exclusion', direction: 'away', hardRule: true },
  { pattern: /avoid\s+(?:anything\s+)?within\s+/i, type: 'exclusion', direction: 'away', hardRule: true },
  { pattern: /outside\s+/i, type: 'exclusion', direction: 'away', hardRule: true },

  // Hard proximity
  { pattern: /must\s+be\s+within\s+/i, type: 'proximity', direction: 'near', hardRule: true },
  { pattern: /within\s+/i, type: 'proximity', direction: 'near', hardRule: false },

  // Soft preferences
  { pattern: /(?:close\s+to|near(?:by)?|adjacent\s+to|accessible\s+to)\s+/i, type: 'preference', direction: 'near', hardRule: false },
  { pattern: /(?:away\s+from|far\s+from|avoid(?:ing)?)\s+/i, type: 'preference', direction: 'away', hardRule: false },
];

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
  const lowerText = text.toLowerCase();

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

// ─── Sector detection ───

function detectSector(text: string): SectorTemplate {
  const lower = text.toLowerCase();
  // Direct match attempt
  for (const t of SECTOR_TEMPLATES) {
    if (t.keywords.some(k => lower.includes(k))) return t;
  }
  return SECTOR_TEMPLATES[0]; // fallback to cafe
}

// ─── City extraction ───

const KNOWN_CITIES = [
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

// ─── Business type extraction ───

function extractBusinessType(text: string, sector: SectorTemplate): string {
  // Try to find the explicit business type from the text
  const lower = text.toLowerCase();
  for (const kw of sector.keywords) {
    const idx = lower.indexOf(kw);
    if (idx !== -1) {
      // Capitalize first letter
      return kw.charAt(0).toUpperCase() + kw.slice(1);
    }
  }
  return sector.label;
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

  // 1. Detect sector
  const sector = detectSector(text);

  // 2. Extract city
  let city = extractCity(text);
  if (!city) {
    // Normalize Bangalore -> Bengaluru
    city = '';
    notes.push('No city detected in prompt. Please specify a target city.');
    confidence = 'low';
  }
  if (city.toLowerCase() === 'bangalore') city = 'Bengaluru';
  if (city.toLowerCase() === 'gurgaon') city = 'Gurugram';

  // 3. Extract business type
  const businessType = extractBusinessType(text, sector);

  // 4. Extract coordinates
  const coords = extractCoordinates(text);

  // 5. Extract constraints
  const constraints = extractConstraints(text);

  // 6. Extract priorities
  const { positive, negative, weights } = extractPriorities(text, sector);

  // 7. Extract result count
  const resultCount = extractResultCount(text);

  // 8. Build notes
  if (constraints.length > 0) {
    notes.push(`Detected ${constraints.length} spatial constraint(s).`);
  }
  if (coords) {
    notes.push(`Using anchor point: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
  }
  if (constraints.some(c => c.osmTags.length === 0 && c.target !== 'Competitors')) {
    notes.push('Some constraint targets could not be mapped to OSM tags and may not be checkable.');
    confidence = 'medium';
  }

  return {
    businessType,
    sectorId: sector.id,
    geography: {
      city,
      anchor: coords || undefined,
    },
    constraints,
    positiveCriteria: positive,
    negativeCriteria: negative,
    inferredWeights: weights,
    resultCount,
    parsingNotes: notes,
    confidence,
  };
}

/**
 * Parse a simple "BusinessType in City" shorthand from UI chips.
 */
export function parseChipInput(businessType: string, city: string): AnalysisSpec {
  const sector = findSectorTemplate(businessType) || SECTOR_TEMPLATES[0];
  const weights: Record<string, number> = {};
  for (const c of sector.criteria) {
    weights[c.name] = c.defaultWeight;
  }
  return {
    businessType,
    sectorId: sector.id,
    geography: { city },
    constraints: [],
    positiveCriteria: [],
    negativeCriteria: [],
    inferredWeights: weights,
    resultCount: 3,
    parsingNotes: [],
    confidence: 'high',
  };
}
