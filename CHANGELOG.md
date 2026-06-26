# Changelog

All notable changes are documented here. Format: [SemVer](https://semver.org).

---

## [1.4.0] — 2026-06-26 — Google Maps Isochrones, Adaptive H3 Resolution & Chat UX

### Added
- **Google Maps isochrones (primary, ORS fallback)**: `fetch_isochrones()` now uses Google Routes `computeRouteMatrix` to sample reachability points and build a convex-hull polygon per candidate. ORS used as fallback per cell when Google fails; Euclidean proxy is the final fallback. Backward-compatible `_rate_limit` alias preserved for `routing.py`.
- **`LARGE_FORMAT_RETAIL` canonical archetype** for supermarkets/hypermarkets/discount stores: drive-reachable residential demand (12-min), supermarket competition (10-min drive), commercial land density (euclidean 400m), office daytime demand (10-min drive). Default topN=5, grid res 8.
- **`discount_supermarket` and `supermarket` intent parser patterns** → maps to `large_format_retail`.
- **Adaptive H3 grid resolution by archetype**: walk/micro-market archetypes (cafe, QSR, retail, preschool) keep res 9; drive-catchment/logistics archetypes (clinic, dark kitchen, warehouse, EV charger, large-format retail) use res 8.
- **Default OSM tags + Places types in `to_layers_dict()`**: canonical archetype layers now populate sensible default tags/types so no layer is ever submitted with an empty source (prevents 422 spec validation errors).
- **Spec repair in `analyses.py`**: `_repair_spec_layers()` strips any remaining empty-source layers before SpecV2 validation, with a clear error if all layers are dropped.
- **Per-message action buttons** (chat UI): copy, edit-and-resend, share-prompt appear on hover for every message.
- **Inline "Run Analysis" prompt**: when `chatReady && chatStage === 'ready'`, a green "Run Analysis" button appears inline in the chat flow — no need to type "run".
- **Tour auto-start for new non-admin users**: guided tour fires 1.2 s after first login; `localStorage` flag prevents repeat. Admins always skip.
- **Responsive tour positioning**: tooltip clamps to viewport on all screen sizes; mobile collapses to bottom-center panel.

### Changed
- Business type sector picker removed from chat input bar.
- System prompt P7: "not_feasible" example changed from the supermarket/rent scenario to a genuinely contradictory constraint; rent/financial caps explicitly documented as UNVALIDATABLE → tradeoffs, never not_feasible.
- `APP_VERSION` / `ENGINE_VERSION` → `1.4.0`.
- `RELEASE_NAME` updated.
- README: version, scoring description, v1.4 highlights table.

### Not changed
- All v1.3.0 evidence trail features preserved.
- All v1.2.0 deterministic planning features preserved.
- Model routing defaults unchanged.
- SPEC_VERSION remains `2.2`.

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
