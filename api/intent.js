/**
 * Stratageo AI Intent Parsing Endpoint (v3 — Profile-Based Architecture)
 *
 * The LLM extracts a UNIVERSAL site-seeking profile from any prompt.
 * Instead of mapping to a small set of hardcoded sectors, it describes
 * the analytical dimensions needed for the deterministic pipeline.
 *
 * Request: POST { prompt: string }
 * Response: LLMIntent JSON with site-seeking profile dimensions
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Helper: send JSON with CORS headers on every path */
function sendJSON(res, status, body) {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(body));
}

const SYSTEM_PROMPT = `You are a geospatial site-selection intent parser for Stratageo, a professional site suitability platform.

Given ANY user query about locating a business, facility, or infrastructure project, extract a structured JSON object. You must handle ANY business type — retail, industrial, infrastructure, energy, social, commercial, or mixed.

Your job is ONLY to understand and structure the request. Do NOT generate final site recommendations.

Return JSON with these exact fields:

{
  "businessType": "string — exact project/facility type as stated (e.g. Apple Store, Solar Farm, Cold Chain Facility, Data Center, Preschool)",
  "sector": "string — broad sector category",
  "subSector": "string or null — sub-category if identifiable",
  "brand": "string or null — brand/operator name if mentioned (Apple, Starbucks, Amazon, etc.)",
  "useCaseSummary": "1 sentence describing the user's goal",

  "siteProfile": {
    "marketPositioning": "premium | mid_market | mass_market | utility_scale | industrial | institutional | unknown",
    "landIntensity": "high | medium | low — how much land/space the project needs",
    "urbanPreference": "urban_core | urban | suburban | periurban | rural | flexible",
    "infrastructureDependency": "high | medium | low — does it need heavy infrastructure (power, fiber, water)?",
    "footTrafficDependency": "high | medium | low | none — does it need walk-in customers?",
    "competitionSensitivity": "avoid_competition | tolerate_clustering | prefer_clustering",
    "accessProfile": "pedestrian | vehicle | freight | mixed | minimal",
    "environmentalSensitivity": "high | medium | low — sensitivity to pollution, noise, flood, etc.",
    "searchRadiusM": "number — recommended search radius in meters based on project type (500-20000)",
    "profileSummary": "1 sentence describing the ideal site characteristics"
  },

  "osmCriteria": [
    {
      "name": "string — human-readable criterion name",
      "osmTags": ["key=value OSM tags to query"],
      "queryBothNodeAndWay": true,
      "direction": "positive or negative — positive means more=better, negative means fewer=better",
      "weight": "number 0.05-0.40 — relative importance",
      "scoringThresholds": [0, 3, 8, 15, 25],
      "description": "why this criterion matters for this specific project"
    }
  ],

  "coordinates": {"lat": number, "lng": number} or null,
  "locationName": "city or region name, or null",
  "anchorType": "coordinate | city | none",
  "neighborhoods": ["3-5 real neighborhood names if city-based, else empty"],

  "positiveCriteria": [{"name": "what user wants nearby", "priority": "high|medium|low"}],
  "negativeCriteria": [{"name": "what user wants to minimize", "priority": "high|medium|low"}],
  "exclusionCriteria": [{"name": "hard exclusion rule", "distanceM": number_or_null}],
  "radiusConstraints": [{"target": "feature", "distanceM": number, "direction": "near|away"}],

  "requestedResultCount": 3,
  "uploadedDataReference": false,
  "confidence": "high | medium | low",
  "ambiguities": [],
  "reasoningSummary": "1-2 sentence explanation"
}

CRITICAL RULES FOR osmCriteria GENERATION:
1. Generate 4-7 criteria that are SPECIFIC to the requested business type. Do NOT use generic retail criteria for non-retail projects.
2. Use real OpenStreetMap tags. Common useful tags:
   - Retail/commercial: amenity=cafe, amenity=restaurant, shop=*, office=*, building=commercial
   - Transit: public_transport=station, highway=bus_stop, railway=station, railway=halt
   - Roads: highway=primary, highway=secondary, highway=trunk, highway=motorway
   - Residential: building=residential, building=apartments, landuse=residential
   - Industrial: landuse=industrial, building=industrial, building=warehouse
   - Power: power=substation, power=line, power=tower, power=generator
   - Land: landuse=farmland, landuse=meadow, natural=scrub, landuse=grass, landuse=forest
   - Water: natural=water, waterway=river, waterway=canal
   - Parks: leisure=park, leisure=playground, leisure=garden
   - Healthcare: amenity=hospital, amenity=clinic, amenity=pharmacy
   - Education: amenity=school, amenity=kindergarten, amenity=university
   - Parking: amenity=parking, amenity=fuel
   - Competitors: use the specific tags relevant to the business type
3. For scoringThresholds, provide 5 numbers representing breakpoints for 1→3→5→7→9 scoring. Adapt to the expected density:
   - Dense urban features (shops, restaurants): [0, 5, 15, 30, 50]
   - Moderate features (transit, schools): [0, 2, 5, 10, 18]
   - Sparse features (substations, hospitals): [0, 1, 3, 6, 10]
4. Set direction=negative for things that should be FEWER (competitors, nearby industrial for residential, etc.)
5. Weights should sum to approximately 1.0 across all criteria.

SECTOR IDENTIFICATION:
Do NOT force into a small set. Use descriptive sector names like:
- "Premium Retail", "QSR/Fast Casual", "Specialty Retail"
- "Solar Energy", "Data Center Infrastructure", "Telecom"
- "Cold Chain Logistics", "Last-Mile Fulfillment", "Freight Hub"
- "Early Childhood Education", "Higher Education"
- "Primary Healthcare", "Diagnostic Center"
- "Premium Coworking", "Budget Coworking"
- "Luxury Residential", "Affordable Housing"

BRAND HANDLING:
If a brand is mentioned (Apple, Starbucks, Amazon, Reliance, etc.):
- Extract it into the "brand" field
- Infer market positioning from the brand (Apple → premium, McDonald's → mass_market)
- Adjust siteProfile accordingly (premium brands need high-traffic premium zones)
- Adjust osmCriteria (premium retail needs luxury co-location, not just any commercial activity)

NEVER default to "Cafe" or "Restaurant" unless the user explicitly mentions food/cafe/restaurant/coffee/dining.
If genuinely ambiguous, set confidence=low and list ambiguities. Do NOT guess.`;

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    return res.end();
  }

  // All error paths use sendJSON to guarantee CORS headers
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return sendJSON(res, 500, { error: 'OPENAI_API_KEY not configured' });
  }

  const startTime = Date.now();

  try {
    const { prompt, sessionContext } = req.body;
    if (!prompt) {
      return sendJSON(res, 400, { error: 'Missing prompt' });
    }

    console.log(`[intent] Calling OpenAI gpt-4o-mini for: "${prompt.substring(0, 100)}..."${sessionContext ? ' (with session context)' : ''}`);

    // Build messages array with optional session context
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    if (sessionContext) {
      messages.push({
        role: 'system',
        content: `Previous analysis context (use this to interpret follow-up queries — carry forward any details not explicitly changed by the user):\n${sessionContext}`,
      });
    }

    messages.push({ role: 'user', content: prompt });

    // Use the stable Chat Completions API (not the newer Responses API)
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1200,
    });

    const elapsed = Date.now() - startTime;
    const rawText = response.choices?.[0]?.message?.content;

    if (!rawText) {
      console.error(`[intent] OpenAI returned empty content in ${elapsed}ms`);
      return sendJSON(res, 502, { error: 'OpenAI returned empty response', latencyMs: elapsed });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(`[intent] OpenAI returned invalid JSON in ${elapsed}ms:`, rawText.substring(0, 200));
      return sendJSON(res, 502, {
        error: 'OpenAI returned invalid JSON',
        detail: rawText.substring(0, 200),
        latencyMs: elapsed,
      });
    }

    console.log(`[intent] SUCCESS in ${elapsed}ms: ${parsed.businessType} / ${parsed.sector} (${parsed.confidence})`);
    return sendJSON(res, 200, parsed);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[intent] FAILED in ${elapsed}ms:`, msg);
    return sendJSON(res, 500, { error: 'Intent parsing failed', detail: msg, latencyMs: elapsed });
  }
}
