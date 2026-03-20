/**
 * OSM Service — Context-aware Overpass and Nominatim queries.
 *
 * Improvements over previous version:
 * - Queries both nodes AND ways for relevant features
 * - Uses sector-specific tag bundles from templates
 * - Supports constraint-derived additional queries
 * - Configurable search radius per sector
 * - Deduplicates POIs
 * - Better coordinate validation
 */

import type { POI, SpatialConstraint } from '../types';
import type { SectorTemplate } from './sectorTemplates';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

// ─── Types ───

export interface GeocodedLocation {
  lat: number;
  lng: number;
  display_name: string;
}

export interface OsmSignals {
  [key: string]: number;
}

export interface OsmResult {
  signals: OsmSignals;
  pois: POI[];
}

// ─── Geocoding ───

export async function geocodeLocation(query: string): Promise<GeocodedLocation | null> {
  try {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1', addressdetails: '1' });
    const response = await fetch(`${NOMINATIM_BASE_URL}?${params.toString()}`, {
      headers: { 'User-Agent': 'Stratageo-SiteSuitability/1.0' },
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (data && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (!isValidCoord(lat, lng)) return null;
      return { lat, lng, display_name: data[0].display_name };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Reverse geocoding ───

export interface ReverseGeocodeResult {
  locality: string;
  city: string;
  state: string;
  country: string;
  display_name: string;
}

const reverseGeocodeCache = new Map<string, ReverseGeocodeResult | null>();

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseGeocodeCache.has(cacheKey)) return reverseGeocodeCache.get(cacheKey) ?? null;

  try {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lon: lng.toString(),
      format: 'json',
      zoom: '14',
      addressdetails: '1',
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
      headers: { 'User-Agent': 'Stratageo-SiteSuitability/1.0' },
    });
    if (!response.ok) {
      reverseGeocodeCache.set(cacheKey, null);
      return null;
    }

    const data = await response.json();
    if (!data || data.error) {
      reverseGeocodeCache.set(cacheKey, null);
      return null;
    }

    const addr = data.address || {};
    const result: ReverseGeocodeResult = {
      locality: addr.suburb || addr.neighbourhood || addr.village || addr.town || '',
      city: addr.city || addr.town || addr.county || '',
      state: addr.state || '',
      country: addr.country || '',
      display_name: data.display_name || '',
    };

    reverseGeocodeCache.set(cacheKey, result);
    return result;
  } catch {
    reverseGeocodeCache.set(cacheKey, null);
    return null;
  }
}

function isValidCoord(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ─── Overpass retry logic ───

async function fetchWithOverpassRetry(query: string): Promise<any> {
  let lastError: Error | null = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        if (response.status === 429) { await new Promise(r => setTimeout(r, 1000)); continue; }
        throw new Error(`Overpass API: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error as Error;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastError || new Error('All Overpass endpoints failed');
}

// ─── Build Overpass query from sector template ───

function buildOverpassQuery(
  lat: number,
  lng: number,
  radiusM: number,
  sector: SectorTemplate,
  constraints: SpatialConstraint[],
): string {
  const parts: string[] = [];
  const addedTags = new Set<string>();

  for (const criterion of sector.criteria) {
    for (const tag of criterion.osmQuery.tags) {
      if (addedTags.has(tag)) continue;
      addedTags.add(tag);

      const isWildcard = tag.includes('=*');
      const [key, value] = tag.split('=');

      if (isWildcard) {
        parts.push(`node["${key}"](around:${radiusM},${lat},${lng});`);
        if (criterion.osmQuery.queryBothNodeAndWay) {
          parts.push(`way["${key}"](around:${radiusM},${lat},${lng});`);
        }
      } else {
        parts.push(`node["${key}"="${value}"](around:${radiusM},${lat},${lng});`);
        if (criterion.osmQuery.queryBothNodeAndWay) {
          parts.push(`way["${key}"="${value}"](around:${radiusM},${lat},${lng});`);
        }
      }
    }
  }

  // Add constraint-specific queries
  for (const constraint of constraints) {
    for (const tag of constraint.osmTags) {
      if (addedTags.has(tag)) continue;
      addedTags.add(tag);

      const isWildcard = tag.includes('=*');
      const [key, value] = tag.split('=');
      const r = constraint.distanceM || radiusM;

      if (isWildcard) {
        parts.push(`node["${key}"](around:${r},${lat},${lng});`);
        parts.push(`way["${key}"](around:${r},${lat},${lng});`);
      } else {
        parts.push(`node["${key}"="${value}"](around:${r},${lat},${lng});`);
        parts.push(`way["${key}"="${value}"](around:${r},${lat},${lng});`);
      }
    }
  }

  return `
    [out:json][timeout:30];
    (
      ${parts.join('\n      ')}
    );
    out center;
  `;
}

// ─── Classify OSM elements into signals ───

function classifyElement(
  tags: Record<string, string>,
  sector: SectorTemplate,
  constraints: SpatialConstraint[],
): { signalKeys: string[]; poiType: string } {
  const signalKeys: string[] = [];
  let poiType = 'other';

  for (const criterion of sector.criteria) {
    for (const tagDef of criterion.osmQuery.tags) {
      const isWildcard = tagDef.includes('=*');
      const [key, value] = tagDef.split('=');

      if (isWildcard ? tags[key] : tags[key] === value) {
        if (!signalKeys.includes(criterion.osmSignalKey)) {
          signalKeys.push(criterion.osmSignalKey);
        }
        if (poiType === 'other') poiType = criterion.osmSignalKey;
        break;
      }
    }
  }

  for (const constraint of constraints) {
    for (const tagDef of constraint.osmTags) {
      const isWildcard = tagDef.includes('=*');
      const [key, value] = tagDef.split('=');
      if (isWildcard ? tags[key] : tags[key] === value) {
        const constraintKey = constraint.target.toLowerCase().replace(/\s+/g, '_');
        if (!signalKeys.includes(constraintKey)) {
          signalKeys.push(constraintKey);
        }
        if (poiType === 'other') poiType = constraintKey;
      }
    }
  }

  return { signalKeys, poiType };
}

// ─── Main data fetch ───

export async function fetchOSMData(
  lat: number,
  lng: number,
  sector: SectorTemplate,
  constraints: SpatialConstraint[] = [],
  overrideRadiusM?: number,
): Promise<OsmResult> {
  const radiusM = overrideRadiusM || sector.searchRadiusM;
  const query = buildOverpassQuery(lat, lng, radiusM, sector, constraints);
  const data = await fetchWithOverpassRetry(query);
  const elements = data.elements || [];

  const signals: OsmSignals = {};
  const pois: POI[] = [];
  const seenIds = new Set<number>();

  for (const el of elements) {
    if (el.id && seenIds.has(el.id)) continue;
    if (el.id) seenIds.add(el.id);

    const tags = el.tags || {};
    const elLat = parseFloat(el.lat ?? el.center?.lat);
    const elLng = parseFloat(el.lon ?? el.center?.lon);
    const hasValidCoords = isValidCoord(elLat, elLng);

    const { signalKeys, poiType } = classifyElement(tags, sector, constraints);

    for (const key of signalKeys) {
      signals[key] = (signals[key] || 0) + 1;
    }

    if (hasValidCoords && poiType !== 'other') {
      pois.push({
        lat: elLat,
        lng: elLng,
        name: tags.name,
        type: poiType,
      });
    }
  }

  return { signals, pois };
}
