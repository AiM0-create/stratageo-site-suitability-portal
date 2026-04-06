/**
 * Geographic utilities for Stratageo backend analysis.
 *
 * Server-side port of the key functions from:
 *   src/services/osmService.ts  — geocoding + Overpass queries
 *   src/services/analysisService.ts — haversine, radius cap, candidate generation
 *
 * Geocoding provider priority:
 *   1. Google Geocoding API  (GOOGLE_PLACES_API_KEY — same Maps Platform key as places.js)
 *   2. Nominatim / OSM       (fallback, no key required)
 */

const NOMINATIM_UA = 'Stratageo-SiteSuitability/1.0';

// ─── Google Geocoding helpers (private) ──────────────────────────────────────

const GOOGLE_GEO_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Extract structured address components from a Google Geocoding result.
 */
function parseGoogleAddressComponents(components = []) {
  const get = (...types) => {
    const c = components.find(c => types.some(t => c.types?.includes(t)));
    return c?.long_name ?? '';
  };
  const getShort = (...types) => {
    const c = components.find(c => types.some(t => c.types?.includes(t)));
    return c?.short_name ?? '';
  };
  return {
    sublocality: get('sublocality_level_1', 'sublocality', 'neighborhood'),
    locality:    get('locality'),
    district:    get('administrative_area_level_3', 'administrative_area_level_2'),
    state:       get('administrative_area_level_1'),
    country:     get('country'),
    countryCode: getShort('country').toLowerCase(),
  };
}

/**
 * Forward-geocode via Google Geocoding API, restricted to India.
 * Returns the full debug envelope or null.
 */
async function googleGeocode(query) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const url =
      `${GOOGLE_GEO_BASE}` +
      `?address=${encodeURIComponent(query)}` +
      `&components=country:IN` +
      `&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) return null;

    const hit = data.results[0];
    const loc = hit.geometry?.location;
    if (!loc?.lat || !loc?.lng) return null;

    const addr = parseGoogleAddressComponents(hit.address_components);
    const isIndia = addr.countryCode === 'in' || addr.country.toLowerCase() === 'india';
    if (!isIndia) return null;

    return {
      lat: loc.lat,
      lng: loc.lng,
      display_name: hit.formatted_address,
      place_id: hit.place_id,
      location_type: hit.geometry?.location_type,
      addr,
    };
  } catch {
    return null;
  }
}

/**
 * Reverse-geocode via Google Geocoding API.
 * Returns structured locality fields or null.
 */
async function googleReverseGeocode(lat, lng) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const url =
      `${GOOGLE_GEO_BASE}` +
      `?latlng=${lat},${lng}` +
      `&result_type=sublocality|locality|administrative_area_level_2` +
      `&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) return null;

    const hit = data.results[0];
    const addr = parseGoogleAddressComponents(hit.address_components);
    return {
      locality:     addr.sublocality || addr.locality,
      city:         addr.locality || addr.district,
      state:        addr.state,
      country:      addr.country,
      display_name: hit.formatted_address,
      place_id:     hit.place_id,
    };
  } catch {
    return null;
  }
}

// ─── Nominatim helpers (private) ─────────────────────────────────────────────

/**
 * Forward-geocode via Nominatim, scoped to India.
 * Appends ", India" scope hint unless query already names a country/state.
 */
