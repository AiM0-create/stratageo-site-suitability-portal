# Stratageo v1.4.0 — Test Results

**Date:** 2026-06-29  
**Branch:** `v1.4-reliability-hardening`

---

## Backend Tests

```
pytest -q
391 passed, 5 warnings in 7.87s
```

### Breakdown

| Test file | Tests | Result |
|-----------|-------|--------|
| test_config_v110.py | 8 | ✅ PASS |
| test_evidence_trail.py | 43 | ✅ PASS |
| test_v14_reliability.py | 56 | ✅ PASS (NEW) |
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
| **TOTAL** | **391** | **✅ ALL PASS** |

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

---

## Manual Validation Required

The following cannot be automatically tested without real API keys or a live portal session:

1. **Live analysis run** — confirm "Start analysis" button appears and analysis completes.
2. **Provisional banner** — confirm amber banner appears for prompts with rent constraints.
3. **Validation checklist** — confirm checklist expands/collapses correctly.
4. **Score display** — confirm displayScore (not raw mcda_score) shown in location cards.
5. **Metro exclusion on dark kitchen prompt** — confirm Kolkata station list used.
6. **Supermarket analysis** — confirm LARGE_FORMAT_RETAIL archetype is selected and result is PROVISIONAL.
7. **State cleanup** — confirm previous result clears when starting a new analysis.
