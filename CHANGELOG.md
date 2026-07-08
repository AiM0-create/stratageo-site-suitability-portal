# Changelog

All notable changes are documented here. Format: [SemVer](https://semver.org).

---

## [Unreleased — housekeeping] — 2026-07-08 — Historical docs archived

No code changed; no version bump; no backend redeploy. 34 version-specific
historical documents (v0.8.x–v1.4.x release notes, deployment checklists,
post-deploy smoke tests, phase audits, superseded reports, and the
`upgrade_backups/` baseline) moved from `docs/` into `docs/archive/` with an
index README; the 8 living documents (engine change log, QA findings,
security review, current-state audits, framework walkthroughs, known
limitations) stay at `docs/` root. CHANGELOG/README pointers to the moved
files updated. A `v1.6.7` release tag was added on GitHub.

---

## [1.6.7] — 2026-07-08 — Report Map & Weight-Responsive Grid Ranks

Cumulative release (includes the boss-numbered v1.6.5 and v1.6.6 fixes that
were never separately shipped). Backend + frontend.

### Added (v1.6.7)
- **The PDF report now contains the map** (`src/services/mapFigure.ts`) — a
  self-rendered analytical figure drawn from the analysis data itself (H3
  suitability surface in the on-screen colours, excluded land greyed, the
  study-area boundary, numbered pins for ranked zones, a legend, and a scale
  bar). Deliberately not a tile screenshot: no basemap licensing/CORS risk,
  cannot fail at render time, and every pixel is defensible. When the
  recommendation is withheld the figure renders grey (the PDF can never look
  more confident than the verdict); custom weights are disclosed in the
  caption. Each ranked zone's detail page also gains a clickable **"Open in
  Google Maps"** link for field validation.
- **Every eligible grid cell is ranked** (`computeGridRanks`): hovering a
  cell shows "Overall suitability: 7.2/10 — rank 17 of 214 eligible cells";
  ranks recompute instantly under the weight sliders.
- **The top-X selection now responds to weights** (`selectTopCellsFromGrid`):
  moving sliders re-selects the top X zones from the whole re-weighted grid
  (with a centroid-distance approximation of the backend's H3-ring
  near-duplicate rule) and shows them as dashed amber numbered pins plus a
  list in the results panel — a zone that was never in the original
  shortlist can now surface when priorities change. These are explicitly
  labeled **screening basis — not yet verified** (no isochrone/routing/
  Places refinement has run for them), with a bold caveat when the prompt
  carried a travel-time constraint. The original verified candidates keep
  their green pins and full verification.

### Fixed (v1.6.5, backend)
- **Refined scores are relative and now say so** — live confusion: a
  criterion showed "0.0" with "934 features observed". Refined (Pass-B)
  values compare shortlisted candidates against each other; 0.0 means
  "lowest among the candidates", not "terrible". Each refined criterion now
  carries a `comparative` block (basis relative-to-shortlist, n, min, max,
  position) surfaced in the drawer/report.
- **Spread-aware refit** (`scoring.py`): near-identical refined values
  (e.g. 934 vs 1010) no longer contrast-stretch to 0.0 vs 10.0 — they
  compress toward neutral; genuinely different values still use the full
  range; constant values stay neutral and are flagged non-discriminating.
- **Evidence badges report the actual data source** — real OSM/Google counts
  were displaying as "AI-generated" whenever a layer had low confidence; the
  source label and a separate `lowConfidenceProxy` flag are now independent.
- Single-candidate fallback summary no longer says "comparison of 1
  candidates".

### Fixed (v1.6.6, backend)
- **The candidate-shortfall note names the actual responsible filter** — in
  live runs the dominant cause was the required travel-time route check,
  which the v1.6.4 wording never mentioned; it now leads with it, including
  how many shortlisted zones failed it.

### Tests
- 4 new backend tests (spread-aware refit) appended to
  `test_v164_map_and_coords.py`; 9 new frontend tests (grid ranking,
  re-selection, separation, exclusions) in `reweighting.test.ts`.

### Validation
- Backend: **608 passed** (604 + 4 new).
- Frontend: `tsc --noEmit` clean, Vitest **75 passed** (66 + 9 new),
  `vite build` clean.

### Deploy
- Backend: Cloud Run revision `stratageo-engine-00064-…` (see tag below).
- Tag `rollback-pre-v1.6.7` points at the previously-live commit (`29639eb`,
  backend revision `stratageo-engine-00063-ph2`).

---

## [1.6.4] — 2026-07-07 — Map Coherence & Coordinate Fidelity

Backend + frontend release fixing three live-reported issues (customer
screenshots/prompts), plus one long-standing transparency gap.

### Fixed
- **A pick's map colour now matches its card score.** The engine's two-pass
  design (cheap screening for every cell, expensive isochrone/routing
  refinement only for the shortlist) is unchanged — but each chosen
  candidate's own hex cell is now recoloured with its FINAL refined score
  and flagged (`refinedCandidate`); hovering it says "FINAL refined score
  (chosen candidate)". All other cells keep the screening surface, the only
  basis on which every cell is comparable. The report's ranking-basis note
  was rewritten to say precisely this. Under custom weight sliders the flag
  is dropped (`mcdaEngine.reweightHexGrid`), since reweighted values are
  screening-based.
- **The map can no longer contradict a withheld recommendation.** When the
  analyst review flags a result unreliable (or no viable land remains), the
  hex suitability surface previously kept its confident green/red gradation
  while the pins were greyed. It now renders neutral grey with faint
  relative shading, and every cell tooltip reads "Screening value X/10 —
  context only: this result was flagged unreliable, no recommendation is
  made."
- **Coordinates in the prompt are now used verbatim.** "Chinar Park[22.62…,
  88.43…]"-style place strings were being sent to the Google/Nominatim text
  geocoders unparsed; both fell back to a country-level "India" match whose
  centroid silently became the study area (observed live: a four-locality
  Kolkata brief analyzed near the centroid of India). Three-layer fix:
  (1) `extract_embedded_coords()` in `study_area.py` reads `[lat, lng]`,
  `(lat, lng)` and `@ lat, lng` styles directly (with lat/lng swap
  auto-correction) and never geocodes them; (2) `extract_prompt_place_coords()`
  in the deterministic planner re-extracts coordinate-tagged places from the
  customer's RAW prompt and makes them the study area even if the LLM
  stripped them from the spec; (3) `geocode()` now rejects country/state-level
  matches outright for every brief — a locality query resolving to "India"
  is always wrong, and failing honestly beats analyzing the wrong place.
