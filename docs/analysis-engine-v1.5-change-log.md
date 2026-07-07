# Analysis Engine v1.5 Lite — Change Log

**Scope:** "Analysis Intelligence v1.5 Lite" — a lightweight reasoning layer on top of the existing pipeline. Strict YAGNI: no new providers, no new APIs, no engine rewrite, no heavy buildability, no pan-India rent logic, no live traffic.

**Baseline:** v1.4.9 (`master @ 5dd5aee`), 513 backend / 44 frontend tests passing before this work.

---

## Pre-implementation audit result (what already existed)

Much of the v1.5 brief was already implemented in v1.4.x; those parts were **verified with tests, not rewritten**:

| Brief part | Already existed as | Action taken |
|---|---|---|
| 1. Prompt → stable spec | `intent_parser.py` (RawIntent), `canonical_archetypes.py`, `deterministic_planner.py`, `planner_lite.py` (v1.4.9) | Extended with a classification layer (see below) |
| 2. Archetype factor templates + deterministic weights | `canonical_archetypes.py` — 11 frozen archetypes, LLM cannot override weights/factors | Nothing changed; scenario variants added in `stability.py` |
| 3. Hard gates before scoring / unknowns disclosed | exclusion masks pre-scoring, route gates require proven pass, `constraint_policy.py`, v1.4.9 unsupported-constraint labels | Verified via new tests |
| 4. Buildability Lite | v1.4.9 planner-gated buildability (30s per-call ceilings, degradable, skipped when irrelevant) **is** the lite version | See "deliberate non-changes" |
| 5. Routing discipline | planner-gated routing (route constraint / strict phrasing only), budgets, never-silent-Euclidean, `routeProvider` labels | Verified via new tests |
| 8. Budgets/caching/degradation | 240s job ceiling, per-call timeouts, Google budget, GCS + in-memory caches, circuit breaker, `_degradable_call` | Nothing changed |

---

## Changes

### 1. `backend-py/app/engine/planner_lite.py` — intelligence classification

- **What:** added a deterministic classification assembled at plan time: `businessArchetype` (8-family mapping from the canonical archetype key, regex fallback), `locationIntent` (priority: riverfront → within_travel_time → between_landmarks → near_anchor → along_corridor → outside_exclusion_zone → inside_locality → unspecified), `riskTriggers` (waterfront / large_floorplate / regulated_use / delivery_time_sensitive / strict_boundary / primary_arterial_required / rent_cap), `analysisMode` (strict_corridor / routing_required / buildability_lite_required / large_format_screening / fast_screening), `hardGates` (each with its verification class), `softFactors` (each with factor family + proxy/observed support), `unknownConstraints`. Also added the shared `_factor_family()` classifier and exposed archetype/mode/riskTriggers in the spec-card preview.
- **Why:** Part 1/2 of the brief — a stable, inspectable spec grammar without touching what actually runs. Pure metadata; the v1.4.9 stage gates remain the only behavioral decisions.
- **Risk:** low — additive fields; no stage-gating logic changed.
- **Tested:** `test_v15_intelligence.py` — exact classification pinned for all four canonical prompts + run-to-run determinism test.
- **Rollback:** remove the `intelligence` field + `_classify_intelligence` block; nothing else depends on it except payload keys below.

### 2. `backend-py/app/engine/stability.py` — NEW (ranking stability, Part 7)

- **What:** `compute_ranking_stability(scores, finals)` re-ranks ONLY the final shortlist (≤ topN) under 4 controlled scenarios (`balanced`, `demand_led`, `access_led`, `competition_sensitive` — family-weight × 1.5, renormalized). Labels: `ROBUST_TOP_CANDIDATE` (top-1 in all), `STABLE_TOP_3` (top-3 in all), `SCENARIO_SENSITIVE` (top-3 in ≥ half, note names the scenario that drops it), `WEAK_UNSTABLE`, `NOT_ENOUGH_CANDIDATES` (< 2 candidates). Never raises (returns `{}` on internal failure).
- **Why:** Part 7 — cheap sensitivity, not Monte Carlo. ≤5 candidates × 4 scenarios × ≤6 layers of pure local arithmetic over already-validated floats; zero provider calls.
- **Risk:** low — informational only; never changes exclusion, scoring, or ranking.
- **Tested:** dominant-candidate → ROBUST, single-candidate → NOT_ENOUGH_CANDIDATES, garbage-input → `{}`, family classifier unit tests, e2e presence assertions.
- **Rollback:** delete the module + its 12-line attach block in `jobs.py`.

### 3. `backend-py/app/services/jobs.py` — payload wiring

- **What:** (a) attach per-candidate `stabilityLabel`/`scenarioRanks`/`stabilityNote` after the v1.4.0 downgrade step; (b) build `dataSufficiencyV2` (geocoding / boundary_or_corridor / demand_data / competition_data / road_access / routing / buildability_lite each verified·proxy·unknown·degraded·not_required, hard-constraint verified/unknown/failed counts, provider health, `final_confidence` + human-readable reason) — assembled **entirely from state the run already computed**; (c) per-candidate `investigationLabel` + analysis-level `analysisRecommendation` using the Part-9 taxonomy (`RECOMMENDED_INVESTIGATION_ZONE` / `PROVISIONAL_CANDIDATE` / `WEAK_CANDIDATE` / `NO_RELIABLE_RECOMMENDATION` / `NO_VIABLE_SITE_IN_CONSTRAINTS`); a `RECOMMENDED` status is demoted to `PROVISIONAL_CANDIDATE` when the analysis is provisional **or** the candidate is `WEAK_UNSTABLE` under scenario stability; (d) three additive payload keys: `analysisIntelligence`, `dataSufficiencyV2`, `analysisRecommendation`.
- **Why:** Parts 6 and 9 — systematic sufficiency/confidence disclosure and honest labels, without renaming the existing wire contract (`recommendationStatus` etc. unchanged, so the frontend keeps working untouched).
- **Risk:** medium (touches the orchestrator) — mitigated: all additions are between existing steps, purely derive-and-attach, and the full 513-test suite passes unchanged.
- **Tested:** e2e assertions for all four prompts (below).
- **Rollback:** revert the three `jobs.py` hunks (stability attach, `_ds2`/labels block, payload keys) + the `_investigation_label` helper.

### 4. `backend-py/tests/test_v15_intelligence.py` — NEW (13 tests)

