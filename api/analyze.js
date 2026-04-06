/**
 * /api/analyze — Server-side end-to-end site suitability analysis.
 *
 * Runs the full analysis pipeline that was previously frontend-only:
 *   prompt → LLM intent → geocoding → candidate generation →
 *   OSM scoring → MCDA ranking → AI explanation → structured JSON
 *
 * This endpoint is designed for:
 *   - Server-side reproducibility and testing
 *   - Debugging intermediate pipeline states
 *   - Integration testing without a browser session
 *
 * Request:  POST { prompt, resultCount?, sessionContext?, debug? }
 * Response: structured JSON — see response shape at bottom of this file.
 *
 * Local test:
 *   vercel dev   (from project root)
 *   curl -s -X POST http://localhost:3000/api/analyze \
 *     -H "Content-Type: application/json" \
 *     -d '{"prompt":"Find locations for a cafe in HSR Layout, Bengaluru","resultCount":3,"debug":true}' \
 *     | jq .
 */

import OpenAI from 'openai';
import { SYSTEM_PROMPT } from './_lib/intentPrompt.js';
import {
  geocodeLocation,
  reverseGeocode,
  haversineM,
  capSearchRadius,
  generateCandidatePoints,
  getNeighborhoodsForCity,
  hasCityInDefaultList,
  fetchOverpassData,
  fetchGooglePlacesDensity,
} from './_lib/geo.js';
import {
  scoreWithDynamicCriteria,
  scoreProfileAlignment,
  computeMCDAScore,
  checkExclusions,
  generateReasoning,
  isSparseData,
} from './_lib/scoring.js';
import {
  buildIntentContract,
  detectFollowupMode,
} from './_lib/intentContract.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJSON(res, status, body) {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(body));
}

// ─── Prompt seed — deterministic integer from prompt text ────────────────────
// Used with OpenAI `seed` param so identical prompts produce the same output.
// djb2-style hash, result in [1, 2^31-1].
function promptSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return (h % 2_147_483_647) || 1; // never 0
}

// ─── City name normalization (same as profileBuilder.ts) ───

function normalizeCity(city) {
  if (!city) return city;
  const lower = city.toLowerCase().trim();
  if (lower === 'bangalore') return 'Bengaluru';
  if (lower === 'gurgaon') return 'Gurugram';
  if (lower === 'bombay') return 'Mumbai';
  if (lower === 'madras') return 'Chennai';
  if (lower === 'calcutta') return 'Kolkata';
  if (/delhi\s*ncr/i.test(city)) return 'Delhi NCR';
  if (/\bncr\b/i.test(city)) return 'Delhi NCR';
  // Regional sub-area names that Nominatim geocodes unreliably or to wrong countries.
  // Map to the canonical parent city so neighborhood geocoding ("Bandra, Mumbai")
  // resolves correctly; extractRequestedLocality will still preserve the sub-area
  // as requestedMicroLocality from the rawCity / prompt text.
  if (/^(south|navi|greater)\s+mumbai$/i.test(lower)) return 'Mumbai';
  if (/^(south|north|east|west|new)\s+delhi$/i.test(lower)) return 'Delhi';
  if (/^(greater\s+)?noida$/i.test(lower)) return 'Noida';
  return city;
}

// ─── Confidence model ────────────────────────────────────────────────────────

/**
 * Compute a practical pipeline confidence score (0–100) and band.
 *
 * Factors (each subtracts from 100):
 *   geocodingFallback      — geocoder had to fall back to Nominatim (−15)
 *   microLocalityBroadened — exact locality could not be geocoded (−10)
 *   fewCandidates          — fewer than 3 candidates geocoded (−10 per missing)
 *   osmFetchFailures       — any Overpass fetch failed (−8 per failure, max −24)
 *   highSparseRatio        — >50% of ranked locations are sparse (−20)
 *   moderateSparseRatio    — 25–50% of ranked locations are sparse (−10)
 *   noDynamicCriteria      — no LLM-generated criteria, scoring is profile-only (−20)
 *   unresolvedExclusions   — exclusions the user requested but we could not geocode (−8 each)
 *   allFallbackCandidates  — every candidate came from city-offset fallback (−18)
 *   fewRankedCandidates    — fewer than 3 ranked results (−15 per missing)
 *
 * Hard caps (override band regardless of score):
 *   candidate_cap_low      — only 1 ranked result → max "low"
 *   candidate_cap_moderate — only 2 ranked results → max "moderate"
 *   evidence_cap_low       — ≥80% missing evidence → max "low"
 *   evidence_cap_moderate  — ≥50% missing evidence → max "moderate"
 *
 * "high" band requires score ≥ 80 AND rankedCount ≥ 3 AND no severe cap.
 *
 * Returns { score (0–100), band, factors[] }
 */