async function nominatimGeocode(query) {
  const INDIA_SUFFIX_RE = /\b(india|maharashtra|karnataka|delhi|rajasthan|gujarat|punjab|haryana|telangana|tamil\s*nadu|kerala|west\s*bengal|odisha|bihar|up|mp|goa)\b/i;
  const needsSuffix = !INDIA_SUFFIX_RE.test(query);
  const scopedQuery = needsSuffix ? `${query}, India` : query;

  async function attempt(q) {
    try {
      const url =
        `https://nominatim.openstreetmap.org/search` +
        `?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1&countrycodes=in`;
      const res = await fetch(url, {
        headers: { 'User-Agent': NOMINATIM_UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.length ? data[0] : null;
    } catch {
      return null;
    }
  }

  let hit = await attempt(scopedQuery);
  if (!hit && scopedQuery !== query) hit = await attempt(query);
  if (!hit) return null;

  const lat = parseFloat(hit.lat);
  const lng = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const cc = hit.address?.country_code ?? '';
  const country = hit.address?.country ?? '';
  const isIndia = cc === 'in' || country.toLowerCase().includes('india');
  if (!isIndia) return null;

  return {
    lat,
    lng,
    display_name: hit.display_name,
    addr: {
      sublocality: hit.address?.suburb || hit.address?.neighbourhood || '',
      locality:    hit.address?.city || hit.address?.town || '',
      state:       hit.address?.state || '',
      country,
      countryCode: cc,
    },
    place_id: null,
    location_type: null,
  };
}

/**
 * Reverse-geocode via Nominatim.
 */
async function nominatimReverseGeocode(lat, lng) {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat}&lon=${lng}&format=json&zoom=14&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.error) return null;
    const addr = data.address || {};
    return {
      locality:     addr.suburb || addr.neighbourhood || addr.village || addr.town || '',
      city:         addr.city || addr.town || addr.county || '',
      state:        addr.state || '',
      country:      addr.country || '',
      display_name: data.display_name || '',
      place_id:     null,
    };
  } catch {
    return null;
  }
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

// ─── Google Places density probe (private) ───────────────────────────────────

/**
 * Common place types used as an urban-activity density signal.
 * These exist in virtually all urban Indian localities and give a quick
 * sense of whether Google Maps has real POI coverage for the area.
 */
const DENSITY_PROBE_TYPES = ['restaurant', 'cafe', 'school', 'pharmacy', 'bank'];

/**
 * Fetch a lightweight Google Places density count for a location.
 * Runs 2 probe type queries in parallel (to limit latency) and returns
 * the total count found + per-type breakdown + source metadata.
 *
 * This is NOT used for per-criterion scoring — it is used solely as a
 * corroboration signal: "does Google see urban activity here at all?"
 *
 * Returns:
 *   { totalCount, breakdown, typesProbed, sourceUsed }
 *   or null if GOOGLE_PLACES_API_KEY is absent or all calls fail.
 */
export async function fetchGooglePlacesDensity(lat, lng, radiusM) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  const probeTypes = DENSITY_PROBE_TYPES.slice(0, 2); // 2 types to limit latency
  const radiusCapped = Math.min(radiusM, 5000);        // cap at 5km for density probe

  const results = await Promise.allSettled(
    probeTypes.map(async (type) => {
      const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.location',
        },
        body: JSON.stringify({
          includedTypes: [type],
          maxResultCount: 20,
          locationRestriction: {
            circle: {
              center: { latitude: lat, longitude: lng },
              radius: radiusCapped,
            },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { type, count: 0, failed: true };
      const data = await res.json();
      return { type, count: (data.places || []).length, failed: false };
    }),
  );

  const breakdown = {};
  let totalCount = 0;
  let probesFailed = 0;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      breakdown[r.value.type] = r.value.count;
      totalCount += r.value.count;
      if (r.value.failed) probesFailed++;
    } else {
      probesFailed++;
    }
  }

  return {
    totalCount,
    breakdown,
    typesProbed: probeTypes,
    probesFailed,
    sourceUsed: probesFailed === probeTypes.length ? 'failed' : 'google',
  };
}

// ─── Public geocoding API ─────────────────────────────────────────────────────
//
// Provider priority: Google (via GOOGLE_PLACES_API_KEY) → Nominatim fallback.
// Both public functions return the same shape so callers are unchanged.

/**
 * Forward-geocode a place name, restricted to India.
 *
 * Returns:
 *   { lat, lng, display_name,
 *     geocoderProviderUsed, geocodeQueryRaw, geocodeQueryNormalized,
 *     geocodeResultDisplayName, geocodePlaceId, geocodeCountry,
 *     geocodeValidationStatus, geocodeFallbackUsed, geocodeRejectionReason }
 *   or null if both providers fail.
 */
