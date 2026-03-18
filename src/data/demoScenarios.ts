import type { DemoScenario, AnalysisSpec } from '../types';

const defaultSpec: AnalysisSpec = {
  businessType: '',
  sectorId: '',
  geography: { city: '' },
  constraints: [],
  userPointConstraints: [],
  hasUserPointReference: false,
  positiveCriteria: [],
  negativeCriteria: [],
  inferredWeights: {},
  resultCount: 3,
  parsingNotes: ['Demo scenario — pre-built data for illustration.'],
  confidence: 'high',
};

export const demoScenarios: DemoScenario[] = [
  {
    id: 'cafe-bengaluru',
    businessType: 'Cafe',
    city: 'Bengaluru',
    label: 'Cafe in Bengaluru',
    description: 'Screening candidate areas for a cafe in Bengaluru using OSM-derived signals.',
    icon: '☕',
    result: {
      summary: 'Screened 3 candidate areas in Bengaluru for Cafe using 5 scoring criteria. Koramangala ranks highest at 7.4/10 with strong commercial activity and transit access. Indiranagar follows at 7.0/10. All scores derived from OSM spatial data. This is a screening-level assessment.',
      business_type: 'Cafe',
      target_location: 'Bengaluru',
      methodology: 'Dynamic MCDA using 5 sector-specific criteria scored from OpenStreetMap data within 1.0km radius. Criteria include competitor density (negative), transit access, commercial activity, residential presence, and amenity ecosystem (positive). All scores are deterministic and evidence-backed.',
      spec: { ...defaultSpec, businessType: 'Cafe', sectorId: 'cafe', geography: { city: 'Bengaluru' } },
      locations: [
        {
          name: 'Koramangala',
          lat: 12.9352,
          lng: 77.6245,
          mcda_score: 7.4,
          excluded: false,
          exclusions: [],
          searchRadiusM: 1000,
          osmSignals: { competitors: 18, transit: 8, commercial: 35, residential: 22, amenities: 12 },
          reasoning: 'Koramangala shows strong signals in commercial activity (35 features, score 7/10) and transit access (8 features, score 7/10) within 1.0km. Note: competitor density is high (18 found), which may indicate saturation.',
          pois: [
            { lat: 12.9350, lng: 77.6240, name: 'Third Wave Coffee', type: 'competitors' },
            { lat: 12.9355, lng: 77.6250, name: 'Starbucks Forum Mall', type: 'competitors' },
            { lat: 12.9348, lng: 77.6230, type: 'transit' },
            { lat: 12.9360, lng: 77.6255, type: 'commercial' },
            { lat: 12.9345, lng: 77.6260, type: 'commercial' },
          ],
          criteria_breakdown: [
            { name: 'Competitor Density', weight: 0.20, score: 4, rawValue: 18, direction: 'negative', justification: '18 competitor density features observed within 1.0km via OSM. (inverted — lower count = higher score)', evidenceBasis: 'osm-observed' },
            { name: 'Transit Access', weight: 0.20, score: 7, rawValue: 8, direction: 'positive', justification: '8 transit access features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Commercial Activity', weight: 0.20, score: 7, rawValue: 35, direction: 'positive', justification: '35 commercial activity features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Residential Presence', weight: 0.20, score: 6, rawValue: 22, direction: 'positive', justification: '22 residential presence features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Amenity Ecosystem', weight: 0.20, score: 8, rawValue: 12, direction: 'positive', justification: '12 amenity ecosystem features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
          ],
        },
        {
          name: 'Indiranagar',
          lat: 12.9784,
          lng: 77.6408,
          mcda_score: 7.0,
          excluded: false,
          exclusions: [],
          searchRadiusM: 1000,
          osmSignals: { competitors: 14, transit: 6, commercial: 28, residential: 18, amenities: 10 },
          reasoning: 'Indiranagar shows strong signals in commercial activity (28 features, score 5/10) and amenity ecosystem (10 features, score 8/10) within 1.0km. Moderate competitor density (14 found).',
          pois: [
            { lat: 12.9780, lng: 77.6405, type: 'competitors' },
            { lat: 12.9790, lng: 77.6410, type: 'transit' },
            { lat: 12.9785, lng: 77.6415, type: 'commercial' },
          ],
          criteria_breakdown: [
            { name: 'Competitor Density', weight: 0.20, score: 5, rawValue: 14, direction: 'negative', justification: '14 competitor density features observed within 1.0km via OSM. (inverted — lower count = higher score)', evidenceBasis: 'osm-observed' },
            { name: 'Transit Access', weight: 0.20, score: 7, rawValue: 6, direction: 'positive', justification: '6 transit access features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Commercial Activity', weight: 0.20, score: 5, rawValue: 28, direction: 'positive', justification: '28 commercial activity features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Residential Presence', weight: 0.20, score: 6, rawValue: 18, direction: 'positive', justification: '18 residential presence features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Amenity Ecosystem', weight: 0.20, score: 8, rawValue: 10, direction: 'positive', justification: '10 amenity ecosystem features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
          ],
        },
        {
          name: 'HSR Layout',
          lat: 12.9116,
          lng: 77.6389,
          mcda_score: 7.6,
          excluded: false,
          exclusions: [],
          searchRadiusM: 1000,
          osmSignals: { competitors: 6, transit: 4, commercial: 18, residential: 30, amenities: 8 },
          reasoning: 'HSR Layout shows strong residential presence (30 features, score 8/10) and low competitor density (6 found, score 6/10) within 1.0km. Good opportunity for a neighborhood cafe.',
          pois: [
            { lat: 12.9120, lng: 77.6385, type: 'competitors' },
            { lat: 12.9118, lng: 77.6392, type: 'residential' },
            { lat: 12.9115, lng: 77.6395, type: 'commercial' },
          ],
          criteria_breakdown: [
            { name: 'Competitor Density', weight: 0.20, score: 6, rawValue: 6, direction: 'negative', justification: '6 competitor density features observed within 1.0km via OSM. (inverted — lower count = higher score)', evidenceBasis: 'osm-observed' },
            { name: 'Transit Access', weight: 0.20, score: 5, rawValue: 4, direction: 'positive', justification: '4 transit access features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Commercial Activity', weight: 0.20, score: 5, rawValue: 18, direction: 'positive', justification: '18 commercial activity features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Residential Presence', weight: 0.20, score: 8, rawValue: 30, direction: 'positive', justification: '30 residential presence features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Amenity Ecosystem', weight: 0.20, score: 7, rawValue: 8, direction: 'positive', justification: '8 amenity ecosystem features observed within 1.0km via OSM.', evidenceBasis: 'osm-observed' },
          ],
        },
      ],
      grounding_sources: [
        { title: 'OpenStreetMap / Overpass API', uri: 'https://overpass-api.de/', retrievedAt: '2025-01-15T00:00:00Z', reliability: 'Varies by region — community-maintained' },
        { title: 'Nominatim Geocoding', uri: 'https://nominatim.openstreetmap.org/', retrievedAt: '2025-01-15T00:00:00Z', reliability: 'Based on OSM address data' },
      ],
    },
  },
  {
    id: 'ev-delhi',
    businessType: 'EV Charging',
    city: 'Delhi',
    label: 'EV Charging in Delhi',
    description: 'Screening candidate areas for EV charging stations along Delhi transport corridors.',
    icon: '⚡',
    result: {
      summary: 'Screened 3 candidate areas in Delhi for EV Charging using 5 scoring criteria. Dwarka ranks highest at 7.8/10 with strong highway access and low existing charger density. Connaught Place follows at 6.6/10. All scores derived from OSM spatial data.',
      business_type: 'EV Charging',
      target_location: 'Delhi',
      methodology: 'Dynamic MCDA using 5 sector-specific criteria scored from OpenStreetMap data within 2.0km radius. Criteria include existing chargers (negative), highway access, commercial zones, parking infrastructure, and residential base (positive).',
      spec: { ...defaultSpec, businessType: 'EV Charging', sectorId: 'ev', geography: { city: 'Delhi' } },
      locations: [
        {
          name: 'Dwarka',
          lat: 28.5921,
          lng: 77.0460,
          mcda_score: 7.8,
          excluded: false,
          exclusions: [],
          searchRadiusM: 2000,
          osmSignals: { competitors: 1, highways: 5, commercial: 20, parking: 6, residential: 35 },
          reasoning: 'Dwarka shows strong signals in residential base (35 features, score 7/10) and low existing chargers (1 found, score 7/10) within 2.0km. Good highway access with 5 major road segments.',
          pois: [
            { lat: 28.5925, lng: 77.0465, type: 'competitors' },
            { lat: 28.5930, lng: 77.0470, type: 'highways' },
            { lat: 28.5915, lng: 77.0455, type: 'parking' },
          ],
          criteria_breakdown: [
            { name: 'Existing Chargers', weight: 0.25, score: 7, rawValue: 1, direction: 'negative', justification: '1 existing chargers features observed within 2.0km via OSM. (inverted — lower count = higher score)', evidenceBasis: 'osm-observed' },
            { name: 'Highway Access', weight: 0.25, score: 7, rawValue: 5, direction: 'positive', justification: '5 highway access features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Commercial Zones', weight: 0.20, score: 5, rawValue: 20, direction: 'positive', justification: '20 commercial zones features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Parking Infrastructure', weight: 0.15, score: 8, rawValue: 6, direction: 'positive', justification: '6 parking infrastructure features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Residential Base', weight: 0.15, score: 7, rawValue: 35, direction: 'positive', justification: '35 residential base features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
          ],
        },
        {
          name: 'Connaught Place',
          lat: 28.6315,
          lng: 77.2167,
          mcda_score: 6.6,
          excluded: false,
          exclusions: [],
          searchRadiusM: 2000,
          osmSignals: { competitors: 4, highways: 3, commercial: 45, parking: 8, residential: 10 },
          reasoning: 'Connaught Place shows high commercial activity (45 features) and good parking (8 facilities), but 4 existing chargers reduce the infrastructure gap score.',
          pois: [
            { lat: 28.6320, lng: 77.2170, type: 'commercial' },
            { lat: 28.6310, lng: 77.2160, type: 'parking' },
          ],
          criteria_breakdown: [
            { name: 'Existing Chargers', weight: 0.25, score: 4, rawValue: 4, direction: 'negative', justification: '4 existing chargers features observed within 2.0km via OSM. (inverted — lower count = higher score)', evidenceBasis: 'osm-observed' },
            { name: 'Highway Access', weight: 0.25, score: 5, rawValue: 3, direction: 'positive', justification: '3 highway access features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Commercial Zones', weight: 0.20, score: 8, rawValue: 45, direction: 'positive', justification: '45 commercial zones features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Parking Infrastructure', weight: 0.15, score: 9, rawValue: 8, direction: 'positive', justification: '8 parking infrastructure features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Residential Base', weight: 0.15, score: 3, rawValue: 10, direction: 'positive', justification: '10 residential base features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
          ],
        },
        {
          name: 'Saket',
          lat: 28.5245,
          lng: 77.2066,
          mcda_score: 7.2,
          excluded: false,
          exclusions: [],
          searchRadiusM: 2000,
          osmSignals: { competitors: 2, highways: 4, commercial: 30, parking: 5, residential: 25 },
          reasoning: 'Saket shows balanced signals across criteria with only 2 existing chargers and good highway connectivity. Moderate commercial and residential presence.',
          pois: [
            { lat: 28.5250, lng: 77.2070, type: 'commercial' },
            { lat: 28.5240, lng: 77.2060, type: 'highways' },
          ],
          criteria_breakdown: [
            { name: 'Existing Chargers', weight: 0.25, score: 7, rawValue: 2, direction: 'negative', justification: '2 existing chargers features observed within 2.0km via OSM. (inverted — lower count = higher score)', evidenceBasis: 'osm-observed' },
            { name: 'Highway Access', weight: 0.25, score: 7, rawValue: 4, direction: 'positive', justification: '4 highway access features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Commercial Zones', weight: 0.20, score: 7, rawValue: 30, direction: 'positive', justification: '30 commercial zones features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Parking Infrastructure', weight: 0.15, score: 7, rawValue: 5, direction: 'positive', justification: '5 parking infrastructure features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
            { name: 'Residential Base', weight: 0.15, score: 6, rawValue: 25, direction: 'positive', justification: '25 residential base features observed within 2.0km via OSM.', evidenceBasis: 'osm-observed' },
          ],
        },
      ],
      grounding_sources: [
        { title: 'OpenStreetMap / Overpass API', uri: 'https://overpass-api.de/', retrievedAt: '2025-01-15T00:00:00Z', reliability: 'Varies by region — community-maintained' },
        { title: 'Nominatim Geocoding', uri: 'https://nominatim.openstreetmap.org/', retrievedAt: '2025-01-15T00:00:00Z', reliability: 'Based on OSM address data' },
      ],
    },
  },
];

// ─── Lookup ───

export function findDemoScenario(businessType: string, city: string): DemoScenario | undefined {
  const bt = businessType.toLowerCase();
  const ct = city.toLowerCase();

  // Exact match on both
  const exact = demoScenarios.find(s =>
    s.businessType.toLowerCase() === bt && s.city.toLowerCase() === ct
  );
  if (exact) return exact;

  // Partial match on business type + city
  return demoScenarios.find(s =>
    (bt.includes(s.businessType.toLowerCase()) || s.businessType.toLowerCase().includes(bt)) &&
    (ct.includes(s.city.toLowerCase()) || s.city.toLowerCase().includes(ct))
  );
}

export function getDefaultDemoScenario(): DemoScenario {
  return demoScenarios[0];
}
