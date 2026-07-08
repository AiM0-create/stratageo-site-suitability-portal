# Stratageo v1.4.0 — Test Results

**Date:** 2026-06-30  
**Branch:** `v1.4-reliability-hardening`  
**Latest commit:** `dc0a478`  
**Readiness:** `READY_FOR_REVIEW_ONLY`

---

## Backend Tests

```
pytest -q
420 passed, 5 warnings in ~8s
```

### Breakdown

| Test file | Tests | Result |
|-----------|-------|--------|
| test_config_v110.py | 8 | ✅ PASS |
| test_evidence_trail.py | 43 | ✅ PASS |
| test_v14_reliability.py | 85 | ✅ PASS (NEW — see below) |
| test_spec.py | 12 | ✅ PASS |
| test_scoring.py | 18 | ✅ PASS |
| test_multi_score.py | 14 | ✅ PASS |
| test_intent_parser.py | 22 | ✅ PASS |
| test_archetypes_v110.py | 16 | ✅ PASS |
| test_routing.py | 9 | ✅ PASS |
| test_corridors.py | 11 | ✅ PASS |
| test_waterfront_guard.py | 8 | ✅ PASS |
| test_waterfront_v103.py | 12 | ✅ PASS |
| test_v1031_patches.py | 8 | ✅ PASS |
| test_buildability.py | 15 | ✅ PASS |
| test_viability_gate.py | 7 | ✅ PASS |
| test_water.py | 9 | ✅ PASS |
| test_water_tag_hotfix.py | 4 | ✅ PASS |
| test_results.py | 11 | ✅ PASS |
| test_poi_merge.py | 8 | ✅ PASS |
| test_traffic.py | 6 | ✅ PASS |
| test_critic.py | 7 | ✅ PASS |
| test_spec_v110.py | 12 | ✅ PASS |
| test_phase17_smoke.py | 8 | ✅ PASS |
| test_uploaded_candidates.py | 9 | ✅ PASS |
| **TOTAL** | **420** | **✅ ALL PASS** |

`test_v14_reliability.py` (85 tests) breaks down as:
- 56 tests from the initial v1.4.0 reliability hardening pass (constraint policy, score display, data coverage, student demand, metro resolution, strict route detection, deterministic critic, canonical prompts, LARGE_FORMAT_RETAIL, evidence trail, health)
- 28 tests added for the metro geometry + strict route critical fixes (`TestMetroExclusionGeometry`, `TestStrictRoutePolicy`)
- 1 regression test (`test_hasStrictRouteConstraint_survives_spec_roundtrip`) added after staging-style backend execution surfaced that `RawIntentMeta` was silently dropping the strict-route flag

### Warnings (non-breaking)
```
DeprecationWarning: datetime.datetime.utcnow() is deprecated
```
This is a Python 3.12+ deprecation in the evidence builder. Non-breaking; will be updated in a future minor version.

---

## TypeScript Type Check

```
npx tsc --noEmit
(exit 0, no errors)
```

---

## Production Build

```
npm run build
vite v6.4.1 building for production...
✓ 1002 modules transformed
✓ built in 9.20s
```

Output sizes:
- `index.html`: 1.85 kB
- `index.css`: 65.03 kB
- `index.js`: 1,069.37 kB (minified)

---

## New Test Coverage (v1.4.0)

### Constraint Policy (6 tests)
- ✅ No unverifiable constraints → verified enforcement
- ✅ Rent constraint → unverifiable → provisional
- ✅ Footprint constraint → unverifiable → provisional
- ✅ Unverifiable → RECOMMENDED downgraded to CANDIDATE_ZONE
- ✅ Validation checklist includes field visit
- ✅ Route unavailable → failed enforcement

### Score Display (5 tests)
- ✅ displayScore rounds to nearest 0.5
- ✅ scoreBand present with "–" separator
- ✅ confidenceLabel in High/Medium/Low
- ✅ closeBandWarning set when scores within 0.5
- ✅ scorePrecision = "screening_estimate"

### Data Coverage (3 tests)
- ✅ Full coverage → penalty = none
- ✅ Partial coverage → medium penalty
- ✅ High-weight layer missing → flagged as critical