export async function geocodeLocation(query) {
  const INDIA_SUFFIX_RE = /\b(india|maharashtra|karnataka|delhi|rajasthan|gujarat|punjab|haryana|telangana|tamil\s*nadu|kerala|west\s*bengal|odisha|bihar|up|mp|goa)\b/i;
  const needsSuffix = !INDIA_SUFFIX_RE.test(query);
  const normalizedQuery = needsSuffix ? `${query}, India` : query;

  const debugBase = {
    geocodeQueryRaw:        query,
    geocodeQueryNormalized: normalizedQuery,
    geocodeFallbackUsed:    false,
    geocodeRejectionReason: null,
  };

  // ── Provider 1: Google ───────────────────────────────────────────────────
  const googleResult = await googleGeocode(normalizedQuery);
  if (googleResult) {
    return {
      lat:          googleResult.lat,
      lng:          googleResult.lng,
      display_name: googleResult.display_name,
      // Legacy fields (used by analyze.js geocodingNotes)
      geocode_query:   normalizedQuery,
      geocode_result:  googleResult.display_name?.slice(0, 80),
      geocode_country: googleResult.addr.country,
      validation_status: 'passed',
      // Debug fields
      ...debugBase,
      geocoderProviderUsed:    'google',
      geocodeResultDisplayName: googleResult.display_name,
      geocodePlaceId:           googleResult.place_id,
      geocodeCountry:           googleResult.addr.country,
      geocodeValidationStatus:  'passed',
      geocodeLocationType:      googleResult.location_type,
    };
  }

  // ── Provider 2: Nominatim fallback ───────────────────────────────────────
  const nominatimResult = await nominatimGeocode(query);
  if (nominatimResult) {
    return {
      lat:          nominatimResult.lat,
      lng:          nominatimResult.lng,
      display_name: nominatimResult.display_name,
      geocode_query:   normalizedQuery,
      geocode_result:  nominatimResult.display_name?.slice(0, 80),
      geocode_country: nominatimResult.addr.country,
      validation_status: 'passed',
      ...debugBase,
      geocoderProviderUsed:     'nominatim_fallback',
      geocodeResultDisplayName:  nominatimResult.display_name,
      geocodePlaceId:            null,
      geocodeCountry:            nominatimResult.addr.country,
      geocodeValidationStatus:   'passed',
      geocodeFallbackUsed:       true,
      geocodeLocationType:       null,
    };
  }

  // Both providers failed
  return null;
}

/**
 * Reverse-geocode lat/lng to locality/city fields.
 *
 * Returns:
 *   { locality, city, state, country, display_name,
 *     geocoderProviderUsed, geocodeFallbackUsed, geocodePlaceId }
 *   or null.
 */
export async function reverseGeocode(lat, lng) {
  // ── Provider 1: Google ───────────────────────────────────────────────────
  const googleResult = await googleReverseGeocode(lat, lng);
  if (googleResult) {
    return {
      ...googleResult,
      geocoderProviderUsed: 'google',
      geocodeFallbackUsed:  false,
    };
  }

  // ── Provider 2: Nominatim fallback ───────────────────────────────────────
  const nominatimResult = await nominatimReverseGeocode(lat, lng);
  if (nominatimResult) {
    return {
      ...nominatimResult,
      geocoderProviderUsed: 'nominatim_fallback',
      geocodeFallbackUsed:  true,
    };
  }

  return null;
}

// ─── Spatial math ───

/**
 * Haversine distance in meters between two WGS84 coordinates.
 */
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cap search radius to 60% of the minimum inter-candidate distance.
 * Prevents overlapping Overpass queries that produce identical signals.
 */
export function capSearchRadius(coords, requestedRadius, minRadius = 500) {
  if (coords.length < 2) return requestedRadius;
  let minDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 1; j < coords.length; j++) {
      const d = haversineM(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng);
      if (d < minDist) minDist = d;
    }
  }
  const maxSafe = Math.max(minRadius, Math.floor(minDist * 0.6));
  return Math.min(requestedRadius, maxSafe);
}

/**
 * Generate cardinal/diagonal candidate points around an anchor coordinate.
 */
