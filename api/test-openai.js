/**
 * OpenAI Connection Test Endpoint
 * GET /api/test-openai
 *
 * Sends a minimal prompt to OpenAI and returns the result.
 */

import OpenAI from 'openai';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

  if (!process.env.OPENAI_API_KEY) {
    return sendJSON(res, 500, {
      ok: false,
      error: 'OPENAI_API_KEY not configured in environment',
      step: 'env_check',
    });
  }

  const startTime = Date.now();
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a test endpoint. Return valid JSON: {"test": true, "message": "OpenAI is working"}' },
        { role: 'user', content: 'Confirm you are working.' },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 50,
    });

    const elapsed = Date.now() - startTime;
    const text = response.choices?.[0]?.message?.content;
    const parsed = text ? JSON.parse(text) : { error: 'empty response' };

    return sendJSON(res, 200, {
      ok: true,
      step: 'complete',
      openaiResponse: parsed,
      model: 'gpt-4o-mini',
      latencyMs: elapsed,
      keyPrefix: process.env.OPENAI_API_KEY.substring(0, 7) + '...',
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[test-openai] OpenAI call failed:', msg);

    return sendJSON(res, 500, {
      ok: false,
      step: 'openai_call',
      error: msg,
      latencyMs: elapsed,
      keyPrefix: process.env.OPENAI_API_KEY?.substring(0, 7) + '...',
      timestamp: new Date().toISOString(),
    });
  }
}
