
import { LocationData, POI } from '../types';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter',
    'https://overpass.osm.ch/api/interpreter'
];

export interface OSMData {
    competitors: number;
    transport: number;
    commercial_density: number;
    residential_density: number;
    pois: POI[];
}

export const geocodeLocation = async (query: string): Promise<{ lat: number; lng: number; display_name: string } | null> => {
    try {
        const params = new URLSearchParams({
            q: query,
            format: 'json',
            limit: '1',
            addressdetails: '1'
        });

        const response = await fetch(`${NOMINATIM_BASE_URL}?${params.toString()}`);
        if (!response.ok) throw new Error('Geocoding failed');
        
        const data = await response.json();
        if (data && data.length > 0) {
            const lat = parseFloat(data[0].lat);
            const lng = parseFloat(data[0].lon);
            
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                console.warn('Geocoding returned invalid coordinates:', data[0]);
                return null;
            }

            return {
                lat,
                lng,
                display_name: data[0].display_name
            };
        }
        return null;
    } catch (error) {
        console.error('Error geocoding location:', error);
        return null;
    }
};

const fetchWithRetry = async (query: string): Promise<any> => {
    let lastError;
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            console.log(`Trying Overpass endpoint: ${endpoint}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 50000); // 50s fetch timeout (slightly more than query timeout)

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: 'data=' + encodeURIComponent(query),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 429) {
                    console.warn(`Rate limited by ${endpoint}, trying next...`);
                    continue; // Try next endpoint immediately
                }
                throw new Error(`Overpass API failed with status ${response.status}`);
            }

            const data = await response.json();
            return data; // Success!

        } catch (error) {
            console.warn(`Failed to fetch from ${endpoint}:`, error);
            lastError = error;
            // Wait a bit before trying the next endpoint to be polite
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    throw lastError || new Error('All Overpass endpoints failed');
};

export const fetchOSMData = async (lat: number, lng: number, competitorTags: string[], businessType: string): Promise<OSMData> => {
    // Construct Overpass QL query
    // We'll search in a 1km radius (1000m)
    const radius = 1000;
    
    // Helper to format tags for Overpass: ["amenity"="cafe"]
    // competitorTags might be ["amenity=cafe", "shop=coffee"]
    const competitorQuery = competitorTags.map(tag => {
        const [key, value] = tag.split('=');
        return `node["${key}"="${value}"](around:${radius},${lat},${lng});`;
    }).join('\n');

    const query = `
        [out:json][timeout:30];
        (
            // Competitors
            ${competitorQuery}
            
            // Public Transport (bus stops, subway, train)
            node["public_transport"](around:${radius},${lat},${lng});
            node["highway"="bus_stop"](around:${radius},${lat},${lng});
            node["railway"="station"](around:${radius},${lat},${lng});
            node["station"](around:${radius},${lat},${lng});

            // Commercial Density (shops, offices - proxy for footfall)
            node["shop"](around:${radius},${lat},${lng});
            node["office"](around:${radius},${lat},${lng});
            node["amenity"="restaurant"](around:${radius},${lat},${lng});
            node["amenity"="bank"](around:${radius},${lat},${lng});

            // Residential Density (apartments, houses - proxy for demographics)
            node["building"="apartments"](around:${radius},${lat},${lng});
            node["building"="residential"](around:${radius},${lat},${lng});
            way["building"="apartments"](around:${radius},${lat},${lng});
            way["building"="residential"](around:${radius},${lat},${lng});
        );
        out center;
    `;

    try {
        const data = await fetchWithRetry(query);
        const elements = data.elements || [];

        // Process results
        let competitors = 0;
        let transport = 0;
        let commercial = 0;
        let residential = 0;
        const pois: POI[] = [];

        elements.forEach((el: any) => {
            const tags = el.tags || {};
            
            // Safer coordinate extraction
            let rawLat = el.lat;
            let rawLng = el.lon;
            
            if (rawLat === undefined && el.center) {
                rawLat = el.center.lat;
                rawLng = el.center.lon;
            }
            
            const lat = parseFloat(rawLat);
            const lng = parseFloat(rawLng);
            const name = tags.name;
            
            const hasValidCoords = Number.isFinite(lat) && Number.isFinite(lng);
            
            // Check Competitors
            const isCompetitor = competitorTags.some(tag => {
                const [k, v] = tag.split('=');
                return tags[k] === v;
            });

            if (isCompetitor) {
                competitors++;
                if (hasValidCoords) pois.push({ lat, lng, name, type: 'competitor' });
            } else if (tags.public_transport || tags.highway === 'bus_stop' || tags.railway === 'station' || tags.station) {
                transport++;
                if (hasValidCoords) pois.push({ lat, lng, name, type: 'transport' });
            } else if (tags.shop || tags.office || tags.amenity === 'restaurant' || tags.amenity === 'bank') {
                commercial++;
                if (hasValidCoords) pois.push({ lat, lng, name, type: 'commercial' });
            } else if (tags.building === 'apartments' || tags.building === 'residential') {
                residential++;
                if (hasValidCoords) pois.push({ lat, lng, name, type: 'residential' });
            }
        });

        return {
            competitors,
            transport,
            commercial_density: commercial,
            residential_density: residential,
            pois
        };

    } catch (error) {
        console.error('Error fetching OSM data:', error);
        throw new Error('Failed to fetch OpenStreetMap data');
    }
};
