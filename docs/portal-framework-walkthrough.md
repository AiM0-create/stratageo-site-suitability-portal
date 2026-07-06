# StrataGeo Portal — Framework Walkthrough (Start to Finish)

**Reflects:** commit `71e374c` (`feat: surface hard constraint verification in analysis results`), the current tip of `master` and the currently deployed version.
**Live state confirmed at time of writing:** frontend bundle `index-CDL8WEI7.js` on GitHub Pages; backend Cloud Run revision `stratageo-engine-00056-tc9` (`appVersion 1.5.0`, `releaseName "Analysis Intelligence Lite"`, `specVersion 2.3`, `evidenceVersion 1.4.0`) — verified live via `GET /health`.

This document walks through exactly what happens, file by file and function by function, from the moment a user opens the portal to the moment a ranked (or honestly-refused) result appears on screen. It is a "how it works" reference, not an audit — for known reliability caveats in the current build, see `LIVE_PORTAL_QA_FINDINGS.md` and `docs/portal-current-state-audit-v1.5.md`.

---

## 1. What the portal is

StrataGeo is a **screening-level, AI-assisted site-suitability tool** for Indian cities. A user describes a business and a location in plain English; the portal turns that into a structured scoring specification, runs a deterministic multi-criteria decision analysis (MCDA) over an H3 hexagon grid using real OpenStreetMap and Google Places data, applies hard exclusion masks (water, railway, heritage, metro buffers, etc.), and returns a small set of ranked **candidate zones** — never "final sites," never "parcels," always labeled with how much of the result could actually be verified from data.

It is explicitly **not** a parcel-level or transactional engine. `siteClaimLevel` is hardcoded to `"micro_market_zone"` everywhere in the backend, and every result carries a disclaimer that field validation is required before any leasing or investment decision.

---

## 2. Deployment topology

```
User Browser
     │
     ▼
GitHub Pages (frontend, static)                Google Cloud Run (backend, stateful compute)
https://aim0-create.github.io/                 stratageo-engine service, asia-south1
stratageo-site-suitability-portal/             --max-instances 1 --no-cpu-throttling
     │  React + TypeScript + Vite                    │  FastAPI (Python 3.12)
     │  bundle: index-CDL8WEI7.js                     │  revision: stratageo-engine-00056-tc9
     └──────────────── fetch() ───────────────────────┘
                         │
                         ├── OpenAI (gpt-5.4 family) — conversational spec-building + optional critic
                         ├── OpenStreetMap / Overpass — POI, water, railway, heritage, road geometry
                         ├── Google Places (New) + Aggregate + Place Details — POI counts, evidence
                         ├── Google Routes API — real network routing
                         └── OpenRouteService (ORS) — routing/isochrone fallback
```

- **Frontend deploy:** push to `master` → GitHub Actions `Deploy to GitHub Pages` workflow → static build served from `gh-pages`.
- **Backend deploy:** manual — `gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod`.
- **Version discipline:** every deploy is preceded by a `rollback-pre-<name>` git tag pointing at the commit that was actually live at that moment (e.g. `rollback-pre-hard-constraint-visibility-v1` → `2e1018e`), so any release can be reverted without guessing which commit was really running.
- **`/health`** is the single source of truth for what's actually live — it reports `engineVersion` from Cloud Run's own `K_REVISION` environment variable, not a hardcoded string, so it can never silently drift from reality.

---

## 3. Step 1 — Authentication

- Entry screen (`src/components/LoginScreen.tsx`) offers **Continue with Google** or **Sign in with Email**.
- Two account tiers exist in practice: a Google-OAuth session with a metered quota ("N of 10 queries left" — 10 free AI-powered evaluations per account), and an **Admin** email/password account with **Unlimited** analyses.
- On sign-in, the app mounts the main single-page view: a full-bleed Leaflet map (`src/components/MapView.tsx`) with a floating conversational assistant panel (`src/components/FloatingAssistant.tsx`) docked over it, plus a `TopBar.tsx` showing account state, version (`v1.5.0`), and admin/session controls.
- A **quirk of the current build:** the assistant panel's spec/plan state is persisted client-side (browser storage) independent of the login session — signing out and back in, or a full page reload, restores whatever analysis plan was last on screen. The button to *execute* that restored plan does not always reappear automatically after a reload; typing any confirmation phrase ("run") re-arms it. This is a known, low-severity friction point, not a data-loss issue — the underlying spec is never lost.

---

