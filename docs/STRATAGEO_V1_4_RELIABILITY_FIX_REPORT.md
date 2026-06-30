# Stratageo v1.4.0 — Reliability Hardening Fix Report

**Release date:** 2026-06-30  
**Engine version:** `stratageo-engine-00047`  
**Evidence trail version:** `1.4.0`  
**Branch:** `v1.4-reliability-hardening`  
**Latest commit:** `dc0a478`  
**Readiness:** `READY_FOR_REVIEW_ONLY` — not production-ready (see Deployment section)

---

## Executive Summary

v1.4.0 is a reliability-hardening release. The core product principle:

> **The portal must never imply more certainty than the data supports.**

Every result now clearly distinguishes between:
1. **Candidate zone for validation** — spatially promising but hard constraints unverified.
2. **Provisional** — analysis ran, but rent/footprint/zoning cannot be verified from spatial data.
3. **No reliable recommendation** — strict spatial constraints removed all viable candidates.
4. **Weak candidate / raw diagnostic** — data too sparse for confident ranking.

The system no longer calls H3 hexes "sites" or "parcels". It never claims RECOMMENDED status when rent, floor area, or zoning are unverifiable.

---

## Changes by Phase

### Phase 2 — Version Bump
- `APP_VERSION` → `1.4.0`
- `ENGINE_VERSION` → `stratageo-engine-00047`
- `EVIDENCE_VERSION` → `1.4.0`
- `SPEC_VERSION` → `2.3`
- `package.json` → `1.4.0`

### Phase 3 — Constraint Policy Layer
**New file:** `backend-py/app/engine/constraint_policy.py`

Deterministic function `evaluate_constraint_policy()` detects unverifiable constraints:
- Rent / lease price ceiling
- Minimum floor area / footprint
- Zoning / licensing / permits
- Parcel / building availability
- Ownership / title constraints
- Route constraints (if routing unavailable)
- Waterfront corridor (if unenforced)
- Required data layers (if missing)

Returns `ConstraintPolicyResult` with:
- `constraintEnforcementLevel`: `verified | provisional | unverifiable | failed`
- `unverifiedHardConstraints`: list of what cannot be checked
- `validationChecklist`: per-item status for the UI
- `hasUnverifiableConstraints`: boolean gate for RECOMMENDED status

**Function `downgrade_status_for_unverified()`** mutates locations in place:
- RECOMMENDED → CANDIDATE_ZONE when any hard constraint is unverifiable
- Adds `provisionalBadge` field to affected locations

### Phase 4 — Candidate Zone Rename
**File:** `src/components/ResultsDrawer.tsx`

- "Ranked Locations" → "Ranked Candidate Zones" (drawer title)
- Score display now shows screening disclaimer inline
- Location cards with `provisionalBadge` show amber "PROVISIONAL — field validation required" label
- Green "RECOMMENDED" badge is blocked when policy is provisional

### Phase 5 — Score Precision and Confidence Bands
**File:** `backend-py/app/engine/multi_score.py`

New fields added to each location:
- `displayScore`: rounded to nearest 0.5 (e.g. 7.3 → 7.5)
- `scoreBand`: string range (e.g. "7.0–8.0")
- `scorePrecision`: always `"screening_estimate"`
- `confidenceLabel`: `"High" | "Medium" | "Low"`
- `confidenceReasons`: plain-English explanation list
- `closeBandWarning`: `true` when all candidates score within 0.5 of each other

Frontend shows displayScore, confidence label, score band, and close-band "statistically similar" label.

### Phase 6 — Missing Data Coverage Penalty
**File:** `backend-py/app/engine/multi_score.py`

New function `compute_data_coverage()` computes:
- `availableWeight`: sum of weights of layers with data
- `missingWeight`: sum of weights of layers without data
- `coverageRatio`: 0–1 fraction
- `missingCriticalLayers`: layers with weight ≥20% that have no data
- `coveragePenalty`: `none | medium | high`

Rules:
- `coverageRatio < 0.50` → analysis is `unreliable`
- `coverageRatio < 0.65` → analysis is `weak`
- Missing layers with `weight ≥ 20%` → `weak` (not unreliable alone)

### Phase 7 — Student Demand Improvements
**File:** `backend-py/app/engine/canonical_archetypes.py`

Expanded `_DEFAULT_OSM_TAGS["student_catchment_proxy"]` to include:
- `amenity=library`, `amenity=language_school`, `amenity=training`
- `building=dormitory`, `office=educational_institution`

Updated proxy warning on `student_catchment_proxy` factor to explicitly state:
- Colleges/coaching centres/hostels are stronger signals than schools
- Confidence is MEDIUM
- Actual enrollment data unavailable

