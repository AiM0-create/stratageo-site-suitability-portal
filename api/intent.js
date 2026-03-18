/**
 * Stratageo AI Intent Parsing Endpoint
 *
 * Parses natural language business queries into structured analysis parameters.
 * Uses OpenAI gpt-4o-mini for cost-effective intent extraction.
 *
 * Request body (POST):
 * { prompt: string }
 *
 * Response:
 * {
 *   businessType: string,
 *   city: string,
 *   neighborhoods: string[],
 *   osmTags: string[]
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

    const systemPrompt = `Extract structured site analysis parameters from the user query. Respond in JSON:
{
  "businessType": "the type of business",
  "city": "the target city",
  "neighborhoods": ["3-4 specific candidate neighborhoods in that city"],
  "osmTags": ["OpenStreetMap tags for competitors, format: key=value"]
}
Be specific with neighborhood names. Use real neighborhoods in the given city.`;

    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      text: {
        format: {
          type: 'json_object',
        },
      },
      temperature: 0.2,
      max_output_tokens: 300,
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
