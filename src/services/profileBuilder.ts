/**
 * Profile Builder — Converts LLM intent into a site-seeking profile
 * and dynamic MCDA configuration.
 *
 * The profile is the universal abstraction that replaces hardcoded sector
 * templates. Different prompts resolve into profiles, not brittle labels.
 *
 * Examples:
 * - "Apple Store in Bengaluru" → premium urban retail profile
 * - "Solar farm near 28.7, 77.1" → infrastructure + land suitability profile
 * - "Cold chain facility near Mumbai" → logistics + power dependency profile
 */

import type { AnalysisSpec, SpatialConstraint } from '../types';
import type { LLMIntent, SiteProfile, DynamicOsmCriterion } from './intentSchema';
import { resolveSectorId } from './intentSchema';
import type { SectorTemplate, CriterionTemplate, OsmQueryDef } from './sectorTemplates';
import { getSectorById } from './sectorTemplates';

// ─── Build AnalysisSpec from LLM intent with profile ───

export interface ProfiledAnalysisConfig {
  spec: AnalysisSpec;
  dynamicCriteria: DynamicOsmCriterion[];
  siteProfile: SiteProfile;
  searchRadiusM: number;
  sector: SectorTemplate; // fallback sector template (used if dynamicCriteria empty)
  useDynamicCriteria: boolean;
}

export function buildProfiledConfig(intent: LLMIntent, validatedSectorId: string | null): ProfiledAnalysisConfig {
  const hasDynamicCriteria = intent.osmCriteria && intent.osmCriteria.length >= 3;
  // Fallback to 'logistics' (neutral industrial template) — NEVER default to 'cafe'
  const sectorId = validatedSectorId || resolveSectorId(intent.sector) || 'logistics';
  const sector = getSectorById(sectorId);

  // Profile-derived search radius (prefer LLM's recommendation)
  const searchRadiusM = intent.siteProfile?.searchRadiusM
    ? Math.min(20_000, Math.max(500, intent.siteProfile.searchRadiusM))
    : sector.searchRadiusM;

  // Validate and normalize dynamic criteria
  const dynamicCriteria = hasDynamicCriteria
    ? normalizeDynamicCriteria(intent.osmCriteria)
    : [];

  // Build constraints from LLM-extracted criteria
  const constraints = buildConstraints(intent);

  // Build inferred weights
  const inferredWeights = hasDynamicCriteria
    ? buildDynamicWeights(dynamicCriteria, intent)
    : buildTemplateWeights(sector, intent);

  // Build positive/negative criteria lists
  const positiveCriteria = intent.positiveCriteria?.map(c => c.name) || [];
  const negativeCriteria = intent.negativeCriteria?.map(c => c.name) || [];

  // Result count
  const resultCount = Math.min(5, Math.max(1, intent.requestedResultCount || 3));

  // Build parsing notes
  const notes: string[] = [];
  const profileLabel = intent.siteProfile?.profileSummary || intent.useCaseSummary;
  notes.push(`[AI Profile] ${profileLabel}`);
  notes.push(`Detected: ${intent.businessType} / ${intent.sector}${intent.brand ? ` (${intent.brand})` : ''} — Confidence: ${intent.confidence}`);

  if (intent.siteProfile) {
    const p = intent.siteProfile;
    notes.push(`Profile: ${p.marketPositioning} positioning, ${p.urbanPreference} preference, ${p.accessProfile} access, search radius ${(searchRadiusM / 1000).toFixed(1)}km`);
  }

  if (hasDynamicCriteria) {
    notes.push(`${dynamicCriteria.length} criteria dynamically generated for this specific request.`);
  } else {
    notes.push(`Using ${sector.label} template (${sector.criteria.length} criteria) as fallback.`);
  }

  if (constraints.length > 0) {
    notes.push(`${constraints.length} spatial constraint(s) extracted.`);
  }

  if (intent.ambiguities && intent.ambiguities.length > 0) {
    notes.push(`Ambiguities: ${intent.ambiguities.join('; ')}`);
  }

  // Normalize city name
  let city = intent.locationName || '';
  if (city.toLowerCase() === 'bangalore') city = 'Bengaluru';
  if (city.toLowerCase() === 'gurgaon') city = 'Gurugram';
  // Preserve "Delhi NCR" as-is so DEFAULT_NEIGHBORHOODS['delhi ncr'] matches
  if (/delhi\s*ncr/i.test(city)) city = 'Delhi NCR';
  else if (/\bncr\b/i.test(city)) city = 'Delhi NCR';

  const spec: AnalysisSpec = {
    businessType: intent.businessType,
    sectorId,
    geography: {
      city,
      anchor: intent.coordinates || undefined,
      neighborhoods: intent.neighborhoods?.length ? intent.neighborhoods : undefined,
    },
    constraints,
    userPointConstraints: [],
    hasUserPointReference: intent.uploadedDataReference,
    positiveCriteria,
    negativeCriteria,
    inferredWeights,
    resultCount,
    parsingNotes: notes,
    confidence: intent.confidence,
    classificationMeta: {
      confidence: intent.confidence,
      matchedKeywords: [],
      reasoning: intent.reasoningSummary || '',
      score: intent.confidence === 'high' ? 10 : intent.confidence === 'medium' ? 5 : 2,
      source: 'llm' as const,
    },
  };

  return {
    spec,
    dynamicCriteria,
    siteProfile: intent.siteProfile || getDefaultProfile(),
    searchRadiusM,
    sector,
    useDynamicCriteria: hasDynamicCriteria,
  };
}

