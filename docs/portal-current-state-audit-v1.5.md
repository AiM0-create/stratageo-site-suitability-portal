# StrataGeo Portal Current State Audit v1.5

**Scope:** Audit-only pass over the codebase at commit `2e1018e` (v1.5.0 "Analysis Intelligence Lite"). No application logic was changed to produce this document.

---

## 1. Executive Summary

StrataGeo is a **screening / decision-support tool for early-stage site selection in Indian cities**, not a final site-selection or transactional engine. Given a natural-language brief ("premium riverside restaurant between Howrah Bridge and Vidyasagar Setu"), it geocodes a study area, builds an H3 hexagon grid, scores each hex with a multi-criteria weighted model built from OpenStreetMap + Google Places data, applies deterministic hard exclusion masks (water, railway, heritage/protected land), and returns a small set of ranked **candidate zones** (hexagons, not addresses or parcels) with confidence/data-sufficiency labels.

It explicitly and repeatedly (in code comments, disclaimers, and payload fields) refuses to claim parcel-level or transaction-ready precision: `siteClaimLevel` is hardcoded to `"micro_market_zone"` everywhere ([backend-py/app/engine/constraint_policy.py:284](backend-py/app/engine/constraint_policy.py), [backend-py/app/services/jobs.py:2445](backend-py/app/services/jobs.py)), and rent/floor-area/zoning/ownership constraints are always flagged "unverified — not scored" rather than silently guessed.

**Biggest strengths:**
- Deterministic, auditable core (H3 grid + weighted MCDA + hard/soft/unknown constraint separation), not an LLM guessing scores.
- Honest degradation: providers failing or being skipped never silently inflate/deflate a score; they show up as `has_data=False`, `degraded`, or `unknown`.
- A real per-prompt relevance planner (PlannerLite) that skips expensive stages (water geometry, buildability, routing) when the prompt doesn't need them, saving API calls and time.
- A recently-added lightweight "intelligence" layer (v1.5.0) that classifies the business archetype, separates hard/soft/unknown constraints, and computes ranking stability under 4 weight scenarios — all pure local computation, zero new provider calls.

**Biggest limitations:**
- Buildability is a narrow set of hard-coded OSM tag masks (railway/heritage/park/maidan); it is not a real buildability/zoning check and is explicitly documented as such.
- Routing depends on external providers (Google Routes / OpenRouteService) that can be unavailable; when they are, route constraints become `"unavailable"` rather than approximated — correct behavior, but it means constraint verification can silently degrade to "unknown."
- There is a second, older, largely-unused client-side analysis pipeline in the frontend (`src/services/analysisService.ts`, `mcdaEngine.ts`, `promptParser.ts`, `osmService.ts`, `placesService.ts`) that duplicates logic already done server-side; it is reachable only via `config.isDemoMode` or a legacy `/api/analyze` endpoint call, and is a source of confusion/dead-code risk (see §16).
- No automated live-provider or end-to-end browser test is part of the standard test suite; nearly all of the 502 backend tests are pure-function/unit tests.

---

## 2. Repository Structure

```
backend-py/               FastAPI backend — the real analysis engine
  app/
    main.py                FastAPI app factory, router mounting
    config.py               Settings (pydantic BaseSettings) — all provider keys/flags/timeouts
    security.py             App-token / rate-limit middleware helpers
    routers/
      analyses.py            POST /api/v2/analyses (start), GET .../{id} (poll), cancel, evidence
      chat.py                POST /api/v2/chat — conversational spec-building turn (LLM)
      health.py              GET /health — engineVersion from K_REVISION
    engine/                 Pure/deterministic analysis logic (no FastAPI deps)
      study_area.py           Geocoding + study-area polygon construction
      grid.py                 H3 polyfill, hex boundaries
      data_osm.py, data_places.py   Provider-agnostic POI fetch helpers
      poi_merge.py            Places+OSM dedup/merge
      scoring.py               Two-pass MCDA (Pass A Euclidean, Pass B refined)
      corridors.py             Linear-feature (road/river) distance gating
      water.py                 Water-body polygon masks
      buildability.py          Railway/heritage/park/maidan hard masks + frontage proxy
      metro.py                 Metro-station resolution for exclusion buffers
      routing.py               ORS/Google Routes network routing + railway-crossing check
      catchments.py, traffic.py  Isochrone refinement, traffic-aware drive catchments
      constraint_policy.py     Hard/soft/unknown constraint classification
      planner_lite.py          Per-prompt relevance gate + v1.5 intelligence classification
      stability.py              4-scenario ranking-stability check (v1.5)
      reliability_critic.py    Deterministic post-run critic (always on)
      contracts.py              Numeric-safety contract layer (finite floats only)
      evidence_builder.py, results.py   Evidence trail + payload assembly helpers
      canonical_archetypes.py  Hard-coded factor templates per business archetype
      archetypes.py, deterministic_planner.py, intent_parser.py  Prompt→spec support
      multi_score.py            Rank/viability/confidence scoring pass
      uploaded_candidates.py   Alternate mode: score user-supplied candidate points only
      sandbox.py               Sandboxed code-exec helper (used by services/critic.py's LLM path?)
      route_policy.py          Route-constraint interpretation helpers
    providers/               Typed external-API contract layer (v1.4.8)
      base.py                  ProviderResult/ProviderContext/ProviderBudget/run_provider()
      google_places_new.py     Places API (New) Nearby/Text Search + legacy fallback
      google_places_aggregate.py  Places Aggregate (POI counts)
      google_routes.py         Google Routes API
      google_place_enrichment.py  Place Details (rating/price) enrichment
    services/
      jobs.py                  THE orchestrator — ~2470 lines, runs the whole pipeline (§3)
      llm.py, prompts.py       OpenAI-backed conversational spec-building (chat_turn)
      critic.py                Optional LLM post-run critique (merged with deterministic critic)
      archetypes.py            Service-layer archetype helpers
      capabilities.py, storage.py  Feature-capability flags, GCS cache
    models/
      spec.py                  SpecV2 pydantic schema (~644 lines) — the validated analysis contract
      evidence.py              EvidenceTrail schema
      chat.py                  Chat request/response schema
  tests/                    502 pytest tests (see §13)

src/                       React + TypeScript frontend (Vite)
  App.tsx                    Top-level orchestration: chat loop, job polling, result state
  components/
    ResultsDrawer.tsx         Candidate cards, verdict badges, data-sufficiency panel (1264 lines)
    MapView.tsx                Leaflet map: hex grid, catchments, candidates
    SpecSummaryCard.tsx        Pre-run "Analysis scope" plan preview
    FloatingAssistant.tsx      Chat UI
    DiagnosticsPanel.tsx, MethodologyDialog.tsx, AdminDashboard.tsx, SavedAnalyses.tsx, GuidedTour.tsx, TopBar.tsx, LoginScreen.tsx, ErrorBoundary.tsx
  services/
    chatService.ts             THE live client for /api/v2/chat, /api/v2/analyses (poll/cancel)
    resultNormalizer.ts         Defensive normalization boundary for every backend field
    analysisFlow.ts             Pure helpers: confirmation phrases, follow-up vs new-brief detection
    analysisStore.ts            Save/share analysis (Firebase)
    mcdaEngine.ts               Client-side weight-recalculation (recalculateWithWeights) — used live
    analysisService.ts, promptParser.ts, osmService.ts, placesService.ts, sectorTemplates.ts,
    keywordOntology.ts, llmIntentExtractor.ts, domainSignalExtractor.ts, businessClassifier.ts,
    profileBuilder.ts, radiusInference.ts, intentSchema.ts, intentValidator.ts, feasibilityValidator.ts,
    benchmarks.ts, contextResolver.ts, csvParser.ts, spatialBufferEngine.ts, usageTracker.ts,
    userPointManager.ts, sessionStore.ts, resetPatterns.ts
                                — a large **legacy/parallel** client-side analysis pipeline (§16)
  types/index.ts               AnalysisResult/LocationData/DataSufficiencyV2 etc. (561 lines)
  __tests__/                  2 Vitest files (resultNormalizer, analysisFlow)

docs/                       ~30 markdown reports/changelogs from prior releases (v1.1.0→v1.5.0)
api/, local-api-server.mjs, vercel.json, firebase.json   Legacy/adjacent deployment artifacts (Vercel/Firebase) alongside the current GCP Cloud Run + GitHub Pages setup — status unclear from code (see §16)
CHANGELOG.md, README.md      Versioned release notes and top-level docs
```

