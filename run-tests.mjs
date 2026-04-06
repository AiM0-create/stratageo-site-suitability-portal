/**
 * run-tests.mjs — Offline test harness for /api/analyze
 * Run with: node run-tests.mjs
 * Requires local-api-server.mjs to be running on port 3000
 */

const BASE = 'http://localhost:3000';
const TIMEOUT_MS = 90_000;

const TESTS = [
  {
    id: 'A_exclusion',
    label: 'A. Exclusion / South Mumbai',
    prompt: 'I want to open a high-end gym in South Mumbai. I already have branches in Colaba and Worli. Suggest 3 new locations but exclude my existing areas.',
    resultCount: 3,
  },
  {
    id: 'B_microlocal',
    label: 'B. Micro-locality / JP Nagar',
    prompt: 'Analyze JP Nagar 2nd Phase in Bengaluru for a small organic grocery store.',
    resultCount: 3,
  },
  {
    id: 'C_sparse',
    label: 'C. Sparse-data / Industrial Nagpur',
    prompt: 'Suggest 3 locations for a heavy machinery spare parts warehouse in the industrial outskirts of Nagpur. Focus on proximity to NH44.',
    resultCount: 3,
  },
  {
    id: 'D_weighting',
    label: 'D. Weighting / Budget coffee Pune',
    prompt: 'Find 3 locations for a budget coffee shop chain in Pune. Rank them primarily on Student Population and Low Rent.',
    resultCount: 3,
  },
  {
    id: 'E_rerank',
    label: 'E. Reversed weighting / Affluence over Students',
    prompt: 'Actually, I now care more about Affluence than Student Population. Reverse the priorities and tell me how the ranking changes.',
    resultCount: 3,
  },
  {
    id: 'F_absurd',
    label: 'F. Zero-data / Thar Desert',
    prompt: 'Find a retail location in the middle of the Thar Desert.',
    resultCount: 3,
  },
  {
    id: 'G_hinglish',
    label: 'G. Hindi/Hinglish / Pune coffee',
    prompt: 'Pune me coffee shop ke liye achchi jagah batao jahan rent kam ho aur student crowd ho.',
    resultCount: 3,
  },
];

async function callAnalyze(prompt, resultCount = 3, debug = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, resultCount, debug }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, ok: res.ok, json, latencyMs: Date.now() - start, rawText: text };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, ok: false, json: null, latencyMs: Date.now() - start, error: err.message };
  }
}

function summarise(result, testId) {
  const { status, json, latencyMs, error } = result;
  if (error) return { testId, status, error, latencyMs };

  const isValidJson = json !== null;
  const pipelineOk = json?.ok === true;
  const city = json?.parsedCity ?? '—';
  const business = json?.parsedBusinessType ?? '—';
  const ranked = json?.rankedLocations ?? [];
  const warnings = json?.warnings ?? [];
  const confidence = json?.confidenceScore ?? '—';
  const hasExplanation = !!json?.explanation?.summary;
  const exclusions = json?.parsedExclusions ?? [];
  const penalties = json?.penaltiesApplied ?? [];
  const candidatesBefore = json?.candidateLocationsBeforeFiltering?.length ?? 0;
  const candidatesAfter = json?.candidateLocationsAfterFiltering?.length ?? 0;
  const hasSparseWarning = warnings.some(w => w.toLowerCase().includes('sparse'));
  const errorMsg = json?.error ?? null;

  return {
    testId,
    status,
    isValidJson,
    pipelineOk,
    city,
    business,
    rankedCount: ranked.length,
    topLocations: ranked.slice(0, 3).map(l => `${l.name}(${l.mcdaScore?.toFixed(2) ?? '?'})`).join(', '),
    warningCount: warnings.length,
    warnings: warnings.slice(0, 3),
    confidence,
    hasExplanation,
    exclusionCount: exclusions.length,
    exclusionPenalties: penalties.filter(p => p.type === 'named_area_exclusion').length,
    candidatesBefore,
    candidatesAfter,
    hasSparseWarning,
    latencyMs,
    errorMsg,
  };
}

async function runRepeatability(prompt, runs = 4) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`REPEATABILITY: "${prompt.slice(0, 60)}..."`);
  const topNames = [];
  for (let i = 0; i < runs; i++) {
    const r = await callAnalyze(prompt, 3);
    const top = r.json?.rankedLocations?.[0]?.name ?? 'NONE';
    const score = r.json?.rankedLocations?.[0]?.mcdaScore?.toFixed(2) ?? '?';
    topNames.push(top);
    console.log(`  Run ${i+1}: #1=${top} (${score}) | ${r.latencyMs}ms`);
  }
  const unique = new Set(topNames).size;
  console.log(`  Stability: ${unique === 1 ? '✓ STABLE' : `⚠ ${unique} different top-1s across ${runs} runs`}`);
  return topNames;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log('STRATAGEO /api/analyze TEST SUITE');
console.log('='.repeat(60));

const results = [];

for (const test of TESTS) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${test.label}`);
  console.log(`Prompt: "${test.prompt.slice(0, 80)}..."`);

  const r = await callAnalyze(test.prompt, test.resultCount, true);
  const s = summarise(r, test.id);

  console.log(`  HTTP: ${s.status} | JSON: ${s.isValidJson} | ok: ${s.pipelineOk} | ${s.latencyMs}ms`);
  if (!s.pipelineOk) {
    console.log(`  ERROR: ${s.errorMsg}`);
    if (r.json?.warnings?.length) console.log(`  WARNINGS: ${r.json.warnings.join('; ')}`);
  } else {
    console.log(`  City: ${s.city} | Business: ${s.business} | Confidence: ${s.confidence}`);
    console.log(`  Candidates: ${s.candidatesBefore} → ${s.candidatesAfter} | Ranked: ${s.rankedCount}`);
    console.log(`  Top: ${s.topLocations}`);
    console.log(`  Exclusions parsed: ${s.exclusionCount} | Penalties applied: ${s.exclusionPenalties}`);
    console.log(`  Warnings (${s.warningCount}): ${s.warnings.slice(0,2).join(' | ') || 'none'}`);
    console.log(`  Sparse flag: ${s.hasSparseWarning} | Explanation: ${s.hasExplanation}`);
  }
  results.push(s);

  // Rate-limit pause between tests
  await new Promise(r => setTimeout(r, 2000));
}

// Repeatability test using prompt D
await runRepeatability(TESTS[3].prompt, 4);

// ── Summary table ─────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log('SUMMARY TABLE');
console.log('='.repeat(60));
console.log('ID            | HTTP | JSON | ok | City           | Business       | Ranked | Excl | Sparse | Expl | ms');
console.log('─'.repeat(110));
for (const s of results) {
  const city = (s.city ?? '—').slice(0,14).padEnd(14);
  const biz  = (s.business ?? '—').slice(0,14).padEnd(14);
  const id   = s.testId.padEnd(13);
  console.log(
    `${id} | ${String(s.status).padStart(4)} | ${s.isValidJson?'✓':'✗'}    | ${s.pipelineOk?'✓':'✗'}  | ${city} | ${biz} | ${String(s.rankedCount??0).padStart(6)} | ${String(s.exclusionPenalties??0).padStart(4)} | ${s.hasSparseWarning?'✓':'✗'}      | ${s.hasExplanation?'✓':'✗'}    | ${s.latencyMs}`
  );
}
console.log('\nDone.');
