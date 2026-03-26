/**
 * Google Places Service — Fetches POI data via the /api/places proxy.
 * Falls back to OSM (Overpass) if Places API fails.
 */

import type { POI } from '../types';
import type { SectorTemplate } from './sectorTemplates';
import type { SpatialConstraint } from '../types';
import { config } from '../config';
import { fetchOSMData, type OsmResult, type OsmSignals } from './osmService';

// ─── Sector-to-Places type mapping ───
// Maps our MCDA criteria signal keys to Google Places API types
const SIGNAL_TO_PLACES_TYPES: Record<string, string[]> = {
  // Cafe/Restaurant
  restaurants: ['restaurant', 'cafe', 'bakery'],
  cafes: ['cafe', 'coffee_shop'],
  foot_traffic: ['shopping_mall', 'transit_station', 'tourist_attraction'],

  // Retail
  shopping: ['shopping_mall', 'department_store', 'clothing_store'],
  competitors: ['store', 'shopping_mall'],

  // Healthcare
  hospitals: ['hospital', 'doctor'],
  pharmacies: ['pharmacy'],
  clinics: ['hospital', 'doctor', 'physiotherapist'],

  // Education
  schools: ['school', 'primary_school', 'secondary_school'],
  parks: ['park', 'playground'],

  // EV
  fuel_stations: ['gas_station', 'electric_vehicle_charging_station'],
  parking: ['parking'],
  ev_charging: ['electric_vehicle_charging_station'],

  // Logistics
  industrial: ['industrial_area'],
  highways: [],  // Places doesn't cover roads — OSM fallback

  // Coworking
  offices: ['office'],
  transit: ['transit_station', 'subway_station', 'bus_station'],

  // Real estate
  residential: [],  // Places doesn't cover residential density — OSM fallback

  // Solar/Energy
  power_infrastructure: [],  // OSM only

  // Common
  bus_stops: ['bus_station', 'transit_station'],
  train_stations: ['train_station', 'transit_station'],
  banks: ['bank', 'atm'],
  entertainment: ['movie_theater', 'amusement_center', 'night_club'],
};

interface PlacesAPIResponse {
  results: Record<string, {
    count: number;
    places: Array<{
      name: string;
      lat: number;
      lng: number;
      types: string[];
      rating: number | null;
      ratingCount: number;
      priceLevel: string | null;
    }>;
  }>;
  source: string;
}

/**
 * Fetch POI data using Google Places API with OSM fallback.
 * Returns the same OsmResult shape for compatibility with the scoring pipeline.
 */
export async function fetchPlacesData(
  lat: number,
  lng: number,
  sector: SectorTemplate,
  constraints: SpatialConstraint[] = [],
  overrideRadiusM?: number,
): Promise<OsmResult> {
  const radiusM = overrideRadiusM || sector.searchRadiusM;

  // Determine which Places types to query based on sector criteria
  const typesToQuery = new Set<string>();
  const signalToTypesMap = new Map<string, string[]>();

  for (const criterion of sector.criteria) {
    const signalKey = criterion.osmSignalKey;
    const placesTypes = SIGNAL_TO_PLACES_TYPES[signalKey] || [];
    if (placesTypes.length > 0) {
      signalToTypesMap.set(signalKey, placesTypes);
      placesTypes.forEach(t => typesToQuery.add(t));
    }
  }

  // If no Places-compatible types, fall back to OSM entirely
  if (typesToQuery.size === 0) {
    return fetchOSMData(lat, lng, sector, constraints, overrideRadiusM);
  }

  try {
    const backendUrl = config.aiBackendUrl || '';
    const response = await fetch(`${backendUrl}/api/places`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat,
        lng,
        radius: radiusM,
        types: Array.from(typesToQuery),
      }),
    });

    if (!response.ok) {
      console.warn('Places API returned error, falling back to OSM');
      return fetchOSMData(lat, lng, sector, constraints, overrideRadiusM);
    }

    const data: PlacesAPIResponse = await response.json();

    // Convert Places results into OsmSignals + POI format
    const signals: OsmSignals = {};
    const pois: POI[] = [];
    const seenNames = new Set<string>();

    // Map Places results back to our signal keys
    for (const [signalKey, placesTypes] of signalToTypesMap.entries()) {
      let count = 0;
      for (const pt of placesTypes) {
        const typeResult = data.results[pt];
        if (typeResult) {
          count += typeResult.count;
          for (const place of typeResult.places) {
            const key = `${place.name}-${place.lat}-${place.lng}`;
            if (!seenNames.has(key) && place.lat && place.lng) {
              seenNames.add(key);
              pois.push({
                lat: place.lat,
                lng: place.lng,
                name: place.name,
                type: signalKey,
              });
            }
          }
        }
      }
      signals[signalKey] = count;
    }

    // For criteria without Places mapping, fetch from OSM
    const unmappedCriteria = sector.criteria.filter(
      c => !(SIGNAL_TO_PLACES_TYPES[c.osmSignalKey]?.length > 0)
    );

    if (unmappedCriteria.length > 0 || constraints.length > 0) {
      try {
        const osmFallback = await fetchOSMData(lat, lng, sector, constraints, overrideRadiusM);
        // Merge OSM signals for unmapped criteria only
        for (const criterion of unmappedCriteria) {
          const key = criterion.osmSignalKey;
          if (osmFallback.signals[key] !== undefined && signals[key] === undefined) {
            signals[key] = osmFallback.signals[key];
          }
        }
        // Merge constraint-related signals
        for (const constraint of constraints) {
          const constraintKey = constraint.target.toLowerCase().replace(/\s+/g, '_');
          if (osmFallback.signals[constraintKey] !== undefined) {
            signals[constraintKey] = osmFallback.signals[constraintKey];
          }
        }
        // Add any OSM POIs for unmapped types
        for (const poi of osmFallback.pois) {
          const key = `${poi.name}-${poi.lat}-${poi.lng}`;
          if (!seenNames.has(key)) {
            seenNames.add(key);
            pois.push(poi);
          }
        }
      } catch (osmErr) {
        console.warn('OSM supplementary fetch also failed:', osmErr);
      }
    }

    return { signals, pois };
  } catch (err) {
    console.warn('Places API failed entirely, falling back to OSM:', err);
    return fetchOSMData(lat, lng, sector, constraints, overrideRadiusM);
  }
}