---

## 3. Current End-to-End Analysis Flow

1. **User prompt entered** — via `FloatingAssistant` chat UI → `sendChatTurn()` ([src/services/chatService.ts:52](src/services/chatService.ts)) → backend `POST /api/v2/chat` ([backend-py/app/routers/chat.py](backend-py/app/routers/chat.py)) → `chat_turn()` ([backend-py/app/services/llm.py](backend-py/app/services/llm.py)), an OpenAI-backed conversational turn that incrementally builds a `SpecV2`.
2. **Prompt interpreted/planned** — deterministic pre-parsing (`intent_parser.parse_raw_intent`, [backend-py/app/engine/intent_parser.py:303](backend-py/app/engine/intent_parser.py)) extracts hard-constraint phrases, business type, geography before the LLM is even asked to reason, then canonical archetype templates (`canonical_archetypes.py`) supply factor weights when the prompt matches a known business type.
3. **Analysis plan shown** — `SpecSummaryCard.tsx` renders the spec (layers, weights, exclusions, feasibility) plus, since v1.4.9, a `plannerPreview` (`AnalysisPlan.to_preview_dict()`, [backend-py/app/engine/planner_lite.py:191](backend-py/app/engine/planner_lite.py)) showing what will/won't be verified for this specific prompt.
4. **User confirms/runs** — `isConfirmationPhrase()`/"Start analysis" button → `startAnalysis(spec)` ([src/services/chatService.ts:69](src/services/chatService.ts)) → `POST /api/v2/analyses` ([backend-py/app/routers/analyses.py:47](backend-py/app/routers/analyses.py)) → `jobs.start_job(spec)` spawns `_run_analysis` in a background thread ([backend-py/app/services/jobs.py:378](backend-py/app/services/jobs.py)).
5. **Providers/data fetched** — `resolve_study_area()` (geocode), `polyfill()` (H3 grid), then one **combined** Overpass query for all OSM layers + exclusions + supplements ([backend-py/app/services/jobs.py:874](backend-py/app/services/jobs.py)), plus per-layer Google Places calls where the spec specifies Places as the provider or as a competition back-up — all gated by `create_analysis_plan()` (§4) so irrelevant stages (water, buildability, routing, Places Aggregate/Details, traffic) are skipped outright.
6. **Candidates generated** — `scoring.select_candidates()` greedily picks the top-K non-excluded, non-overlapping hexes by composite score with H3 ring-distance dedup ([backend-py/app/engine/scoring.py:146](backend-py/app/engine/scoring.py)).
7. **Factors scored** — two-pass MCDA: Pass A scores every hex with Euclidean-radius BallTree counts ([backend-py/app/engine/scoring.py:95](backend-py/app/engine/scoring.py)); Pass B optionally re-scores only the shortlisted candidates with real isochrones/traffic/Places-Aggregate counts, refit on the candidate-only value range so refined layers can discriminate ([backend-py/app/engine/scoring.py:170](backend-py/app/engine/scoring.py)).
8. **Hard gates/constraints applied** — water/water-overlap masks, buildability masks (railway/heritage/park/maidan), corridor/exclusion buffers, and route constraints are OR'd into an `excluded` boolean array before candidate selection; `constraint_policy.evaluate_constraint_policy()` then separately classifies which HARD constraints (rent, footprint, zoning, parcel, ownership, routes, waterfront) could actually be *verified* from data.
9. **Final candidates labelled** — `downgrade_status_for_unverified()` demotes `RECOMMENDED` → `CANDIDATE_ZONE` whenever any hard constraint is unverifiable ([backend-py/app/engine/constraint_policy.py:308](backend-py/app/engine/constraint_policy.py)); v1.5 layers `investigationLabel` (`_investigation_label()`, [backend-py/app/services/jobs.py:249](backend-py/app/services/jobs.py)) and `stabilityLabel` on top of that, and an analysis-level `analysisRecommendation` is derived from the set of per-candidate labels ([backend-py/app/services/jobs.py:2301](backend-py/app/services/jobs.py)).
10. **Map/result UI rendered** — `pollAnalysis()` returns the terminal payload → `normalizeAnalysisResult()` ([src/services/resultNormalizer.ts](src/services/resultNormalizer.ts)) defensively validates every field → `ResultsDrawer.tsx` (candidate cards, verdict badge, data-sufficiency panel) and `MapView.tsx` (hex-grid choropleth, catchment outlines, candidate markers) render the result.

---

## 4. Prompt Understanding / Planning Logic

- **Parsing is a hybrid**: a deterministic regex/keyword pre-parser (`intent_parser.py`) extracts hard-constraint phrases, business type guesses, and spatial relations *before* any LLM call, specifically so hard constraints stated in the prompt can be validated against what the LLM-built spec actually encodes (`validate_hard_constraints_in_spec()`, [backend-py/app/engine/intent_parser.py:339](backend-py/app/engine/intent_parser.py)). The conversational spec-building itself (turning a vague brief into layers/weights/exclusions) **is LLM-driven** (`services/llm.py`, `services/prompts.py`, OpenAI `gpt-5.4*` models per `config.py`), with `stratageo_deterministic_planning=True` and `temperature=0.0`/fixed `seed=42` to keep it as reproducible as an LLM call can be.
- **Business archetype / factor templates**: `canonical_archetypes.py` (908 lines) hard-codes ~10 named archetypes (`STUDENT_QSR_CAFE`, `PREMIUM_RESTAURANT`, `DARK_KITCHEN`, `CLINIC_HEALTHCARE`, `WAREHOUSE_LOGISTICS`, `EV_CHARGING`, `RETAIL_STORE`, `PRESCHOOL_SCHOOL`, `LARGE_FORMAT_RETAIL`, `GENERIC_FALLBACK`), each a `CanonicalArchetype` with a fixed list of `CanonicalFactor` (name, weight, catchment type, direction). `resolve_canonical_archetype()` picks one deterministically from a parser-derived key.
- **v1.5-Lite adds a second, orthogonal classification layer** on top of the existing pipeline — `planner_lite._classify_intelligence()` ([backend-py/app/engine/planner_lite.py:319](backend-py/app/engine/planner_lite.py)) derives `businessArchetype` (food_footfall/hospitality_destination/delivery_kitchen/healthcare/education/logistics/large_format_retail/generic), `locationIntent` (riverfront_or_waterfront/within_travel_time/between_landmarks/near_anchor/along_corridor/outside_exclusion_zone/inside_locality/unspecified), `analysisMode`, `riskTriggers`, `hardGates`, `softFactors`, `unknownConstraints` — purely from regexes over prompt text and already-computed spec fields. **This is metadata only**: it never changes which stages run; the stage gates themselves are decided independently (§ below).
- **Hard vs soft vs unknown**: `constraint_policy.py` regex-classifies rent/lease (`_RENT_RE`), floor-area (`_FOOTPRINT_RE`), zoning (`_ZONING_RE`), parcel availability (`_PARCEL_RE`), and ownership (`_OWNERSHIP_RE`) as **always unverifiable** — these are never scored, only disclosed with a "field validation required" label. Verifiable hard constraints are exclusions/corridors/route constraints/waterfront bands, checked against real geometry.
- **Scenario weighting (balanced/demand-led/access-led/competition-sensitive)** exists **only** as a post-hoc *stability check* (`stability.py`, §6), not as alternative user-selectable "what-if" scoring modes exposed pre-run. It answers "is the ranking sensitive to weight emphasis?", not "show me the demand-led ranking."
- **Determinism caveat**: the planning stage regexes and archetype registry are fully deterministic; the conversational spec-building LLM call is not (LLM calls are inherently non-deterministic even at temperature 0, per prior `V1.2_NONDETERMINISM_AUDIT.md` in docs/).