## 4. Step 2 — Prompt → conversational spec-building (LLM)

The user types a natural-language brief into the assistant input (e.g. *"Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass."*) and sends it.

1. **Deterministic pre-parse.** Before any LLM call, `intent_parser.parse_raw_intent()` (`backend-py/app/engine/intent_parser.py:303`) extracts hard-constraint phrases, a guessed business type, and spatial relations from the raw text using regex — this exists specifically so the hard constraints the user actually typed can later be checked against what the LLM's structured spec encodes (`validate_hard_constraints_in_spec()`).
2. **Conversational turn.** `POST /api/v2/chat` (`backend-py/app/routers/chat.py`) → `chat_turn()` (`backend-py/app/services/llm.py`), which calls OpenAI (`gpt-5.4-mini` for planning/reasoning by default, `gpt-5.4` for the critic, `gpt-5.4-nano` for fast/report text — see `backend-py/app/config.py`). This turn narrates the assistant's understanding back to the user ("I'm mapping this as a QSR / quick-service cafe around Ruby Crossing…") and asks a confirming question ("Ready to see the analysis framework?").
3. **Archetype matching.** `canonical_archetypes.py` (908 lines) holds ~10 hard-coded business archetypes (student café, premium restaurant, dark kitchen, clinic, warehouse/logistics, EV charging, retail, preschool, large-format retail, and a generic fallback), each with a fixed, reviewed set of scoring factors, weights, and catchment types. `resolve_canonical_archetype()` tries to match the parsed business type to one of these. When a prompt cleanly matches (the plain café case matches consistently), the resulting factor set is specific and well-differentiated (5 named factors: student catchment, transit access, competition, co-tenancy, frontage). When the match is weaker (large-format retail, premium riverside dining were both observed falling back in live testing), the executed framework can default to a much more generic 3-factor template (`demand_density_proxy` / `road_access` / `generic_competition`, all lower confidence) — even though the **narrated chat text** for that same turn often still describes the richer, archetype-specific plan. This is a known current gap between narration and execution (see `LIVE_PORTAL_QA_FINDINGS.md` §6, P1 Fix 4).
4. On confirmation ("yes"), the assistant streams the full structured plan: objective, detected constraints with a `status` per constraint (`satisfiable` / `unvalidatable` / `conflicting`), a feasibility verdict (`feasible` / `feasible with tradeoffs` / `not_feasible` / `insufficient_data`), the factor table, hard exclusions, weighting scenarios (Balanced / archetype-specific / Competition-sensitive), and caveats — all rendered by `SpecSummaryCard.tsx`.

This whole stage produces a `SpecV2` object (`backend-py/app/models/spec.py`, ~644 lines) — the single validated contract everything downstream depends on.

---

## 5. Step 3 — The pre-run plan preview (PlannerLite)

Before the user can click **Start analysis**, the backend has already computed — deterministically, with zero provider calls — exactly which expensive stages this specific prompt actually needs. This is `create_analysis_plan()` in `backend-py/app/engine/planner_lite.py:426`.

- **Water relevance** (`_water_relevant()`, line 237): true if the spec is flagged waterfront, or any corridor/exclusion in the spec carries a water OSM tag, or the prompt text matches a water/river/lake/coastal regex.
- **Buildability relevance** (`_buildability_relevant()`, line 253): true automatically if water is relevant ("ghat/heritage/no-build land is a real risk" near water), or if the text matches a land-development/parcel/construction regex, or explicit "avoid railway" phrasing.
- **Routing relevance**: true if the spec has an explicit `routeConstraint`, or the raw-intent parser flagged strict drive/walk-time phrasing.
- **Isochrone refinement / Places Aggregate / Place Details**: gated simply on whether the framework actually has walk/drive-catchment layers or Google-Places-sourced layers — these are common enough that they run for almost every archetype.
- **Unsupported constraints** (rent, floor area, zoning, parcel availability, ownership/title) are matched by dedicated regexes and marked `should_score = False` **unconditionally** — these are never scored, only disclosed, as a structural guarantee rather than a convention.

The result renders in `SpecSummaryCard.tsx` as an **"Analysis scope"** section: a `✓ WILL BE CHECKED` list and a `⚡ SKIPPED FOR THIS ANALYSIS (SAVES TIME)` list with a one-line reason for each skip, plus a `CANNOT BE VERIFIED FROM DATA` list for rent/floor-area-type constraints — all visible **before** the user commits to running anything.

