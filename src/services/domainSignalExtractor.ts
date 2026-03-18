/**
 * Domain Signal Extractor — Extracts sector-specific spatial signals from prompts.
 *
 * These signals feed into the MCDA constraint system as additional
 * domain-aware criteria that the generic constraint parser can't detect.
 */

import type { SpatialConstraint } from '../types';

// ─── Domain signal definitions ───

interface SignalPattern {
  pattern: RegExp;
  constraint: Omit<SpatialConstraint, 'label'>;
}

const DOMAIN_SIGNALS: Record<string, SignalPattern[]> = {
  solar: [
    {
      pattern: /\b(?:substation|grid\s+connection)\b/i,
      constraint: {
        type: 'preference',
        target: 'Power Substation',
        osmTags: ['power=substation'],
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\btransmission\s+line\b/i,
      constraint: {
        type: 'preference',
        target: 'Transmission Line',
        osmTags: ['power=line'],
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:slope|flat\s+land|terrain)\b/i,
      constraint: {
        type: 'preference',
        target: 'Flat Terrain',
        osmTags: [], // not directly queryable via OSM
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:settlement|habitation|village).*(?:away|distance|far)\b/i,
      constraint: {
        type: 'preference',
        target: 'Residential Area',
        osmTags: ['building=residential', 'landuse=residential'],
        direction: 'away',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:agricultural|farm\s*land|crop)\b/i,
      constraint: {
        type: 'preference',
        target: 'Agricultural Land',
        osmTags: ['landuse=farmland'],
        direction: 'near',
        hardRule: false,
      },
    },
  ],

  logistics: [
    {
      pattern: /\b(?:highway|expressway|motorway)\b/i,
      constraint: {
        type: 'preference',
        target: 'Highway',
        osmTags: ['highway=trunk', 'highway=motorway', 'highway=primary'],
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:railway|rail\s+siding|rail\s+line)\b/i,
      constraint: {
        type: 'preference',
        target: 'Railway',
        osmTags: ['railway=rail'],
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:port|harbor|harbour|dock)\b/i,
      constraint: {
        type: 'preference',
        target: 'Port',
        osmTags: ['industrial=port', 'harbour=*'],
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:airport|airstrip|cargo\s+terminal)\b/i,
      constraint: {
        type: 'preference',
        target: 'Airport',
        osmTags: ['aeroway=aerodrome'],
        direction: 'near',
        hardRule: false,
      },
    },
  ],

  ev: [
    {
      pattern: /\b(?:highway|expressway|national\s+highway)\b/i,
      constraint: {
        type: 'preference',
        target: 'Highway',
        osmTags: ['highway=trunk', 'highway=motorway'],
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:parking|rest\s+stop|rest\s+area)\b/i,
      constraint: {
        type: 'preference',
        target: 'Parking Area',
        osmTags: ['amenity=parking'],
        direction: 'near',
        hardRule: false,
      },
    },
  ],

  clinic: [
    {
      pattern: /\b(?:residential|families|patients)\b/i,
      constraint: {
        type: 'preference',
        target: 'Residential Area',
        osmTags: ['building=residential', 'building=apartments', 'landuse=residential'],
        direction: 'near',
        hardRule: false,
      },
    },
  ],

  preschool: [
    {
      pattern: /\b(?:residential|families|children|family)\b/i,
      constraint: {
        type: 'preference',
        target: 'Residential Area',
        osmTags: ['building=residential', 'building=apartments', 'landuse=residential'],
        direction: 'near',
        hardRule: false,
      },
    },
    {
      pattern: /\b(?:park|playground|open\s+space)\b/i,
      constraint: {
        type: 'preference',
        target: 'Parks',
        osmTags: ['leisure=park', 'leisure=playground'],
        direction: 'near',
        hardRule: false,
      },
    },
  ],
};

// ─── Extractor ───

/**
 * Extract domain-specific spatial signals from the prompt.
 * Returns constraints that should be merged with the standard constraint list,
 * avoiding duplicates.
 */
export function extractDomainSignals(
  text: string,
  sectorId: string,
  existingConstraints: SpatialConstraint[],
): SpatialConstraint[] {
  const patterns = DOMAIN_SIGNALS[sectorId];
  if (!patterns) return [];

  const results: SpatialConstraint[] = [];
  const existingTargets = new Set(existingConstraints.map(c => c.target.toLowerCase()));

  for (const signal of patterns) {
    if (!signal.pattern.test(text)) continue;

    // Skip if a constraint for this target already exists
    if (existingTargets.has(signal.constraint.target.toLowerCase())) continue;

    results.push({
      ...signal.constraint,
      label: `Domain signal: ${signal.constraint.target}`,
    });
  }

  return results;
}