Four-prompt classification pins, determinism, stability labels, payload contract (intelligence + sufficiency + labels), supermarket verdict capped below strong recommendation while rent/floorplate unknown, dark kitchen `routing: "verified"`, degraded-provider sufficiency reflection. All fully mocked — zero network.

---

## Deliberate non-changes (YAGNI decisions)

- **No always-on "cheap" water/rail/open-space tier** (brief Part 4 "always cheap" list): the current v1.4.9 behavior skips these fetches entirely when the prompt has no water/land-development signal. Re-adding even a "cheap" Overpass tier for every prompt would re-add the API calls v1.4.9 deliberately removed, violating "do not increase API calls unnecessarily" and "do not reintroduce heavy buildability". The risk is surfaced honestly instead via `riskTriggers` + `dataSufficiencyV2.buildability_lite: "not_required"`.
- **No Traffic Lite speed model**: the brief explicitly allows "structure/labels + selective routing only". Selective routing, per-provider budgets, timeouts, and honest labels (`routeProvider`, `routing: verified/degraded/not_required`) already exist; a road-class speed model would be a new estimation system with no consumer yet.
- **No renaming of the existing `recommendationStatus` values**: the new taxonomy is additive (`investigationLabel`) so the deployed frontend keeps rendering correctly without a coordinated release.
- **No new config flags**: nothing here calls providers or changes behavior, so there is nothing to flag off. (`stability`/classification are pure derivations; if they ever misbehave, the rollback is a revert, not a flag.)
- **No frontend changes**: all new fields ride the payload; existing normalizer passes unknown keys through untouched. UI rendering of the new labels is deliberately deferred until the labels prove stable in production payloads.

## API/cost impact

**Zero new external calls.** Every addition is local arithmetic over data the pipeline already fetched. No new providers, no pan-India rent data, no live traffic, no heavy buildability.

## Validation runs

| Check | Command | Result |
|---|---|---|
| Backend tests | `cd backend-py && python -m pytest tests/ -q` | **526 passed** (513 existing + 13 new) |
| Frontend typecheck | `npx tsc --noEmit` | clean |
| Frontend build | `npm run build` | success |
| Frontend tests | `npm test` | 44 passed |
| Lint | — | **not run: no linter is configured in this repo** (no eslint/ruff/flake8 config present); typecheck + tests are the enforced gates |
| Live dry-run | — | not run locally (requires provider keys + network); the mocked end-to-end pipeline tests exercise `_run_analysis` fully instead |

## UI pass (v1.5.0 release commit)

### 5. `src/types/index.ts` — types for the new payload fields
- **What:** `DataSufficiencyV2` interface; `AnalysisResult.analysisRecommendation` / `.dataSufficiencyV2` / `.analysisIntelligence`; `LocationData.investigationLabel` / `.stabilityLabel` / `.stabilityNote` / `.scenarioRanks`. All optional.
- **Why:** typed access without `any` sprawl; old payloads simply omit the fields.
- **Risk:** none (types only). **Tested:** `tsc --noEmit` clean. **Rollback:** revert file.

### 6. `src/services/resultNormalizer.ts` — shape guarantees
- **What:** `analysisRecommendation` validated against the five-value enum (unknown → dropped); `dataSufficiencyV2` normalized field-by-field with safe defaults (`unknown`, zero counts) and hidden with a warning when malformed; per-candidate `investigationLabel`/`stabilityLabel`/`stabilityNote` kept only when strings.
- **Why:** the drawer must render any payload vintage without crashing — same boundary-repair pattern as v1.4.6/v1.4.9.
- **Risk:** low. **Tested:** 4 new vitest cases incl. old-payload compatibility and malformed-field dropping. **Rollback:** revert the two normalizer hunks.

### 7. `src/components/ResultsDrawer.tsx` — additive rendering
- **What:** (a) analysis-level verdict badge (five-label taxonomy, color-coded, "field validation required" phrasing on provisional); (b) `getRecommendationLabel` prefers `investigationLabel` when present — legacy chain untouched as fallback; (c) per-candidate scenario-stability label with the stability note as tooltip; (d) compact Data sufficiency panel (per-domain chips: verified green / proxy amber / unknown grey / degraded red / not-required light, hard-constraint counts, final confidence + reason); (e) unsupported-constraint list now headed "Field validation required".
- **Why:** Parts 1-6 of the UI brief; no redesign — every element is a small additive block next to existing v1.4.x banners; skipped/degraded checks continue to render via the existing completeness card (warning styling, never fatal).
- **Risk:** low-medium (largest UI diff) — mitigated by normalizer guarantees + old-payload fallback paths; `tsc`/build/vitest green.
- **Tested:** typecheck + build + 48 vitest; no component-test harness exists (long-standing, deliberate).
- **Rollback:** revert the drawer hunks; labels fall back to v1.4.9 rendering.

### 8. Versioning + docs (release commit)
- `config.py` APP_VERSION → 1.5.0, ENGINE_VERSION → `stratageo-engine-00055`, RELEASE_NAME → "Analysis Intelligence Lite"; `package.json`/lock → 1.5.0; version-assertion tests updated; README current-version + v1.5.0 highlights + history row; CHANGELOG 1.5.0 entry.

## Rollback plan

All backend+UI changes ship in one release commit on `master`; `git revert <commit>` restores v1.4.9 behavior exactly. A `rollback-pre-v1.5.0` tag points at the commit live before this deploy. No schema migrations, no config changes, no deployed-state coupling — the payload keys are additive and the old frontend never depended on them (and the new frontend renders old payloads unchanged).

---

# Hard Constraint Verification Visibility v1 (post-v1.5.0 working tree)

**Goal:** surface plainly, at result and candidate level, when a user-requested hard constraint was Verified / Proxy verified / Not verifiable from available data / Requested but not enforced / Failed — closing the correctness-visibility gap identified in `docs/portal-current-state-audit-v1.5.md` §16/§19 (e.g. a metro exclusion silently unenforced when station data cannot be resolved).

**Design constraint honored:** pure mapping of state the run already computes (constraint policy, PlannerLite unsupported constraints, metro resolution mode, `route_unavailable`, waterfront enforcement flags, degraded-provider lists). Zero new external calls, zero scoring changes, additive-only payload.

