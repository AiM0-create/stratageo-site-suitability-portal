# Stratageo v1.4.0 — Reliability Hardening Fix Report

**Release date:** 2026-06-29  
**Engine version:** `stratageo-engine-00047`  
**Evidence trail version:** `1.4.0`  
**Branch:** `v1.4-reliability-hardening`

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

### Phase 8 — Metro Exclusion Fix
**New file:** `backend-py/app/engine/metro.py`

- Static verified Kolkata Metro station list (35+ stations, Blue + Green lines)
- Resolution priority: `static_verified > osm_metro > generic_station_fallback > unavailable`
- OSM tags: `station=subway`, `subway=yes` preferred over `railway=station`
- Confidence: `high` for static list, `medium` for OSM subway, `low` for generic fallback
- Generic fallback generates advisory warning
- Returns `MetroResolutionResult` with `to_evidence_dict()` for evidence trail

### Phase 9 — Strict Route-Time Validation
**File:** `backend-py/app/engine/intent_parser.py`

New regex patterns:
- `_STRICT_ROUTE_RE`: detects "exactly within", "strictly within", "must be within", "delivery drive", "10-minute drive"
- `_STRICT_WALK_RE`: detects "walking radius", "walk time", "on foot"

New `RawIntent` fields:
- `hasStrictRouteConstraint: bool`
- `hasStrictWalkConstraint: bool`

These propagate into the evidence trail. The constraint policy layer marks route constraints as `failed` when routing is unavailable for strict prompts.

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
| `backend-py/app/models/evidence.py` | EvidenceTrail v1.4 schemas; EVIDENCE_VERSION → 1.4.0 |
| `backend-py/app/routers/health.py` | Capability flags; evidenceVersion |
| `backend-py/app/services/jobs.py` | Constraint policy; deterministic critic; metro resolution; data coverage; v1.4 result fields |
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
391 passed, 5 warnings in 7.87s
  └─ 335 original tests
  └─ 56 new v1.4 tests
```

TypeScript: `npx tsc --noEmit` — 0 errors  
Build: `npm run build` — succeeds (9.2s)

---

## How Each Known Gap Was Fixed

| Gap | Fix |
|-----|-----|
| Unvalidatable rent/footprint/zoning | `constraint_policy.py` — detected and blocks RECOMMENDED |
| Scores too precise (7.1/10) | `multi_score.py` — `displayScore` rounds to nearest 0.5, `scoreBand` shows range |
| Generic railway stations for metro exclusion | `metro.py` — verified Kolkata list; fallback declares confidence tier |
| LLM critic disabled in low-cost mode | `reliability_critic.py` — deterministic critic always runs |
| H3 hexes called "sites"/"parcels" | Renamed to "candidate zones" in UI; siteClaimLevel always "micro_market_zone" |
| Stale poll responses from old jobIds | `activeJobIdRef` guard in App.tsx |
| Missing data coverage not accounted for | `compute_data_coverage()` + deterministic critic checks coverage ratio |
| Student demand over-reliant on schools | Expanded OSM tags (library, dormitory, training); proxy warning updated |
| Supermarket prompt not running | LARGE_FORMAT_RETAIL archetype + parser patterns |
| Strict route constraint satisfied by Euclidean | `_STRICT_ROUTE_RE` detection; constraint policy marks failed when routing unavailable |

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

## Deployment

Ready for review. To deploy:
```bash
# Backend
cd backend-py
pytest -q  # must pass 391/391

# Frontend
npm run build  # must succeed

# Deploy backend to Cloud Run (use existing pipeline)
# Frontend deploys automatically via GitHub Pages on push to master after PR merge
```
