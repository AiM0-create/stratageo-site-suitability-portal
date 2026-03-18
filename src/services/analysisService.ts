/**
 * Analysis Service — Orchestrates the full analysis pipeline.
 *
 * Pipeline:
 * 1. Parse prompt → AnalysisSpec
 * 2. Resolve neighborhoods (AI intent or defaults)
 * 3. Geocode each neighborhood
 * 4. Fetch OSM data using sector-specific queries
 * 5. Score with dynamic MCDA (positive/negative/exclusions)
 * 6. Generate evidence-backed reasoning
 * 7. Optional AI explanation enhancement
 */

import type { AnalysisResult, AnalysisSpec, AnalysisStatus, LocationData, UserPoint, UserPointConstraint } from '../types';
import { config } from '../config';
import { parsePrompt, parseUserPointIntent } from './promptParser';
import { getSectorById } from './sectorTemplates';
import { geocodeLocation, fetchOSMData } from './osmService';
import { scoreNeighborhood, computeMCDAScore, checkExclusions, addUserPointCriteria, generateReasoning, generateSummary } from './mcdaEngine';
import { fetchAIExplanation, fetchAIIntent } from './aiClient';
import { findDemoScenario, getDefaultDemoScenario } from '../data/demoScenarios';
import { inferRadius } from './radiusInference';

// ─── Default neighborhoods by city ───

const DEFAULT_NEIGHBORHOODS: Record<string, string[]> = {
  bengaluru: ['Koramangala', 'Indiranagar', 'HSR Layout', 'Whitefield', 'Jayanagar'],
  mumbai: ['Powai', 'Andheri West', 'Bandra', 'Lower Parel', 'Malad West'],
  delhi: ['Connaught Place', 'Dwarka', 'Hauz Khas', 'Saket', 'Lajpat Nagar'],
  hyderabad: ['Madhapur', 'Gachibowli', 'Banjara Hills', 'Jubilee Hills', 'Kondapur'],
  pune: ['Koregaon Park', 'Viman Nagar', 'Hinjewadi', 'Kothrud', 'Baner'],
  chennai: ['T. Nagar', 'Anna Nagar', 'Adyar', 'Velachery', 'Nungambakkam'],
};

function getNeighborhoodsForCity(city: string, count: number): string[] {
  const key = city.toLowerCase().trim();
  for (const [k, v] of Object.entries(DEFAULT_NEIGHBORHOODS)) {
    if (key.includes(k) || k.includes(key)) return v.slice(0, count);
  }
  return ['City Center', 'North', 'South', 'East', 'West'].slice(0, count);
}

// ─── Demo analysis ───

export async function runDemoAnalysis(
  rawPrompt: string,
  onStatus: (status: AnalysisStatus) => void,
): Promise<{ result: AnalysisResult; spec: AnalysisSpec }> {
  const spec = parsePrompt(rawPrompt);

  onStatus({ message: 'Parsing your query...', progress: 20 });
  await new Promise(r => setTimeout(r, 400));

  onStatus({ message: 'Searching demo scenarios...', progress: 50 });
  await new Promise(r => setTimeout(r, 400));

  const scenario = findDemoScenario(spec.businessType, spec.geography.city);

  onStatus({ message: 'Preparing results...', progress: 80 });
  await new Promise(r => setTimeout(r, 300));

  if (scenario) {
    onStatus({ message: 'Demo analysis complete', progress: 100 });
    return { result: { ...scenario.result, spec }, spec };
  }

  const fallback = getDefaultDemoScenario();
  onStatus({ message: 'Demo analysis complete', progress: 100 });
  return {
    result: {
      ...fallback.result,
      business_type: spec.businessType || fallback.result.business_type,
      target_location: spec.geography.city || fallback.result.target_location,
      summary: `Demo analysis for ${spec.businessType || 'a business'} in ${spec.geography.city || 'a city'}. ${fallback.result.summary}`,
      spec,
    },
    spec,
  };
}

// ─── Live analysis ───