### 9. `backend-py/app/engine/hard_constraints.py` — NEW pure mapping module
- **What:** `build_hard_constraint_verification()` → the additive `hardConstraintVerification` object (`summaryStatus` + five counts + per-constraint entries with id/label/category/status/severity/affectsRecommendation/candidateScope/reason/fieldValidationRequired); `candidate_warnings()` → compact per-candidate warning list for unresolved analysis-wide constraints; `demotes_strong_recommendation()` → the safety-cap predicate. Status vocabulary fixed: `verified | proxy_verified | not_verifiable | requested_not_enforced | failed | not_required`. Rules: rent/floor-area/zoning/parcel/ownership are always `not_verifiable` (critical when stated as a hard ConstraintItem); metro exclusion unresolved → `requested_not_enforced` (critical), generic-station fallback → `proxy_verified`; route constraint with routing unavailable → `requested_not_enforced`; waterfront corridor unenforced → `failed`; buildability skipped-as-irrelevant → `not_required` and NOT counted as requested; buildability degraded → `requested_not_enforced`; primary arterial road → `proxy_verified` at best (there is no road-class hard gate — honestly labeled).
- **Why:** the state existed but was scattered across strings (`route_unavailable`, `fallbacks`, `mask_stats`) — invisible as a coherent per-constraint answer.
- **Risk:** low — pure functions, no provider calls, no imports from jobs.py.
- **Tested:** 17 new tests in `tests/test_hard_constraint_visibility.py` (15 unit + 2 mocked end-to-end).
- **Rollback:** delete the module + revert the jobs.py wiring block; the payload key disappears, old frontends unaffected.

### 10. `backend-py/app/services/jobs.py` — additive wiring block
- **What:** one try/except-wrapped block after `analysisRecommendation` derivation: builds `_hcv`, attaches `hardConstraintWarnings` to every non-excluded candidate when any constraint is unresolved, applies the recommendation-demotion safety cap (an unresolved requested hard constraint can never coexist with `RECOMMENDED_INVESTIGATION_ZONE` — analysis-level and per-candidate; existing stricter labels are preserved, statuses/scores untouched), and adds the `hardConstraintVerification` payload key (omitted entirely if the build fails — never a partial/default object).
- **Why:** Parts 1-3 of the brief. NOTE: the audit's metro case was found to already be strictly handled (metro-unenforced flows into `route_unavailable` → all candidates excluded + `NO_RELIABLE_RECOMMENDATION`) — the gap was purely visibility, so the safety cap is an invariant re-assertion, not a behavior change; no existing test moved.
- **Risk:** low — additive, exception-isolated, no scoring path touched.
- **Tested:** full backend suite 543 passed (541 prior + 2 new e2e); the two e2e tests specifically pin that the key lands in the payload (the try/except would otherwise hide a silent failure from every other test).
- **Rollback:** revert the import + block + payload key (3 small hunks).

### 11. `src/types/index.ts` — `HardConstraintVerification` / `HardConstraintEntry` / `HardConstraintWarning` interfaces; `AnalysisResult.hardConstraintVerification?`; `LocationData.hardConstraintWarnings?`. All optional.
- **Risk:** none (types only). **Tested:** `tsc --noEmit` clean. **Rollback:** revert file.

### 12. `src/services/resultNormalizer.ts` — defensive normalization
- **What:** `normalizeHardConstraintVerification()` — entries with an unknown status are dropped, severities/booleans defaulted, counts coerced (requestedCount derived from entries when missing); a non-object value is hidden with a normalization warning; per-candidate `hardConstraintWarnings` keep only well-formed entries with a non-empty message. Old payloads without the key are untouched (no warning).
- **Risk:** low. **Tested:** 5 new vitest cases (old payload, well-formed, malformed + bad-entry filtering, candidate warnings, metro requested-not-enforced end-to-end shape). **Rollback:** revert the two hunks.

### 13. `src/components/ResultsDrawer.tsx` — "Hard constraint verification" panel + candidate chips
- **What:** (a) new compact panel after the Data sufficiency card: summary status, the five counts (Verified / Proxy verified / Not verifiable / Requested but not enforced / Failed), a per-constraint status line (reason as tooltip, "field validation required" suffix), and warning cards for any `requested_not_enforced` / `failed` / affecting `not_verifiable` entry (red styling only for failed/critical, amber otherwise); `not_required` entries are listed nowhere in warnings (no noise for the cafe prompt). (b) candidate cards: up to 3 compact warning chips under the header when `hardConstraintWarnings` present — warning styling, never fatal; existing score/factor detail untouched.
- **Risk:** low-medium (UI diff) — panel renders only when the normalizer-guaranteed object is present and non-empty; old payloads render exactly as before.
- **Tested:** tsc clean, build success, 53 vitest passed. No component-test harness exists (long-standing); manual validation scenarios documented in the task report.
- **Rollback:** revert the drawer hunks.

### 14. `src/components/SpecSummaryCard.tsx` — pre-run plan clarity
- **What:** in the "Analysis scope" section: a note under "Cannot be verified from data" ("These will be flagged for field validation — never scored.") and, when the spec contains a metro/subway exclusion (client-side detection from `spec.exclusions` names/tags — no new backend behavior), an honesty note that the exclusion depends on station data resolving and will be marked "requested but not enforced" if it cannot.
- **Risk:** none — presentational only. **Tested:** tsc + build. **Rollback:** revert the two hunks.

### Validation runs (this pass)

| Check | Command | Result |
|---|---|---|
| New tests | `pytest tests/test_hard_constraint_visibility.py -q` | **17 passed** |
| Full backend | `pytest tests -q` | **543 passed** (526 at v1.5.0 + 17 new) |
| Frontend typecheck | `npx tsc --noEmit` | clean |
| Frontend tests | `npx vitest run` | **53 passed** (48 + 5 new) |
| Frontend build | `npm run build` | success |

### API/cost impact (this pass)
**Zero new external calls.** The verification object is assembled from already-computed run state; candidate warnings are local list broadcasts; the SpecSummaryCard note is derived client-side from the existing spec.

### Rollback plan (this pass)
Uncommitted working-tree change set; `git checkout -- <files>` (or revert the single commit once made) restores v1.5.0 exactly. Payload key is additive and omitted-on-failure — an old frontend ignores it, the new frontend renders old payloads unchanged.

---

# Phase 1 Reliability Fixes v1.5.2 (externally reviewed patch)

**Source:** reviewed patch package (`phase1-reliability-fixes.patch`) fixing the two P0 blockers from `LIVE_PORTAL_QA_FINDINGS.md` §7. Verified before application: applies cleanly to master `71e374c`, standalone reference files content-identical to patch output, full suite green on a dry-run.

