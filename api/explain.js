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
    const { businessType, city, locations } = req.body;

    if (!businessType || !city || !locations?.length) {
      return sendJSON(res, 400, { error: 'Missing required fields: businessType, city, locations' });
    }

    const locationSummary = locations.map(loc =>
      `${loc.name} (score: ${loc.mcda_score}/10): ${loc.criteria_breakdown.map(c => `${c.name}: ${c.score}/10`).join(', ')}`
    ).join('\n');

    const prompt = `You are a concise geospatial business analyst for Stratageo, a site suitability consultancy.

Given these MCDA-scored locations for a "${businessType}" in ${city}:

${locationSummary}

Provide:
1. A 2-3 sentence executive summary comparing the locations
2. For each location: a 1-2 sentence reasoning and a 1-2 sentence strategic recommendation

Respond in JSON format:
{
  "summary": "...",
  "locationInsights": [
    { "name": "...", "reasoning": "...", "strategy": "..." }
  ]
}

Be concise, data-informed, and business-practical. Do not repeat score numbers. Do not use marketing hype.`;

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