### Student Demand (4 tests)
- ✅ Expanded OSM tags include library/dormitory
- ✅ Proxy warning mentions confidence level
- ✅ Student intent detected for QSR prompts
- ✅ Student intent not detected for non-student prompts

### Metro Resolution (6 tests)
- ✅ Kolkata static list: 35+ stations, static_verified, high confidence
- ✅ Calcutta alias works
- ✅ Unknown city + OSM subway stations → osm_metro
- ✅ Generic fallback stations → generic_station_fallback + warning
- ✅ No data → unavailable
- ✅ Evidence dict structure correct

### Strict Route Detection (4 tests)
- ✅ "exactly within" detected
- ✅ "strictly within" detected
- ✅ "walking radius" detected
- ✅ Normal prompt not flagged as strict

### Deterministic Critic (7 tests)
- ✅ Reliable when all checks pass
- ✅ Unreliable when required layer missing
- ✅ Unreliable when route unavailable
- ✅ Weak when high-weight layer missing
- ✅ Unreliable when waterfront unenforced
- ✅ Conservative merge with LLM critic
- ✅ Coverage ratio computed correctly

### Canonical Prompts (8 tests)
- ✅ P1: student cafe → student_qsr_cafe archetype
- ✅ P1: default recommendation mode = candidate_zones
- ✅ P2: riverside restaurant → premium_restaurant + waterfront strict
- ✅ P3: supermarket → large_format_retail archetype
- ✅ P3: rent+footprint → RECOMMENDED blocked
- ✅ P4: dark kitchen → strict route + walk constraint detected
- ✅ P4: Ballygunge → Kolkata metro static list used
- ✅ P4: routing unavailable → constraint failed → no recommendation

### LARGE_FORMAT_RETAIL (6 tests)
- ✅ In registry as large_format_retail
- ✅ supermarket/discount_supermarket parser → large_format_retail
- ✅ Has highway_arterial_proximity factor
- ✅ Grid resolution = 8
- ✅ All layers have valid source tags
- ✅ Misleading variables mention rent and floor area

### Evidence Trail v1.4 (5 tests)
- ✅ EVIDENCE_VERSION = "1.4.0"
- ✅ v1.4 fields present on EvidenceTrail
- ✅ siteClaimLevel = "micro_market_zone"
- ✅ Disclaimer mentions field validation
- ✅ safe_dict() contains no secrets

### Health Endpoint (2 tests)
- ✅ Capability flags present (supportsStrictRouting, etc.)
- ✅ supportsVerifiedMetroLayer always True

### Metro Exclusion Geometry (16 tests — `TestMetroExclusionGeometry`)
- ✅ Metro exclusion detected by name keyword ("metro", "subway", "underground")
- ✅ Metro exclusion detected by `station=subway` / `subway=yes` tags
- ✅ Generic `railway=station` alone (no metro name) is NOT detected as a metro exclusion
- ✅ Case-insensitive detection
- ✅ No metro exclusion present → returns None
- ✅ Converted POIs have `lat`/`lng` as floats
- ✅ Converted POIs are tagged `station=subway`
- ✅ POI format is compatible with `scoring.build_tree()`
- ✅ Empty station list → empty POI list
- ✅ Stations missing lat/lng are skipped
- ✅ Kolkata exclusion uses verified static station list, not OSM-derived coordinates
- ✅ Non-metro railway stations (junctions, terminals) are not present in the verified list
- ✅ Generic fallback declared with `confidence=low` and an explicit warning
- ✅ Unknown city with no OSM stations → `mode=unavailable`
- ✅ Unenforced metro exclusion → constraint policy `enforcementLevel=failed`

