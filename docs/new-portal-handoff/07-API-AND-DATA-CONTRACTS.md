# 07 — API and Data Contracts

Reduced examples — interpreted, not full schema dumps. Sources cited per
contract. All routes are under the Cloud Run backend; the frontend base is
`config.pyBackendUrl`.

## API reference

### `GET /health` — `routers/health.py`
- **Purpose:** version + capability/feature flags for the frontend + smoke
  checks. **Auth:** none (exempt from `X-App-Token`).
- **Response (abridged):**
  ```json
  {"ok": true, "appVersion": "1.8.0", "engineVersion": "stratageo-engine-00070-92f",
   "releaseName": "Screening & Investigation-Zone Product Contract",
   "specVersion": "2.3", "evidenceVersion": "1.4.0", "costMode": "low",
   "featureFlags": {"deterministicPlanning": true, "...": true},
   "hasOpenAiKey": true, "hasGooglePlacesKey": true, "hasGoogleRoutesKey": true,
   "hasOrsKey": true, "supportsStrictRouting": true, "supportsTrafficAwareRouting": true}
  ```
- **New portal relevance:** keep a `/health` with version + capability flags;
  drop the legacy duplicate keys (`hasOpenAIKey`, `hasPlacesKey`).

### `POST /api/v2/chat` — `routers/chat.py`
- **Purpose:** one conversational planning turn. **Auth:** `enforce_auth_and_quota(consume=False)` (no-op while `REQUIRE_USER_AUTH=false`); `X-App-Token` via middleware; optional `Authorization: Bearer <firebase>`.
- **Request** (`models/chat.ChatRequest`): `{ messages: [{role, content}], spec?: draft, context?: {resultCount, csvPointCount} }`.
- **Response** (`ChatResponse`): `{ ok, reply, stage: chat|framework|ready, spec?, specStatus, readyToExecute, feasibility?, unsupported[], specValid, specValidationError?, model, usage? }`.
- **Errors:** 400 (bad messages), 503/502/504 typed provider failures with `{message, errorCode, requestId}`.
- **New portal relevance:** **core.** This is the LLM planning turn; the new
  portal keeps it but the LLM emits the *final* methodology (no override).

### `POST /api/v2/analyses` — `routers/analyses.py`
- **Purpose:** start an analysis job from a validated spec. **Auth:** identity checked (`consume=False`), then one credit consumed (`consume=True`) only after validation.
- **Request:** `{ spec: SpecV2 }`.
- **Response:** `{ ok: true, jobId }` (async).
- **Errors:** 409 `not_feasible`; 422 invalid/empty-layer spec; 402 quota; 401 auth (when on).
- **New portal relevance:** **core.**

### `GET /api/v2/analyses/{jobId}` — status/poll
- **Response:** `{ ok, status: queued|running|done|error|cancelled|timeout, progress, phase, message, result?, error? }`. **New portal:** core.

### `POST /api/v2/analyses/{jobId}/cancel`
- Always 200 with a safe payload. **New portal:** core (cooperative cancel).

### `GET /api/v2/analyses/{jobId}/evidence` and `.../evidence.json`
- Evidence trail for a completed job (409 if not done). **New portal:** later.

## Frontend deployment configuration

- **Backend URL:** `VITE_PY_BACKEND_URL` + `VITE_CONVERSATIONAL_MODE=1` selects
  the Cloud Run path (`config.isConversationalMode`). `VITE_AI_BACKEND_URL`
  points at a **vestigial Vercel Node API** — not on the live path; do not
  carry forward.
- **CORS:** backend allows `origins_list` (from `FRONTEND_ORIGINS`), methods
  `GET/POST/OPTIONS`, headers `Content-Type, X-App-Token, Authorization`.
- **App token:** `VITE_APP_TOKEN` → `X-App-Token` header; verified against
  `APP_SHARED_TOKEN`. Rotatable kill-switch (ships in bundle, not a true
  secret). **Trap:** the GH secret and the Cloud Run env var must rotate
  together or the live portal 401s.
