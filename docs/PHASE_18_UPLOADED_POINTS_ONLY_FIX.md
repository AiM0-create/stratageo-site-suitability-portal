# Phase 18 — Uploaded-Candidates-Only Hard Fix

**Date:** 2026-06-24
**Branch:** `feature/v1.1.0-universal-suitability-logic`

---

## Problem (Phase 17 finding)

Phase 17 found that "Only rank my uploaded CSV points" was detected by the RawIntent
parser but **not enforced by the engine**. The engine ignored the constraint and ran
a full H3 hex-grid search of the entire study area, returning results that had nothing
to do with the user's uploaded points. This violated the user's explicit "only" hard
constraint and was classified as a production blocker.

---

## Changes made

### Backend

**`app/engine/uploaded_candidates.py`** (NEW)
- `validate_uploaded_points()`: validates each uploaded point (lat/lng range, within study bbox, uniqueness). Returns (valid_cells, invalid_records).
- `score_uploaded_points()`: scores valid uploaded points using the same BallTree/POI-counting infrastructure as the main engine (no H3 grid). Returns ranked location dicts restricted to uploaded points only.
- `build_no_points_result()`: returns a blocking result dict when `uploadedCandidatesOnly=True` but no points are provided. Includes a user-facing message and suggestions. No H3 search, no fallback.

**`app/models/spec.py`**
- `UserCandidatePoint(BaseModel)`: new model for uploaded candidate points (lat, lng, name, id, attributes).
- `SpecV2.userCandidatePoints: list[UserCandidatePoint] = []` — coordinates passed from frontend at execution time.
- `SpecV2.uploadedCandidatesOnly: bool = False` — hard constraint flag.
- `RawIntentMeta.uploadedCandidatesOnly: bool = False` — stored from parser.

**`app/engine/intent_parser.py`**
- `_UPLOADED_ONLY_RE`: new regex detecting "only/solely/just/exclusively" + uploaded variants, and the reverse ("uploaded ... only").
- `RawIntent.uploadedCandidatesOnly`: new field; True when intent is clearly "uploaded points only".
- `parse_raw_intent()`: populates `uploadedCandidatesOnly` separately from `hasUploadedCandidates`.

**`app/services/jobs.py`**
- Hard gate at the very start of `_run_analysis()` before the H3 study-area step:
  - `uploadedCandidatesOnly=True` + no points → `build_no_points_result()` returned, job done, no engine run.
  - `uploadedCandidatesOnly=True` + all invalid points → blocked with validation reasons.
  - `uploadedCandidatesOnly=True` + valid points → `score_uploaded_points()` path, never touches H3 grid.
  - Full result has `constraintEnforcementLevel="enforced"`, `candidateSource="uploaded_points"`, `uploadedCandidatesOnly=True`.

### Frontend

**`src/App.tsx`**
- `handleConfirmExecute()`: at execution time, injects `userPoints` coordinates as `spec.userCandidatePoints` and sets `uploadedCandidatesOnly` flag if detected. The spec payload sent to the backend now contains the actual point coordinates.

**`src/types/index.ts`**
- `LocationData`: added `candidateSource`, `uploadedPointId`, `uploadedPointAttributes`.
- `AnalysisResult`: added `uploadedCandidatesOnly`, `candidateSource`, `uploadedCandidateCount`, `rankedUploadedCandidateCount`, `excludedUploadedCandidateCount`, `uploadedCandidateWarnings`.

**`src/components/ResultsDrawer.tsx`**
- Reads `uploadedCandidatesOnly`, `candidateSource`, uploaded count fields.
- Renders a green "Candidate Source: Uploaded points only" disclosure box when active.
- Shows total/ranked/excluded counts and any per-point validation warnings.

**`src/App.tsx` (PDF)**
- PDF methodology section 5 states "Candidate universe: RESTRICTED to uploaded points only" when active.
- PDF methodology section 6 (new) shows uploaded candidate counts and excluded count.

---

## Behavior before fix (Phase 17)

| Scenario | Before |
|---|---|
| "Only rank uploaded CSV points" + points present | Engine ran full H3 search, returned H3 hex candidates, completely ignored uploaded points |
| "Only rank uploaded CSV points" + no points | Engine ran full H3 search anyway, returned results unrelated to the constraint |
| Advisory warning | Added to notes[], but never shown to user in a useful way |

## Behavior after fix (Phase 18)

| Scenario | After |
|---|---|
| "Only rank uploaded CSV points" + points present | Engine scores only the uploaded points using MCDA factors; no H3 grid search; result shows candidateSource="uploaded_points" |
| "Only rank uploaded CSV points" + no points | Engine **blocked before running**; user sees "You asked to rank only uploaded candidate points, but no uploaded points are available" |
| Invalid uploaded points | Per-point validation; valid points scored, invalid excluded with reasons |
| Mixed valid/invalid | Valid points ranked; invalid shown as excluded; no H3 fallback |
| constraintEnforcementLevel | "enforced" (not "advisory") for all uploaded-only results |

---

## Tests added

`backend-py/tests/test_uploaded_candidates.py` — **21 new tests**:
- Parser: "only rank uploaded" → uploadedCandidatesOnly=True
- Parser: "use uploaded as constraints" (no "only") → uploadedCandidatesOnly=False
- Parser: "exclusively/solely" uploaded → True
- Validation: valid points pass, invalid lat/lng excluded with reason
- Validation: mixed valid/invalid handled correctly
- Validation: cap at 200 points
- Validation: points outside study bbox excluded
- No-points result: blocked, empty locations, no H3 fallback
- Scoring: only uploaded cells returned (no H3 hex IDs)
- Scoring: topN=3 default applies to uploaded candidates
- Scoring: topN=5 returns at most 5 uploaded candidates
- Scoring: candidateSource="uploaded_point" on all returned locations
- SpecV2: uploadedCandidatesOnly defaults to False
- SpecV2: accepts True with userCandidatePoints
- constraintEnforcementLevel="enforced" in all uploaded-only results

---

## Remaining hard-constraint limitations after Phase 18

| Constraint type | Status |
|---|---|
| Uploaded candidates only | ✅ **Fully enforced** (Phase 18) |
| Between landmarks | ✅ Deterministic (study area polygon) |
| Along waterfront / river | ✅ Deterministic (v1.0.3 corridor) |
| No-build / protected / water | ✅ Deterministic (v1.0.3 masks) |
| Route / time constraints | ✅ if ORS available + LLM creates routeConstraints |
| Outside distance (exclusion) | ⚠️ LLM-dependent (must create spec.exclusions) |
| Within distance | ⚠️ LLM-dependent (must create spec.routeConstraints) |
| Contradictory constraints | ⚠️ LLM feasibility gate (parser detects; LLM blocks) |
| validate gate (advisory) | ⚠️ Advisory only (blocking gate → v1.2) |

---

## Final recommendation after Phase 18

See PHASE_17_SMOKE_TEST_v1.1.0.md section 10 for the full decision.

With Phase 18 complete:
- The only production blocker identified in Phase 17 is resolved.
- All 236 backend tests pass.
- Frontend TypeScript clean; build succeeds.

**SAFE TO MERGE TO STAGING for further validation.**
**SAFE TO MERGE TO MAIN** after:
1. Operators set `STRATAGEO_MAX_LLM_COST_MODE=balanced` in Secret Manager (enables critic).
2. Staging smoke test confirms the 8 Phase 17 prompts behave as documented.