export function generateCandidatePoints(anchorLat, anchorLng, searchRadiusM, count) {
  const points = [{ lat: anchorLat, lng: anchorLng, label: 'Anchor (center)' }];
  const offsetM = searchRadiusM * 1.5;
  const latDeg = offsetM / 111_320;
  const lngDeg = offsetM / (111_320 * Math.cos(anchorLat * Math.PI / 180));

  const dirs = [
    { label: 'North', dLat: latDeg, dLng: 0 },
    { label: 'South', dLat: -latDeg, dLng: 0 },
    { label: 'East', dLat: 0, dLng: lngDeg },
    { label: 'West', dLat: 0, dLng: -lngDeg },
    { label: 'NE', dLat: latDeg * 0.7, dLng: lngDeg * 0.7 },
    { label: 'SE', dLat: -latDeg * 0.7, dLng: lngDeg * 0.7 },
    { label: 'SW', dLat: -latDeg * 0.7, dLng: -lngDeg * 0.7 },
    { label: 'NW', dLat: latDeg * 0.7, dLng: -lngDeg * 0.7 },
  ];

  for (const dir of dirs) {
    if (points.length >= count + 2) break;
    points.push({ lat: anchorLat + dir.dLat, lng: anchorLng + dir.dLng, label: dir.label });
  }
  return points;
}

// ─── Default neighborhoods per city ───
// Static, deterministic lists. LLM suggestions may be appended but never
// replace these. Add cities here as coverage expands.

