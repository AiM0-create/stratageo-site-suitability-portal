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
import { SYSTEM_PROMPT } from './_lib/intentPrompt.js';

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

    // Attach token usage for tracking
    const tokenUsage = response.usage || {};
    parsed._tokenUsage = {
      promptTokens: tokenUsage.prompt_tokens || 0,
      completionTokens: tokenUsage.completion_tokens || 0,
      totalTokens: tokenUsage.total_tokens || 0,
    };

    console.log(`[intent] SUCCESS in ${elapsed}ms: ${parsed.businessType} / ${parsed.sector} (${parsed.confidence}) [${tokenUsage.total_tokens || 0} tokens]`);
    return sendJSON(res, 200, parsed);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[intent] FAILED in ${elapsed}ms:`, msg);
    return sendJSON(res, 500, { error: 'Intent parsing failed', detail: msg, latencyMs: elapsed });
  }
}