### 15. `backend-py/app/config.py` — buildability stage budget settings
- **What:** two new settings: `buildability_stage_budget_seconds = 90` (total wall-clock budget for the whole buildability stage) and `buildability_fetch_concurrency = 2` (max concurrent Overpass fetches; 2 = public-mirror connection-slot etiquette).
- **Why:** the v1.4.2 per-call cap (30s) bounded each fetch but not their SUM — up to 6 × 30s = 180s stacked sequentially, blowing the 240s job ceiling (observed live on 2 of 4 canonical prompts).
- **Risk:** low — additive settings, defaults tuned so worst-case stage cost is ~90s. **Rollback:** revert commit.

### 16. `backend-py/app/services/jobs.py` — concurrent deadline-aware buildability fetches
- **What:** the three per-kind fetch helpers (`_safe_area`/`_safe_line`/`_safe_named`) replaced by one `_safe_fetch(kind, arg, label)` that is (a) semaphore-bounded to `buildability_fetch_concurrency`, (b) deadline-aware against a single stage-level `time.monotonic()` budget — a fetch that cannot start or finish inside the remaining budget degrades to an empty mask with an honest fallback note + `_buildability_degraded` entry, exactly like the previous timeout path. All needed fetches launch concurrently and are gathered before mask application; mask application itself stays sequential (order-dependent `&= ~excluded` reporting semantics unchanged).
- **Why:** eliminates the raw 240s job timeout caused by sequential buildability fetch stacking; worst-case stage wall clock drops from ~180s to ≤90s.
- **Risk:** medium (restructured fetch block) — mitigated: degradation paths byte-compatible with previous reporting (`fallbacks`, `_buildability_degraded`, `mask_stats.buildabilityDegraded`, hardConstraintVerification all unchanged downstream); 550/550 tests pass including the mocked end-to-end pipeline tests.
- **Rollback:** revert commit.

### 17. `backend-py/app/engine/planner_lite.py` — deterministic water relevance
- **What:** `_water_relevant()` no longer treats a water-tagged EXCLUSION alone as a water signal. Order now: waterfront flag → water corridor → prompt/constraint text regex → (new) uncorroborated water exclusion returns False with an explicit "spec noise" reason. The exclusion's own buffer mask still applies via the main fetch; it just cannot trigger the expensive water_geometry + buildability cascade by itself.
- **Why:** the LLM spec-builder was observed non-deterministically attaching a default "Avoid water bodies" exclusion to dry-land prompts, flipping the stage plan (and triggering the timeout-prone buildability stage) between runs of the IDENTICAL prompt — the second live P0.
- **Risk:** low — genuine water briefs unaffected (waterfront flag / corridor / text all still trigger; pinned by 5 new tests). Known cosmetic nuance: a spurious water exclusion now enforced only via POI-buffer mask, yet still listed "Verified" in hardConstraintVerification — acceptable, flagged for later refinement.
- **Rollback:** revert commit.

### 18. `backend-py/tests/test_v152_reliability.py` — NEW, 7 regression tests
- Stage-budget config sanity (budget < job ceiling, per-call ≤ budget, worst-case wall clock fits); uncorroborated water exclusion does not flip water/buildability; identical prompt → identical plan with or without the spurious exclusion; genuine water wording / water corridor / prompt-corroborated exclusion still trigger.

### Validation (this pass)
| Check | Result |
|---|---|
| Full backend suite | **550 passed** (543 + 7 new) |
| Patch integrity | applies cleanly; reference files content-identical (CRLF-only diffs) |
| API/cost impact | zero new external calls; buildability Overpass calls unchanged in number, now bounded in wall-clock |

### Rollback plan
Single commit; `git revert` restores v1.5.1 behavior exactly. Tag `rollback-pre-phase1-reliability` points at the previously-live commit.

---

# Round 2 Consistency Fixes v1.5.2 (externally reviewed package, cumulative with Phase 1)

**Source:** reviewed package fixing the three issues found in the boss's JP Nagar live test (objective drift, wrong grocery archetype + grid resolution, map-vs-final score confusion). The cumulative `.patch` did NOT apply to master `c13ed6a` (Phase 1 hunks already applied); the standalone post-patch files were verified instead: every delta vs our master is a pure addition, and the package files retain our v1.5.1 + Phase-1 work byte-for-byte.

### 19. `backend-py/app/engine/canonical_archetypes.py` — small-format grocery correction
- **What:** `_SMALL_FORMAT_RE` (small/mini/organic/kirana/convenience/corner/neighbourhood/local/boutique/daily-needs/mom-and-pop) + a rule in `resolve_canonical_archetype()`: parser key `supermarket` + small-format wording in the RAW prompt → `retail_store` archetype instead of `large_format_retail`.
- **Why:** the parser maps any "grocery store" wording to `supermarket` → hypermarket playbook (res-8, highway/delivery factors). Observed live on the JP Nagar organic grocery prompt.
- **Risk:** low — deterministic, raw-prompt-only; "massive discount supermarket" pinned unchanged by test. **Rollback:** revert commit.