function computeConfidence({
  rankedLocations,
  candidateLocationsBeforeFiltering,
  hasDynamicCriteria,
  osmFetchFailureCount,
  geocodeFallbackUsed,
  anchorResolution,
  unresolvedExclusions,
  googleEvidenceCount,
  googleProbeFailures,
  blendedEvidenceCount,
  missingEvidenceCount,
}) {
  let score = 100;
  const factors = [];

  // ── Geocoding quality ──────────────────────────────────────────────────
  if (geocodeFallbackUsed) {
    score -= 15;
    factors.push({ factor: 'geocoding_fallback', penalty: -15, detail: 'Primary geocoder unavailable; Nominatim fallback used — coordinates may be less precise.' });
  }
  if (anchorResolution === 'broadened') {
    score -= 10;
    factors.push({ factor: 'locality_broadened', penalty: -10, detail: 'Requested micro-locality could not be geocoded; broader area used.' });
  }

  // ── Candidate coverage ─────────────────────────────────────────────────
  // Use ranked count (post-dedup, post-filter) as the real signal of result quality.
  const rankedCount = rankedLocations.length;
  const candCount = candidateLocationsBeforeFiltering.length;
  if (rankedCount < 3) {
    // Penalty per missing ranked candidate: −15 each (was −10 on pre-filter count).
    // A 2-candidate result misses meaningful comparison; 1-candidate result is near-useless.
    const pen = (3 - rankedCount) * 15;
    score -= pen;
    factors.push({ factor: 'few_ranked_candidates', penalty: -pen, detail: `Only ${rankedCount} candidate(s) ranked — minimum 3 needed for reliable comparison.` });
  }
  const allFallback = candCount > 0 &&
    candidateLocationsBeforeFiltering.every(c => c.source === 'city_offset_fallback');
  if (allFallback) {
    score -= 18;
    factors.push({ factor: 'all_candidates_are_offsets', penalty: -18, detail: 'All candidates are directional offsets from city center — no neighborhoods geocoded; results are approximate.' });
  }

  // ── OSM data quality ───────────────────────────────────────────────────
  if (osmFetchFailureCount > 0) {
    const pen = Math.min(24, osmFetchFailureCount * 8);
    score -= pen;
    factors.push({ factor: 'osm_fetch_failures', penalty: -pen, detail: `${osmFetchFailureCount} candidate(s) had OSM fetch failures — evidence is partial.` });
  }
  if (!hasDynamicCriteria) {
    score -= 20;
    factors.push({ factor: 'no_dynamic_criteria', penalty: -20, detail: 'LLM returned no business-specific OSM criteria — scoring uses generic profile alignment only.' });
  }

  // ── Evidence sparseness — Google-aware ────────────────────────────────
  // Count how many ranked locations are truly sparse (not Google-corroborated)
  const trulySparseCount = rankedLocations.filter(l => l.sparseData === true).length;
  const osmGapCount = rankedLocations.filter(l => l.evidenceQuality === 'osm_gap_google_corroborated').length;
  const totalRanked = rankedLocations.length;

  if (totalRanked > 0) {
    const trulySparseRatio = trulySparseCount / totalRanked;

    if (trulySparseRatio >= 1.0) {
      // All ranked locations have weak evidence from both sources
      score -= 35;
      factors.push({ factor: 'all_truly_sparse', penalty: -35, detail: `All ${totalRanked} ranked location(s) have sparse evidence from both OSM and Google — scores are not reliable.` });
    } else if (trulySparseRatio > 0.5) {
      score -= 22;
      factors.push({ factor: 'mostly_truly_sparse', penalty: -22, detail: `${trulySparseCount}/${totalRanked} ranked locations have weak evidence from both sources — rankings are directional only.` });
    } else if (trulySparseRatio > 0) {
      score -= 10;
      factors.push({ factor: 'some_truly_sparse', penalty: -10, detail: `${trulySparseCount}/${totalRanked} ranked location(s) have weak dual-source evidence — treat those rankings with caution.` });
    }

    // OSM gap (Google corroborates activity but OSM tags are missing) is a softer penalty
    if (osmGapCount > 0 && trulySparseCount === 0) {
      score -= 8;
      factors.push({ factor: 'osm_coverage_gap', penalty: -8, detail: `${osmGapCount}/${totalRanked} location(s) show Google activity but sparse OSM tags — OSM may undercount here.` });
    }
  }

  // ── Missing evidence (both sources zero) ──────────────────────────────
  const totalEvidence = blendedEvidenceCount + missingEvidenceCount;
  if (totalEvidence > 0) {
    const missingRatio = missingEvidenceCount / totalEvidence;
    if (missingRatio >= 0.8) {
      score -= 20;
      factors.push({ factor: 'high_missing_evidence', penalty: -20, detail: `${Math.round(missingRatio * 100)}% of criteria have no observed evidence from either OSM or Google.` });
    } else if (missingRatio >= 0.5) {
      score -= 10;
      factors.push({ factor: 'moderate_missing_evidence', penalty: -10, detail: `${Math.round(missingRatio * 100)}% of criteria lack evidence from both sources.` });
    }
  }

  // ── Google Places unavailable ──────────────────────────────────────────
  if (googleProbeFailures > 0 && googleProbeFailures >= (rankedLocations.length || 1)) {
    score -= 8;
    factors.push({ factor: 'google_places_unavailable', penalty: -8, detail: 'Google Places density probes failed for all candidates — blended evidence not available.' });
  }

  // ── Exclusion enforcement ──────────────────────────────────────────────
  if (unresolvedExclusions.length > 0) {
    const pen = Math.min(24, unresolvedExclusions.length * 8);
    score -= pen;
    factors.push({ factor: 'unresolved_exclusions', penalty: -pen, detail: `${unresolvedExclusions.length} exclusion(s) (${unresolvedExclusions.map(e => e.name).join(', ')}) could not be geocoded — not enforced.` });
  }

  score = Math.max(0, Math.min(100, score));

  // ── Band caps — hard structural and evidence-based ceilings ─────────────
  // These override the numeric score when structural conditions make 'high'
  // confidence inappropriate regardless of score.
  const totalCriteriaSlots = blendedEvidenceCount + missingEvidenceCount;
  let bandCap = null; // null = no cap

  // 1. Thin candidate pool: high requires ≥3 ranked results
  if (rankedCount < 2) {
    bandCap = 'low';
    factors.push({ factor: 'candidate_cap_low', penalty: 0, detail: `Only ${rankedCount} ranked result(s) — comparative analysis not possible; confidence capped at "low".` });
  } else if (rankedCount < 3) {
    // 2 ranked candidates: cap at moderate
    const existing = bandCap ? ['very_low','low','moderate','high'].indexOf(bandCap) : 3;
    if (existing > 1) { // only tighten, never loosen
      bandCap = 'moderate';
      factors.push({ factor: 'candidate_cap_moderate', penalty: 0, detail: `Only ${rankedCount} ranked candidates — high confidence requires at least 3; capped at "moderate".` });
    }
  }

  // 2. Missing evidence cap
  if (totalCriteriaSlots > 0) {
    const missingRatio = missingEvidenceCount / totalCriteriaSlots;
    if (missingRatio >= 0.8) {
      bandCap = 'low';   // ≥80% missing → max "low"
      factors.push({ factor: 'evidence_cap_low', penalty: 0, detail: `${Math.round(missingRatio * 100)}% of criteria have zero evidence from either source — confidence band capped at "low".` });
    } else if (missingRatio >= 0.5) {
      if (!bandCap || ['very_low','low','moderate','high'].indexOf(bandCap) > 1) {
        bandCap = 'moderate'; // ≥50% missing → max "moderate"
        factors.push({ factor: 'evidence_cap_moderate', penalty: 0, detail: `${Math.round(missingRatio * 100)}% of criteria lack any evidence — confidence band capped at "moderate".` });
      }
    }
  }

  // Compute numeric band
  let band;
  if (score >= 80)      band = 'high';
  else if (score >= 55) band = 'moderate';
  else if (score >= 30) band = 'low';
  else                  band = 'very_low';

  // Apply cap: degrade band only (never promote)
  const bandOrder = ['very_low', 'low', 'moderate', 'high'];
  if (bandCap && bandOrder.indexOf(band) > bandOrder.indexOf(bandCap)) {
    band = bandCap;
  }

  return { score, band, factors };
}

/**
 * Build a structured data sufficiency summary across all ranked locations.
 * Incorporates both OSM and Google blended evidence counts.
 */
function buildDataSufficiencySummary(
  rankedLocations,
  osmFetchFailureCount,
  hasDynamicCriteria,
  { googleEvidenceCount = 0, osmEvidenceCount = 0, blendedEvidenceCount = 0, missingEvidenceCount = 0 } = {},
) {
  const total = rankedLocations.length;
  if (total === 0) return { status: 'no_results', detail: 'No locations were scored.' };

  // sparseData = true means OSM sparse AND not Google-corroborated (truly weak)
  const trulySparseCount = rankedLocations.filter(l => l.sparseData === true).length;
  const osmGapCount = rankedLocations.filter(l => l.evidenceQuality === 'osm_gap_google_corroborated').length;
  const sufficientCount = rankedLocations.filter(l => l.evidenceQuality === 'sufficient').length;
  const totalCriteria = rankedLocations[0]?.criteriaBreakdown?.length ?? 0;

  // OSM observed percentage (raw — Google blending handled separately)
  let osmObservedTotal = 0, osmAbsentTotal = 0;
  for (const loc of rankedLocations) {
    for (const c of loc.criteriaBreakdown ?? []) {
      if ((c.rawValue ?? 0) > 0) osmObservedTotal++;
      else osmAbsentTotal++;
    }
  }
  const osmObservedPct = (osmObservedTotal + osmAbsentTotal) > 0
    ? Math.round((osmObservedTotal / (osmObservedTotal + osmAbsentTotal)) * 100)
    : 0;

  // Blended observed percentage (either source observed)
  const totalCriteriaSlots = blendedEvidenceCount + missingEvidenceCount;
  const blendedObservedPct = totalCriteriaSlots > 0
    ? Math.round((blendedEvidenceCount / totalCriteriaSlots) * 100)
    : osmObservedPct;

  // Status: based on blended picture — "sufficient" requires >50% blended evidence
  let status;
  if (osmFetchFailureCount === total) status = 'fetch_failed_all';
  else if (trulySparseCount === total) status = 'all_truly_sparse';
  else if (trulySparseCount > total / 2) status = 'mostly_truly_sparse';
  else if (trulySparseCount > 0 && osmGapCount > 0) status = 'mixed_evidence';
  else if (osmGapCount === total) status = 'osm_gap_google_corroborated';
  else if (trulySparseCount > 0) status = 'partially_sparse';
  else status = 'sufficient';

  const detail = status === 'sufficient'
    ? `${blendedObservedPct}% of criteria have blended evidence (OSM + Google) across ${total} location(s).`
    : status === 'all_truly_sparse'
      ? `All ${total} location(s) have weak evidence from both OSM and Google — scores are not reliable.`
      : status === 'fetch_failed_all'
        ? 'OSM data could not be fetched for any candidate. Scores are not evidence-based.'
        : status === 'osm_gap_google_corroborated'
          ? `OSM coverage is sparse but Google Places confirms urban activity — scores may undercount features.`
          : `${trulySparseCount}/${total} location(s) have weak dual-source evidence. ${blendedObservedPct}% of criteria have blended coverage.`;

  return {
    status,
    rankedLocationCount: total,
    criteriaPerLocation: totalCriteria,
    // OSM-only metrics (for comparison)
    osmObservedCriteriaPercent: osmObservedPct,
    osmFetchFailures: osmFetchFailureCount,
    // Blended metrics
    blendedObservedCriteriaPercent: blendedObservedPct,
    blendedEvidenceCount,
    missingEvidenceCount,
    osmEvidenceCount,
    googleEvidenceCount,
    // Location-level breakdown
    sufficientLocationCount: sufficientCount,
    osmGapLocationCount: osmGapCount,
    trulySparseLocationCount: trulySparseCount,
    hasDynamicCriteria,
    detail,
  };
}

