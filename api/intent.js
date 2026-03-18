/**
 * Stratageo AI Intent Parsing Endpoint (v2 — LLM-First Architecture)
 *
 * The LLM is the FIRST semantic interpreter of the user's prompt.
 * It returns a rich structured intent object that drives the entire
 * deterministic analysis pipeline downstream.
 *
 * Request body (POST):
 * { prompt: string }
 *
 * Response: LLMIntent JSON (see intentSchema.ts for full type)
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = `You are a geospatial site-selection intent parser for Stratageo, a professional site suitability platform.

Given a user's natural-language query about where to locate a business, facility, or infrastructure project, extract a structured JSON object.

Your job is ONLY to understand and structure the request — NOT to generate site recommendations.

Return JSON with these exact fields:
{
  "businessType": "string — the exact project type (e.g. Solar Farm, Warehouse, Cafe, Data Center, EV Charging Station, Preschool, Clinic)",
  "sector": "string — one of: energy, logistics, retail_food, retail, ev_mobility, education, healthcare, coworking, real_estate, infrastructure",
  "subSector": "string or null",
  "useCaseSummary": "1 sentence describing what the user wants",
  "coordinates": {"lat": number, "lng": number} or null,
  "locationName": "city or region name, or null",
  "anchorType": "coordinate or city or none",
  "neighborhoods": ["3-5 real neighborhood names if city-based, else empty array"],
  "positiveCriteria": [{"name": "what user wants nearby/more of", "priority": "high|medium|low"}],
  "negativeCriteria": [{"name": "what user wants to avoid/minimize", "priority": "high|medium|low"}],
  "exclusionCriteria": [{"name": "hard exclusion rule description", "distanceM": number_or_null}],
  "radiusConstraints": [{"target": "feature name", "distanceM": number, "direction": "near|away"}],
  "requestedResultCount": number_between_1_and_5_default_3,
  "uploadedDataReference": false,
  "confidence": "high|medium|low",
  "ambiguities": ["things you are uncertain about, if any"],
  "reasoningSummary": "1-2 sentence explanation of your interpretation"
}

CRITICAL RULES:
1. Identify the EXACT business/project type from the prompt. Solar farm is energy, not retail. Warehouse is logistics, not retail. Data center is infrastructure.
2. NEVER default to cafe/restaurant/retail unless the user EXPLICITLY mentions food, cafe, restaurant, coffee, bakery, dining, or similar food-service terms.
3. Extract coordinates in any format: "latitude X longitude Y", "lat X lon Y", "near 28.7, 77.1", bare decimal pairs.
4. Clearly separate:
   - positiveCriteria: things the user wants nearby or more of (substation proximity, road access, transit)
   - negativeCriteria: things the user wants to minimize but not hard-exclude (slope, noise, competition)
   - exclusionCriteria: hard rules that eliminate candidates (not within 3km of settlements, not on agricultural land)
5. Parse distance constraints with correct unit conversion (km→meters).
6. If the prompt references "my locations", "uploaded points", "CSV", "my stores", set uploadedDataReference=true.
7. Set confidence=high if the business type and location are clear. Set confidence=low only if the prompt is genuinely vague or ambiguous.
8. If you cannot determine the business type at all, set confidence=low and list ambiguities.
9. For neighborhoods: only suggest real, specific neighborhood names for the identified city. If coordinate-based, return empty array.
10. Be conservative — do not invent criteria not supported by the prompt.

Sector mapping guide:
- Solar farm, solar plant, PV, photovoltaic, wind farm, renewable energy → "energy"
- Data center, server farm, telecom tower → "infrastructure"
- Warehouse, logistics hub, distribution center, fulfillment, godown → "logistics"
- Cafe, restaurant, coffee shop, bakery, food court, eatery → "retail_food"
- Store, supermarket, mall, boutique, outlet, retail shop → "retail"
- EV charging, charging station, electric vehicle → "ev_mobility"
- School, preschool, kindergarten, daycare, education → "education"
- Clinic, hospital, pharmacy, healthcare, diagnostic → "healthcare"
- Coworking, shared office, workspace → "coworking"
- Real estate, residential, apartments, mixed-use, housing → "real_estate"`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    return res.end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      text: {
        format: {
          type: 'json_object',
        },
      },
      temperature: 0.2,
      max_output_tokens: 800,
    });

    const parsed = JSON.parse(response.output_text);

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(parsed));
  } catch (error) {
    console.error('Intent parsing error:', error);
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Intent parsing failed' }));
  }
}
