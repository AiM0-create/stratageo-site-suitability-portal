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