---

## 5. Candidate Generation and Geography Logic

- **Study area**: for the common "places" mode, all named places in the prompt are geocoded concurrently (Google Geocoding primary, Nominatim fallback), then a convex hull of the geocoded points is buffered by `hullBufferM` (or a flat 2 km buffer for a single place) — see `resolve_study_area()` ([backend-py/app/engine/study_area.py:76](backend-py/app/engine/study_area.py)). `bbox` and `point_radius` modes are also supported.
- **Anchors/landmarks/corridors**: "between X and Y" prompts become a convex hull over the two geocoded anchors; explicit corridors (e.g. a riverfront band) are modeled in `corridors.py` as linear-feature distance gates, not as named landmark objects — there is no separate "anchor" data structure, landmarks are just study-area geocoding inputs.
- **H3 resolution**: `grid.polyfill()` ([backend-py/app/engine/grid.py:22](backend-py/app/engine/grid.py)) fills the study polygon at the spec's requested resolution and **auto-degrades** (lowers resolution) if the hex count would exceed `max_hexes` (default 8000), down to a floor of resolution 7. This is a genuine safety valve against a huge study area blowing up compute.
- **Candidate selection is hex-level, not parcel-level.** `select_candidates()` greedily picks top-K hexes by composite score with a minimum H3-ring separation to avoid picking adjacent near-duplicate hexes. There is **no** parcel/building footprint geometry anywhere in the codebase — `siteClaimLevel` is hardcoded to `"micro_market_zone"`.
- **What the portal can spatially verify**: hex-centroid containment/proximity to real OSM/Places geometry (water polygons, railway lines, road lines, POI points), and (for the top-K only) real network routing distances/times. **What it only approximates**: everything scored in Pass A uses Euclidean (straight-line) radius counts, not network distance — Pass B refinement narrows this gap only for the shortlisted candidates and only for walk/drive catchment factors, not for every factor.
- **Where H3 is useful**: cheap, uniform tiling of an arbitrary polygon for a fast first-pass score, with well-defined ring-distance for dedup. **Where H3 is not enough**: it cannot tell you which side of a hex is buildable, whether a specific plot inside the hex is vacant, or resolve differences smaller than the hex's true area (resolution-dependent, degrades automatically under load — see above) — the code is explicit about this being "screening-level, not exact parcels."

---

## 6. Scoring and Ranking Logic