const DEFAULT_NEIGHBORHOODS = {
  // ── Tier 1 metros ─────────────────────────────────────────────────────────
  bengaluru: ['Koramangala', 'Indiranagar', 'HSR Layout', 'Whitefield', 'Jayanagar', 'Malleswaram', 'Hebbal', 'Electronic City'],
  bangalore: ['Koramangala', 'Indiranagar', 'HSR Layout', 'Whitefield', 'Jayanagar', 'Malleswaram', 'Hebbal', 'Electronic City'],
  mumbai: ['Andheri West', 'Bandra', 'Borivali', 'Kurla', 'Lower Parel', 'Malad West', 'Powai', 'Thane'],
  delhi: ['Connaught Place', 'Dwarka', 'Hauz Khas', 'Lajpat Nagar', 'Pitampura', 'Rohini', 'Saket', 'Vasant Kunj'],
  hyderabad: ['Banjara Hills', 'Gachibowli', 'Jubilee Hills', 'Kondapur', 'Kukatpally', 'Madhapur', 'Secunderabad', 'Uppal'],
  chennai: ['Adyar', 'Anna Nagar', 'Chromepet', 'Nungambakkam', 'OMR Chennai', 'Porur', 'T. Nagar', 'Velachery'],
  kolkata: ['Alipore', 'Ballygunge', 'Behala', 'Dum Dum', 'New Town', 'Park Street', 'Salt Lake', 'Tollygunge'],

  // ── Tier 2 cities ─────────────────────────────────────────────────────────
  pune: ['Aundh', 'Baner', 'Hadapsar', 'Hinjewadi', 'Kalyani Nagar', 'Koregaon Park', 'Kothrud', 'Viman Nagar'],
  nagpur: ['Civil Lines Nagpur', 'Dharampeth', 'Manish Nagar', 'MIDC Nagpur', 'Pratap Nagar Nagpur', 'Sadar Nagpur', 'Shankar Nagar', 'Sitabuldi'],
  ahmedabad: ['Bopal', 'Maninagar', 'Navrangpura', 'Prahlad Nagar', 'Satellite Ahmedabad', 'SG Highway', 'Thaltej', 'Vastrapur'],
  surat: ['Adajan', 'Athwa', 'Citylight Surat', 'Katargam', 'Pal Surat', 'Piplod', 'Rander', 'Vesu'],
  jaipur: ['Bapu Nagar Jaipur', 'C Scheme', 'Jagatpura', 'Malviya Nagar Jaipur', 'Mansarovar', 'Raja Park', 'Tonk Road Jaipur', 'Vaishali Nagar'],
  lucknow: ['Aliganj', 'Aminabad', 'Gomti Nagar', 'Hazratganj', 'Indira Nagar Lucknow', 'Mahanagar Lucknow', 'Rajajipuram', 'Vikas Nagar Lucknow'],
  kanpur: ['Civil Lines Kanpur', 'Govind Nagar', 'Kakadeo', 'Kidwai Nagar Kanpur', 'Swaroop Nagar Kanpur', 'Tilak Nagar Kanpur'],
  indore: ['Bhawarkuan', 'MG Road Indore', 'Palasia', 'Rajwada Indore', 'Rau', 'Scheme 54', 'Vijay Nagar Indore', 'Vijaynagar'],
  bhopal: ['Arera Colony', 'Hoshangabad Road', 'Kolar Road Bhopal', 'MP Nagar', 'New Market Bhopal', 'Shahpura Bhopal', 'Shivaji Nagar Bhopal', 'TT Nagar'],
  visakhapatnam: ['Dwaraka Nagar', 'Madhurawada', 'MVP Colony', 'Rushikonda', 'Siripuram', 'Steel Plant Area', 'Ukkunagaram', 'Waltair Uplands'],
  kochi: ['Edapally', 'Kakkanad', 'MG Road Kochi', 'Panampilly Nagar', 'Thevara', 'Thrippunithura', 'Vytilla', 'White Field Kochi'],
  coimbatore: ['Gandhipuram', 'Hopes College', 'Peelamedu', 'RS Puram', 'Saibaba Colony', 'Singanallur', 'Sowripalayam', 'Thudiyalur'],
  mysuru: ['Gokulam', 'Hebbal Mysuru', 'Jayalakshmipuram', 'Kuvempunagar', 'Nazarbad', 'Ramakrishnanagar', 'Vidyaranyapuram', 'Vijayanagar Mysuru'],
  mysore: ['Gokulam', 'Hebbal Mysuru', 'Jayalakshmipuram', 'Kuvempunagar', 'Nazarbad', 'Ramakrishnanagar', 'Vidyaranyapuram', 'Vijayanagar Mysuru'],
  vadodara: ['Alkapuri', 'Fatehgunj', 'Gorwa', 'Karelibaug', 'Manjalpur', 'Old Padra Road', 'Subhanpura', 'Waghodia Road'],
  agra: ['Civil Lines Agra', 'Kamla Nagar Agra', 'Sanjay Place', 'Shahganj', 'Taj Nagri Phase', 'Trans Yamuna Colony'],
  nashik: ['Canada Corner', 'Cidco Nashik', 'Gangapur Road', 'Nashik Road', 'Panchavati', 'Satpur', 'Tidke Colony', 'Trimbak Road'],

  // ── NCR satellites ────────────────────────────────────────────────────────
  gurgaon: ['Cyber City Gurgaon', 'DLF Phase 1', 'Golf Course Road Gurgaon', 'MG Road Gurgaon', 'Sector 14 Gurgaon', 'Sector 29 Gurgaon', 'Sector 56 Gurgaon', 'Sohna Road'],
  gurugram: ['Cyber City Gurgaon', 'DLF Phase 1', 'Golf Course Road Gurgaon', 'MG Road Gurgaon', 'Sector 14 Gurgaon', 'Sector 29 Gurgaon', 'Sector 56 Gurgaon', 'Sohna Road'],
  noida: ['Greater Noida West', 'Sector 137 Noida', 'Sector 18 Noida', 'Sector 44 Noida', 'Sector 62 Noida', 'Sector 76 Noida'],
  faridabad: ['NIT Faridabad', 'Old Faridabad', 'Sector 15 Faridabad', 'Sector 21 Faridabad', 'Surajkund'],
  chandigarh: ['Manimajra', 'Mohali Phase 7', 'Sector 17 Chandigarh', 'Sector 22 Chandigarh', 'Sector 35 Chandigarh', 'Sector 43 Chandigarh'],
  'delhi ncr': ['Connaught Place', 'Cyber City Gurgaon', 'Dwarka', 'Greater Noida West', 'Saket', 'Sector 18 Noida'],
  ncr: ['Connaught Place', 'Cyber City Gurgaon', 'Dwarka', 'Greater Noida West', 'Saket', 'Sector 18 Noida'],
};