// ─── Normalize and validate dynamic criteria ───

function normalizeDynamicCriteria(criteria: DynamicOsmCriterion[]): DynamicOsmCriterion[] {
  const normalized: DynamicOsmCriterion[] = [];

  for (const c of criteria) {
    // Validate required fields
    if (!c.name || !c.osmTags || c.osmTags.length === 0) continue;
    if (!c.direction || !['positive', 'negative'].includes(c.direction)) continue;

    // Normalize weight
    const weight = Math.min(0.40, Math.max(0.05, c.weight || 0.15));

    // Validate scoring thresholds (need 5 numbers)
    const thresholds = Array.isArray(c.scoringThresholds) && c.scoringThresholds.length === 5
      ? c.scoringThresholds
      : [0, 3, 8, 15, 25]; // safe default

    // Validate OSM tags format (key=value)
    const validTags = c.osmTags.filter(t => t.includes('='));

    if (validTags.length === 0) continue;

    normalized.push({
      name: c.name,
      osmTags: validTags,
      queryBothNodeAndWay: c.queryBothNodeAndWay !== false,
      direction: c.direction,
      weight,
      scoringThresholds: thresholds,
      description: c.description || '',
    });
  }

  // Normalize weights to sum to ~1.0
  const totalWeight = normalized.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight > 0 && Math.abs(totalWeight - 1.0) > 0.1) {
    for (const c of normalized) {
      c.weight = Math.round((c.weight / totalWeight) * 100) / 100;
    }
  }

  return normalized;
}

// ─── Build constraints from intent ───

const CONSTRAINT_OSM_MAP: Record<string, string[]> = {
  substation: ['power=substation'],
  substations: ['power=substation'],
  'power infrastructure': ['power=substation', 'power=line', 'power=tower'],
  highway: ['highway=trunk', 'highway=motorway', 'highway=primary'],
  road: ['highway=primary', 'highway=secondary', 'highway=tertiary'],
  transit: ['public_transport=station', 'highway=bus_stop', 'railway=station'],
  metro: ['railway=station', 'station=subway'],
  school: ['amenity=school'],
  hospital: ['amenity=hospital'],
  park: ['leisure=park'],
  settlement: ['building=residential', 'building=apartments', 'landuse=residential'],
  settlements: ['building=residential', 'building=apartments', 'landuse=residential'],
  residential: ['building=residential', 'building=apartments', 'landuse=residential'],
  industrial: ['landuse=industrial', 'building=industrial'],
  water: ['natural=water', 'waterway=river'],
  'city center': ['amenity=town_hall', 'place=city'],
  'flood zone': [],
  'agricultural land': ['landuse=farmland'],
  competitor: [],
  competitors: [],
};

