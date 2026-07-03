# Changelog

All notable changes are documented here. Format: [SemVer](https://semver.org).

---

## [1.4.9] — 2026-07-03 — PlannerLite Smart Resource Gating

**Tests:** 513 backend passed · 44 frontend passed · **Readiness:** deployed to production

A YAGNI resource-optimization release. The v1.4.8 audit (`docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md`) found the pipeline ran the same generic checklist for nearly every prompt — buildability (railway/ghat/heritage/maidan, up to 5 sequential Overpass calls) fired for almost any commercial business type via an overly broad keyword regex, and water geometry was fetched even for briefs with zero water relevance. This release adds a minimal relevance gate in front of the existing pipeline — no engine rewrite, no new providers, no new APIs.

### Added
- **`PlannerLite`** (`backend-py/app/engine/planner_lite.py`) — `create_analysis_plan(spec)` returns an `AnalysisPlan` (required/optional/skipped stages, unsupported constraints, per-factor support labels, provider budgets) from deterministic rules over the already-validated spec text and fields. Deliberately not the full `AnalysisPlanner` architecture the audit sketched — a single pure function, no new classes beyond simple dataclasses.
- **Relevance rules**: water/corridor checks run only on a waterfront flag, a water-tagged corridor/exclusion, or water/river/lake/coastal language in the prompt; buildability runs only when water-relevant or the prompt signals land development (parcel/plot/construction/resort/warehouse/industrial/…) or explicit railway avoidance; routing runs only on an explicit route constraint or detected strict drive/walk-time phrasing; Places Aggregate/Details run only when Google-Places-sourced factors exist.
- **`analysisCompleteness`** in the result payload: `coreScoringComplete`, `buildabilityVerified`, `waterVerified`, `routeVerified`, `placesVerified`, `provisional`, `confidenceLevel` (H/M/L), `skippedStages`, `degradedStages`, `unsupportedConstraints`. Skipping an irrelevant stage never lowers confidence; a degraded *relevant* stage does and marks the result provisional.
- **`plannerPreview`** embedded in the spec at chat time (`services/llm.py`) — surfaces "what will be verified / what will be skipped / what cannot be verified" on the `SpecSummaryCard` **before** the user clicks Start analysis, in a new "Analysis scope" section.
- **`ResultsDrawer`** renders `analysisCompleteness`: skipped stages shown as resource-saving decisions (not errors), degraded stages as warnings, unsupported constraints as "not scored"; a provisional completeness verdict now also suppresses the green RECOMMENDED badge.
- **11 new backend tests** (`tests/test_v149_planner_lite.py`) covering plan rules for all four canonical prompts, including provider-call spy assertions proving zero Overpass geometry/named calls fire for cafe/supermarket/dark-kitchen when buildability/water are correctly skipped.

### Changed
- `config.py`: `APP_VERSION` → `1.4.9`; `ENGINE_VERSION` fallback → `stratageo-engine-00054`; `RELEASE_NAME` → "PlannerLite Smart Resource Gating".
- `package.json` / `package-lock.json`: version → `1.4.9`.
- Candidate `buildabilityStatus` now reports `"unchecked"` (rather than a fabricated "viable"/"weak" verdict) when the frontage check was planner-skipped.

### Not changed
- No new provider APIs, no background jobs, no confidence-weighted scoring formula, no new database/queue/dashboard — kept deliberately out of scope per the audit's phased roadmap. Result contract remains exactly `SUCCESS` / `NO_VIABLE_SITE` / `FAILED`.

---

## [1.4.8] — 2026-07-03 — Result Contract Stability & Google Provider Intelligence

**Tests:** 502 backend passed · 41 frontend passed · **Readiness:** deployed to production

This bump folds in the accumulated v1.4.1–v1.4.7 reliability fixes (shipped across several commits without an `APP_VERSION` bump) together with the new v1.4.8 Google provider integration.

### v1.4.7 — result contract stability (root-cause fix)
- **Root cause fixed**: `evidence_builder._build_excluded_mask` summed *every* value in `mask_stats`, but `buildabilityDegraded` / `providerDegraded` are lists — any degraded run (the common case after v1.4.6) crashed with `TypeError: unsupported operand type(s) for +: 'int' and 'list'` at evidence assembly, after the analysis had already computed. Fixed with an explicit whitelist of hex-removal counters (`safe_int_sum`).
- **Numeric scoring contract** (`engine/contracts.py`): `FactorValue`/`FactorResult`, `to_finite_float`, `normalize_0_1`, `aggregate_provider_values`, `validate_factor_result` — no list/dict/NaN/inf can reach a numeric scoring field; every factor is validated before final ranking.
- **Three-state result payload**: every terminal analysis is now exactly `status: "success" | "no_viable_site" | "failed"`. A `FAILED` payload carries `stage`, `errorCode`, `userMessage`, `retryable`, `jobRef` — no raw Python exception ever becomes the user-facing result.
- **Provider retry + circuit breaker**: `_degradable_call` gained bounded retry with jittered exponential backoff (never on timeout) and a per-job circuit breaker per provider family.
- **Frontend**: `resultNormalizer` renders the three states distinctly (`malformed` payload shows a `jobRef`); follow-up questions about existing results ("why is zone 2 lower?") no longer clear the results drawer — only a new analysis brief does.

### v1.4.8 — Google provider integration
- **Google Places API (New) provider layer** (`app/providers/`): Nearby Search / Text Search (New) as the primary POI source, legacy Nearby Search and OSM/Overpass retained as automatic fallback.
- **Places Aggregate (Area Insights)** refines top-candidate counts with `computeInsights(INSIGHT_COUNT)`. Self-disables (HTTP 403/404) and falls back to Places/OSM-derived counts if the Aggregate API is not enabled, out of quota, or lacks permission — never blocks an analysis.
- **Google Routes primary** for route-constraint validation (`computeRoutes`), ORS Directions retained as fallback; unavailable on both → constraint marked provisional/unavailable, **never** silently replaced by Euclidean distance.
- **Place Details (New)** enrich a capped set (`google_details_max_places_per_job`, default 6) of top evidence POIs with rating/review count/price level — evidence only, never scored.
- **Typed `ProviderResult` contract** for every external call: strict timeout, bounded retry (429/5xx/network only, exponential backoff + jitter, never on timeout), per-provider circuit breaker, per-job Google time budget, per-job request cache. No API keys or request headers are ever logged. Explicit minimal field masks everywhere (never `*`).
- New config flags (`enable_google_places_new`, `enable_google_places_aggregate`, `enable_google_place_details_new`, `enable_google_routes_validation`, plus off-by-default `enable_google_place_photos` / `enable_google_autocomplete` / `enable_google_search_along_route` / `enable_google_ai_summaries`) and timeout/budget settings.
- `providerDiagnostics.googleCalls` (provider/feature/status/elapsedMs/degradationReason) attached to every terminal payload.
- **28 new backend tests** (`tests/test_v148_google_providers.py`): field-mask audit, retry/backoff/breaker/budget/cache policy, fallback chains never raise, Aggregate→`FactorValue`, Text Search for ambiguous queries, Details cap, polyline decode, route-unavailable→provisional, photos/AI-summaries excluded from scoring, full end-to-end payload-contract check.
- Product correctness preserved: rent/footprint remain unverified for supermarket briefs; dark-kitchen drive-time never silently falls back to Euclidean; results remain candidate zones, never exact parcels.

### Changed
- `config.py`: `APP_VERSION` → `1.4.8`; `ENGINE_VERSION` fallback → `stratageo-engine-00053`; `RELEASE_NAME` → "Result Contract Stability & Google Provider Intelligence". `SPEC_VERSION` and `EVIDENCE_VERSION_PUBLIC` intentionally **not** bumped — neither wire schema changed structurally.
- `package.json` / `package-lock.json`: version → `1.4.8`.

---

## [1.4.0] — 2026-06-30 — Reliability Hardening — Honest Candidate Zones

**Branch:** `v1.4-reliability-hardening` · **Latest commit:** `dc0a478` · **Tests:** 420 passed · **Readiness:** `READY_FOR_REVIEW_ONLY`

### Core Principle
The portal must never imply more certainty than the data supports. v1.4.0 enforces this structurally — not just in the UI copy.

### Added
- **Constraint policy engine** (`engine/constraint_policy.py`): `evaluate_constraint_policy()` detects unverifiable hard constraints (rent, footprint, zoning, parcel availability, ownership). Returns `ConstraintPolicyResult` with validation checklist and enforcement level.
- **Constraint downgrade rule**: `downgrade_status_for_unverified()` mutates locations — RECOMMENDED → CANDIDATE_ZONE when any hard constraint is unverifiable. No candidate can ever be RECOMMENDED when rent/footprint/zoning is unverified.
- **Metro station resolver** (`engine/metro.py`): verified Kolkata Metro station list (35+ stations); OSM subway-tag detection; generic fallback with confidence tiers (`high → medium → low`). City auto-detected from prompt text.
- **Always-on deterministic reliability critic** (`engine/reliability_critic.py`): `run_deterministic_critic()` checks 10 failure modes independently of cost mode. `merge_with_llm_critic()` combines verdicts conservatively. Previously, no critic ran in `low` cost mode.
- **Score display policy** (`multi_score.py`): `displayScore` (rounded to nearest 0.5), `scoreBand` ("6.5–7.5"), `confidenceLabel` (High/Medium/Low), `confidenceReasons`, `closeBandWarning` when candidates are statistically indistinguishable.
- **Data coverage accounting** (`multi_score.py`): `compute_data_coverage()` returns `availableWeight`, `missingWeight`, `coverageRatio`, `missingCriticalLayers`. Coverage < 50% → unreliable; 50–65% → weak; missing ≥20% weight → weak.
- **LARGE_FORMAT_RETAIL archetype** (`canonical_archetypes.py`): for supermarket / hypermarket / discount store prompts. Factors: arterial proximity, residential catchment, competition density, commercial land density. Grid resolution 8. Misleading variables explicitly list rent and floor area as unverifiable.
- **Strict route detection** (`intent_parser.py`): `_STRICT_ROUTE_RE` detects "exactly within / strictly within / delivery drive"; `_STRICT_WALK_RE` detects "walking radius". New `RawIntent` fields: `hasStrictRouteConstraint`, `hasStrictWalkConstraint`, `hasStudentDemandSignal`.
- **Student demand improvements** (`canonical_archetypes.py`): expanded OSM tags for `student_catchment_proxy` (library, dormitory, training, language school); updated proxy warning explicitly stating MEDIUM confidence and that schools are weak demand proxies.
- **EvidenceTrail v1.4** (`models/evidence.py`): new schemas `ConstraintValidationEvidence`, `DataCoverageEvidence`, `RouteValidationEvidence`, `MetroValidationEvidence`, `ScoreDisplayPolicyEvidence`, `DeterministicCriticEvidence`. Also: `siteClaimLevel = "micro_market_zone"` and mandatory `disclaimer` field.
- **Health endpoint capability flags** (`routers/health.py`): `evidenceVersion`, `supportsStrictRouting`, `supportsTrafficAwareRouting`, `supportsVerifiedMetroLayer`, `criticMode`.
- **Provisional banner in UI** (`ResultsDrawer.tsx`): amber warning when constraints are unverifiable, expandable validation checklist, per-item status (✓ Verified / ? Unverifiable / ✕ Failed / ! Required / — N/A).
- **Screening disclaimer** in drawer (always visible): "H3 micro-market areas, not exact parcels or leasable sites."
- **State cleanup / activeJobId guard** (`App.tsx`): previous result, selectedLocations, heatmapType cleared on new analysis. `activeJobIdRef` discards stale poll responses from old jobs.
- **56 new tests** (`tests/test_v14_reliability.py`): constraint policy, score display, data coverage, student demand, metro resolution, strict route detection, deterministic critic, 4 canonical prompts, LARGE_FORMAT_RETAIL, evidence trail v1.4, health flags.
- **3 new documentation files**: `STRATAGEO_V1_4_RELIABILITY_FIX_REPORT.md`, `STRATAGEO_V1_4_TEST_RESULTS.md`, `STRATAGEO_V1_4_KNOWN_LIMITATIONS.md`.

### Changed
- `config.py`: APP_VERSION → 1.4.0; ENGINE_VERSION → `stratageo-engine-00047`; EVIDENCE_VERSION → 1.4.0; SPEC_VERSION → 2.3; RELEASE_NAME → "Reliability Hardening — Honest Candidate Zones".
- `analysis_status` now derived from always-on deterministic critic + optional LLM critic (conservative combination), not LLM critic alone. New status: `"provisional"` when constraints are unverifiable.
- Drawer title: "Ranked Locations" → "Ranked Candidate Zones".
- Location score display: `displayScore` (rounded 0.5) instead of raw `mcda_score`.
- `jobs.py` result payload: `constraintEnforcementLevel` now reflects actual policy result (not hardcoded `"advisory"`); `criticEnabled` is now always `true` (deterministic critic always runs); new fields `constraintPolicy`, `metroValidation`, `dataCoverage`, `siteClaimLevel`, `disclaimer`.
- `tests/test_config_v110.py`: version assertion → 1.4.0.
- `tests/test_evidence_trail.py`: EVIDENCE_VERSION assertion → 1.4.0.
- `package.json`: version → 1.4.0.

### Fixed
- Supermarket prompt (`discount supermarket in Sector V`) now selects `LARGE_FORMAT_RETAIL` archetype and correctly marks rent + footprint as PROVISIONAL rather than failing with `not_feasible`.
- **Metro exclusion geometry enforced (Critical Fix 1):** `detect_metro_exclusion()` + `metro_stations_to_pois()` replace OSM tag-based exclusion POIs with verified metro station coordinates **injected directly into the actual exclusion mask** (not just reported as metadata). Kolkata prompt: 30 verified stations injected before `scoring.exclusion_mask()` runs. Generic railway=station alone does NOT qualify as metro exclusion. Generic fallback explicitly declared with `confidence=low` and critic downgrade.
- **Strict route constraint enforcement (Critical Fix 2):** `route_policy.validate_strict_route_constraints()` called after route evaluation. "Exactly within / strictly within / delivery drive" phrases with no `routeConstraint` in spec → `route_unavailable` entry → recommendations withheld. routeConstraint present but no ORS/Google Routes → explicitly declares Euclidean not acceptable → withheld. **Strict route constraints cannot pass through Euclidean fallback under any code path** — the gate is enforced independently of the Pass-A Euclidean-proxy score.
- **Provisional banner bug fixed:** `isProvisional` in ResultsDrawer now reads `constraintPolicy.hasUnverifiableConstraints` directly. Previous implementation checked `analysisStatus === 'provisional'` which was never set (det_critic sets `verdict='weak'`, not `'provisional'`).
- Score precision: "7.1/10" is now shown as "7.0" with band "6.5–7.5" — no false precision.
- Previous analysis result no longer persists into new analysis start (state cleared deterministically).
- 28 new tests for metro geometry and strict route enforcement added (419 total at that point, all pass).

### Fixed — staging-style backend execution (commit `dc0a478`)
Running the four canonical prompts through the real `_run_analysis()` pipeline (bypassing the UI, since the local OpenAI key was expired and ORS/Google Places were not configured) surfaced four further bugs not caught by unit tests in isolation:
- **`_det_critic` used before assignment** — `UnboundLocalError` crash; `analysis_status` block read `_det_critic.verdict` before `run_deterministic_critic()` had run. Fixed by reordering `jobs.py` so the constraint policy and deterministic critic execute before `analysis_status` is computed.
- **`RawIntentMeta` missing `hasStrictRouteConstraint`** — the Pydantic model embedded in `SpecV2.rawIntent` silently dropped the field on `model_dump()`, so `route_policy.validate_strict_route_constraints()` never saw it in the real pipeline and the strict-route gate was permanently bypassed even though direct unit tests of `route_policy` (which pass a hand-built dict) passed. Added `hasStrictRouteConstraint`, `hasStrictWalkConstraint`, `hasStudentDemandSignal` to `RawIntentMeta`; added `test_hasStrictRouteConstraint_survives_spec_roundtrip` regression test.
- **`provisionalBadge` missing on existing `CANDIDATE_ZONE` locations** — only set when a location was downgraded from `RECOMMENDED`. `downgrade_status_for_unverified()` now badges every non-excluded location when `hasUnverifiableConstraints` is true, regardless of prior status.
- **Duplicate entries in `unverifiedHardConstraints`** — `route_unavailable` entries were double-counted under both "Route constraint:" and "Required data layer:" labels because `jobs.py` passed `required_missing=all_required_missing` (which already included `route_unavailable`). Fixed to pass the pure data-layer-only `required_missing` list.
- 420 total tests pass after these fixes (1 new regression test added).

### Not Done — full UI staging validation
The local `OPENAI_API_KEY` was expired and `ORS_API_KEY` / `GOOGLE_PLACES_API_KEY` were not configured, so the conversational chat→spec flow, the live ORS/Google Routes evaluation path, and the ResultsDrawer rendering (provisional banner, validation checklist, score bands, state cleanup) were **not** verified in a live browser session. Current readiness is `READY_FOR_REVIEW_ONLY` — not staging-validated, not production-ready.

---

## [1.3.0] — 2026-06-25 — Evidence Trail & Reproducible Site Selection Reports

### Added
- **EvidenceTrail schema** (`models/evidence.py`): audit-grade Pydantic v2 schema with `ProviderQueryEvidence`, `FactorEvidence`, `CandidateEvidence`, `ExclusionEvidence`, `ScoringEvidence`, `DataSnapshotEvidence`, `StudyAreaEvidence`.
- **Secret scrubbing** (`safe_dict()` + `_scrub_secrets()`): `evidenceTrail` payload recursively removes any key matching `api_key|authorization|token|secret|password`.
- **Evidence builder** (`engine/evidence_builder.py`): `QueryTracker` + builder functions for all evidence types.
- **Provider query tracking**: OSM Overpass (main fetch + water), Google Places (primary + backup), ORS (isochrones) — all recorded with feature counts, timestamps, bbox params (no secrets).
- **Exclusion ledger**: explicit `ExclusionEvidence` records for every H3-cell-batch mask (railway, water, corridor, ghat, protected) and every excluded candidate.
- **Factor evidence**: per-factor raw count, normalized score, and weighted contribution per candidate.
- **Candidate evidence**: per-candidate recommendation status, score breakdown, constraint checks, exclusion reasons.
- **Scoring evidence**: formula description, total/present weight, normalization method per factor, recommendation status rules, min viable score.
- **API endpoints**: `GET /api/v2/analyses/{jobId}/evidence` and `GET /api/v2/analyses/{jobId}/evidence.json`.
- **Evidence Trail section** in ResultsDrawer: collapsible with 7 sub-sections (identity, data sources, factor evidence, candidate breakdown, exclusion ledger, scoring formula, reproducibility + JSON export).
- **Evidence JSON export button** in UI: client-side download of `safe_dict()` evidence with no secrets.
- **TypeScript interfaces** for all evidence trail types in `src/types/index.ts`.
- **Config flag**: `enable_evidence_trail = True`.
- 36 new tests in `tests/test_evidence_trail.py` (34 pass, 2 skip).
- Docs: `V1.3_EVIDENCE_TRAIL_AUDIT.md`, `V1.3_EVIDENCE_SCHEMA.md`, `V1.3_REPRODUCIBILITY_LIMITATIONS.md`, `RELEASE_NOTES_v1.3.0.md`, `DEPLOYMENT_CHECKLIST_v1.3.0.md`.

### Changed
- `config.py`: APP_VERSION/ENGINE_VERSION → 1.3.0; RELEASE_NAME updated.
- `tests/test_config_v110.py`: version assertion updated to 1.3.0.
- `package.json`: version → 1.3.0.
- `README.md`: current version updated.

### Not changed
- All v1.2.0 deterministic planning safeguards preserved (planningFingerprint, canonical archetypes, temperature=0, seed=42).
- SPEC_VERSION remains "2.2".
- Model routing defaults unchanged.
- All v1.2.0 and earlier tests continue to pass.

---

## [1.2.0] — 2026-06-24 — Deterministic Planning & Constraint Enforcement Upgrade

### Added
- **Canonical archetype registry** (`engine/canonical_archetypes.py`): 10 frozen archetype schemas with stable factor keys, weights (summing to 100), catchment radii, and scoring curves. Archetypes: student_qsr_cafe, generic_qsr_cafe, premium_restaurant, dark_kitchen, clinic_healthcare, warehouse_logistics, ev_charger, retail_store, preschool_school, generic fallback.
- **Student QSR detection** (`detect_student_qsr()`): deterministic detection of student-oriented cafe prompts. The Ruby Crossing / EM Bypass prompt now reliably resolves to `student_qsr_cafe` with weights 32/27/18/14/9.
- **Deterministic planner** (`engine/deterministic_planner.py`): overrides LLM-generated structural spec fields (factor keys, weights, catchment) with canonical schema. LLM is retained only for explanation text and study area geocoding.
- **Prompt normalisation** (`normalize_prompt()`): stable lowercasing + place-name normalisation for reproducible fingerprinting.
- **Spec fingerprinting** (`planning_fingerprint()`, `spec_fingerprint()`): stable SHA-256-based hashes for same-prompt reproducibility verification.
- **Constraint enforcement records**: per-constraint `enforcementLevel` (hard_enforced / partially_enforced / advisory / not_enforced) and mechanism now stored in spec and result.
- **Relaxation options** (`build_relaxation_options()`): concrete ordered options when `validCount < requestedCount`.
- **No-reliable-recommendation banner** in ResultsDrawer: when all candidates are excluded, shows "No recommendable sites found. Excluded candidates are shown for inspection only."
- **Planning mode disclosure** in ResultsDrawer: shows "Deterministic" badge + planning fingerprint + any LLM weight overrides.
- **Config flags**: `STRATAGEO_DETERMINISTIC_PLANNING=true`, `STRATAGEO_SPEC_TEMPERATURE=0.0`, `STRATAGEO_SPEC_SEED=42`.
- **SpecV2 v2.2**: new fields `planningMode`, `archetypeSource`, `weightsSource`, `llmRole`, `planningFingerprint`, `specFingerprint`, `normalizedPrompt`, `constraintEnforcementRecords`, `llmSuggestedButNotApplied`, `relaxationOptions`.
- **Golden test suite** (`tests/golden/test_deterministic_planning.py`): 24 tests, same prompt × 5 runs asserts stable archetype/factors/weights/fingerprint.
- `docs/V1.2_NONDETERMINISM_AUDIT.md`, `docs/RELEASE_NOTES_v1.2.0.md`, `docs/DEPLOYMENT_CHECKLIST_v1.2.0.md`, `docs/V1.2_DETERMINISM_VERIFICATION.md`.

### Changed
- `llm.py`: temperature set to 0 (from 0.2) + seed=42 in deterministic mode; deterministic planner applied after LLM spec building at `framework`/`ready` stage.
- `models/spec.py`: version literal `"2.2"` added; new v1.2.0 fields.
- `config.py`: APP_VERSION/ENGINE_VERSION → 1.2.0; SPEC_VERSION → 2.2.

### Not changed
- All v1.1.2 / v1.1.1 / v1.0.3 safeguards preserved.
- Model routing unchanged (gpt-5.4-mini default).
- Cloud Run deployment config unchanged.

---

## [1.1.2] — 2026-06-24 — Water Tag Helper NameError Fix

### Fixed
- **`NameError: name '_is_water_tag' is not defined`** in `services/jobs.py` line 610. The helper `_is_water_tag` is defined in `models/spec.py` but was never imported into `jobs.py`. Any analysis that processed corridor water-tag checks (e.g. QSR cafe near road junction, any non-waterfront brief that still reaches the corridor loop) crashed with this NameError. **Fix:** added `_is_water_tag` to the import at `jobs.py` line 18. One-line change.
- **Trigger prompt:** "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass" — crashed the engine at the corridor loop even with no waterfront corridors.
- 21 new regression tests in `tests/test_water_tag_hotfix.py`.

### Not changed
- Model routing (gpt-5.4-mini / gpt-5.4-nano / gpt-5.4).
- Any spatial mask logic or water/buildability mask behavior.
- No new dependencies.

---

## [1.1.1] — 2026-06-24 — Cost-Aware Model Routing Refresh

### Changed
- **Model defaults updated to gpt-5.4 family** (`backend-py/app/config.py`):
  - `STRATAGEO_CHAT_MODEL`: `gpt-5.4-mini` (was `gpt-4o`)
  - `STRATAGEO_REASONING_MODEL`: `gpt-5.4-mini` (was `gpt-4o`)
  - `STRATAGEO_CRITIC_MODEL`: `gpt-5.4` (was `gpt-4o`)
  - `STRATAGEO_REPORT_MODEL`: `gpt-5.4-nano` (was `gpt-4o-mini`)
  - `STRATAGEO_FAST_MODEL`: `gpt-5.4-nano` (was `gpt-4o-mini`)
  - Escalation in `high` mode may use `gpt-5.5` for critic only (not Pro).
  - **No Pro models used anywhere.**
- Added `STRATAGEO_ENABLE_MODEL_FALLBACK`, `STRATAGEO_FALLBACK_CHAT_MODEL`, `STRATAGEO_FALLBACK_FAST_MODEL` — disabled by default.
- Version bumped: `APP_VERSION`, `ENGINE_VERSION` → `1.1.1`; `package.json` → `1.1.1`.

### Not changed
- Cost mode default still `low`; critic still off in `low` mode.
- All v1.1.0 and v1.0.3 features preserved.
- No dependency changes.

---

## [1.1.0] — 2026-06-24 — Universal Suitability Logic Upgrade

### Fixed (Phase 18 — production blocker)
- **"Uploaded points only" hard constraint now enforced.** Previously, "Only rank my uploaded CSV points" was detected by the parser but ignored by the engine, which ran a full H3 search. Now: (1) if `uploadedCandidatesOnly=True` and points are provided, the engine scores only those points using the MCDA factor framework — no H3 grid search; (2) if no points are provided, execution is **blocked** with a clear user-facing message; (3) `constraintEnforcementLevel` is set to `"enforced"` in all uploaded-only results.
- **Contradictory constraint detection** (`detect_contradictory_constraints()`): unit normalization bug fixed (m vs km were compared without conversion).
- **`validate_hard_constraints_in_spec`** wired as advisory check in `_run_analysis()` (was imported but never called).
- **Critic disclosure**: `criticEnabled`, `constraintEnforcementLevel`, `untracedConstraints` added to result JSON; shown in ResultsDrawer.
- **Cost mode default** corrected from `balanced` to `low` (Phase 16).
- **PDF version disclosure** added (app version, engine version, recommendation mode, site claim level).

### Added
- **Deterministic RawIntent parser** (`engine/intent_parser.py`): extracts output count, business type, geography, hard constraints, spatial relations, and feature classes from the raw prompt before the LLM sees it. Hard constraints that cannot be traced to a SpecV2 gate block execution.
- **Universal archetype registry** (`engine/archetypes.py`): 14 archetypes (QSR, premium restaurant, dark kitchen, clinic, hospital, preschool, gym, retail, warehouse, EV charger, hotel, office, industrial, generic fallback). Each archetype defines factor weights, scoring curves, misleading variables, and minimum viable evidence.
- **Scoring curve types**: `positive_linear`, `negative_linear`, `inverted_u`, `threshold_min/max`, `distance_decay`, `distance_band`, `opportunity_gap`, `complementarity`, `binary_gate`.
- **Multi-dimensional scoring**: `relativeRankScore`, `absoluteViabilityScore`, `confidenceScore` alongside the existing `compositeScore`. Recommendation mode gated on all three.
- **SpecV2 v2.1 extensions** (backward-compatible): `rawIntent`, `analysisMode`, `recommendationMode`, `scoreSemantics`, `modelDisclosure`, `confidence`, `siteClaimLevel`, `output.requestedTopNRaw/topNResolved/topNReason/outputCountWarning`.
- **Cost-aware model routing** (Phase 9): `STRATAGEO_CHAT_MODEL`, `STRATAGEO_REASONING_MODEL`, `STRATAGEO_CRITIC_MODEL`, `STRATAGEO_REPORT_MODEL`, `STRATAGEO_FAST_MODEL`, `STRATAGEO_ENABLE_MODEL_ESCALATION=false`, `STRATAGEO_MAX_LLM_COST_MODE=balanced`. All default to existing production models — zero config change needed.
- **`/health` extended**: returns `appVersion`, `apiVersion`, `engineVersion`, `specVersion`, `releaseName`, `modelConfig`, `costMode`, `featureFlags`.
- **Output count from RawIntent**: default 3, user-specifiable 1–10, cap at 10 with warning. Chat box no longer shows a result-count stepper.
- **Universal critic contract**: returns `shouldWithholdRecommendations`, `recommendationModeOverride`, `downgrades`, `confidenceAdjustment`, `requiredFixes`, `userFacingWarning`.
- **Upgraded recommendation labels**: `RECOMMENDED`, `CANDIDATE_ZONE`, `WEAK_CANDIDATE`, `RAW_DIAGNOSTIC`, `EXCLUDED`, `NO_RELIABLE_RECOMMENDATION` replacing simple STRONG/VIABLE/WEAK.
- **Frontend type extensions**: `AnalysisResult` and `LocationData` carry new v1.1.0 fields. ResultsDrawer shows Rank Score, Absolute Viability, and Confidence alongside composite score.
- `docs/upgrade_backups/V1.1.0_BASELINE.md` — rollback reference.
- `docs/RELEASE_NOTES_v1.1.0.md` — full release narrative.
- `docs/DEPLOYMENT_CHECKLIST_v1.1.0.md` — staging / deployment checklist.

### Changed
- `config.py`: all model names now configurable via env vars; cost-mode tiers control LLM call budget.
- `health.py`: richer version + model metadata.
- `main.py`: version read from `config.APP_VERSION`.
- `services/prompts.py`: universal consultant prompt covering all 14 archetypes, `siteClaimLevel`, `recommendationMode`, and cost-aware output.
- `services/critic.py`: upgraded critic JSON contract with deterministic result application.
- Frontend `FloatingAssistant`: result-count stepper removed; count comes from RawIntent.
- Frontend `ResultsDrawer`: new score columns + recommendation status display.
- Frontend `MapView`: pin colour/glyph driven by `recommendationMode` not just composite score.

### Fixed
- Recommendation language: "Best locations" replaced with "Recommended candidate zones" unless `siteClaimLevel=parcel_site`.
- Competition logic: inverted-U scoring curve; zero competition + weak demand correctly penalised.

### Not changed / preserved
- Existing SpecV2 v2.0 fields: fully backward-compatible — old saved analyses load correctly.
- Cloud Run deployment config: unchanged.
- All v1.0.3 spatial reliability safeguards (waterfront corridor, buildability masks, viability gate, etc.): active and untouched.

---

## [1.0.3] — 2026-06 — Spatial Reliability Upgrade

See `SPATIAL_RELIABILITY_UPGRADE_REPORT.md`.

---

## [1.0.1] — 2026-05 — Conversational Mode

First multi-turn conversational analysis flow.

---

## [1.0.0] — 2026-04 — Initial Release

Single-prompt direct analysis mode.