Added `hasStudentDemandSignal` detection in `intent_parser.py`.

### Phase 8 — Metro Exclusion Fix (Enforcement + Geometry)
**File:** `backend-py/app/engine/metro.py`

New functions:
- `resolve_metro_stations()` — static verified Kolkata list, then OSM subway tags, then generic fallback
- `detect_metro_exclusion(spec)` — scans `spec.exclusions` for metro/subway exclusions (by name keyword OR `station=subway` / `subway=yes` tags). Returns `(name, buffer_m)` or `None`.
- `metro_stations_to_pois(stations)` — converts station list to `{lat, lng, tags}` format compatible with the scoring engine's `build_tree()` and `point_buffer_mask()`.

**Geometry enforcement (not just metadata):**
- `detect_metro_exclusion()` is called early in `jobs.py` (before `exclusion_pois` is built)
- `resolve_metro_stations()` is called early (before Pass-A scoring)
- `exclusion_pois[metro_exclusion_name]` is **replaced** with verified station coordinates
- This means the actual exclusion buffer uses the verified metro station lat/lng — not whatever OSM returns for `railway=station` (which includes non-metro mainline stations)
- If metro is unavailable: `exclusion_pois[name] = []` (empty — not enforced), added to `route_unavailable`

Key behaviour:
- Kolkata prompt → `static_verified`, 30 stations, confidence=high → exclusion buffer uses hardcoded metro coordinates
- Generic fallback (unknown city, no OSM subway tags) → warning + confidence=low + deterministic critic downgrade
- No stations resolved → exclusion empty + `route_unavailable` entry → constraint policy = failed

Note: `railway=station` alone (without a metro name or `station=subway`/`subway=yes` tag) is **not** treated as a metro exclusion.

### Phase 9 — Strict Route-Time Validation (Enforcement)
**Files:** `backend-py/app/engine/intent_parser.py`, `backend-py/app/engine/route_policy.py`

**intent_parser.py** — detection:
- `_STRICT_ROUTE_RE`: detects "exactly within", "strictly within", "must be within", "delivery drive", "10-minute drive"
- `_STRICT_WALK_RE`: detects "walking radius", "walk time", "on foot"
- New `RawIntent` fields: `hasStrictRouteConstraint`, `hasStrictWalkConstraint`

**route_policy.py** (new) — enforcement:
- `validate_strict_route_constraints(spec, raw_intent_dict, has_ors, has_google_routes)` is called in `jobs.py` after route evaluation
- **Case A:** `hasStrictRouteConstraint=True` + no `routeConstraints` in spec + no corridors → `withheld=True`; entries added to `route_unavailable` → constraint policy = failed → `recommendation_withheld = True`
- **Case B:** `routeConstraints` present but no ORS/Google Routes → `withheld=True`; message explicitly states "Euclidean straight-line distance does NOT satisfy 'exactly within' / 'strictly within' constraints"
- **Case C:** corridor present (no routeConstraint) → partial mitigation; not failed (corridors apply a spatial gate)
- **Case D:** routeConstraints present + ORS or Google Routes available → OK; standard ORS evaluation applies

Euclidean fallback cannot satisfy strict route constraints unless ORS is available and succeeds.

### Phase 10 — Deterministic Reliability Critic (Always-On)
**New file:** `backend-py/app/engine/reliability_critic.py`

`run_deterministic_critic()` checks:
1. Missing required data layers → unreliable
2. Unavailable route constraints → unreliable
3. Waterfront corridor unenforced → unreliable
4. Coverage < 50% → unreliable
5. Coverage 50–65% → weak
6. High-weight layers missing (≥20%) → weak
7. Non-discriminating dominant factors → weak
8. Score spread < 0.5 → weak
9. Metro exclusion generic fallback → weak
10. All candidates excluded → unreliable
11. Competition whitespace over-reliance → weak

`merge_with_llm_critic()` combines deterministic + LLM verdict conservatively.

The LLM critic (critic.py) still runs in `balanced/high` cost modes. The **deterministic critic always runs** regardless of cost mode.

In jobs.py: `analysis_status` is now derived from the deterministic critic verdict instead of the LLM critic verdict alone.

### Phase 11 — State Cleanup / UI Leakage Fix
**File:** `src/App.tsx`

- Added `activeJobIdRef` to track the current job
- On new analysis start: clears `result`, `selectedLocations`, `heatmapType`, closes drawer
- `activeJobIdRef.current` set to new jobId before polling
- If a newer job starts while polling, the old poll result is discarded