- **Candidate shortfall is now explained** (long-standing gap, first flagged
  in the live QA review): when fewer zones survive scoring/exclusions/
  near-duplicate separation than requested, the result notes state how many
  survived and why, instead of silently returning a shorter list.

### Tests
- New `tests/test_v164_map_and_coords.py` (10 tests), including the
  customer's exact four-locality Kolkata coordinates prompt as a permanent
  regression test (all four places must resolve inside Kolkata), the
  LLM-stripped-coordinates worst case, swapped lat/lng auto-correction, and
  the country-level geocode rejection.

### Validation
- Backend: **604 passed** (594 + 10 new).
- Frontend: `tsc --noEmit` clean, Vitest **66 passed**, `vite build` clean.

### Deploy
- Backend: Cloud Run revision `stratageo-engine-00063-…` (see tag below).
- Tag `rollback-pre-v1.6.4` points at the previously-live commit (`f9b17e0`,
  backend revision `stratageo-engine-00062-4h2`).

---

## [1.6.3] — 2026-07-07 — H3 Grid-Level Choice (7/8, default 8)

Backend + frontend release: the engine default changes and the plan card
gains a control, so both sides ship together (`package.json` and the UI's
`v…` badge move to 1.6.3).

### Changed
- **Default analysis grid coarsened from H3 resolution 9 to resolution 8.**
  Every canonical archetype (`canonical_archetypes.py`), the `Grid` model
  default (`models/spec.py`), the LLM consultant's stated default
  (`prompts.py`), and the evidence-trail fallbacks now use resolution 8
  (~0.74 km² hexes, ~461 m edge) instead of 9 (~0.10 km² hexes, ~174 m edge).
  Fewer cells per study area → faster runs and more headroom for the
  provider stages. `LARGE_FORMAT_RETAIL` was already 8.

### Added
- **Plan-card grid-level picker (frontend)** — the "Grid:" row on the
  Analysis Plan card is now a two-option segmented control: **Level 7**
  (~5.2 km² hexes — district-scale screening, fastest) or **Level 8**
  (~0.74 km² hexes — neighbourhood-scale, the default). Tooltips explain the
  tradeoff. If the backend set a different resolution (e.g. the res-10
  block-granularity prompt override), that value is shown beside the picker
  until the customer picks a level.
