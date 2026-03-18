/**
 * OpenAI Connection Test Endpoint
 * GET /api/test-openai
 *
 * Sends a minimal prompt to OpenAI and returns the result.
 * If this fails, the entire AI pipeline is broken.
 */

import OpenAI from 'openai';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    return res.end();
  }

  // Step 1: Check env var
  if (!process.env.OPENAI_API_KEY) {
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: false,
      error: 'OPENAI_API_KEY not configured in environment',
      step: 'env_check',
    }));
  }

  // Step 2: Try to call OpenAI
  const startTime = Date.now();
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: 'You are a test endpoint. Return valid JSON: {"test": true, "message": "OpenAI is working"}' },
        { role: 'user', content: 'Confirm you are working.' },
      ],
      text: { format: { type: 'json_object' } },
      temperature: 0,
      max_output_tokens: 50,
    });

    const elapsed = Date.now() - startTime;
    const parsed = JSON.parse(response.output_text);

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      step: 'complete',
      openaiResponse: parsed,
      model: 'gpt-4o-mini',
      latencyMs: elapsed,
      keyPrefix: process.env.OPENAI_API_KEY.substring(0, 7) + '...',
      timestamp: new Date().toISOString(),
    }));

  } catch (error) {
    const elapsed = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);

    console.error('[test-openai] OpenAI call failed:', msg);

    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: false,
      step: 'openai_call',
      error: msg,
      latencyMs: elapsed,
      keyPrefix: process.env.OPENAI_API_KEY.substring(0, 7) + '...',
      timestamp: new Date().toISOString(),
    }));
  }
}