- **Firebase:** inlined public config; only relevant if the new portal keeps
  Firebase (recommended: don't, for MVP).

## Key data contracts

### SpecV2 (analysis specification) — `models/spec.py`
The single largest contract (~680 lines, ~40 top-level fields). Structural
core: `objective, businessType, studyArea, grid, layers[], exclusions[],
corridors[], routeConstraints[], output, execution, constraints[],
feasibility`. Everything else is **transparency/audit metadata** accreted over
v1.1–v1.8: `rawIntent, outputCount, canonicalWeights, weightsAdjustedByUser,
searchRadiusOverrideM, gridResolutionAdjustedByUser, analysisMode,
recommendationMode, scoreSemantics, siteClaimLevel, archetypeKey,
planningMode, archetypeSource, weightsSource, planningFingerprint,
specFingerprint, normalizedPrompt, llmSuggestedButNotApplied, relaxationOptions,
userCandidatePoints, uploadedCandidatesOnly`.
- **`version` literal:** `"2.0"|"2.1"|"2.2"` (default `2.2`) — decoupled from
  the public `SPEC_VERSION="2.3"`.
- **New portal:** define a **leaner spec** — keep the structural core + the
  v1.8.0 additions that matter (`scoringCurve` per layer). Drop the
  determinism-fingerprint fields (`planningFingerprint`, `archetypeSource`,
  `llmSuggestedButNotApplied`, `normalizedPrompt`) — they exist to audit the
  registry override the new portal won't have.

### Layer / Catchment / Normalization
See `04`. New-portal-relevant fields: `id, name, weight, direction, source,
catchment, normalization{method,pLow,pHigh}, scoringCurve, required,
confidence, proxyWarning`. Backward-compat-only: the `_canonical`,
`_canonicalKey`, `_scoringCurve` underscore fields injected by
`to_layers_dict` — **do not copy.**

### Analysis result — `results.py` docstring + `types/index.ts`
Three-state top level: `status: success|no_viable_site|failed`. Success
payload (abridged):
```json
{"status":"success","analysisId":"analysis_xxx","jobRef":"xxxxxxxx",
 "candidates":[Location...],"locations":[Location...],   // legacy dup
 "hexGrid":[HexCell...],"catchments":[...],"studyAreaBoundary":[[lat,lng]...],
 "summary":"...","business_type":"...","target_location":"...","methodology":"...",
 "dataSufficiency":{...},"dataQuality":[{name,provider,weight,featureCount,lowCoverage,dataStatus}],
 "unifiedConfidence":{"level":"Medium","reason":"...","components":{...}},
 "analysisRecommendation":"RECOMMENDED_INVESTIGATION_ZONE",
 "claimLevel":"investigation_zone","siteClaimLevel":"micro_market_zone",
 "constraintPolicy":{...},"hardConstraintVerification":{...},
 "analysisCompleteness":{...},"analysisIntelligence":{"spatialScale":"micro_market",...},
 "weightAudit":{"adjustedByUser":false,"defaultWeights":{},"executedWeights":{}},
 "evidenceTrail":{...},"maskStats":{...},"providerDiagnostics":{...}}
```
- **`candidates` vs `locations`:** duplicated for wire-compat — **new portal:
  pick one.**
- **`no_viable_site`** adds `reason, failedGates[], relaxationSuggestions[]`.
- **`failed`** is `{status, stage, errorCode, userMessage, retryable, jobRef}`.

### Candidate / investigation zone (`Location`) — `types/index.ts`
Core: `name, lat, lng, mcda_score, criteria_breakdown[], exclusions[],
excluded, reasoning, osmSignals, searchRadiusM`. Screening (v1.8.0):
`screeningVerdict, nextValidation[], scoreWithheld, screeningScore,
rankingBasis, investigationLabel`. Evidence/verification: `recommended,
riverDistanceM, inWaterfrontCorridor, hardConstraintPass, routeMetrics,
trafficContext, stabilityLabel, hardConstraintWarnings, provisionalReasons`.
Multi-score: `relativeRankScore, absoluteViabilityScore, confidenceScore,
recommendationStatus`.
- **New portal keep:** name/lat/lng/mcda_score/criteria/screeningVerdict/
  nextValidation/excluded/reasoning/scoreWithheld. **Drop:** the multi-score
  triple (relative/absolute/confidence) unless a use-case demands it — it
  overlaps `unifiedConfidence`.

### MCDA criterion (`criteria_breakdown[]`)
`{name, weight, score|null, rawValue|null, direction, required,
justification, evidenceBasis, scoringCurve?, dataStatus?, comparative?,
lowConfidenceProxy?, osmQuery?}`. `score:null` = no data (must survive
render). **New portal keep** as-is conceptually.

### Confidence — `unified_confidence.py`
`{level: High|Medium|Low, reason, components:{dataSufficiency, reliabilityCritic},
method:"conservative-min"}`. **New portal keep** — the conservative-min merge is
a keeper.

### Screening verdict + next validation — `screening_contract.py`
Verdict projected from `investigationLabel`; `nextValidation` generated from
run state. **New portal:** extract this module (adapt to the new label source).

### Weight audit — `jobs.py`
`{adjustedByUser, defaultWeights, executedWeights}`. In the new portal
"default" = the LLM's first proposal; still useful for "you changed X".

### Job status — `types/chat.ts` `AnalysisJobStatus`
`{status, progress, phase, message, result?, error?}`. **New portal keep.**