- **`gridResolutionAdjustedByUser` spec flag + preservation guard**
  (`preserve_user_grid_resolution()` in `deterministic_planner.py`, wired in
  `llm.py`) — mirrors the v1.6.0 weight-slider guarantee: the deterministic
  planner re-applies the archetype default resolution on every chat turn, so
  without this guard a customer who picked a level and then typed another
  message would have the choice silently wiped. An explicit UI choice also
  wins over the res-10 block-granularity override. The guard only trusts the
  two offered levels (7/8); the SpecV2 7–10 clamp and `polyfill()`
  auto-degrade (with recorded note) are unchanged.

### Tests
- New `tests/test_v163_grid_choice.py` (9 tests): default is 8 in the Grid
  model / every archetype / an end-to-end planned spec; a user's level-7
  choice survives a replan; the choice wins over the block-granularity
  override; the override still applies when no choice was made; flagged but
  unoffered resolutions (5/9/10/None/"8") are ignored; malformed incoming
  specs are tolerated.
- Updated: archetype-default assertion in `test_v152_reliability.py` (9→8),
  version assertions.

### Validation
- Backend: **594 passed** (585 + 9 new).
- Frontend: `tsc --noEmit` clean, Vitest **66 passed**, `vite build` clean.

### Deploy
- Backend: Cloud Run revision `stratageo-engine-00062-…` (see tag below).
- Tag `rollback-pre-v1.6.3` points at the previously-live commit (`5f46c50`,
  backend revision `stratageo-engine-00061-fzz`).

---

## [Unreleased — housekeeping] — 2026-07-07 — Repo Cleanup

No `APP_VERSION` bump and no backend redeploy: nothing in `backend-py/app/`
or `src/` changed — this is dead-file removal, doc-accuracy fixes, and
metadata only. The production frontend bundle is byte-identical before and
after (verified: same content hash from `vite build`).

### Removed
- **The entire legacy Node.js/Vercel serverless API layer** (`api/` —
  `analyze.js`, `explain.js`, `health.js`, `intent.js`, `places.js`,
  `test-openai.js`, `_lib/*`), `vercel.json`, and its local dev tooling
  (`local-api-server.mjs`, `run-tests.mjs`, and the `dev:api`/`dev:full`
  `package.json` scripts). This was a full duplicate analysis pipeline
  (prompt → LLM intent → geocoding → OSM scoring → MCDA ranking) that called
  OpenAI directly — superseded by `backend-py/` since the conversational v2
  engine shipped. Confirmed unreachable from the live site: the deployed
  frontend bundle always sets `isConversationalMode=true`, so the code path
  that would call these functions never executes in production; one of the
  functions was already marked "DEPRECATED" in its own code comment.
  **Note:** this only removes the source from this repo — if a separate
  Vercel deployment of this code is still live, deleting it from this repo
  does not delete or pause that deployment; it should be checked/retired
  directly in the Vercel dashboard if no longer wanted (it calls OpenAI with
  a live key and may still be reachable/billing independently of this site).

### Moved
- `PORTAL_STATUS.md` (a stale v0.8.0 QA snapshot, Vercel-era) and
  `SPATIAL_RELIABILITY_UPGRADE_REPORT.md` (superseded by this CHANGELOG and
  `docs/analysis-engine-v1.5-change-log.md`) archived from the repo root into
  `docs/`, matching the existing historical-docs convention there.

### Fixed
- `backend-py/README.md` referenced `v1.0.1` and `gpt-4o` — both long stale
  (current: see root README for the live version and model config). Trimmed
  to point at the root README for anything version/architecture-specific and
  fixed the specific wrong model-name references.
- `.env.example` only documented the legacy demo-mode / Vercel-proxy
  variables (`VITE_APP_MODE`, `VITE_AI_BACKEND_URL`) and omitted the
  variables the actual production build needs (`VITE_PY_BACKEND_URL`,
  `VITE_CONVERSATIONAL_MODE`, `VITE_APP_TOKEN`). Rewritten to document the
  current production path first, legacy fallback second.
- README's CI test-count row was stale (513 backend / 44 frontend) — updated
  to the current 585 / 66.