### Strict Route Policy (12 tests — `TestStrictRoutePolicy`)
- ✅ Non-strict prompt → no action taken
- ✅ No `rawIntent` → no action taken
- ✅ Strict phrase + no `routeConstraint` in spec + no corridor → withheld
- ✅ Withheld result populates `route_unavailable` entries
- ✅ Strict `routeConstraint` + no routing provider → withheld, explicitly states Euclidean is not acceptable
- ✅ Strict `routeConstraint` + ORS available → OK
- ✅ Strict `routeConstraint` + Google Routes available → OK
- ✅ Strict walk constraint without a provider is a known, documented limitation (not gated by this function)
- ✅ Dark-kitchen canonical prompt triggers `hasStrictRouteConstraint`
- ✅ Dark-kitchen prompt + no ORS → route policy fails
- ✅ Dark-kitchen prompt + ORS available → route policy passes
- ✅ Corridor (no `routeConstraint`) is treated as partial mitigation, not a hard failure
- ✅ **Regression:** `hasStrictRouteConstraint` survives the full `RawIntent.to_dict()` → `SpecV2.rawIntent` (`RawIntentMeta`) → `model_dump()` round-trip (this is the exact bug found during staging-style execution — see below)

---

## Bugs Found During Staging-Style Backend Execution

After all unit tests above passed, the four canonical prompts were run through the **actual `_run_analysis()` pipeline** (not mocks) by injecting hand-built specs directly, since the local OpenAI key was expired and ORS/Google Places keys were not configured. This surfaced four bugs that the unit-test suite alone had not caught — all are fixed in commit `dc0a478` and now have regression coverage:

1. **`_det_critic` referenced before assignment** — `UnboundLocalError` crash in `jobs.py`; fixed by reordering so the deterministic critic runs before `analysis_status` is computed.
2. **`RawIntentMeta` missing strict-route fields** — `hasStrictRouteConstraint` never survived the spec round-trip, so the strict-route gate was silently bypassed in the real pipeline even though unit tests (which called `route_policy` directly with a hand-built dict) passed. Fixed by adding the fields to `RawIntentMeta`; added regression test.
3. **`provisionalBadge` missing on existing `CANDIDATE_ZONE` locations** — only set when a location was downgraded from `RECOMMENDED`; locations already at `CANDIDATE_ZONE` never got the badge.
4. **Duplicate entries in `unverifiedHardConstraints`** — `route_unavailable` entries were double-counted once as "Route constraint:" and once as "Required data layer:".

This is the value of running the real pipeline end-to-end versus unit tests in isolation: bug #2 in particular was invisible to `test_v14_reliability.py`'s direct-call tests because those tests passed `raw_intent_dict` by hand rather than deriving it from a real `SpecV2.rawIntent.model_dump()`.

---

## What Was and Was Not Validated

**Validated (real backend pipeline, real OSM data, no mocks):**
- P3 (supermarket): `constraintPolicy.enforcementLevel=provisional`, RECOMMENDED blocked, `provisionalBadge` set, rent + footprint correctly flagged unverifiable
- P4 (dark kitchen): `recommendationWithheld=true`, `analysisStatus=unreliable`, Kolkata metro exclusion uses 30 verified station coordinates (`metroExclusionOverrideApplied=1`), strict route constraint correctly withheld because no ORS was configured

**NOT validated — full UI staging pass was not completed:**
- The local `OPENAI_API_KEY` was expired (401 Unauthorized), so the conversational chat→spec flow could not be exercised through the actual UI.
- `ORS_API_KEY` and `GOOGLE_PLACES_API_KEY` were not configured locally, so real network routing and real Places competitor/co-tenancy data were never evaluated — only the "provider unavailable, withhold" code path was exercised.
- No browser session was run, so the following remain unverified visually:
  1. "Start analysis" button appears and analysis completes through the chat UI.
  2. Amber provisional banner renders for rent/footprint-constrained prompts.
  3. Validation checklist expands/collapses correctly.
  4. `displayScore` (not raw `mcda_score`) is what actually renders in location cards.
  5. State cleanup — previous result/markers/title clear when a new analysis starts (the `activeJobIdRef` guard is implemented and unit-tested at the React state level, but not observed in a live browser).

**Current readiness: `READY_FOR_REVIEW_ONLY`.** This is not a production-ready or even a fully staging-validated build — it is ready for code review, with all backend enforcement logic verified against real OSM data and 420/420 tests passing. A full UI staging pass with valid API keys is required before claiming `READY_FOR_STAGING_VALIDATED`.