/**
 * Returns the static neighborhood list for a city, or directional-offset
 * fallbacks for cities not yet in the list.
 */
export function getNeighborhoodsForCity(city, count) {
  const key = city.toLowerCase().trim();
  for (const [k, v] of Object.entries(DEFAULT_NEIGHBORHOODS)) {
    if (key.includes(k) || k.includes(key)) return v.slice(0, count);
  }
  // For unlisted cities, prefix with city name so geocoders find the right area
  return [
    `${city} City Center`,
    `${city} North`,
    `${city} South`,
    `${city} East`,
    `${city} West`,
  ].slice(0, count);
}

/**
 * Returns true if the city has a static predefined neighborhood list.
 * Used by analyze.js to decide candidateGenerationSource and neighborhoodStrategy.
 */
export function hasCityInDefaultList(city) {
  if (!city) return false;
  const key = city.toLowerCase().trim();
  for (const k of Object.keys(DEFAULT_NEIGHBORHOODS)) {
    if (key.includes(k) || k.includes(key)) return true;
  }
  return false;
}

// ─── Overpass API ───

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithOverpassRetry(query) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        if (res.status === 429) { await sleep(1000); continue; }
        throw new Error(`Overpass ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw lastError || new Error('All Overpass endpoints failed');
}

/**
 * Fetch OSM Overpass data for a list of criteria at a given location.
 *
 * criteriaList: Array of { signalKey, osmTags, queryBothNodeAndWay }
 *   Each element matching any of its osmTags will increment signals[signalKey].
 *
 * Returns { signals: Record<signalKey, count>, pois: Array<{lat,lng,name,type}> }
 */
export async function fetchOverpassData(criteriaList, lat, lng, radiusM) {
  const parts = [];
  const addedTags = new Set();

  for (const criterion of criteriaList) {
    for (const tag of criterion.osmTags) {
      if (addedTags.has(tag)) continue;
      addedTags.add(tag);

      const isWildcard = tag.includes('=*');
      const eqIdx = tag.indexOf('=');
      const key = tag.slice(0, eqIdx);
      const value = tag.slice(eqIdx + 1);

      if (isWildcard) {
        parts.push(`node["${key}"](around:${radiusM},${lat},${lng});`);
        if (criterion.queryBothNodeAndWay) {
          parts.push(`way["${key}"](around:${radiusM},${lat},${lng});`);
        }
      } else {
        parts.push(`node["${key}"="${value}"](around:${radiusM},${lat},${lng});`);
        if (criterion.queryBothNodeAndWay) {
          parts.push(`way["${key}"="${value}"](around:${radiusM},${lat},${lng});`);
        }
      }
    }
  }

  if (parts.length === 0) return { signals: {}, pois: [] };

  const query = `[out:json][timeout:25];\n(\n  ${parts.join('\n  ')}\n);\nout center;`;
  const data = await fetchWithOverpassRetry(query);
  const elements = data.elements || [];

  const signals = {};
  const pois = [];
  const seenIds = new Set();

  for (const el of elements) {
    if (el.id && seenIds.has(el.id)) continue;
    if (el.id) seenIds.add(el.id);

    const tags = el.tags || {};
    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;

    // Each element can match multiple criteria independently
    for (const criterion of criteriaList) {
      let matched = false;
      for (const osmTag of criterion.osmTags) {
        const isWildcard = osmTag.includes('=*');
        const eqIdx = osmTag.indexOf('=');
        const key = osmTag.slice(0, eqIdx);
        const value = osmTag.slice(eqIdx + 1);
        if (isWildcard ? !!tags[key] : tags[key] === value) {
          matched = true;
          break;
        }
      }
      if (matched) {
        signals[criterion.signalKey] = (signals[criterion.signalKey] || 0) + 1;
        if (elLat != null && elLng != null) {
          pois.push({
            lat: parseFloat(elLat),
            lng: parseFloat(elLng),
            name: tags.name || '',
            type: criterion.signalKey,
          });
        }
      }
    }
  }

  return { signals, pois };
}