- **Factor families** (used for scenario weighting and v1.5 classification, not for scoring itself): `competition`, `cotenancy`, `access`, `demand`, classified by regex over the factor's name in `_factor_family()` ([backend-py/app/engine/planner_lite.py:117](backend-py/app/engine/planner_lite.py), reused by `stability.py`).
- **Weights**: each `Layer` in the spec carries its own `weight` (set by the LLM-built spec or the canonical archetype template, user-editable via `SpecSummaryCard`'s weight inputs). Composite score is the **weighted mean over layers that actually have data**, dividing by `present_weight()` (sum of weights of layers with data) rather than the full weight sum — so a missing layer neither drags the score to 0 nor silently normalizes to a fake 10 ([backend-py/app/engine/scoring.py:89](backend-py/app/engine/scoring.py), `pass_a()`).
- **Positive vs negative factors**: each layer has a `direction` (`positive`/`negative`); `normalize()` inverts negative-direction (e.g. competition) values so higher-normalized-score is always "better" — this consistency is explicitly called out to the LLM critic (`services/critic.py`'s system prompt: "every factor score is direction-normalized so HIGHER IS ALWAYS BETTER").
- **Competition treatment**: modeled as an ordinary negative-direction layer (count of competitors within radius), not a special-cased algorithm; there is also a `_cap_competition_whitespace()` helper in `jobs.py` that appears to cap an unrealistic "zero competition" reading (uninspected in this pass — flagged, not verified in depth).
- **Normalization**: `fit_normalization()` supports `minmax` or percentile-based (`pLow`/`pHigh`) per layer; a hard floor prevents divide-by-zero (`hi <= lo → hi = lo + 1.0`). Refined (Pass B) values are **refit on the candidate-only range**, separately from Pass A's grid-wide range, because the two are on different scales (`refit_refined_layers()`, [backend-py/app/engine/scoring.py:170](backend-py/app/engine/scoring.py)); a layer whose refined values are constant across candidates is marked `discriminating=False` and contributes a neutral 0.5 rather than a fabricated 0.
- **Confidence per factor**: exposed via `hasData`/`discriminating`/`refinedSource` per layer per hex in `composite_for_hex()`'s detail dict, and at a coarser level via `factor_support` (`observed` vs `proxy`) in the PlannerLite plan.
- **Low/weak data handling**: a layer with zero fetched POIs is `has_data=False` and contributes **nothing** to the composite (never scored as 0 or a fabricated maximum) — this "absence of data ≠ absence of the thing" rule is stated as a design principle in multiple docstrings.
- **Final score**: weighted mean, computed once as the grid-wide `composite` array (Pass A) for selection, and again per-candidate with full per-layer detail via `composite_for_hex()` for the results payload.
- **Ranking stability (v1.5, new)**: `stability.compute_ranking_stability()` ([backend-py/app/engine/stability.py:67](backend-py/app/engine/stability.py)) re-scores only the final ≤5 shortlisted candidates under 4 weight-multiplier scenarios (balanced/demand_led/access_led/competition_sensitive, ×1.5 on one factor family each) and labels each candidate `ROBUST_TOP_CANDIDATE` / `STABLE_TOP_3` / `SCENARIO_SENSITIVE` / `WEAK_UNSTABLE` / `NOT_ENOUGH_CANDIDATES`. It is wrapped in try/except and returns `{}` on any failure — explicitly non-load-bearing.
- **Client-side re-weighting**: separately, once a result is returned, the frontend can re-rank the *already-fetched* candidates locally by user-adjusted weights via `recalculateWithWeights()` ([src/services/mcdaEngine.ts](src/services/mcdaEngine.ts), used live in `App.tsx:215`) — this is a real, currently-used interactive feature, distinct from the backend stability check.

---

## 7. Hard Gates, Soft Scores and Unknown Constraints

`constraint_policy.evaluate_constraint_policy()` ([backend-py/app/engine/constraint_policy.py:96](backend-py/app/engine/constraint_policy.py)) is the single source of truth for this split:

| Constraint type | Example | Verified how | Effect if unverifiable |
|---|---|---|---|
| **Verified hard constraint** | primary arterial road frontage (as a corridor/exclusion geometry), waterfront band, metro exclusion buffer | Real OSM geometry / resolved station coordinates | Enforced as a hard mask; candidates outside it are excluded outright |
| **Proxy-verifiable** | 10-minute delivery drive radius | Google Routes / ORS network routing on the top-K candidates only | `"unavailable"` per candidate if routing fails — never silently approximated with straight-line distance |
| **Unknown / non-verifiable (always)** | rent cap, floor area / footprint, zoning/licensing, parcel availability, ownership/title | Regex-detected in prompt text; never checked against any data source | Listed in `unverifiedHardConstraints`, `provisionalReasons`; drives `constraintEnforcementLevel` to `"provisional"` |
| **Failed hard gate** | a required data layer returned zero features, or a waterfront corridor could not be enforced for lack of river geometry | — | `constraintEnforcementLevel = "failed"`, `clientReady = False`, `recommendationWithheldReason` set |

`downgrade_status_for_unverified()` then mechanically demotes every non-excluded location's `recommendationStatus` from `RECOMMENDED` to `CANDIDATE_ZONE` and stamps a `"PROVISIONAL — field validation required"` badge whenever **any** hard constraint is unverifiable — this is a blanket demotion, not per-candidate nuance.

Worked examples from the code:
- **Rent cap** ("under ₹X/sqft") → `_RENT_RE` matches → always unverified, never scored, always demotes.
- **Floor area** ("10,000 sq ft") → `_FOOTPRINT_RE` matches → always unverified.
- **Outside metro buffer** → resolved via `metro.py` station data; if station data can't be resolved, the exclusion is explicitly marked **unenforced** (empty mask) with a `LOW confidence` fallback note, not silently skipped.
- **10-minute delivery radius** → a `routeConstraint`; verified per-candidate by real routing, `"unavailable"` if routing fails for that candidate.
- **Primary arterial road** → matched by `_ARTERIAL_RE` for v1.5 risk-trigger labeling, but actual road-access verification is the *soft* commercial-frontage proxy (§8), not a hard, provably-verified constraint.
- **Riverfront strict corridor** → `spec.waterfront.isWaterfront` drives a real geometry-based corridor band; `waterfront_unenforced` (no river geometry found) is a **failed** hard gate, which withholds recommendation entirely.

**Unknown constraints are never scored** — this is enforced structurally (`UnsupportedConstraint.should_score` is hardcoded `False` in `planner_lite.py`) and is one of the more defensible design choices in the codebase.

---

## 8. Buildability Current State

**What exists today is "Buildability Lite" / an "anti-nonsense exclusion" layer, not full buildability.** From `buildability.py`'s own docstring: *"OSM is incomplete in India, so we never invent buildability — absence of a mask is 'unknown', not 'buildable'."*

Concretely ([backend-py/app/engine/buildability.py](backend-py/app/engine/buildability.py)):
- **Hard masks** (candidate hexes excluded outright): railway yards/platforms/stations (`RAILWAY_AREA_TAGS`), rail line buffers (`RAILWAY_LINE_TAGS`, `line_buffer_mask`), protected/heritage/open-space land (`PROTECTED_AREA_TAGS`: parks, nature reserves, pitches, gardens, commons, recreation grounds, grassland/scrub/wood, graveyards, places of worship, anything tagged `historic=*`/`heritage=*`), and open grounds identified only by name regex (`"...Maidan"`, `"Parade Ground"`, `"Mydan"`) since they're frequently untagged in OSM.
- **Soft signal only**: `commercial_viability()` — a road-frontage-or-nearby-commercial-POI proxy, returning `"viable"`/`"weak"` (never `"excluded"`) for the shortlisted candidates only. Explicitly documented as lenient because OSM under-maps Indian streets.
- **When it runs**: gated per-prompt by `PlannerLite` — `_buildability_relevant()` ([backend-py/app/engine/planner_lite.py:253](backend-py/app/engine/planner_lite.py)) triggers it only for waterfront briefs, or prompts mentioning parcel/plot/land-development/construction/resort/township/warehouse/factory/industrial keywords, or explicit "avoid railway" phrasing. **A plain café/QSR prompt with no such signal skips buildability entirely** — this is by design (v1.4.9 YAGNI), not an oversight, and is disclosed via `skippedStages`/`analysisCompleteness.buildabilityVerified`.
- **What is labelled unknown**: any hex that passes all hard masks is *not* thereby "buildable" — absence of a mask hit is explicitly documented as "unknown," and `provisional_reasons` always appends a note that "parcel-level validation remains an offline step before any leasing decision" when buildability wasn't checked.
- **Global vs prompt-triggered**: prompt-triggered only (per above), never runs unconditionally for every analysis.
- **Slowness/timeout risk**: real — the code comments note buildability can cost up to ~4 additional sequential Overpass calls (railway×2, ghat/protected, maidan) per job; this is exactly why v1.4.9 gates it to only relevant prompts. `buildability_overpass_timeout` (30s, `config.py`) bounds each call.
- **Offline/field validation**: the codebase and UI copy are consistent that any leasing/investment decision requires a physical site visit ("Field visit" checklist item is always `"required"` in `constraint_policy.py`, regardless of buildability outcome).

**Framing check**: The UI never claims full buildability exists — `SpecSummaryCard`'s scope preview and `ResultsDrawer`'s data-sufficiency panel both surface `buildability_lite: "not_required"|"degraded"|"verified"` honestly. This is one area where the code and the UI claims are consistent.

---

## 9. Routing / Traffic / Isochrone Current State

- **When triggered**: only when the spec has explicit `routeConstraints` (e.g. "within 10 min drive of X") or the raw prompt was flagged `hasStrictRouteConstraint` by the intent parser, AND `PlannerLite` gates it in (`_routing_relevant()`, [backend-py/app/engine/planner_lite.py:267](backend-py/app/engine/planner_lite.py)). Isochrone refinement (Pass B) is separately gated on whether any layer actually uses a `walk`/`drive` catchment type; traffic-aware catchments additionally require `catchment.trafficAware=True` on a drive layer.
- **Real network routing, not a straight-line proxy**: `routing.route()` ([backend-py/app/engine/routing.py:96](backend-py/app/engine/routing.py)) calls Google Routes API first (if enabled + keyed), falling back to OpenRouteService (ORS) Directions. Both return real network geometry/distance/duration; there is **no** silent Euclidean substitute — if neither provider succeeds, the function returns `None` and the caller marks the constraint `"unavailable"`.
- **Traffic-aware routing**: exists as a distinct catchment mode (`traffic.py`, `traffic_catchment` stage) using Google's traffic-aware drive-time data for the top-K candidates only — this is closer to "current-typical traffic conditions" than true live/real-time traffic, and is capped to the top-K candidates for cost reasons (not confirmed from code whether it reflects live traffic vs. typical/historical traffic-aware estimates — flagged as **unclear from code** without reading `google_routes.py`'s traffic model parameter in full depth).
- **Delivery/walk/drive constraints**: `evaluate_route_constraint()` ([backend-py/app/engine/routing.py:184](backend-py/app/engine/routing.py)) routes each candidate to the nearest of the resolved target points, checks `maxDistanceM`/`maxMinutes`/`avoidRailwayCrossing` against the *natural* shortest route (not an artificially railway-avoiding route) and separately tests whether that natural route crosses a railway line — a deliberate design choice so "avoid railway" answers the user's actual question truthfully rather than reporting false negatives from a detour route.
- **Provider failure handling**: Google Routes failure logs a warning and falls back to ORS; if ORS also has no API key or fails, the constraint is `"unavailable"` for that candidate — never silently treated as passed or failed.
- **Timeouts/fallbacks**: `google_routes_timeout_seconds` (15s default, `config.py`); ORS calls share a rate-limiter token bucket (`catchments._rate_limit`) and are GCS-cached by rounded origin/dest/mode key so repeat routes within a job (or across jobs) are free.
- **ORS/OpenRouteService usage confirmed**: `ORS_DIRECTIONS` endpoint, `foot-walking`/`driving-car` profiles, used for both directions and isochrone refinement (`catchments.py`, not fully read in this pass — flagged, not verified in depth).

---

## 10. Provider/API Usage and Cost Risk

| Provider | Used for | Call pattern | Cached | Timeout | Failure behavior | Cost/perf risk |
|---|---|---|---|---|---|---|
| **Overpass API (OSM)** | POI layers, exclusions, water/railway/protected-land geometry, road lines | 1 combined union query per job for all main layers+exclusions+supplements; separate calls for water, buildability masks (up to 4), railway geometry | GCS-cached for railway geometry only (`storage.cache_key`); main fetch not shown cached | `main_fetch_timeout` 120s, `buildability_overpass_timeout` 30s | Timeout/failure → affected layers scored as zero data (`has_data=False`), never crashes the job | **Medium** — free but multiple sequential mirrors tried on failure (`OVERPASS_ENDPOINTS`), each retry costs latency |
| **Google Places (New) — Nearby/Text Search** | Primary POI source when spec chooses Google, or as competition back-up for an OSM consumer layer | Per layer, capped at `PLACES_FETCH_CAP = 6` fetches/job | Per-job in-memory cache in `ProviderContext.cache` | `google_places_timeout_seconds` 12s | Falls back to legacy Places → OSM-only; never blocks the job | **Medium-High** — paid API, capped by `google_places_total_budget_seconds_per_job` (45s) |
| **Google Places Aggregate** | POI-count refinement for top-K candidates (Pass B) | Only if Google-Places-sourced layers exist AND `PlannerLite` gates it in | Per-job cache | `google_places_aggregate_timeout_seconds` 12s | Degrades to Pass-A Euclidean count | **Medium** — gated by relevance, bounded to top-K |
| **Google Routes API** | Route-constraint validation, traffic-aware catchments | Per required route constraint × top-K candidates | GCS-cached (ORS path); Google Routes path caching unconfirmed | `google_routes_timeout_seconds` 15s | Falls back to ORS | **Medium** — paid, bounded to top-K |
| **Google Place Details (New)** | Evidence-POI enrichment (rating/price) for the results/evidence trail | Capped `google_details_max_places_per_job` (6) | Unconfirmed | Provider-layer default | Enrichment only — never affects scoring | **Low** |
| **OpenRouteService (ORS)** | Directions fallback, isochrone refinement | Per candidate/route, rate-limited via a shared token bucket | GCS-cached by rounded coord/mode key | 60s per direction call | Returns `None` → `"unavailable"` | **Low-Medium** — free tier has hard rate limits |
| **Google Geocoding API / Nominatim** | Study-area place resolution, reverse geocoding for candidate naming | Once per named place, concurrently | Not cached (per-call) | 15s | Google → Nominatim fallback; ungeocoded places are dropped with a note | **Low** |
| **OpenAI (gpt-5.4 family)** | Conversational spec-building (`chat_turn`), optional post-run LLM critique (`critic.py`) | 1+ per chat turn; 1 optional critique per completed job | Not cached (by design — conversational) | Handled via typed `openai.*Error` exception mapping in `chat.py` | Chat turn fails → structured error to UI; critique fails → `None`, analysis proceeds with only the deterministic critic | **Medium-High** — the only true "AI cost" in the system; scales with chat turns, not with grid size |
| **Google Places (legacy Nearby Search)** | Fallback under `google_places_new.fetch_pois_with_fallback` when Places (New) fails | Automatic fallback | — | — | Falls back further to OSM-only | **Low** (rarely the primary path) |

**No pan-India rent/price API, no live-traffic-everywhere call, no Overpass-per-H3-cell pattern exists** — confirmed absent from the code, consistent with the "do not add" list in the v1.5 spec.

---

## 11. Caching, Timeouts and Reliability

- **Cache layer**: `services/storage.py` wraps a GCS-backed JSON cache (`storage.get_json`/`put_json`, keyed by `storage.cache_key(...)` — a hash of rounded coordinates/params) used for railway geometry and ORS routes; provider calls additionally get an in-job `ProviderContext.cache` dict for exact-match dedup within a single run.
- **Provider dedup**: the in-job cache in `ProviderContext` prevents identical Places/Aggregate/Routes calls from firing twice inside one job; there's no cross-job dedup beyond the GCS cache for railway/routes.
- **Stage budgets**: `ProviderBudget` ([backend-py/app/providers/base.py:66](backend-py/app/providers/base.py)) enforces a per-job wall-clock ceiling (`google_places_total_budget_seconds_per_job`, 45s) across all Google calls; once exhausted, further calls short-circuit to `status="degraded", degradation_reason="google_budget_exhausted"` without even attempting the request.
- **Total analysis timeout**: `job_max_runtime_seconds` (240s, `config.py`) is the backend's hard ceiling — confirmed referenced but the exact enforcement point inside `_run_analysis` was not read line-by-line in this pass (**unclear from code** exactly where/how it's checked mid-loop vs. only via an outer `asyncio.wait_for`).
- **Graceful degradation**: pervasive and consistent — every optional provider call in `jobs.py` goes through `_degradable_call()` (a wrapper around `asyncio.wait_for` + circuit breaker) with an explicit `default=(...)` fallback value, and every degradation is recorded in `fallbacks`/`_provider_degraded` and surfaced in the final payload (`degradationNotes`, `providerDiagnostics`, `analysisCompleteness.degradedStages`).
- **Circuit breaker**: `ProviderBreaker` class in `jobs.py` (duck-typed `is_open(label)`/`record_failure(label)`) — a per-job breaker keyed by provider family, consulted by `run_provider()` in `providers/base.py` before every call.
- **Stuck-analysis prevention**: server-side, `job_max_runtime_seconds` is the backstop; client-side, `pollAnalysis()` in `chatService.ts` adds a `MAX_POLL_MINUTES` (6 min) hard deadline **and** a `WATCHDOG_STALL_MS` (220s) stall detector that fires if neither progress% nor message changes — explicitly documented as a *fallback* safety net, not the primary timeout mechanism.
- **Cancel behavior**: `POST /api/v2/analyses/{id}/cancel` ([backend-py/app/routers/analyses.py:86](backend-py/app/routers/analyses.py)) marks the job cancelled; `JobCancelled` is raised and caught at multiple checkpoints inside `_run_analysis` (confirmed via the `except JobCancelled: raise` pattern seen at the OSM fetch step) so a cancel actually interrupts a running job rather than just hiding it in the UI. The endpoint always returns 200 even for an already-finished/unknown job, by design, so the UI never has to know the job's state before calling it.
- **Retry behavior**: `run_provider()` retries ONLY on retryable HTTP codes (429/5xx) or network/transport errors, with exponential backoff + jitter, up to `max_retries` (typically 2); a **timeout is never retried** (explicitly, to avoid stacking against the job budget); HTTP 403/404 self-disables the feature for the rest of the job rather than retrying (these usually mean "API not enabled for this key").
- **Honest gap**: no evidence of a global "kill switch" that cancels a job purely because *total elapsed wall time* (as opposed to per-stage timeouts) crossed a threshold mid-stage — this relies on the sum of per-stage timeouts staying under `job_max_runtime_seconds`, which is a soft guarantee, not an enforced one, unless there's an outer wrapper not located in this pass.

