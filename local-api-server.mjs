/**
 * local-api-server.mjs
 *
 * Standalone local dev API server. Imports the actual Vercel function
 * handlers and wraps them in a standard Node http server so you can test
 * without relying on `vercel dev`.
 *
 * Usage:
 *   node local-api-server.mjs          # listens on port 3000
 *   PORT=3001 node local-api-server.mjs
 *
 * Env: reads .env.local automatically (same values vercel dev would use).
 */

import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local so OPENAI_API_KEY is available ────────────────────────────
function loadEnvLocal() {
  const envPath = resolve(__dirname, '.env.local');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    process.env[key] = val; // .env.local always wins, even over system env
  }
}
loadEnvLocal();

// ── Parse request body ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { req.body = JSON.parse(raw); } catch { req.body = {}; }
      resolve();
    });
  });
}

// ── Route table ──────────────────────────────────────────────────────────────
//
// Each entry: [urlPattern, handlerModulePath]
// Patterns are matched by exact path (query string stripped).
//
const ROUTES = [
  ['/api/health',     './api/health.js'],
  ['/api/analyze',    './api/analyze.js'],
  ['/api/intent',     './api/intent.js'],
  ['/api/explain',    './api/explain.js'],
  ['/api/places',     './api/places.js'],
];

// Pre-import all handlers so startup errors surface immediately
const handlers = {};
for (const [path, mod] of ROUTES) {
  try {
    const { default: fn } = await import(mod);
    handlers[path] = fn;
    console.log(`[api-server] loaded handler: ${path}`);
  } catch (err) {
    console.error(`[api-server] FAILED to load handler ${path}: ${err.message}`);
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer(async (req, res) => {
  await readBody(req);

  const urlPath = (req.url || '/').split('?')[0];
  console.log(`[api-server] ${req.method} ${urlPath}`);

  const handler = handlers[urlPath];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found', path: urlPath }));
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[api-server] unhandled error in ${urlPath}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Handler threw', detail: err.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n[api-server] Ready at http://localhost:${PORT}`);
  console.log('[api-server] OPENAI_API_KEY configured:', !!process.env.OPENAI_API_KEY);
  console.log('[api-server] Loaded routes:', Object.keys(handlers).join(', '));
  console.log('\nTest commands:');
  console.log(`  curl http://localhost:${PORT}/api/health`);
  console.log(`  curl -s -X POST http://localhost:${PORT}/api/analyze \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"prompt":"cafe in HSR Layout Bengaluru","debug":true}' | jq .`);
  console.log('');
});
