/**
 * Stratageo AI Explanation Endpoint
 *
 * Calls OpenAI to generate business-context explanations
 * for pre-scored site suitability results.
 *
 * Request: POST { businessType, city, locations }
 * Response: { summary, locationInsights }
 */

import OpenAI from 'openai';

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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    return res.end();
  }

  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return sendJSON(res, 500, { error: 'OPENAI_API_KEY not configured' });
  }

  try {
    const { businessType, city, locations, profileContext, feasibilityWarnings } = req.body;

    if (!businessType || !city || !locations?.length) {
      return sendJSON(res, 400, { error: 'Missing required fields: businessType, city, locations' });
    }

    const locationSummary = locations.map(loc =>
      `${loc.name} (score: ${loc.mcda_score}/10): ${loc.criteria_breakdown.map(c => `${c.name}: ${c.score}/10`).join(', ')}`
    ).join('\n');

    const profileSection = profileContext
      ? `\n${profileContext}\n`
      : '';

    const warningsSection = feasibilityWarnings?.length
      ? `\nFeasibility concerns identified:\n${feasibilityWarnings.map(w => `- ${w}`).join('\n')}\n`
      : '';

    const prompt = `You are a senior GIS analyst and site suitability consultant for Stratageo. You think like a real-world site selection professional — not a generic chatbot. You understand that:
- Land-intensive projects (solar farms, golf courses, factories) need OPEN LAND, not urban amenities
- Dense urban areas are UNSUITABLE for land-intensive uses regardless of nearby infrastructure
- A high score on "nearby hospitals" means nothing if the business needs 50 acres of flat ground
- Location-type fit matters more than amenity counts for many business types
${profileSection}
Given these MCDA-scored locations for a "${businessType}" in ${city}:

${locationSummary}
${warningsSection}
Provide:
1. A 2-3 sentence executive summary comparing the locations. If there are feasibility concerns, lead with them honestly — don't sugarcoat unsuitable locations.
2. For each location: a 1-2 sentence reasoning that a GIS professional would give, and a 1-sentence strategic recommendation.

If the "Land availability" or "Location-type fit" scores are low (≤3), explicitly state that the location is likely physically unsuitable for this use case, regardless of other criteria scores.

Respond in JSON format:
{
  "summary": "...",
  "locationInsights": [
    { "name": "...", "reasoning": "...", "strategy": "..." }
  ]
}

Be concise, honest, and spatially-aware. Prioritize real-world feasibility over raw scores.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 600,
    });

    const text = response.choices?.[0]?.message?.content;
    if (!text) {
      return sendJSON(res, 502, { error: 'OpenAI returned empty response' });
    }

    const parsed = JSON.parse(text);
    return sendJSON(res, 200, parsed);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[explain] OpenAI API error:', msg);
    return sendJSON(res, 500, { error: 'AI explanation generation failed', detail: msg });
  }
}
