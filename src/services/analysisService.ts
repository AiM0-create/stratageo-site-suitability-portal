import type { AnalysisRequest, AnalysisResult, AnalysisStatus, LocationData } from '../types';
import { config } from '../config';
import { geocodeLocation, fetchOSMData } from './osmService';
import { scoreNeighborhood, computeMCDAScore, inferFootfall, generateTemplateReasoning, generateTemplateStrategy } from './scoringEngine';
import { fetchAIExplanation, fetchAIIntent } from './aiClient';
import { findDemoScenario, getDefaultDemoScenario } from '../data/demoScenarios';

const DEFAULT_NEIGHBORHOODS: Record<string, string[]> = {
  bengaluru: ['Koramangala', 'Indiranagar', 'HSR Layout', 'Whitefield'],
  mumbai: ['Powai', 'Andheri West', 'Bandra', 'Lower Parel'],
  delhi: ['Connaught Place', 'Dwarka', 'Hauz Khas', 'Saket'],
  hyderabad: ['Madhapur', 'Gachibowli', 'Banjara Hills', 'Jubilee Hills'],
  pune: ['Koregaon Park', 'Viman Nagar', 'Hinjewadi', 'Kothrud'],
  chennai: ['T. Nagar', 'Anna Nagar', 'Adyar', 'Velachery'],
};