### 20. `backend-py/app/engine/deterministic_planner.py` — res-10 rule + templated objective
- **What:** (a) `_BLOCK_GRANULARITY_RE` (intersections/blocks/street corners/street-level/corner plots) bumps grid to res 10 (user's words only; polyfill still auto-degrades on hex-budget overflow); (b) `spec["objective"]` is now template-generated from resolved topN + businessType + first study-area place — byte-identical across runs of the identical prompt.
- **Why:** live-observed objective drift ("3 candidate intersections or blocks…" vs "candidate micro-market zones…") and narrated-res-9-but-needs-block-scale mismatch.
- **Risk:** low-medium (objective rewrite could drop water cues) — mitigated by item 21. **Rollback:** revert commit.

### 21. `backend-py/app/models/spec.py` — waterfront detection reads the raw prompt
- **What:** `validate_layers` waterfront detection text now appends `rawIntent.rawPrompt` when present.
- **Why:** the templated objective drops adjectives; water cues must come from the customer's own words (also simply the more truthful source). Pinned by `test_waterfront_detection_survives_templated_objective`.
- **Risk:** low — widens detection input only. **Rollback:** revert commit.

### 22. `backend-py/app/engine/results.py` + `backend-py/app/services/jobs.py` — screening/refined transparency
- **What:** `build_location()` gains `screening01`; every candidate carries `screeningScore` (Pass-A composite, same basis as the map choropleth) and `rankingBasis` (`refined`|`screening`); jobs.py passes `composite[ci]` and appends a methodology note explaining refined re-ranking + the near-duplicate hex-ring skip rule.
- **Why:** live-reported confusion — "recommended cells were not the highest-scoring cells on the map." Not a bug; an undisclosed two-stage process, now disclosed.
- **Risk:** low — additive payload fields + one note. **Rollback:** revert commit.

### 23. Frontend — `src/types/index.ts`, `src/services/resultNormalizer.ts`, `src/components/ResultsDrawer.tsx`
- **What:** `screeningScore`/`rankingBasis` typed + normalized (optional; old payloads unaffected); candidate card shows "map/screening X → refined Y" chip with tooltip only when basis is refined and the two differ by ≥0.3.
- **Risk:** low. **Rollback:** revert commit.

### 24. `backend-py/tests/test_v152_reliability.py` — expanded 7 → 13 tests
- Adds: small-grocery→retail_store, discount-supermarket→large_format (regression), res-10 granularity, res-9 without block wording, byte-identical objective across divergent LLM wordings, waterfront survives templated objective.

### 25. Version bump + docs (release commit)
- `config.py`: APP_VERSION → **1.5.2**, ENGINE_VERSION → `stratageo-engine-00058`, RELEASE_NAME → "Reliability & Consistency"; docstring entries for v1.5.1/v1.5.2. Version-assertion tests updated. `package.json`/lock → 1.5.2 (drives the TopBar `v…` badge). README: current-version line, v1.5.1 + v1.5.2 highlights, version-history rows, stale `/health` example fixed. CHANGELOG: 1.5.1 + 1.5.2 entries.

### Validation (this release)
| Check | Result |
|---|---|
| Backend | **556 passed** (543 + 13 new) |
| Frontend typecheck / tests / build | clean / **53 passed** / success |
| API/cost impact | zero new external calls |

### Rollback plan
Tag `rollback-pre-v1.5.2` points at the previously-live commit (`c13ed6a`, backend revision `stratageo-engine-00057-sp4`).

---

## v1.6.0 — Factor Weight Sliders (Phase 2)

### 26. `backend-py/app/engine/deterministic_planner.py` — canonical weights + preservation
- **What:** `apply_deterministic_plan()` now records `spec["canonicalWeights"]` (archetype default weights, keyed by display name) before any user adjustment. New `preserve_user_weights(new_spec, incoming_spec)`: when the incoming client spec has `weightsAdjustedByUser: true`, copies its per-layer weights onto the freshly planned spec by layer id (falling back to name match), and flags `weightsSource: "user_adjusted"`.
- **Why:** the deterministic planner re-applies archetype defaults on EVERY chat turn — a customer who adjusted sliders on the plan card and then typed "run" had those adjustments silently wiped by the final turn's replan. Real bug, now fixed.
- **Risk:** low — only activates when the client explicitly flags the adjustment. **Rollback:** revert commit.

### 27. `backend-py/app/models/spec.py` + `backend-py/app/services/llm.py` — wiring
- **What:** `SpecV2` gains `canonicalWeights: Optional[dict[str, float]]` and `weightsAdjustedByUser: Optional[bool]`. `llm.py`'s `chat_turn()` calls `preserve_user_weights(new_spec, spec)` immediately after `apply_deterministic_plan()`.
- **Risk:** low — additive optional fields. **Rollback:** revert commit.

### 28. `backend-py/app/services/jobs.py` — weight audit in result payload
- **What:** every result now carries `"weightAudit": {"adjustedByUser", "defaultWeights", "executedWeights"}`, sourced from the spec's `canonicalWeights`/`weightsAdjustedByUser` and the layers actually executed with.
- **Why:** so an adjusted ranking is never presented as the untouched default methodology — visible in the report.
- **Risk:** low — additive payload key. **Rollback:** revert commit.

### 29. Frontend — `mcdaEngine.ts`, `App.tsx`, `ResultsDrawer.tsx`, `SpecSummaryCard.tsx`, `types/*.ts`, `resultNormalizer.ts`
- **What:** `reweightHexGrid()` (recolors the hex-grid map client-side from per-cell `layerScores`) and `weightsDiffer()` (scale-invariant weight-set comparison) added to `mcdaEngine.ts`. `App.tsx` tracks `defaultWeights` alongside `customWeights`, derives `weightsAdjusted`/`displayHexGrid`/`handleWeightsReset`, and passes them to `ResultsDrawer`. `ResultsDrawer` gained the "⚖ Factor weights" panel (sliders + reset button + default-weight comparison) and the amber "Custom weights active" honesty banner that suppresses stale default-weight decorations (score band, "statistically similar", map→refined chip) while adjusted. `SpecSummaryCard`'s plan-card weight editor now sets `weightsAdjustedByUser: true`. Types + normalizer extended for `weightAudit`/`canonicalWeights`/`weightsAdjustedByUser`.
- **Fixed:** `recalculateWithWeights()` previously counted a no-data factor (`score === null`) as a fabricated `0` in the weighted mean while still counting its weight in the denominator — unfairly dragging down candidates in data-sparse areas. Now present-weight-renormalized (excludes no-data factors from both numerator and denominator), matching the backend's honesty rules.
- **Risk:** low-medium (touches the core candidate-scoring recompute) — mitigated by the reweighting test suite (13 tests) including the canonical "reverse the weights flips the ranking" scenario and a direct regression test for the fabricated-zero fix. **Rollback:** revert commit.

### 30. Tests + version bump (release commit)
- Backend: 4 new tests appended to `test_v152_reliability.py` (canonical weights recorded, weights preserved across a simulated chat turn, unflagged incoming spec does not preserve, `SpecV2` accepts the new audit fields).
- Frontend: new `src/__tests__/reweighting.test.ts` (13 tests) covering `recalculateWithWeights`, `reweightHexGrid`, and `weightsDiffer`.
- `config.py`: APP_VERSION → **1.6.0**, ENGINE_VERSION → `stratageo-engine-00059`, RELEASE_NAME → "Factor Weight Sliders"; docstring entry added. Version-assertion tests updated. `package.json`/lock → 1.6.0. README: current-version line, v1.6.0 highlights, version-history row, `/health` example fixed. CHANGELOG: 1.6.0 entry.

### Validation (this release)
| Check | Result |
|---|---|
| Backend | **560 passed** |
| Frontend typecheck / tests / build | clean / **66 passed** / success |
| API/cost impact | zero new external calls — weight recompute is pure client-side arithmetic |

### Rollback plan
Tag `rollback-pre-v1.6.0` points at the previously-live commit, tagged immediately before this deploy.

---

## v1.6.1 — Confidence, Report, Quotas, Security (Phase 3)

### 31. `backend-py/app/engine/unified_confidence.py` (new) — headline confidence verdict
- **What:** `build_unified_confidence(data_sufficiency, critique)` merges `dataSufficiencyV2.final_confidence` and the reliability critic's `verdict` into one `{level, reason, components, method}` verdict. Conservative rule: `level` is the WORST of the two components; when they disagree, `reason` names both and states the conservative-merge rationale explicitly.
- **Why:** live testing showed these two signals disagreeing on 3 of 4 canonical prompts (e.g. "high" data sufficiency next to a "weak" critic verdict) — technically both true, commercially indefensible to show unreconciled to a paying customer.
- **Risk:** low — pure function, wrapped in try/except at the `jobs.py` call site; `unifiedConfidence` is omitted (never defaulted) on failure. **Rollback:** revert commit.

### 32. `backend-py/app/services/jobs.py` — wiring + weight-audit note (recap) + confidence
- **What:** imports `build_unified_confidence`; after the existing `dataSufficiencyV2` (`_ds2`) block, calls `build_unified_confidence(_ds2, _det_critic.to_dict())` and adds `unifiedConfidence` to the result dict only when the build succeeds.
- **Risk:** low — additive, exception-isolated. **Rollback:** revert commit.

### 33. Frontend — PDF report + `ResultsDrawer.tsx` confidence banner
- **What:** `App.tsx`'s PDF section list gains "Overall Confidence: {level}" (body = the reason) and a "Factor Weight Audit" table (default vs. applied weight per factor, headed "ADJUSTED BY USER" when `weightsAdjusted || weightAudit.adjustedByUser`). `ResultsDrawer.tsx` gains a colored (green/amber/red by level) "Overall confidence: …" banner above the summary. `resultNormalizer.ts` + `types/index.ts` gain `unifiedConfidence` normalization/typing.
- **Risk:** low — purely additive rendering over an optional field. **Rollback:** revert commit.

### 34. Per-customer quota allotment — `firestore.rules`, `auth_quota.py`, `AuthContext.tsx`, `AdminDashboard.tsx`, `FloatingAssistant.tsx`, `usageTracker.ts`
- **What:** `users/{uid}.maxPrompts` (admin-grant-only per Firestore rules — a user can neither create nor modify it) replaces the single hardcoded 10-prompt cap. The backend's quota transaction (`auth_quota.enforce_auth_and_quota`) reads it with `s.max_prompts_per_user` as fallback. Frontend: `AuthContext` tracks `maxPrompts` and derives `promptsRemaining` from it; `FloatingAssistant` shows "N of {cap} queries"; `AdminDashboard` gained **Set allotment** (`grantAllotment(uid, n)`) and **Reset usage** (`resetUsage(uid)`) buttons, plus a "contract" badge on accounts with a granted allotment; the "users at limit" overview metric now compares against each user's own cap instead of a hardcoded `4`.
- **Why:** the ₹50,000/5-analysis sales-led contract model needs a per-customer number, not one global constant — this IS the payment tie-in (contract signed → admin grants 5 credits).
- **Risk:** low-medium (Firestore rules change) — mitigated by backward compatibility: accounts without `maxPrompts` fall back to 10 (rules) / `max_prompts_per_user` (backend), identical to pre-existing behavior. **Rollback:** revert commit + `firebase deploy --only firestore:rules` from the previous commit if already deployed.

### 35. `backend-py/app/auth_quota.py` (new) — server-side identity + quota enforcement
- **What:** `enforce_auth_and_quota(request, consume)` verifies a Firebase ID token (via `firebase-admin`, Application Default Credentials) when `require_user_auth` is true; when `consume=True` it atomically transacts `users/{uid}.promptsUsed` (read-check-increment) against the account's allotment. Wired into `routers/analyses.py` (`consume=False` before spec validation, `consume=True` after — a malformed spec never burns a credit) and `routers/chat.py` (`consume=False`, plus the chat-turn rate limiter below). `main.py` CORS now allows the `Authorization` header. Frontend `chatService.ts` attaches `Authorization: Bearer <Firebase ID token>` to every engine call (`authJsonHeaders()`), lazily importing firebase so it stays out of the module's static dependency graph.
- **Why:** the engine endpoints themselves accepted anonymous calls — the Firestore rules alone couldn't stop a direct `curl`/scraped-bundle caller from bypassing the quota while spending real OpenAI/Google money. For a paid product the quota must be enforced where the cost is incurred.
- **Rollout safety:** `require_user_auth` (`STRATAGEO_REQUIRE_USER_AUTH`) defaults to **False** — this entire deploy is a no-op for live traffic until the flag is explicitly flipped (a separate, deliberate go-live action per `docs/PHASE3-SECURITY-REVIEW.md`). Fail-closed: if enforcement is on and token/Firestore verification cannot be performed, the request is rejected (401/503), never silently allowed.
- **Risk:** low as shipped (flag off); the flag flip itself is the higher-risk action and is intentionally NOT bundled with this deploy. **Rollback:** revert commit (no rules/env change needed since the flag ships off).

### 36. `backend-py/app/auth_quota.py` — chat-turn rate limiter
- **What:** `chat_rate_decision(uid, now, limit, window_s, history)` — an in-memory per-user sliding-window counter (default 60/hour, `CHAT_TURNS_PER_HOUR`), applied to identity-verified (non-consuming) chat calls. Returns 429 `CHAT_RATE_LIMITED` with a message clarifying analysis credits are unaffected.
- **Why:** chat turns correctly don't consume analysis credits, but that left an unmetered-spend gap — a signed-in user (or a script with a valid token) could loop the LLM endpoint indefinitely at the operator's cost.
- **Risk:** low — in-memory state is correct for the current `--max-instances 1` deployment; documented as needing to move to Firestore/Redis if ever scaled out. **Rollback:** revert commit.

### 37. Tests + version bump (release commit)
- Backend: 2 new tests appended to `test_v152_reliability.py` (`test_quota_decision_respects_per_customer_allotment`, `test_chat_rate_limiter_sliding_window`) + new `test_v160_phase3.py` (14 tests: unified-confidence agreement/disagreement/defaults, quota-decision parametrized matrix, bearer-token parsing, `require_user_auth` off-by-default + no-op-when-off rollout-safety checks).
- `config.py`: APP_VERSION → **1.6.1**, ENGINE_VERSION → `stratageo-engine-00060`, RELEASE_NAME → "Confidence, Report & Quotas"; docstring entry added. Version-assertion tests updated. `package.json`/lock → 1.6.1. README: current-version line, v1.6.1 highlights, version-history row, `/health` example fixed. CHANGELOG: 1.6.1 entry. `docs/PHASE3-SECURITY-REVIEW.md` added (full findings + go-live sequence).

### Validation (this release)
| Check | Result |
|---|---|
| Backend | **579 passed** |
| Frontend typecheck / tests / build | clean / **66 passed** / success |
| API/cost impact | zero new external calls (unified confidence is pure local merge; auth adds one token-verify + one Firestore transaction per analysis, only once the flag is on) |

### Rollback plan
Tag `rollback-pre-v1.6.1` points at the previously-live commit (`d845fc9`, backend revision `stratageo-engine-00059-cgl`), tagged immediately before this deploy.

### Go-live note (not part of this deploy)
`STRATAGEO_REQUIRE_USER_AUTH` ships OFF. Flipping it to `true` (plus setting `MAX_PROMPTS_PER_USER` per the paid tier) is a separate, deliberate action — see `docs/PHASE3-SECURITY-REVIEW.md` § "Suggested go-live sequence for the paid tier". Not performed automatically by this release.

---

## v1.6.2 — Smart Water/Buildability Relevance (backend-only)

### 38. `backend-py/app/engine/planner_lite.py` + `backend-py/app/services/jobs.py` — buildability single source of truth
- **What:** `_COMMERCIAL_RE`, `_AVOID_RAIL_RE`, `_PARK_USE_RE`, and `_buildability_flags()` moved from `jobs.py` into `planner_lite.py` (jobs.py now imports them). `planner_lite._buildability_relevant()` rewritten to call `_buildability_flags(spec)` directly and return relevant=True whenever `commercial_proxy` or `railway` would fire, instead of its own narrower, independently-maintained regex pair (`_LAND_DEV_RE`/`_AVOID_RAIL_RE` only — no commercial-business check at all). `_buildability_flags()` also hardened with `getattr(..., default)` attribute access so it tolerates duck-typed spec stubs (previously assumed a real `SpecV2` with `.objective`/`.businessType`/`.waterfront`).
- **Why (root cause):** `jobs.py`'s `_buildability_flags()` already correctly recognized "gym" (and every other word in the broad `_COMMERCIAL_RE`) as a commercial business needing no-build-land protection. But `jobs.py` line ~1290 forcibly zeroed the railway/ghat/protected flags whenever the PLANNER's separate (narrower) relevance check said "not relevant" — so a cafe/gym/supermarket/etc. brief had its correctly-computed protection silently stripped. Live-observed: a "high-end gym in Mumbai" candidate landed on port/dockyard land. `_buildability_flags()` itself was never wrong; the two-function split let them drift apart.
- **Risk:** low — the fix REMOVES a divergence risk rather than introducing new logic; `_buildability_flags()`'s decision logic is unchanged, only its physical location and the gate's dependency on it. **Rollback:** revert commit.

### 39. `backend-py/app/engine/planner_lite.py` — geography-aware water relevance
- **What:** new `_COASTAL_METRO_RE` (Mumbai/Bombay, Chennai/Madras, Kolkata/Calcutta, Kochi/Cochin, Visakhapatnam/Vizag, Mangalore, Surat, Goa, Puducherry, Thiruvananthapuram, Kozhikode, and ~15 more major Indian coastal/port cities). `_water_relevant()` now also returns True when this matches the resolved study-area text (already embedded in the templated objective — no new provider call).
- **Why:** water relevance was pure prompt-text matching; a coastal peninsula city carries real water/dock risk regardless of whether the prompt happens to mention water. Scoped to well-known coastal/port metros (not an exhaustive gazetteer) to avoid false positives on unrelated name collisions.
- **Risk:** low-medium (broadens water-stage triggering for the listed cities) — mitigated by a landlocked-city counterfactual test proving the same business type in e.g. Pune does NOT trigger either stage. **Rollback:** revert commit.

### 40. `backend-py/app/engine/planner_lite.py` — analysisMode priority reorder
- **What:** `large_format_retail` archetype check moved BEFORE the `buildability` check in `_classify_intelligence()`'s mode-selection chain.
- **Why:** now that buildability correctly fires for nearly every commercial archetype, checking it first would have made the more specific `"large_format_screening"` label unreachable for supermarkets/hypermarkets (`"buildability_lite_required"` would always win first). Purely informational metadata (plan-card display) — no gate/enforcement behavior changed.
- **Risk:** low. **Rollback:** revert commit.

### 41. `backend-py/app/services/jobs.py` — water + buildability fetches launched concurrently
- **What:** the water-body Overpass fetch and the buildability fetch-task group (railway/ghat/protected/maidan/road_frontage) were each awaited as a separate blocking step, in sequence (water first, fully awaited, THEN buildability's own bounded concurrent group). Restructured so both launch as `asyncio` tasks at the same point (right after `lat0, lng0` are computed) — `bflags` computation and the buildability `_fp` task-launching moved to before the water fetch, which is now itself wrapped in `_fetch_water_ways()` and launched via `asyncio.ensure_future` instead of directly awaited. `water_ways = await _water_task` happens where its value is first needed (before the corridor loop); the buildability tasks are awaited at their original position (now labelled "4e (apply phase)"). Mask application order, `notes`/`mask_stats`/`fallbacks` reporting, and the corridor riverbank-boundary fallback are all unchanged — only WHEN the two fetch groups' clocks start changed.
- **Why:** items 38-39 above make water AND buildability fire TOGETHER far more often — every coastal-metro commercial brief needs both, where before this was a rare combination. Sequentially, that combination cost up to `optional_provider_timeout` (45s, water) + `buildability_stage_budget_seconds` (90s, buildability) = ~135s for these two stages alone, eating deep into the shared 240s job ceiling on what just became the common case. Concurrently, the combined worst case is bounded to `max(water, buildability)` ≈ 90s instead of their sum — this is the direct answer to "won't broader triggering just cause more timeouts?": no, because the two stages no longer stack.
- **Risk:** low-medium (reorders when async tasks start, inside the hot analysis path) — mitigated by a real-wall-clock regression test (item 42) that fails if this ever regresses back to sequential fetching, not just a functional-correctness check. Mask application logic itself is untouched.

### 42. Tests
- New `backend-py/tests/test_v162_smart_masks.py` (6 tests): the exact Mumbai-gym regression (`test_gym_in_mumbai_triggers_both_water_and_buildability`); a geography-only isolation test using a business type matching neither `_COMMERCIAL_RE` nor `_LAND_DEV_RE` (proves the city alone drives the water trigger); the landlocked-city counterfactual (proves the fix isn't an always-on regression); an invariant test asserting `_buildability_relevant()` can never diverge from `_buildability_flags()` across 6 business/city combinations; a timeout-safety check confirming the plan's runtime target stays within `job_max_runtime_seconds` for the Mumbai-gym case; and `test_water_and_buildability_fetches_run_concurrently_not_sequentially` — delays every mocked Overpass fetch by a fixed amount and asserts the measured wall-clock elapsed time sits below the midpoint between the old sequential bound (4× delay) and the new concurrent bound (3× delay), a genuine regression guard against item 41 ever reverting to sequential fetching.
- Updated 9 existing tests whose fixtures/assertions had encoded the OLD (buggy) behavior as expected: `test_v149_planner_lite.py` (cafe/supermarket plan + e2e tests now expect buildability to RUN, not skip; budget-comparison test rebased on the dark-kitchen fixture as the "skips everything" baseline), `test_v15_intelligence.py` (cafe's `analysisMode` → `buildability_lite_required`; cafe's `dataSufficiencyV2.buildability_lite` → `verified`), `test_hard_constraint_visibility.py` (cafe's `buildability_lite` HCV entry → `proxy_verified`). `_buildability_flags()` itself was also hardened with `getattr` defaults (item 38) so it tolerates `test_v152_reliability.py`'s duck-typed `_SpecStub`, fixing that file's water-exclusion-determinism test without changing its assertions. The shared live-prompt fixtures' default study area moved from "Kolkata" (itself a genuine port/river city — now correctly water-relevant, which is why it was changed) to "Pune" (landlocked) so the "skip when genuinely irrelevant" tests keep testing that scenario cleanly.
- **585 passed** (579 + 6 new).

### Validation (this release)
| Check | Result |
|---|---|
| Backend | **585 passed** |
| Frontend | unchanged — no frontend files touched, no rebuild/redeploy needed |
| API/cost impact | none — same Overpass calls, same count, only their concurrency changed; broader buildability triggering stays bounded (max, not sum, of the two stages) verified by a real-wall-clock test, not just the timeout-safety check |

### Rollback plan
Tag `rollback-pre-v1.6.2` points at the previously-live commit (`5162fd5`, backend revision `stratageo-engine-00060-dxr`), tagged immediately before this deploy.

---

## v1.6.3 — H3 Grid-Level Choice (7/8, default 8)

### 43. Default grid resolution 9 → 8, plan-card level picker, choice preserved across turns
- **What (backend):** every canonical archetype's `grid_resolution` coarsened from 9 to 8 (`canonical_archetypes.py`; `LARGE_FORMAT_RETAIL` was already 8), along with the `Grid` model default (`models/spec.py`), the LLM consultant's stated default and example spec (`prompts.py`), and the evidence-trail fallbacks (`models/evidence.py`, `evidence_builder.py`, `llm.py`). New spec flag `gridResolutionAdjustedByUser` + `preserve_user_grid_resolution()` (`deterministic_planner.py`, wired in `llm.py` right after `preserve_user_weights()`): when the client spec carries the flag and one of the two offered levels (7/8), the planner keeps that resolution instead of re-applying the archetype default — including over the v1.5.2 res-10 block-granularity prompt override (an explicit UI choice beats prompt-wording inference). The guard ignores flagged-but-unoffered values; the SpecV2 7–10 clamp and `polyfill()` auto-degrade are unchanged.
- **What (frontend):** the "Grid:" row on the Analysis Plan card (`SpecSummaryCard.tsx`) is now a two-option segmented control — Level 7 (~5.2 km² hexes, district-scale screening, fastest) / Level 8 (~0.74 km² hexes, neighbourhood-scale, default) — with tooltips explaining the tradeoff; picking a level sets `grid.resolution` + the flag through the same `onSpecEdit` path the weight sliders use. When the backend set a non-offered resolution (e.g. block-granularity res 10), that value is displayed beside the picker until the customer picks a level. New `gridResolutionAdjustedByUser` field on the frontend `SpecV2` type; `/api/v2/analyses` needed no change (it already validates the client spec as-is, and 7/8 pass the existing clamp).
- **Why:** res 9 (~0.10 km² hexes) was street-scale granularity on every default run — slower, more cells to score, more provider load — when screening-level output is the product's stated claim. Res 8 keeps neighbourhood-scale differentiation at roughly 1/7th the cell count; res 7 gives a very fast district-scale first pass for large study areas. Making it a customer choice (rather than another inference) keeps the plan card honest about what will run.
- **Risk:** medium-low. Coarser default changes score granularity of every new analysis (existing results unaffected); candidate hexes are bigger, so per-hex POI counts rise and candidate spacing widens — both inherent to the chosen scale and disclosed by the picker tooltips. The preservation guard is flag-gated and value-whitelisted, so a malformed client spec cannot inject an arbitrary resolution. **Rollback:** tag `rollback-pre-v1.6.3` (commit `5f46c50`, backend revision `stratageo-engine-00061-fzz`).

### 44. Tests
- New `tests/test_v163_grid_choice.py` (9 tests): default is 8 in the `Grid` model, every archetype, and an end-to-end planned spec; the 7–10 clamp still holds; a user's level-7 choice survives a replan; the choice wins over the block-granularity override; the override still applies when no choice was made; flagged-but-unoffered resolutions (5/9/10/None/"8") are ignored; malformed incoming specs (None/{}/missing grid) are tolerated.
- Updated: `test_v152_reliability.py` archetype-default assertion (9→8), version assertions in `test_config_v110.py` / `test_v14_reliability.py`.
- **594 passed** (585 + 9 new); frontend `tsc` clean, Vitest 66 passed, build clean.