// ─── Micro-locality detection ─────────────────────────────────────────────────

/**
 * Tokens that indicate a name is a sub-locality rather than just a city.
 * Used to detect when the user has been specific about a micro-area.
 */
const MICRO_LOCALITY_MARKERS =
  /\b(phase|sector|sec|block|layout|nagar|colony|enclave|extension|vihar|puram|ganj|bagh|marg|road|industrial\s+area|corridor|junction|east|west|north|south)\b/i;

/**
 * Extract the most-specific locality the user mentioned, given the resolved city.
 *
 * Three sources tried in order:
 *   1. city itself is "SubLocality, ParentCity" (LLM captured both in locationName)
 *   2. rawLocationName differs from city and contains a locality marker
 *   3. Prompt parsing — requires the candidate to contain a locality marker token
 *
 * Returns the sub-locality string, or null if only city-level specificity found.
 */
function extractRequestedLocality(rawLocationName, city, promptText) {
  const cityLower = city?.toLowerCase().trim() || '';

  // ── Source 1: city is already "SubLocality, ParentCity" ─────────────────
  // e.g. city="HSR Layout, Bengaluru" → return "HSR Layout"
  //      city="Bandra West, Mumbai"   → return "Bandra West"
  if (city?.includes(',')) {
    const subPart = city.split(',')[0].trim();
    if (subPart.length > 2) return subPart;
  }

  // ── Source 2: LLM's locationName is more specific than the normalized city ─
  // e.g. rawLocationName="JP Nagar 2nd Phase" but city="Bengaluru"
  if (rawLocationName && rawLocationName.toLowerCase().trim() !== cityLower) {
    const cityEscR = (city || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const subPart = rawLocationName.replace(new RegExp(`,?\\s*${cityEscR}\\s*$`, 'i'), '').trim();
    if (subPart.length > 2 && MICRO_LOCALITY_MARKERS.test(rawLocationName)) {
      return subPart || rawLocationName;
    }
  }

  // ── Source 3: Parse prompt — only accept candidates with locality markers ──
  // This prevents business descriptions ("pharmacy", "IT office") from being
  // mistaken for locality names.
  if (!promptText || !city) return null;

  const cityEsc = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    // "X in CityName" — locality precedes the city with "in" before the city
    new RegExp(`([\\w''-]+(?:\\s+[\\w''-]+){0,5})\\s+in\\s+${cityEsc}\\b`, 'i'),
    // "X, CityName" — locality comma-separated from city
    new RegExp(`([\\w''-]+(?:\\s+[\\w''-]+){0,5}),\\s*${cityEsc}\\b`, 'i'),
    // "in X CityName" — locality follows "in" and is directly adjacent to city (no comma)
    // e.g. "in JP Nagar 2nd Phase Bengaluru" → "JP Nagar 2nd Phase"
    new RegExp(`\\bin\\s+([\\w''-]+(?:\\s+[\\w''-]+){0,5})\\s+${cityEsc}\\b`, 'i'),
  ];

  for (const pattern of patterns) {
    const m = promptText.match(pattern);
    if (!m) continue;

    let candidate = m[1].trim();

    // If captured text contains " in " (e.g. "IT office in Sector 62"),
    // split and take the part that contains a locality marker.
    if (/\s+in\s+/i.test(candidate)) {
      const parts = candidate.split(/\s+in\s+/i);
      const markerPart = [...parts].reverse().find(p => MICRO_LOCALITY_MARKERS.test(p));
      if (markerPart) candidate = markerPart.trim();
      else continue; // no marker found in either part — skip
    }

    // Mandatory: candidate must contain a locality marker to be trusted
    if (!MICRO_LOCALITY_MARKERS.test(candidate)) continue;

    // Strip leading structural words (e.g. "Analyze ", "the ")
    candidate = candidate
      .replace(/^(?:analyze|find|suggest|locate|a\s+|an\s+|the\s+|for\s+(?:a\s+|an?\s+)?|i\s+want\s+(?:to\s+)?|looking\s+for\s+)/gi, '')
      .trim();

    if (!candidate || candidate.toLowerCase() === cityLower) continue;
    if (candidate.length < 3 || candidate.split(/\s+/).length > 5) continue;
    if (!MICRO_LOCALITY_MARKERS.test(candidate)) continue; // re-check after strip

    return candidate;
  }

  return null;
}

// ─── Exclusion OSM tag lookup ───
// Mirrors profileBuilder.ts:CONSTRAINT_OSM_MAP

const EXCLUSION_OSM_MAP = {
  hospital: ['amenity=hospital'],
  hospitals: ['amenity=hospital'],
  school: ['amenity=school'],
  schools: ['amenity=school', 'amenity=kindergarten'],
  industrial: ['landuse=industrial', 'building=industrial'],
  'industrial zone': ['landuse=industrial'],
  metro: ['railway=station', 'station=subway'],
  highway: ['highway=trunk', 'highway=motorway', 'highway=primary'],
  road: ['highway=primary', 'highway=secondary'],
  water: ['natural=water', 'waterway=river'],
  park: ['leisure=park'],
  parks: ['leisure=park', 'leisure=garden'],
  residential: ['building=residential', 'building=apartments', 'landuse=residential'],
  'flood zone': [],
  'agricultural land': ['landuse=farmland'],
};

function resolveExclusionOsmTags(name) {
  const lower = name.toLowerCase().trim();
  if (EXCLUSION_OSM_MAP[lower]) return EXCLUSION_OSM_MAP[lower];
  for (const [k, v] of Object.entries(EXCLUSION_OSM_MAP)) {
    if (lower.includes(k) || k.includes(lower)) return v;
  }
  return []; // no known OSM mapping → treat as named-area exclusion
}

// ─── Main handler ───