A live-tested caveat: this stage-relevance decision is a pure function of the validated `SpecV2`, but the spec itself is LLM-produced, and in testing the identical prompt occasionally produced specs that did or didn't carry a default water-tagged exclusion — which flips the water/buildability decision even though the planner logic itself is deterministic given its input. See §9.

---

## 6. Step 4 — Execution: the backend pipeline

Clicking **Start analysis** calls `startAnalysis(spec)` (`src/services/chatService.ts:69`) → `POST /api/v2/analyses` (`backend-py/app/routers/analyses.py:47`) → `jobs.start_job(spec)`, which spawns `_run_analysis()` (`backend-py/app/services/jobs.py:597`) in a background thread. The frontend then polls `GET /api/v2/analyses/{job_id}` every 2.5 seconds (`pollAnalysis()`, `src/services/chatService.ts:157`) and renders each progress message live.

The pipeline, in order:

1. **Study area resolution** (`resolve_study_area()`, `engine/study_area.py:76`) — geocodes named places (Google Geocoding primary, Nominatim fallback), builds a convex-hull polygon with a buffer, or uses an explicit bbox/point-radius.
2. **H3 grid** (`polyfill()`, `engine/grid.py:22`) — fills the polygon with hexagons at the requested resolution (default 9), auto-degrading resolution if the hex count would explode past `max_hexes` (8000).
3. **PlannerLite plan** is computed here (§5) and logged.
4. **Metro station resolution** (`resolve_metro_stations()`, `engine/metro.py`) — runs early if a metro exclusion is detected, so the exclusion buffer uses verified station coordinates rather than generic OSM `railway=station` tags where possible.
5. **Combined data fetch** — one batched Overpass query for every OSM layer, exclusion, and cross-provider supplement at once, plus per-layer Google Places calls where specified (capped at 6 fetches/job, bounded by a 45-second total Google budget). Every provider call goes through the typed contract in `backend-py/app/providers/base.py` (`run_provider()`): strict timeout, bounded retry only on 429/5xx/network errors (never on timeout), exponential backoff with jitter, a circuit breaker per provider family, and 403/404 responses self-disabling the feature for the rest of the job.
6. **Pass A scoring** (`scoring.pass_a()`, `engine/scoring.py:95`) — every hex scored via BallTree radius counts (Euclidean proxy), weighted mean over only the layers that actually returned data (present-weight renormalization — a missing layer never drags the score to 0 or inflates it).
7. **Corridor/exclusion gating** — linear-feature gates (e.g. "along the EM Bypass," river corridors) and buffer exclusions (metro, named exclusions) applied via `corridors.py`.
8. **Buildability masks** (only if PlannerLite marked this stage relevant) — `engine/buildability.py`: sequential hard-exclusion checks for railway land/tracks, ghats, heritage/protected/open-space land, and a name-matched "maidan" check, followed by a soft commercial-frontage viability proxy. Every mask is OSM-tag-driven; absence of a mask hit means "unknown," never "confirmed buildable." **This is the stage responsible for the 240-second job timeouts observed in live testing** — each of the ~5 sub-checks is its own bounded Overpass call, and their cumulative wall-clock time can exceed the job's total budget even when each individual call is within its own timeout. See `LIVE_PORTAL_QA_FINDINGS.md` §7 (P0 Fix 1) for the planned stage-budget remediation.
9. **Candidate selection** (`scoring.select_candidates()`, `engine/scoring.py:146`) — greedy top-K by composite score with H3 ring-distance dedup so adjacent near-duplicate hexes aren't both shortlisted.
10. **Pass B refinement** — for the shortlisted candidates only: real isochrone/routing verification, Google Places Aggregate refinement, traffic-aware catchments where applicable. Refined values are refit on the candidate-only range so they can actually discriminate between sites.
11. **Route constraint evaluation** (`routing.evaluate_route_constraint()`, `engine/routing.py:184`) — real network routing (Google Routes primary, ORS fallback) to the nearest resolved target, checking distance/time/railway-crossing against the constraint. Never falls back to straight-line distance; an unreachable/unavailable route is marked `"unavailable"`, never silently passed.
12. **Deterministic reliability critic** (`run_deterministic_critic()`, `engine/reliability_critic.py`) — always runs, checking hard GIS facts (coverage ratio, missing critical layers, constraint satisfaction) regardless of whether the optional LLM critic (`services/critic.py`, a senior-consultant-style self-review) is also enabled. The two are merged conservatively (`merge_with_llm_critic()`).
13. **Constraint policy evaluation** (`evaluate_constraint_policy()`, `engine/constraint_policy.py:96`) — the master hard/soft/unknown classification: rent, floor area, zoning, parcel availability, and ownership are always `unvalidatable`; route/waterfront/metro checks are `verified`/`failed` based on what actually happened. `downgrade_status_for_unverified()` then mechanically demotes any `RECOMMENDED` candidate to `CANDIDATE_ZONE` whenever anything is unverifiable — a blanket, structural safety net.
14. **Ranking stability** (`compute_ranking_stability()`, `engine/stability.py`) — re-scores only the final shortlist under 4 controlled weight-multiplier scenarios (balanced / demand-led / access-led / competition-sensitive), labeling each candidate `ROBUST_TOP_CANDIDATE` / `STABLE_TOP_3` / `SCENARIO_SENSITIVE` / `WEAK_UNSTABLE` / `NOT_ENOUGH_CANDIDATES`. Pure local arithmetic, zero new provider calls, never load-bearing (wrapped in try/except, returns `{}` on any failure).
15. **Hard Constraint Verification** (`build_hard_constraint_verification()`, `engine/hard_constraints.py` — added in this repo's most recent commit, `71e374c`) — the newest layer in the pipeline. This is a pure, additive mapping over everything the run has already computed (constraint policy, metro resolution mode, route availability, waterfront enforcement, buildability degradation) into one structured object:
   - Per-constraint status: `verified` / `proxy_verified` / `not_verifiable` / `requested_not_enforced` / `failed` / `not_required`.
   - A summary (`verifiedCount`, `proxyVerifiedCount`, `unknownCount`, `unenforcedCount`, `failedCount`) and an overall `summaryStatus`.
   - Compact per-candidate warnings (`hardConstraintWarnings`) broadcast onto every non-excluded candidate when something analysis-wide is unresolved.
   - A safety-cap re-assertion: an unresolved requested hard constraint can never coexist with the strongest `RECOMMENDED_INVESTIGATION_ZONE` label — this duplicates protection that already existed via the constraint-policy demotion path, made explicit as an invariant.
   - Zero new provider calls; wrapped in try/except so a bug in this layer can never break the underlying analysis — the key is simply omitted from the payload if the build fails.
16. **Three-state result contract.** The job always resolves to exactly one of: `"success"`, `"no_viable_site"` (when a strict spatial constraint — most often a waterfront corridor — leaves zero buildable candidates; live-tested and confirmed working: the Hooghly riverside prompt correctly returned this state with specific, actionable relaxation suggestions rather than a fabricated pick), or `"failed"` (a structured error with `stage`/`errorCode`/`userMessage`/`retryable`/`jobRef` — this is the shape a raw 240-second buildability timeout currently surfaces as).

---

## 7. Step 5 — The result payload

The final payload assembled in `jobs.py` (`job.result = {...}`, ~line 2377) is large and additive across releases. The pieces a reader most needs to know:

| Key | What it is | Since |
|---|---|---|
| `status` | `success` \| `no_viable_site` \| `failed` | v1.4.7 |
| `candidates` / `locations` | ranked candidate zones, each with score, factor breakdown, exclusions, route metrics | — |
| `constraintPolicy` | hard/soft/unknown split (rent, floor area, zoning, parcel, ownership always unvalidatable) | v1.4.0 |
| `analysisCompleteness` | what was verified/skipped/degraded for this specific prompt, with a confidence level (H/M/L) | v1.4.9 |
| `analysisIntelligence` | deterministic prompt classification: business archetype, location intent, risk triggers | v1.5.0 |
| `dataSufficiencyV2` | per-domain (geocoding, boundary, demand, competition, road access, routing, buildability) verified/proxy/unknown/degraded/not-required status + a `final_confidence` and human-readable `confidence_reason` | v1.5.0 |
| `analysisRecommendation` | one of `RECOMMENDED_INVESTIGATION_ZONE` / `PROVISIONAL_CANDIDATE` / `WEAK_CANDIDATE` / `NO_RELIABLE_RECOMMENDATION` / `NO_VIABLE_SITE_IN_CONSTRAINTS` | v1.5.0 |
| `hardConstraintVerification` | the per-constraint verification object described in §6 step 15 | **v1.5.1 (latest, commit 71e374c)** |
| `evidenceTrail` | full secret-safe audit trail of every query/mask/provider call for this run, downloadable as JSON | v1.3.0 |
| `critique` | the always-on deterministic critic's verdict (`reliable`/`weak`/`unreliable`), merged with the optional LLM critic | v1.4.0 |

Live-tested observation worth flagging here: the payload currently exposes **three distinct confidence-ish signals** for the same result — `dataSufficiencyV2.final_confidence`, `critique.verdict`/`confidence`, and each candidate's `confidenceLabel` — and in 3 of 4 canonical test prompts these disagreed with each other (e.g. "high" data sufficiency alongside a "Weak"/"LOW" critic verdict on the identical result). None of the three is wrong on its own terms; nothing currently reconciles or explains the disagreement to the viewer. See `LIVE_PORTAL_QA_FINDINGS.md` §7 (P1 Fix 5).

---

## 8. Step 6 — Frontend rendering

1. **`normalizeAnalysisResult()`** (`src/services/resultNormalizer.ts`) is the mandatory boundary every payload passes through before touching React state. Every field — old or new — is validated, defaulted, or hidden-with-a-warning; a malformed or missing field never crashes the drawer, it just quietly degrades (recorded in `normalizationWarnings`). This same pattern was used to add `hardConstraintVerification`/`hardConstraintWarnings` support without touching how any older payload renders.
2. **`ResultsDrawer.tsx`** (1264+ lines) renders, top to bottom: an analysis-level verdict badge (five-label taxonomy, color-coded), the "Provisional/Recommended/No viable site" banner, an "Analysis scope" card (skipped-vs-degraded, never conflated), a "Data sufficiency" panel, the **"Hard constraint verification"** panel (counts + per-constraint status lines + warning cards for anything unresolved), then the ranked candidate list — each card showing score, investigation label, scenario-stability label, multi-dimensional score pills, and (new) compact hard-constraint warning chips.
3. **`MapView.tsx`** renders the H3 hex-grid choropleth (capped at 3000 cells), catchment/isochrone outlines, and candidate markers on a Leaflet map with OSM/CARTO tiles.
4. **`SpecSummaryCard.tsx`** is what the user sees *before* running — it now also carries a pre-run honesty note (added in the latest commit) that a metro exclusion depends on station data resolving at run time and will be marked "requested but not enforced" rather than silently dropped if it can't.

---

## 9. What's genuinely new since the previous audit (`docs/portal-current-state-audit-v1.5.md`)

That earlier audit (also in this repo) was written against commit `2e1018e`. The one commit since then, `71e374c`, added exactly the **Hard Constraint Verification** layer described in §6.15 / §7 / §8.2 above:
- `backend-py/app/engine/hard_constraints.py` (new module)
- `backend-py/app/services/jobs.py` (wiring block; additive, exception-isolated)
- `src/types/index.ts`, `src/services/resultNormalizer.ts`, `src/components/ResultsDrawer.tsx`, `src/components/SpecSummaryCard.tsx` (frontend surfacing)
- 17 new backend tests (`backend-py/tests/test_hard_constraint_visibility.py`) + 5 new frontend tests

No scoring logic, buildability logic, or provider integrations changed in that commit — it is purely a visibility layer over state the pipeline already computed. It has since been confirmed working correctly in live testing across all four canonical prompts (see `LIVE_PORTAL_QA_FINDINGS.md`).

---

## 10. Known current behavior characteristics (as of this commit/deployment)

These are facts about how the system behaves today, observed via live testing, not aspirational or planned fixes:

- **Reliability:** buildability's sequential Overpass sub-checks can consume the entire 240-second job budget, causing an outright job failure requiring manual retry. Observed live on 2 of 4 canonical prompts in the most recent test pass.
- **Determinism:** the same prompt, submitted fresh in separate sessions, has been observed producing different PlannerLite stage decisions (water/buildability triggered vs. skipped) — traced most plausibly to non-deterministic LLM spec-building occasionally attaching a default water-tagged exclusion.
- **Candidate shortfall transparency:** when fewer than the requested `topN` candidates survive scoring/exclusion, the current UI does not explicitly say how many were requested vs. found, or why.
- **Never overclaims:** in every test run, the system correctly refused a strong "Recommended" label whenever any hard constraint was unverified, unenforced, or failed, and correctly returned a "no viable site" result with specific relaxation suggestions rather than forcing a pick when a strict corridor had zero buildable land.

For remediation status on the reliability/determinism items, see the task list associated with `LIVE_PORTAL_QA_FINDINGS.md` §7.