function resolveOsmTags(target: string): string[] {
  const lower = target.toLowerCase().trim();
  if (CONSTRAINT_OSM_MAP[lower]) return CONSTRAINT_OSM_MAP[lower];
  for (const [key, tags] of Object.entries(CONSTRAINT_OSM_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return tags;
  }
  return [];
}

function buildConstraints(intent: LLMIntent): SpatialConstraint[] {
  const constraints: SpatialConstraint[] = [];

  if (intent.radiusConstraints) {
    for (const rc of intent.radiusConstraints) {
      constraints.push({
        type: rc.direction === 'away' ? 'exclusion' : 'proximity',
        target: rc.target,
        osmTags: resolveOsmTags(rc.target),
        distanceM: rc.distanceM,
        direction: rc.direction,
        hardRule: rc.direction === 'away',
        label: `${rc.direction === 'away' ? 'Not within' : 'Within'} ${(rc.distanceM / 1000).toFixed(1)}km of ${rc.target}`,
      });
    }
  }

  for (const exc of intent.exclusionCriteria) {
    if (intent.radiusConstraints?.some(rc => rc.target.toLowerCase() === exc.name.toLowerCase())) continue;
    constraints.push({
      type: 'exclusion',
      target: exc.name,
      osmTags: resolveOsmTags(exc.name),
      distanceM: exc.distanceM || undefined,
      direction: 'away',
      hardRule: true,
      label: exc.distanceM
        ? `Not within ${(exc.distanceM / 1000).toFixed(1)}km of ${exc.name}`
        : `Exclude: ${exc.name}`,
    });
  }

  return constraints;
}

// ─── Build weights ───

function buildDynamicWeights(criteria: DynamicOsmCriterion[], intent: LLMIntent): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const c of criteria) {
    weights[c.name] = c.weight;
  }

  // Apply user priority adjustments
  for (const pc of intent.positiveCriteria || []) {
    const match = criteria.find(c =>
      c.name.toLowerCase().includes(pc.name.toLowerCase()) ||
      pc.name.toLowerCase().includes(c.name.toLowerCase()),
    );
    if (match && pc.priority === 'high') {
      weights[match.name] = Math.min(0.40, (weights[match.name] || 0.15) + 0.05);
    }
  }

  return weights;
}

function buildTemplateWeights(sector: SectorTemplate, intent: LLMIntent): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const c of sector.criteria) {
    weights[c.name] = c.defaultWeight;
  }

  for (const pc of intent.positiveCriteria || []) {
    const match = sector.criteria.find(c =>
      c.name.toLowerCase().includes(pc.name.toLowerCase()) ||
      pc.name.toLowerCase().includes(c.name.toLowerCase()),
    );
    if (match && pc.priority === 'high') {
      weights[match.name] = Math.min(0.40, (weights[match.name] || 0.15) + 0.10);
    }
  }

  return weights;
}

// ─── Convert dynamic criteria to sector-template-compatible format ───

export function dynamicCriteriaToTemplate(
  dynamicCriteria: DynamicOsmCriterion[],
  searchRadiusM: number,
  businessType: string,
): SectorTemplate {
  const criteria: CriterionTemplate[] = dynamicCriteria.map(c => ({
    name: c.name,
    direction: c.direction,
    defaultWeight: c.weight,
    osmSignalKey: c.name.toLowerCase().replace(/[\s/]+/g, '_'),
    osmQuery: {
      tags: c.osmTags,
      queryBothNodeAndWay: c.queryBothNodeAndWay,
    } as OsmQueryDef,
    scoringThresholds: c.scoringThresholds,
    evidenceBasis: 'osm-observed' as const,
    description: c.description,
  }));

  return {
    id: 'dynamic',
    label: businessType,
    icon: '📍',
    keywords: [],
    searchRadiusM,
    criteria,
    competitorTags: dynamicCriteria
      .filter(c => c.direction === 'negative' && c.name.toLowerCase().includes('compet'))
      .flatMap(c => c.osmTags),
  };
}

// ─── Default profile (fallback) ───

function getDefaultProfile(): SiteProfile {
  return {
    marketPositioning: 'unknown',
    landIntensity: 'low',
    urbanPreference: 'flexible',
    infrastructureDependency: 'low',
    footTrafficDependency: 'medium',
    competitionSensitivity: 'avoid_competition',
    accessProfile: 'mixed',
    environmentalSensitivity: 'medium',
    searchRadiusM: 1500,
    profileSummary: 'General site suitability analysis.',
  };
}