### Phase 12 — Health and Capability Reporting
**File:** `backend-py/app/routers/health.py`

New fields in `/health` response:
- `evidenceVersion`: `"1.4.0"`
- `hasGoogleRoutesKey`: `bool`
- `supportsStrictRouting`: `bool` (true if ORS or Google Routes key present)
- `supportsTrafficAwareRouting`: `bool`
- `supportsVerifiedMetroLayer`: `true` (static lists always available)
- `criticMode`: `"deterministic_always_plus_optional_llm"` or `"deterministic_only"`

Legacy keys preserved for backward compatibility.

### Phase 13 — Evidence Trail v1.4
**File:** `backend-py/app/models/evidence.py`

New schemas added to `EvidenceTrail`:
- `ConstraintValidationEvidence`: verified/unverified/failed constraints
- `DataCoverageEvidence`: coverage ratio, missing critical layers
- `RouteValidationEvidence`: provider, strict, fallbackUsed, failures
- `MetroValidationEvidence`: mode, stationCount, city, confidence, warning
- `ScoreDisplayPolicyEvidence`: why scores are shown as bands
- `DeterministicCriticEvidence`: always-on critic result

Also added:
- `siteClaimLevel: "micro_market_zone"` (always)
- `disclaimer`: mandatory client-facing text about screening-level output

### Phase 14 — Frontend UX
**File:** `src/components/ResultsDrawer.tsx`

- Screening disclaimer shown at top of results (always visible)
- Provisional notice banner: amber warning with unverified constraint list + expandable validation checklist
- Checklist items show status: ✓ Verified / ? Unverifiable / ✕ Failed / ! Required / — N/A
- Data coverage warning when `coverageRatio < 0.65` and critical layers missing
- Location cards: `displayScore` (rounded), `scoreBand`, `confidenceLabel`, `closeBandWarning`
- "Statistically similar" label when scores are within 0.5
- Analysis Quality section: shows deterministic critic (always-on), coverage %, site claim level
- Constraint enforcement: "Verified / Provisional / Failed" (not just "advisory/enforced")

**File:** `src/types/index.ts`

Added TypeScript types for all v1.4 fields: `constraintPolicy`, `metroValidation`, `dataCoverage`, `disclaimer`, `activeJobId` on `AnalysisResult` and score display fields on `LocationData`.

### Phase 15 — Tests
**New file:** `backend-py/tests/test_v14_reliability.py`

56 new tests covering:
- Constraint policy: rent, footprint, zoning, route unavailability
- Score display: displayScore rounding, scoreBand, confidenceLabel, closeBandWarning
- Data coverage: full/partial/critical-missing scenarios
- Student demand: expanded tags, proxy warnings, intent detection
- Metro resolution: Kolkata static list, OSM fallback, generic fallback, unavailable
- Strict route detection: "exactly within", "strictly within", "walking radius"
- Deterministic critic: reliable/weak/unreliable verdicts, merge logic
- Four canonical prompts: archetype selection, constraint policy, metro, strict route
- LARGE_FORMAT_RETAIL archetype: registry, tags, misleading variables
- Evidence trail v1.4: new fields, siteClaimLevel, disclaimer, secret-safe
- Health endpoint: capability flags, evidenceVersion, verifiedMetroLayer

---

## Files Modified