---

## 12. Output Payload and UI Rendering

**Backend result payload** (`job.result`, assembled at [backend-py/app/services/jobs.py:2377](backend-py/app/services/jobs.py)) is large and has grown additively across five releases. Key groups:
- **Three-state contract** (v1.4.7): `status: "success"|"no_viable_site"|"failed"`, `analysisId`, `jobRef`.
- **Candidates**: `candidates`/`locations` (legacy duplicate key) — each a dict with recommendation status, criteria breakdown, route metrics, and (v1.5) `investigationLabel`, `stabilityLabel`, `scenarioRanks`, `stabilityNote`.
- **Map layers**: `hexGrid` (capped 3000 cells), `catchments`, `studyAreaBoundary`, referenced by a `mapLayers` index rather than duplicated.
- **Factor scores**: `factorScores` — per-factor confidence/degraded flag + per-hex raw/normalized values (evidence-trail-oriented, contract-typed via `contracts.py`).
- **Constraint/data-quality**: `constraintValidation`/`constraintPolicy` (hard/soft/unknown split, §7), `dataCoverage`, `dataSufficiency` (legacy), `dataSufficiencyV2` (v1.5 — per-domain verified/proxy/unknown/degraded/not_required + `final_confidence`/`confidence_reason`).
- **v1.5 additions**: `analysisIntelligence` (the classification object from §4), `analysisRecommendation` (one of the 5-value investigation-zone taxonomy), `analysisCompleteness` (v1.4.9 — what was verified/skipped/degraded, confidence H/M/L).
- **Evidence trail**: `evidenceTrail` — a "secret-safe" serialization (`safe_dict()`) of the full evidence chain (queries made, masks applied, provider calls) for audit/download via `GET /api/v2/analyses/{id}/evidence.json`.
- **Always-present disclaimer + siteClaimLevel** (`"micro_market_zone"`), critic verdict (`critique`, always the deterministic critic, optionally merged with the LLM critic).

