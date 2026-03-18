/**
 * Health Check Endpoint
 * GET /api/health
 *
 * Returns deployment status and configuration (no secrets).
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    return res.end();
  }

  const status = {
    ok: true,
    timestamp: new Date().toISOString(),
    service: 'stratageo-api',
    version: '3.0',
    openaiKeyConfigured: !!process.env.OPENAI_API_KEY,
    nodeVersion: process.version,
    endpoints: ['/api/health', '/api/intent', '/api/explain', '/api/test-openai'],
  };

  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(status));
}