function getNeighborhoodsForCity(city: string): string[] {
  const key = city.toLowerCase().trim();
  for (const [k, v] of Object.entries(DEFAULT_NEIGHBORHOODS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return ['City Center', 'North District', 'South District', 'East District'];
}

function getOSMTagsForSector(sectorId: string): string[] {
  const sector = config.sectors.find(s => s.id === sectorId);
  return sector ? [...sector.osmTags] : ['amenity=restaurant', 'shop=convenience'];
}

function findSectorByType(businessType: string): string {
  const bt = businessType.toLowerCase();
  for (const s of config.sectors) {
    if (bt.includes(s.id) || s.label.toLowerCase().includes(bt) || bt.includes(s.label.toLowerCase().split('/')[0].trim())) {
      return s.id;
    }
  }
  if (bt.includes('cafe') || bt.includes('coffee') || bt.includes('restaurant')) return 'cafe';
  if (bt.includes('school') || bt.includes('preschool') || bt.includes('education')) return 'preschool';
  if (bt.includes('retail') || bt.includes('store') || bt.includes('shop')) return 'retail';
  if (bt.includes('clinic') || bt.includes('health') || bt.includes('hospital')) return 'clinic';
  if (bt.includes('ev') || bt.includes('charging') || bt.includes('electric')) return 'ev';
  return 'cafe';
}

export async function runDemoAnalysis(
  request: AnalysisRequest,
  onStatus: (status: AnalysisStatus) => void
): Promise<AnalysisResult> {
  onStatus({ message: 'Loading demo scenario...', progress: 30 });

  await new Promise(r => setTimeout(r, 800));

  const scenario = findDemoScenario(request.businessType, request.city);

  onStatus({ message: 'Preparing results...', progress: 70 });
  await new Promise(r => setTimeout(r, 600));

  if (scenario) {
    onStatus({ message: 'Demo analysis complete', progress: 100 });
    return scenario.result;
  }

  // If no exact match, return the default with adjusted labels
  const fallback = getDefaultDemoScenario();
  onStatus({ message: 'Demo analysis complete', progress: 100 });
  return {
    ...fallback.result,
    business_type: request.businessType || fallback.result.business_type,
    target_location: request.city || fallback.result.target_location,
    summary: `This is a demo analysis for a ${request.businessType || 'business'} in ${request.city || 'a selected city'}. ` + fallback.result.summary,
  };
}

export async function runLiveAnalysis(
  request: AnalysisRequest,
  onStatus: (status: AnalysisStatus) => void
): Promise<AnalysisResult> {
  const { businessType, city } = request;
  const sectorId = findSectorByType(businessType);
  const osmTags = getOSMTagsForSector(sectorId);

  // Step 1: Try AI intent refinement, fall back to defaults
  onStatus({ message: 'Planning search strategy...', progress: 10 });
  let neighborhoods = getNeighborhoodsForCity(city);

  const aiIntent = await fetchAIIntent(`${businessType} in ${city}`);
  if (aiIntent?.neighborhoods?.length) {
    neighborhoods = aiIntent.neighborhoods.slice(0, 4);
  }

  // Step 2: Gather OSM data for each neighborhood
  const analyzedLocations: Array<{ name: string; lat: number; lng: number; osmData: any }> = [];

  for (let i = 0; i < neighborhoods.length; i++) {
    const neighborhood = neighborhoods[i];
    onStatus({ message: `Analyzing ${neighborhood}...`, progress: 20 + (i * 15) });

    const coords = await geocodeLocation(`${neighborhood}, ${city}`);
    if (!coords) continue;

    try {
      const osmData = await fetchOSMData(coords.lat, coords.lng, osmTags);
      analyzedLocations.push({
        name: coords.display_name.split(',')[0],
        lat: coords.lat,
        lng: coords.lng,
        osmData,
      });
    } catch {
      continue;
    }
  }

  if (analyzedLocations.length === 0) {
    throw new Error(`Could not gather data for any neighborhoods in ${city}. Try a different city or check your connection.`);
  }

  // Step 3: Deterministic scoring
  onStatus({ message: 'Scoring candidate locations...', progress: 75 });
  const locations: LocationData[] = analyzedLocations.map(loc => {
    const criteria = scoreNeighborhood(loc.osmData);
    const mcdaScore = computeMCDAScore(criteria);
    return {
      name: loc.name,
      lat: loc.lat,
      lng: loc.lng,
      reasoning: generateTemplateReasoning(loc.name, businessType, loc.osmData),
      footfall: inferFootfall(loc.osmData.commercial_density, loc.osmData.transport),
      demographics: `Based on ${loc.osmData.residential_density} residential buildings within 1km. Detailed demographics require additional data sources.`,
      marketing_radius_km: 2,
      marketing_strategy: generateTemplateStrategy(businessType, loc.osmData),
      public_transport: `${loc.osmData.transport} public transit stops identified within 1km radius.`,
      mcda_score: mcdaScore,
      criteria_breakdown: criteria,
      pois: loc.osmData.pois,
    };
  });

  // Sort by score descending
  locations.sort((a, b) => b.mcda_score - a.mcda_score);

  // Step 4: Optional AI enhancement
  onStatus({ message: 'Generating insights...', progress: 88 });
  let summary = generateTemplateSummary(businessType, city, locations);

  if (config.isLiveMode) {
    const aiResult = await fetchAIExplanation({
      businessType,
      city,
      locations: locations.map(loc => ({
        name: loc.name,
        mcda_score: loc.mcda_score,
        criteria_breakdown: loc.criteria_breakdown,
        osmCounts: {
          competitors: loc.criteria_breakdown.find(c => c.name === 'Competitive Landscape')?.score ?? 0,
          transport: loc.criteria_breakdown.find(c => c.name === 'Transit Accessibility')?.score ?? 0,
          commercial: loc.criteria_breakdown.find(c => c.name === 'Commercial Vibrancy')?.score ?? 0,
          residential: loc.criteria_breakdown.find(c => c.name === 'Residential Catchment')?.score ?? 0,
        },
      })),
    });

    if (aiResult) {
      summary = aiResult.summary;
      for (const insight of aiResult.locationInsights) {
        const loc = locations.find(l => l.name === insight.name);
        if (loc) {
          loc.reasoning = insight.reasoning;
          loc.marketing_strategy = insight.strategy;
        }
      }
    }
  }

  onStatus({ message: 'Analysis complete', progress: 100 });

  return {
    summary,
    business_type: businessType,
    target_location: city,
    methodology: 'Multi-Criteria Decision Analysis (MCDA) using OpenStreetMap infrastructure data. Scores are computed deterministically from real-world POI counts within a 1km radius of each candidate area, evaluating competitive landscape, transit accessibility, commercial vibrancy, residential catchment, pedestrian footfall potential, and complementary infrastructure.',
    locations,
    grounding_sources: [
      { title: 'OpenStreetMap Infrastructure Data', uri: 'https://www.openstreetmap.org/', retrievedAt: new Date().toISOString(), reliability: 'High (OSM Community Data)' },
      { title: 'Nominatim Geocoding Service', uri: 'https://nominatim.openstreetmap.org/', retrievedAt: new Date().toISOString(), reliability: 'High (OSM Geocoder)' },
    ],
  };
}

function generateTemplateSummary(businessType: string, city: string, locations: LocationData[]): string {
  if (locations.length === 0) return `No candidate locations could be analyzed for ${businessType} in ${city}.`;

  const top = locations[0];
  const parts = [
    `Analysis of ${locations.length} candidate areas in ${city} for a ${businessType} venture identifies ${top.name} as the top-ranked location with a suitability score of ${top.mcda_score}/10.`,
  ];

  if (locations.length > 1) {
    parts.push(`${locations[1].name} follows with a score of ${locations[1].mcda_score}/10.`);
  }

  parts.push(`Scores are derived from real-world OpenStreetMap data including competitor density, transit access, commercial activity, and residential catchment within a 1km radius of each candidate area.`);
  parts.push(`This is a screening-level assessment. For a comprehensive site suitability study with proprietary data layers, sector-specific criteria, and on-ground validation, contact Stratageo.`);

  return parts.join(' ');
}