- `.gitignore` had two dead rules (`api/.env`, `api/node_modules`) referring
  to the now-removed folder; removed. Added `STRATAGEO_PORTAL_FULL_CONTEXT.md`
  (a working-session context file that may contain partial credential
  fingerprints — was already untracked by convention, now enforced) and
  `vercel-dev.log` to prevent future accidental commits.
- GitHub repo topics updated to reflect the actual current stack (added
  `python`, `fastapi`, `google-cloud-run`, `firebase` — previously only
  frontend-stack topics were listed).

### Validation
- Backend: **585 passed** (unchanged from the last release — no backend code touched).
- Frontend: `tsc --noEmit` clean, Vitest **66 passed**, `vite build` output
  **byte-identical bundle hash** to the pre-cleanup build.

---

## [Unreleased — frontend-only] — 2026-07-06 — Admin Prompt/Output Comparison Log

No `APP_VERSION` bump: the backend is untouched and not redeployed by this
change — only the frontend usage log and Admin Dashboard changed.

### Added
- **Output snapshot on every logged prompt** (`usageTracker.ts`) — each completed
  v2 analysis now logs, alongside the existing prompt/latency/score fields: its
  `planningFingerprint`/`specFingerprint`, `analysisRecommendation`, requested
  vs. actual candidate count, a compact top-candidate list (name/score/
  investigation label), a hard-constraint-verification count summary, and
  which PlannerLite stages were skipped. All fields optional and stripped of
  `undefined` before the Firestore write, so older log entries and the legacy
  demo path are unaffected.
- **Admin Dashboard → Prompts tab**: an expandable "Output" row per prompt
  showing the snapshot above.
- **Automatic non-determinism detection** — entries are grouped by
  `planningFingerprint` (a stable hash of prompt + archetype + schema); if the
  same fingerprint produced a different candidate count / top score / verdict
  across runs, every row in that group is flagged `⚠` and a summary badge
  ("N mismatches detected") appears in the toolbar.
- **"Export comparison report (.md)" button** — downloads a structured
  Markdown report grouping all visible prompt runs by fingerprint, with a
  table per group and `⚠ MISMATCH` headers where runs disagree — built for
  side-by-side review of whether the engine is behaving deterministically for
  repeated prompts.