export default async function handler(req, res) {
  console.log('[analyze] handler entered, method:', req.method);
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    return res.end();
  }
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { ok: false, error: 'POST only' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return sendJSON(res, 500, { ok: false, error: 'OPENAI_API_KEY not configured' });
  }

  const pipelineStart = Date.now();
  const warnings = [];
  const parsingNotes = [];
  const geocodingNotes = [];

  // Per-request geocoding cache — avoids repeated API calls for the same query
  // string within one analysis run (exclusions/candidates often share city prefixes).
  const geocodeCache = new Map();
  async function cachedGeocode(query) {
    if (geocodeCache.has(query)) return geocodeCache.get(query);
    const result = await geocodeLocation(query);
    geocodeCache.set(query, result);
    return result;
  }

  // Derive the canonical parent-city for exclusion geocoding.
  // "South Mumbai" → "Mumbai", "Greater Noida" → "Noida" etc.
  // Used so exclusions like "Colaba" geocode as "Colaba, Mumbai, India"
  // instead of "Colaba, South Mumbai, India" (which Nominatim cannot resolve).
  function canonicalCityForExclusion(cityStr) {
    if (!cityStr) return cityStr;
    return cityStr
      .replace(/^(south|north|east|west|greater|old|new|navi)\s+/i, '')
      .trim();
  }

  try {
    const {
      prompt,
      resultCount = 3,
      sessionContext,
      debug = false,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return sendJSON(res, 400, { ok: false, error: 'Missing required field: prompt (string)' });
    }

    const count = Math.min(5, Math.max(1, Number(resultCount) || 3));

    // ═══════════════════════════════════════════════════════
    // Step 1 — Intent extraction via OpenAI
    // ═══════════════════════════════════════════════════════

    const intentStart = Date.now();
    let intent = null;
    let intentTokenUsage = null;

    try {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
      if (sessionContext) {
        messages.push({
          role: 'system',
          content: `Previous analysis context (use to interpret follow-up queries):\n${sessionContext}`,
        });
      }
      messages.push({ role: 'user', content: prompt });

      const intentRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        response_format: { type: 'json_object' },
        temperature: 0,              // deterministic sampling
        seed: promptSeed(prompt),    // same prompt → same token sequence (best-effort)
        max_tokens: 1500, // intentionally higher than /api/intent to reduce truncation
      });

      const rawText = intentRes.choices?.[0]?.message?.content;
      if (rawText) {
        intent = JSON.parse(rawText);
        const u = intentRes.usage;
        if (u) {
          intentTokenUsage = {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
          };
        }
      }
    } catch (err) {
      return sendJSON(res, 500, {
        ok: false,
        error: 'Intent extraction failed',
        detail: err.message,
        rawPrompt: prompt,
        debug: { intentLatencyMs: Date.now() - intentStart },
      });
    }

    const intentLatencyMs = Date.now() - intentStart;

    if (!intent?.businessType || !intent?.anchorType) {
      return sendJSON(res, 500, {
        ok: false,
        error: 'OpenAI returned invalid intent structure',
        rawPrompt: prompt,
        debug: { intentLatencyMs, rawIntent: intent },
      });
    }

    // ═══════════════════════════════════════════════════════
    // Step 1b — Intent contract (bounded archetype, guardrails)
    // ═══════════════════════════════════════════════════════

    const intentContract = buildIntentContract(intent, prompt, sessionContext ?? null);

    // Guard: follow-up modification prompt without prior context
    // Return a structured 400 so the caller can prompt the user to provide context.
    if (intentContract.requiresPriorContext && !sessionContext) {
      return sendJSON(res, 400, {
        ok: false,
        followupWithoutContext: true,
        followupMode: intentContract.followupMode,
        suggestion:
          'This prompt looks like a modification of a prior analysis ' +
          '(e.g. "actually prioritize X" or "now I care more about Y"). ' +
          'Please include the prior session context or rephrase as a new analysis prompt.',
        missingContextFlags: intentContract.missingContextFlags,
        intentContract,
        rawPrompt: prompt,
      });
    }

    // ═══════════════════════════════════════════════════════
    // Step 2 — Geography extraction
    // ═══════════════════════════════════════════════════════

    const rawCity = intent.locationName || '';
    let city = normalizeCity(rawCity);
    const anchor = intent.coordinates || null;
    const isCoordAnchored = intent.anchorType === 'coordinate' && anchor?.lat != null;
    const anchorTextRaw = isCoordAnchored ? `${anchor.lat}, ${anchor.lng}` : (rawCity || '');

    let anchorTextNormalized = city || anchorTextRaw;

    if (isCoordAnchored) {
      const rev = await reverseGeocode(anchor.lat, anchor.lng);
      if (rev?.city) {
        anchorTextNormalized = rev.locality ? `${rev.locality}, ${rev.city}` : rev.city;
        parsingNotes.push(`Anchor reverse-geocoded to: ${anchorTextNormalized}`);
      }
    }

    if (!city && !isCoordAnchored) {
      // LLM returned no locationName. Attempt a heuristic rescue: extract the
      // most likely place name from the prompt using "in <Place>" / "of <Place>"
      // patterns, then geocode it. Handles geographic regions like "Thar Desert".
      const placeMatch = prompt.match(
        /\bin\s+(?:the\s+)?([A-Z][a-zA-Z\s]{2,40}?)(?:\s*[.,?]|$)/,
      ) || prompt.match(/\bof\s+(?:the\s+)?([A-Z][a-zA-Z\s]{2,40}?)(?:\s*[.,?]|$)/);
      const extractedPlace = placeMatch?.[1]?.trim();
      let rescuedCity = null;
      if (extractedPlace) {
        const geo = await geocodeLocation(extractedPlace);
        if (geo) {
          const rev = await reverseGeocode(geo.lat, geo.lng);
          rescuedCity = rev?.city || rev?.locality || extractedPlace;
          parsingNotes.push(`LLM returned no city — rescued from prompt: "${extractedPlace}" → ${rescuedCity}`);
          warnings.push(`Location "${extractedPlace}" is a geographic region, not a city. Results are approximate.`);
        }
      }
      if (!rescuedCity) {
        return sendJSON(res, 400, {
          ok: false,
          error: 'Could not determine target location from prompt. Specify a city or coordinates.',
          rawPrompt: prompt,
          parsedIntent: intent,
          warnings: ['No city or coordinates extracted from prompt.'],
        });
      }
      // Patch into the mutable `city` so the rest of the pipeline uses it
      city = normalizeCity(rescuedCity);
      anchorTextNormalized = city;
    }

    // ─── Micro-locality: detect if user specified something more precise than city ───
    // Extract independently of LLM neighborhoods — the LLM often broadens or replaces it.
    const requestedMicroLocality = isCoordAnchored
      ? null
      : extractRequestedLocality(rawCity, city, prompt);

    const localityWarnings = [];
    let anchorResolution = 'city_level';      // default
    let broadenedFrom = null;                 // set if exact locality is supplemented
    let neighborhoodStrategy = 'coordinate_offsets'; // overwritten in city-based path

    // ═══════════════════════════════════════════════════════
    // Step 3 — Build scoring criteria from LLM osmCriteria
    // ═══════════════════════════════════════════════════════

    const hasDynamicCriteria = Array.isArray(intent.osmCriteria) && intent.osmCriteria.length >= 3;
    let dynamicCriteria = [];

    if (hasDynamicCriteria) {
      const rawCriteria = intent.osmCriteria.filter(
        c => c.name && Array.isArray(c.osmTags) && c.osmTags.length > 0 && c.direction,
      );

      dynamicCriteria = rawCriteria.map(c => ({
        name: c.name,
        // signalKey: strip filler words + normalise so minor label variation
        // ("Nearby Cafes" vs "nearby cafes" vs "Cafes Nearby") maps to the
        // same OSM accumulator key. This prevents different criteria names
        // in repeated runs from forking the Overpass query structure.
        signalKey: c.name
          .toLowerCase()
          .replace(/\b(nearby|access|availability|areas?|zones?|facilities|amenities|places?)\b/g, '')
          .replace(/[\s/]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .replace(/_+/g, '_') || c.name.toLowerCase().replace(/[\s/]+/g, '_'),
        osmTags: c.osmTags.filter(t => typeof t === 'string' && t.includes('=')),
        queryBothNodeAndWay: c.queryBothNodeAndWay !== false,
        direction: c.direction,
        weight: Math.min(0.40, Math.max(0.05, Number(c.weight) || 0.15)),
        scoringThresholds: (Array.isArray(c.scoringThresholds) && c.scoringThresholds.length === 5)
          ? c.scoringThresholds
          : [0, 3, 8, 15, 25],
      })).filter(c => c.osmTags.length > 0);

      // Cap at 3 criteria: gpt-4o-mini reliably produces the same top 3 for a
      // given prompt even without a perfect seed. Criteria at positions 4+ vary
      // across runs (different concepts, different OSM tags) even at temperature=0.
      // Using only the top 3 gives the tightest stability guarantee.
      if (dynamicCriteria.length > 3) dynamicCriteria = dynamicCriteria.slice(0, 3);

      // Normalize weights to sum ≈ 1.0
      const totalW = dynamicCriteria.reduce((s, c) => s + c.weight, 0);
      if (totalW > 0.1 && Math.abs(totalW - 1.0) > 0.1) {
        dynamicCriteria.forEach(c => {
          c.weight = Math.round((c.weight / totalW) * 100) / 100;
        });
      }

      parsingNotes.push(`${dynamicCriteria.length} LLM-generated criteria built from osmCriteria.`);
    } else {
      warnings.push('LLM returned fewer than 3 valid osmCriteria — only profile-alignment scoring will apply.');
      parsingNotes.push('No dynamic criteria. Falling back to profile-alignment-only scoring.');
    }

    // ─── Build exclusion list ───

    const allExclusions = (intent.exclusionCriteria || []).map(exc => ({
      name: exc.name,
      distanceM: exc.distanceM || null,
      osmTags: resolveExclusionOsmTags(exc.name),
      isNamedArea: resolveExclusionOsmTags(exc.name).length === 0,
    }));

    const namedAreaExclusions = allExclusions.filter(e => e.isNamedArea);
    const osmHardExclusions = allExclusions.filter(e => !e.isNamedArea);

    // ─── Site profile ───

    const profile = intent.siteProfile || {
      landIntensity: 'low',
      urbanPreference: 'flexible',
      marketPositioning: 'unknown',
      searchRadiusM: 1500,
    };

    const searchRadiusM = Math.min(20_000, Math.max(500, Number(profile.searchRadiusM) || 1500));

    // ═══════════════════════════════════════════════════════
    // Step 4 — Geocode candidate locations
    // ═══════════════════════════════════════════════════════

    /** @type {Array<{name,lat,lng,geocodedQuery,source,distFromCityKm?}>} */
    const candidateLocationsBeforeFiltering = [];

    if (isCoordAnchored) {
      // Coordinate anchor: generate directional offsets
      const pts = generateCandidatePoints(anchor.lat, anchor.lng, searchRadiusM, count + 2);
      for (const pt of pts) {
        let displayName = pt.label;
        const rev = await reverseGeocode(pt.lat, pt.lng);
        if (rev?.locality) displayName = rev.locality;
        else if (rev?.display_name) displayName = rev.display_name.split(',')[0];

        candidateLocationsBeforeFiltering.push({
          name: displayName,
          lat: pt.lat,
          lng: pt.lng,
          geocodedQuery: `${pt.lat.toFixed(4)},${pt.lng.toFixed(4)}`,
          source: 'coordinate_offset',
        });
      }
    } else {
      // City-based: geocode each neighborhood
      const cityAnchor = await geocodeLocation(city);
      if (!cityAnchor) {
        return sendJSON(res, 400, {
          ok: false,
          error: `Could not geocode city: "${city}"`,
          rawPrompt: prompt,
          parsedCity: city,
          parsedBusinessType: intent.businessType,
          warnings: [`Geocoding failed for "${city}". Try a more specific spelling.`],
        });
      }

      const cityAnchorFallback = cityAnchor.geocoderProviderUsed === 'nominatim_fallback';
      geocodingNotes.push(
        `City anchor: "${city}" → ${cityAnchor.lat.toFixed(4)}, ${cityAnchor.lng.toFixed(4)}` +
        (cityAnchorFallback ? ' [nominatim fallback]' : ' [google]'),
      );

      // ── Micro-locality: attempt exact locality first ──────────────────────
      // If the user named a specific sub-locality (e.g. "JP Nagar 2nd Phase"),
      // geocode it immediately and insert as the first candidate before any
      // LLM-generated neighborhoods. This prevents the system from broadening
      // prematurely when the user was precise.
      if (requestedMicroLocality) {
        let microCoords = await cachedGeocode(`${requestedMicroLocality}, ${city}`);
        if (!microCoords) microCoords = await cachedGeocode(requestedMicroLocality);

        if (microCoords) {
          const distM = haversineM(cityAnchor.lat, cityAnchor.lng, microCoords.lat, microCoords.lng);
          if (distM <= 100_000) {
            candidateLocationsBeforeFiltering.push({
              name: requestedMicroLocality,
              lat: microCoords.lat,
              lng: microCoords.lng,
              geocodedQuery: `${requestedMicroLocality}, ${city}`,
              distFromCityKm: Math.round(distM / 100) / 10,
              source: 'exact_micro_locality',
            });
            anchorResolution = 'exact';
            geocodingNotes.push(
              `Exact micro-locality "${requestedMicroLocality}" geocoded → ${microCoords.lat.toFixed(4)}, ${microCoords.lng.toFixed(4)}`,
            );
          } else {
            localityWarnings.push(
              `Exact locality "${requestedMicroLocality}" geocoded >100km from ${city} — ignored as likely error.`,
            );
          }
        } else {
          anchorResolution = 'broadened';
          broadenedFrom = requestedMicroLocality;
          localityWarnings.push(
            `Could not geocode exact locality "${requestedMicroLocality}" — broadening to city-level neighborhoods.`,
          );
          geocodingNotes.push(`Micro-locality "${requestedMicroLocality}" not geocodable — using neighborhoods instead.`);
        }
      }

      // ── LLM-suggested or default neighborhoods ────────────────────────────
      // Build the supplementary list; deduplicate against what's already added.
      const alreadyAdded = new Set(
        candidateLocationsBeforeFiltering.map(c => c.name.toLowerCase().trim()),
      );

      // Stable neighborhood selection strategy:
      //   - Known cities (in DEFAULT_NEIGHBORHOODS): use the static list as the
      //     authoritative base. LLM extras are appended alphabetically after, so
      //     LLM variation can only add — it never reorders the base set.
      //   - Unknown cities: LLM list sorted alphabetically, fallback to generic
      //     directional offsets if LLM returned nothing.
      const defaultNeighborhoods = getNeighborhoodsForCity(city, count + 3);
      const isKnownCity = hasCityInDefaultList(city);
      neighborhoodStrategy = isKnownCity ? 'default_only' : 'llm_only';
      let neighborhoodNames;
      if (isKnownCity) {
        // Known city: use ONLY the static default list — fully deterministic.
        // LLM suggestions are intentionally ignored to eliminate run-to-run
        // variation from LLM neighborhood drift.
        neighborhoodNames = defaultNeighborhoods;
      } else {
        // Unknown city: use LLM list sorted alphabetically, fallback to generic
        // directional offsets if the LLM returned nothing.
        neighborhoodNames = intent.neighborhoods?.length
          ? [...intent.neighborhoods].sort((a, b) => a.localeCompare(b))
          : defaultNeighborhoods;
      }

      const MAX_DIST_M = 100_000; // 100km sanity check

      for (const nb of neighborhoodNames) {
        // Skip if this is the same as the exact micro-locality already added
        if (alreadyAdded.has(nb.toLowerCase().trim())) continue;
        if (requestedMicroLocality && nb.toLowerCase().trim() === requestedMicroLocality.toLowerCase().trim()) continue;

        // Three-tier fallback: "Neighborhood, City" → "Neighborhood, India" → plain name
        let coords = await cachedGeocode(`${nb}, ${city}`);
        if (!coords) coords = await cachedGeocode(`${nb}, India`);
        if (!coords) coords = await cachedGeocode(nb);

        if (!coords) {
          geocodingNotes.push(`Could not geocode "${nb}" — skipped.`);
          continue;
        }

        const distM = haversineM(cityAnchor.lat, cityAnchor.lng, coords.lat, coords.lng);
        if (distM > MAX_DIST_M) {
          geocodingNotes.push(
            `"${nb}" geocoded ${Math.round(distM / 1000)}km from ${city} — rejected as geocoding error.`,
          );
          continue;
        }

        // Deduplicate by coordinates: skip if a candidate already exists within
        // 500m. Prevents city="Bandra West, Mumbai" from collapsing all
        // neighborhoods to Bandra West's coordinates (geocoder locks to city
        // qualifier), which would produce identical OSM queries and tied scores.
        const DEDUP_RADIUS_M = 500;
        const tooClose = candidateLocationsBeforeFiltering.some(
          existing => haversineM(existing.lat, existing.lng, coords.lat, coords.lng) < DEDUP_RADIUS_M,
        );
        if (tooClose) {
          geocodingNotes.push(`"${nb}" geocoded too close to an existing candidate — skipped as duplicate.`);
          continue;
        }

        // Strip city prefix from display name for readability
        const displayName = nb
          .replace(new RegExp(`^${city}\\s+`, 'i'), '')
          .replace(/, .*$/, '');

        candidateLocationsBeforeFiltering.push({
          name: displayName,
          lat: coords.lat,
          lng: coords.lng,
          geocodedQuery: `${nb}, ${city}`,
          distFromCityKm: Math.round(distM / 100) / 10,
          source: 'neighborhood_geocode',
        });
        alreadyAdded.add(displayName.toLowerCase().trim());
      }

      // Track broadening: if exact micro-locality was found but we added extra neighborhoods
      if (anchorResolution === 'exact' && candidateLocationsBeforeFiltering.length > 1) {
        anchorResolution = 'exact_with_broadening';
        broadenedFrom = requestedMicroLocality;
        parsingNotes.push(
          `Exact locality "${requestedMicroLocality}" preserved as candidate #1; supplemented with ${candidateLocationsBeforeFiltering.length - 1} broader neighborhood(s).`,
        );
      }

      // Fallback: if no neighborhoods geocoded, use city-center offsets
      if (candidateLocationsBeforeFiltering.length === 0) {
        warnings.push(`No neighborhoods could be geocoded for "${city}" — using city-center directional offsets.`);
        parsingNotes.push('Neighborhood geocoding failed; falling back to city-center offsets.');
        const offsetKm = Math.min(searchRadiusM / 1000, 5);
        const offsets = [
          { name: city, dlat: 0, dlng: 0 },
          { name: `${city} North`, dlat: offsetKm / 111, dlng: 0 },
          { name: `${city} South`, dlat: -offsetKm / 111, dlng: 0 },
          { name: `${city} East`, dlat: 0, dlng: offsetKm / (111 * Math.cos(cityAnchor.lat * Math.PI / 180)) },
          { name: `${city} West`, dlat: 0, dlng: -offsetKm / (111 * Math.cos(cityAnchor.lat * Math.PI / 180)) },
        ];
        for (const off of offsets.slice(0, count + 2)) {
          candidateLocationsBeforeFiltering.push({
            name: off.name,
            lat: cityAnchor.lat + off.dlat,
            lng: cityAnchor.lng + off.dlng,
            geocodedQuery: off.name,
            source: 'city_offset_fallback',
          });
        }
      }
    }

    // Merge locality warnings into main warnings now that Step 4 is complete
    warnings.push(...localityWarnings);

    if (candidateLocationsBeforeFiltering.length === 0) {
      return sendJSON(res, 422, {
        ok: false,
        error: 'No candidate locations could be geocoded.',
        rawPrompt: prompt,
        parsedCity: city,
        warnings,
        geocodingNotes,
      });
    }

    // ═══════════════════════════════════════════════════════
    // Step 5 — Apply named-area exclusion filtering
    // ═══════════════════════════════════════════════════════

    let candidateLocationsAfterFiltering = [...candidateLocationsBeforeFiltering];
    const penaltiesApplied = [];

    // Exclusion tracking fields (returned in response)
    const resolvedExclusions = [];
    const unresolvedExclusions = [];
    const excludedCandidates = [];
    const retainedCandidatesWithPenalties = [];
    const exclusionGeocodeAttempts = [];

    // Derive the canonical parent city for exclusion geocoding.
    // Strips directional qualifiers so "Colaba, South Mumbai, India" doesn't fail;
    // instead we try "Colaba, Mumbai, India" which Nominatim handles correctly.
    const canonicalCity = canonicalCityForExclusion(city);

    for (const exc of namedAreaExclusions) {
      // Robust resolution order:
      //  1. "<exc>, <canonicalCity>, India"  — most reliable
      //  2. "<exc>, <city>"                  — try the raw city as given
      //  3. "<exc>, India"                   — country-scoped bare name
      //  4. "<exc>"                          — last resort (geocodeLocation appends India)
      const attempts = [
        `${exc.name}, ${canonicalCity}, India`,
        ...(canonicalCity !== city ? [`${exc.name}, ${city}`] : []),
        `${exc.name}, India`,
        exc.name,
      ].filter((q, i, arr) => arr.indexOf(q) === i); // dedupe

      let excCoords = null;
      let usedQuery = null;
      for (const q of attempts) {
        const r = await cachedGeocode(q);
        if (r) { excCoords = r; usedQuery = q; break; }
      }

      exclusionGeocodeAttempts.push({
        exclusion: exc.name,
        queriesTried: attempts,
        resolvedQuery: usedQuery,
        resolved: !!excCoords,
        coords: excCoords ? { lat: excCoords.lat, lng: excCoords.lng } : null,
      });

      if (!excCoords) {
        unresolvedExclusions.push({ name: exc.name, reason: 'geocoding_failed', queriesTried: attempts });
        warnings.push(`Exclusion "${exc.name}" could not be geocoded and was NOT applied — results near this area may still appear.`);
        geocodingNotes.push(`Exclusion "${exc.name}": all ${attempts.length} geocoding attempts failed.`);
        continue;
      }

      resolvedExclusions.push({
        name: exc.name,
        lat: excCoords.lat,
        lng: excCoords.lng,
        resolvedQuery: usedQuery,
        exclusionRadiusM: exc.distanceM || 2000,
        softZoneRadiusM: (exc.distanceM || 2000) * 2,
      });

      const excRadius = exc.distanceM || 2000;
      const softRadius = excRadius * 2; // 2× hard radius = soft warning zone
      const before = candidateLocationsAfterFiltering.length;

      candidateLocationsAfterFiltering = candidateLocationsAfterFiltering.filter(loc => {
        const dist = haversineM(excCoords.lat, excCoords.lng, loc.lat, loc.lng);

        if (dist < excRadius) {
          // Hard exclusion: candidate is within the exclusion zone — remove it
          excludedCandidates.push({
            name: loc.name,
            exclusionName: exc.name,
            type: 'exact_exclusion',
            distKm: Math.round(dist / 100) / 10,
            exclusionRadiusKm: excRadius / 1000,
            penaltyReasoning: `"${loc.name}" is ${(dist / 1000).toFixed(1)}km from excluded area "${exc.name}" (limit: ${(excRadius / 1000).toFixed(1)}km) — removed from candidates.`,
          });
          penaltiesApplied.push({
            type: 'exact_exclusion',
            location: loc.name,
            rule: `Within ${(excRadius / 1000).toFixed(1)}km of excluded area "${exc.name}"`,
            distKm: Math.round(dist / 100) / 10,
          });
          return false;
        }

        if (dist < softRadius) {
          // Soft proximity zone: candidate is close but not inside hard boundary — flag it
          retainedCandidatesWithPenalties.push({
            name: loc.name,
            exclusionName: exc.name,
            type: 'proximity_penalty',
            distKm: Math.round(dist / 100) / 10,
            softZoneRadiusKm: softRadius / 1000,
            penaltyReasoning: `"${loc.name}" is ${(dist / 1000).toFixed(1)}km from excluded area "${exc.name}" — retained but flagged as nearby (soft zone: ${(softRadius / 1000).toFixed(1)}km).`,
          });
          penaltiesApplied.push({
            type: 'proximity_penalty',
            location: loc.name,
            rule: `Within soft zone (${(softRadius / 1000).toFixed(1)}km) of avoided area "${exc.name}"`,
            distKm: Math.round(dist / 100) / 10,
          });
        }

        return true;
      });

      const removed = before - candidateLocationsAfterFiltering.length;
      if (removed > 0) {
        parsingNotes.push(`Exclusion "${exc.name}": removed ${removed} candidate(s) within ${(excRadius / 1000).toFixed(1)}km.`);
      }
    }

    // Restore full set if all candidates were excluded (avoid empty results)
    if (candidateLocationsAfterFiltering.length === 0 && candidateLocationsBeforeFiltering.length > 0) {
      warnings.push(
        'All candidates were filtered by named-area exclusions — restoring full candidate set as fallback.',
      );
      candidateLocationsAfterFiltering = [...candidateLocationsBeforeFiltering];
    }

    // ═══════════════════════════════════════════════════════
    // Step 6 — Cap search radius
    // ═══════════════════════════════════════════════════════

    let effectiveRadius = searchRadiusM;
    if (candidateLocationsAfterFiltering.length >= 2) {
      effectiveRadius = capSearchRadius(
        candidateLocationsAfterFiltering.map(c => ({ lat: c.lat, lng: c.lng })),
        searchRadiusM,
      );
      if (effectiveRadius < searchRadiusM) {
        parsingNotes.push(
          `Radius capped from ${(searchRadiusM / 1000).toFixed(1)}km → ${(effectiveRadius / 1000).toFixed(1)}km (inter-neighborhood overlap prevention).`,
        );
        penaltiesApplied.push({
          type: 'radius_cap',
          rule: `Search radius reduced from ${(searchRadiusM / 1000).toFixed(1)}km to ${(effectiveRadius / 1000).toFixed(1)}km`,
        });
      }
    }

    // ═══════════════════════════════════════════════════════
    // Step 7 — Fetch OSM data and score (parallel)
    // ═══════════════════════════════════════════════════════

    const osmStart = Date.now();

    // Build the combined criteria list for Overpass: dynamic + hard-exclusion OSM signals
    const exclusionFetchCriteria = osmHardExclusions
      .filter(e => e.osmTags.length > 0)
      .map(e => ({
        signalKey: e.name.toLowerCase().replace(/\s+/g, '_'),
        osmTags: e.osmTags,
        queryBothNodeAndWay: true,
      }));

    const allCriteriaForFetch = [...dynamicCriteria, ...exclusionFetchCriteria];

    const targetCandidates = candidateLocationsAfterFiltering.slice(0, count + 2);

    // Fetch OSM + Google Places density probes in parallel for all candidates
    const [osmSettled, googleDensitySettled] = await Promise.all([
      Promise.allSettled(
        targetCandidates.map(candidate =>
          allCriteriaForFetch.length > 0
            ? fetchOverpassData(allCriteriaForFetch, candidate.lat, candidate.lng, effectiveRadius)
            : Promise.resolve({ signals: {}, pois: [] }),
        ),
      ),
      Promise.allSettled(
        targetCandidates.map(candidate =>
          fetchGooglePlacesDensity(candidate.lat, candidate.lng, effectiveRadius),
        ),
      ),
    ]);

    const osmLatencyMs = Date.now() - osmStart;

    const scoredLocations = [];
    let osmFetchFailureCount = 0;

    // Evidence coverage accumulators (across all candidates)
    let googleEvidenceCount = 0;   // total Google density places found
    let osmEvidenceCount = 0;      // total OSM rawValues observed (> 0)
    let blendedEvidenceCount = 0;  // criteria where at least one source observed evidence
    let missingEvidenceCount = 0;  // criteria where both sources had zero/absent evidence
    let googleProbeFailures = 0;

    for (let i = 0; i < targetCandidates.length; i++) {
      const candidate = targetCandidates[i];
      const settled = osmSettled[i];

      if (settled.status === 'rejected') {
        osmFetchFailureCount++;
        warnings.push(`OSM fetch failed for "${candidate.name}": ${settled.reason?.message || 'unknown error'}`);
        continue;
      }

      const osmResult = settled.value;

      // Google Places density result for this candidate
      const googleDensityResult = googleDensitySettled[i];
      const googleDensity = googleDensityResult.status === 'fulfilled'
        ? googleDensityResult.value
        : null;
      if (!googleDensity || googleDensity?.sourceUsed === 'failed') googleProbeFailures++;
      const googleDensityTotal = googleDensity?.totalCount ?? 0;
      googleEvidenceCount += googleDensityTotal;

      // Score dynamic criteria (OSM-based — scoring logic unchanged)
      const criteriaBreakdown = dynamicCriteria.length > 0
        ? scoreWithDynamicCriteria(osmResult.signals, dynamicCriteria, effectiveRadius)
        : [];

      // Append profile-alignment criteria (land availability, urban-rural fit)
      criteriaBreakdown.push(...scoreProfileAlignment(osmResult.signals, profile));

      const mcdaScore = computeMCDAScore(criteriaBreakdown);

      // Check hard OSM exclusions
      const exclusionChecks = checkExclusions(
        osmResult.signals,
        osmHardExclusions.map(e => ({ target: e.name, direction: 'away' })),
      );
      const excluded = exclusionChecks.some(e => !e.passed);

      if (excluded) {
        penaltiesApplied.push({
          type: 'hard_osm_exclusion',
          location: candidate.name,
          failedRules: exclusionChecks.filter(e => !e.passed).map(e => e.rule),
        });
      }

      // ── Evidence coverage per candidate ──────────────────────────────────
      // For each dynamic criterion, determine source-of-evidence and blend status.
      // Google density is a general signal (not criterion-specific), so we use it
      // to corroborate or dispute OSM sparseness at the candidate level.
      const candidateEvidenceMeta = criteriaBreakdown.map(c => {
        const osmObserved = (c.rawValue ?? 0) > 0;
        // Google density corroborates: if the candidate area has >5 places of any
        // common type, it's likely an active locality — OSM zero may be a coverage
        // gap, not true absence. We mark this criterion as "google_corroborated".
        const googleCorroborates = googleDensityTotal >= 5;
        let sourceUsed;
        if (osmObserved) {
          sourceUsed = googleCorroborates ? 'blended' : 'osm';
          blendedEvidenceCount++;
          osmEvidenceCount++;
        } else if (googleCorroborates) {
          sourceUsed = 'google_corroborated';
          blendedEvidenceCount++;
        } else {
          sourceUsed = 'none';
          missingEvidenceCount++;
        }
        return {
          criterionName: c.name,
          osmRawValue: c.rawValue ?? 0,
          googleDensityTotal,
          sourceUsed,
          osmObserved,
          googleCorroborates,
        };
      });

      // A candidate is sparse if >50% of criteria have no OSM evidence.
      // But if Google corroborates activity, demote to "osm_gap" rather than "sparse".
      const osmSparseData = isSparseData(criteriaBreakdown);
      const googleCorroborates = googleDensityTotal >= 5;
      const sparseData = osmSparseData && !googleCorroborates;
      const evidenceQuality = osmSparseData
        ? (googleCorroborates ? 'osm_gap_google_corroborated' : 'sparse')
        : 'sufficient';

      if (osmSparseData && !googleCorroborates) {
        warnings.push(`"${candidate.name}": sparse OSM data and no Google corroboration — evidence quality is weak.`);
      } else if (osmSparseData && googleCorroborates) {
        warnings.push(`"${candidate.name}": sparse OSM data but Google Places shows urban activity — possible OSM coverage gap.`);
      }

      const reasoning = generateReasoning(candidate.name, criteriaBreakdown, exclusionChecks, effectiveRadius);

      scoredLocations.push({
        name: candidate.name,
        lat: candidate.lat,
        lng: candidate.lng,
        mcdaScore,
        excluded,
        criteriaBreakdown,
        exclusions: exclusionChecks,
        osmSignals: osmResult.signals,
        pois: osmResult.pois,
        reasoning,
        geocodedQuery: candidate.geocodedQuery,
        sparseData,
        evidenceQuality,
        googleDensity: {
          totalCount: googleDensityTotal,
          breakdown: googleDensity?.breakdown ?? {},
          sourceUsed: googleDensity?.sourceUsed ?? 'unavailable',
        },
        candidateEvidenceMeta,
      });
    }

    if (scoredLocations.length === 0) {
      return sendJSON(res, 422, {
        ok: false,
        error: 'Could not score any candidate locations. OSM data unavailable for all candidates.',
        rawPrompt: prompt,
        parsedCity: city,
        parsedBusinessType: intent.businessType,
        warnings,
        debug: { intentLatencyMs, osmLatencyMs, parsingNotes, geocodingNotes },
      });
    }

    // ═══════════════════════════════════════════════════════
    // Step 8 — Rank locations
    // ═══════════════════════════════════════════════════════

    const RANKING_TIE_BREAK_RULE = 'name_asc';
    scoredLocations.sort((a, b) => {
      // Excluded locations always rank last
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      // Primary: MCDA score descending
      if (b.mcdaScore !== a.mcdaScore) return b.mcdaScore - a.mcdaScore;
      // Secondary (tie-break): name ascending — deterministic across runs
      return a.name.localeCompare(b.name);
    });

    const rankedLocations = scoredLocations.slice(0, count).map((loc, i) => ({
      rank: i + 1,
      ...loc,
    }));

    // ═══════════════════════════════════════════════════════
    // Step 8b — Confidence scoring & data sufficiency
    // ═══════════════════════════════════════════════════════

    const confidence = computeConfidence({
      rankedLocations,
      candidateLocationsBeforeFiltering,
      hasDynamicCriteria,
      osmFetchFailureCount,
      geocodeFallbackUsed: isCoordAnchored
        ? false
        : (geocodeCache.values().next().value?.geocoderProviderUsed === 'nominatim_fallback'),
      anchorResolution,
      unresolvedExclusions,
      googleEvidenceCount,
      googleProbeFailures,
      blendedEvidenceCount,
      missingEvidenceCount,
    });

    const dataSufficiencySummary = buildDataSufficiencySummary(
      rankedLocations,
      osmFetchFailureCount,
      hasDynamicCriteria,
      { googleEvidenceCount, osmEvidenceCount, blendedEvidenceCount, missingEvidenceCount },
    );

    // Emit confidence-derived warnings into the main warnings array
    if (confidence.band === 'very_low') {
      warnings.push(`Pipeline confidence is very low (${confidence.score}/100) — results should not be used for site selection without additional validation.`);
    } else if (confidence.band === 'low') {
      warnings.push(`Pipeline confidence is low (${confidence.score}/100) — treat rankings as directional rather than definitive.`);
    }
    if (dataSufficiencySummary.status !== 'sufficient') {
      warnings.push(`Data sufficiency: ${dataSufficiencySummary.detail}`);
    }

    // ═══════════════════════════════════════════════════════
    // Step 9 — AI explanation
    // ═══════════════════════════════════════════════════════

    const explainStart = Date.now();
    let explanation = null;
    let explainTokenUsage = null;
    let explainError = null;

    try {
      const locationSummary = rankedLocations
        .map(loc =>
          `${loc.name} (score: ${loc.mcdaScore}/10): ` +
          loc.criteriaBreakdown.map(c => `${c.name}: ${c.score}/10`).join(', '),
        )
        .join('\n');

      const profileLine = profile.profileSummary
        ? `Business profile: ${profile.profileSummary}. Land intensity: ${profile.landIntensity}. Urban preference: ${profile.urbanPreference}.`
        : '';

      const warningLine = warnings.length > 0
        ? `Identified concerns: ${warnings.slice(0, 3).join('; ')}`
        : '';

      const explainPrompt =
        `You are a senior GIS analyst for Stratageo. Given MCDA-scored locations for "${intent.businessType}" in ${anchorTextNormalized}:\n\n` +
        `${locationSummary}\n` +
        (profileLine ? `\n${profileLine}` : '') +
        (warningLine ? `\n${warningLine}` : '') +
        `\n\nProvide:\n` +
        `1. A 2-3 sentence executive summary. Be honest about low scores and sparse data.\n` +
        `2. For each location: 1-2 sentence reasoning and 1 sentence strategic recommendation.\n\n` +
        `Respond in JSON:\n{"summary":"...","locationInsights":[{"name":"...","reasoning":"...","strategy":"..."}]}`;

      const explainRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: explainPrompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 700,
      });

      const explainText = explainRes.choices?.[0]?.message?.content;
      if (explainText) {
        explanation = JSON.parse(explainText);
        const u = explainRes.usage;
        if (u) {
          explainTokenUsage = {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
          };
        }

        // Apply per-location insights via fuzzy name match (avoids exact-string failures)
        if (Array.isArray(explanation.locationInsights)) {
          for (const insight of explanation.locationInsights) {
            const loc = rankedLocations.find(l =>
              l.name === insight.name ||
              l.name.toLowerCase().startsWith(insight.name.toLowerCase()) ||
              insight.name.toLowerCase().startsWith(l.name.toLowerCase()),
            );
            if (loc) loc.reasoning = insight.reasoning;
          }
        }
      }
    } catch (err) {
      explainError = err.message;
      warnings.push(`Explanation generation failed: ${err.message}. Generated reasoning used instead.`);
    }

    const explainLatencyMs = Date.now() - explainStart;
    const totalLatencyMs = Date.now() - pipelineStart;

    // ═══════════════════════════════════════════════════════
    // Step 10 — Build response
    // ═══════════════════════════════════════════════════════

    const debugAlways = {
      totalLatencyMs,
      sectorId: hasDynamicCriteria ? 'dynamic' : 'fallback',
      criteriaCount: dynamicCriteria.length,
      candidatesBeforeFilter: candidateLocationsBeforeFiltering.length,
      candidatesAfterFilter: candidateLocationsAfterFiltering.length,
      rankedCount: rankedLocations.length,
      // Repeatability diagnostics
      candidateGenerationSource: isCoordAnchored
        ? 'coordinate_offsets'
        : neighborhoodStrategy,
      neighborhoodStrategy: isCoordAnchored ? 'coordinate_offsets' : neighborhoodStrategy,
      criteriaGenerationSource: hasDynamicCriteria ? 'llm_dynamic' : 'profile_fallback',
      rankingTieBreakRule: RANKING_TIE_BREAK_RULE,
      intentTemperature: 0,
      intentSeed: promptSeed(prompt),
      // Intent contract
      normalizedIntentContract: intentContract,
      selectedArchetype: intentContract.businessArchetype,
      allowedCriteriaFamilies: intentContract.allowedCriteriaFamilies,
      followupMode: intentContract.followupMode,
      missingContextFlags: intentContract.missingContextFlags,
      intentGuardrailsApplied: intentContract.intentGuardrailsApplied,
      parsingNotes,
      geocodingNotes,
    };

    const debugVerbose = {
      ...debugAlways,
      intentLatencyMs,
      osmLatencyMs,
      explainLatencyMs,
      criteriaType: hasDynamicCriteria ? 'llm-generated' : 'none',
      searchRadiusM,
      effectiveRadiusM: effectiveRadius,
      tokenUsage: {
        intent: intentTokenUsage,
        explain: explainTokenUsage,
      },
      explainError: explainError || null,
      rawIntent: intent,
      exclusionGeocodeAttempts,
      osmFetchFailureCount,
      confidenceDetail: confidence,
    };

    return sendJSON(res, 200, {
      ok: true,

      // ─── Input echo ───
      rawPrompt: prompt,

      // ─── Parsed intent ───
      parsedIntent: intent,
      intentContract,
      parsedCity: city || anchorTextNormalized,
      parsedBusinessType: intent.businessType,
      parsedExclusions: allExclusions.map(e => ({
        name: e.name,
        distanceM: e.distanceM,
        type: e.isNamedArea ? 'named_area' : 'osm_feature',
        osmTags: e.osmTags,
      })),

      // ─── Geography ───
      anchorTextRaw,
      anchorTextNormalized,
      requestedMicroLocality,
      anchorResolution,
      broadenedFrom,
      localityWarnings,

      // ─── Candidate pipeline states ───
      candidateLocationsBeforeFiltering,
      candidateLocationsAfterFiltering,

      // ─── Ranked results ───
      rankedLocations,

      // ─── Exclusion detail ───
      resolvedExclusions,
      unresolvedExclusions,
      exactExclusionsApplied: excludedCandidates.length,
      excludedCandidates,
      retainedCandidatesWithPenalties,

      // ─── Applied penalties / filters ───
      penaltiesApplied,

      // ─── Confidence & data quality ───
      confidenceScore: confidence.score,
      confidenceBand: confidence.band,
      confidenceFactors: confidence.factors,
      dataSufficiencySummary,
      evidenceCoverageSummary: {
        googleEvidenceCount,
        osmEvidenceCount,
        blendedEvidenceCount,
        missingEvidenceCount,
        fetchFailureCount: osmFetchFailureCount,
      },
      warnings,

      // ─── AI explanation ───
      explanation,

      // ─── Debug metadata ───
      debug: debug ? debugVerbose : debugAlways,
    });

  } catch (err) {
    console.error('[analyze] Unhandled pipeline error:', err);
    return sendJSON(res, 500, {
      ok: false,
      error: 'Analysis pipeline failed',
      detail: err.message,
      debug: {
        totalLatencyMs: Date.now() - pipelineStart,
        parsingNotes,
        geocodingNotes,
      },
    });
  }
}