### Backend
| File | Change |
|------|--------|
| `backend-py/app/config.py` | Version constants → v1.4.0 |
| `backend-py/app/engine/canonical_archetypes.py` | LARGE_FORMAT_RETAIL archetype; expanded student OSM tags; supermarket/discount_supermarket in registry |
| `backend-py/app/engine/intent_parser.py` | Supermarket patterns; strict route detection; student demand signal; RawIntent new fields |
| `backend-py/app/engine/multi_score.py` | Score display policy; confidence labels; close-band warning; data coverage function |
| `backend-py/app/engine/evidence_builder.py` | v1.4 evidence trail assembly; new schema imports |
| `backend-py/app/engine/metro.py` | `detect_metro_exclusion()`, `metro_stations_to_pois()` — verified coordinates injected into exclusion mask |
| `backend-py/app/engine/constraint_policy.py` | `provisionalBadge` now set on all non-excluded locations, not only RECOMMENDED→CANDIDATE_ZONE downgrades |
| `backend-py/app/models/evidence.py` | EvidenceTrail v1.4 schemas; EVIDENCE_VERSION → 1.4.0 |
| `backend-py/app/models/spec.py` | `RawIntentMeta` — added `hasStrictRouteConstraint`, `hasStrictWalkConstraint`, `hasStudentDemandSignal` (bug fix #2) |
| `backend-py/app/routers/health.py` | Capability flags; evidenceVersion |
| `backend-py/app/services/jobs.py` | Constraint policy; deterministic critic; metro resolution; data coverage; v1.4 result fields; ordering fix (bug #1); required_missing fix (bug #4) |
| `backend-py/tests/test_config_v110.py` | Version assertion → v1.4.0 |
| `backend-py/tests/test_evidence_trail.py` | Evidence version assertion → 1.4.0 |

### Backend (New Files)
| File | Purpose |
|------|---------|
| `backend-py/app/engine/constraint_policy.py` | Constraint policy evaluation (Phase 3) |
| `backend-py/app/engine/metro.py` | Metro station resolver with verified Kolkata list (Phase 8) |
| `backend-py/app/engine/reliability_critic.py` | Always-on deterministic critic (Phase 10) |
| `backend-py/tests/test_v14_reliability.py` | 56 new tests (Phase 15) |

### Frontend
| File | Change |
|------|--------|
| `src/App.tsx` | activeJobIdRef; state clearing on new analysis (Phase 11) |
| `src/components/ResultsDrawer.tsx` | Phase 4/5/14: candidate zone rename; provisional banner; checklist; displayScore; confidence label; data coverage warning |
| `src/types/index.ts` | v1.4 type definitions for all new fields |
| `package.json` | Version → 1.4.0 |

---

## Test Results

```
420 passed, 5 warnings in ~8s
  └─ 335 original tests
  └─ 56 v1.4.0 reliability tests
  └─ 28 critical fix tests (metro geometry + strict route enforcement)
  └─ 1 regression test (hasStrictRouteConstraint spec round-trip)
```

TypeScript: `npx tsc --noEmit` — 0 errors  
Build: `npm run build` — succeeds

---

## How Each Known Gap Was Fixed

| Gap | Fix |
|-----|-----|
| Unvalidatable rent/footprint/zoning | `constraint_policy.py` — detected and blocks RECOMMENDED |
| Scores too precise (7.1/10) | `multi_score.py` — `displayScore` rounds to nearest 0.5, `scoreBand` shows range |
| Metro exclusion used generic railway=station | `metro.py` — `detect_metro_exclusion()` + `metro_stations_to_pois()` replace OSM POIs with verified station coordinates in the actual exclusion mask. Kolkata: 30 verified stations injected. Generic fallback explicitly declared, confidence=low, critic downgraded. |
| LLM critic disabled in low-cost mode | `reliability_critic.py` — deterministic critic always runs |
| H3 hexes called "sites"/"parcels" | Renamed to "candidate zones" in UI; siteClaimLevel always "micro_market_zone" |
| Stale poll responses from old jobIds | `activeJobIdRef` guard in App.tsx |
| Missing data coverage not accounted for | `compute_data_coverage()` + deterministic critic checks coverage ratio |
| Student demand over-reliant on schools | Expanded OSM tags (library, dormitory, training); proxy warning updated |
| Supermarket prompt not running | LARGE_FORMAT_RETAIL archetype + parser patterns |
| Strict route constraint satisfied by Euclidean | `route_policy.py` — `validate_strict_route_constraints()` called after route eval in jobs.py. If strict phrase + no routeConstraint in spec: `route_unavailable` entry → recommendations withheld. If strict + routeConstraints + no ORS: explicitly declares Euclidean not acceptable → withheld. **Metro verified coordinates are injected directly into the actual exclusion mask** (not just reported as metadata) — `detect_metro_exclusion()` + `metro_stations_to_pois()` replace OSM-fetched POIs with the verified station list before `scoring.exclusion_mask()` runs. **Strict route constraints cannot pass through Euclidean fallback** — `validate_strict_route_constraints()` explicitly withholds recommendations when no routing provider is configured, regardless of how the Euclidean-proxy Pass-A score comes out. |
| Provisional banner never showed | Fixed: `isProvisional` now reads `constraintPolicy.hasUnverifiableConstraints` directly, not `analysisStatus === 'provisional'` (which was dead code). |

---

## Bugs Found and Fixed During Staging-Style Backend Execution (commit `dc0a478`)

After the critical fixes above were implemented, the full analysis pipeline was executed directly against the real backend (bypassing the UI, since the local OpenAI key was expired and ORS/Google Places were not configured — see Deployment section). Running the actual `_run_analysis()` code path surfaced four bugs that unit tests alone had not caught:

| # | Bug | Severity | Fix |
|---|-----|----------|-----|
| 1 | `_det_critic` referenced before assignment (`UnboundLocalError`, hard crash) — the `analysis_status` block read `_det_critic.verdict` before `_det_critic = run_deterministic_critic(...)` had executed | Critical (crash) | Reordered `jobs.py` so constraint-policy evaluation and the deterministic critic run **before** `analysis_status` is determined |
| 2 | `RawIntentMeta` (the Pydantic model embedded in `SpecV2.rawIntent`) was missing `hasStrictRouteConstraint` / `hasStrictWalkConstraint` / `hasStudentDemandSignal` — these fields existed only on the intermediate `RawIntent` dataclass and were silently dropped by `model_dump()`, so `route_policy.validate_strict_route_constraints()` never saw them and the strict-route gate was permanently bypassed | Critical (silent bypass of Fix 2) | Added the three fields to `RawIntentMeta` in `models/spec.py`; added `test_hasStrictRouteConstraint_survives_spec_roundtrip` regression test |
| 3 | `provisionalBadge` was only set when a location was downgraded from `RECOMMENDED`. Locations that were already `CANDIDATE_ZONE` (e.g. from the multi-score viability gate) never got the badge, even with unverifiable hard constraints present | Moderate | `downgrade_status_for_unverified()` now sets `provisionalBadge` + `provisionalReasons` on **every** non-excluded location when `hasUnverifiableConstraints` is true, not only ones downgraded from RECOMMENDED |
| 4 | `constraintPolicy.unverifiedHardConstraints` contained duplicate entries — `jobs.py` passed `required_missing=all_required_missing` (which already included `route_unavailable`) into `evaluate_constraint_policy()`, so each `route_unavailable` entry was double-counted under both the "Route constraint:" and "Required data layer:" labels | Minor | `jobs.py` now passes `required_missing=required_missing` (the pure data-layer-only list) and keeps `route_unavailable` as a separate parameter |

All four fixes are in commit `dc0a478`. 420/420 tests pass after the fixes (1 new regression test added for bug #2).

---

## Remaining Known Limitations

See `STRATAGEO_V1_4_KNOWN_LIMITATIONS.md` for the full list.

Key limitations that remain:
1. Real rent data still requires external broker/property-market integration.
2. Parcel availability still requires external property/registry data.
3. OSM and Google Places remain proxies — accuracy varies by city and data vintage.
4. Output remains screening-level H3 zones — not exact parcels or leasable buildings.
5. Strict drive-time constraints use Euclidean fallback when ORS/Google Routes are unavailable.
6. Metro exclusion falls back to generic railway stations when OSM subway tags are absent.

---

## Deployment Readiness: `READY_FOR_REVIEW_ONLY`

**Full UI staging validation was NOT completed.** The local OpenAI API key was expired (401 Unauthorized) so chat turns could not build a spec through the conversational UI, and ORS / Google Places keys were not configured locally, so live routing and Places data were unavailable. To work around this, the four canonical prompts were executed by injecting hand-built specs directly into the `_run_analysis()` pipeline, bypassing the chat layer entirely. This validated all backend enforcement logic (constraint policy, metro exclusion geometry, route policy, deterministic critic) against real OSM data, but did **not** validate:
- The conversational spec-building flow end-to-end
- The ResultsDrawer UI rendering (provisional banner, validation checklist, score bands) in a live browser
- Real ORS/Google Routes drive-time evaluation
- Real Google Places competitor/co-tenancy data

This pipeline-level execution is what surfaced the four bugs documented above — they would not have been caught by unit tests alone, but they are also not equivalent to a full UI staging pass.

**Before this can move to `READY_FOR_STAGING_VALIDATED`:**
1. Configure a valid `OPENAI_API_KEY`, `ORS_API_KEY`, and `GOOGLE_PLACES_API_KEY` in the staging environment.
2. Run the four canonical prompts through the actual chat UI end-to-end.
3. Visually confirm the provisional banner, validation checklist, displayScore/scoreBand, and confidence labels render correctly.
4. Confirm a strict route constraint is evaluated with real ORS/Google Routes data (not just the "unavailable" withhold path).

**Before this can move to `READY_FOR_PRODUCTION_CANDIDATE`:** the above staging validation must pass, plus a full regression pass against the four canonical prompts with no withheld/degraded results due to missing API keys.

To run validation locally:
```bash
# Backend
cd backend-py
pytest -q  # must pass 420/420

# Frontend
npx tsc --noEmit  # must be clean
npm run build     # must succeed

# Deploy backend to Cloud Run (use existing pipeline) — NOT recommended until staging validation above is complete
# Frontend deploys automatically via GitHub Pages on push to master after PR merge
```
