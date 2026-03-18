/**
 * Analysis Service — Orchestrates the full analysis pipeline.
 *
 * v3 Architecture (Profile-Based):
 *
 * Stage A — Universal Intent Understanding:
 *   1. LLM extracts structured intent with site-seeking profile + dynamic criteria
 *   2. Validate intent (geography, criteria, profile coherence)
 *   3. Build profiled config (dynamic criteria OR fallback to sector template)
 *   Fallback: local parsePrompt() if LLM unavailable
 *
 * Stage B — Deterministic Analysis:
 *   4. Resolve geography (reverse geocode if coordinate-anchored)
 *   5. Generate candidates (neighborhoods or coordinate offsets)
 *   6. Fetch OSM data using DYNAMIC criteria (not hardcoded templates)
 *   7. Score with MCDA
 *   8. Exclusion checks, ranking, feasibility validation
 *   9. Optional AI explanation enhancement
 */

import type { AnalysisResult, AnalysisSpec, AnalysisStatus, LocationData, UserPoint, UserPointConstraint } from '../types';
import { config } from '../config';
import { parsePrompt, parseUserPointIntent } from './promptParser';
import { extractIntent, getLastDiagnostics } from './llmIntentExtractor';
import { validateLLMIntent } from './intentValidator';
import { buildProfiledConfig, dynamicCriteriaToTemplate, type ProfiledAnalysisConfig } from './profileBuilder';
import { validateFeasibility } from './feasibilityValidator';
import { getSectorById } from './sectorTemplates';
import type { SectorTemplate } from './sectorTemplates';
import { geocodeLocation, fetchOSMData, reverseGeocode } from './osmService';
import { scoreNeighborhood, computeMCDAScore, checkExclusions, addUserPointCriteria, generateReasoning, generateSummary } from './mcdaEngine';
import { fetchAIExplanation } from './aiClient';
import { findDemoScenario, getDefaultDemoScenario } from '../data/demoScenarios';
import { inferRadius } from './radiusInference';
import type { SiteProfile } from './intentSchema';

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

// ─── Coordinate-based candidate generation ───

interface CandidatePoint {
  lat: number;
  lng: number;
  label: string;
}

function generateCandidatePoints(anchorLat: number, anchorLng: number, searchRadiusM: number, count: number): CandidatePoint[] {
  const points: CandidatePoint[] = [];
  points.push({ lat: anchorLat, lng: anchorLng, label: 'Anchor (center)' });

  const offsetM = searchRadiusM * 1.5;
  const latDeg = offsetM / 111_320;
  const lngDeg = offsetM / (111_320 * Math.cos(anchorLat * Math.PI / 180));

  const directions: Array<{ label: string; dLat: number; dLng: number }> = [
    { label: 'North', dLat: latDeg, dLng: 0 },
    { label: 'South', dLat: -latDeg, dLng: 0 },
    { label: 'East', dLat: 0, dLng: lngDeg },
    { label: 'West', dLat: 0, dLng: -lngDeg },
    { label: 'NE', dLat: latDeg * 0.7, dLng: lngDeg * 0.7 },
    { label: 'SE', dLat: -latDeg * 0.7, dLng: lngDeg * 0.7 },
    { label: 'SW', dLat: -latDeg * 0.7, dLng: -lngDeg * 0.7 },
    { label: 'NW', dLat: latDeg * 0.7, dLng: -lngDeg * 0.7 },
  ];

  for (const dir of directions) {
    if (points.length >= count + 2) break;
    points.push({
      lat: anchorLat + dir.dLat,
      lng: anchorLng + dir.dLng,
      label: dir.label,
    });
  }

  return points;
}

// ─── Default profile ───

const DEFAULT_PROFILE: SiteProfile = {
  marketPositioning: 'unknown',
  landIntensity: 'low',
  urbanPreference: 'flexible',
  infrastructureDependency: 'low',
  footTrafficDependency: 'medium',
  competitionSensitivity: 'avoid_competition',
  accessProfile: 'mixed',
  environmentalSensitivity: 'medium',
  searchRadiusM: 1500,
  profileSummary: 'General site suitability analysis.',
};

// ─── Stage A: Intent Understanding ───