export async function runLiveAnalysis(
  rawPrompt: string,
  resultCount: number,
  onStatus: (status: AnalysisStatus) => void,
  userPoints?: UserPoint[],
): Promise<{ result: AnalysisResult; spec: AnalysisSpec }> {
  // Step 1: Parse prompt
  onStatus({ message: 'Understanding your query...', progress: 5 });
  const spec = parsePrompt(rawPrompt);
  spec.resultCount = Math.min(5, Math.max(1, resultCount));

  // Step 1b: Build user-point constraints if CSV data provided
  if (userPoints && userPoints.length > 0) {
    const intent = parseUserPointIntent(rawPrompt);
    const radiusInfo = intent.radiusM
      ? { radiusM: intent.radiusM, reason: `User specified ${(intent.radiusM / 1000).toFixed(1)}km radius.` }
      : inferRadius(spec.sectorId, spec.geography.city);

    const upc: UserPointConstraint = {
      points: userPoints,
      mode: intent.detected ? intent.mode : 'exclude',
      radiusM: radiusInfo.radiusM,
      radiusSource: intent.radiusM ? 'user' : 'inferred',
      label: `${userPoints.length} uploaded location(s)`,
    };
    spec.userPointConstraints = [upc];
    spec.parsingNotes.push(
      `CSV: ${userPoints.length} user points loaded. Mode: ${upc.mode}, radius: ${(upc.radiusM / 1000).toFixed(1)}km (${upc.radiusSource}). ${radiusInfo.reason}`,
    );
  }

  const sector = getSectorById(spec.sectorId);
  const { city } = spec.geography;

  if (!city) {
    throw new Error('Could not detect a target city from your prompt. Please specify a city (e.g., "Cafe in Bengaluru").');
  }

  // Step 2: Resolve neighborhoods
  onStatus({ message: 'Planning search strategy...', progress: 10 });

  let neighborhoods: string[];
  if (spec.geography.neighborhoods?.length) {
    neighborhoods = spec.geography.neighborhoods;
  } else {
    const aiIntent = await fetchAIIntent(`${spec.businessType} in ${city}`);
    neighborhoods = aiIntent?.neighborhoods?.length
      ? aiIntent.neighborhoods.slice(0, spec.resultCount + 2)
      : getNeighborhoodsForCity(city, spec.resultCount + 2);
  }

  // Step 3: Gather OSM data for each neighborhood
  const analyzedLocations: LocationData[] = [];

  for (let i = 0; i < neighborhoods.length; i++) {
    const neighborhood = neighborhoods[i];
    onStatus({
      message: `Analyzing ${neighborhood}...`,
      progress: 15 + Math.round((i / neighborhoods.length) * 50),
    });

    const coords = await geocodeLocation(`${neighborhood}, ${city}`);
    if (!coords) {
      spec.parsingNotes.push(`Could not geocode "${neighborhood}" — skipped.`);
      continue;
    }

    try {
      const osmResult = await fetchOSMData(coords.lat, coords.lng, sector, spec.constraints);

      let criteria = scoreNeighborhood(osmResult.signals, sector, spec);

      // Add user-point-derived criteria (soft proximity scoring)
      if (spec.userPointConstraints.length > 0) {
        criteria = addUserPointCriteria(criteria, coords.lat, coords.lng, spec.userPointConstraints);
      }

      const mcdaScore = computeMCDAScore(criteria);
      const exclusions = checkExclusions(
        osmResult.signals, spec.constraints, sector.searchRadiusM,
        coords.lat, coords.lng, spec.userPointConstraints,
      );
      const excluded = exclusions.some(e => !e.passed);

      const reasoning = generateReasoning(
        coords.display_name.split(',')[0],
        criteria,
        exclusions,
        sector.searchRadiusM,
      );

      analyzedLocations.push({
        name: coords.display_name.split(',')[0],
        lat: coords.lat,
        lng: coords.lng,
        mcda_score: mcdaScore,
        criteria_breakdown: criteria,
        exclusions,
        excluded,
        reasoning,
        osmSignals: osmResult.signals,
        pois: osmResult.pois,
        searchRadiusM: sector.searchRadiusM,
      });
    } catch {
      spec.parsingNotes.push(`OSM data fetch failed for "${neighborhood}" — skipped.`);
      continue;
    }
  }

  if (analyzedLocations.length === 0) {
    throw new Error(`Could not gather data for any neighborhoods in ${city}. Try a different city or check your connection.`);
  }

  // Step 4: Sort and limit
  onStatus({ message: 'Ranking candidate locations...', progress: 70 });

  analyzedLocations.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.mcda_score - a.mcda_score;
  });

  const finalLocations = analyzedLocations.slice(0, spec.resultCount);

  // Step 4b: Feasibility check
  const nonExcludedCount = finalLocations.filter(l => !l.excluded).length;
  if (nonExcludedCount === 0 && spec.userPointConstraints.length > 0) {
    const upc = spec.userPointConstraints[0];
    const radiusKm = (upc.radiusM / 1000).toFixed(1);
    onStatus({ message: 'Analysis complete — no feasible locations found', progress: 100 });
    return {
      result: {
        summary: `No suitable locations found given current constraints. All ${analyzedLocations.length} candidate areas fall within the ${radiusKm}km ${upc.mode === 'exclude' ? 'exclusion' : 'inclusion'} zone of the ${upc.points.length} uploaded location(s). Try reducing the radius or relaxing constraints.`,
        business_type: spec.businessType,
        target_location: city,
        methodology: `Attempted to screen ${analyzedLocations.length} areas but all were excluded by user-supplied spatial constraints (${radiusKm}km ${upc.mode} buffer around ${upc.points.length} points).`,
        spec,
        locations: finalLocations, // still return them so user can see what was excluded
        grounding_sources: [
          { title: 'OpenStreetMap / Overpass API', uri: 'https://overpass-api.de/', retrievedAt: new Date().toISOString(), reliability: 'Varies by region' },
          { title: 'User-supplied CSV data', uri: 'user-upload', retrievedAt: new Date().toISOString(), reliability: 'User-provided' },
        ],
      },
      spec,
    };
  }

  if (nonExcludedCount < spec.resultCount && spec.userPointConstraints.length > 0) {
    spec.parsingNotes.push(
      `Only ${nonExcludedCount} of ${spec.resultCount} requested locations passed all constraints. Showing all available results.`,
    );
  }

  // Step 5: Optional AI enhancement
  onStatus({ message: 'Generating insights...', progress: 85 });

  let summary = generateSummary(spec.businessType, city, finalLocations, spec);

  if (config.isLiveMode) {
    const aiResult = await fetchAIExplanation({
      businessType: spec.businessType,
      city,
      locations: finalLocations.map(loc => ({
        name: loc.name,
        mcda_score: loc.mcda_score,
        criteria_breakdown: loc.criteria_breakdown.map(c => ({
          name: c.name,
          score: c.score,
          weight: c.weight,
          justification: c.justification,
        })),
        osmCounts: loc.osmSignals,
      })),
    });

    if (aiResult) {
      summary = aiResult.summary;
      for (const insight of aiResult.locationInsights) {
        const loc = finalLocations.find(l => l.name === insight.name);
        if (loc) {
          loc.reasoning = insight.reasoning;
        }
      }
    }
  }

  onStatus({ message: 'Analysis complete', progress: 100 });

  const radiusKm = (sector.searchRadiusM / 1000).toFixed(1);
  return {
    result: {
      summary,
      business_type: spec.businessType,
      target_location: city,
      methodology: `Dynamic MCDA using ${finalLocations[0]?.criteria_breakdown.length || 0} sector-specific criteria scored from OpenStreetMap data within ${radiusKm}km radius. Criteria include both positive and negative signals with direction-aware scoring. ${spec.constraints.length > 0 ? `${spec.constraints.length} spatial constraint(s) applied.` : ''} All scores are deterministic and evidence-backed.`,
      spec,
      locations: finalLocations,
      grounding_sources: [
        { title: 'OpenStreetMap / Overpass API', uri: 'https://overpass-api.de/', retrievedAt: new Date().toISOString(), reliability: 'Varies by region — community-maintained' },
        { title: 'Nominatim Geocoding', uri: 'https://nominatim.openstreetmap.org/', retrievedAt: new Date().toISOString(), reliability: 'Based on OSM address data' },
      ],
    },
    spec,
  };
}