**Frontend rendering**:
- `resultNormalizer.ts` ([src/services/resultNormalizer.ts](src/services/resultNormalizer.ts)) is the defensive boundary — every new/legacy field is validated and defaulted before touching React state; malformed v1.5 fields are dropped with a console warning rather than crashing the UI (confirmed via the 4 new tests in `resultNormalizer.test.ts` covering old-payload compatibility, well-formed v1.5, malformed-field dropping, and partial defaults).
- `ResultsDrawer.tsx` renders: analysis-level verdict badge (`ANALYSIS_RECO_META` lookup, using `analysisRecommendation`), per-candidate criteria bar chart (`ComparisonChart`), a "Data sufficiency" panel (`DS_STATUS_META` chips for verified/proxy/unknown/degraded/not_required), per-candidate stability label, and an unsupported-constraints banner reading "Field validation required — not scored (cannot be verified from data)".
- `MapView.tsx` renders the hex-grid choropleth, catchment polygons, and candidate markers (not read in full depth this pass — file exists and is wired from `App.tsx`, structure not verified line-by-line).
- `SpecSummaryCard.tsx` renders the pre-run plan preview (feasibility badge, layers with editable weights, `plannerPreview`'s will-verify/skipped/cannot-verify lists, v1.5's compact archetype/analysisMode/riskTriggers).
- **Backend fields not yet surfaced in the frontend** (based on `types/index.ts` vs. the full `jobs.py` payload): `analysisIntelligence.hardGates`/`softFactors` (full structured list, only `archetype`/`analysisMode`/`riskTriggers` are shown via `plannerPreview`), `providerDiagnostics.googleCalls` (raw per-call log — evidence-trail only, not shown in the main UI), `metroValidation` full detail (only used to gate an exclusion, not displayed), `dataCoverage` (legacy field, unclear if still rendered anywhere distinct from `dataSufficiencyV2`).

---

## 13. Current Test Coverage

