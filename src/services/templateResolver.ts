/**
 * Template Resolver — Maps LLM intent → sector template + AnalysisSpec.
 *
 * Bridges Stage A (LLM intent) and Stage B (deterministic analysis)
 * by converting the LLM's structured understanding into the AnalysisSpec
 * that the MCDA pipeline expects.
 */

import type { AnalysisSpec, SpatialConstraint } from '../types';
import type { LLMIntent } from './intentSchema';
import { resolveSectorId } from './intentSchema';
import { getSectorById, type SectorTemplate } from './sectorTemplates';

// ─── Feature-to-OSM-tag mapping for LLM-extracted constraints ───

const CONSTRAINT_OSM_MAP: Record<string, string[]> = {
  substation: ['power=substation'],
  substations: ['power=substation'],
  'power infrastructure': ['power=substation', 'power=line', 'power=tower'],
  'transmission line': ['power=line'],
  'power line': ['power=line'],
  highway: ['highway=trunk', 'highway=motorway', 'highway=primary'],
  road: ['highway=primary', 'highway=secondary', 'highway=tertiary'],
  transit: ['public_transport=station', 'highway=bus_stop', 'railway=station'],
  metro: ['railway=station', 'station=subway'],
  railway: ['railway=station'],
  school: ['amenity=school'],
  hospital: ['amenity=hospital'],
  clinic: ['amenity=clinic', 'amenity=hospital'],
  park: ['leisure=park'],
  settlement: ['building=residential', 'building=apartments', 'landuse=residential'],
  settlements: ['building=residential', 'building=apartments', 'landuse=residential'],
  residential: ['building=residential', 'building=apartments', 'landuse=residential'],
  'residential area': ['building=residential', 'building=apartments', 'landuse=residential'],
  industrial: ['landuse=industrial', 'building=industrial'],
  'industrial zone': ['landuse=industrial'],
  water: ['natural=water', 'waterway=river'],
  'water body': ['natural=water', 'waterway=river'],
  'city center': ['amenity=town_hall', 'place=city'],
  'flood zone': [],
  'flood-prone': [],
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

// ─── Priority → weight adjustment ───

function priorityWeightDelta(priority: 'high' | 'medium' | 'low'): number {
  switch (priority) {
    case 'high': return 0.10;
    case 'medium': return 0;
    case 'low': return -0.05;
  }
}

// ─── Main resolver ───

export function resolveTemplate(
  intent: LLMIntent,
  resolvedSectorId: string | null,
): { sector: SectorTemplate; spec: AnalysisSpec } {
  // Determine sector template
  const sectorId = resolvedSectorId || resolveSectorId(intent.sector) || 'cafe';
  const sector = getSectorById(sectorId);

  // Build constraints from LLM-extracted criteria
  const constraints: SpatialConstraint[] = [];

  // Radius constraints → SpatialConstraint
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

  // Exclusion criteria → SpatialConstraint (hard rules)
  for (const exc of intent.exclusionCriteria) {
    // Avoid duplicating radius constraints already added
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

  // Build inferred weights from LLM priority signals
  const inferredWeights: Record<string, number> = {};
  for (const c of sector.criteria) {
    inferredWeights[c.name] = c.defaultWeight;
  }

  // Adjust weights based on positive/negative criteria priorities
  for (const pc of intent.positiveCriteria) {
    const matchingCriterion = sector.criteria.find(c =>
      c.name.toLowerCase().includes(pc.name.toLowerCase()) ||
      pc.name.toLowerCase().includes(c.name.toLowerCase()),
    );
    if (matchingCriterion) {
      const delta = priorityWeightDelta(pc.priority);
      inferredWeights[matchingCriterion.name] = Math.min(0.40, Math.max(0.05,
        (inferredWeights[matchingCriterion.name] || 0.15) + delta,
      ));
    }
  }

  for (const nc of intent.negativeCriteria) {
    const matchingCriterion = sector.criteria.find(c =>
      c.name.toLowerCase().includes(nc.name.toLowerCase()) ||
      nc.name.toLowerCase().includes(c.name.toLowerCase()),
    );
    if (matchingCriterion) {
      const delta = priorityWeightDelta(nc.priority);
      inferredWeights[matchingCriterion.name] = Math.min(0.40, Math.max(0.05,
        (inferredWeights[matchingCriterion.name] || 0.15) + delta,
      ));
    }
  }

  // Build positive/negative criteria lists for spec
  const positiveCriteria = intent.positiveCriteria.map(c => c.name);
  const negativeCriteria = intent.negativeCriteria.map(c => c.name);

  // Result count
  const resultCount = Math.min(5, Math.max(1, intent.requestedResultCount || 3));

  // Build parsing notes
  const notes: string[] = [];
  notes.push(`[AI Intent] ${intent.reasoningSummary || intent.useCaseSummary}`);
  notes.push(`Detected: ${intent.businessType} / ${intent.sector} (Confidence: ${intent.confidence})`);
  if (constraints.length > 0) {
    notes.push(`${constraints.length} constraint(s) extracted from prompt.`);
  }
  if (intent.ambiguities && intent.ambiguities.length > 0) {
    notes.push(`Ambiguities: ${intent.ambiguities.join('; ')}`);
  }

  // Normalize city name
  let city = intent.locationName || '';
  if (city.toLowerCase() === 'bangalore') city = 'Bengaluru';
  if (city.toLowerCase() === 'gurgaon') city = 'Gurugram';

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

  return { sector, spec };
}
