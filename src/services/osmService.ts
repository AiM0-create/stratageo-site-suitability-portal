import type { POI } from '../types';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

export interface OSMData {
  competitors: number;
  transport: number;
  commercial_density: number;
  residential_density: number;
  pois: POI[];
}

export interface GeocodedLocation {
  lat: number;
  lng: number;
  display_name: string;
}

export async function geocodeLocation(query: string): Promise<GeocodedLocation | null> {
  try {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1', addressdetails: '1' });
    const response = await fetch(`${NOMINATIM_BASE_URL}?${params.toString()}`);
    if (!response.ok) return null;

    const data = await response.json();
    if (data && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, display_name: data[0].display_name };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchWithOverpassRetry(query: string): Promise<any> {
  let lastError: Error | null = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        if (response.status === 429) continue;
        throw new Error(`Overpass API failed: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error as Error;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastError || new Error('All Overpass endpoints failed');
}

export async function fetchOSMData(lat: number, lng: number, competitorTags: string[]): Promise<OSMData> {
  const radius = 1000;

  const competitorQuery = competitorTags.map(tag => {
    const [key, value] = tag.split('=');
    return `node["${key}"="${value}"](around:${radius},${lat},${lng});`;
  }).join('\n');

  const query = `
    [out:json][timeout:30];
    (
      ${competitorQuery}
      node["public_transport"](around:${radius},${lat},${lng});
      node["highway"="bus_stop"](around:${radius},${lat},${lng});
      node["railway"="station"](around:${radius},${lat},${lng});
      node["shop"](around:${radius},${lat},${lng});
      node["office"](around:${radius},${lat},${lng});
      node["amenity"="restaurant"](around:${radius},${lat},${lng});
      node["amenity"="bank"](around:${radius},${lat},${lng});
      node["building"="apartments"](around:${radius},${lat},${lng});
      node["building"="residential"](around:${radius},${lat},${lng});
      way["building"="apartments"](around:${radius},${lat},${lng});
      way["building"="residential"](around:${radius},${lat},${lng});
    );
    out center;
  `;

  const data = await fetchWithOverpassRetry(query);
  const elements = data.elements || [];

  let competitors = 0, transport = 0, commercial = 0, residential = 0;
  const pois: POI[] = [];

  for (const el of elements) {
    const tags = el.tags || {};
    let rawLat = el.lat ?? el.center?.lat;
    let rawLng = el.lon ?? el.center?.lon;
    const elLat = parseFloat(rawLat);
    const elLng = parseFloat(rawLng);
    const hasValidCoords = Number.isFinite(elLat) && Number.isFinite(elLng);
    const name = tags.name;

    const isCompetitor = competitorTags.some(tag => {
      const [k, v] = tag.split('=');
      return tags[k] === v;
    });

    if (isCompetitor) {
      competitors++;
      if (hasValidCoords) pois.push({ lat: elLat, lng: elLng, name, type: 'competitor' });
    } else if (tags.public_transport || tags.highway === 'bus_stop' || tags.railway === 'station') {
      transport++;
      if (hasValidCoords) pois.push({ lat: elLat, lng: elLng, name, type: 'transport' });
    } else if (tags.shop || tags.office || tags.amenity === 'restaurant' || tags.amenity === 'bank') {
      commercial++;
      if (hasValidCoords) pois.push({ lat: elLat, lng: elLng, name, type: 'commercial' });
    } else if (tags.building === 'apartments' || tags.building === 'residential') {
      residential++;
    }
  }

  return { competitors, transport, commercial_density: commercial, residential_density: residential, pois };
}
