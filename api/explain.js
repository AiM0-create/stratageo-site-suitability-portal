/**
 * Stratageo AI Explanation Endpoint
 *
 * Serverless function that calls OpenAI to generate business-context explanations
 * for pre-scored site suitability results.
 *
 * Deploy to: Vercel Functions, Netlify Functions, Cloudflare Workers, or similar.
 *
 * Environment variables required:
 *   OPENAI_API_KEY - Your OpenAI API key (server-side only)
 *
 * Request body (POST):
 * {
 *   businessType: string,
 *   city: string,
 *   locations: Array<{
 *     name: string,
 *     mcda_score: number,
 *     criteria_breakdown: Array<{ name: string, score: number, weight: number, justification: string }>,
 *     osmCounts: { competitors: number, transport: number, commercial: number, residential: number }
 *   }>
 * }
 *
 * Response:
 * {
 *   summary: string,
 *   locationInsights: Array<{ name: string, reasoning: string, strategy: string }>
 * }
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
  // CORS preflight
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
    const { businessType, city, locations } = req.body;

    if (!businessType || !city || !locations?.length) {
      return res.status(400).json({ error: 'Missing required fields: businessType, city, locations' });
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

    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: prompt,
      text: {
        format: {
          type: 'json_object',
        },
      },
      temperature: 0.3,
      max_output_tokens: 600,
    });

    const text = response.output_text;
    const parsed = JSON.parse(text);

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(parsed));
  } catch (error) {
    console.error('OpenAI API error:', error);
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'AI explanation generation failed' }));
  }
}