### Fixed
- **Admin panel crashed on open (React error #310)** — `AdminDashboard.tsx`
  had an `if (!open) return null;` early return sitting between two hooks
  (`useMemo` for mismatch detection, `useCallback` for the export report)
  added by this feature. Since `open` is `false` on first mount and only
  becomes `true` when an admin opens the panel, React saw a different hook
  count between renders. Fixed by moving the early return after all hooks.

---

## [1.6.2] — 2026-07-07 — Smart Water/Buildability Relevance (backend-only)

No frontend code changed in this release; `package.json`/the UI's `v…` badge
stay at 1.6.1. Backend-only fix, backend-only redeploy.

### Fixed
- **Live-observed bug: commercial briefs could land on port/rail/water land.**
  "High-end gym in Mumbai" — a bare screening prompt with zero water or
  land-development wording — put a recommended candidate on the Mumbai
  coastline/dockyard edge, and another near Mumbai Port Trust/CSMT railway
  land. Root cause was two independent gaps:
  1. The PlannerLite relevance gate's `_buildability_relevant()` used a
     narrower, independently-drifting check than
     `jobs.py._buildability_flags()` (moved to `engine/planner_lite.py` as
     the single source of truth) — the function that actually decides which
     no-build masks to apply. `_buildability_flags()` already correctly
     recognized "gym" as commercial (via `_COMMERCIAL_RE`); the narrower gate
     did not, so whenever the gate said "skip", `jobs.py` forcibly zeroed the
     railway/ghat/protected flags the flags function had correctly set —
     silently dropping no-build-land protection for most commercial briefs.
     Fixed: the gate now calls the exact same function, so the two can never
     diverge again.
  2. `_water_relevant()` was pure prompt-text matching with no geography
     awareness — a coastal peninsula city like Mumbai carries a real
     water/dock risk that the prompt itself may never mention. Added a
     deterministic coastal/port-metro check (Mumbai, Chennai, Kolkata, Kochi,
     Visakhapatnam, and other major Indian coastal cities) that triggers the
     water mask from the resolved study area alone.
- **Water and buildability fetches now run CONCURRENTLY, not sequentially —
  closing the actual timeout risk this release would otherwise have
  introduced.** Both fixes above make water_geometry AND buildability fire
  TOGETHER far more often (a coastal metro's commercial brief needs both,
  every time — previously a rare combination, now the common case). Under
  the old code, the water-body fetch (up to `optional_provider_timeout`=45s)
  fully completed before buildability's own bounded 90s-budget fetch group
  even started — a worst case of up to ~135s for these two stages alone,
  stacking on top of the rest of the 240s job budget. Fixed: the water fetch
  and the buildability fetch group are now launched as concurrent asyncio
  tasks at the same point in the pipeline (`jobs.py`'s buildability flag
  computation and fetch-task launching moved earlier, right alongside the
  water-fetch launch) and only awaited where their results are actually
  needed — bounding the combined worst case to `max(water, buildability)`
  instead of their sum. Neither stage depends on the other's fetched data
  (only the corridor riverbank-boundary fallback needs water_ways, and that's
  awaited separately once both are already in flight), so this is a pure
  latency win with no behavior change to mask application, ordering, or
  reported notes/mask_stats.

### Tests
- New `test_v162_smart_masks.py` (6 tests): the exact Mumbai-gym regression,
  an isolation test proving the water trigger works from city alone (a
  business type matching neither the commercial nor land-development regex),
  a landlocked-city counterfactual (proves the fix is geography-aware, not
  an across-the-board always-on change), an invariant that buildability
  relevance can never diverge from `_buildability_flags()` again, the
  timeout-safety check, and a real-wall-clock concurrency test (delays every
  mocked Overpass fetch and asserts the measured elapsed time sits below the
  midpoint between the old sequential bound and the new concurrent bound —
  a genuine regression guard against re-introducing sequential fetching,
  not just a mask-correctness check).
- Updated 9 existing tests across `test_v149_planner_lite.py`,
  `test_v15_intelligence.py`, `test_hard_constraint_visibility.py`, and
  `test_v152_reliability.py` whose fixtures/assertions had encoded the old
  (buggy) skip-buildability-for-commercial-briefs behavior as expected —
  cafe/supermarket fixtures now correctly show buildability required, and
  the shared live-prompt fixtures moved their default study area from
  "Kolkata" (itself a real port/river city, now correctly water-relevant) to
  "Pune" (landlocked) to keep testing genuine irrelevance-skip coverage.
- **585 passed** (579 + 6 new).

### Rollback plan
Tag `rollback-pre-v1.6.2` points at the previously-live commit (`5162fd5`,
backend revision `stratageo-engine-00060-dxr`).

---

## [1.6.1] — 2026-07-07 — Confidence, Report & Quotas

### Added
- **Unified confidence verdict** (`backend-py/app/engine/unified_confidence.py`)
  — merges `dataSufficiencyV2.final_confidence` and the reliability critic's
  verdict into ONE headline `unifiedConfidence` (High/Medium/Low), using a
  conservative rule (overall = worst of the components) with a reason
  sentence explaining any disagreement. Shown as a banner at the top of
  results and as a PDF section. Pure function, exception-isolated at the call
  site — never blocks or defaults an analysis on failure.
- **PDF report: Overall Confidence + Factor Weight Audit** — the exported
  report now includes the unified confidence verdict and a table of each
  factor's playbook default weight vs. the weight actually applied, headed
  "ADJUSTED BY USER" whenever the customer moved a slider before running.
- **Per-customer analysis allotments** — `users/{uid}.maxPrompts`, admin-
  grant-only (Firestore rules reject a user creating or changing it
  themselves), replacing the single hardcoded prompt cap. Enforced atomically
  in the backend's quota transaction, surfaced in the UI ("N of 5 queries
  left"), and manageable from the Admin Dashboard via new **Set allotment**
  and **Reset usage** actions.
- **Server-side identity + quota enforcement** (`backend-py/app/auth_quota.py`)
  — `/api/v2/chat` and `/api/v2/analyses` verify the caller's Firebase ID
  token (sent by the frontend as `Authorization: Bearer …`) and the analyses
  endpoint transactionally consumes one credit only once the spec has
  validated (a malformed spec never burns a customer's analysis). Fails
  **closed** if verification infrastructure is unavailable. Gated behind
  `STRATAGEO_REQUIRE_USER_AUTH`, **OFF by default** — deploying this code
  changes nothing until the flag is explicitly flipped. See
  [`docs/PHASE3-SECURITY-REVIEW.md`](docs/PHASE3-SECURITY-REVIEW.md) for the
  full review and go-live sequence.
- **Chat-turn rate limiting** — a per-user sliding one-hour window (default
  60 turns, `CHAT_TURNS_PER_HOUR`) on the free-to-use chat/spec-refinement
  endpoint, closing a gap where a signed-in user could loop the LLM endpoint
  indefinitely without ever consuming a paid analysis credit.

### Fixed
- **Admin "users at limit" metric used a hardcoded threshold** — now computed
  against each user's own allotment instead of a fixed number.

### Tests
- Backend: 2 new tests in `test_v152_reliability.py` (per-customer quota
  decision, chat rate-limiter sliding window) + a new `test_v160_phase3.py`
  (14 tests: unified-confidence merge logic, quota decision matrix, bearer-
  token parsing, rollout-safety — enforcement off by default and a no-op when
  the flag is off). **579 passed.**
- Frontend: **66 passed** (unchanged from v1.6.0 — this release is additive
  on top of the same reweighting-engine tests).

### Rollback plan
Tag `rollback-pre-v1.6.1` points at the previously-live commit (`d845fc9`,
backend revision `stratageo-engine-00059-cgl`).

---

## [1.6.0] — 2026-07-06 — Factor Weight Sliders

### Added
- **Plan-card weight adjustments now survive chat turns** — a customer who
  moves a weight slider on the plan card before running, then types "run",
  previously had their adjustment silently wiped because every chat turn
  re-applies archetype default weights. Fixed: adjustments are flagged
  (`weightsAdjustedByUser` on the spec) and the new `preserve_user_weights()`
  (`backend-py/app/engine/deterministic_planner.py`) copies them back onto the
  freshly planned spec by layer id/name before execution.
- **Post-run weight sliders, fully wired** — the "⚖ Factor weights" panel
  above the candidate list re-ranks candidates **and recolors the hex-grid
  map** instantly on every slider move, entirely client-side (`reweightHexGrid`
  in `mcdaEngine.ts`) — no re-fetch, no analysis credit used. A **Reset to
  defaults** button restores the original analysis.
- **Honesty banner + stale-decoration suppression** — moving any slider away
  from defaults shows an amber "Custom weights active" banner explaining that
  confidence/stability labels and the shortlist itself were computed under
  default weights; score-band, "statistically similar", and map→refined chips
  are hidden rather than shown against numbers they no longer describe.
- **Weight audit trail** — every analysis result now carries a `weightAudit`
  object (`defaultWeights`, `executedWeights`, `adjustedByUser`), built in
  `jobs.py` from the spec's `canonicalWeights` (recorded by the deterministic
  planner before any adjustment) and the layers it actually executed with.

### Fixed
- **Fabricated-zero bug in `recalculateWithWeights`** (`mcdaEngine.ts`) — the
  pre-existing (half-finished) weight-slider recompute counted a factor with
  no data (`score === null`) as a hard `0` in the weighted mean while still
  counting its weight in the denominator, unfairly dragging down candidates in
  data-sparse areas. Fixed with present-weight renormalization matching the
  backend's honesty rules — a no-data factor is now excluded from both
  numerator and denominator entirely.

### Tests
- Backend: 4 new tests in `test_v152_reliability.py` covering
  `canonicalWeights` recording, weight preservation across a simulated chat
  turn, that an unflagged incoming spec does NOT preserve, and that `SpecV2`
  accepts the new audit fields. **560 passed.**
- Frontend: new `src/__tests__/reweighting.test.ts` (13 tests) covering the
  canonical "reverse the weights flips the ranking" test prompt, the
  no-data-factor exclusion fix, hex-grid recoloring, and `weightsDiffer`
  scale-invariance. **66 passed.**

---

## [1.5.2] — 2026-07-06 — Reliability & Consistency

**Tests:** 556 backend passed · 53 frontend passed · **Readiness:** deployed to production

### Fixed
- **Buildability stage timeout** — the up-to-6 land-exclusion Overpass fetches (railway area/lines, ghat, heritage/protected, maidan, road-frontage) previously ran sequentially (6 × 30s worst case = 180s) and could blow the 240s job ceiling — observed live on 2 of 4 canonical prompts. Fetches now launch concurrently (semaphore = 2, public-Overpass-mirror etiquette) under a single **90-second stage budget** (`buildability_stage_budget_seconds`, `buildability_fetch_concurrency` in config). A fetch that cannot start or finish inside the remaining budget degrades to an empty mask with an honest note — never a job failure. Live-verified: the riverside prompt that hard-failed now completes in ~135s with zero degraded checks.
- **Planner determinism** — the LLM spec-builder sometimes attached a default water-tagged exclusion to prompts with no water signal, flipping the water/buildability stage plan between runs of the identical prompt. An uncorroborated water exclusion no longer triggers the water/buildability cascade (its own buffer mask still applies); stage relevance is decided only by the waterfront flag, a real water corridor, or water wording in the user's prompt/constraints.
- **Small-format grocery mis-archetyping** — "small / mini / organic / kirana / convenience / corner / neighbourhood" grocery briefs were routed to the large-format-retail (hypermarket) playbook (res-8 grid, highway/delivery factors). They now resolve to the neighbourhood retail archetype (walk footfall, co-tenancy, competition, transit; res-9). "Massive discount supermarket" still correctly resolves large-format (pinned by test).
- **Objective drift** — the plan-card objective was LLM-phrased and drifted between runs of the identical prompt. It is now template-generated from deterministic inputs (regex-parsed top-N, business type, study area) — byte-identical every run. Companion fix: waterfront detection now also reads `rawIntent.rawPrompt`, so water cues survive the templated objective.

### Added
- **Block-granularity grid rule** — prompts asking for "specific intersections or blocks / street corners" get an H3 res-10 grid (~66 m cells), driven purely by the user's own words; `polyfill()` still auto-degrades with a note if the area would exceed the hex budget.
- **Screening-vs-refined score transparency** — every candidate carries `screeningScore` (Pass-A composite, same basis as the map choropleth) and `rankingBasis` (`refined` | `screening`); the candidate card shows "map/screening X → refined Y" when they meaningfully differ, and the methodology notes explain both the refined re-ranking and the near-duplicate skip rule.
- 13 new regression tests (`test_v152_reliability.py`): stage-budget sanity, water-relevance determinism (uncorroborated exclusion, corroborated exclusion, corridor, prompt wording), small-grocery vs discount-supermarket archetype resolution, res-10 granularity rule, byte-identical objective across divergent LLM wordings, waterfront detection surviving the templated objective.

### Unchanged by design
- Zero new providers or external calls; conservative recommendation logic, caveats, and the hard-constraint verification layer untouched.

---

## [1.5.1] — 2026-07-06 — Hard Constraint Verification Visibility

**Tests:** 543 backend passed · 53 frontend passed · **Readiness:** deployed to production (no APP_VERSION bump at ship time; version folded into 1.5.2)

### Added
- **`hardConstraintVerification` payload object** — per-requested-hard-constraint status (`verified` / `proxy_verified` / `not_verifiable` / `requested_not_enforced` / `failed` / `not_required`) with category, severity, reason, `affectsRecommendation`, and `fieldValidationRequired`, plus summary counts and an overall `summaryStatus`. Built as a pure mapping over state the pipeline already computed (constraint policy, metro resolution, route availability, waterfront enforcement, buildability degradation) — zero new provider calls, exception-isolated (the key is omitted if the build fails, never a broken payload).
- **Per-candidate `hardConstraintWarnings`** — compact warning chips on every non-excluded candidate when an analysis-wide requested constraint is unresolved (e.g. "Requested but not enforced: Metro exclusion — no station data could be resolved").
- **"Hard constraint verification" panel** in the results drawer — counts, per-constraint status lines, and warning cards; rent/floor-area/zoning/parcel/ownership always show *Not verifiable — field validation required*; the arterial-road requirement is honestly split into a Verified corridor gate vs a proxy/not-verifiable frontage claim.
- **Strong-verdict safety cap** — an unresolved requested hard constraint can never coexist with `RECOMMENDED_INVESTIGATION_ZONE` (re-asserts the existing demotion paths as an explicit invariant).
- **Pre-run honesty note** in the spec card: a metro exclusion depends on station data resolving at run time and will be marked "requested but not enforced" — never silently kept.
- 17 new backend tests (`test_hard_constraint_visibility.py`, incl. 2 mocked end-to-end payload pins) + 5 new frontend normalizer tests.

---

## [1.5.0] — 2026-07-04 — Analysis Intelligence Lite

**Tests:** 526 backend passed · 48 frontend passed · **Readiness:** deployed to production

A lightweight reasoning layer over the v1.4.9 pipeline — strict YAGNI: zero new provider calls, no engine rewrite, no heavy buildability, no rent data, no live traffic. Full per-change detail (risk, testing, rollback) in [`docs/analysis-engine-v1.5-change-log.md`](docs/analysis-engine-v1.5-change-log.md).

### Added — backend
- **Intelligence classification** (`engine/planner_lite.py`): deterministic `businessArchetype` (8 families mapped from the canonical archetype registry with regex fallback), `locationIntent`, `riskTriggers`, `analysisMode`, hard-gate inventory with per-gate verification class, soft factors with family + proxy/observed support. Attached to the plan, the result payload (`analysisIntelligence`), and the spec-card preview.
- **Scenario ranking stability** (`engine/stability.py`, new): the final shortlist re-ranked under `balanced` / `demand_led` / `access_led` / `competition_sensitive` weight variants → `ROBUST_TOP_CANDIDATE` / `STABLE_TOP_3` / `SCENARIO_SENSITIVE` (names the scenario that drops it) / `WEAK_UNSTABLE` / `NOT_ENOUGH_CANDIDATES`. Informational only; never changes exclusion or scoring; never raises.
- **`dataSufficiencyV2`** (`services/jobs.py`): per-domain verified/proxy/unknown/degraded/not_required statuses, hard-constraint verified/unknown/failed counts, provider health, `final_confidence` (high/medium/low) with a human-readable reason — assembled entirely from state the run already computed.
- **Investigation-zone taxonomy**: per-candidate `investigationLabel` + analysis-level `analysisRecommendation` (`RECOMMENDED_INVESTIGATION_ZONE` / `PROVISIONAL_CANDIDATE` / `WEAK_CANDIDATE` / `NO_RELIABLE_RECOMMENDATION` / `NO_VIABLE_SITE_IN_CONSTRAINTS`). A `RECOMMENDED` status demotes to `PROVISIONAL_CANDIDATE` when the analysis is provisional or the candidate is scenario-unstable. Existing `recommendationStatus` wire values unchanged.

### Added — frontend (additive only; old payloads render exactly as before)
- Analysis-level verdict badge at the top of the results drawer.
- Per-candidate investigation label (preferred over the legacy label when present) and scenario-stability label with explanatory tooltip.
- Compact **Data sufficiency** panel: per-domain status chips, hard-constraint counts, final confidence + reason.
- Unsupported constraints now headed **"Field validation required"**.
- `resultNormalizer` guarantees all new shapes (malformed → hidden with a warning, never a crash).

### Changed
- `config.py`: `APP_VERSION` → `1.5.0`; `ENGINE_VERSION` fallback → `stratageo-engine-00055`; `RELEASE_NAME` → "Analysis Intelligence Lite".
- `package.json` / `package-lock.json`: version → `1.5.0`.

### Tests
- 13 new backend tests (`tests/test_v15_intelligence.py`): four-prompt classification pins + determinism, stability labels, payload contract, supermarket verdict capped below strong recommendation while rent/floorplate unknown, dark-kitchen `routing: verified`, degraded-provider sufficiency.
- 4 new frontend normalizer tests: old-payload compatibility, well-formed v1.5 payload, malformed-field dropping, partial-object defaults.

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
- `docs/archive/V1.2_NONDETERMINISM_AUDIT.md`, `docs/archive/RELEASE_NOTES_v1.2.0.md`, `docs/archive/DEPLOYMENT_CHECKLIST_v1.2.0.md`, `docs/archive/V1.2_DETERMINISM_VERIFICATION.md`.

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
- `docs/archive/upgrade_backups/V1.1.0_BASELINE.md` — rollback reference.
- `docs/archive/RELEASE_NOTES_v1.1.0.md` — full release narrative.
- `docs/archive/DEPLOYMENT_CHECKLIST_v1.1.0.md` — staging / deployment checklist.

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

See `docs/archive/SPATIAL_RELIABILITY_UPGRADE_REPORT.md`.

---

## [1.0.1] — 2026-05 — Conversational Mode

First multi-turn conversational analysis flow.

---

## [1.0.0] — 2026-04 — Initial Release

Single-prompt direct analysis mode.