interface IntentResult {
  spec: AnalysisSpec;
  effectiveSector: SectorTemplate;
  searchRadiusM: number;
  profile: SiteProfile;
}

async function extractAnalysisIntent(
  rawPrompt: string,
  onStatus: (status: AnalysisStatus) => void,
): Promise<IntentResult> {
  // In demo mode, skip LLM — use local parser
  if (config.isDemoMode) {
    console.log('[Stratageo] Demo mode — skipping GPT, using local parser.');
    const spec = parsePrompt(rawPrompt);
    spec.parsingNotes.unshift('[Demo Mode] GPT not used — running with local classifier and demo data.');
    const sector = getSectorById(spec.sectorId);
    return {
      spec,
      effectiveSector: sector,
      searchRadiusM: sector.searchRadiusM,
      profile: DEFAULT_PROFILE,
    };
  }

  // ─── LIVE MODE: GPT intent extraction is the primary path ───
  onStatus({ message: 'Understanding your query via GPT...', progress: 5 });
  console.log(`[Stratageo] Live mode active. Backend URL: ${config.aiBackendUrl}`);

  // Try GPT-first intent extraction (the extractIntent function is LOUD about failures)
  const intent = await extractIntent(rawPrompt);
  const diagnostics = getLastDiagnostics();

  if (intent) {
    const validation = validateLLMIntent(intent);

    if (validation.valid || validation.sectorId || validation.hasDynamicCriteria) {
      // GPT succeeded — build profiled config
      console.log(`[Stratageo] GPT SUCCESS: ${intent.businessType} / ${intent.sector} — using AI-generated profile`);
      const profiledConfig = buildProfiledConfig(intent, validation.sectorId);

      for (const w of validation.warnings) {
        profiledConfig.spec.parsingNotes.push(`[Validation] ${w}`);
      }

      const effectiveSector = profiledConfig.useDynamicCriteria
        ? dynamicCriteriaToTemplate(profiledConfig.dynamicCriteria, profiledConfig.searchRadiusM, intent.businessType)
        : profiledConfig.sector;

      return {
        spec: profiledConfig.spec,
        effectiveSector,
        searchRadiusM: profiledConfig.searchRadiusM,
        profile: profiledConfig.siteProfile,
      };
    }

    // GPT returned data but validation failed
    console.error(`[Stratageo] GPT returned data but validation FAILED:`, validation.errors);
  }

  // ─── FALLBACK: GPT was expected but did not work ───
  const fallbackReason = diagnostics.failureReason || 'Unknown reason';
  console.warn(`[Stratageo] FALLBACK to local classifier. Reason: ${fallbackReason}`);

  onStatus({ message: 'GPT unavailable — using local analysis...', progress: 8 });
  const spec = parsePrompt(rawPrompt);

  // Make the fallback reason visible in parsing notes
  spec.parsingNotes.unshift(`[FALLBACK] GPT intent extraction failed — using local classifier.`);
  spec.parsingNotes.unshift(`[REASON] ${fallbackReason}`);

  const sector = getSectorById(spec.sectorId);
  return {
    spec,
    effectiveSector: sector,
    searchRadiusM: sector.searchRadiusM,
    profile: DEFAULT_PROFILE,
  };
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
  // ═══════════════════════════════════════════════════════
  // Stage A: Universal Intent Understanding
  // ═══════════════════════════════════════════════════════

  const { spec, effectiveSector, searchRadiusM, profile } = await extractAnalysisIntent(rawPrompt, onStatus);
  spec.resultCount = Math.min(5, Math.max(1, resultCount));

  // Build user-point constraints if CSV data provided
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

  // ═══════════════════════════════════════════════════════
  // Stage B: Deterministic Analysis
  // ═══════════════════════════════════════════════════════

  // Use the effective sector (may be dynamic or template-based)
  const sector = effectiveSector;
  let { city } = spec.geography;
  const anchor = spec.geography.anchor;
  const isCoordinateAnchored = !!anchor && !city;

  // Validate: must have either city or coordinates
  if (!city && !anchor) {
    throw new Error('Could not detect a target location. Please specify a city (e.g., "Cafe in Bengaluru") or provide coordinates (e.g., "near 12.9385, 77.6206").');
  }

  // Step 2: Resolve geography
  onStatus({ message: isCoordinateAnchored ? 'Resolving location from coordinates...' : 'Planning search strategy...', progress: 10 });

  let locationLabel = city || 'provided coordinates';
  if (isCoordinateAnchored && anchor) {
    try {
      const reverseResult = await reverseGeocode(anchor.lat, anchor.lng);
      if (reverseResult) {
        const locality = reverseResult.locality;
        const inferredCity = reverseResult.city;
        if (inferredCity) {
          city = inferredCity;
          spec.geography.city = inferredCity;
          locationLabel = locality ? `${locality}, ${inferredCity}` : inferredCity;
          spec.parsingNotes.push(`Reverse geocoded: ${locationLabel} (${reverseResult.state || reverseResult.country}).`);
        } else if (locality) {
          locationLabel = locality;
          spec.parsingNotes.push(`Reverse geocoded locality: ${locality}.`);
        }
      }
    } catch {
      spec.parsingNotes.push('Reverse geocoding failed — proceeding with raw coordinates as anchor.');
    }
  }

  // Step 3: Build candidate list
  const analyzedLocations: LocationData[] = [];

  if (anchor && (isCoordinateAnchored || !city)) {
    // ─── Coordinate-anchored analysis ───
    const candidates = generateCandidatePoints(anchor.lat, anchor.lng, searchRadiusM, spec.resultCount + 2);

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      onStatus({
        message: `Analyzing area ${candidate.label}...`,
        progress: 15 + Math.round((i / candidates.length) * 50),
      });

      try {
        let candidateName = `${candidate.label} (${candidate.lat.toFixed(4)}, ${candidate.lng.toFixed(4)})`;
        try {
          const rev = await reverseGeocode(candidate.lat, candidate.lng);
          if (rev?.locality) candidateName = rev.locality;
          else if (rev?.display_name) candidateName = rev.display_name.split(',')[0];
        } catch { /* use fallback name */ }

        const osmResult = await fetchOSMData(candidate.lat, candidate.lng, sector, spec.constraints);

        let criteria = scoreNeighborhood(osmResult.signals, sector, spec);
        if (spec.userPointConstraints.length > 0) {
          criteria = addUserPointCriteria(criteria, candidate.lat, candidate.lng, spec.userPointConstraints);
        }

        const mcdaScore = computeMCDAScore(criteria);
        const exclusions = checkExclusions(
          osmResult.signals, spec.constraints, searchRadiusM,
          candidate.lat, candidate.lng, spec.userPointConstraints,
        );
        const excluded = exclusions.some(e => !e.passed);

        const reasoning = generateReasoning(candidateName, criteria, exclusions, searchRadiusM);

        analyzedLocations.push({
          name: candidateName,
          lat: candidate.lat,
          lng: candidate.lng,
          mcda_score: mcdaScore,
          criteria_breakdown: criteria,
          exclusions,
          excluded,
          reasoning,
          osmSignals: osmResult.signals,
          pois: osmResult.pois,
          searchRadiusM,
        });
      } catch {
        spec.parsingNotes.push(`OSM data fetch failed for "${candidate.label}" — skipped.`);
      }
    }
  } else {
    // ─── City-based analysis ───
    let neighborhoods: string[];
    if (spec.geography.neighborhoods?.length) {
      neighborhoods = spec.geography.neighborhoods;
    } else {
      neighborhoods = getNeighborhoodsForCity(city, spec.resultCount + 2);
    }

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
        if (spec.userPointConstraints.length > 0) {
          criteria = addUserPointCriteria(criteria, coords.lat, coords.lng, spec.userPointConstraints);
        }

        const mcdaScore = computeMCDAScore(criteria);
        const exclusions = checkExclusions(
          osmResult.signals, spec.constraints, searchRadiusM,
          coords.lat, coords.lng, spec.userPointConstraints,
        );
        const excluded = exclusions.some(e => !e.passed);

        const reasoning = generateReasoning(
          coords.display_name.split(',')[0],
          criteria,
          exclusions,
          searchRadiusM,
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
          searchRadiusM,
        });
      } catch {
        spec.parsingNotes.push(`OSM data fetch failed for "${neighborhood}" — skipped.`);
      }
    }
  }

  if (analyzedLocations.length === 0) {
    throw new Error(`Could not gather data for any candidate areas${city ? ` in ${city}` : ''}. Try a different location or check your connection.`);
  }

  // Step 4: Sort and limit
  onStatus({ message: 'Ranking candidate locations...', progress: 70 });

  analyzedLocations.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.mcda_score - a.mcda_score;
  });

  const finalLocations = analyzedLocations.slice(0, spec.resultCount);

  // Step 4b: Feasibility validation against profile
  const feasibility = validateFeasibility(finalLocations, spec, profile);

  // Handle infeasible results
  const nonExcludedCount = finalLocations.filter(l => !l.excluded).length;
  if (nonExcludedCount === 0 && spec.userPointConstraints.length > 0) {
    const upc = spec.userPointConstraints[0];
    const radiusKm = (upc.radiusM / 1000).toFixed(1);
    onStatus({ message: 'Analysis complete — no feasible locations found', progress: 100 });
    return {
      result: {
        summary: `No suitable locations found given current constraints. All ${analyzedLocations.length} candidate areas fall within the ${radiusKm}km ${upc.mode === 'exclude' ? 'exclusion' : 'inclusion'} zone of the ${upc.points.length} uploaded location(s). Try reducing the radius or relaxing constraints.`,
        business_type: spec.businessType,
        target_location: locationLabel,
        methodology: `Attempted to screen ${analyzedLocations.length} areas but all were excluded by user-supplied spatial constraints (${radiusKm}km ${upc.mode} buffer around ${upc.points.length} points).`,
        spec,
        locations: finalLocations,
        grounding_sources: [
          { title: 'OpenStreetMap / Overpass API', uri: 'https://overpass-api.de/', retrievedAt: new Date().toISOString(), reliability: 'Varies by region' },
          { title: 'User-supplied CSV data', uri: 'user-upload', retrievedAt: new Date().toISOString(), reliability: 'User-provided' },
        ],
      },
      spec,
    };
  }

  // Append feasibility warnings/suggestions to parsing notes
  for (const w of feasibility.warnings) {
    spec.parsingNotes.push(`[Feasibility] ${w}`);
  }
  for (const s of feasibility.suggestions) {
    spec.parsingNotes.push(`[Suggestion] ${s}`);
  }

  if (nonExcludedCount < spec.resultCount && spec.userPointConstraints.length > 0) {
    spec.parsingNotes.push(
      `Only ${nonExcludedCount} of ${spec.resultCount} requested locations passed all constraints.`,
    );
  }

  // Step 5: Optional AI enhancement
  onStatus({ message: 'Generating insights...', progress: 85 });

  let summary = generateSummary(spec.businessType, locationLabel, finalLocations, spec);

  // Prepend feasibility assessment to summary
  if (feasibility.overallQuality === 'weak') {
    summary = `Note: Overall suitability is low for ${spec.businessType} in this area. ${summary}`;
  }

  if (config.isLiveMode) {
    const aiResult = await fetchAIExplanation({
      businessType: spec.businessType,
      city: locationLabel,
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

  const radiusKm = (searchRadiusM / 1000).toFixed(1);
  const intentSource = spec.classificationMeta?.source === 'llm' ? 'AI-profiled' : 'locally-parsed';
  const criteriaType = sector.id === 'dynamic' ? 'dynamically-generated' : 'template-based';
  return {
    result: {
      summary,
      business_type: spec.businessType,
      target_location: locationLabel,
      methodology: `${intentSource} intent with ${criteriaType} criteria → MCDA using ${finalLocations[0]?.criteria_breakdown.length || 0} criteria scored from OpenStreetMap within ${radiusKm}km radius.${isCoordinateAnchored ? ' Anchor-based analysis from provided coordinates.' : ''} ${spec.constraints.length > 0 ? `${spec.constraints.length} spatial constraint(s) applied.` : ''} Feasibility: ${feasibility.overallQuality}. All scores are deterministic and evidence-backed.`,
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