- **Backend**: `pytest` — 502 `def test_*` functions across ~34 files in `backend-py/tests/`. Run via `pytest backend-py/tests` (exact invocation not re-verified in this pass; not executed to avoid live-provider calls per the audit's "do not run expensive live tests" instruction).
- **Mocked vs pure-function tests**: only ~12 of the ~34 test files reference `monkeypatch`/`mock`/`respx` (provider-level mocking) — e.g. `test_v148_google_providers.py` (26 tests, provider fallback chains), `test_v147_contract.py` (16 tests, numeric contract), `test_v15_intelligence.py` (13 tests), `test_v149_planner_lite.py` (11 tests). The remaining ~22 files (`test_buildability.py`, `test_water.py`, `test_scoring.py`, `test_corridors.py`, `test_spec.py`, `test_multi_score.py`, `test_intent_parser.py`, etc.) are pure-function unit tests over deterministic engine logic with synthetic inputs — no network calls, no mocking needed.
- **v1.5 tests**: `test_v15_intelligence.py` — classification pins for the four canonical prompts, determinism checks, stability-label edge cases, factor-family classifier, full payload contract, supermarket verdict capping, dark-kitchen routing verification, degraded-provider sufficiency reflection.
- **Frontend**: Vitest — only 2 test files (`resultNormalizer.test.ts`, `analysisFlow.test.ts`) despite ~40 files under `src/services/` and ~13 React components. **This is the most under-tested area of the codebase** — `mcdaEngine.ts` (client-side scoring/re-weighting), `promptParser.ts`, all of `ResultsDrawer.tsx`/`MapView.tsx`/`SpecSummaryCard.tsx` (React component logic) have no automated tests.
- **No live-provider or end-to-end browser tests are part of the standard suite** — the "four canonical prompts" testing referenced in prior release docs was done via manual/agent-driven smoke testing against the deployed instance, not as a repeatable automated test.
- **Gaps**: no frontend component tests, no integration test that runs a full `_run_analysis()` job end-to-end with mocked providers (tests exercise individual engine functions, not the `jobs.py` orchestration as a whole), no test asserting the full `job.result` payload shape against `types/index.ts` (i.e., no contract test between backend payload and frontend type).

---

## 14. Findings from the Four Canonical Test Prompts

*(Based on code inspection and the pinned assertions in `test_v15_intelligence.py`/`test_v149_planner_lite.py`, not a live run.)*

### Prompt 1: Quick-service cafe near Ruby crossing and EM Bypass
- **Expected archetype**: `food_footfall` (via `_FOOD_RE` matching "cafe", or `student_qsr_cafe`/`generic_qsr_cafe` canonical registry key → `food_footfall` family).
- **Location intent**: `near_anchor` (matches `_NEAR_RE`: "crossing").
- **Factors**: footfall/demand, competition (café density), access/road proximity — from the QSR canonical template.
- **Hard gates**: none beyond standard exclusions unless the prompt states one explicitly.
- **Skipped checks**: water_geometry (no water signal), buildability (no land-development/parcel/railway-avoidance signal) — both skipped with `saved_cost: "high"`. Routing skipped unless a travel-time phrase is present.
- **Likely limitations**: purely Euclidean-radius footfall proxy at Pass A; no true buildability check for this prompt by design.

### Prompt 2: Premium riverside restaurant between Howrah Bridge and Vidyasagar Setu
- **Expected archetype**: `hospitality_destination` (via `_HOSPITALITY_RE` + `_FOOD_RE`, or `premium_restaurant` canonical key).
- **Location intent**: `riverfront_or_waterfront` (water relevance wins over "between" landmark phrasing per the `_location_intent()` priority order).
- **Strict corridor handling**: `_water_relevant()` returns `True` on "riverside"; `analysisMode = "strict_corridor"` if `strict` phrasing detected (e.g. "strictly riverside") else `"buildability_lite_required"`.
- **Water/buildability/heritage risks**: water_geometry is **required** (not skipped); buildability is **required** because water=True forces it (`_buildability_relevant()` returns True whenever water is relevant, citing ghat/heritage risk explicitly). `riskTriggers` includes `"waterfront"`.
- **Likely result behavior**: if no river geometry is found for the named corridor, `waterfront_unenforced=True` → `constraintEnforcementLevel="failed"` → recommendation **withheld entirely**, not merely demoted — this is the strictest failure path in the codebase.

### Prompt 3: 10,000 sq ft discount supermarket in Sector V with primary arterial road and rent cap
- **Expected archetype**: `large_format_retail` (via `_LARGE_FORMAT_RE` on "supermarket") — the `_v15_intelligence` test suite specifically pins a "supermarket verdict capping" case, implying the deterministic critic or reliability critic imposes a ceiling on confidence/verdict for large-format retail (verified as a named test scenario; the capping mechanism itself not read line-by-line).
- **Large-format logic**: `analysisMode = "large_format_screening"` when no water/routing/buildability signal dominates.
- **Road-access proxy**: `_ARTERIAL_RE` matches "primary arterial road" → `riskTriggers` includes `"primary_arterial_required"`; actual verification is the same soft `commercial_viability()` frontage proxy as any other prompt — there is **no dedicated "primary arterial" geometry check**, it's the generic frontage-or-nearby-POI heuristic.
- **Rent/floorplate unknowns**: `_RENT_RE` (rent cap) and `_FOOTPRINT_RE` (10,000 sq ft) both match → two `unsupported_constraints` entries → `unknownConstraints: ["rent_or_lease_price", "floor_area_footprint"]`, `riskTriggers` includes `"rent_cap"` and `"large_floorplate"`.
- **Recommendation demotion**: guaranteed — any match on rent/footprint forces `constraintEnforcementLevel="provisional"`, demoting `RECOMMENDED`→`CANDIDATE_ZONE` for every candidate.

### Prompt 4: Dark kitchen in South Kolkata within 10-minute delivery drive of Ballygunge Phari and outside 1km metro radius
- **Expected archetype**: `delivery_kitchen` (via `_DARK_KITCHEN_RE`).
- **Routing trigger**: `_routing_relevant()` returns True from the explicit "within 10-minute delivery drive" route constraint → routing is a **required** stage; `riskTriggers` includes `"delivery_time_sensitive"`.
- **Metro exclusion**: handled by `metro.py`'s station resolution overriding generic OSM `railway=station` tags with verified metro-only coordinates; if unresolved, the exclusion is explicitly marked **unenforced** (not silently ignored).
- **Demand/access factors**: dark-kitchen archetype skips the frontage-proxy check specifically ("delivery-only kitchen has no walk-in frontage requirement" — [backend-py/app/engine/planner_lite.py:463](backend-py/app/engine/planner_lite.py)), a genuinely archetype-aware YAGNI decision.
- **Likely limitations**: buildability is skipped (no water/land-development signal) unless "avoid railway" is also stated; if metro station data can't be resolved for this specific area, the "outside 1km metro" constraint silently becomes unenforced rather than blocking the run — a real correctness risk if not surfaced clearly enough in the UI.

---

## 15. Known Strengths

- **Deterministic factor templates** (`canonical_archetypes.py`) give reproducible weights/factors for known business types, independent of LLM variance.
- **Hard/soft/unknown constraint separation** (`constraint_policy.py`) is structurally enforced (`should_score=False` hardcoded), not just a convention.
- **Data sufficiency is honest and granular** (`dataSufficiencyV2`), built from real run state rather than a static disclaimer.
- **Graceful degradation is the default, not an afterthought** — every optional provider path has a typed fallback value and is surfaced in `degradationNotes`/`analysisCompleteness`.
- **No fake rent/floorplate verification** — these are structurally excluded from scoring, always labeled unverified.
- **H3 screening** is a reasonable, well-understood approach for micro-market-level (not parcel-level) screening, with an automatic resolution-degradation safety valve for oversized study areas.
- **Scenario weights (stability check)** add a genuinely useful, zero-cost signal (ranking robustness) without inflating API cost or run time.
- **Deterministic critic always runs** (`reliability_critic.py`) regardless of whether the optional LLM critic is enabled — a safety net that doesn't depend on an external API being up.
- **Field-validation labeling is consistent** across backend payload and frontend copy ("Field validation required", "PROVISIONAL — field validation required").
- **No unbounded/uncontrolled provider explosion**: `PLACES_FETCH_CAP`, `google_places_total_budget_seconds_per_job`, `google_details_max_places_per_job`, `max_hexes`, `PlannerLite`'s relevance gating all bound cost deliberately.
- **PlannerLite's per-prompt relevance gating** is a real architectural improvement — it measurably reduces Overpass/Google calls for prompts that don't need water/buildability/routing, and does so via clear deterministic rules, not guesswork.

---

## 16. Known Gaps and Risks

### Analysis logic gaps
- **Metro/exclusion silent-unenforced fallback** (§14, Prompt 4) — severity: **medium**. If station data can't be resolved, an exclusion constraint the user explicitly asked for becomes unenforced with only a backend note; user impact is a false sense of compliance unless the UI surfaces this loudly. Fix difficulty: low (surface more prominently in `ResultsDrawer`). No cost/speed risk.
- **`_cap_competition_whitespace()`** in `jobs.py` was not read in depth — unclear from code what threshold/logic it applies. Severity: **low-medium** (could mask a genuine "zero competition" finding as capped/adjusted). Fix difficulty: unknown without deeper reading.

### Data gaps
- **OSM under-mapping of Indian streets/POIs** is repeatedly acknowledged in code comments (buildability frontage proxy is deliberately lenient because of this) — severity: **medium**, inherent to the data source, not fixable without a paid alternative (which the spec explicitly forbids adding).
- **No parcel/legal/zoning data source of any kind** — severity: **high** if a user misreads "candidate zone" as a buildable parcel; mitigated by consistent disclaimers, but the underlying data gap is real and cannot be closed without a paid data source (explicitly out of scope).

### Buildability gaps
- **Narrow tag coverage**: only railway/heritage/protected/maidan-by-name are hard-masked. Other real no-build categories (e.g. active construction sites, government/defense land not tagged `historic`/`heritage`, private compounds) are not covered and would show as "unknown," not "excluded." Severity: **medium**, inherent OSM limitation.
- **Buildability is entirely skipped for the majority of prompt types** (anything without water/land-development/anti-rail signal) — by design, but a user requesting a "safe from railway"-style constraint informally (without matching the exact regex phrasing) would get **no** buildability check and no visible warning beyond the generic "buildability not checked" note. Severity: **medium**, user impact depends on how carefully they read the plan preview.

### Routing/traffic gaps
- **Traffic-aware vs. live traffic is unclear from code** in this pass (§9) — severity: **low-medium**, matters for delivery-time-sensitive archetypes (dark kitchens) where "10-minute" claims materially affect the recommendation.
- **Routing failure → "unavailable"** is correct behavior but reduces effective constraint coverage silently unless surfaced; currently it does flow into `dataSufficiencyV2.routing = "degraded"`, which is good, but the per-candidate `"unavailable"` reason isn't obviously surfaced in `ResultsDrawer` beyond the aggregate label (not fully verified — flagged).

### UI/UX gaps
- **Backend fields not surfaced**: `analysisIntelligence.hardGates`/`softFactors` full detail, `providerDiagnostics.googleCalls`, full `metroValidation` — a power user or analyst reviewing the evidence trail has to download the JSON rather than see it in the main UI. Severity: **low**, no correctness impact, just discoverability.
- **Legacy/parallel frontend pipeline** (`analysisService.ts`, `mcdaEngine.ts`'s scoring functions other than `recalculateWithWeights`, `promptParser.ts`, `osmService.ts`, `placesService.ts`, `sectorTemplates.ts`, `keywordOntology.ts`, `llmIntentExtractor.ts`, and related files) appears to duplicate logic that now lives server-side, reachable only via `config.isDemoMode` or a legacy `/api/analyze` endpoint not present in the current backend router list (`analyses.py`/`chat.py` only expose `/api/v2/*`). Severity: **medium** — dead-code/confusion risk for future maintainers, and a real risk that a bug fix applied only to the backend engine leaves this parallel path silently stale. Not confirmed dead (still imported and reachable via `config.isDemoMode`), so removal needs a deliberate decision, not blind deletion.
- **Legacy deployment artifacts** (`vercel.json`, `firebase.json`, `api/`, `local-api-server.mjs`) alongside the current GCP Cloud Run + GitHub Pages setup — status **unclear from code**; could be stale from an earlier deployment architecture.

### Reliability/performance gaps
- **No confirmed single enforcement point for total job wall-clock time** beyond the sum of per-stage timeouts (§11) — **unclear from code** without deeper reading of `_run_in_thread`/`_run_analysis`'s outer structure.
- **Per-job GCS cache** exists for railway geometry and ORS routes but not confirmed for the main Overpass union fetch — repeat analyses of the same/overlapping area may re-fetch OSM data unnecessarily. Severity: **low** (Overpass is free, but slow and rate-limited by public mirrors).

### Testing gaps
- **Frontend test coverage is thin** (2 files vs. ~40 service files + 13 components) — severity: **medium**, especially for `mcdaEngine.ts` (live client-side re-scoring logic with zero automated tests) and all React component rendering logic.
- **No orchestration-level integration test** for `jobs._run_analysis()` as a whole — all engine-function tests are unit-level; a regression in how stages compose (e.g. a payload key silently disappearing) would only be caught by the frontend's `resultNormalizer` tests or manual QA, not a backend integration test.
- **No automated contract test between backend payload shape and frontend `types/index.ts`** — the two are kept in sync manually across releases (as evidenced by this session's own change log discipline), which is a process control, not a code control.

---

## 17. What Should Not Be Done

- Do not add pan-India rent estimation or any rent/price API — rent is structurally treated as unverifiable by design; adding it would require a paid data source not currently integrated and would break the "never invent buildability/pricing" principle.
- Do not run Overpass per H3 cell — the entire architecture is built around one combined union query per job specifically to avoid this; reverting to per-cell queries would explode both latency and mirror load.
- Do not add live traffic everywhere — traffic-aware catchments are already deliberately scoped to top-K candidates only for cost reasons.
- Do not claim parcel-level recommendations — `siteClaimLevel` is hardcoded `"micro_market_zone"` throughout; changing this without an actual parcel data source would be a false claim, not an engineering improvement.
- Do not turn unknown constraints into scores — `UnsupportedConstraint.should_score=False` is a structural guarantee; any change here needs to preserve "never scored, always disclosed."
- Do not reintroduce unbounded buildability (running the full railway/ghat/heritage/maidan mask stack for every prompt regardless of relevance) — this was the exact resource waste PlannerLite (v1.4.9) was built to eliminate.
- Do not let provider failures block completion — every provider call in the codebase already degrades gracefully; any new provider integration must follow the same `run_provider()`/`_degradable_call()` pattern.
- Do not overfit to only the four canonical prompts — the classification regexes in `planner_lite.py` are broad pattern families (e.g. `_FOOD_RE`, `_HOSPITALITY_RE`), not hardcoded to the exact four test phrases; future prompt-shape work should preserve this generality rather than special-casing new literal strings.

---

## 18. Safe Improvement Opportunities

### Zero/new API cost changes
- Surface `metroValidation.mode`/confidence and unenforced-exclusion state more prominently in `ResultsDrawer` when it's `"generic_station_fallback"` or unresolved — pure UI change, uses data already in the payload. **Benefit**: closes the "silent unenforced exclusion" UX gap (§16). **Risk**: none — additive UI only. **Files**: `src/components/ResultsDrawer.tsx`. **API cost change**: none.
- Surface `analysisIntelligence.hardGates`/`softFactors` (already computed, already in the payload) in a collapsible "Analysis detail" section. **Benefit**: closes a UI discoverability gap. **Risk**: none. **Files**: `src/components/ResultsDrawer.tsx`, `src/types/index.ts` (already has the loosely-typed field). **API cost**: none.

### Low compute local logic changes
- Document (or, if truly dead, deprecate behind a clearer flag) the legacy `analysisService.ts`/`mcdaEngine.ts` client-side pipeline's actual current usage so future contributors don't maintain two implementations of the same logic by accident. **Benefit**: reduces future maintenance risk. **Risk**: requires confirming `config.isDemoMode`'s real-world usage first (do not delete blindly). **Files**: `src/services/analysisService.ts` and siblings. **API cost**: none (this is deletion/consolidation, not a feature).
- Add a small deterministic check that flags in `provisionalReasons` when a stated exclusion (metro, etc.) ends up unenforced, elevating it from a backend-only note to a payload field the UI is guaranteed to check. **Benefit**: closes a real correctness-visibility gap. **Risk**: very low, pure additive dict field. **Files**: `backend-py/app/services/jobs.py` (near the existing `_metro_excl_unenforced` handling).

### UI-only clarity changes
- Add a short inline explainer near the "Recommended Investigation Zone" badge clarifying it's a screening label, not a final recommendation (the disclaimer already exists at the payload level; making it more visible at the badge itself costs nothing).
- Show `dataSufficiencyV2.confidence_reason` (already computed, a ready-made human-readable sentence) directly under the analysis-level verdict badge instead of only in the sufficiency panel.

### Testing/observability changes
- Add Vitest coverage for `mcdaEngine.ts`'s `recalculateWithWeights()` — it's a live, user-facing feature with zero current tests. **Benefit**: closes the single largest test gap identified in §13. **Risk**: none, pure test addition. **Files**: new `src/__tests__/mcdaEngine.test.ts`.
- Add one backend integration test that runs `jobs._run_analysis()` end-to-end with all providers mocked/stubbed, asserting the full `job.result` key set matches what `types/index.ts` expects. **Benefit**: catches payload-shape regressions before they reach the frontend. **Risk**: none if properly mocked (no live provider calls). **Files**: new `backend-py/tests/test_e2e_payload_contract.py`.

---

## 19. Recommended Next Engineering Step

**Add explicit UI surfacing for unenforced-but-requested hard constraints** (starting with the metro-exclusion case documented in §14/§16): when `metroValidation.mode` is `"generic_station_fallback"` or a requested exclusion/route constraint ends up unenforced, show a clear, non-dismissible warning on the specific affected candidate cards (not just a buried backend note) — e.g. "Metro exclusion could not be verified for this zone."

This is small (a payload-field-driven UI conditional plus wiring a value that already exists in `metroValidation`/`_metro_excl_unenforced` into the result), safe (pure additive UI, zero new provider calls, zero scoring changes, zero speed impact), and directly closes the single most concrete correctness-visibility gap found in this audit — a case where the system silently does *less* than the user explicitly asked for, and the current UI does not make that unmistakable at the point where a leasing/investment decision might be made.

---

## 20. Appendix

### Important file map (see §2 for full listing)
- Orchestrator: [backend-py/app/services/jobs.py](backend-py/app/services/jobs.py) (`_run_analysis`, 2468 lines)
- Relevance/classification: [backend-py/app/engine/planner_lite.py](backend-py/app/engine/planner_lite.py)
- Constraint policy: [backend-py/app/engine/constraint_policy.py](backend-py/app/engine/constraint_policy.py)
- Buildability: [backend-py/app/engine/buildability.py](backend-py/app/engine/buildability.py)
- Scoring: [backend-py/app/engine/scoring.py](backend-py/app/engine/scoring.py)
- Stability: [backend-py/app/engine/stability.py](backend-py/app/engine/stability.py)
- Provider contract: [backend-py/app/providers/base.py](backend-py/app/providers/base.py)
- Spec schema: [backend-py/app/models/spec.py](backend-py/app/models/spec.py)
- Frontend result boundary: [src/services/resultNormalizer.ts](src/services/resultNormalizer.ts)
- Frontend results UI: [src/components/ResultsDrawer.tsx](src/components/ResultsDrawer.tsx)

### Important functions/classes
`create_analysis_plan()`, `AnalysisPlan` (planner_lite.py) · `evaluate_constraint_policy()`, `downgrade_status_for_unverified()` (constraint_policy.py) · `pass_a()`, `composite_for_hex()`, `select_candidates()` (scoring.py) · `compute_ranking_stability()` (stability.py) · `run_provider()`, `ProviderResult`, `ProviderContext`, `ProviderBudget` (providers/base.py) · `run_deterministic_critic()`, `merge_with_llm_critic()` (reliability_critic.py) · `_investigation_label()`, `ProviderBreaker`, `_degradable_call()` (jobs.py)

### Commands run during this audit
- `git status --short`, `git log --oneline -5`
- `Glob`/`Read`/`Grep` over `backend-py/app/**/*.py` and `src/**/*.{ts,tsx}`
- `wc -l` over backend and frontend source files (line-count survey)
- `grep -c "^def test_"` / `grep -rn "def test_"` / `grep -rln "monkeypatch|mock|Mock|respx"` over `backend-py/tests/*.py` (test composition survey)
- No tests were executed; no servers were started; no external APIs were called.

### Git status
- **Before**: 1 untracked file (`../STRATAGEO_PORTAL_FULL_CONTEXT.md`, outside the audited repo tree, pre-existing, unrelated to this pass).
- **After**: same untracked file, plus this new file (`docs/portal-current-state-audit-v1.5.md`). No tracked file was modified.

### Uncertainty / not fully verified in this pass
- `catchments.py`, `traffic.py`, `metro.py`, `multi_score.py`, `evidence_builder.py`, `MapView.tsx` were referenced and partially inspected but not read line-by-line — their high-level role is stated correctly from headers/call-sites, but internal logic details are not independently verified.
- Whether live/real-time traffic data (vs. traffic-aware historical/typical estimates) is actually used by Google Routes in this codebase — **unclear from code** without reading `providers/google_routes.py` in full depth.
- The exact enforcement mechanism (single call site) for `job_max_runtime_seconds` as a true wall-clock kill-switch across the whole `_run_analysis()` — **unclear from code** without a full line-by-line read of `_run_in_thread`.
- `_cap_competition_whitespace()`'s exact logic in `jobs.py` — noted to exist, not read in depth.
- Whether `vercel.json`/`firebase.json`/`api/`/`local-api-server.mjs` are live, deprecated, or environment-specific — **unclear from code** without checking actual deployment configuration/CI outside the repo.
- Whether the legacy `analysisService.ts`/`mcdaEngine.ts` scoring path (`config.isDemoMode`) is ever actually enabled in production, or only in local dev — **unclear from code** without checking the deployed `config` values.
